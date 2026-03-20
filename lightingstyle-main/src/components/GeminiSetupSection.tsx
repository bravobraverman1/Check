import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, ExternalLink, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import {
  getGeminiConfig,
  updateGeminiConfig,
  performGeminiConnectionTest,
  getGeminiTestStatus,
} from "@/lib/geminiConfig";
import { invalidateReadCache } from "@/lib/supabaseGoogleSheets";
import { useQueryClient } from "@tanstack/react-query";
import { broadcastConfigChange, onConfigChange } from "@/lib/configSync";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeAuth";


// GitHub repository configuration
const GITHUB_REPO_URL = "https://github.com/bravobraverman1/lighting-style-product-creation";

interface GeminiSetupSectionProps {
  supabaseUrl: string;
  supabaseAnonKey: string;
  isValidSupabaseUrl: boolean;
}

// ── Supabase app_settings helpers ────────────────────────────────
// Cast through unknown to bypass strict table typing for the dynamic app_settings table
async function getAppSetting(key: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("app_settings")
      .select("setting_value")
      .eq("setting_name", key)
      .maybeSingle();
    if (error || !data) return null;
    return data.setting_value as string;
  } catch {
    return null;
  }
}

async function setAppSetting(key: string, value: string): Promise<void> {
  try {
    const { data: viaFnData, error: viaFnError } = await invokeEdgeFunction<{
      success?: boolean;
      error?: string;
    }>("manage-ai-prompt", {
      body: {
        action: "save_setting",
        settingName: key,
        settingValue: value,
      },
    });

    if (!viaFnError && (viaFnData?.success ?? true)) return;
    const edgeError = viaFnError?.message || viaFnData?.error || "Failed to persist setting via edge function";
    console.warn("setAppSetting error:", edgeError);
  } catch (e) {
    console.warn("setAppSetting failed:", e);
  }
}

