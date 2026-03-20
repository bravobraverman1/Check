import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  getCorsHeaders,
  jsonResponse,
  parseJsonObject,
  rejectIfMissingProjectKey,
  rejectIfOriginNotAllowed,
} from "../_shared/security.ts";

const VALID_ACTIONS = new Set([
  "list",
  "save",
  "remove",
  "activate",
  "get_active",
  "save_vars",
  "load_vars",
  "save_setting",
]);
const PROMPT_TYPE_REGEX = /^[a-z0-9_-]{1,64}$/i;
const SETTING_NAME_REGEX = /^[a-z0-9._:-]{1,120}$/i;
const MAX_PROMPT_CONTENT_CHARS = (() => {
  const raw = Number(Deno.env.get("AI_PROMPT_CONTENT_MAX_CHARS") || "500000");
  if (!Number.isFinite(raw) || raw < 10_000) return 500_000;
  return Math.floor(raw);
})();

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parsePromptType(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "product_data";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!PROMPT_TYPE_REGEX.test(normalized)) return null;
  return normalized;
}

function parseSettingName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!SETTING_NAME_REGEX.test(normalized)) return null;
  return normalized;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  const blockedOriginResponse = rejectIfOriginNotAllowed(origin, "POST, OPTIONS", req);
  if (blockedOriginResponse) {
    return blockedOriginResponse;
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Only POST requests are allowed" }, 405, corsHeaders);
  }

  const authRejected = await rejectIfMissingProjectKey(req, corsHeaders);
  if (authRejected) return authRejected;

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return jsonResponse(
        { success: false, error: "Supabase environment variables are not configured" },
        500,
        corsHeaders,
      );
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const body = await parseJsonObject(req);
    const action = typeof body.action === "string" ? body.action.trim() : "";
    if (!VALID_ACTIONS.has(action)) {
      return jsonResponse(
        { success: false, error: "Invalid action. Use: list, save, remove, activate, get_active, save_vars, load_vars, save_setting" },
        400,
        corsHeaders,
      );
    }

    const pType = parsePromptType(body.promptType);
    if (!pType) {
      return jsonResponse({ success: false, error: "Invalid promptType" }, 400, corsHeaders);
    }

    const description =
      typeof body.description === "string" ? body.description.trim().slice(0, 255) : undefined;
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const selectedVersion = parsePositiveInteger(body.selectedVersion);
    const activateVersion = parsePositiveInteger(body.activateVersion);

    if (action === "list") {
      const { data, error } = await supabase
        .from("ai_prompts")
        .select("*")
        .eq("prompt_type", pType)
        .order("version", { ascending: false });

      if (error) throw error;

      return jsonResponse({ success: true, data }, 200, corsHeaders);
    }

    if (action === "save") {
      if (!content) {
        return jsonResponse({ success: false, error: "Prompt content cannot be empty" }, 400, corsHeaders);
      }
      if (content.length > MAX_PROMPT_CONTENT_CHARS) {
        return jsonResponse(
          { success: false, error: `Prompt content is too large (max ${MAX_PROMPT_CONTENT_CHARS} chars)` },
          400,
          corsHeaders,
        );
      }

      // Get last version for this prompt_type
      const { data: latest } = await supabase
        .from("ai_prompts")
        .select("version")
        .eq("prompt_type", pType)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();

      const nextVersion = (latest?.version ?? 0) + 1;

      const { error } = await supabase.from("ai_prompts").insert({
        version: nextVersion,
        description: description || `Version ${nextVersion}`,
        content,
        is_active: false,
        prompt_type: pType,
      });

      if (error) throw error;

      return new Response(
        JSON.stringify({
          success: true,
          message: `Version ${nextVersion} of the AI prompt has been saved`,
          version: nextVersion,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "remove") {
      if (!selectedVersion) {
        return jsonResponse({ success: false, error: "No version specified" }, 400, corsHeaders);
      }

      // Delete the version (scoped to prompt_type)
      const { error: deleteError } = await supabase
        .from("ai_prompts")
        .delete()
        .eq("version", selectedVersion)
        .eq("prompt_type", pType);

      if (deleteError) throw deleteError;

      // Re-sequence remaining versions for this prompt_type
      const { data: remaining, error: fetchError } = await supabase
        .from("ai_prompts")
        .select("*")
        .eq("prompt_type", pType)
        .order("version", { ascending: true });

      if (fetchError) throw fetchError;

      if (remaining && remaining.length > 0) {
        for (let i = 0; i < remaining.length; i++) {
          if (remaining[i].version !== i + 1) {
            const { error: updateError } = await supabase
              .from("ai_prompts")
              .update({ version: i + 1 })
              .eq("id", remaining[i].id);
            if (updateError) throw updateError;
          }
        }
      }

      return jsonResponse({ success: true, message: "Version removed and re-sequenced" }, 200, corsHeaders);
    }

    if (action === "activate") {
      if (!activateVersion) {
        return jsonResponse({ success: false, error: "No version specified" }, 400, corsHeaders);
      }

      // Clear all is_active flags for this prompt_type only, then set the selected one
      const { error: clearError } = await supabase
        .from("ai_prompts")
        .update({ is_active: false })
        .eq("prompt_type", pType);
      if (clearError) throw clearError;

      const { error: activateError } = await supabase
        .from("ai_prompts")
        .update({ is_active: true })
        .eq("version", activateVersion)
        .eq("prompt_type", pType);

      if (activateError) throw activateError;

      return new Response(
        JSON.stringify({ success: true, message: `Version ${activateVersion} is now the active prompt` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "get_active") {
      const { data, error } = await supabase
        .from("ai_prompts")
        .select("*")
        .eq("is_active", true)
        .eq("prompt_type", pType)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      return jsonResponse({ success: true, data }, 200, corsHeaders);
    }

    // ─── Variable persistence (stored in app_settings table) ──────────────
    if (action === "save_vars") {
      const vars = body.variables;
      if (!Array.isArray(vars)) {
        return jsonResponse({ success: false, error: "variables must be an array" }, 400, corsHeaders);
      }
      const settingsKey = `ai-prompt-vars-${pType}`;
      const { error } = await supabase
        .from("app_settings")
        .upsert(
          { setting_name: settingsKey, setting_value: JSON.stringify(vars), updated_at: new Date().toISOString() },
          { onConflict: "setting_name" },
        );
      if (error) {
        console.error("save_vars upsert error:", error.message);
        throw error;
      }
      return jsonResponse({ success: true }, 200, corsHeaders);
    }

    if (action === "load_vars") {
      const settingsKey = `ai-prompt-vars-${pType}`;
      const { data, error } = await supabase
        .from("app_settings")
        .select("setting_value")
        .eq("setting_name", settingsKey)
        .maybeSingle();

      if (error) {
        console.warn("load_vars error:", error.message);
        return jsonResponse({ success: true, variables: [] }, 200, corsHeaders);
      }

      let variables: unknown[] = [];
      try {
        if (data?.setting_value) variables = JSON.parse(data.setting_value);
      } catch { /* return empty */ }

      return jsonResponse({ success: true, variables }, 200, corsHeaders);
    }

    if (action === "save_setting") {
      const settingName = parseSettingName(body.settingName);
      if (!settingName) {
        return jsonResponse({ success: false, error: "Invalid settingName" }, 400, corsHeaders);
      }

      const rawValue = body.settingValue;
      let settingValue = "";
      if (typeof rawValue === "string") {
        settingValue = rawValue;
      } else if (rawValue === undefined || rawValue === null) {
        settingValue = "";
      } else {
        try {
          settingValue = JSON.stringify(rawValue);
        } catch {
          return jsonResponse({ success: false, error: "Invalid settingValue" }, 400, corsHeaders);
        }
      }

      if (settingValue.length > 100_000) {
        return jsonResponse({ success: false, error: "settingValue is too large" }, 400, corsHeaders);
      }

      const { error } = await supabase
        .from("app_settings")
        .upsert(
          {
            setting_name: settingName,
            setting_value: settingValue,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "setting_name" },
        );

      if (error) {
        console.error("save_setting upsert error:", error.message);
        throw error;
      }

      return jsonResponse({ success: true }, 200, corsHeaders);
    }

    return jsonResponse(
      { success: false, error: "Invalid action. Use: list, save, remove, activate, get_active, save_vars, load_vars, save_setting" },
      400,
      corsHeaders,
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : JSON.stringify(e);
    console.error("manage-ai-prompt error:", errMsg);
    const isBadRequest = e instanceof Error && /invalid json|json body must/i.test(e.message);
    if (isBadRequest) {
      return jsonResponse({ success: false, error: errMsg }, 400, corsHeaders);
    }
    const errorRef = crypto.randomUUID();
    console.error("manage-ai-prompt internal error:", { errorRef, errMsg });
    return jsonResponse({ success: false, error: "Internal server error", error_ref: errorRef }, 500, corsHeaders);
  }
});
