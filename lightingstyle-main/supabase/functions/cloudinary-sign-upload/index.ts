import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  getCorsHeaders,
  jsonResponse,
  parseJsonObject,
  rejectIfMissingProjectKey,
  rejectIfOriginNotAllowed,
} from "../_shared/security.ts";

function sha1Hex(text: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-1", new TextEncoder().encode(text))
    .then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
}

function parseFolder(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const folder = value.trim();
  if (!folder) return null;
  if (!/^[A-Za-z0-9/_-]{1,120}$/.test(folder)) return null;
  return folder;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  const blockedOriginResponse = rejectIfOriginNotAllowed(origin, "POST, OPTIONS", req);
  if (blockedOriginResponse) return blockedOriginResponse;

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Only POST requests are allowed" }, 405, corsHeaders);
  }

  const authRejected = await rejectIfMissingProjectKey(req, corsHeaders);
  if (authRejected) return authRejected;

  const cloudName = (Deno.env.get("CLOUDINARY_CLOUD_NAME") || "").trim();
  const apiKey = (Deno.env.get("CLOUDINARY_API_KEY") || "").trim();
  const apiSecret = (Deno.env.get("CLOUDINARY_API_SECRET") || "").trim();
  const defaultFolder = (Deno.env.get("CLOUDINARY_UPLOAD_FOLDER") || "temp_images").trim();

  if (!cloudName || !apiKey || !apiSecret) {
    return jsonResponse(
      {
        success: false,
        error: "Missing Cloudinary secrets (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)",
      },
      500,
      corsHeaders,
    );
  }

  try {
    const body = await parseJsonObject(req);
    const action = typeof body.action === "string" ? body.action.trim() : "";

    // --- log_upload: insert into temp_images using service role ---
    if (action === "log_upload") {
      const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      if (!supabaseUrl || !serviceRoleKey) {
        return jsonResponse({ success: false, error: "Missing Supabase service config" }, 500, corsHeaders);
      }
      const publicId = typeof body.public_id === "string" ? body.public_id.trim() : "";
      const secureUrl = typeof body.secure_url === "string" ? body.secure_url.trim() : "";
      const originalFilename = typeof body.original_filename === "string" ? body.original_filename.trim() : "";
      const bytes = typeof body.bytes === "number" ? body.bytes : 0;
      const mimeType = typeof body.mime_type === "string" ? body.mime_type.trim() : "image/jpeg";

      if (!publicId || !secureUrl) {
        return jsonResponse({ success: false, error: "Missing public_id or secure_url" }, 400, corsHeaders);
      }

      const sb = createClient(supabaseUrl, serviceRoleKey);
      const { error: insertError } = await sb.from("temp_images").insert({
        cloudinary_public_id: publicId,
        secure_url: secureUrl,
        original_filename: originalFilename || null,
        bytes: bytes || 0,
        mime_type: mimeType,
      });
      if (insertError) {
        console.error("[cloudinary-sign-upload] log_upload insert error:", insertError.message);
        return jsonResponse({ success: false, error: "Failed to log upload" }, 500, corsHeaders);
      }
      return jsonResponse({ success: true }, 200, corsHeaders);
    }

    // --- sign_upload (default) ---
    if (action && action !== "sign_upload") {
      return jsonResponse({ success: false, error: "Invalid action" }, 400, corsHeaders);
    }

    const requestedFolder = parseFolder(body.folder);
    const folder = requestedFolder || defaultFolder;
    const timestamp = Math.floor(Date.now() / 1000);

    const params: Record<string, string | number> = { timestamp };
    if (folder) params.folder = folder;

    const toSign = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("&");
    const signature = await sha1Hex(`${toSign}${apiSecret}`);

    return jsonResponse(
      {
        success: true,
        cloudName,
        apiKey,
        timestamp,
        signature,
        ...(folder ? { folder } : {}),
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : "Failed to sign upload" },
      400,
      corsHeaders,
    );
  }
});
