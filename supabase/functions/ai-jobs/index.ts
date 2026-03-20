// ai-jobs: unified entry point
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  getCorsHeaders,
  jsonResponse,
  parseJsonObject,
  rejectIfMissingProjectKey,
  rejectIfOriginNotAllowed,
} from "../_shared/security.ts";
import { getEnforcedModel } from "../_shared/aiConfig.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const AI_WORKER_SECRET = Deno.env.get("AI_WORKER_SECRET") || "";
const AI_WORKER_SHARED_SECRET = AI_WORKER_SECRET || SUPABASE_SERVICE_ROLE_KEY;
const ENFORCED_MODEL = getEnforcedModel();
const MAX_FILES = (() => {
  const n = Number(Deno.env.get("AI_MAX_FILES") || "5");
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(20, Math.floor(n));
})();
const WORKER_TRIGGER_STATUS_TIMEOUT_MS = (() => {
  const n = Number(Deno.env.get("AI_WORKER_TRIGGER_STATUS_TIMEOUT_MS") || "12000");
  if (!Number.isFinite(n) || n < 2000) return 12_000;
  return Math.floor(n);
})();
const STALE_NO_CHUNKS_MS = (() => {
  const n = Number(Deno.env.get("AI_STALE_NO_CHUNKS_MS") || "180000");
  if (!Number.isFinite(n) || n < 10_000) return 180_000;
  return Math.floor(n);
})();
const STALE_RUNNING_NO_PROGRESS_MS = (() => {
  const n = Number(Deno.env.get("AI_STALE_RUNNING_NO_PROGRESS_MS") || "180000");
  if (!Number.isFinite(n) || n < 30_000) return 180_000;
  return Math.floor(n);
})();
const REAP_SCAN_LIMIT = (() => {
  const n = Number(Deno.env.get("AI_REAP_SCAN_LIMIT") || "120");
  if (!Number.isFinite(n) || n < 20) return 120;
  return Math.min(400, Math.floor(n));
})();
const RECOVER_LOOKBACK_MS = (() => {
  const n = Number(Deno.env.get("AI_RECOVER_LOOKBACK_MS") || "1800000");
  if (!Number.isFinite(n) || n < 60_000) return 1_800_000;
  return Math.floor(n);
})();
const STALE_RUNNING_CHUNK_REQUEUE_MS = (() => {
  const n = Number(Deno.env.get("AI_STALE_RUNNING_CHUNK_REQUEUE_MS") || "120000");
  if (!Number.isFinite(n) || n < 30_000) return 120_000;
  return Math.min(180_000, Math.floor(n));
})();
const STALE_RUNNING_DIRECT_FILES_REQUEUE_MS = (() => {
  const n = Number(Deno.env.get("AI_STALE_RUNNING_DIRECT_FILES_REQUEUE_MS") || "360000");
  const minDirectMs = STALE_RUNNING_CHUNK_REQUEUE_MS + 30_000;
  if (!Number.isFinite(n) || n < minDirectMs) return minDirectMs;
  return Math.min(600_000, Math.floor(n));
})();
const STALE_RUNNING_CHUNK_CANCEL_MS = (() => {
  const n = Number(Deno.env.get("AI_STALE_RUNNING_CHUNK_CANCEL_MS") || "600000");
  const minCancelMs = STALE_RUNNING_CHUNK_REQUEUE_MS + 60_000;
  if (!Number.isFinite(n) || n < minCancelMs) return minCancelMs;
  return Math.max(minCancelMs, Math.min(420_000, Math.floor(n)));
})();
const STALE_RUNNING_CHUNK_RETRY_MAX = (() => {
  const n = Number(Deno.env.get("AI_STALE_RUNNING_CHUNK_RETRY_MAX") || "1");
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(2, Math.floor(n));
})();
const ABSOLUTE_JOB_RUNTIME_MS = (() => {
  const n = Number(Deno.env.get("AI_ABSOLUTE_JOB_RUNTIME_MS") || "420000");
  if (!Number.isFinite(n) || n < 120_000) return 420_000;
  return Math.min(1_800_000, Math.floor(n));
})();
const AI_HISTORY_RETENTION_JOBS_MS = (() => {
  const n = Number(Deno.env.get("AI_HISTORY_RETENTION_JOBS_MS") || `${14 * 24 * 60 * 60 * 1000}`);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(24 * 60 * 60 * 1000, Math.floor(n));
})();
const AI_HISTORY_RETENTION_CACHE_MS = (() => {
  const n = Number(Deno.env.get("AI_HISTORY_RETENTION_CACHE_MS") || `${30 * 24 * 60 * 60 * 1000}`);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(24 * 60 * 60 * 1000, Math.floor(n));
})();
const AI_HISTORY_RETENTION_SWEEP_INTERVAL_MS = (() => {
  const n = Number(Deno.env.get("AI_HISTORY_RETENTION_SWEEP_INTERVAL_MS") || "21600000");
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(15 * 60 * 1000, Math.floor(n));
})();
const AI_HISTORY_RETENTION_JOB_BATCH_SIZE = (() => {
  const n = Number(Deno.env.get("AI_HISTORY_RETENTION_JOB_BATCH_SIZE") || "25");
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, Math.max(5, Math.floor(n)));
})();
const AI_HISTORY_RETENTION_CACHE_BATCH_SIZE = (() => {
  const n = Number(Deno.env.get("AI_HISTORY_RETENTION_CACHE_BATCH_SIZE") || "20");
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(50, Math.max(5, Math.floor(n)));
})();
const TERMINAL_JOB_STATUSES = ["done", "error", "cancelled"];
let lastHistoryRetentionSweepStartedAtMs = 0;
let historyRetentionSweepInFlight: Promise<void> | null = null;

const JOB_TYPES = new Set([
  "pdf_compare",
  "generate_data",
  "text_compare",
  "filter_extract",
  "admin_action",
  "generic",
]);

interface ChunkCounts {
  total: number;
  queued: number;
  running: number;
  done: number;
  error: number;
  cancelled: number;
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  }
  if (typeof value === "number") return value === 1;
  return false;
}

async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildWorkerHeaders(bodyText: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: SUPABASE_SERVICE_ROLE_KEY,
  };

  if (AI_WORKER_SHARED_SECRET) {
    if (AI_WORKER_SECRET) {
      // Backward-compatible explicit secret header during staged rollout.
      headers["x-ai-worker-secret"] = AI_WORKER_SECRET;
    }
    const ts = Date.now().toString();
    const signature = await hmacSha256Hex(AI_WORKER_SHARED_SECRET, `${ts}.${bodyText}`);
    headers["x-ai-worker-ts"] = ts;
    headers["x-ai-worker-sig"] = signature;
  }

  return headers;
}

function trimPreview(value: string, max = 600): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function summarizeChunkTiming(timing: Record<string, unknown> | null): Record<string, unknown> {
  const source = timing || {};
  return {
    started_at: source.started_at ?? null,
    finished_at: source.finished_at ?? null,
    total_ms: source.total_ms ?? 0,
    gemini_ms: source.gemini_ms ?? 0,
    prompt_chars: source.prompt_chars ?? 0,
    output_chars: source.output_chars ?? 0,
    retry_count: source.retry_count ?? 0,
    cache_hit: source.cache_hit ?? false,
    http_status: source.http_status ?? null,
    gemini_error: source.gemini_error ?? null,
    source: source.source ?? null,
    direct_files_mode: source.direct_files_mode ?? false,
    input_file_count: source.input_file_count ?? 0,
    input_file_bytes: source.input_file_bytes ?? 0,
  };
}

function inferType(payload: Record<string, unknown>): string {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const documentText = typeof payload.documentText === "string" ? payload.documentText : "";
  const explicitType = typeof payload.type === "string" ? payload.type.trim() : "";

  if (explicitType && JOB_TYPES.has(explicitType)) return explicitType;
  if (explicitType) return "generic";

  if (files.length > 0) {
    const labels = files
      .map((f) => (f && typeof f === "object" ? (f as { label?: unknown }).label : ""))
      .map((v) => (typeof v === "string" ? v.toLowerCase() : ""));

    if (labels.includes("supplier") && labels.includes("ls")) return "pdf_compare";
    return "generate_data";
  }

  if (documentText.trim()) return "text_compare";
  return "generic";
}

