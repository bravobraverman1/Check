/**
 * globalSettings.ts
 * ─────────────────
 * Syncs the app_config localStorage object with the Supabase `app_settings`
 * key-value table so that every browser/user sees the same configuration.
 *
 * Strategy:
 *   • localStorage remains the fast synchronous cache (getConfigValue reads it).
 *   • On app boot, `initGlobalSettings()` pulls all rows from app_settings
 *     and merges them into localStorage (remote wins).
 *   • Every `setConfigValue` also upserts the key to Supabase (fire-and-forget).
 */

import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeAuth";

let _initialised = false;

type AppSettingRow = {
  key: string;
  value: string;
};

async function fetchAllSettings(): Promise<AppSettingRow[]> {
  // Primary schema used by the rest of the app
  const primary = await supabase
    .from("app_settings" as never)
    .select("setting_name, setting_value");

  if (!primary.error && Array.isArray(primary.data)) {
    return (primary.data as Array<{ setting_name: string; setting_value: string }>)
      .filter((row) => typeof row.setting_name === "string")
      .map((row) => ({
        key: row.setting_name,
        value: row.setting_value ?? "",
      }));
  }

  // Backward-compatible fallback for older schema variants
  const legacy = await supabase
    .from("app_settings" as never)
    .select("key, value");

  if (legacy.error || !Array.isArray(legacy.data)) {
    const msg = primary.error?.message || legacy.error?.message || "Unknown app_settings read error";
    throw new Error(msg);
  }

  return (legacy.data as Array<{ key: string; value: string }>)
    .filter((row) => typeof row.key === "string")
    .map((row) => ({
      key: row.key,
      value: row.value ?? "",
    }));
}

async function upsertSetting(key: string, value: string): Promise<void> {
  const viaEdge = await invokeEdgeFunction<{ success?: boolean; error?: string }>("manage-ai-prompt", {
    body: {
      action: "save_setting",
      settingName: key,
      settingValue: value,
    },
  });

  if (!viaEdge.error && (viaEdge.data?.success ?? true)) return;
  const edgeError = viaEdge.error?.message || viaEdge.data?.error || "Failed to persist setting via edge function";
  throw new Error(edgeError);
}

/**
 * Fetch all rows from `app_settings` and merge into localStorage.
 * Called once at app startup. Safe to call multiple times (no-op after first).
 */
export async function initGlobalSettings(): Promise<void> {
  if (_initialised) return;
  _initialised = true;

  try {
    const data = await fetchAllSettings();

    if (!data || !Array.isArray(data) || data.length === 0) return;

    // Merge remote values into localStorage (remote wins)
    let stored: Record<string, string> = {};
    try {
      const raw = localStorage.getItem("app_config");
      stored = raw ? JSON.parse(raw) : {};
    } catch {
      stored = {};
    }

    for (const row of data) {
      stored[row.key] = row.value;
    }

    localStorage.setItem("app_config", JSON.stringify(stored));
    console.log(`[globalSettings] synced ${data.length} settings from database`);
  } catch (err) {
    console.warn("[globalSettings] init error:", err);
  }
}

/**
 * Upsert a single key-value pair into the `app_settings` table.
 * Fire-and-forget — errors are logged but never thrown.
 */
export function persistConfigValue(key: string, value: string): void {
  upsertSetting(key, value)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message) {
        console.warn(`[globalSettings] upsert failed for "${key}":`, message);
      }
    });
}
