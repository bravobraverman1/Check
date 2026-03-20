import { SUPABASE_ANON_KEY } from "@/config/publicEnv";
import { supabase } from "@/integrations/supabase/client";

const IS_PUBLISHABLE_KEY = SUPABASE_ANON_KEY.startsWith("sb_publishable_");
const LOOKS_LIKE_JWT = SUPABASE_ANON_KEY.split(".").length === 3;
const ANON_SIGNIN_RETRY_MS = 30_000;

let ensureSessionInFlight: Promise<void> | null = null;
let lastEnsureSessionFailureAt = 0;
let anonymousProviderDisabled = false;

function isTestRuntime(): boolean {
  try {
    // Vitest sets this env var; avoid background auth side effects in tests.
    return typeof process !== "undefined" && process.env?.VITEST === "true";
  } catch {
    return false;
  }
}

async function getSessionAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session?.access_token ?? null;
}

/**
 * Ensures edge-function calls use a real JWT when project uses sb_publishable_* keys.
 * Falls back to legacy anon JWT key auth for older key formats.
 */
export async function ensureEdgeAuthSession(): Promise<void> {
  if (typeof window === "undefined") return;
  if (isTestRuntime()) return;

  const accessToken = await getSessionAccessToken();
  if (accessToken) return;
  if (!IS_PUBLISHABLE_KEY) return;

  if (anonymousProviderDisabled) return;

  const now = Date.now();
  if (lastEnsureSessionFailureAt > 0 && now - lastEnsureSessionFailureAt < ANON_SIGNIN_RETRY_MS) {
    return;
  }

  if (!ensureSessionInFlight) {
    ensureSessionInFlight = (async () => {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) {
        lastEnsureSessionFailureAt = Date.now();
        const message = (error.message || "").toLowerCase();
        const code = String((error as { code?: string }).code || "").toLowerCase();
        if (message.includes("anonymous sign-ins are disabled") || code === "anonymous_provider_disabled") {
          anonymousProviderDisabled = true;
        }
        console.warn("[edge-auth] Anonymous sign-in failed. Edge calls may return 401 until auth is configured.", error.message);
      }
    })().finally(() => {
      ensureSessionInFlight = null;
    });
  }

  await ensureSessionInFlight;
}

export function bootstrapEdgeAuth(): void {
  void ensureEdgeAuthSession();
}

export async function buildEdgeRequestHeaders(
  baseHeaders: Record<string, string> = {},
): Promise<Record<string, string>> {
  await ensureEdgeAuthSession();

  const headers: Record<string, string> = {
    ...baseHeaders,
    apikey: SUPABASE_ANON_KEY,
  };

  const accessToken = await getSessionAccessToken();
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    // Always send the anon key as bearer fallback so edge functions
    // that call rejectIfMissingProjectKey never see a missing token.
    headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  }

  return headers;
}

export function getEdgeAuthTroubleshootingMessage(detail: string): string | null {
  const text = (detail || "").toLowerCase();
  if (!text) return null;

  const jwtProblem =
    text.includes("invalid jwt") ||
    text.includes("invalid bearer token") ||
    text.includes("jwt malformed") ||
    text.includes("missing authorization") ||
    text.includes("authorization header is missing") ||
    text.includes("unauthorized");

  const anonDisabled =
    text.includes("anonymous sign-ins are disabled") ||
    text.includes("anonymous sign in is disabled");

  if (anonDisabled) {
    return "Anonymous auth is disabled. Enable Supabase Auth -> Providers -> Anonymous, then redeploy edge functions.";
  }

  if (jwtProblem) {
    return "Edge functions require a valid JWT. Enable Supabase Anonymous auth (or sign users in) so frontend calls can send a real access token.";
  }

  return null;
}

type EdgeInvokeOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
  region?: string;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function extractEdgeInvokeErrorMessage(error: unknown): Promise<string> {
  const errObj = asObject(error);
  const baseMessage = typeof errObj?.message === "string" ? errObj.message : "";

  // FunctionsHttpError includes the underlying Response as `context`.
  const ctx = errObj?.context;
  const response = asObject(ctx) as unknown as (Response & { status?: number }) | null;
  if (response && typeof response.clone === "function") {
    try {
      const text = await response.clone().text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const parsedMessage =
            (typeof parsed.error === "string" && parsed.error) ||
            (typeof parsed.message === "string" && parsed.message) ||
            "";
          if (parsedMessage) {
            return parsedMessage;
          }
        } catch {
          return text.trim();
        }
      }
      if (typeof response.status === "number" && response.status > 0) {
        return `Edge function returned HTTP ${response.status}`;
      }
    } catch {
      // Fall through to base message.
    }
  }

  return baseMessage || "Edge function request failed";
}

export async function invokeEdgeFunction<T = unknown>(
  functionName: string,
  options?: EdgeInvokeOptions,
) {
  const headers = await buildEdgeRequestHeaders(options?.headers ?? {});
  const result = await supabase.functions.invoke<T>(
    functionName,
    {
      ...options,
      headers,
    } as never,
  );
  if (!result.error) return result;

  const rawMessage = await extractEdgeInvokeErrorMessage(result.error);
  const hint = getEdgeAuthTroubleshootingMessage(rawMessage);
  return {
    data: result.data,
    error: new Error(hint || rawMessage),
  };
}