function normalizeConfigFlags(
  type: string,
  flags: unknown,
): Record<string, unknown> {
  const source = (flags && typeof flags === "object" && !Array.isArray(flags))
    ? (flags as Record<string, unknown>)
    : {};

  const defaultSinglePass = [
    "pdf_compare",
    "generate_data",
    "text_compare",
    "filter_extract",
    "admin_action",
    "generic",
  ].includes(type);

  // Temperature is server-authoritative.
  // For deterministic actions (generate_data, pdf_compare, filter_extract, text_compare),
  // force temperature=0 regardless of client request. Only allow override for non-strict types.
  const STRICT_TEMP_ZERO_TYPES = ["generate_data", "pdf_compare", "filter_extract", "text_compare"];
  const isStrictTempType = STRICT_TEMP_ZERO_TYPES.includes(type);
  const rawTemp = source.temperature;
  const temperature = isStrictTempType
    ? 0
    : (typeof rawTemp === "number" && Number.isFinite(rawTemp)
      ? Math.min(2, Math.max(0, rawTemp))
      : 0);

  // strictJson: when true, worker skips JSON repair and fails fast on invalid JSON.
  // Keep default false for resilient extraction unless explicitly enabled.
  const strictJson = typeof source.strictJson === "boolean"
    ? source.strictJson
    : false;

  // strictGrounding: always true for production actions, logs into debug_meta
  const strictGrounding = typeof source.strictGrounding === "boolean"
    ? source.strictGrounding
    : true;

  // Cache policy:
  // server-authoritative hard disable for all AI job types.
  const disableCache = true;

  return {
    ...source,
    singlePass: typeof source.singlePass === "boolean" ? source.singlePass : defaultSinglePass,
    directFiles: typeof source.directFiles === "boolean" ? source.directFiles : true,
    disableCache,
    // Server-authoritative temperature — forced to 0 for strict action types
    temperature,
    strictJson,
    strictGrounding,
    // Optional hard validation for strict section-based outputs.
    strictSectionValidation: typeof source.strictSectionValidation === "boolean"
      ? source.strictSectionValidation
      : false,
  };
}

function sanitizeFiles(value: unknown): Array<{ bucket: string; path: string; filename?: string; label?: string }> {
  if (!Array.isArray(value)) return [];

  const refs: Array<{ bucket: string; path: string; filename?: string; label?: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const bucket = typeof (item as { bucket?: unknown }).bucket === "string" ? (item as { bucket: string }).bucket : "";
    const path = typeof (item as { path?: unknown }).path === "string" ? (item as { path: string }).path : "";
    const filename = typeof (item as { filename?: unknown }).filename === "string" ? (item as { filename: string }).filename : undefined;
    const label = typeof (item as { label?: unknown }).label === "string" ? (item as { label: string }).label : undefined;
    if (!bucket || !path) continue;
    refs.push({ bucket, path, ...(filename ? { filename } : {}), ...(label ? { label } : {}) });
    if (refs.length >= MAX_FILES) break;
  }
  return refs;
}

function isInstructionLikeValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === "instructions" || normalized.includes("instruction");
}

function isInstructionLikeFile(file: { filename?: string; label?: string }): boolean {
  if (typeof file.label === "string" && isInstructionLikeValue(file.label)) return true;
  if (typeof file.filename === "string" && file.filename.toLowerCase().includes("instruction")) return true;
  return false;
}

function hasInstructionFile(
  files: Array<{ bucket: string; path: string; filename?: string; label?: string }>,
): boolean {
  return files.some((file) => isInstructionLikeFile(file));
}

function countChunkStatuses(rows: Array<{ status: string }>): ChunkCounts {
  const counts: ChunkCounts = {
    total: 0,
    queued: 0,
    running: 0,
    done: 0,
    error: 0,
    cancelled: 0,
  };

  for (const row of rows) {
    counts.total += 1;
    if (row.status === "queued") counts.queued += 1;
    else if (row.status === "running") counts.running += 1;
    else if (row.status === "done") counts.done += 1;
    else if (row.status === "error") counts.error += 1;
    else if (row.status === "cancelled") counts.cancelled += 1;
  }

  return counts;
}

async function getChunkCounts(
  supabase: any,
  jobId: string,
): Promise<ChunkCounts> {
  const { data } = await supabase
    .from("ai_job_chunks")
    .select("status")
    .eq("job_id", jobId);

  return countChunkStatuses((data || []) as Array<{ status: string }>);
}

function resolveAction(
  req: Request,
  body: Record<string, unknown>,
): "start" | "status" | "cancel" | "list" | "cancel_stale" | "hard_reset" | "recover_latest" {
  const url = new URL(req.url);
  const queryAction = (url.searchParams.get("action") || "").toLowerCase();
  const bodyAction = typeof body.action === "string" ? body.action.toLowerCase() : "";
  const action = bodyAction || queryAction;

  if (
    action === "start" ||
    action === "status" ||
    action === "cancel" ||
    action === "list" ||
    action === "cancel_stale" ||
    action === "hard_reset" ||
    action === "recover_latest"
  ) {
    return action;
  }

  if (body.list === true || url.searchParams.get("list") === "1") return "list";
  if (body.cancel === true) return "cancel";
  if (typeof body.prompt === "string" && body.prompt.trim()) return "start";

  return "status";
}

