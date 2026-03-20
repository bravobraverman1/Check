import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getCorsHeaders,
  jsonResponse,
  parseJsonObject,
  rejectIfMissingProjectKey,
  rejectIfOriginNotAllowed,
} from "../_shared/security.ts";

type CleanupRule = {
  bucket: string;
  expiryMs: number;
  rootPath?: string;
};

const TRANSIENT_UPLOAD_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
const LOADING_DOCK_SNAPSHOT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LIST_PAGE_SIZE = 500;
const REMOVE_BATCH_SIZE = 100;

const SESSION_BUCKETS = [
  "document-uploads-1",
  "document-uploads-2",
  "document-uploads-3",
  "document-uploads-4",
] as const;

const CLEANUP_RULES: CleanupRule[] = [
  ...SESSION_BUCKETS.map((bucket) => ({
    bucket,
    expiryMs: TRANSIENT_UPLOAD_EXPIRY_MS,
  })),
  {
    bucket: "document-uploads-form-json",
    expiryMs: LOADING_DOCK_SNAPSHOT_EXPIRY_MS,
    rootPath: "form-imports",
  },
  {
    bucket: "document-uploads-loading-dock",
    expiryMs: LOADING_DOCK_SNAPSHOT_EXPIRY_MS,
    rootPath: "loading-dock-snapshots",
  },
];

const CLEANUP_TOKEN = Deno.env.get("CLEANUP_CRON_TOKEN") || "";

function hasValidCleanupToken(req: Request): boolean {
  if (!CLEANUP_TOKEN) return false;
  return req.headers.get("x-cleanup-token") === CLEANUP_TOKEN;
}

function isValidSessionId(sessionId: unknown): sessionId is string {
  if (typeof sessionId !== "string") return false;
  return /^s_[a-zA-Z0-9_-]{6,120}$/.test(sessionId.trim());
}

/**
 * Targeted cleanup: remove ALL files for a specific session in a specific bucket.
 * Called via sendBeacon when a user closes their browser tab.
 */
async function cleanupSession(
  supabase: ReturnType<typeof createClient<any>>,
  bucket: string,
  sessionId: string,
): Promise<number> {
  let cleaned = 0;

  // 1. Remove session subdirectory files
  const { data: subFiles } = await supabase.storage.from(bucket).list(sessionId, { limit: 500 });
  if (subFiles && subFiles.length > 0) {
    const paths = subFiles.map((f: { name: string }) => `${sessionId}/${f.name}`);
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (!error) cleaned += paths.length;
  }

  return cleaned;
}

async function listAllEntries(
  supabase: ReturnType<typeof createClient<any>>,
  bucket: string,
  path: string,
): Promise<Array<{ name: string; id: string | null; created_at?: string | null }>> {
  const entries: Array<{ name: string; id: string | null; created_at?: string | null }> = [];

  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await supabase.storage.from(bucket).list(path, {
      limit: LIST_PAGE_SIZE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    if (!data || data.length === 0) break;
    entries.push(...data);
    if (data.length < LIST_PAGE_SIZE) break;
  }

  return entries;
}

async function collectExpiredPaths(
  supabase: ReturnType<typeof createClient<any>>,
  rule: CleanupRule,
  path: string,
  now: number,
): Promise<string[]> {
  const entries = await listAllEntries(supabase, rule.bucket, path);
  if (entries.length === 0) return [];

  const expiredPaths: string[] = [];
  for (const entry of entries) {
    const childPath = path ? `${path}/${entry.name}` : entry.name;
    if (entry.id === null) {
      expiredPaths.push(...await collectExpiredPaths(supabase, rule, childPath, now));
      continue;
    }

    const created = new Date(entry.created_at || 0).getTime();
    if (now - created >= rule.expiryMs) {
      expiredPaths.push(childPath);
    }
  }

  return expiredPaths;
}

async function removePathsBatched(
  supabase: ReturnType<typeof createClient<any>>,
  bucket: string,
  paths: string[],
): Promise<number> {
  let removed = 0;

  for (let index = 0; index < paths.length; index += REMOVE_BATCH_SIZE) {
    const batch = paths.slice(index, index + REMOVE_BATCH_SIZE);
    const { error } = await supabase.storage.from(bucket).remove(batch);
    if (error) {
      console.error(`Failed to clean ${bucket}:`, error);
      continue;
    }
    removed += batch.length;
  }

  return removed;
}

/**
 * Full cleanup: remove all expired files across all buckets.
 * Called by the cron job every 30 minutes.
 */
async function cleanupExpired(supabase: ReturnType<typeof createClient<any>>): Promise<number> {
  const now = Date.now();
  let totalCleaned = 0;

  for (const rule of CLEANUP_RULES) {
    const expiredPaths = await collectExpiredPaths(supabase, rule, rule.rootPath ?? "", now);
    if (expiredPaths.length === 0) continue;
    totalCleaned += await removePathsBatched(supabase, rule.bucket, expiredPaths);
  }

  return totalCleaned;
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

  // Allow either cron cleanup token or project key auth.
  if (!hasValidCleanupToken(req)) {
    const authRejected = await rejectIfMissingProjectKey(req, corsHeaders);
    if (authRejected) return authRejected;
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return jsonResponse(
        { success: false, error: "Supabase environment variables are not configured" },
        500,
        corsHeaders,
      );
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Check for targeted cleanup request (from sendBeacon on tab close)
    const body = await parseJsonObject(req);

    if (body.bucket !== undefined || body.sessionId !== undefined) {
      // Targeted session cleanup is security-sensitive.
      // Require cron/internal token; project anon key alone is insufficient.
      if (!hasValidCleanupToken(req)) {
        return jsonResponse(
          { success: false, error: "Targeted cleanup requires internal token" },
          403,
          corsHeaders,
        );
      }

      // Targeted: clean specific session's files immediately
      const bucket = typeof body.bucket === "string" ? body.bucket : "";
      const sessionId = body.sessionId;

      if (!SESSION_BUCKETS.includes(bucket as (typeof SESSION_BUCKETS)[number])) {
        return jsonResponse({ success: false, error: "Invalid bucket" }, 400, corsHeaders);
      }
      if (!isValidSessionId(sessionId)) {
        return jsonResponse({ success: false, error: "Invalid sessionId" }, 400, corsHeaders);
      }

      const cleaned = await cleanupSession(supabase, bucket, sessionId);
      return jsonResponse({ success: true, message: `Cleaned ${cleaned} files from ${bucket}` }, 200, corsHeaders);
    }

    // Full cleanup (cron job)
    const totalCleaned = await cleanupExpired(supabase);
    return jsonResponse(
      {
        success: true,
        message: `Cleaned ${totalCleaned} expired files across ${CLEANUP_RULES.length} cleanup scopes`,
      },
      200,
      corsHeaders,
    );
  } catch (e) {
    console.error("cleanup-uploads error:", e);
    const isBadRequest = e instanceof Error && /invalid json|json body must/i.test(e.message);
    if (isBadRequest) {
      return jsonResponse({ success: false, error: String(e) }, 400, corsHeaders);
    }
    const errorRef = crypto.randomUUID();
    console.error("cleanup-uploads internal error:", { errorRef, e });
    return jsonResponse({ success: false, error: "Internal cleanup error", error_ref: errorRef }, 500, corsHeaders);
  }
});