export function GeminiSetupSection({ supabaseUrl, supabaseAnonKey, isValidSupabaseUrl }: GeminiSetupSectionProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [geminiConfig, setGeminiConfig] = useState(() => getGeminiConfig());
  const [testingConnection, setTestingConnection] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [appSettingsTableMissing, setAppSettingsTableMissing] = useState(false);

  // Load gemini_enabled from Supabase app_settings on mount.
  // Falls back to the value already in getGeminiConfig() (localStorage) if Supabase table doesn't exist yet.
  useEffect(() => {
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase as any)
          .from("app_settings")
          .select("setting_value")
          .eq("setting_name", "gemini_enabled")
          .maybeSingle();

        if (error) {
          // Table likely missing — show warning
          console.warn("app_settings table error:", error.message);
          setAppSettingsTableMissing(true);
        } else {
          setAppSettingsTableMissing(false);
          if (data) {
            const enabled = data.setting_value === "true";
            updateGeminiConfig({ enabled });
            setGeminiConfig((prev) => ({ ...prev, enabled }));
          }
        }
      } catch (e) {
        setAppSettingsTableMissing(true);
      }
      setSettingsLoaded(true);
    })();
  }, []);

  // Subscribe to Supabase Realtime for app_settings changes
  useEffect(() => {
    const channel = supabase
      .channel("app_settings_realtime")
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "app_settings" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          const row = payload.new as { setting_name: string; setting_value: string } | undefined;
          if (row?.setting_name === "gemini_enabled") {
            const enabled = row.setting_value === "true";
            updateGeminiConfig({ enabled });
            setGeminiConfig((prev) => ({ ...prev, enabled }));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Also listen for broadcast-based sync (same-tab fast path)
  useEffect(() => {
    return onConfigChange((event, payload) => {
      if (event === "gemini-enabled-changed") {
        const enabled = Boolean(payload.enabled);
        updateGeminiConfig({ enabled });
        setGeminiConfig((prev) => ({ ...prev, enabled }));
      }
    });
  }, []);

  const SUPABASE_URL_PATTERN = /https:\/\/([a-z0-9-]+)\.supabase\.co/i;
  const supabaseProjectRef = supabaseUrl.match(SUPABASE_URL_PATTERN)?.[1] || "";
  const testStatus = getGeminiTestStatus();

  const handleEnableChange = async (enabled: boolean) => {
    // updateGeminiConfig writes to localStorage (app_config key) immediately
    updateGeminiConfig({ enabled });
    setGeminiConfig((prev) => ({ ...prev, enabled }));
    // Persist to Supabase so ALL new sessions / incognito tabs pick it up
    await setAppSetting("gemini_enabled", String(enabled));
    // Also broadcast for instant update to currently-open tabs
    broadcastConfigChange("gemini-enabled-changed", { enabled });
    toast({
      title: enabled ? "Gemini AI Enabled" : "Gemini AI Disabled",
      description: enabled
        ? "AI document extraction is now active for all users"
        : "AI features are turned off for all users",
    });
  };

  const testGeminiConnection = async () => {
    setTestingConnection(true);
    try {
      const success = await performGeminiConnectionTest();
      setGeminiConfig(getGeminiConfig());

      if (success) {
        toast({
          title: "Connected ✅",
          description: "Successfully connected to Gemini AI! Edge function is working and API key is valid.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Connection Failed",
          description: "Gemini edge function did not respond correctly. Check deployment and API key.",
        });
      }
    } catch (error) {
      let errorMessage = "An unexpected error occurred.";

      if (error instanceof Error) {
        if (error.message.includes("Failed to fetch") || error.message.includes("NetworkError")) {
          errorMessage = "Network error. Check your internet connection and that the Supabase project URL is correct.";
        } else if (error.message.includes("404")) {
          errorMessage = "Edge Function not found. Please deploy ai-jobs and ai-worker (see setup guide).";
        } else {
          errorMessage = error.message;
        }
      }

      toast({
        variant: "destructive",
        title: "Connection Error",
        description: errorMessage,
      });
    } finally {
      setTestingConnection(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* app_settings table missing warning */}
      {appSettingsTableMissing && (
        <div className="rounded-lg border-2 border-destructive bg-destructive/10 p-4 space-y-2">
          <h4 className="text-sm font-bold text-destructive">⚠️ Global Toggle Not Working — Run SQL First</h4>
          <p className="text-xs text-foreground">
            The <code className="bg-muted px-1 rounded">app_settings</code> table is missing from your database.
            The Gemini toggle currently only saves to this browser. To make it persist globally (including incognito/other devices), run this SQL in your Supabase SQL Editor:
          </p>
          <pre className="text-xs bg-muted p-3 rounded overflow-auto whitespace-pre-wrap font-mono text-foreground">{`-- Drop any existing policies and recreate (safe to run multiple times)
DROP POLICY IF EXISTS "allow_all_app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "allow_all" ON public.app_settings;
DROP POLICY IF EXISTS "read_app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "deny_client_write_app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "deny_client_update_app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "deny_client_delete_app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "deny_insert_app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "deny_update_app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "deny_delete_app_settings" ON public.app_settings;

-- Create table if it doesn't exist yet
CREATE TABLE IF NOT EXISTS public.app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_name text UNIQUE NOT NULL,
  setting_value text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings FORCE ROW LEVEL SECURITY;

-- Read-only from clients (writes go through edge functions using service role)
CREATE POLICY "read_app_settings" ON public.app_settings
  FOR SELECT TO anon, authenticated USING (true);

-- Deny client writes (edge functions use service role which bypasses RLS)
CREATE POLICY "deny_client_write_app_settings" ON public.app_settings
  AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK (false);

CREATE POLICY "deny_client_update_app_settings" ON public.app_settings
  AS RESTRICTIVE FOR UPDATE TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny_client_delete_app_settings" ON public.app_settings
  AS RESTRICTIVE FOR DELETE TO anon, authenticated
  USING (false);

-- Add to realtime (ignore error if already added)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`}</pre>
          <p className="text-xs text-muted-foreground">After running, refresh this page and toggle the switch again.</p>
        </div>
      )}

      {/* Help Banner — matches Google Sheets style */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950 dark:border-blue-800 p-4 space-y-2">
        <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-100">📚 Need Help Setting Up Gemini AI?</h4>
        <p className="text-xs text-blue-800 dark:text-blue-200">
          Follow the complete step-by-step setup guide to securely connect Gemini AI using a Supabase Edge Function.
        </p>
        <div className="pt-2">
          <Button type="button" variant="outline" size="sm" asChild className="bg-white dark:bg-gray-900">
            <a href={`${GITHUB_REPO_URL}/blob/main/GEMINI_AI_SETUP.md`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-1" /> View Complete Setup Guide
            </a>
          </Button>
        </div>
      </div>

      {/* Project Check Section — matches Google Sheets style */}
      <div className="space-y-3 rounded-lg border border-muted bg-muted/50 p-4">
        <h5 className="text-sm font-semibold">Project Check (Important)</h5>
        <p className="text-xs text-muted-foreground">
          The Gemini AI processor runs as a Supabase Edge Function. Verify your Supabase project configuration and GEMINI_API_KEY secret before testing.
        </p>
        <p className="text-xs font-semibold text-red-600 dark:text-red-400">
          ⚠️ Do NOT run Lovable "Security Fixer" for Edge Functions or anything related to cloud/database/AI.
          It can reroute requests to Lovable services and break your Supabase connection.
        </p>
        <div className="space-y-2 text-sm font-mono">
          <div className="flex items-start gap-2">
            <span className="text-xs text-muted-foreground w-32 shrink-0">Supabase URL:</span>
            <span className={`text-xs break-all ${isValidSupabaseUrl ? "text-foreground" : "text-red-600 dark:text-red-400"}`}>
              {supabaseUrl || "NOT CONFIGURED"}
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs text-muted-foreground w-32 shrink-0">Project Ref:</span>
            <span className={`text-xs ${supabaseProjectRef ? "text-green-600 dark:text-green-400 font-semibold" : "text-red-600 dark:text-red-400"}`}>
              {supabaseProjectRef ? `✓ Detected: ${supabaseProjectRef}` : "NOT CONFIGURED"}
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs text-muted-foreground w-32 shrink-0">Publishable Key:</span>
            <span className={`text-xs font-semibold ${supabaseAnonKey ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
              {supabaseAnonKey ? "✓ Detected" : "NOT CONFIGURED"}
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs text-muted-foreground w-32 shrink-0">Gemini Enabled:</span>
            <span className={`text-xs font-semibold ${geminiConfig.enabled ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
              {geminiConfig.enabled ? "✓ Enabled" : "⚠ Disabled"}
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs text-muted-foreground w-32 shrink-0">Last Test:</span>
            <span className={`text-xs font-semibold ${
              testStatus.status === "connected" ? "text-green-600 dark:text-green-400" :
              testStatus.status === "error" ? "text-red-600 dark:text-red-400" :
              "text-amber-600 dark:text-amber-400"
            }`}>
              {testStatus.status === "connected" ? "✓ Connected" :
               testStatus.status === "error" ? "✗ Failed" :
               "⚠ Not tested yet"}
            </span>
          </div>
        </div>
      </div>

      {/* Environment Variables Warning — matches Google Sheets style */}
      {(!isValidSupabaseUrl || !supabaseAnonKey) && (
        <div className="rounded-lg border-2 border-red-500 bg-red-50 dark:bg-red-950 dark:border-red-800 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <span className="text-red-600 dark:text-red-400 text-xl">⚠️</span>
            <div className="space-y-2 flex-1">
              <h5 className="text-sm font-bold text-red-900 dark:text-red-100">
                Environment Variables Not Configured
              </h5>
              <p className="text-xs text-red-800 dark:text-red-200">
                Your Supabase credentials are not set up. The Test Connection button is disabled until these are configured.
              </p>
              <div className="text-xs text-red-900 dark:text-red-100 space-y-2 bg-white/50 dark:bg-black/20 p-3 rounded border border-red-300 dark:border-red-700">
                <p className="font-semibold">Quick Fix:</p>
                <ol className="list-decimal list-inside space-y-1 ml-1">
                  <li>Open <code className="bg-red-100 dark:bg-red-900 px-1 py-0.5 rounded">src/config/publicEnv.ts</code> in your codebase</li>
                  <li>Set <code className="bg-red-100 dark:bg-red-900 px-1 py-0.5 rounded">SUPABASE_URL</code> and <code className="bg-red-100 dark:bg-red-900 px-1 py-0.5 rounded">SUPABASE_ANON_KEY</code> to your actual Supabase project values</li>
                  <li><strong>Publish/redeploy</strong> the site so changes take effect</li>
                  <li>Hard refresh this page (Ctrl+Shift+R)</li>
                </ol>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Enable/Disable Toggle */}
      <div className="space-y-3 rounded-lg border border-muted bg-muted/50 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h5 className="text-sm font-semibold">Enable Gemini AI</h5>
            <p className="text-xs text-muted-foreground mt-1">
              Toggle AI-powered document extraction on/off for the product entry form
            </p>
          </div>
          <Switch checked={geminiConfig.enabled} onCheckedChange={handleEnableChange} />
        </div>
      </div>

      {/* Test Connection Section — matches Google Sheets style */}
      <div className="space-y-3 border-l-2 border-primary pl-4">
        <h5 className="text-sm font-semibold">Test Your Connection</h5>
        <p className="text-sm text-muted-foreground">
          Once you've completed the setup guide above, test that the Gemini AI edge function is deployed and working.
        </p>
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={testGeminiConnection}
              disabled={testingConnection || !isValidSupabaseUrl || !supabaseAnonKey}
            >
              {testingConnection ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                  Testing Connection...
                </>
              ) : (
                <>
                  <ExternalLink className="h-3.5 w-3.5 mr-2" />
                  Test Connection
                </>
              )}
            </Button>
          </div>

          {/* Error Explanations — matches Google Sheets style */}
          <div className="rounded-lg border border-amber-600 bg-amber-50 dark:bg-amber-950 dark:border-amber-800 p-3 space-y-2">
            <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">🔴 "Connection Failed" or "Cannot Read Secrets" Error?</p>
            <div className="text-xs text-amber-900 dark:text-amber-100 space-y-1">
              <p className="font-semibold">This usually means you added GEMINI_API_KEY AFTER deploying the function.</p>
              <p className="font-medium">✅ Solution: Redeploy ai-jobs and ai-worker</p>
              <ol className="list-decimal list-inside space-y-0.5 ml-2">
                <li>Go to the <strong>Actions</strong> tab in your GitHub repository</li>
                <li>Run <strong>"Deploy ai-jobs Edge Function"</strong></li>
                <li>Run <strong>"Deploy ai-worker Edge Function"</strong></li>
                <li>Wait 2-3 minutes for completion</li>
                <li>Return here and click <strong>"Test Connection"</strong> again</li>
              </ol>
              <p className="italic mt-1">Why? Edge Functions load secrets at deployment time only. Adding secrets to an already-running function requires redeployment.</p>
              <div className="pt-2">
                <Button type="button" variant="outline" size="sm" asChild className="bg-white dark:bg-gray-900">
                  <a href={`${GITHUB_REPO_URL}/actions`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3 mr-1" /> Go to GitHub Actions Workflow
                  </a>
                </Button>
              </div>
            </div>
            <div className="pt-2 border-t border-amber-200 dark:border-amber-700">
              <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">Other Common Errors:</p>
              <ul className="text-xs text-amber-800 dark:text-amber-200 mt-1 space-y-0.5 list-disc list-inside">
                <li><strong>Edge Function not found (404):</strong> ai-jobs/ai-worker not deployed yet — see setup guide STEP 3</li>
                <li><strong>API Key invalid:</strong> Verify GEMINI_API_KEY is correct in Supabase → Edge Functions → Secrets</li>
                <li><strong>Storage bucket missing:</strong> Create "document-uploads" bucket in Supabase Storage</li>
              </ul>
            </div>
          </div>

          <div className="rounded-lg border border-green-600 bg-green-50 dark:bg-green-950 dark:border-green-800 p-3">
            <p className="text-xs font-semibold text-green-900 dark:text-green-100">✅ Successful test shows: "Connected" — Gemini AI is ready to extract product data.</p>
          </div>
        </div>
      </div>

    </div>
  );
}