function parseMs(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : NaN;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function getChunkActivityMs(row: { timing?: unknown; created_at?: unknown; updated_at?: unknown }): number {
  const timing = isPlainObject(row.timing) ? row.timing : {};
  const heartbeatMs = parseMs(timing.last_activity_at);
  if (Number.isFinite(heartbeatMs)) return heartbeatMs;
  // Check updated_at BEFORE started_at — the heartbeat keeps updated_at fresh
  // every 15s while started_at is only set once when the chunk is claimed.
  // Previous ordering caused the watchdog to ignore heartbeats and kill active chunks.
  const updatedMs = parseMs(row.updated_at);
  if (Number.isFinite(updatedMs)) return updatedMs;
  const startedMs = parseMs(timing.started_at);
  if (Number.isFinite(startedMs)) return startedMs;
  const createdMs = parseMs(row.created_at);
  if (Number.isFinite(createdMs)) return createdMs;
  return NaN;
}

function getRunningChunkStaleThresholdMs(timing: unknown): number {
  const source = isPlainObject(timing) ? timing : {};
  const isDirectFiles = Boolean(source.direct_files_mode);
  return isDirectFiles
    ? Math.max(STALE_RUNNING_CHUNK_REQUEUE_MS, STALE_RUNNING_DIRECT_FILES_REQUEUE_MS)
    : STALE_RUNNING_CHUNK_REQUEUE_MS;
}

async function cancelJobsWithChunks(
  supabase: any,
  jobIds: string[],
  reason: string,
): Promise<number> {
  if (jobIds.length === 0) return 0;

  const now = toIsoNow();
  const { data: cancelledJobs } = await supabase
    .from("ai_jobs")
    .update({
      status: "cancelled",
      progress: 0,
      error: reason,
      updated_at: now,
    })
    .in("id", jobIds)
    .in("status", ["queued", "running"])
    .select("id");

  await supabase
    .from("ai_job_chunks")
    .update({
      status: "cancelled",
      error: reason,
      updated_at: now,
    })
    .in("job_id", jobIds)
    .in("status", ["queued", "running"]);

  return (cancelledJobs || []).length;
}

async function hardResetAllJobs(
  supabase: any,
  reason: string,
): Promise<{ cancelledJobs: number; cancelledChunks: number; jobIds: string[] }> {
  const now = toIsoNow();

  const { data: cancelledJobsRows, error: jobsError } = await supabase
    .from("ai_jobs")
    .update({
      status: "cancelled",
      progress: 0,
      error: reason,
      updated_at: now,
    })
    .in("status", ["queued", "running"])
    .select("id");

  if (jobsError) {
    throw new Error(`Hard reset failed while cancelling jobs: ${jobsError.message}`);
  }

  const jobIds = (cancelledJobsRows || [])
    .map((job: any) => String(job.id || ""))
    .filter((id: string) => id.length > 0);

  if (jobIds.length === 0) {
    return { cancelledJobs: 0, cancelledChunks: 0, jobIds: [] };
  }

  const { data: cancelledChunkRows, error: chunksError } = await supabase
    .from("ai_job_chunks")
    .update({
      status: "cancelled",
      error: reason,
      updated_at: now,
    })
    .in("job_id", jobIds)
    .in("status", ["queued", "running"])
    .select("id");

  if (chunksError) {
    throw new Error(`Hard reset failed while cancelling chunks: ${chunksError.message}`);
  }

  return {
    cancelledJobs: jobIds.length,
    cancelledChunks: (cancelledChunkRows || []).length,
    jobIds,
  };
}

async function reapStaleJobs(
  supabase: any,
  scanLimit = REAP_SCAN_LIMIT,
): Promise<{ scanned: number; cancelled: number; jobIds: string[] }> {
  const { data: candidates } = await supabase
    .from("ai_jobs")
    .select("id, status, progress, created_at, updated_at")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(scanLimit);

  const jobs = (candidates || []) as Array<{
    id: string;
    status: string;
    progress: number;
    created_at: string;
    updated_at: string;
  }>;
  if (jobs.length === 0) {
    return { scanned: 0, cancelled: 0, jobIds: [] };
  }

  const jobIds = jobs.map((job) => job.id);
  const { data: chunkRows } = await supabase
    .from("ai_job_chunks")
    .select("job_id, status, timing, created_at, updated_at")
    .in("job_id", jobIds);

  const countsByJob = new Map<string, ChunkCounts>();
  for (const jobId of jobIds) {
    countsByJob.set(jobId, {
      total: 0,
      queued: 0,
      running: 0,
      done: 0,
      error: 0,
      cancelled: 0,
    });
  }

  const staleRunningChunkByJob = new Set<string>();
  const now = Date.now();
  for (const row of (chunkRows || []) as Array<{ job_id: string; status: string; timing?: unknown; created_at?: string; updated_at?: string }>) {
    const counts = countsByJob.get(row.job_id);
    if (!counts) continue;
    counts.total += 1;
    if (row.status === "queued") counts.queued += 1;
    else if (row.status === "running") counts.running += 1;
    else if (row.status === "done") counts.done += 1;
    else if (row.status === "error") counts.error += 1;
    else if (row.status === "cancelled") counts.cancelled += 1;

    if (row.status === "running") {
      const activityMs = getChunkActivityMs(row);
      if (Number.isFinite(activityMs) && now - activityMs >= STALE_RUNNING_CHUNK_CANCEL_MS) {
        staleRunningChunkByJob.add(row.job_id);
      }
    }
  }

  const staleIds: string[] = [];

  for (const job of jobs) {
    const createdMs = parseMs(job.created_at);
    const updatedMs = parseMs(job.updated_at);
    const ageMs = Number.isFinite(createdMs) ? (now - createdMs) : (Number.isFinite(updatedMs) ? now - updatedMs : 0);
    const counts = countsByJob.get(job.id) || {
      total: 0,
      queued: 0,
      running: 0,
      done: 0,
      error: 0,
      cancelled: 0,
    };

    // Stuck before chunk preflight has started.
    const staleNoChunks = counts.total === 0 && ageMs >= STALE_NO_CHUNKS_MS;
    // Running job with no active/done chunks for too long.
    const staleRunningNoProgress = job.status === "running"
      && counts.done === 0
      && counts.queued === 0
      && counts.running === 0
      && ageMs >= STALE_RUNNING_NO_PROGRESS_MS;
    const staleRunningChunk = staleRunningChunkByJob.has(job.id);

    if (staleNoChunks || staleRunningNoProgress || staleRunningChunk) {
      staleIds.push(job.id);
    }
  }

  if (staleIds.length === 0) {
    return { scanned: jobs.length, cancelled: 0, jobIds: [] };
  }

  const reason = "Auto-cancelled stale AI job (no active chunk progress).";
  const cancelled = await cancelJobsWithChunks(supabase, staleIds, reason);
  return {
    scanned: jobs.length,
    cancelled,
    jobIds: staleIds.slice(0, cancelled),
  };
}

async function pruneRetainedAiJobs(
  supabase: any,
  cutoffIso: string,
  batchSize: number,
): Promise<{ scanned: number; deleted: number; jobIds: string[] }> {
  if (batchSize <= 0) return { scanned: 0, deleted: 0, jobIds: [] };

  const { data: rows, error } = await supabase
    .from("ai_jobs")
    .select("id")
    .in("status", TERMINAL_JOB_STATUSES)
    .lt("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(batchSize);

  if (error) {
    throw new Error(`AI history prune failed while listing old jobs: ${error.message}`);
  }

  const jobIds = ((rows || []) as Array<{ id: string }>).map((row) => row.id).filter(Boolean);
  if (jobIds.length === 0) return { scanned: 0, deleted: 0, jobIds: [] };

  const { error: deleteError } = await supabase
    .from("ai_jobs")
    .delete()
    .in("id", jobIds);

  if (deleteError) {
    throw new Error(`AI history prune failed while deleting old jobs: ${deleteError.message}`);
  }

  return { scanned: jobIds.length, deleted: jobIds.length, jobIds };
}

async function pruneRetainedAiCache(
  supabase: any,
  cutoffIso: string,
  batchSize: number,
): Promise<{ scanned: number; deleted: number }> {
  if (batchSize <= 0) return { scanned: 0, deleted: 0 };

  const { data: rows, error } = await supabase
    .from("ai_cache")
    .select("hash, mode, chunk_index, model")
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (error) {
    throw new Error(`AI history prune failed while listing old cache rows: ${error.message}`);
  }

  const cacheRows = (rows || []) as Array<{
    hash: string | null;
    mode: string | null;
    chunk_index: number | null;
    model: string | null;
  }>;
  if (cacheRows.length === 0) return { scanned: 0, deleted: 0 };

  let deleted = 0;
  for (const row of cacheRows) {
    let deleteQuery = supabase
      .from("ai_cache")
      .delete();

    deleteQuery = row.hash === null ? deleteQuery.is("hash", null) : deleteQuery.eq("hash", row.hash);
    deleteQuery = row.mode === null ? deleteQuery.is("mode", null) : deleteQuery.eq("mode", row.mode);
    deleteQuery = row.chunk_index === null
      ? deleteQuery.is("chunk_index", null)
      : deleteQuery.eq("chunk_index", row.chunk_index);
    deleteQuery = row.model === null ? deleteQuery.is("model", null) : deleteQuery.eq("model", row.model);

    const { error: deleteError } = await deleteQuery;
    if (deleteError) {
      throw new Error(`AI history prune failed while deleting cache row: ${deleteError.message}`);
    }
    deleted += 1;
  }

  return { scanned: cacheRows.length, deleted };
}

async function pruneRetainedAiHistory(
  supabase: any,
): Promise<{ deletedJobs: number; deletedCacheRows: number }> {
  const now = Date.now();
  const jobCutoffIso = AI_HISTORY_RETENTION_JOBS_MS > 0
    ? new Date(now - AI_HISTORY_RETENTION_JOBS_MS).toISOString()
    : "";
  const cacheCutoffIso = AI_HISTORY_RETENTION_CACHE_MS > 0
    ? new Date(now - AI_HISTORY_RETENTION_CACHE_MS).toISOString()
    : "";

  const deletedJobs = jobCutoffIso
    ? (await pruneRetainedAiJobs(supabase, jobCutoffIso, AI_HISTORY_RETENTION_JOB_BATCH_SIZE)).deleted
    : 0;
  const deletedCacheRows = cacheCutoffIso
    ? (await pruneRetainedAiCache(supabase, cacheCutoffIso, AI_HISTORY_RETENTION_CACHE_BATCH_SIZE)).deleted
    : 0;

  return { deletedJobs, deletedCacheRows };
}

function scheduleRetainedAiHistoryPrune(supabase: any): void {
  if (
    AI_HISTORY_RETENTION_SWEEP_INTERVAL_MS <= 0 ||
    (AI_HISTORY_RETENTION_JOBS_MS <= 0 && AI_HISTORY_RETENTION_CACHE_MS <= 0)
  ) {
    return;
  }
  if (historyRetentionSweepInFlight) return;
  const now = Date.now();
  if (now - lastHistoryRetentionSweepStartedAtMs < AI_HISTORY_RETENTION_SWEEP_INTERVAL_MS) return;

  lastHistoryRetentionSweepStartedAtMs = now;
  historyRetentionSweepInFlight = (async () => {
    try {
      const result = await pruneRetainedAiHistory(supabase);
      if (result.deletedJobs > 0 || result.deletedCacheRows > 0) {
        console.info("AI_HISTORY_PRUNE_COMPLETED", result);
      }
    } catch (err) {
      console.warn("AI_HISTORY_PRUNE_FAILED", err);
    } finally {
      historyRetentionSweepInFlight = null;
    }
  })();
}

async function rescueStaleRunningChunks(
  supabase: any,
  jobId: string,
): Promise<{ requeued: number; markedError: number; handled: boolean }> {
  const { data: runningRows } = await supabase
    .from("ai_job_chunks")
    .select("id, chunk_index, timing, created_at, updated_at")
    .eq("job_id", jobId)
    .eq("status", "running");

  const rows = (runningRows || []) as Array<{
    id: string;
    chunk_index: number;
    timing: Record<string, unknown> | null;
    created_at?: string;
    updated_at?: string;
  }>;
  if (rows.length === 0) return { requeued: 0, markedError: 0, handled: false };

  const nowIso = toIsoNow();
  const nowMs = Date.now();
  let requeued = 0;
  let markedError = 0;

  for (const row of rows) {
    const timing = isPlainObject(row.timing) ? row.timing : {};
    const activityMs = getChunkActivityMs(row);
    const staleThresholdMs = getRunningChunkStaleThresholdMs(timing);
    const cancelThresholdMs = Math.max(staleThresholdMs, STALE_RUNNING_CHUNK_CANCEL_MS);
    const staleForMs = Number.isFinite(activityMs) ? nowMs - activityMs : NaN;
    if (!Number.isFinite(activityMs)) continue;
    if (staleForMs < staleThresholdMs) continue;

    const watchdogRetryCountRaw = Number(timing.watchdog_requeue_count || 0);
    const watchdogRetryCount = Number.isFinite(watchdogRetryCountRaw) && watchdogRetryCountRaw > 0
      ? Math.floor(watchdogRetryCountRaw)
      : 0;
    const canRequeue = staleForMs < cancelThresholdMs && watchdogRetryCount < STALE_RUNNING_CHUNK_RETRY_MAX;

    if (canRequeue) {
      const { data: requeuedRow } = await supabase
        .from("ai_job_chunks")
        .update({
          status: "queued",
          error: null,
          result: null,
          latency_ms: null,
          timing: {
            ...timing,
            watchdog_requeue_count: watchdogRetryCount + 1,
            watchdog_requeued_at: nowIso,
            watchdog_last_requeue_reason: "stale_running_chunk",
            watchdog_stale_for_ms: Math.max(0, Math.floor(staleForMs)),
            started_at: null,
            finished_at: null,
            gemini_error: null,
            total_ms: null,
          },
          updated_at: nowIso,
        })
        .eq("id", row.id)
        .eq("status", "running")
        .select("id")
        .maybeSingle();
      if (requeuedRow) requeued += 1;
      continue;
    }

    const { data: marked } = await supabase
      .from("ai_job_chunks")
      .update({
        status: "error",
        error: "Watchdog detected a stale running chunk after automatic recovery failed. Please retry manually.",
        timing: {
          ...timing,
          watchdog_marked_error_at: nowIso,
          watchdog_last_requeue_reason: "stale_running_chunk_terminal",
          watchdog_stale_for_ms: Math.max(0, Math.floor(staleForMs)),
          finished_at: nowIso,
          gemini_error: "watchdog_error_stale_running_chunk",
        },
        updated_at: nowIso,
      })
      .eq("id", row.id)
      .eq("status", "running")
      .select("id")
      .maybeSingle();
    if (marked) markedError += 1;
  }

  return {
    requeued,
    markedError,
    handled: requeued > 0 || markedError > 0,
  };
}

async function triggerWorker(
  jobId: string,
  opts: { trigger: string; timeoutMs: number },
): Promise<{ ok: boolean; reason: string | null; status: number | null; durationMs: number }> {
  const workerUrl = `${SUPABASE_URL}/functions/v1/ai-worker`;
  const bodyText = JSON.stringify({ jobId, trigger: opts.trigger });
  const headers = await buildWorkerHeaders(bodyText);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(workerUrl, {
      method: "POST",
      headers,
      body: bodyText,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        reason: `trigger_http_${response.status}${text ? `:${trimPreview(text, 180)}` : ""}`,
        status: response.status,
        durationMs,
      };
    }

    return {
      ok: true,
      reason: null,
      status: response.status,
      durationMs,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const reason = /abort|timed? out/i.test(message)
      ? "trigger_timeout"
      : `trigger_exception:${trimPreview(message, 180)}`;

    return {
      ok: false,
      reason,
      status: null,
      durationMs,
    };
  }
}

async function dispatchWorkerTrigger(jobId: string, trigger: string): Promise<void> {
  const workerUrl = `${SUPABASE_URL}/functions/v1/ai-worker`;
  const bodyText = JSON.stringify({ jobId, trigger });
  const headers = await buildWorkerHeaders(bodyText);

  fetch(workerUrl, {
    method: "POST",
    headers,
    body: bodyText,
  })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.warn(
          `AI_JOBS_TRIGGER_ASYNC_FAILED { jobId: ${jobId}, trigger: ${trigger}, status: ${response.status}, body: ${trimPreview(text, 180)} }`,
        );
      }
    })
    .catch((err) => {
      console.warn(
        `AI_JOBS_TRIGGER_ASYNC_EXCEPTION { jobId: ${jobId}, trigger: ${trigger}, error: ${err instanceof Error ? err.message : String(err)} }`,
      );
    });
}

