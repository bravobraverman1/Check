const CORS_ALLOW_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").trim();
const SUPABASE_ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") || "").trim();
const SUPABASE_PUBLISHABLE_KEY = (Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
const TOKEN_VERIFY_TIMEOUT_MS = 4_000;
const TOKEN_VERIFY_CACHE_TTL_MS = 60_000;

const tokenVerifyCache = new Map<string, { ok: boolean; expiresAt: number }>();

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "https://lovable.dev",
  "https://lovable.app",
  "https://*.lovable.dev",
  "https://*.lovable.app",
  "https://lovableproject.com",
  "https://*.lovableproject.com",
];

function readEnvList(key: string): string[] {
  return (Deno.env.get(key) || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const configuredOrigins = [
  ...readEnvList("ALLOWED_ORIGINS"),
  ...readEnvList("ALLOWED_ORIGIN"),
];

export const ALLOWED_ORIGINS = Array.from(new Set([...configuredOrigins, ...DEFAULT_ALLOWED_ORIGINS]));

function parseBoolEnv(value: string | undefined | null, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

const ENFORCE_ORIGIN_ALLOWLIST = parseBoolEnv(Deno.env.get("ENFORCE_ORIGIN_ALLOWLIST"), true);

export function originMatches(allowed: string, origin: string): boolean {
  if (allowed === "*") return true;
  if (!allowed.includes("*")) return allowed === origin;

  // Wildcard support: https://*.example.com
  const escaped = allowed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(origin);
}

export function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some((allowed) => originMatches(allowed, origin));
}

export function getCorsHeaders(origin?: string | null, methods = "POST, OPTIONS"): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Allow-Methods": methods,
    Vary: "Origin",
  };

  if (origin) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

export function jsonResponse(
  payload: unknown,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function rejectIfOriginNotAllowed(
  origin: string | null | undefined,
  methods = "POST, OPTIONS",
  req?: Request,
): Response | null {
  if (!ENFORCE_ORIGIN_ALLOWLIST) return null;

  // Allow non-browser calls with explicit auth headers (server-to-server/internal).
  if (!origin) {
    const hasAuthHeaders = !!(
      req?.headers.get("authorization") ||
      req?.headers.get("apikey") ||
      req?.headers.get("x-ai-worker-sig") ||
      req?.headers.get("x-ai-worker-secret") ||
      req?.headers.get("x-cron-secret")
    );
    if (hasAuthHeaders) return null;
    return jsonResponse(
      { error: "Origin header is required" },
      403,
      getCorsHeaders(undefined, methods),
    );
  }
  if (isAllowedOrigin(origin)) return null;

  return jsonResponse(
    { error: "Origin not allowed" },
    403,
    getCorsHeaders(undefined, methods),
  );
}

function getBearerToken(req: Request): string {
  const authHeader = (req.headers.get("authorization") || "").trim();
  if (!authHeader.toLowerCase().startsWith("bearer ")) return "";
  return authHeader.slice(7).trim();
}

function isPublishableKey(token: string): boolean {
  return token.startsWith("sb_publishable_");
}

function looksLikeJwt(token: string): boolean {
  if (!token) return false;
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

async function verifySupabaseAccessToken(token: string): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  const now = Date.now();
  const cached = tokenVerifyCache.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.ok;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TOKEN_VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    const ok = response.ok;
    tokenVerifyCache.set(token, { ok, expiresAt: now + TOKEN_VERIFY_CACHE_TTL_MS });
    return ok;
  } catch {
    tokenVerifyCache.set(token, { ok: false, expiresAt: now + TOKEN_VERIFY_CACHE_TTL_MS });
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Edge auth hardening for edge functions.
 * - Allows service-role internal calls.
 * - Requires a valid end-user JWT for client calls (verified via Auth /user endpoint).
 */
export async function rejectIfMissingProjectKey(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const anonKey = SUPABASE_ANON_KEY;
  const publishableKey = SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = SUPABASE_SERVICE_ROLE_KEY;
  const knownKeys = [anonKey, publishableKey, serviceRoleKey].filter(Boolean);

  // Fail-closed on misconfiguration so sensitive handlers are never exposed.
  if (knownKeys.length === 0) {
    return jsonResponse({ error: "Function auth is not configured" }, 500, corsHeaders);
  }

  const apiKey = (req.headers.get("apikey") || "").trim();
  const bearer = getBearerToken(req);

  // Internal server-to-server calls may use service role key directly.
  if ((apiKey && apiKey === serviceRoleKey) || (bearer && bearer === serviceRoleKey)) {
    return null;
  }

  // Accept configured project keys directly (non-JWT publishable keys included).
  if (
    (apiKey && (apiKey === anonKey || apiKey === publishableKey)) ||
    (bearer && (bearer === anonKey || bearer === publishableKey))
  ) {
    return null;
  }

  // Browser fallback for projects where publishable key is the only client key.
  if (apiKey && bearer && apiKey === bearer && isPublishableKey(apiKey)) {
    return null;
  }

  // Client/browser calls must present a real access token.
  if (!bearer) {
    return jsonResponse({ error: "Missing bearer token" }, 401, corsHeaders);
  }

  if (!looksLikeJwt(bearer)) {
    return jsonResponse({ error: "Invalid bearer token" }, 401, corsHeaders);
  }

  if (apiKey && apiKey !== anonKey && apiKey !== publishableKey) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  }

  const verified = await verifySupabaseAccessToken(bearer);
  if (!verified) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  }

  return null;
}

export async function parseJsonObject(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }

  return parsed as Record<string, unknown>;
}