async function maybeKickWorker(
  supabase: any,
  job: { id: string; status: string; timing: Record<string, unknown> | null },
  chunkCounts: ChunkCounts,
): Promise<{ kicked: boolean; reason: string | null }> {
  if (job.status !== "queued" && job.status !== "running") {
    return { kicked: false, reason: null };
  }

  // Only kick if no chunks exist yet OR there are queued chunks with zero running
  const shouldKick = chunkCounts.total === 0
    || (chunkCounts.queued > 0 && chunkCounts.running === 0);
  if (!shouldKick) {
    return { kicked: false, reason: null };
  }

  const timing = isPlainObject(job.timing) ? job.timing : {};
  const lastKickAt = typeof timing.last_worker_kick_at === "string" ? timing.last_worker_kick_at : "";
  const lastKickMs = lastKickAt ? Date.parse(lastKickAt) : NaN;
  const kickThrottleMs = chunkCounts.total === 0 ? 3_000 : 15_000;
  // Brand-new queued jobs need quicker recovery than already-started jobs.
  if (Number.isFinite(lastKickMs) && Date.now() - lastKickMs < kickThrottleMs) {
    return { kicked: false, reason: "throttled_recent_kick" };
  }

  const reason = chunkCounts.total === 0 ? "no_chunks_yet" : "queued_chunks_without_runner";
  const triggerResult = await triggerWorker(job.id, {
    trigger: "ai-jobs-status-kick",
    timeoutMs: WORKER_TRIGGER_STATUS_TIMEOUT_MS,
  });
  if (!triggerResult.ok) {
    const failReason = `trigger_failed:${triggerResult.reason || "unknown"}`;
    const failedTiming = {
      ...timing,
      last_worker_kick_at: toIsoNow(),
      last_worker_kick_reason: failReason,
      last_worker_kick_error: triggerResult.reason || "unknown",
      worker_kick_attempts: Number(timing.worker_kick_attempts || 0) + 1,
    };
    await supabase
      .from("ai_jobs")
      .update({ timing: failedTiming, updated_at: toIsoNow() })
      .eq("id", job.id)
      .in("status", ["queued", "running"]);
    return { kicked: false, reason: failReason };
  }

  const updatedTiming = {
    ...timing,
    last_worker_kick_at: toIsoNow(),
    last_worker_kick_reason: reason,
    worker_kick_attempts: Number(timing.worker_kick_attempts || 0) + 1,
  };
  await supabase
    .from("ai_jobs")
    .update({ timing: updatedTiming, updated_at: toIsoNow() })
    .eq("id", job.id)
    .in("status", ["queued", "running"]);

  return { kicked: true, reason };
}

serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = getCorsHeaders(origin, "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  const blocked = rejectIfOriginNotAllowed(origin, "GET, POST, OPTIONS", req);
  if (blocked) return blocked;

  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, cors);
  }

  const authRejected = await rejectIfMissingProjectKey(req, cors);
  if (authRejected) return authRejected;

  try {
    // deno-lint-ignore no-explicit-any
    const supabase: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      body = await parseJsonObject(req);
    }

    const action = resolveAction(req, body);

    if (action === "start") {
      // Fire-and-forget: reaping stale jobs is housekeeping that shouldn't
      // block the critical path of creating a new job (saves 50-200ms).
      reapStaleJobs(supabase).catch((err) => {
        console.warn("AI_STALE_REAPER_START_FAILED", err);
      });
      scheduleRetainedAiHistoryPrune(supabase);

      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        return jsonResponse({ error: "Missing or invalid 'prompt'" }, 400, cors);
      }

      const requestedModel = typeof body.model === "string" ? body.model.trim() : "";

      const files = sanitizeFiles(body.files).map((file) => ({
        ...file,
        ...(isInstructionLikeFile(file) ? { label: "instructions" } : {}),
      }));
      const documentText = typeof body.documentText === "string" ? body.documentText : "";
      const debugActionKey = typeof body.debugActionKey === "string" ? body.debugActionKey.trim().slice(0, 120) : "";
      const debugPromptType = typeof body.debugPromptType === "string" ? body.debugPromptType.trim().slice(0, 120) : "";
      const type = inferType({ ...body, files, documentText });
      // Prompt-only jobs (generic, admin_action, text_compare with inline prompt)
      // don't require files or documentText — the prompt itself is the payload.
      const promptOnlyTypes = new Set(["generic", "admin_action"]);
      if (!files.length && !documentText.trim() && !promptOnlyTypes.has(type)) {
        return jsonResponse({ error: "Provide either files or documentText" }, 400, cors);
      }
      const requestedJsonMode = typeof body.jsonMode === "boolean" ? body.jsonMode : body.mode === "json";
      const isPdfCompare = type === "pdf_compare";
      const jsonMode = isPdfCompare ? true : requestedJsonMode;
      const requestMode = jsonMode ? "json" : "text";
      const configFlags = normalizeConfigFlags(type, body.configFlags);
      const maxValidationRetriesRaw = Number(body.maxValidationRetries ?? 0);
      const maxValidationRetries = Number.isFinite(maxValidationRetriesRaw) && maxValidationRetriesRaw >= 0
        ? Math.min(1, Math.floor(maxValidationRetriesRaw))
        : 0;
      const effectiveMaxValidationRetries = isPdfCompare ? Math.max(1, maxValidationRetries) : maxValidationRetries;
      const incomingResponseGuard = isPlainObject(body.responseGuard)
        ? (body.responseGuard as Record<string, unknown>)
        : {};
      const effectiveResponseGuard: Record<string, unknown> | null = isPdfCompare
        ? {
            ...incomingResponseGuard,
            requiredJsonKeys: ["same_product_assessment", "extracted_data", "comparison_audit"],
            minJsonProperties: Math.max(3, Number(incomingResponseGuard.minJsonProperties || 0) || 0),
          }
        : (Object.keys(incomingResponseGuard).length > 0 ? incomingResponseGuard : null);
      const allowMissingInstruction = asBoolean(configFlags.allowMissingInstruction ?? true);
      const fileLabels = files.map((f: { label?: string }) => (f.label || "").toLowerCase());
      // Instruction PDF is optional — only block if explicitly required AND missing
      if (files.length > 0 && !hasInstructionFile(files) && !allowMissingInstruction) {
        return jsonResponse(
          { error: `This action requires an instruction PDF (label="instructions") but none was found in files. Labels: [${fileLabels.join(", ")}]` },
          400,
          cors,
        );
      }

      // ── File Label Contracts ───────────────────────────────────
      if (type === "pdf_compare") {
        const hasSupplier = fileLabels.includes("supplier");
        const hasLs = fileLabels.includes("ls");
        if (!hasSupplier || !hasLs) {
          return jsonResponse(
            { error: `pdf_compare requires files with labels "supplier" and "ls". Got: [${fileLabels.join(", ")}]` },
            400,
            cors,
          );
        }
      }

      // ── Idempotency / De-Dup ──────────────────────────────────
      // Full-content fingerprint: hash the actual prompt, files, config, guards, etc.
      // This prevents false dedup (different prompts with same length) and false misses
      // (identical requests with different metadata).
      const promptHash = await sha256Hex(prompt);
      const systemPromptHash = typeof body.systemPrompt === "string" && body.systemPrompt.trim()
        ? await sha256Hex(body.systemPrompt.trim())
        : "";
      const documentTextHash = documentText.trim()
        ? await sha256Hex(documentText)
        : "";
      const dedupInput = JSON.stringify({
        type,
        mode: requestMode,
        prompt_hash: promptHash,
        file_keys: files.map((f: { bucket: string; path: string }) => `${f.bucket}/${f.path}`).sort(),
        document_text_hash: documentTextHash,
        document_text_length: documentText.length,
        temperature: configFlags.temperature,
        disable_cache: configFlags.disableCache,
        single_pass: configFlags.singlePass,
        has_response_guard: Boolean(effectiveResponseGuard),
        response_guard_summary: effectiveResponseGuard
          ? JSON.stringify(effectiveResponseGuard).slice(0, 200)
          : "",
        system_prompt_hash: systemPromptHash,
        max_validation_retries: effectiveMaxValidationRetries,
        debug_action_key: debugActionKey,
        debug_prompt_type: debugPromptType,
      });
      const requestHash = await sha256Hex(dedupInput);

      // Check for recent duplicate (queued or running, created within last 5 minutes)
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      let existingDedupJob: { id: string; status: string } | null = null;

      // Fast path: query exact request_hash directly from timing JSON.
      const hashQuery = await supabase
        .from("ai_jobs")
        .select("id, status")
        .in("status", ["queued", "running"])
        .gte("created_at", fiveMinAgo)
        .eq("type", type)
        .eq("timing->>request_hash", requestHash)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (hashQuery.data) {
        existingDedupJob = hashQuery.data as { id: string; status: string };
      } else if (hashQuery.error) {
        // Backward-compatible fallback for PostgREST instances without ->> filters.
        const { data: existingJobs } = await supabase
          .from("ai_jobs")
          .select("id, status, created_at, timing")
          .in("status", ["queued", "running"])
          .gte("created_at", fiveMinAgo)
          .eq("type", type)
          .limit(10);

        if (existingJobs && existingJobs.length > 0) {
          for (const ej of existingJobs) {
            const ejTiming = ej?.timing && typeof ej.timing === "object"
              ? ej.timing as Record<string, unknown>
              : {};
            if (ejTiming.request_hash === requestHash) {
              existingDedupJob = { id: ej.id, status: ej.status };
              break;
            }
          }
        }
      }

      if (existingDedupJob) {
        console.log(`AI_JOBS_DEDUP { existing: ${existingDedupJob.id}, hash: ${requestHash} }`);
        return jsonResponse(
          {
            jobId: existingDedupJob.id,
            type,
            status: existingDedupJob.status,
            progress: 5,
            result: null,
            error: null,
            deduplicated: true,
          },
          200,
          cors,
        );
      }

      const requestPayload = {
        type,
        prompt,
        files,
        documentText,
        clientSessionId: typeof body.clientSessionId === "string" ? body.clientSessionId.trim() : "",
        requireFiles: Boolean(body.requireFiles),
        jsonMode: Boolean(jsonMode),
        mode: requestMode,
        bucket: typeof body.bucket === "string" ? body.bucket : null,
        responseGuard: effectiveResponseGuard,
        maxValidationRetries: effectiveMaxValidationRetries,
        ...(typeof body.systemPrompt === "string" && body.systemPrompt.trim()
          ? { systemPrompt: body.systemPrompt.trim() }
          : {}),
        ...(debugActionKey ? { debugActionKey } : {}),
        ...(debugPromptType ? { debugPromptType } : {}),
        model: ENFORCED_MODEL,
        configFlags,
      };

      // ── Debug Meta (safe, redacted) ────────────────────────────
      const debugMeta: Record<string, unknown> = {
        request_hash: requestHash,
        action_type: type,
        json_mode: Boolean(jsonMode),
        file_labels: fileLabels,
        file_count: files.length,
        config_flags: configFlags,
        prompt_chars: prompt.length,
        prompt_hash: promptHash,
        system_prompt_hash: systemPromptHash || null,
        document_text_chars: documentText.length,
        has_system_prompt: Boolean(typeof body.systemPrompt === "string" && body.systemPrompt.trim()),
        has_response_guard: Boolean(effectiveResponseGuard),
        max_validation_retries: effectiveMaxValidationRetries,
        temperature: configFlags.temperature,
        strict_json: configFlags.strictJson,
        strict_grounding: configFlags.strictGrounding,
        compare_request_normalized: isPdfCompare,
        requested_mode: typeof body.mode === "string" ? body.mode : null,
        effective_mode: requestMode,
        model: ENFORCED_MODEL,
        debug_action_key: debugActionKey || null,
        debug_prompt_type: debugPromptType || null,
      };

      const t0 = Date.now();
      const { data: job, error: insertError } = await supabase
        .from("ai_jobs")
        .insert({
          type,
          status: "queued",
          progress: 5,
          request_payload: requestPayload,
          model_used: ENFORCED_MODEL,
          timing: {
            queued_at: new Date().toISOString(),
            prompt_chars: prompt.length,
            request_hash: requestHash,
            debug_meta: debugMeta,
          },
        })
        .select("id, status, created_at")
        .single();

      if (insertError || !job) {
        console.error("ai-jobs insert error:", insertError);
        return jsonResponse({ error: "Failed to create processing job" }, 500, cors);
      }

      void dispatchWorkerTrigger(job.id, "ai-jobs-start");

      console.log(`AI_JOBS_START { jobId: ${job.id}, type: ${type}, trigger_dispatched: true, mode: async_fire_and_forget, ms: ${Date.now() - t0} }`);

      return jsonResponse(
        {
          jobId: job.id,
          type,
          status: "queued",
          progress: 5,
          result: null,
          error: null,
          latency_ms: null,
          model_used: ENFORCED_MODEL,
          timing: {
            queued_at: toIsoNow(),
            prompt_chars: prompt.length,
            request_hash: requestHash,
            debug_meta: debugMeta,
            worker_trigger_mode: "async_fire_and_forget",
          },
          chunks_total: 0,
          chunks_done: 0,
          chunks_queued: 0,
          chunks_running: 0,
          chunks_error: 0,
          chunks_cancelled: 0,
          created_at: job.created_at,
          updated_at: null,
          trigger_dispatched: true,
          trigger_ms: 0,
        },
        200,
        cors,
      );
    }

    const url = new URL(req.url);
    const queryJobId = url.searchParams.get("jobId");
    const jobId = typeof body.jobId === "string" ? body.jobId : queryJobId;

    if (action === "cancel") {
      if (!jobId) {
        return jsonResponse({ error: "jobId is required" }, 400, cors);
      }

      await supabase
        .from("ai_jobs")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .in("status", ["queued", "running"]);

      await supabase
        .from("ai_job_chunks")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("job_id", jobId)
        .in("status", ["queued", "running"]);

      return jsonResponse({ jobId, status: "cancelled" }, 200, cors);
    }

    if (action === "cancel_stale") {
      const staleCleanup = await reapStaleJobs(supabase);
      return jsonResponse(
        {
          ok: true,
          action: "cancel_stale",
          scanned: staleCleanup.scanned,
          cancelled: staleCleanup.cancelled,
          jobIds: staleCleanup.jobIds,
        },
        200,
        cors,
      );
    }

    if (action === "hard_reset") {
      const reason = typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : "Hard reset requested from AI admin panel.";
      const resetResult = await hardResetAllJobs(supabase, reason);
      return jsonResponse(
        {
          ok: true,
          action: "hard_reset",
          reason,
          cancelled: resetResult.cancelledJobs,
          cancelled_chunks: resetResult.cancelledChunks,
          jobIds: resetResult.jobIds,
        },
        200,
        cors,
      );
    }

    if (action === "recover_latest") {
      const sessionFromBody = typeof body.clientSessionId === "string" ? body.clientSessionId.trim() : "";
      const sessionFromQuery = url.searchParams.get("clientSessionId")?.trim() || "";
      const clientSessionId = sessionFromBody || sessionFromQuery;
      if (!clientSessionId) {
        return jsonResponse({ error: "clientSessionId is required" }, 400, cors);
      }

      const rawTypes = Array.isArray(body.types) ? body.types : [];
      const allowedTypes = rawTypes
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim())
        .slice(0, 8);

      const recoverStatuses = ["queued", "running", "done", "error"] as const;
      const cutoffIso = new Date(Date.now() - RECOVER_LOOKBACK_MS).toISOString();

      let query = supabase
        .from("ai_jobs")
        .select("id, type, status, progress, result, error, model_used, latency_ms, timing, request_payload, created_at, updated_at")
        .eq("request_payload->>clientSessionId", clientSessionId)
        .in("status", [...recoverStatuses])
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: false })
        .limit(1);

      if (allowedTypes.length > 0) {
        query = query.in("type", allowedTypes);
      }

      let { data: latest, error: latestError } = await query.maybeSingle();
      if (latestError) {
        // Backward-compatible fallback for PostgREST instances that do not support ->> filters.
        let fallbackQuery = supabase
          .from("ai_jobs")
          .select("id, type, status, progress, result, error, model_used, latency_ms, timing, request_payload, created_at, updated_at")
          .contains("request_payload", { clientSessionId })
          .in("status", [...recoverStatuses])
          .gte("created_at", cutoffIso)
          .order("created_at", { ascending: false })
          .limit(1);
        if (allowedTypes.length > 0) {
          fallbackQuery = fallbackQuery.in("type", allowedTypes);
        }
        const fallback = await fallbackQuery.maybeSingle();
        latest = fallback.data;
        latestError = fallback.error;
      }
      if (latestError) {
        const errorRef = crypto.randomUUID();
        console.error("ai-jobs recover_latest query failed:", { errorRef, latestError });
        return jsonResponse({ error: "Failed to recover latest job", error_ref: errorRef }, 500, cors);
      }

      if (!latest) {
        return jsonResponse({ job: null }, 200, cors);
      }

      const recoveredCounts = await getChunkCounts(supabase, latest.id);
      return jsonResponse(
        {
          job: {
            jobId: latest.id,
            type: latest.type,
            status: latest.status,
            progress: latest.status === "done" ? 100 : (latest.progress || 0),
            result: latest.result,
            error: latest.error,
            model_used: latest.model_used,
            latency_ms: latest.latency_ms,
            timing: latest.timing,
            chunks_total: recoveredCounts.total,
            chunks_done: recoveredCounts.done,
            chunks_queued: recoveredCounts.queued,
            chunks_running: recoveredCounts.running,
            chunks_error: recoveredCounts.error,
            chunks_cancelled: recoveredCounts.cancelled,
            created_at: latest.created_at,
            updated_at: latest.updated_at,
          },
        },
        200,
        cors,
      );
    }

    if (action === "list") {
      const autoCancelStale = asBoolean(body.autoCancelStale) || asBoolean(url.searchParams.get("autoCancelStale"));
      const staleCleanup = autoCancelStale ? await reapStaleJobs(supabase) : null;
      const queryLimitRaw = Number(url.searchParams.get("limit") || "20");
      const bodyLimitRaw = typeof body.limit === "number" ? body.limit : queryLimitRaw;
      const limit = Number.isFinite(bodyLimitRaw) ? Math.max(1, Math.min(100, Math.floor(bodyLimitRaw))) : 20;

      const { data: jobs, error } = await supabase
        .from("ai_jobs")
        .select("id, type, status, progress, model_used, latency_ms, error, timing, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        const errorRef = crypto.randomUUID();
        console.error("ai-jobs list query failed:", { errorRef, error });
        return jsonResponse({ error: "Failed to list jobs", error_ref: errorRef }, 500, cors);
      }

      const ids = (jobs || []).map((job: any) => job.id);
      let chunkRows: Array<{ job_id: string; status: string }> = [];
      if (ids.length > 0) {
        const { data: chunks } = await supabase
          .from("ai_job_chunks")
          .select("job_id, status")
          .in("job_id", ids);
        chunkRows = (chunks || []) as Array<{ job_id: string; status: string }>;
      }

      const countsByJob = new Map<string, ChunkCounts>();
      for (const id of ids) {
        countsByJob.set(id, {
          total: 0,
          queued: 0,
          running: 0,
          done: 0,
          error: 0,
          cancelled: 0,
        });
      }

      for (const row of chunkRows) {
        const counts = countsByJob.get(row.job_id);
        if (!counts) continue;
        counts.total += 1;
        if (row.status === "queued") counts.queued += 1;
        else if (row.status === "running") counts.running += 1;
        else if (row.status === "done") counts.done += 1;
        else if (row.status === "error") counts.error += 1;
        else if (row.status === "cancelled") counts.cancelled += 1;
      }

      const includeDebug = asBoolean(body.debug) || asBoolean(url.searchParams.get("debug"));

      const jobChunksById = new Map<string, Array<Record<string, unknown>>>();
      if (includeDebug && ids.length > 0) {
        const { data: fullChunks } = await supabase
          .from("ai_job_chunks")
          .select("job_id, chunk_index, chunk_type, status, latency_ms, error, timing, text, created_at, updated_at")
          .in("job_id", ids)
          .order("chunk_index", { ascending: true });

        for (const row of fullChunks || []) {
          const key = String(row.job_id || "");
          if (!key) continue;
          const existing = jobChunksById.get(key) || [];
          existing.push({
            chunk_index: row.chunk_index,
            chunk_type: row.chunk_type,
            status: row.status,
            latency_ms: row.latency_ms,
            error: row.error,
            text_chars: typeof row.text === "string" ? row.text.length : 0,
            text_preview: typeof row.text === "string" ? trimPreview(row.text, 220) : "",
            created_at: row.created_at,
            updated_at: row.updated_at,
            timing: summarizeChunkTiming((row.timing || null) as Record<string, unknown> | null),
          });
          jobChunksById.set(key, existing);
        }
      }

      return jsonResponse(
        {
          jobs: (jobs || []).map((job: any) => ({
            ...job,
            chunk_counts: countsByJob.get(job.id) || {
              total: 0,
              queued: 0,
              running: 0,
              done: 0,
              error: 0,
              cancelled: 0,
            },
            ...(includeDebug
              ? {
                debug: {
                  chunk_details: jobChunksById.get(job.id) || [],
                },
              }
              : {}),
          })),
          ...(staleCleanup ? { stale_cleanup: staleCleanup } : {}),
        },
        200,
        cors,
      );
    }

    if (!jobId) {
      return jsonResponse({ error: "jobId is required" }, 400, cors);
    }

    const includeDebug = asBoolean(body.debug) || asBoolean(url.searchParams.get("debug"));

    // Parallelize the two independent DB fetches (saves ~one round-trip per poll)
    const [jobResult, chunkCountsInitial] = await Promise.all([
      supabase
        .from("ai_jobs")
        .select("id, type, status, progress, result, error, model_used, latency_ms, timing, request_payload, created_at, updated_at")
        .eq("id", jobId)
        .single(),
      getChunkCounts(supabase, jobId),
    ]);

    const { data: job, error } = jobResult;
    if (error || !job) {
      return jsonResponse({
        jobId,
        status: "not_found",
        progress: 0,
        result: null,
        error: "Job not found",
        model_used: null,
        latency_ms: null,
        chunks_total: 0,
        chunks_done: 0,
        chunks_error: 0,
        chunks_running: 0,
        chunks_queued: 0,
        chunks_cancelled: 0,
      }, 200, cors);
    }

    const requestPayload = (job.request_payload && typeof job.request_payload === "object")
      ? (job.request_payload as Record<string, unknown>)
      : {};

    let chunkCounts = chunkCountsInitial;
    let watchdogInfo: { requeued: number; markedError: number; handled: boolean } | null = null;
    // Only run the watchdog on old-enough jobs.
    const timingEarly = (job.timing && typeof job.timing === "object")
      ? (job.timing as Record<string, unknown>)
      : {};
    const watchdogMinAgeMs = getRunningChunkStaleThresholdMs(timingEarly);
    const jobCreatedMsEarly = parseMs(job.created_at);
    const jobAgeMsEarly = Number.isFinite(jobCreatedMsEarly) ? (Date.now() - jobCreatedMsEarly) : 0;
    const canWatchdogRecoverRunningChunks = (job.status === "running" || job.status === "queued")
      && chunkCounts.running > 0
      && jobAgeMsEarly >= watchdogMinAgeMs;
    if (canWatchdogRecoverRunningChunks) {
      watchdogInfo = await rescueStaleRunningChunks(supabase, jobId);
      if (watchdogInfo.handled) {
        chunkCounts = await getChunkCounts(supabase, jobId);
        const timing = isPlainObject(job.timing) ? job.timing : {};
        await supabase
          .from("ai_jobs")
          .update({
            timing: {
              ...timing,
              watchdog_last_run_at: toIsoNow(),
              watchdog_requeued_chunks: Number(timing.watchdog_requeued_chunks || 0) + watchdogInfo.requeued,
              watchdog_error_chunks: Number(timing.watchdog_error_chunks || 0) + watchdogInfo.markedError,
            },
            updated_at: toIsoNow(),
          })
          .eq("id", job.id)
          .in("status", ["queued", "running"]);
      }
    }
    const jobCreatedMs = parseMs(job.created_at);
    const ageMs = Number.isFinite(jobCreatedMs) ? (Date.now() - jobCreatedMs) : 0;
    const staleCurrentNoChunks = (job.status === "queued" || job.status === "running")
      && chunkCounts.total === 0
      && ageMs >= STALE_NO_CHUNKS_MS;
    if (staleCurrentNoChunks) {
      const reason = "Auto-cancelled stale AI job (queued too long with no chunks).";
      await cancelJobsWithChunks(supabase, [job.id], reason);
      return jsonResponse(
        {
          jobId: job.id,
          type: job.type,
          status: "cancelled",
          progress: 0,
          result: null,
          error: reason,
          model_used: job.model_used,
          latency_ms: job.latency_ms,
          timing: job.timing,
          chunks_total: 0,
          chunks_done: 0,
          chunks_queued: 0,
          chunks_running: 0,
          chunks_error: 0,
          chunks_cancelled: 0,
          created_at: job.created_at,
          updated_at: toIsoNow(),
          ...(includeDebug
            ? {
              debug: {
                source: "ai-jobs/status",
                observed_at: toIsoNow(),
                request_summary: {
                  type: requestPayload.type ?? job.type,
                  mode: requestPayload.mode ?? null,
                  jsonMode: requestPayload.jsonMode ?? null,
                  requireFiles: requestPayload.requireFiles ?? null,
                  model: requestPayload.model ?? job.model_used ?? ENFORCED_MODEL,
                  configFlags: requestPayload.configFlags ?? null,
                  prompt_chars: typeof requestPayload.prompt === "string" ? requestPayload.prompt.length : 0,
                  prompt_preview: typeof requestPayload.prompt === "string" ? trimPreview(requestPayload.prompt, 900) : "",
                  document_text_chars: typeof requestPayload.documentText === "string" ? requestPayload.documentText.length : 0,
                  file_count: Array.isArray(requestPayload.files) ? requestPayload.files.length : 0,
                  files: Array.isArray(requestPayload.files) ? requestPayload.files : [],
                },
                chunk_details: [],
                pipeline_hint: "stale_job_cancelled",
              },
            }
            : {}),
        },
        200,
        cors,
      );
    }

    const staleByAbsoluteRuntime = (job.status === "queued" || job.status === "running")
      && ageMs >= ABSOLUTE_JOB_RUNTIME_MS;
    if (staleByAbsoluteRuntime) {
      const reason = `Auto-cancelled stale AI job (exceeded max runtime of ${Math.floor(ABSOLUTE_JOB_RUNTIME_MS / 1000)}s).`;
      await cancelJobsWithChunks(supabase, [job.id], reason);
      return jsonResponse(
        {
          jobId: job.id,
          type: job.type,
          status: "cancelled",
          progress: Number(job.progress || 0),
          result: null,
          error: reason,
          model_used: job.model_used,
          latency_ms: job.latency_ms,
          timing: job.timing,
          chunks_total: chunkCounts.total,
          chunks_done: chunkCounts.done,
          chunks_queued: chunkCounts.queued,
          chunks_running: chunkCounts.running,
          chunks_error: chunkCounts.error,
          chunks_cancelled: chunkCounts.cancelled,
          created_at: job.created_at,
          updated_at: toIsoNow(),
          ...(includeDebug
            ? {
              debug: {
                source: "ai-jobs/status",
                observed_at: toIsoNow(),
                request_summary: {
                  type: requestPayload.type ?? job.type,
                  mode: requestPayload.mode ?? null,
                  jsonMode: requestPayload.jsonMode ?? null,
                  requireFiles: requestPayload.requireFiles ?? null,
                  model: requestPayload.model ?? job.model_used ?? ENFORCED_MODEL,
                  configFlags: requestPayload.configFlags ?? null,
                  prompt_chars: typeof requestPayload.prompt === "string" ? requestPayload.prompt.length : 0,
                  prompt_preview: typeof requestPayload.prompt === "string" ? trimPreview(requestPayload.prompt, 900) : "",
                  document_text_chars: typeof requestPayload.documentText === "string" ? requestPayload.documentText.length : 0,
                  file_count: Array.isArray(requestPayload.files) ? requestPayload.files.length : 0,
                  files: Array.isArray(requestPayload.files) ? requestPayload.files : [],
                },
                chunk_details: [],
                pipeline_hint: "absolute_runtime_timeout_cancelled",
              },
            }
            : {}),
        },
        200,
        cors,
      );
    }

    const chunksAllTerminal = chunkCounts.total > 0 && chunkCounts.queued === 0 && chunkCounts.running === 0;
    const shouldFailFastFromChunkErrors = chunksAllTerminal
      && chunkCounts.error > 0
      && (job.status === "queued" || job.status === "running");
    if (shouldFailFastFromChunkErrors) {
      let chunkErrorMessage = "One or more AI chunks failed.";
      const { data: firstErroredChunk } = await supabase
        .from("ai_job_chunks")
        .select("error")
        .eq("job_id", job.id)
        .eq("status", "error")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (firstErroredChunk && typeof firstErroredChunk.error === "string" && firstErroredChunk.error.trim()) {
        chunkErrorMessage = firstErroredChunk.error.trim();
      }

      const resolvedJobError = typeof job.error === "string" && job.error.trim()
        ? job.error.trim()
        : chunkErrorMessage;

      await supabase
        .from("ai_jobs")
        .update({
          status: "error",
          error: resolvedJobError,
          updated_at: toIsoNow(),
        })
        .eq("id", job.id)
        .in("status", ["queued", "running"]);

      return jsonResponse(
        {
          jobId: job.id,
          type: job.type,
          status: "error",
          progress: Number(job.progress || 0),
          result: null,
          error: resolvedJobError,
          model_used: job.model_used,
          latency_ms: job.latency_ms,
          timing: job.timing,
          chunks_total: chunkCounts.total,
          chunks_done: chunkCounts.done,
          chunks_queued: chunkCounts.queued,
          chunks_running: chunkCounts.running,
          chunks_error: chunkCounts.error,
          chunks_cancelled: chunkCounts.cancelled,
          created_at: job.created_at,
          updated_at: toIsoNow(),
          ...(includeDebug
            ? {
              debug: {
                source: "ai-jobs/status",
                observed_at: toIsoNow(),
                request_summary: {
                  type: requestPayload.type ?? job.type,
                  mode: requestPayload.mode ?? null,
                  jsonMode: requestPayload.jsonMode ?? null,
                  requireFiles: requestPayload.requireFiles ?? null,
                  model: requestPayload.model ?? job.model_used ?? ENFORCED_MODEL,
                  configFlags: requestPayload.configFlags ?? null,
                  prompt_chars: typeof requestPayload.prompt === "string" ? requestPayload.prompt.length : 0,
                  prompt_preview: typeof requestPayload.prompt === "string" ? trimPreview(requestPayload.prompt, 900) : "",
                  document_text_chars: typeof requestPayload.documentText === "string" ? requestPayload.documentText.length : 0,
                  file_count: Array.isArray(requestPayload.files) ? requestPayload.files.length : 0,
                  files: Array.isArray(requestPayload.files) ? requestPayload.files : [],
                },
                chunk_details: [],
                pipeline_hint: "failed_all_chunks_terminal_with_errors",
              },
            }
            : {}),
        },
        200,
        cors,
      );
    }

    const kickInfo = await maybeKickWorker(
      supabase,
      {
        id: job.id,
        status: job.status,
        timing: (job.timing && typeof job.timing === "object")
          ? (job.timing as Record<string, unknown>)
          : null,
      },
      chunkCounts,
    );

    const timingObject = (job.timing && typeof job.timing === "object")
      ? (job.timing as Record<string, unknown>)
      : {};
    const priorKickAttempts = Number(timingObject.worker_kick_attempts || 0);
    const triggerFailed = typeof kickInfo.reason === "string" && kickInfo.reason.startsWith("trigger_failed:");
    const effectiveKickAttempts = priorKickAttempts + (triggerFailed ? 1 : 0);
    if (chunkCounts.total === 0 && (job.status === "queued" || job.status === "running") && triggerFailed && effectiveKickAttempts >= 2) {
      const failMessage = `Worker trigger failed repeatedly (${kickInfo.reason}). Check ai-worker deployment and auth settings.`;
      await supabase
        .from("ai_jobs")
        .update({
          status: "error",
          error: failMessage,
          updated_at: toIsoNow(),
        })
        .eq("id", job.id)
        .in("status", ["queued", "running"]);

      return jsonResponse(
        {
          jobId: job.id,
          type: job.type,
          status: "error",
          progress: 0,
          result: null,
          error: failMessage,
          model_used: job.model_used,
          latency_ms: job.latency_ms,
          timing: job.timing,
          chunks_total: chunkCounts.total,
          chunks_done: chunkCounts.done,
          chunks_queued: chunkCounts.queued,
          chunks_running: chunkCounts.running,
          chunks_error: chunkCounts.error,
          chunks_cancelled: chunkCounts.cancelled,
          created_at: job.created_at,
          updated_at: toIsoNow(),
          ...(includeDebug
            ? {
              debug: {
                source: "ai-jobs/status",
                observed_at: toIsoNow(),
                request_summary: {
                  type: requestPayload.type ?? job.type,
                  mode: requestPayload.mode ?? null,
                  jsonMode: requestPayload.jsonMode ?? null,
                  requireFiles: requestPayload.requireFiles ?? null,
                  model: requestPayload.model ?? job.model_used ?? ENFORCED_MODEL,
                  configFlags: requestPayload.configFlags ?? null,
                  prompt_chars: typeof requestPayload.prompt === "string" ? requestPayload.prompt.length : 0,
                  prompt_preview: typeof requestPayload.prompt === "string" ? trimPreview(requestPayload.prompt, 900) : "",
                  document_text_chars: typeof requestPayload.documentText === "string" ? requestPayload.documentText.length : 0,
                  file_count: Array.isArray(requestPayload.files) ? requestPayload.files.length : 0,
                  files: Array.isArray(requestPayload.files) ? requestPayload.files : [],
                },
                chunk_details: [],
                pipeline_hint: "worker_trigger_failed_repeatedly",
                worker_kick: {
                  kicked: false,
                  reason: kickInfo.reason,
                },
              },
            }
            : {}),
        },
        200,
        cors,
      );
    }

    let chunkDetails: Array<Record<string, unknown>> = [];
    if (includeDebug) {
      const { data: chunks } = await supabase
        .from("ai_job_chunks")
        .select("chunk_index, chunk_type, status, latency_ms, error, timing, text, created_at, updated_at")
        .eq("job_id", jobId)
        .order("chunk_index", { ascending: true });

      chunkDetails = (chunks || []).map((chunk: any) => ({
        chunk_index: chunk.chunk_index,
        chunk_type: chunk.chunk_type,
        status: chunk.status,
        latency_ms: chunk.latency_ms,
        error: chunk.error,
        text_chars: typeof chunk.text === "string" ? chunk.text.length : 0,
        text_preview: typeof chunk.text === "string" ? trimPreview(chunk.text, 260) : "",
        created_at: chunk.created_at,
        updated_at: chunk.updated_at,
        timing: summarizeChunkTiming((chunk.timing || null) as Record<string, unknown> | null),
      }));
    }

    const requestSummary = {
      type: requestPayload.type ?? job.type,
      mode: requestPayload.mode ?? null,
      jsonMode: requestPayload.jsonMode ?? null,
      requireFiles: requestPayload.requireFiles ?? null,
      model: requestPayload.model ?? job.model_used ?? ENFORCED_MODEL,
      configFlags: requestPayload.configFlags ?? null,
      prompt_chars: typeof requestPayload.prompt === "string" ? requestPayload.prompt.length : 0,
      prompt_preview: typeof requestPayload.prompt === "string" ? trimPreview(requestPayload.prompt, 900) : "",
      document_text_chars: typeof requestPayload.documentText === "string" ? requestPayload.documentText.length : 0,
      file_count: Array.isArray(requestPayload.files) ? requestPayload.files.length : 0,
      files: Array.isArray(requestPayload.files) ? requestPayload.files : [],
    };
    const effectiveStatus = (job.status === "queued" && (chunkCounts.running > 0 || chunkCounts.done > 0 || chunkCounts.error > 0))
      ? "running"
      : job.status;

    return jsonResponse(
      {
        jobId: job.id,
        type: job.type,
        status: effectiveStatus,
        progress: effectiveStatus === "done" ? 100 : (job.progress || 0),
        result: job.result,
        error: job.error,
        model_used: job.model_used,
        latency_ms: job.latency_ms,
        timing: job.timing,
        chunks_total: chunkCounts.total,
        chunks_done: chunkCounts.done,
        chunks_queued: chunkCounts.queued,
        chunks_running: chunkCounts.running,
        chunks_error: chunkCounts.error,
        chunks_cancelled: chunkCounts.cancelled,
        created_at: job.created_at,
        updated_at: job.updated_at,
        ...(includeDebug
          ? {
            debug: {
              source: "ai-jobs/status",
              observed_at: toIsoNow(),
              request_summary: requestSummary,
              chunk_details: chunkDetails,
              pipeline_hint: kickInfo.kicked
                ? "worker_kick_dispatched"
                : effectiveStatus === "queued"
                  ? "waiting_for_worker"
                  : effectiveStatus === "running"
                    ? "processing_chunks"
                    : effectiveStatus === "done"
                      ? "complete"
                      : effectiveStatus === "error"
                        ? "failed"
                        : "cancelled",
              worker_kick: {
                kicked: kickInfo.kicked,
                reason: kickInfo.reason,
              },
              watchdog: watchdogInfo,
            },
          }
          : {}),
      },
      200,
      cors,
    );
  } catch (err) {
    const errorRef = crypto.randomUUID();
    console.error("ai-jobs error:", { errorRef, err });
    return jsonResponse(
      { error: "Internal processing error", error_ref: errorRef },
      500,
      cors,
    );
  }
});
