import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { encode as encodeBase64 } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { getCorsHeaders, jsonResponse, parseJsonObject, rejectIfOriginNotAllowed } from "../_shared/security.ts";
import { buildMultiInstructionSystemPrompt } from "../_shared/multi_instruction_pdf_engine.ts";
import { getEnforcedModel } from "../_shared/aiConfig.ts";
import { dedupeEquivalentProductDataAliases } from "../_shared/productDataAliasDedup.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const AI_WORKER_SECRET = Deno.env.get("AI_WORKER_SECRET") || "";
const AI_WORKER_SHARED_SECRET = AI_WORKER_SECRET || SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";

const ENFORCED_MODEL = getEnforcedModel();
const GOOGLE_AI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GOOGLE_AI_UPLOAD = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GOOGLE_AI_FILES = "https://generativelanguage.googleapis.com/v1beta/files";
const AI_WORKER_URL = `${SUPABASE_URL}/functions/v1/ai-worker`;

const MAX_CHARS_PER_CHUNK = 32_000;
const MAX_PAGES_PER_CHUNK = 5;
const MAX_CHUNKS_PER_INVOCATION = (() => {
  const n = Number(Deno.env.get("AI_MAX_CHUNKS_PER_INVOCATION") || "6");
  if (!Number.isFinite(n) || n <= 0) return 6;
  return Math.min(12, Math.floor(n));
})();
const CHUNK_CONCURRENCY = (() => {
  const n = Number(Deno.env.get("AI_CHUNK_CONCURRENCY") || "3");
  if (!Number.isFinite(n) || n <= 0) return 3;
  return Math.min(6, Math.floor(n));
})();
const CHUNK_TIMEOUT_MS = (() => {
  const n = Number(Deno.env.get("AI_CHUNK_TIMEOUT_MS") || "120000");
  if (!Number.isFinite(n) || n < 5000) return 120_000;
  return Math.floor(n);
})();
const FREE_EDGE_RUNTIME_SAFE_TIMEOUT_MS = 120_000;
const DIRECT_FILES_TIMEOUT_MS = (() => {
  const n = Number(Deno.env.get("AI_DIRECT_FILES_TIMEOUT_MS") || String(FREE_EDGE_RUNTIME_SAFE_TIMEOUT_MS));
  if (!Number.isFinite(n) || n < 10000) return FREE_EDGE_RUNTIME_SAFE_TIMEOUT_MS;
  return Math.min(FREE_EDGE_RUNTIME_SAFE_TIMEOUT_MS, Math.floor(n));
})();
const SINGLE_PASS_MAX_CHARS = (() => {
  const n = Number(Deno.env.get("AI_SINGLE_PASS_MAX_CHARS") || "450000");
  if (!Number.isFinite(n) || n < 50000) return 450000;
  return Math.floor(n);
})();
const DIRECT_FILES_MAX_TOTAL_BYTES = (() => {
  const n = Number(Deno.env.get("AI_DIRECT_FILES_MAX_TOTAL_BYTES") || String(100 * 1024 * 1024));
  if (!Number.isFinite(n) || n <= 0) return 100 * 1024 * 1024; // 100MB — Files API supports up to 2GB
  return Math.floor(n);
})();
const DIRECT_FILES_MAX_PER_FILE_BYTES = (() => {
  const n = Number(Deno.env.get("AI_DIRECT_FILES_MAX_PER_FILE_BYTES") || String(100 * 1024 * 1024));
  if (!Number.isFinite(n) || n <= 0) return 100 * 1024 * 1024; // 100MB per file
  return Math.floor(n);
})();
const FILE_DOWNLOAD_TIMEOUT_MS = (() => {
  const n = Number(Deno.env.get("AI_FILE_DOWNLOAD_TIMEOUT_MS") || "30000");
  if (!Number.isFinite(n) || n < 5000) return 30_000;
  return Math.min(120_000, Math.floor(n));
})();
const CHUNK_HEARTBEAT_INTERVAL_MS = (() => {
  const n = Number(Deno.env.get("AI_CHUNK_HEARTBEAT_INTERVAL_MS") || "15000");
  if (!Number.isFinite(n) || n < 3000) return 15_000;
  return Math.min(60_000, Math.floor(n));
})();
const GEMINI_FILES_UPLOAD_TIMEOUT_MS = (() => {
  const n = Number(Deno.env.get("AI_GEMINI_FILES_UPLOAD_TIMEOUT_MS") || "45000");
  if (!Number.isFinite(n) || n < 5000) return 45_000;
  return Math.min(FREE_EDGE_RUNTIME_SAFE_TIMEOUT_MS, Math.floor(n));
})();
const GEMINI_FILES_STATUS_TIMEOUT_MS = (() => {
  const n = Number(Deno.env.get("AI_GEMINI_FILES_STATUS_TIMEOUT_MS") || "15000");
  if (!Number.isFinite(n) || n < 3000) return 15_000;
  return Math.min(60_000, Math.floor(n));
})();
const GEMINI_FILES_PROCESSING_MAX_WAIT_MS = (() => {
  const n = Number(Deno.env.get("AI_GEMINI_FILES_PROCESSING_MAX_WAIT_MS") || "60000");
  if (!Number.isFinite(n) || n < 5000) return 60_000;
  return Math.min(FREE_EDGE_RUNTIME_SAFE_TIMEOUT_MS, Math.floor(n));
})();
const GEMINI_FILES_UPLOAD_RETRIES = (() => {
  const n = Number(Deno.env.get("AI_GEMINI_FILES_UPLOAD_RETRIES") || "1");
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(3, Math.floor(n));
})();
const AI_WORKER_ENFORCE_AUTH = (() => {
  const raw = (Deno.env.get("AI_WORKER_ENFORCE_AUTH") || "").trim();
  // Secure by default for internal worker endpoint.
  if (!raw) return true;
  const value = raw.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
})();
const MAX_OUTPUT_TOKENS = (() => {
  const n = Number(Deno.env.get("GEMINI_MAX_OUTPUT_TOKENS") || "16384");
  if (!Number.isFinite(n) || n <= 0) return 16384;
  return Math.floor(n);
})();
const GEMINI_THINKING_BUDGET = (() => {
  const raw = (Deno.env.get("GEMINI_THINKING_BUDGET") || "").trim();
  if (!raw) return undefined; // unset = don't send thinkingConfig (safest default)
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n); // 0 = disable thinking, >0 = token budget
})();
const GEMINI_TRANSPORT_MAX_RETRIES = (() => {
  const n = Number(Deno.env.get("AI_GEMINI_TRANSPORT_MAX_RETRIES") || "1");
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(3, Math.floor(n));
})();
const AI_JOB_TRANSPORT_RETRY_MAX = (() => {
  const n = Number(Deno.env.get("AI_JOB_TRANSPORT_RETRY_MAX") || "1");
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(2, Math.floor(n));
})();
const COMPARE_MIN_INVENTORY_TOTAL_FOR_SKIP_RESCUE = (() => {
  const n = Number(Deno.env.get("AI_COMPARE_MIN_INVENTORY_TOTAL_FOR_SKIP_RESCUE") || "5");
  if (!Number.isFinite(n) || n < 5) return 5;
  return Math.min(40, Math.floor(n));
})();

function getModelCandidates(primaryModel: string): string[] {
  const configuredFallbacks = (Deno.env.get("AI_MODEL_FALLBACKS") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const defaults = [
    "gemini-3-flash-preview",
    "gemini-3-flash",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash",
  ];
  const ordered = [primaryModel, ...configuredFallbacks, ...defaults];
  return [...new Set(ordered.filter(Boolean))];
}

function isModelNotFoundErrorText(text: string): boolean {
  const message = (text || "").toLowerCase();
  if (!message) return false;
  return (
    (message.includes("is not found") && message.includes("api version")) ||
    message.includes("not supported for generatecontent") ||
    message.includes("call listmodels") ||
    (message.includes("models/") && message.includes("not found"))
  );
}

/**
 * Returns true if the model family is known to support thinkingConfig.
 * Currently only gemini-2.5-* models support it.
 */
function supportsThinkingConfig(model: string): boolean {
  const normalized = (model || "").toLowerCase();
  return normalized.startsWith("gemini-2.5-");
}

/**
 * Returns true if the 400 error was caused by an unsupported request field
 * (e.g. thinkingConfig on a model that doesn't recognise it).
 */
function isUnsupportedFieldError(errorText: string): boolean {
  const lower = (errorText || "").toLowerCase();
  return lower.includes("unknown name") || lower.includes("cannot find field");
}

// ── Module-level file byte cache (survives across invocations within same isolate) ──
const fileBytesCache = new Map<string, { bytes: Uint8Array; loadedAt: number }>();
const FILE_CACHE_TTL_MS = 30 * 60_000; // 30 min

function getCachedFileBytes(cacheKey: string): Uint8Array | null {
  const cached = fileBytesCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.loadedAt >= FILE_CACHE_TTL_MS) {
    fileBytesCache.delete(cacheKey);
    return null;
  }
  return cached.bytes;
}

function setCachedFileBytes(cacheKey: string, bytes: Uint8Array): void {
  // Evict oldest entry when at capacity (LRU-style: sort by loadedAt ascending)
  if (fileBytesCache.size >= 10) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of fileBytesCache) {
      if (entry.loadedAt < oldestTime) {
        oldestTime = entry.loadedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) fileBytesCache.delete(oldestKey);
  }
  fileBytesCache.set(cacheKey, { bytes, loadedAt: Date.now() });
}

/**
 * Refresh cache entry's loadedAt on access (LRU behavior).
 * Called after a cache hit to keep frequently-used entries alive.
 */
function touchCachedFileBytes(cacheKey: string): void {
  const cached = fileBytesCache.get(cacheKey);
  if (cached) cached.loadedAt = Date.now();
}

// ── Gemini Files API: upload files for URI-based references (no base64 payload) ──

interface GeminiFileUploadResult {
  fileUri: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
}

interface CachedGeminiFileReference {
  fileUri: string;
  displayName: string;
  mimeType: string;
  cachedAt: number;
}

const GEMINI_FILE_URI_CACHE_TTL_MS = (() => {
  const n = Number(Deno.env.get("AI_GEMINI_FILE_URI_CACHE_TTL_MS") || String(30 * 60 * 1000));
  if (!Number.isFinite(n) || n < 60_000) return 30 * 60 * 1000;
  return Math.min(6 * 60 * 60 * 1000, Math.floor(n));
})();

const geminiFileUriCache = new Map<string, CachedGeminiFileReference>();

function getCachedGeminiFileReference(cacheKey: string): CachedGeminiFileReference | null {
  const cached = geminiFileUriCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > GEMINI_FILE_URI_CACHE_TTL_MS) {
    geminiFileUriCache.delete(cacheKey);
    return null;
  }
  return cached;
}

function parseBoolEnv(value: string | null | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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

function isFreshSignedTimestamp(rawTs: string | null): boolean {
  if (!rawTs || !/^\d{10,14}$/.test(rawTs.trim())) return false;
  const ts = Number(rawTs);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const skewMs = Math.abs(Date.now() - ts);
  return skewMs <= 5 * 60_000;
}

async function buildInternalWorkerHeaders(bodyText: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: SUPABASE_SERVICE_ROLE_KEY,
  };

  if (AI_WORKER_SHARED_SECRET) {
    if (AI_WORKER_SECRET) {
      headers["x-ai-worker-secret"] = AI_WORKER_SECRET;
    }
    const ts = Date.now().toString();
    const signature = await hmacSha256Hex(AI_WORKER_SHARED_SECRET, `${ts}.${bodyText}`);
    headers["x-ai-worker-ts"] = ts;
    headers["x-ai-worker-sig"] = signature;
  }

  return headers;
}

function setCachedGeminiFileReference(cacheKey: string, value: Omit<CachedGeminiFileReference, "cachedAt">): void {
  if (geminiFileUriCache.size >= 40) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of geminiFileUriCache) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) geminiFileUriCache.delete(oldestKey);
  }

  geminiFileUriCache.set(cacheKey, {
    ...value,
    cachedAt: Date.now(),
  });
}

function invalidateCachedGeminiFileReference(cacheKey: string): void {
  geminiFileUriCache.delete(cacheKey);
}

function looksLikeStaleGeminiFileUriError(message: string): boolean {
  const text = (message || "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("file") &&
    (text.includes("not found") ||
      text.includes("invalid") ||
      text.includes("cannot access") ||
      text.includes("permission") ||
      text.includes("deleted"))
  );
}

async function uploadToGeminiFilesAPIOnce(
  bytes: Uint8Array,
  mimeType: string,
  displayName: string,
): Promise<GeminiFileUploadResult> {
  const uploadUrl = `${GOOGLE_AI_UPLOAD}?key=${GEMINI_API_KEY}`;

  const boundary = `----GeminiUpload${Date.now()}${Math.random().toString(36).slice(2)}`;
  const metadataPart = JSON.stringify({ file: { displayName } });

  const encoder = new TextEncoder();
  const preamble = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${metadataPart}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(preamble.length + bytes.length + epilogue.length);
  body.set(preamble, 0);
  body.set(bytes, preamble.length);
  body.set(epilogue, preamble.length + bytes.length);

  const response = await fetchWithHardTimeout(
    uploadUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "X-Goog-Upload-Protocol": "multipart",
      },
      body,
    },
    GEMINI_FILES_UPLOAD_TIMEOUT_MS,
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini Files API upload failed (${response.status}): ${errText}`);
  }

  const result = await response.json();
  const file = result.file;
  if (!file?.uri) {
    throw new Error("Gemini Files API returned no file URI");
  }

  const maxWait = GEMINI_FILES_PROCESSING_MAX_WAIT_MS;
  const startedAt = Date.now();
  let fileState = String(file.state || "ACTIVE").toUpperCase();
  let fileUri = file.uri;
  const fileName = file.name;
  let pollDelay = 300;

  while (fileState === "PROCESSING" && Date.now() - startedAt < maxWait) {
    await new Promise((r) => setTimeout(r, pollDelay));
    pollDelay = Math.min(pollDelay * 2, 4_000);

    const statusResp = await fetchWithHardTimeout(
      `${GOOGLE_AI_FILES}/${fileName}?key=${GEMINI_API_KEY}`,
      { method: "GET" },
      GEMINI_FILES_STATUS_TIMEOUT_MS,
    );
    if (!statusResp.ok) {
      const statusErrText = await statusResp.text();
      throw new Error(
        `Gemini Files API status failed (${statusResp.status}) for ${displayName}: ${trimPreview(statusErrText, 220)}`,
      );
    }

    const statusData = await statusResp.json();
    fileState = String(statusData.state || "ACTIVE").toUpperCase();
    fileUri = statusData.uri || fileUri;
    if (fileState === "FAILED") {
      throw new Error(`Gemini file ${displayName} entered FAILED state`);
    }
  }

  if (fileState === "PROCESSING") {
    throw new Error(`Gemini file ${displayName} still processing after ${maxWait}ms`);
  }
  if (fileState !== "ACTIVE") {
    throw new Error(`Gemini file ${displayName} finished in unexpected state: ${fileState}`);
  }

  console.log(`GEMINI_FILE_UPLOADED: ${displayName} -> ${fileUri} (${bytes.length} bytes)`);

  return { fileUri, displayName, mimeType, sizeBytes: bytes.length };
}

async function uploadToGeminiFilesAPI(
  bytes: Uint8Array,
  mimeType: string,
  displayName: string,
): Promise<GeminiFileUploadResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const retryDelays = [0, 500, 1_500, 3_000].slice(0, GEMINI_FILES_UPLOAD_RETRIES + 1);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt] > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }

    try {
      const uploaded = await uploadToGeminiFilesAPIOnce(bytes, mimeType, displayName);
      if (attempt > 0) {
        console.warn(
          `GEMINI_FILES_UPLOAD_RECOVERED displayName=${displayName} attempt=${attempt + 1}/${retryDelays.length}`,
        );
      }
      return uploaded;
    } catch (error) {
      lastError = error;
      if (attempt >= retryDelays.length - 1) break;
      console.warn(
        `GEMINI_FILES_UPLOAD_RETRY displayName=${displayName} attempt=${attempt + 1}/${retryDelays.length} error=${error instanceof Error ? trimPreview(error.message, 220) : trimPreview(String(error), 220)}`,
      );
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Gemini Files API upload failed after ${retryDelays.length} attempt(s): ${message}`);
}

interface JobRecord {
  id: string;
  status: string;
  type: string;
  request_payload: Record<string, unknown>;
  timing: Record<string, unknown> | null;
  created_at?: string;
}

interface ChunkRecord {
  id: string;
  chunk_index: number;
  chunk_type: "pdf" | "text";
  text: string;
  status: string;
  timing: Record<string, unknown> | null;
  result: unknown;
  error: string | null;
}

interface ChunkCounts {
  total: number;
  queued: number;
  running: number;
  done: number;
  error: number;
  cancelled: number;
}

interface ExtractedFile {
  bucket: string;
  path: string;
  label: string;
  filename: string;
  pages: string[];
  bytes: number;
}

interface DownloadedFileRef {
  bucket: string;
  path: string;
  label: string;
  filename: string;
  bytes: Uint8Array;
}

interface ResponseGuardConfig {
  requiredSections: string[];
  requiredJsonKeys: string[];
  minJsonProperties: number;
  minJsonItems: number;
}

interface FinalizeOutcome {
  status: "done" | "error" | "retry";
  reason?: string;
}

interface DownloadedDirectFileRef extends DownloadedFileRef {
  mimeType: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .split("\u0000")
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function trimPreview(value: string, max = 400): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

function sanitizeUserFacingAiError(raw: string): string {
  const text = (raw || "").trim();
  if (!text) return "AI processing failed. Please retry.";
  if (/LOW_CONFIDENCE_INPUT/i.test(text)) return text;

  if (isModelNotFoundErrorText(text)) {
    return "Configured AI model is unavailable for this API. Update model settings or set AI_MODEL_FALLBACKS.";
  }

  if (/all\s*chunks?\s*failed/i.test(text)) {
    if (
      /sendrequest|connection\s*reset|connection\s*error|timed\s*out|timeout|generatecontent|https?:\/\//i.test(text)
    ) {
      return "All chunks failed due to AI connection instability. Please retry with the same files.";
    }
    return "All chunks failed. Please retry with cleaner PDFs if the issue repeats.";
  }

  if (/sendrequest|connection\s*reset|connection\s*error|timed\s*out|timeout|generatecontent|https?:\/\//i.test(text)) {
    return "AI connection failed while contacting the model. Please retry.";
  }

  if (/api\.?key|unauthorized|403|401|not configured|not set/i.test(text)) {
    return "AI service configuration error. Contact Eran to resolve this.";
  }

  return text;
}

function normalizeSectionTextForValidation(value: string): string {
  return value.replace(/\r/g, "\n").trim();
}

function extractProductDataSection(value: string): string {
  const text = normalizeSectionTextForValidation(value);
  const match = text.match(/===\s*PRODUCT_DATA\s*===([\s\S]*?)(?=\n===\s*[A-Z0-9_\-/ ]+\s*===|$)/i);
  if (!match) return "";
  return (match[1] || "").trim();
}

function looksLikePlaceholderProductData(value: string): boolean {
  const section = extractProductDataSection(value);
  if (section) {
    return /^MISSING\s*:\s*MISSING$/i.test(section) || section.toUpperCase() === "MISSING";
  }
  return /^MISSING\s*:\s*MISSING$/i.test(value.trim()) || value.trim().toUpperCase() === "MISSING";
}

function hasLowStructuredEvidence(value: string): boolean {
  const section = extractProductDataSection(value) || value;
  const normalized = section.trim();
  if (!normalized) return true;
  const alphaNumChars = (normalized.match(/[A-Za-z0-9]/g) || []).length;
  const fieldLikeLines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z0-9][A-Z0-9 _/&()+.'%:-]{1,140}:\s+\S+/i.test(line)).length;
  return alphaNumChars < 180 || fieldLikeLines < 2;
}

function computeOutputChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function toStringSafe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeChunkForDebug(row: {
  chunk_index?: unknown;
  chunk_type?: unknown;
  status?: unknown;
  latency_ms?: unknown;
  error?: unknown;
  timing?: unknown;
  text?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}): Record<string, unknown> {
  const timing = isPlainObject(row.timing) ? row.timing : {};
  return {
    chunk_index: row.chunk_index,
    chunk_type: row.chunk_type,
    status: row.status,
    latency_ms: row.latency_ms,
    error: row.error,
    text_chars: typeof row.text === "string" ? row.text.length : 0,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    timing: {
      started_at: timing.started_at ?? null,
      finished_at: timing.finished_at ?? null,
      total_ms: timing.total_ms ?? 0,
      gemini_ms: timing.gemini_ms ?? 0,
      prompt_chars: timing.prompt_chars ?? 0,
      output_chars: timing.output_chars ?? 0,
      retry_count: timing.retry_count ?? 0,
      cache_hit: timing.cache_hit ?? false,
      http_status: timing.http_status ?? null,
      gemini_error: timing.gemini_error ?? null,
      source: timing.source ?? null,
      direct_files_mode: timing.direct_files_mode ?? false,
      input_file_count: timing.input_file_count ?? 0,
      input_file_bytes: timing.input_file_bytes ?? 0,
    },
  };
}

function extractGeminiText(result: unknown): string {
  if (!result || typeof result !== "object") {
    throw new Error("Gemini returned an invalid payload");
  }

  const candidates = (result as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("No response candidates from Gemini");
  }

  const first = candidates[0] as { content?: { parts?: Array<{ text?: string }> }; finishReason?: string };
  const parts = first?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Gemini response content is missing");
  }

  const text = parts.find((p) => typeof p?.text === "string")?.text;
  if (!text || !text.trim()) {
    throw new Error("Gemini response did not contain text");
  }

  if (first?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini output truncated by MAX_TOKENS");
  }

  return text;
}

function extractUsage(result: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!result || typeof result !== "object") return undefined;
  const usage = (
    result as {
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }
  ).usageMetadata;
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
}

function repairAndParseJson(raw: string): unknown {
  // Strip markdown code fences
  let cleaned = raw
    .trim()
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  // Find JSON boundaries
  const jsonStart = cleaned.search(/[[{]/);
  if (jsonStart === -1) throw new Error("No JSON object found in response");
  const openChar = cleaned[jsonStart];
  const closeChar = openChar === "[" ? "]" : "}";
  const jsonEnd = cleaned.lastIndexOf(closeChar);

  if (jsonEnd <= jsonStart) {
    // Truncated — try to close it
    cleaned = cleaned.substring(jsonStart);
  } else {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }

  const tryParse = (text: string): unknown | null => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const closeTruncatedJson = (text: string): string => {
    let out = "";
    let inString = false;
    let escaped = false;
    const stack: Array<"{" | "["> = [];

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        out += ch;
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        out += ch;
        continue;
      }
      if (ch === "{") {
        stack.push("{");
        out += ch;
        continue;
      }
      if (ch === "[") {
        stack.push("[");
        out += ch;
        continue;
      }
      if (ch === "}") {
        const top = stack[stack.length - 1];
        if (top === "{") {
          stack.pop();
          out += ch;
        }
        continue;
      }
      if (ch === "]") {
        const top = stack[stack.length - 1];
        if (top === "[") {
          stack.pop();
          out += ch;
        }
        continue;
      }
      out += ch;
    }

    if (escaped) out += "\\";
    if (inString) out += "\"";

    out = out.trimEnd();
    while (/[,:]\s*$/.test(out)) {
      out = out.replace(/[,:]\s*$/, "").trimEnd();
    }

    for (let i = stack.length - 1; i >= 0; i -= 1) {
      out += stack[i] === "{" ? "}" : "]";
    }
    return out;
  };

  const trimToLastComma = (text: string): string | null => {
    let inString = false;
    let escaped = false;
    let lastComma = -1;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === ",") lastComma = i;
    }

    if (lastComma <= 0) return null;
    return closeTruncatedJson(text.slice(0, lastComma));
  };

  const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const unescapeLooseString = (value: string): string =>
    value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
      .trim();
  const extractLooseField = (text: string, keys: string[]): string | null => {
    const normalizedTargets = new Set(keys.map(normalizeKey));
    const keyPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*"/g;
    let match: RegExpExecArray | null = null;

    while ((match = keyPattern.exec(text)) !== null) {
      const rawKey = unescapeLooseString(match[1]);
      if (!normalizedTargets.has(normalizeKey(rawKey))) continue;

      let value = "";
      let escaped = false;
      for (let i = keyPattern.lastIndex; i < text.length; i += 1) {
        const ch = text[i];
        if (escaped) {
          value += ch;
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          value += ch;
          continue;
        }
        if (ch === "\"") {
          return unescapeLooseString(value);
        }
        value += ch;
      }
      return unescapeLooseString(value);
    }
    return null;
  };

  // First attempts
  const direct = tryParse(cleaned);
  if (direct !== null) return direct;

  // Repair pass: trailing commas, control chars, bad escapes
  cleaned = cleaned
    .replace(/./gs, (ch) => {
      const code = ch.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : ch;
    }) // control characters -> space
  // Repair pass: trailing commas, control chars inside strings, bad escapes
  let outCleaned = "";
  let inStringRepair = false;
  let escapedRepair = false;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inStringRepair) {
      if (escapedRepair) {
        outCleaned += ch;
        escapedRepair = false;
      } else if (ch === "\\") {
        escapedRepair = true;
        outCleaned += ch;
      } else if (ch === "\"") {
        inStringRepair = false;
        outCleaned += ch;
      } else if (ch === "\n") {
        outCleaned += "\\n";
      } else if (ch === "\r") {
        // ignore
      } else if (ch === "\t") {
        outCleaned += "\\t";
      } else if (ch.charCodeAt(0) <= 31 || ch.charCodeAt(0) === 127) {
        outCleaned += " ";
      } else {
        outCleaned += ch;
      }
    } else {
      if (ch === "\"") {
        inStringRepair = true;
      }
      outCleaned += ch;
    }
  }

  cleaned = outCleaned
    .replace(/,\s*([}\]])/g, "$1") // trailing commas
    .replace(/([^\\])\\(?!["\\/bfnrtu])/g, "$1\\\\"); // bad escapes

  const sanitized = tryParse(cleaned);
  if (sanitized !== null) return sanitized;

  const closed = closeTruncatedJson(cleaned);
  const closedParsed = tryParse(closed);
  if (closedParsed !== null) return closedParsed;

  const trimmed = trimToLastComma(closed);
  if (trimmed) {
    const trimmedParsed = tryParse(trimmed);
    if (trimmedParsed !== null) return trimmedParsed;
  }

  const title = extractLooseField(closed, [
    "title",
    "product_title",
    "product-title",
    "name",
    "product name",
    "ai_title",
    "ai-title",
  ]);
  const description = extractLooseField(closed, [
    "description",
    "product_description",
    "product-description",
    "ai_description",
    "ai-description",
    "chatgpt_description",
    "chatgpt-description",
    "body",
    "copy",
  ]);
  if (title && description) {
    return { title, description };
  }
  if (title || description) {
    const res: Record<string, string> = {};
    if (title) res.title = title;
    if (description) res.description = description;
    return res;
  }

  throw new Error("Failed to parse JSON after repair: malformed or truncated model output");
}

function parseGeminiOutput(rawText: string, jsonMode: boolean, strictJson = false): unknown {
  if (!jsonMode) return rawText;
  if (strictJson) {
    // Strict mode: no JSON repair. Parse the model output as-is and fail fast.
    const text = rawText.trim();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`Strict JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Resilient mode: repair slightly malformed JSON before parsing.
  return repairAndParseJson(rawText);
}

function buildPdfCompareResponseSchema(): Record<string, unknown> {
  return {
    type: "OBJECT",
    required: ["same_product_assessment", "extracted_data", "comparison_audit"],
    properties: {
      same_product_assessment: {
        type: "OBJECT",
        required: ["same_product", "confidence", "reason"],
        properties: {
          same_product: { type: "BOOLEAN" },
          confidence: { type: "NUMBER" },
          reason: { type: "STRING" },
        },
      },
      extracted_data: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          required: ["field", "supplier", "ls"],
          properties: {
            field: { type: "STRING" },
            supplier: { type: "STRING" },
            ls: { type: "STRING" },
            status: { type: "STRING" },
            notes: { type: "STRING" },
          },
        },
      },
      comparison_audit: {
        type: "OBJECT",
        required: ["fields_a", "fields_b", "identical", "equivalent", "different", "added", "ignored"],
        properties: {
          fields_a: { type: "NUMBER" },
          fields_b: { type: "NUMBER" },
          identical: { type: "NUMBER" },
          equivalent: { type: "NUMBER" },
          different: { type: "NUMBER" },
          added: { type: "NUMBER" },
          ignored: { type: "NUMBER" },
        },
      },
    },
  };
}

async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sanitizeFileRefs(value: unknown): Array<{ bucket: string; path: string; label: string; filename: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ bucket: string; path: string; label: string; filename: string }> = [];

  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const bucket = typeof item.bucket === "string" ? item.bucket : "";
    const path = typeof item.path === "string" ? item.path : "";
    if (!bucket || !path) continue;

    const rawLabel = typeof item.label === "string" ? item.label : "document";
    const filename = typeof item.filename === "string" ? item.filename : path.split("/").pop() || "document";
    const normalizedLabel = normalizeInstructionLabel(rawLabel, filename);

    out.push({ bucket, path, label: normalizedLabel, filename });
  }

  return out.slice(0, 5);
}

function normalizeInstructionLabel(label: string, filename: string): string {
  const normalized = (label || "").trim().toLowerCase();
  if (normalized === "instructions" || normalized.includes("instruction")) {
    return "instructions";
  }
  if ((filename || "").toLowerCase().includes("instruction")) {
    return "instructions";
  }
  return label || "document";
}

function isInstructionLikeFile(file: { label?: string; filename?: string }): boolean {
  const normalizedLabel = normalizeInstructionLabel(file.label || "", file.filename || "");
  return normalizedLabel === "instructions";
}

function isAllowMissingInstructionEnabled(configFlags: unknown): boolean {
  return isPlainObject(configFlags) && configFlags.allowMissingInstruction === true;
}

function shouldIgnoreMissingInstructionDownload(
  ref: { label: string; bucket: string; path: string; filename: string },
  error: unknown,
  allowMissingInstruction: boolean,
): boolean {
  if (!allowMissingInstruction) return false;
  if (ref.label !== "instructions") return false;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to download|http 404|not found|no such object/i.test(message);
}

function inferMimeType(filename: string, bytes: Uint8Array): string {
  const lower = filename.toLowerCase();
  if (looksLikePdf(filename, bytes)) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function isDirectMimeSupported(mimeType: string): boolean {
  return ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType);
}

function buildDirectChunkText(refs: Array<{ bucket: string; path: string; label: string; filename: string }>): string {
  const lines = refs.map((ref, idx) => `${idx + 1}. ${ref.label} | ${ref.filename} | ${ref.bucket}/${ref.path}`);
  return `[DIRECT_FILES_MODE]\n${lines.join("\n")}`;
}

async function downloadFilesForDirectMode(
  supabase: any,
  refs: Array<{ bucket: string; path: string; label: string; filename: string }>,
  allowMissingInstruction = false,
  disableCache = true,
): Promise<{
  files: DownloadedFileRef[];
  totalBytes: number;
  downloadMs: number;
  eligible: boolean;
  reason: string | null;
}> {
  const startedAt = Date.now();
  const downloaded: DownloadedFileRef[] = [];

  // Download all files in parallel for speed (saves ~3-4s on 12+ MB payloads)
  const results = await Promise.allSettled(
    refs.map(async (ref) => {
      let cached: Uint8Array | null = null;
      const cacheKey = `${ref.bucket}/${ref.path}`;
      if (!disableCache) {
        cached = getCachedFileBytes(cacheKey);
        if (cached) {
          touchCachedFileBytes(cacheKey);
        }
      }
      const bytes = cached ?? (await downloadFileBytes(supabase, ref.bucket, ref.path));
      if (!disableCache && !cached) {
        setCachedFileBytes(cacheKey, bytes);
      }
      return { ...ref, bytes } as DownloadedFileRef;
    }),
  );
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      downloaded.push(result.value);
    } else {
      const ref = refs[i];
      if (shouldIgnoreMissingInstructionDownload(ref, result.reason, allowMissingInstruction)) {
        console.warn(`AI_OPTIONAL_INSTRUCTION_SKIPPED bucket=${ref.bucket} path=${ref.path} filename=${ref.filename}`);
        continue;
      }
      throw result.reason;
    }
  }

  const downloadMs = Date.now() - startedAt;
  if (downloaded.length === 0) {
    return { files: [], totalBytes: 0, downloadMs, eligible: false, reason: "no_downloadable_files" };
  }

  let totalBytes = 0;
  for (const file of downloaded) {
    const size = file.bytes.length;
    totalBytes += size;
    if (size > DIRECT_FILES_MAX_PER_FILE_BYTES) {
      return { files: downloaded, totalBytes, downloadMs, eligible: false, reason: "file_too_large" };
    }
    const mimeType = inferMimeType(file.filename, file.bytes);
    if (!isDirectMimeSupported(mimeType)) {
      return { files: downloaded, totalBytes, downloadMs, eligible: false, reason: `unsupported_mime:${mimeType}` };
    }
  }

  if (totalBytes > DIRECT_FILES_MAX_TOTAL_BYTES) {
    return { files: downloaded, totalBytes, downloadMs, eligible: false, reason: "total_bytes_too_large" };
  }

  return { files: downloaded, totalBytes, downloadMs, eligible: true, reason: null };
}

async function hasWorkerAccess(req: Request): Promise<boolean> {
  if (!AI_WORKER_ENFORCE_AUTH) {
    return true;
  }

  if (AI_WORKER_SHARED_SECRET) {
    const sig = (req.headers.get("x-ai-worker-sig") || "").trim().toLowerCase();
    const ts = req.headers.get("x-ai-worker-ts");
    if (isFreshSignedTimestamp(ts) && sig) {
      const rawBody = await req.clone().text();
      const expected = await hmacSha256Hex(AI_WORKER_SHARED_SECRET, `${ts}.${rawBody}`);
      if (timingSafeEqualHex(sig, expected)) return true;
    }
  }

  // Legacy key-based fallback is disabled by default.
  // Enable only as a temporary rollback path:
  // AI_WORKER_ALLOW_LEGACY_KEY_AUTH=true
  const allowLegacyKeyAuth = parseBoolEnv(Deno.env.get("AI_WORKER_ALLOW_LEGACY_KEY_AUTH"), false);
  if (!allowLegacyKeyAuth) {
    return false;
  }

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const apiKey = (req.headers.get("apikey") || "").trim();

  if (token && token === SUPABASE_SERVICE_ROLE_KEY) {
    return true;
  }

  if (apiKey && apiKey === SUPABASE_SERVICE_ROLE_KEY) {
    return true;
  }

  return false;
}

async function claimJob(supabase: any, requestedJobId?: string): Promise<JobRecord | null> {
  const nowIso = new Date().toISOString();

  if (requestedJobId) {
    // Only claim if job is still queued — prevents duplicate workers
    const { data: claimed } = await supabase
      .from("ai_jobs")
      .update({
        status: "running",
        progress: 5,
        updated_at: nowIso,
      })
      .eq("id", requestedJobId)
      .eq("status", "queued")
      .select("id, status, type, request_payload, timing, created_at")
      .maybeSingle();

    if (claimed) {
      return claimed as JobRecord;
    }

    // If already running, check if there are queued chunks that need processing
    const { data: running } = await supabase
      .from("ai_jobs")
      .select("id, status, type, request_payload, timing, created_at")
      .eq("id", requestedJobId)
      .eq("status", "running")
      .maybeSingle();

    if (!running) return null;

    // Only process if there are actually queued chunks waiting
    const { data: queuedChunks } = await supabase
      .from("ai_job_chunks")
      .select("id")
      .eq("job_id", requestedJobId)
      .eq("status", "queued")
      .limit(1)
      .maybeSingle();

    if (!queuedChunks) {
      // No queued chunks — another worker is already handling it
      return null;
    }

    return running as JobRecord;
  }

  const { data: nextQueued } = await supabase
    .from("ai_jobs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!nextQueued?.id) {
    return null;
  }

  const { data: claimed } = await supabase
    .from("ai_jobs")
    .update({
      status: "running",
      progress: 5,
      updated_at: nowIso,
    })
    .eq("id", nextQueued.id)
    .eq("status", "queued")
    .select("id, status, type, request_payload, timing, created_at")
    .maybeSingle();

  return (claimed as JobRecord | null) ?? null;
}

async function getChunkCounts(supabase: any, jobId: string): Promise<ChunkCounts> {
  const { data } = await supabase.from("ai_job_chunks").select("status").eq("job_id", jobId);

  const counts: ChunkCounts = {
    total: 0,
    queued: 0,
    running: 0,
    done: 0,
    error: 0,
    cancelled: 0,
  };

  for (const row of data || []) {
    const status = typeof row.status === "string" ? row.status : "queued";
    counts.total += 1;
    if (status === "queued") counts.queued += 1;
    else if (status === "running") counts.running += 1;
    else if (status === "done") counts.done += 1;
    else if (status === "error") counts.error += 1;
    else if (status === "cancelled") counts.cancelled += 1;
  }

  return counts;
}

async function updateJob(supabase: any, jobId: string, updates: Record<string, unknown>): Promise<void> {
  await supabase
    .from("ai_jobs")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", ["queued", "running"]);
}

async function updateChunk(supabase: any, chunkId: string, updates: Record<string, unknown>): Promise<void> {
  await supabase
    .from("ai_job_chunks")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", chunkId)
    .eq("status", "running");
}

async function downloadFileBytes(_supabase: any, bucket: string, path: string): Promise<Uint8Array> {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const retryDelaysMs = [0, 250, 750, 1500];
  let lastError = "no data";
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const endpoint = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
  const headers = {
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: SUPABASE_SERVICE_ROLE_KEY,
  };

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) {
      await wait(retryDelaysMs[attempt]);
    }

    try {
      const response = await fetchWithHardTimeout(endpoint, { method: "GET", headers }, FILE_DOWNLOAD_TIMEOUT_MS);

      if (response.ok) {
        const ab = await response.arrayBuffer();
        return new Uint8Array(ab);
      }

      const errText = trimPreview(await response.text(), 220);
      lastError = `HTTP ${response.status}${errText ? `: ${errText}` : ""}`;
      if (![408, 409, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        break;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Failed to download ${bucket}/${path}: ${lastError}`);
}

function looksLikePdf(path: string, bytes: Uint8Array): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return true;
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function splitByCharacters(text: string, maxChars: number): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const paragraphs = normalized
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (para.length <= maxChars) {
      current = para;
      continue;
    }

    for (let i = 0; i < para.length; i += maxChars) {
      chunks.push(para.slice(i, i + maxChars));
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function decodeTextBytes(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return normalizeText(utf8);
}

function extractPdfTextFallback(bytes: Uint8Array): string[] {
  const raw = new TextDecoder("latin1").decode(bytes);
  const collected: string[] = [];

  const tjRegex = /\(([^()]{1,2000})\)\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = tjRegex.exec(raw)) !== null) {
    const cleaned = match[1]
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ")
      .trim();
    if (cleaned) collected.push(cleaned);
  }

  const tjArrayRegex = /\[(.*?)\]\s*TJ/gs;
  while ((match = tjArrayRegex.exec(raw)) !== null) {
    const pieces = [...match[1].matchAll(/\(([^()]{1,2000})\)/g)].map((m) => m[1].trim()).filter(Boolean);
    if (pieces.length) collected.push(pieces.join(" "));
  }

  const merged = normalizeText(collected.join("\n"));
  if (!merged) {
    const ascii = normalizeText(raw.replace(/[^\x20-\x7E\n]+/g, " "));
    return splitByCharacters(ascii, MAX_CHARS_PER_CHUNK);
  }

  return splitByCharacters(merged, MAX_CHARS_PER_CHUNK);
}

async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
  try {
    const pdfjs = await import("https://esm.sh/pdfjs-dist@4.10.38/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: bytes,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
    });

    const pdf = await loadingTask.promise;
    const pages: string[] = Array.from({ length: pdf.numPages }, () => "");
    const pageConcurrency = Math.min(4, Math.max(1, pdf.numPages));
    let cursor = 1;

    const workers = Array.from({ length: pageConcurrency }, async () => {
      while (true) {
        const pageNumber = cursor;
        cursor += 1;
        if (pageNumber > pdf.numPages) break;

        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const text = textContent.items
          .map((item: unknown) => {
            if (!item || typeof item !== "object") return "";
            const value = (item as { str?: unknown }).str;
            return typeof value === "string" ? value : "";
          })
          .join(" ");

        pages[pageNumber - 1] = normalizeText(text);
      }
    });

    await Promise.all(workers);

    try {
      loadingTask.destroy();
    } catch {
      // Ignore
    }

    return pages.filter((p) => p.length > 0);
  } catch (error) {
    console.warn("PDF extraction fallback used:", error);
    return extractPdfTextFallback(bytes);
  }
}

async function extractFiles(
  supabase: any,
  refs: Array<{ bucket: string; path: string; label: string; filename: string }>,
  preDownloaded?: DownloadedFileRef[],
  allowMissingInstruction = false,
): Promise<{ files: ExtractedFile[]; downloadMs: number; extractMs: number; totalBytes: number }> {
  let downloaded: DownloadedFileRef[] = [];
  let downloadMs = 0;
  if (preDownloaded && preDownloaded.length > 0) {
    downloaded = preDownloaded;
  } else {
    const downloadStart = Date.now();
    for (const ref of refs) {
      try {
        const bytes = await downloadFileBytes(supabase, ref.bucket, ref.path);
        downloaded.push({ ...ref, bytes });
      } catch (error) {
        if (shouldIgnoreMissingInstructionDownload(ref, error, allowMissingInstruction)) {
          console.warn(
            `AI_OPTIONAL_INSTRUCTION_SKIPPED bucket=${ref.bucket} path=${ref.path} filename=${ref.filename}`,
          );
          continue;
        }
        throw error;
      }
    }
    downloadMs = Date.now() - downloadStart;
  }

  const extractStart = Date.now();
  const files: ExtractedFile[] = [];
  for (const file of downloaded) {
    // File validation: abort if file has zero bytes
    if (file.bytes.length === 0) {
      throw new Error(`File has zero bytes: ${file.bucket}/${file.path} (${file.label})`);
    }

    const pages = looksLikePdf(file.path, file.bytes)
      ? await extractPdfPages(file.bytes)
      : splitByCharacters(decodeTextBytes(file.bytes), MAX_CHARS_PER_CHUNK);

    // Validate extracted content is non-empty
    const totalExtractedChars = pages.reduce((sum, p) => sum + p.length, 0);
    if (totalExtractedChars === 0) {
      console.warn(
        `AI_FILE_EMPTY_EXTRACTION file=${file.bucket}/${file.path} label=${file.label} bytes=${file.bytes.length}`,
      );
      if (allowMissingInstruction && isInstructionLikeFile(file)) {
        console.warn(
          `AI_OPTIONAL_INSTRUCTION_EMPTY_EXTRACTION_SKIPPED bucket=${file.bucket} path=${file.path} filename=${file.filename}`,
        );
        continue;
      }
      throw new Error(
        `File extraction returned empty text: ${file.filename} (${file.label}). The file may be corrupted or password-protected.`,
      );
    }

    files.push({
      bucket: file.bucket,
      path: file.path,
      label: file.label,
      filename: file.filename,
      pages: pages.length > 0 ? pages : [""],
      bytes: file.bytes.length,
    });
  }
  const extractMs = Date.now() - extractStart;

  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  return { files, downloadMs, extractMs, totalBytes };
}

function buildChunksFromFiles(files: ExtractedFile[]): Array<{ chunk_type: "pdf"; text: string }> {
  if (files.length === 0) return [];

  const pagesPerFilePerChunk = Math.max(1, Math.floor(MAX_PAGES_PER_CHUNK / Math.max(1, files.length)));
  const chunks: Array<{ chunk_type: "pdf"; text: string }> = [];

  let cycle = 0;
  while (true) {
    const parts: string[] = [];

    for (const file of files) {
      const start = cycle * pagesPerFilePerChunk;
      const end = Math.min(file.pages.length, start + pagesPerFilePerChunk);
      for (let pageIndex = start; pageIndex < end; pageIndex++) {
        const pageText = normalizeText(file.pages[pageIndex] || "");
        if (!pageText) continue;
        parts.push(`[FILE ${file.label} | NAME ${file.filename} | PAGE ${pageIndex + 1}]\n${pageText}`);
      }
    }

    if (parts.length === 0) break;

    const base = parts.join("\n\n");
    const split = splitByCharacters(base, MAX_CHARS_PER_CHUNK);
    for (const piece of split) {
      chunks.push({ chunk_type: "pdf", text: piece });
    }

    cycle += 1;
  }

  if (chunks.length === 0) {
    const fallbackText = files
      .map((f) => `[FILE ${f.label} | NAME ${f.filename}]\n${normalizeText(f.pages.join("\n"))}`)
      .join("\n\n");

    for (const piece of splitByCharacters(fallbackText, MAX_CHARS_PER_CHUNK)) {
      chunks.push({ chunk_type: "pdf", text: piece });
    }
  }

  return chunks;
}

function buildSinglePassChunkFromFiles(files: ExtractedFile[]): {
  chunks: Array<{ chunk_type: "pdf"; text: string }>;
  tooLarge: boolean;
} {
  if (files.length === 0) return { chunks: [], tooLarge: false };

  const parts: string[] = [];
  for (const file of files) {
    for (let pageIndex = 0; pageIndex < file.pages.length; pageIndex++) {
      const pageText = normalizeText(file.pages[pageIndex] || "");
      if (!pageText) continue;
      parts.push(`[FILE ${file.label} | NAME ${file.filename} | PAGE ${pageIndex + 1}]\n${pageText}`);
    }
  }

  const merged = normalizeText(parts.join("\n\n"));
  if (!merged) return { chunks: [], tooLarge: false };

  if (merged.length <= SINGLE_PASS_MAX_CHARS) {
    return { chunks: [{ chunk_type: "pdf", text: merged }], tooLarge: false };
  }

  return { chunks: [], tooLarge: true };
}

function buildChunksFromText(documentText: string): Array<{ chunk_type: "text"; text: string }> {
  return splitByCharacters(documentText, MAX_CHARS_PER_CHUNK).map((text) => ({
    chunk_type: "text" as const,
    text,
  }));
}

async function ensureChunksExist(supabase: any, job: JobRecord): Promise<ChunkCounts> {
  const existing = await getChunkCounts(supabase, job.id);
  if (existing.total > 0) return existing;

  const payload = isPlainObject(job.request_payload) ? job.request_payload : {};
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const jobType = typeof payload.type === "string" ? payload.type : job.type;
  const promptOnlyAllowed = jobType === "generic" || jobType === "admin_action";
  const configFlags = isPlainObject(payload.configFlags) ? payload.configFlags : {};
  const allowMissingInstruction = isAllowMissingInstructionEnabled(configFlags);
  const disableCache = typeof configFlags.disableCache === "boolean" ? configFlags.disableCache : true;
  const singlePass = typeof configFlags.singlePass === "boolean" ? configFlags.singlePass : jobType === "pdf_compare";
  const directFilesPreferred = typeof configFlags.directFiles === "boolean" ? configFlags.directFiles : true;
  const fileRefs = sanitizeFileRefs(payload.files);
  const nonInstructionFileRefs = fileRefs.filter((ref) => !isInstructionLikeFile(ref));
  const allowDirectFilesForJob =
    jobType === "pdf_compare" || nonInstructionFileRefs.length >= 1 || configFlags.forceDirectFiles === true;
  let singlePassUsed = false;
  let singlePassFallbackReason: string | null = null;
  let directFilesMode = false;

  const documentText = typeof payload.documentText === "string" ? payload.documentText : "";

  let chunks: Array<{ chunk_type: "pdf" | "text"; text: string }> = [];
  let downloadMs = 0;
  let extractMs = 0;
  let totalBytes = 0;
  let preDownloadedRefs: DownloadedFileRef[] | undefined;
  let preUploadedGeminiFiles: Array<{ fileUri: string; displayName: string; mimeType: string; sizeBytes: number; label: string; filename: string }> | null = null;

  if (fileRefs.length > 0) {
    if (singlePass && directFilesPreferred && allowDirectFilesForJob) {
      const directCheck = await downloadFilesForDirectMode(supabase, fileRefs, allowMissingInstruction, disableCache);
      preDownloadedRefs = directCheck.files;
      downloadMs = directCheck.downloadMs;
      totalBytes = directCheck.totalBytes;

      if (directCheck.eligible) {
        chunks = [{ chunk_type: "pdf", text: buildDirectChunkText(fileRefs) }];
        singlePassUsed = true;
        directFilesMode = true;

        // Pre-upload files to Gemini Files API during chunk creation.
        // This moves the expensive upload out of processChunk so the
        // phase-split keeps each edge function invocation under the runtime limit.
        if (preDownloadedRefs && preDownloadedRefs.length > 0) {
          try {
            const uploaded: Array<{ fileUri: string; displayName: string; mimeType: string; sizeBytes: number; label: string; filename: string }> = [];
            for (const ref of preDownloadedRefs) {
              const mime = inferMimeType(ref.filename, ref.bytes);
              const result = await uploadToGeminiFilesAPI(ref.bytes, mime, ref.filename);
              uploaded.push({
                fileUri: result.fileUri,
                displayName: result.displayName,
                mimeType: result.mimeType,
                sizeBytes: result.sizeBytes,
                label: ref.label,
                filename: ref.filename,
              });
            }
            preUploadedGeminiFiles = uploaded;
            console.log(`GEMINI_PRE_UPLOAD_COMPLETE jobId=${job.id} files=${uploaded.length}`);
          } catch (uploadErr) {
            console.warn(
              `GEMINI_PRE_UPLOAD_SKIPPED jobId=${job.id}: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
            );
            // Fall through — processChunk will handle the upload as normal
          }
        }
      } else {
        singlePassFallbackReason = `direct_files_ineligible:${directCheck.reason || "unknown"}`;
      }
    } else if (singlePass && directFilesPreferred && !allowDirectFilesForJob) {
      singlePassFallbackReason = "direct_files_disabled_no_non_instruction_source";
    }

    if (!directFilesMode) {
      const extracted = await extractFiles(supabase, fileRefs, preDownloadedRefs, allowMissingInstruction);
      downloadMs = Math.max(downloadMs, extracted.downloadMs);
      extractMs = extracted.extractMs;
      totalBytes = Math.max(totalBytes, extracted.totalBytes);
      if (singlePass) {
        const single = buildSinglePassChunkFromFiles(extracted.files);
        if (single.chunks.length > 0) {
          chunks = single.chunks;
          singlePassUsed = true;
        } else {
          chunks = buildChunksFromFiles(extracted.files);
          singlePassFallbackReason = single.tooLarge ? "files_exceeded_single_pass_limit" : "files_empty_after_extract";
        }
      } else {
        chunks = buildChunksFromFiles(extracted.files);
      }
    }
  } else if (documentText.trim()) {
    const normalized = normalizeText(documentText);
    if (!normalized) {
      chunks = [];
    } else {
      if (singlePass) {
        if (normalized.length <= SINGLE_PASS_MAX_CHARS) {
          chunks = [{ chunk_type: "text", text: normalized }];
          singlePassUsed = true;
        } else {
          chunks = buildChunksFromText(normalized);
          singlePassFallbackReason = "text_exceeded_single_pass_limit";
        }
      } else {
        chunks = buildChunksFromText(normalized);
      }
    }
  } else if (promptOnlyAllowed) {
    // Prompt-only jobs (for example title/description formatting) must still produce
    // at least one chunk so the pipeline can execute. Use prompt text as chunk input.
    const normalizedPrompt = normalizeText(prompt);
    if (!normalizedPrompt) {
      chunks = [];
    } else if (singlePass) {
      if (normalizedPrompt.length <= SINGLE_PASS_MAX_CHARS) {
        chunks = [{ chunk_type: "text", text: normalizedPrompt }];
        singlePassUsed = true;
      } else {
        chunks = buildChunksFromText(normalizedPrompt);
        singlePassFallbackReason = "prompt_exceeded_single_pass_limit";
      }
    } else {
      chunks = buildChunksFromText(normalizedPrompt);
    }
  }

  if (chunks.length === 0) {
    throw new Error("No chunks could be created from job payload");
  }

  const rows = chunks.map((chunk, idx) => ({
    job_id: job.id,
    chunk_index: idx,
    chunk_type: chunk.chunk_type,
    text: chunk.text,
    status: "queued",
    timing: {
      download_ms: 0,
      extract_ms: 0,
      chunk_count: chunks.length,
      gemini_ms: 0,
      total_ms: 0,
      prompt_chars: prompt.length,
      output_chars: 0,
      retry_count: 0,
      cache_hit: false,
      direct_files_mode: directFilesMode,
      // Store pre-uploaded Gemini file URIs so processChunk can skip the upload
      gemini_file_uris: preUploadedGeminiFiles,
    },
  }));

  const { error } = await supabase.from("ai_job_chunks").insert(rows);

  if (error) {
    // If chunks already exist (race condition from concurrent worker triggers), just use them
    if (error.message?.includes("duplicate key") || error.code === "23505") {
      console.warn(`Chunks already exist for job ${job.id}, using existing chunks`);
      return getChunkCounts(supabase, job.id);
    }
    throw new Error(`Failed to insert chunks: ${error.message}`);
  }

  const mergedTiming = {
    ...(job.timing || {}),
    preflight_at: new Date().toISOString(),
    download_ms: downloadMs,
    extract_ms: extractMs,
    chunk_count: chunks.length,
    total_file_bytes: totalBytes,
    prompt_chars: prompt.length,
    single_pass_requested: singlePass,
    single_pass_used: singlePassUsed,
    single_pass_fallback_reason: singlePassFallbackReason,
    direct_files_mode: directFilesMode,
  };

  await updateJob(supabase, job.id, {
    progress: 10,
    timing: mergedTiming,
  });

  return getChunkCounts(supabase, job.id);
}

function buildChunkPrompt(
  basePrompt: string,
  chunkIndex: number,
  totalChunks: number,
  jsonMode: boolean,
  type: string,
  directFilesMode: boolean,
): string {
  const sourceRule = directFilesMode
    ? "Use attached files (especially instruction-labeled files) as factual source. CHUNK_INPUT below is routing metadata, not product facts."
    : "Use only CHUNK_INPUT as factual source for this chunk.";

  // Lightweight extraction reminder for generate_data jobs — the full mandate is in the system prompt,
  // but repeating the key constraint at chunk level prevents the model from reverting to filter-only output.
  const extractionReminder = (type === "generate_data" && !jsonMode)
    ? "\nREMINDER: Output ALL product data as KEY: VALUE lines (15-30+ lines expected). Do NOT output only filter proposals."
    : "";

  return `${basePrompt}

--- CHUNK EXECUTION CONTEXT ---
Job type: ${type || "generic"}
Chunk: ${chunkIndex + 1} of ${totalChunks}
${sourceRule}${extractionReminder}`;
}

async function fetchWithHardTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let hardTimeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const response = await Promise.race([
      fetch(input, {
        ...init,
        signal: controller.signal,
      }),
      new Promise<Response>((_, reject) => {
        hardTimeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error(`Request timed out after ${timeoutMs}ms`));
        }, timeoutMs + 500);
      }),
    ]);
    return response;
  } finally {
    clearTimeout(timeoutId);
    if (hardTimeoutId !== null) {
      clearTimeout(hardTimeoutId);
    }
  }
}

function buildGeminiRetryDelays(): number[] {
  const delays = [0];
  for (let i = 1; i <= GEMINI_TRANSPORT_MAX_RETRIES; i++) {
    delays.push(Math.min(5000, 500 * 2 ** (i - 1)));
  }
  return delays;
}

function isTransientHttpStatus(status: number): boolean {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("connection reset") ||
    message.includes("connection closed") ||
    message.includes("client error (sendrequest)") ||
    message.includes("network") ||
    message.includes("eof") ||
    message.includes("socket") ||
    message.includes("temporary") ||
    message.includes("unreachable") ||
    message.includes("refused")
  );
}

function isTransportConnectivityMessage(message: string): boolean {
  const text = (message || "").toLowerCase();
  if (!text) return false;
  if (isModelNotFoundErrorText(text)) return false;
  return (
    text.includes("ai connection failed") ||
    text.includes("connection reset") ||
    text.includes("connection closed") ||
    text.includes("sendrequest") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("network") ||
    text.includes("socket") ||
    text.includes("eof") ||
    text.includes("unreachable") ||
    text.includes("refused") ||
    text.includes("generatecontent")
  );
}

function buildConfidenceGateError(reason: string, suggestion: string): string {
  return `LOW_CONFIDENCE_INPUT: ${reason}. ${suggestion}`;
}

function gateChunkTextConfidence(
  type: string,
  prompt: string,
  chunkText: string,
): { ok: true } | { ok: false; error: string } {
  // Admin connectivity checks are synthetic and intentionally lightweight.
  // Do not block them with extraction confidence thresholds.
  if (type === "admin_action") {
    return { ok: true };
  }

  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt.length < 24) {
    return {
      ok: false,
      error: buildConfidenceGateError(
        "Prompt context is too short to produce a reliable result",
        "Use the standard routed prompt and include complete instructions before running AI",
      ),
    };
  }

  const normalizedChunk = chunkText.trim();
  const alphaNumChars = (normalizedChunk.match(/[A-Za-z0-9]/g) || []).length;
  const fieldLikeLines = normalizedChunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z0-9][A-Z0-9 _/&()+.'%:-]{1,120}:\s+\S+/i.test(line)).length;

  if (alphaNumChars < 120) {
    return {
      ok: false,
      error: buildConfidenceGateError(
        "Extracted text is too small/readability is too low",
        "Upload clearer PDFs with selectable text and try again",
      ),
    };
  }

  if (type === "pdf_compare" && fieldLikeLines < 3) {
    return {
      ok: false,
      error: buildConfidenceGateError(
        "Insufficient structured product fields were detected",
        "Use cleaner datasheets for the same product and ensure the PDF text is selectable",
      ),
    };
  }

  return { ok: true };
}

function gateDirectFilesConfidence(
  type: string,
  prompt: string,
  files: DownloadedDirectFileRef[],
): { ok: true } | { ok: false; error: string } {
  if (prompt.trim().length < 24) {
    return {
      ok: false,
      error: buildConfidenceGateError(
        "Prompt context is too short to produce a reliable result",
        "Use the standard routed prompt and include complete instructions before running AI",
      ),
    };
  }

  const nonInstructionFiles = files.filter((file) => !isInstructionLikeFile(file));
  if (type === "pdf_compare" && nonInstructionFiles.length < 2) {
    return {
      ok: false,
      error: buildConfidenceGateError(
        "Missing required comparison source files",
        "Upload both supplier and LS datasheets before running AI",
      ),
    };
  }

  if (type === "generate_data" && nonInstructionFiles.length < 1) {
    return {
      ok: false,
      error: buildConfidenceGateError("Missing source PDF", "Upload at least one datasheet PDF before running AI"),
    };
  }

  const tinyFile = nonInstructionFiles.find((file) => file.bytes.length < 2_000);
  if (tinyFile) {
    return {
      ok: false,
      error: buildConfidenceGateError(
        `File ${tinyFile.filename} is too small to trust extraction quality`,
        "Re-upload a complete PDF export (not screenshot-derived or truncated)",
      ),
    };
  }

  return { ok: true };
}

async function invokeGeminiGenerateWithRetry(
  endpoint: string,
  requestBody: Record<string, unknown>,
  timeoutMs: number,
): Promise<
  { ok: true; responseText: string; attempts: number } | { ok: false; status: number; error: string; attempts: number }
> {
  const retryDelays = buildGeminiRetryDelays();

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt] > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }

    try {
      const response = await fetchWithHardTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        },
        timeoutMs,
      );

      if (response.ok) {
        return {
          ok: true,
          responseText: await response.text(),
          attempts: attempt + 1,
        };
      }

      const text = await response.text();
      const errorMessage = `Gemini API error (${response.status}): ${text || "empty response"}`;

      if (isTransientHttpStatus(response.status) && attempt < retryDelays.length - 1) {
        console.warn(
          `GEMINI_TRANSIENT_HTTP_RETRY status=${response.status} attempt=${attempt + 1}/${retryDelays.length}`,
        );
        continue;
      }

      return {
        ok: false,
        status: response.status,
        error: errorMessage,
        attempts: attempt + 1,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientNetworkError(error) && attempt < retryDelays.length - 1) {
        console.warn(`GEMINI_TRANSIENT_NETWORK_RETRY attempt=${attempt + 1}/${retryDelays.length}: ${message}`);
        continue;
      }

      const isAbort = error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
      return {
        ok: false,
        status: isAbort ? 504 : 500,
        error: isAbort ? "Gemini request timed out" : message || "Unknown Gemini call error",
        attempts: attempt + 1,
      };
    }
  }

  return {
    ok: false,
    status: 500,
    error: "Gemini request failed after retries",
    attempts: retryDelays.length,
  };
}

async function invokeGeminiWithModelFallback(
  requestBody: Record<string, unknown>,
  timeoutMs: number,
): Promise<
  | { ok: true; responseText: string; attempts: number; modelUsed: string }
  | { ok: false; status: number; error: string; attempts: number; modelUsed: string }
> {
  const candidates = getModelCandidates(ENFORCED_MODEL);
  let lastFailure: { ok: false; status: number; error: string; attempts: number; modelUsed: string } | null = null;

  let effectiveBody = requestBody;

  for (const modelName of candidates) {
    const endpoint = `${GOOGLE_AI_BASE}/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    const result = await invokeGeminiGenerateWithRetry(endpoint, effectiveBody, timeoutMs);
    if (result.ok) {
      if (modelName !== ENFORCED_MODEL) {
        console.warn(`AI_MODEL_FALLBACK_USED primary=${ENFORCED_MODEL} fallback=${modelName}`);
      }
      return { ...result, modelUsed: modelName };
    }

    lastFailure = { ok: false as const, status: result.status, error: result.error, attempts: result.attempts, modelUsed: modelName };
    if (result.status === 404 && isModelNotFoundErrorText(result.error)) {
      continue;
    }
    // If the model rejected an unknown field (e.g. thinkingConfig), strip it
    // and retry with the same model before giving up.
    if (result.status === 400 && isUnsupportedFieldError(result.error) && "thinkingConfig" in effectiveBody) {
      console.warn(`STRIP_THINKING_CONFIG model=${modelName} — retrying without thinkingConfig`);
      const { thinkingConfig: _dropped, ...stripped } = effectiveBody;
      effectiveBody = stripped;
      const retryResult = await invokeGeminiGenerateWithRetry(endpoint, effectiveBody, timeoutMs);
      if (retryResult.ok) {
        return { ...retryResult, modelUsed: modelName };
      }
      lastFailure = { ok: false as const, status: retryResult.status, error: retryResult.error, attempts: retryResult.attempts, modelUsed: modelName };
    }
    return lastFailure;
  }

  if (lastFailure) return lastFailure;
  return {
    ok: false,
    status: 500,
    error: "Gemini request failed before attempting any model candidate",
    attempts: 0,
    modelUsed: ENFORCED_MODEL,
  };
}

async function triggerWorker(jobId: string): Promise<void> {
  const bodyText = JSON.stringify({ jobId, trigger: "continuation" });
  const headers = await buildInternalWorkerHeaders(bodyText);

  fetch(AI_WORKER_URL, {
    method: "POST",
    headers,
    body: bodyText,
  }).catch((err) => console.warn("Worker continuation trigger failed:", err));
}

async function callChunkGemini(
  jobId: string,
  chunkIndex: number,
  prompt: string,
  chunkText: string,
  jsonMode: boolean,
  _type: string,
  systemPrompt?: string,
  temperatureOverride?: number,
  strictJson = false,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!GEMINI_API_KEY) {
    return {
      status: 500,
      payload: { success: false, error: "GEMINI_API_KEY environment variable not set" },
    };
  }

  const temperature =
    typeof temperatureOverride === "number" && Number.isFinite(temperatureOverride)
      ? Math.min(2, Math.max(0, temperatureOverride))
      : 0;
  const isJsonAdminAction = jsonMode && _type === "admin_action";
  const effectiveMaxOutputTokens = isJsonAdminAction
    ? Math.min(MAX_OUTPUT_TOKENS, 8192)
    : MAX_OUTPUT_TOKENS;

  const generationConfig: Record<string, unknown> = {
    temperature,
    maxOutputTokens: effectiveMaxOutputTokens,
  };
  if (jsonMode) {
    generationConfig.responseMimeType = "application/json";
    if (_type === "pdf_compare") {
      generationConfig.responseSchema = buildPdfCompareResponseSchema();
    }
  }

  const sysText = buildMultiInstructionSystemPrompt(jsonMode, systemPrompt);

  // Safe fallback: use minimal system instruction if buildMultiInstructionSystemPrompt returns empty
  const effectiveSysText =
    sysText && sysText.trim()
      ? sysText
      : "Follow instructions exactly. Use only provided inputs. Do not add commentary.";

  if (!sysText || !sysText.trim()) {
    console.warn(`AI_WORKER_SYSTEM_PROMPT_FALLBACK jobId=${jobId} chunkIndex=${chunkIndex}`);
  }

  const confidenceGate = gateChunkTextConfidence(_type, prompt, chunkText);
  if (!confidenceGate.ok) {
    return {
      status: 422,
      payload: {
        success: false,
        error: confidenceGate.error,
        statusCode: 422,
        attempts: 0,
      },
    };
  }

  const normalizedPrompt = normalizeText(prompt);
  const normalizedChunkText = normalizeText(chunkText);
  const shouldAttachChunkInput = Boolean(normalizedChunkText) && normalizedChunkText !== normalizedPrompt;
  const contentParts = shouldAttachChunkInput
    ? [{ text: prompt }, { text: `\n\nCHUNK_INPUT:\n${chunkText}` }]
    : [{ text: prompt }];

  const requestBody: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: effectiveSysText }],
    },
    contents: [
      {
        parts: contentParts,
      },
    ],
    generationConfig,
  };
  // Only inject thinkingConfig when the env var is explicitly set AND
  // the model is known to support it (gemini-2.5-*).  Models like
  // gemini-3-flash-preview reject the unknown field with a hard 400.
  if (!isJsonAdminAction && GEMINI_THINKING_BUDGET !== undefined && supportsThinkingConfig(ENFORCED_MODEL)) {
    requestBody.thinkingConfig = { thinkingBudget: GEMINI_THINKING_BUDGET };
  }

  const startedAt = Date.now();

  try {
    const geminiCall = await invokeGeminiWithModelFallback(requestBody, CHUNK_TIMEOUT_MS);

    const geminiMs = Date.now() - startedAt;

    if (!geminiCall.ok) {
      return {
        status: geminiCall.status,
        payload: {
          success: false,
          error: geminiCall.error,
          statusCode: geminiCall.status,
          attempts: geminiCall.attempts,
        },
      };
    }

    const responseText = geminiCall.responseText;
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(responseText);
    } catch (jsonErr) {
      console.warn("Gemini response JSON parse failed, attempting repair:", jsonErr);
      try {
        rawJson = repairAndParseJson(responseText);
      } catch (repairErr) {
        return {
          status: 500,
          payload: {
            success: false,
            error: `Gemini returned truncated response: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
          },
        };
      }
    }
    const rawText = extractGeminiText(rawJson);
    const parsed = parseGeminiOutput(rawText, jsonMode, strictJson);
    const usage = extractUsage(rawJson);
    const totalMs = Date.now() - startedAt;

    return {
      status: 200,
      payload: {
        success: true,
        result: parsed,
        data: parsed,
        usage,
        meta: {
          latencyMs: totalMs,
          model: ENFORCED_MODEL,
          timing: {
            download_ms: 0,
            extract_ms: 0,
            chunk_count: 1,
            gemini_ms: geminiMs,
            total_ms: totalMs,
            prompt_chars: prompt.length + (shouldAttachChunkInput ? chunkText.length : 0),
            output_chars: rawText.length,
            transport_retry_count: Math.max(0, geminiCall.attempts - 1),
          },
        },
      },
    };
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
    return {
      status: isAbort ? 504 : 500,
      payload: {
        success: false,
        error: isAbort
          ? "Gemini chunk call timed out"
          : error instanceof Error
            ? error.message
            : "Unknown Gemini call error",
      },
    };
  }
}

async function callChunkGeminiWithFiles(
  supabase: any,
  jobId: string,
  chunkIndex: number,
  prompt: string,
  jsonMode: boolean,
  payload: Record<string, unknown>,
  preDownloadedFiles?: DownloadedDirectFileRef[],
  preDownloadedMs = 0,
  systemPrompt?: string,
  temperatureOverride?: number,
  strictJson = false,
  supplementalExtractedText?: string,
  preUploadedGeminiFiles?: Array<{ fileUri: string; displayName: string; mimeType: string; sizeBytes: number; label: string; filename: string }>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!GEMINI_API_KEY) {
    return {
      status: 500,
      payload: { success: false, error: "GEMINI_API_KEY environment variable not set" },
    };
  }

  const refs = sanitizeFileRefs(payload.files);
  const configFlags = isPlainObject(payload.configFlags) ? payload.configFlags : {};
  const allowMissingInstruction = isAllowMissingInstructionEnabled(configFlags);
  const disableCache = typeof configFlags.disableCache === "boolean" ? configFlags.disableCache : true;
  if (refs.length === 0 && (!preUploadedGeminiFiles || preUploadedGeminiFiles.length === 0)) {
    return {
      status: 400,
      payload: { success: false, error: "No files available for direct-files mode" },
    };
  }

  const temperature =
    typeof temperatureOverride === "number" && Number.isFinite(temperatureOverride)
      ? Math.min(2, Math.max(0, temperatureOverride))
      : 0;
  const requestType = typeof payload.type === "string" ? payload.type : "";

  const generationConfig: Record<string, unknown> = {
    temperature,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
  if (jsonMode) {
    generationConfig.responseMimeType = "application/json";
    if (requestType === "pdf_compare") {
      generationConfig.responseSchema = buildPdfCompareResponseSchema();
    }
  }

  const extractedTextContext = normalizeText(supplementalExtractedText || "");

  const sysText = buildMultiInstructionSystemPrompt(jsonMode, systemPrompt);
  const effectiveSysText =
    sysText && sysText.trim()
      ? sysText
      : "Follow instructions exactly. Use only provided inputs. Do not add commentary.";

  if (!sysText || !sysText.trim()) {
    console.warn(`AI_WORKER_SYSTEM_PROMPT_FALLBACK_DIRECT jobId=${jobId} chunkIndex=${chunkIndex}`);
  }

  // ── Resolve files: pre-uploaded fast-path OR standard download+upload ──
  let uploadedFiles: GeminiFileUploadResult[] = [];
  let attachmentManifest: string;
  let totalBytes: number;
  let downloadMs = preDownloadedMs;
  const cacheHits: string[] = [];
  const cacheMisses: string[] = [];
  let buildFileReferences: ((forceRefresh?: boolean) => Promise<GeminiFileUploadResult[]>) | null = null;
  let inputFileCount: number;

  if (preUploadedGeminiFiles && preUploadedGeminiFiles.length > 0) {
    // ── Fast path: files already uploaded to Gemini during ensureChunksExist ──
    const ordered = [...preUploadedGeminiFiles].sort((a, b) => {
      const aScore = a.label === "instructions" ? 0 : 1;
      const bScore = b.label === "instructions" ? 0 : 1;
      return aScore !== bScore ? aScore - bScore : 0;
    });

    uploadedFiles = ordered.map((f) => ({
      fileUri: f.fileUri,
      displayName: f.displayName,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
    }));

    attachmentManifest = ordered
      .map(
        (file, idx) =>
          `${idx + 1}. label=${file.label}, filename=${file.filename}, mime=${file.mimeType}, bytes=${file.sizeBytes}`,
      )
      .join("\n");

    totalBytes = ordered.reduce((sum, f) => sum + f.sizeBytes, 0);
    inputFileCount = ordered.length;
    downloadMs = 0;
    console.log(
      `GEMINI_PRE_UPLOADED_FILES_USED jobId=${jobId} chunkIndex=${chunkIndex} files=${uploadedFiles.length}`,
    );
  } else {
    // ── Standard path: download from storage, upload to Gemini Files API ──
    let downloaded: DownloadedDirectFileRef[] = [];
    if (preDownloadedFiles && preDownloadedFiles.length > 0) {
      downloaded = preDownloadedFiles;
    } else {
      const downloadStartedAt = Date.now();
      const downloadResults = await Promise.allSettled(
        refs.map(async (ref) => {
          let cached: Uint8Array | null = null;
          const cacheKey = `${ref.bucket}/${ref.path}`;
          if (!disableCache) {
            cached = getCachedFileBytes(cacheKey);
            if (cached) {
              touchCachedFileBytes(cacheKey);
            }
          }
          const bytes = cached ?? (await downloadFileBytes(supabase, ref.bucket, ref.path));
          if (!disableCache && !cached) setCachedFileBytes(cacheKey, bytes);
          return { ...ref, bytes, mimeType: inferMimeType(ref.filename, bytes) } as DownloadedDirectFileRef;
        }),
      );

      for (let i = 0; i < downloadResults.length; i++) {
        const result = downloadResults[i];
        if (result.status === "fulfilled") {
          downloaded.push(result.value);
          continue;
        }
        const ref = refs[i];
        if (shouldIgnoreMissingInstructionDownload(ref, result.reason, allowMissingInstruction)) {
          console.warn(`AI_OPTIONAL_INSTRUCTION_SKIPPED bucket=${ref.bucket} path=${ref.path} filename=${ref.filename}`);
          continue;
        }
        throw result.reason;
      }
      downloadMs = Date.now() - downloadStartedAt;
    }
    if (downloaded.length === 0) {
      return {
        status: 400,
        payload: { success: false, error: "No files available for direct-files mode" },
      };
    }
    totalBytes = downloaded.reduce((sum, item) => sum + item.bytes.length, 0);

    const unsupported = downloaded.find((f) => !isDirectMimeSupported(f.mimeType));
    if (unsupported) {
      return {
        status: 400,
        payload: {
          success: false,
          error: `Unsupported file type for direct mode: ${unsupported.mimeType} (${unsupported.filename})`,
        },
      };
    }

    const orderedDownloaded = [...downloaded].sort((a, b) => {
      const aScore = a.label === "instructions" ? 0 : 1;
      const bScore = b.label === "instructions" ? 0 : 1;
      if (aScore !== bScore) return aScore - bScore;
      return 0;
    });

    attachmentManifest = orderedDownloaded
      .map(
        (file, idx) =>
          `${idx + 1}. label=${file.label}, filename=${file.filename}, mime=${file.mimeType}, bytes=${file.bytes.length}`,
      )
      .join("\n");
    inputFileCount = orderedDownloaded.length;

    const confidenceGate = gateDirectFilesConfidence(requestType, prompt, orderedDownloaded);
    if (!confidenceGate.ok) {
      return {
        status: 422,
        payload: {
          success: false,
          error: confidenceGate.error,
          statusCode: 422,
          attempts: 0,
        },
      };
    }

    // Upload files to Gemini Files API and use URI references (no base64 payload)
    const uploadStartedAt = Date.now();
    const fileCacheDescriptors: Array<{ cacheKey: string; file: DownloadedDirectFileRef }> = [];

    for (const file of orderedDownloaded) {
      const digest = await sha256HexBytes(file.bytes);
      const cacheKey = `${file.mimeType}|${file.filename}|${digest}`;
      fileCacheDescriptors.push({ cacheKey, file });
    }

    buildFileReferences = async (forceRefresh = false): Promise<GeminiFileUploadResult[]> => {
      const fileRefs: GeminiFileUploadResult[] = [];
      for (const descriptor of fileCacheDescriptors) {
        const { cacheKey, file } = descriptor;
        if (!forceRefresh && !disableCache) {
          const cached = getCachedGeminiFileReference(cacheKey);
          if (cached) {
            cacheHits.push(cacheKey);
            fileRefs.push({
              fileUri: cached.fileUri,
              displayName: cached.displayName,
              mimeType: cached.mimeType,
              sizeBytes: file.bytes.length,
            });
            continue;
          }
        }

        cacheMisses.push(cacheKey);
        const uploaded = await uploadToGeminiFilesAPI(file.bytes, file.mimeType, file.filename);
        if (!disableCache) {
          setCachedGeminiFileReference(cacheKey, {
            fileUri: uploaded.fileUri,
            displayName: uploaded.displayName,
            mimeType: uploaded.mimeType,
          });
        }
        fileRefs.push(uploaded);
      }
      return fileRefs;
    };

    try {
      const uploads = await buildFileReferences(false);
      uploadedFiles.push(...uploads);
    } catch (uploadErr) {
      console.error("GEMINI_FILES_UPLOAD_FAILED:", uploadErr);
      return {
        status: 500,
        payload: {
          success: false,
          error: `File upload to Gemini failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
        },
      };
    }
    const uploadMs = Date.now() - uploadStartedAt;
    console.log(
      `GEMINI_FILES_UPLOAD_COMPLETE: ${uploadedFiles.length} files in ${uploadMs}ms (cache_hits=${cacheHits.length}, cache_misses=${cacheMisses.length})`,
    );
  }

  // ── Build request prompt (shared by both paths) ──
  const requestPrompt = `${prompt}
${
  extractedTextContext
    ? `

--- EXTRACTED_TEXT_CONTEXT ---
${extractedTextContext}`
    : ""
}

--- ATTACHMENTS ---
${attachmentManifest}`;

  const requestBody: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: effectiveSysText }],
    },
    contents: [
      {
        parts: [
          { text: requestPrompt },
          ...uploadedFiles.map((file) => ({
            fileData: {
              mimeType: file.mimeType,
              fileUri: file.fileUri,
            },
          })),
        ],
      },
    ],
    generationConfig,
  };
  if (GEMINI_THINKING_BUDGET !== undefined && supportsThinkingConfig(ENFORCED_MODEL)) {
    requestBody.thinkingConfig = { thinkingBudget: GEMINI_THINKING_BUDGET };
  }

  const startedAt = Date.now();

  try {
    const geminiCall = await invokeGeminiWithModelFallback(requestBody, DIRECT_FILES_TIMEOUT_MS);

    const geminiMs = Date.now() - startedAt;

    if (!geminiCall.ok) {
      if (buildFileReferences && cacheHits.length > 0 && geminiCall.status === 400 && looksLikeStaleGeminiFileUriError(geminiCall.error)) {
        for (const key of cacheHits) invalidateCachedGeminiFileReference(key);

        try {
          const refreshedUploads = await buildFileReferences(true);
          const refreshedBody: Record<string, unknown> = {
            ...requestBody,
            contents: [
              {
                parts: [
                  { text: requestPrompt },
                  ...refreshedUploads.map((file) => ({
                    fileData: {
                      mimeType: file.mimeType,
                      fileUri: file.fileUri,
                    },
                  })),
                ],
              },
            ],
          };

          const retryCall = await invokeGeminiWithModelFallback(refreshedBody, DIRECT_FILES_TIMEOUT_MS);
          if (retryCall.ok) {
            const retryRawJson = (() => {
              try {
                return JSON.parse(retryCall.responseText);
              } catch {
                return repairAndParseJson(retryCall.responseText);
              }
            })();
            const retryRawText = extractGeminiText(retryRawJson);
            const retryParsed = parseGeminiOutput(retryRawText, jsonMode, strictJson);
            const retryUsage = extractUsage(retryRawJson);
            const retryTotalMs = Date.now() - startedAt;

            return {
              status: 200,
              payload: {
                success: true,
                result: retryParsed,
                data: retryParsed,
                usage: retryUsage,
                meta: {
                  latencyMs: retryTotalMs,
                  model: ENFORCED_MODEL,
                  timing: {
                    download_ms: downloadMs,
                    extract_ms: 0,
                    chunk_count: 1,
                    gemini_ms: retryTotalMs,
                    total_ms: retryTotalMs,
                    prompt_chars: requestPrompt.length,
                    output_chars: retryRawText.length,
                    direct_files_mode: true,
                    input_file_count: inputFileCount,
                    input_file_bytes: totalBytes,
                    transport_retry_count: Math.max(0, retryCall.attempts - 1),
                  },
                },
              },
            };
          }
        } catch (refreshErr) {
          console.warn(
            `GEMINI_FILE_URI_REFRESH_FAILED jobId=${jobId} chunkIndex=${chunkIndex}: ${refreshErr instanceof Error ? trimPreview(refreshErr.message, 220) : trimPreview(String(refreshErr), 220)}`,
          );
        }
      }

      return {
        status: geminiCall.status,
        payload: {
          success: false,
          error: geminiCall.error,
          statusCode: geminiCall.status,
          attempts: geminiCall.attempts,
        },
      };
    }
    const responseText = geminiCall.responseText;
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(responseText);
    } catch (jsonErr) {
      console.warn("Gemini direct-files response JSON parse failed, attempting repair:", jsonErr);
      try {
        rawJson = repairAndParseJson(responseText);
      } catch (repairErr) {
        return {
          status: 500,
          payload: {
            success: false,
            error: `Gemini returned truncated response: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
          },
        };
      }
    }
    const rawText = extractGeminiText(rawJson);
    const parsed = parseGeminiOutput(rawText, jsonMode, strictJson);
    const usage = extractUsage(rawJson);
    const totalMs = Date.now() - startedAt;

    return {
      status: 200,
      payload: {
        success: true,
        result: parsed,
        data: parsed,
        usage,
        meta: {
          latencyMs: totalMs,
          model: ENFORCED_MODEL,
          timing: {
            download_ms: downloadMs,
            extract_ms: 0,
            chunk_count: 1,
            gemini_ms: geminiMs,
            total_ms: totalMs,
            prompt_chars: requestPrompt.length,
            output_chars: rawText.length,
            direct_files_mode: true,
            input_file_count: inputFileCount,
            input_file_bytes: totalBytes,
            transport_retry_count: Math.max(0, geminiCall.attempts - 1),
          },
        },
      },
    };
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
    return {
      status: isAbort ? 504 : 500,
      payload: {
        success: false,
        error: isAbort
          ? "Gemini direct-files call timed out"
          : error instanceof Error
            ? error.message
            : "Unknown Gemini direct-files call error",
      },
    };
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>,
): Promise<void> {
  const workers = Array.from({ length: Math.max(1, concurrency) }, async (_, workerIndex) => {
    for (let i = workerIndex; i < items.length; i += concurrency) {
      await handler(items[i]);
    }
  });
  await Promise.all(workers);
}

function normalizeCompareCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeCompareResponseKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeFieldKey(raw: string): string {
  return raw.trim().replace(/[–—]/g, "-").replace(/\s+/g, " ").toUpperCase();
}

const COMPARE_FIELD_LABEL_KEY_SET = new Set([
  "field",
  "attribute",
  "property",
  "spec",
  "specification",
  "item",
  "key",
  "name",
  "label",
].map((key) => normalizeCompareResponseKey(key)));

const COMPARE_SUPPLIER_VALUE_KEY_SET = new Set([
  "supplier",
  "supplier_data",
  "supplier_doc",
  "supplier_document",
  "supplier_extracted",
  "supplier_extraction",
  "supplier_sheet",
  "supplier_text",
  "supplier_raw",
  "supplier_value",
  "supplier_datasheet",
  "supplier_data_sheet",
  "supplier_data_value",
  "supplier_spec",
  "datasheet",
  "datasheet_a",
  "document_a",
  "doc_a",
  "source_a",
  "source_a_value",
  "source_1",
  "a",
  "left",
].map((key) => normalizeCompareResponseKey(key)));

const COMPARE_LS_VALUE_KEY_SET = new Set([
  "ls",
  "ls_data",
  "ls_doc",
  "ls_document",
  "ls_extracted",
  "ls_extraction",
  "ls_sheet",
  "ls_text",
  "ls_raw",
  "ls_value",
  "ls_datasheet",
  "ls_data_sheet",
  "ls_data_value",
  "ls_spec",
  "website",
  "website_value",
  "website_text",
  "website_extracted",
  "lighting_style",
  "lighting_style_value",
  "datasheet_b",
  "document_b",
  "doc_b",
  "source_b",
  "source_b_value",
  "source_2",
  "b",
  "right",
].map((key) => normalizeCompareResponseKey(key)));

const COMPARE_FIELD_ALIASES = new Map<string, string>([
  ["APPLICATION", "APPLICATIONS"],
  ["GLOBE TYPE", "GLOBE"],
  ["LIFE SPAN", "LIFESPAN"],
  ["LED WATTAGE", "WATTAGE"],
  ["POWER", "WATTAGE"],
  ["POWER (W)", "WATTAGE"],
  ["WATTAGE (LED)", "WATTAGE"],
  ["INPUT VOLTAGE", "VOLTAGE"],
  ["IP", "IP RATING"],
  ["CCT", "COLOUR TEMP"],
]);

const ENV_COMPARE_FIELD_ALIASES = (() => {
  const raw = (Deno.env.get("AI_COMPARE_FIELD_ALIASES_JSON") || "").trim();
  if (!raw) return new Map<string, string>();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map<string, string>();
    const out = new Map<string, string>();
    for (const [rawFrom, rawTo] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof rawFrom !== "string" || typeof rawTo !== "string") continue;
      const from = normalizeFieldKey(rawFrom);
      const to = normalizeFieldKey(rawTo);
      if (!from || !to) continue;
      out.set(from, to);
    }
    return out;
  } catch {
    return new Map<string, string>();
  }
})();

for (const [from, to] of ENV_COMPARE_FIELD_ALIASES.entries()) {
  COMPARE_FIELD_ALIASES.set(from, to);
}

const COMPARE_FIELD_STATUS_SUFFIX_RE =
  /\s*(?:\((?:ADDED|DIFFERENT|DIFF|IDENTICAL|EQUIVALENT|MATCH|ONLY IN SUPPLIER|ONLY IN LS)\)|\[(?:ADDED|DIFFERENT|DIFF|IDENTICAL|EQUIVALENT|MATCH|ONLY IN SUPPLIER|ONLY IN LS)\])\s*$/i;
const COMPARE_PLACEHOLDER_RE =
  /^(?:---|N\/A|NA|MISSING(?:\*{3})?(?:\s*\([^)]*\))?|NULL|NONE|UNKNOWN)$/i;

function canonicalizeCompareFieldName(raw: string): string {
  const withoutStatus = raw.replace(COMPARE_FIELD_STATUS_SUFFIX_RE, "").replace(/\s+/g, " ").trim();
  const normalized = normalizeFieldKey(withoutStatus);
  return COMPARE_FIELD_ALIASES.get(normalized) || normalized;
}

const DEFAULT_IGNORED_FIELD_KEYS = new Set<string>(["TIMESTAMP", "UPDATED AT", "LAST UPDATED"]);

const ENV_DEFAULT_IGNORED_FIELD_KEYS = (() => {
  const raw = (Deno.env.get("AI_COMPARE_DEFAULT_IGNORED_FIELDS") || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((item: string) => normalizeFieldKey(item))
    .filter(Boolean);
})();
for (const key of ENV_DEFAULT_IGNORED_FIELD_KEYS) {
  DEFAULT_IGNORED_FIELD_KEYS.add(key);
}

const IGNORED_FIELD_KEY_PATTERNS: RegExp[] = [/^TIMESTAMP$/i, /^(LAST\s+)?UPDATED(\s+AT)?$/i];

function parseIgnoreFieldHintsFromPrompt(prompt: string): Set<string> {
  const out = new Set<string>();
  const text = prompt || "";
  const pattern = /\b(?:omit|ignore|exclude|do not (?:include|output|emit))[^:\n]{0,120}:\s*([^\n]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const segment = match[1] || "";
    const quoted = [...segment.matchAll(/["'`](.{1,80}?)["'`]/g)].map((m) => m[1]);
    const list = segment
      .split(/[,;|]/)
      .map((item) => item.trim())
      .filter(Boolean);
    for (const candidate of [...quoted, ...list]) {
      const cleaned = candidate
        .replace(/^\W+|\W+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!cleaned) continue;
      if (cleaned.split(" ").length > 5) continue;
      if (!/[A-Za-z]/.test(cleaned)) continue;
      out.add(normalizeFieldKey(cleaned));
    }
  }

  return out;
}

function isIgnoredFieldKey(rawKey: string, runtimeIgnored: Set<string>): boolean {
  const key = normalizeFieldKey(rawKey);
  if (!key) return true;
  if (runtimeIgnored.has(key) || DEFAULT_IGNORED_FIELD_KEYS.has(key)) return true;
  return IGNORED_FIELD_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function normalizeComparableScalar(value: string): string {
  return value
    .trim()
    .replace(/[–—]/g, "-")
    .replace(/[×✕]/g, "x")
    .replace(/\s*([;,:|])\s*/g, "$1")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function splitCompositeValues(value: string): string[] {
  if (!/[;\n|]/.test(value)) return [];
  return value
    .split(/[;\n|]/)
    .map((part) => normalizeComparableScalar(part))
    .filter(Boolean);
}

function areEquivalentCompareValues(a: string, b: string): boolean {
  const left = normalizeComparableScalar(a);
  const right = normalizeComparableScalar(b);
  if (left === right) return true;

  const leftParts = splitCompositeValues(left);
  const rightParts = splitCompositeValues(right);
  if (leftParts.length === 0 || rightParts.length === 0) return false;
  if (leftParts.length !== rightParts.length) return false;

  const sortedLeft = [...leftParts].sort();
  const sortedRight = [...rightParts].sort();
  for (let i = 0; i < sortedLeft.length; i++) {
    if (sortedLeft[i] !== sortedRight[i]) return false;
  }
  return true;
}

function normalizeCompareOutputRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeCompareRow(row);
  const out: Record<string, unknown> = {
    field: canonicalizeCompareFieldName(normalized.field),
    supplier: normalized.supplier,
    ls: normalized.ls,
  };
  if (Number.isFinite(Number(row.confidence))) {
    out.confidence = Number(row.confidence);
  }
  return out;
}

type CompareAuditCounts = {
  fields_a: number;
  fields_b: number;
  identical: number;
  equivalent: number;
  different: number;
  added: number;
  ignored: number;
};

function readNonNegativeInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function parseComparisonAudit(value: unknown): CompareAuditCounts | null {
  if (!isPlainObject(value)) return null;
  const fieldsA = readNonNegativeInt(value.fields_a);
  const fieldsB = readNonNegativeInt(value.fields_b);
  const identical = readNonNegativeInt(value.identical);
  const equivalent = readNonNegativeInt(value.equivalent);
  const different = readNonNegativeInt(value.different);
  const added = readNonNegativeInt(value.added);
  const ignored = readNonNegativeInt(value.ignored);
  if (
    fieldsA === null ||
    fieldsB === null ||
    identical === null ||
    equivalent === null ||
    different === null ||
    added === null ||
    ignored === null
  ) {
    return null;
  }
  return {
    fields_a: fieldsA,
    fields_b: fieldsB,
    identical,
    equivalent,
    different,
    added,
    ignored,
  };
}

// synthesizeComparisonAudit removed — use inferComparisonAuditFromRows instead

function mergeComparisonAudits(items: CompareAuditCounts[]): CompareAuditCounts | null {
  if (items.length === 0) return null;
  return items.reduce<CompareAuditCounts>(
    (acc, next) => ({
      fields_a: acc.fields_a + next.fields_a,
      fields_b: acc.fields_b + next.fields_b,
      identical: acc.identical + next.identical,
      equivalent: acc.equivalent + next.equivalent,
      different: acc.different + next.different,
      added: acc.added + next.added,
      ignored: acc.ignored + next.ignored,
    }),
    {
      fields_a: 0,
      fields_b: 0,
      identical: 0,
      equivalent: 0,
      different: 0,
      added: 0,
      ignored: 0,
    },
  );
}

function inferComparisonAuditFromRows(rows: Array<Record<string, unknown>>): CompareAuditCounts {
  let identical = 0;
  let equivalent = 0;
  let different = 0;
  let added = 0;
  let ignored = 0;
  let docAHints = 0;
  let docBHints = 0;

  for (const row of rows) {
    const normalized = normalizeCompareRow(row);
    const field = normalized.field;
    const supplier = normalized.supplier;
    const ls = normalized.ls;
    const supplierMissing = isComparePlaceholder(supplier);
    const lsMissing = isComparePlaceholder(ls);

    if (!supplierMissing) docAHints += 1;
    if (!lsMissing) docBHints += 1;

    if (!field || (supplierMissing && lsMissing)) {
      ignored += 1;
      continue;
    }
    if (supplierMissing !== lsMissing) {
      added += 1;
      continue;
    }

    const left = normalizeComparableScalar(supplier);
    const right = normalizeComparableScalar(ls);
    if (left === right) {
      identical += 1;
      continue;
    }
    if (areEquivalentCompareValues(supplier, ls)) {
      equivalent += 1;
      continue;
    }
    different += 1;
  }

  const classifiedTotal = identical + equivalent + different + added + ignored;
  const hintTotal = docAHints + docBHints;
  const estimatedFieldsA =
    hintTotal > 0
      ? Math.max(0, Math.min(classifiedTotal, Math.round((docAHints / hintTotal) * classifiedTotal)))
      : Math.floor(classifiedTotal / 2);
  const estimatedFieldsB = Math.max(0, classifiedTotal - estimatedFieldsA);
  return {
    // When inventory counts are missing, estimate split from row-side evidence
    // while preserving strict self-consistency with classified totals.
    fields_a: estimatedFieldsA,
    fields_b: estimatedFieldsB,
    identical,
    equivalent,
    different,
    added,
    ignored,
  };
}

function normalizeCompareRow(row: Record<string, unknown>): { field: string; supplier: string; ls: string } {
  const pickBestCompareRowCell = (keySet: Set<string>): string => {
    let best = "";
    for (const [rawKey, rawValue] of Object.entries(row)) {
      if (!keySet.has(normalizeCompareResponseKey(rawKey))) continue;
      const candidate = normalizeCompareCell(rawValue);
      if (!candidate) continue;
      if (!best) {
        best = candidate;
        continue;
      }
      const currentMissing = isComparePlaceholder(best);
      const nextMissing = isComparePlaceholder(candidate);
      if (currentMissing !== nextMissing) {
        if (!nextMissing) best = candidate;
        continue;
      }
      if (candidate.length > best.length) best = candidate;
    }
    return best;
  };

  return {
    field: canonicalizeCompareFieldName(pickBestCompareRowCell(COMPARE_FIELD_LABEL_KEY_SET)),
    supplier: pickBestCompareRowCell(COMPARE_SUPPLIER_VALUE_KEY_SET) || "---",
    ls: pickBestCompareRowCell(COMPARE_LS_VALUE_KEY_SET) || "---",
  };
}

function isComparePlaceholder(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  return !normalized || COMPARE_PLACEHOLDER_RE.test(normalized);
}

function isReportableCompareRow(row: Record<string, unknown>): boolean {
  const normalized = normalizeCompareRow(row);
  const field = normalized.field;
  const supplier = normalized.supplier;
  const ls = normalized.ls;
  const supplierMissing = isComparePlaceholder(supplier);
  const lsMissing = isComparePlaceholder(ls);

  if (!field) return false;
  if (supplierMissing !== lsMissing) return true;
  if (supplierMissing && lsMissing) return false;
  return !areEquivalentCompareValues(supplier, ls);
}

function compareRowSignature(row: Record<string, unknown>): string {
  const normalized = normalizeCompareRow(row);
  return [
    normalized.field.toLowerCase(),
    normalizeComparableScalar(normalized.supplier),
    normalizeComparableScalar(normalized.ls),
  ].join("|");
}

function choosePreferredCompareCell(current: string, next: string): string {
  const currentMissing = isComparePlaceholder(current);
  const nextMissing = isComparePlaceholder(next);
  if (currentMissing !== nextMissing) return nextMissing ? current : next;
  return next.trim().length > current.trim().length ? next : current;
}

function canMergeCompareRows(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const normalizedLeft = normalizeCompareRow(left);
  const normalizedRight = normalizeCompareRow(right);
  if (normalizedLeft.field !== normalizedRight.field) return false;

  const sides: Array<keyof Omit<typeof normalizedLeft, "field">> = ["supplier", "ls"];
  for (const side of sides) {
    const leftValue = normalizedLeft[side];
    const rightValue = normalizedRight[side];
    if (isComparePlaceholder(leftValue) || isComparePlaceholder(rightValue)) continue;
    if (areEquivalentCompareValues(leftValue, rightValue)) continue;
    return false;
  }

  return true;
}

function mergeCompareRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const normalizedRow = normalizeCompareOutputRow(row);
    const signature = compareRowSignature(normalizedRow);
    if (!signature.replace(/\|/g, "").trim()) continue;

    const existing = map.get(signature);
    if (!existing) {
      map.set(signature, normalizedRow);
      continue;
    }

    const oldConfidence = Number(existing.confidence || 0);
    const nextConfidence = Number(normalizedRow.confidence || 0);
    if (nextConfidence > oldConfidence) {
      map.set(signature, normalizedRow);
    }
  }

  const deduped = [...map.values()];
  const mergedByField: Record<string, unknown>[] = [];
  for (const row of deduped) {
    const existing = mergedByField.find((candidate) => canMergeCompareRows(candidate, row));
    if (!existing) {
      mergedByField.push({ ...row });
      continue;
    }

    const normalizedExisting = normalizeCompareRow(existing);
    const normalizedNext = normalizeCompareRow(row);
    existing.field = normalizedExisting.field;
    existing.supplier = choosePreferredCompareCell(normalizedExisting.supplier, normalizedNext.supplier);
    existing.ls = choosePreferredCompareCell(normalizedExisting.ls, normalizedNext.ls);

    const oldConfidence = Number(existing.confidence || 0);
    const nextConfidence = Number(row.confidence || 0);
    if (nextConfidence > oldConfidence) {
      existing.confidence = nextConfidence;
    }
  }

  return mergedByField.sort((a, b) => {
    const left = normalizeCompareRow(a);
    const right = normalizeCompareRow(b);
    const byField = left.field.localeCompare(right.field);
    if (byField !== 0) return byField;
    const bySupplier = normalizeComparableScalar(left.supplier).localeCompare(
      normalizeComparableScalar(right.supplier),
    );
    if (bySupplier !== 0) return bySupplier;
    return normalizeComparableScalar(left.ls).localeCompare(normalizeComparableScalar(right.ls));
  });
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (isPlainObject(value)) return Object.values(value).some(hasMeaningfulValue);
  return false;
}

// Only strip obvious chain-of-thought leakage. Do NOT strip legitimate product
// data phrases like "not mentioned" (could be a valid CONFLICTS entry) or
// "manual says" (could be a spec reference).
const NARRATIVE_LEAK_PATTERNS: RegExp[] = [/^\s*wait\b/i, /\bi will use\b/i, /^\s*i('?| )ll\b/i];

const STRUCTURED_FIELD_LINE_RE = /^[A-Z0-9][A-Z0-9 _/&()+.'%:-]{1,140}:\s+\S+/;

function looksLikeNarrativeLeak(value: string): boolean {
  const normalized = value
    .replace(/^[-*•\d).:\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  return NARRATIVE_LEAK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function shouldSanitizeStructuredText(value: string): boolean {
  if (!value.trim()) return false;
  if (/===\s*[A-Z0-9_\-/ ]+\s*===/.test(value)) return true;
  if (/^\s*VARIANT\s*:/im.test(value)) return true;
  const kvCount = (value.match(/^[^:\n]{2,140}:\s+.+$/gm) || []).length;
  return kvCount >= 3;
}

function sanitizeStructuredTextLeakage(value: string): { output: string; removed: number } {
  const lines = value.split("\n");
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^VARIANT:\s*$/i.test(trimmed)) {
      removed += 1;
      continue;
    }
    // Never strip valid structured field lines; we only remove obvious narrative/meta chatter.
    if (STRUCTURED_FIELD_LINE_RE.test(trimmed) || /^VARIANT:\s+\S+/i.test(trimmed)) {
      kept.push(line);
      continue;
    }
    if (looksLikeNarrativeLeak(line)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  return {
    output: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    removed,
  };
}

function sanitizeCompareRowsLeakage(value: unknown): { output: unknown; removed: number } {
  if (!isPlainObject(value)) return { output: value, removed: 0 };
  const extracted = value.extracted_data;
  if (!Array.isArray(extracted)) return { output: value, removed: 0 };

  const keptRows: unknown[] = [];
  let removed = 0;
  for (const row of extracted) {
    if (!isPlainObject(row)) {
      keptRows.push(row);
      continue;
    }

    const field = typeof row.field === "string" ? row.field : "";
    const supplier = typeof row.supplier === "string" ? row.supplier : "";
    const ls = typeof row.ls === "string" ? row.ls : "";
    const combined = [field, supplier, ls].filter(Boolean).join(" | ");
    if (looksLikeNarrativeLeak(combined)) {
      removed += 1;
      continue;
    }
    keptRows.push(row);
  }

  return {
    output: {
      ...value,
      extracted_data: keptRows,
    },
    removed,
  };
}

function parseSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const regex = /===\s*([A-Za-z0-9_\-/ ]{2,80})\s*===/g;
  const matches = [...text.matchAll(regex)];

  const normalizeSectionHeader = (raw: string): string => {
    const normalized = raw
      .trim()
      .toUpperCase()
      .replace(/[\s\-/]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (normalized === "FILTER_PROPOSAL" || normalized === "FILTER_PROPOSALS") {
      return "FILTERS_PROPOSAL";
    }
    if (normalized === "CONFLICT") {
      return "CONFLICTS";
    }
    return normalized;
  };

  for (let i = 0; i < matches.length; i++) {
    const header = normalizeSectionHeader(matches[i][1]);
    if (!header) continue;
    const start = (matches[i].index || 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index || text.length : text.length;
    const content = text.slice(start, end).trim();
    sections[header] = content;
  }

  return sections;
}

function normalizeResponseGuard(payload: Record<string, unknown>): ResponseGuardConfig {
  const raw = isPlainObject(payload.responseGuard) ? payload.responseGuard : {};
  const seenSections = new Set<string>();
  const requiredSections: string[] = [];
  const sectionSource = Array.isArray(raw.requiredSections) ? raw.requiredSections : [];
  for (const value of sectionSource) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toUpperCase();
    if (!normalized || seenSections.has(normalized)) continue;
    seenSections.add(normalized);
    requiredSections.push(normalized);
  }

  const seenJsonKeys = new Set<string>();
  const requiredJsonKeys: string[] = [];
  const jsonKeySource = Array.isArray(raw.requiredJsonKeys) ? raw.requiredJsonKeys : [];
  for (const value of jsonKeySource) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized || seenJsonKeys.has(normalized)) continue;
    seenJsonKeys.add(normalized);
    requiredJsonKeys.push(normalized);
  }

  const minJsonPropertiesRaw = Number(raw.minJsonProperties ?? 0);
  const minJsonItemsRaw = Number(raw.minJsonItems ?? 0);

  return {
    requiredSections,
    requiredJsonKeys,
    minJsonProperties:
      Number.isFinite(minJsonPropertiesRaw) && minJsonPropertiesRaw > 0 ? Math.floor(minJsonPropertiesRaw) : 0,
    minJsonItems: Number.isFinite(minJsonItemsRaw) && minJsonItemsRaw > 0 ? Math.floor(minJsonItemsRaw) : 0,
  };
}

function defaultSectionContent(section: string): string {
  // Use empty-but-present markers so the UI can distinguish
  // "AI didn't return this section" from "AI explicitly said NONE".
  if (section === "PRODUCT_DATA") return "MISSING: MISSING";
  if (section === "PRODUCT_TITLE") return "MISSING";
  if (section === "PRODUCT_DESCRIPTION") return "MISSING";
  if (section === "CONFLICTS") return "";
  if (section === "FILTERS_PROPOSAL") return "";
  return "";
}

function buildCriticalSectionRetryPrompt(basePrompt: string, attempt: number, failingSections: string[]): string {
  const marker = "[VALIDATION_RETRY_CRITICAL_SECTIONS_V1]";
  if (basePrompt.includes(marker)) return basePrompt;
  const sectionList = failingSections.length > 0 ? failingSections.join(", ") : "PRODUCT_DATA";
  const retryBlock = `

--- VALIDATION RETRY DIRECTIVE ---
${marker}
Retry attempt: ${attempt}
Previous output failed strict validation for: ${sectionList}
Treat this as a formatting/completeness retry only.
Do not introduce new business rules or assumptions.
Follow original source authority:
1) User prompt
2) Attached instruction PDF(s) when present
3) Source files
If wrapper/helper instructions conflict with source authority, follow source authority.
Return only the required output format with no commentary.`;
  return `${basePrompt}${retryBlock}`;
}

function buildCompareJsonRetryPrompt(basePrompt: string, attempt: number, reason: string): string {
  const marker = "[VALIDATION_RETRY_COMPARE_JSON_V1]";
  if (basePrompt.includes(marker)) return basePrompt;
  const retryBlock = `

--- VALIDATION RETRY DIRECTIVE ---
${marker}
Retry attempt: ${attempt}
Previous output failed JSON validation: ${reason}
Re-scan all provided documents. Follow source authority (user prompt first).
Return ONLY valid JSON with: same_product_assessment, extracted_data, comparison_audit.
extracted_data can be [] only when there are genuinely no reportable differences.
No commentary.`;
  return `${basePrompt}${retryBlock}`;
}

// Only strip fields that are clearly meta/narrative leakage, not legitimate product fields.
// Admin prompt decides which fields belong — this only catches chain-of-thought artifacts.
const FORBIDDEN_PRODUCT_DATA_KEYS = new Set(["SKU", "FIELD", "FIELDS"]);

const FORBIDDEN_PRODUCT_DATA_KEY_PATTERNS: RegExp[] = [
  /\bWAIT\b/i,
  /\bFINAL\s+CHECK\b/i,
  /\bTHINK\b/i,
  /\bREASONING\b/i,
  /\bIF\s+THE\s+PRODUCT\b/i,
];

function isLikelyNarrativeProductDataKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  if (!normalized) return true;
  if (normalized.length > 72) return true;
  if (/[.,?!]/.test(normalized)) return true;
  return FORBIDDEN_PRODUCT_DATA_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function canonicalizeProductDataKey(raw: string): string {
  const normalized = normalizeFieldKey(raw);
  return COMPARE_FIELD_ALIASES.get(normalized) || normalized;
}

function normalizeVariantToken(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
}

function extractRequestedVariantFromPrompt(prompt: string): string | null {
  const text = prompt || "";
  const skuMatch = text.match(/(?:^|\n)\s*SKU\s*:\s*([^\n]+)/i);
  if (!skuMatch) return null;
  const sku = skuMatch[1].trim();
  if (!sku || /^unknown$/i.test(sku)) return null;
  return sku;
}

function serializeSections(sectionMap: Record<string, string>): string {
  const preferredOrder = ["PRODUCT_DATA", "PRODUCT_TITLE", "PRODUCT_DESCRIPTION", "CONFLICTS", "FILTERS_PROPOSAL"];
  const headers = [
    ...preferredOrder.filter((h) => Object.prototype.hasOwnProperty.call(sectionMap, h)),
    ...Object.keys(sectionMap).filter((h) => !preferredOrder.includes(h)),
  ];
  return headers
    .map((header) => `===${header}===\n${(sectionMap[header] || "").trim()}`.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function hasNonNoneConflicts(conflictsSection: string): boolean {
  const lines = conflictsSection
    .split("\n")
    .map((line) => line.replace(/^[-*•\s]+/, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return false;

  // Filter out markdown table headers/separators (e.g. "Field | Supplier | LS", "| --- | ---")
  const meaningful = lines.filter((line) => {
    const upper = line.toUpperCase();
    if (upper === "NONE") return false;
    // Pure separator rows: only pipes, dashes, spaces, colons
    if (/^[|\-:\s]+$/.test(line)) return false;
    // Table header row containing generic column headers
    if (/^(FIELD\s*\||\|\s*FIELD)/i.test(line)) return false;
    return true;
  });

  return meaningful.length > 0;
}

function normalizeConflictLine(line: string): string {
  return line.replace(/^[-*•\s]+/, "").trim();
}

function mergeConflictSectionLines(existingSection: string, appendedLines: string[]): string {
  const existing = existingSection
    .split("\n")
    .map((line) => normalizeConflictLine(line))
    .filter((line) => line && line.toUpperCase() !== "NONE");
  const incoming = appendedLines
    .map((line) => normalizeConflictLine(line))
    .filter((line) => line && line.toUpperCase() !== "NONE");

  const merged = [...new Set([...existing, ...incoming])];
  if (merged.length === 0) {
    return existingSection.trim();
  }
  return merged.map((line) => `- ${line}`).join("\n");
}

function normalizeFilterProposalConfidence(raw: string): number {
  const cleaned = raw.trim().replace(/%$/, "").trim();
  if (!cleaned) return 0;

  const fractionMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*\/\s*100$/);
  if (fractionMatch) {
    const value = Number.parseFloat(fractionMatch[1]);
    return Number.isFinite(value) ? Math.round(value) : 0;
  }

  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed > 0 && parsed <= 1) return Math.round(parsed * 100);
  return Math.round(parsed);
}

function isUnavailableProductValue(raw: string): boolean {
  const normalized = raw.trim().replace(/\s+/g, " ").toUpperCase();
  if (!normalized) return true;
  if (normalized === "-" || normalized === "---") return true;

  const exactUnavailable = new Set([
    "MISSING",
    "N/A",
    "NA",
    "NONE",
    "NULL",
    "UNKNOWN",
    "VARIABLE",
    "VARIES",
    "VARIOUS",
    "NOT PROVIDED",
    "NOT AVAILABLE",
    "NOT SPECIFIED",
    "NOT LISTED",
    "NOT STATED",
    "NO DATA",
  ]);
  if (exactUnavailable.has(normalized)) return true;

  return /^MISSING\s*(?:\([^)]*\))?$/.test(normalized);
}

function looksLikeConflictNarrativeValue(raw: string): boolean {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  const patterns = [
    /provided\s+documents?/i,
    /do\s+not\s+match/i,
    /does\s+not\s+match/i,
    /mismatch/i,
    /different\s+product/i,
    /different\s+product\s+famil(y|ies)/i,
    /requested\s+[A-Za-z0-9\-_/]+/i,
    /\bcontradicts?\b/i,
    /\binconsisten(t|cy|cies)\b/i,
    /\bdiscrep(ant|ancy|ancies)\b/i,
    /\bconflict(s|ing)?\b/i,
    /\bdatasheet\b.+\bvs\b.+\bwebsite\b/i,
    /\bwebsite\b.+\bvs\b.+\bdatasheet\b/i,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function parseFilterProposalSection(section: string): Array<{ filterName: string; value: string; confidence: number }> {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts.length >= 3)
    .map((parts) => ({
      filterName: parts[0],
      value: parts[1],
      confidence: normalizeFilterProposalConfidence(parts[2]),
    }));
}

function summarizeFilterProposalConfidences(
  proposals: Array<{ filterName: string; value: string; confidence: number }>,
): {
  total: number;
  missingCount: number;
  nonMissingCount: number;
  exact100Count: number;
  highConfidenceCount: number;
  exact100Ratio: number;
} {
  const nonMissing = proposals.filter((proposal) => proposal.value.trim().toUpperCase() !== "MISSING");
  const exact100Count = nonMissing.filter((proposal) => proposal.confidence >= 100).length;
  const highConfidenceCount = nonMissing.filter((proposal) => proposal.confidence >= 95).length;

  return {
    total: proposals.length,
    missingCount: proposals.length - nonMissing.length,
    nonMissingCount: nonMissing.length,
    exact100Count,
    highConfidenceCount,
    exact100Ratio: nonMissing.length > 0 ? exact100Count / nonMissing.length : 0,
  };
}

function buildProductDataComplianceRetryPrompt(basePrompt: string, attempt: number, reason: string): string {
  const marker = "[VALIDATION_RETRY_PRODUCT_DATA_FORMAT_V1]";
  if (basePrompt.includes(marker)) return basePrompt;
  const retryBlock = `

--- VALIDATION RETRY DIRECTIVE ---
${marker}
Retry attempt: ${attempt}
Previous output failed PRODUCT_DATA compliance: ${reason}
Re-scan source documents. Follow source authority (user prompt first).
Return only the required sections. No commentary.`;
  return `${basePrompt}${retryBlock}`;
}

function normalizeProductDataSection(
  section: string,
  options?: {
    runtimeIgnored?: Set<string>;
    targetVariant?: string | null;
  },
): {
  output: string;
  totalInputLines: number;
  parsedFieldLines: number;
  droppedNonFieldLines: number;
  forbiddenKeysRemoved: string[];
  hasDiscrepancyLine: boolean;
  discrepancyLines: string[];
  hasVariantBlocks: boolean;
  duplicateCanonicalKeysRemoved: number;
  variantsRemoved: number;
} {
  const runtimeIgnored = options?.runtimeIgnored || new Set<string>();
  const targetVariant = options?.targetVariant?.trim() || "";
  const targetVariantToken = targetVariant ? normalizeVariantToken(targetVariant) : "";
  const lines = section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  type Token = { type: "variant"; value: string } | { type: "field"; id: string; key: string };
  const tokens: Token[] = [];
  const seenFieldIds = new Set<string>();
  const fieldValues = new Map<string, string[]>();
  const forbiddenRemoved = new Set<string>();
  let currentVariant = "__GLOBAL__";
  let droppedNonFieldLines = 0;
  let duplicateCanonicalKeysRemoved = 0;
  let variantsRemoved = 0;
  const discrepancyLines: string[] = [];

  for (const rawLine of lines) {
    const cleaned = rawLine
      .replace(/^[-*\u2022]+\s*/, "")
      .replace(/^\d+[).:\s-]+/, "")
      .trim();
    if (!cleaned) continue;

    const variantMatch = cleaned.match(/^VARIANT\s*:\s*(.+)$/i);
    if (variantMatch) {
      const variantValue = variantMatch[1].trim();
      if (variantValue) {
        currentVariant = variantValue;
        tokens.push({ type: "variant", value: variantValue });
      }
      continue;
    }

    let key = "";
    let value = "";

    const kvMatch = cleaned.match(/^([^:]{1,140})\s*:\s*(.+)$/);
    if (kvMatch) {
      key = kvMatch[1].trim().toUpperCase().replace(/\s+/g, " ");
      value = kvMatch[2].trim().replace(/\s+/g, " ");
    } else {
      // Fallback: pipe-delimited table format  "Field | Value1 | Value2"
      const pipeParts = cleaned.split(/\s*\|\s*/);
      if (pipeParts.length >= 2) {
        const rawKey = pipeParts[0].trim().replace(/\s*\((DIFFERENT|ADDED|IDENTICAL|EQUIVALENT|IGNORED)\)\s*/gi, "");
        // Skip header rows (e.g. "Field | Supplier Data Sheet | LS Data Sheet")
        const isHeaderRow =
          /^field$/i.test(rawKey.trim()) || pipeParts.slice(1).some((p) => /data\s*sheet|document|column/i.test(p));
        if (!isHeaderRow) {
          // Pick the first non-empty, non-dash value column
          const rawValue =
            pipeParts
              .slice(1)
              .map((p) => p.trim())
              .find((p) => p && p !== "---" && p !== "-") || "";
          if (rawKey && rawValue) {
            key = rawKey.toUpperCase().replace(/\s+/g, " ");
            value = rawValue.replace(/\s+/g, " ");
          }
        }
      }
    }

    if (!key || !value) {
      droppedNonFieldLines += 1;
      continue;
    }

    if (isUnavailableProductValue(value)) {
      droppedNonFieldLines += 1;
      continue;
    }

    const canonicalKey = canonicalizeProductDataKey(key);

    if (canonicalKey.includes("DISCREPANCY")) {
      discrepancyLines.push(`${canonicalKey}: ${value}`);
      continue;
    }

    if (looksLikeConflictNarrativeValue(value)) {
      discrepancyLines.push(`${canonicalKey}: ${value}`);
      continue;
    }

    if (FORBIDDEN_PRODUCT_DATA_KEYS.has(canonicalKey) || isIgnoredFieldKey(canonicalKey, runtimeIgnored)) {
      forbiddenRemoved.add(key);
      continue;
    }
    if (isLikelyNarrativeProductDataKey(canonicalKey)) {
      forbiddenRemoved.add(key);
      continue;
    }

    const id = `${currentVariant}\u0000${canonicalKey}`;
    if (!seenFieldIds.has(id)) {
      seenFieldIds.add(id);
      tokens.push({ type: "field", id, key: canonicalKey });
      fieldValues.set(id, [value]);
      continue;
    }

    const existing = fieldValues.get(id) || [];
    if (!existing.some((v) => v.toLowerCase() === value.toLowerCase())) {
      existing.push(value);
      fieldValues.set(id, existing);
      duplicateCanonicalKeysRemoved += 1;
    }
  }

  const outputLines: string[] = [];
  let hasDiscrepancyLine = false;
  let hasVariantBlocks = false;
  let parsedFieldLines = 0;
  let activeVariantAllowed = true;
  const hasAnyTargetVariantMatch = targetVariantToken
    ? tokens.some((token) => {
        if (token.type !== "variant") return false;
        const variantToken = normalizeVariantToken(token.value);
        return (
          variantToken.length > 0 &&
          (variantToken.includes(targetVariantToken) || targetVariantToken.includes(variantToken))
        );
      })
    : false;

  for (const token of tokens) {
    if (token.type === "variant") {
      hasVariantBlocks = true;
      if (targetVariantToken && hasAnyTargetVariantMatch) {
        const variantToken = normalizeVariantToken(token.value);
        activeVariantAllowed =
          variantToken.length > 0 &&
          (variantToken.includes(targetVariantToken) || targetVariantToken.includes(variantToken));
        if (!activeVariantAllowed) {
          variantsRemoved += 1;
          continue;
        }
      } else {
        activeVariantAllowed = true;
      }
      outputLines.push(`VARIANT: ${token.value}`);
      continue;
    }
    if (!activeVariantAllowed && !token.id.startsWith("__GLOBAL__\u0000")) {
      continue;
    }
    const values = fieldValues.get(token.id) || [];
    if (values.length === 0) continue;
    parsedFieldLines += 1;
    if (token.key.includes("DISCREPANCY")) hasDiscrepancyLine = true;
    outputLines.push(`${token.key}: ${values.join(";")}`);
  }

  return {
    output: outputLines.join("\n").trim(),
    totalInputLines: lines.length,
    parsedFieldLines,
    droppedNonFieldLines,
    forbiddenKeysRemoved: [...forbiddenRemoved],
    hasDiscrepancyLine: hasDiscrepancyLine || discrepancyLines.length > 0,
    discrepancyLines,
    hasVariantBlocks,
    duplicateCanonicalKeysRemoved,
    variantsRemoved,
  };
}

function extractLooseProductDataLines(
  section: string,
  options?: {
    runtimeIgnored?: Set<string>;
  },
): {
  output: string;
  parsedFieldLines: number;
} {
  const runtimeIgnored = options?.runtimeIgnored || new Set<string>();
  const seenCanonical = new Set<string>();
  const outputLines: string[] = [];

  for (const rawLine of section.split("\n")) {
    const cleaned = rawLine
      .trim()
      .replace(/^[-*\u2022]+\s*/, "")
      .replace(/^\d+[).:\s-]+/, "")
      .trim();
    if (!cleaned) continue;
    if (/^VARIANT\s*:/i.test(cleaned)) continue;

    const kvMatch = cleaned.match(/^([^:]{1,160})\s*:\s*(.+)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1].trim().toUpperCase().replace(/\s+/g, " ");
    const value = kvMatch[2].trim().replace(/\s+/g, " ");
    if (!key || !value) continue;
    if (isUnavailableProductValue(value)) continue;

    const canonicalKey = canonicalizeProductDataKey(key);
    if (!canonicalKey) continue;
    if (canonicalKey.includes("DISCREPANCY")) continue;
    if (looksLikeConflictNarrativeValue(value)) continue;
    if (FORBIDDEN_PRODUCT_DATA_KEYS.has(canonicalKey) || isIgnoredFieldKey(canonicalKey, runtimeIgnored)) {
      continue;
    }
    if (isLikelyNarrativeProductDataKey(canonicalKey)) continue;
    if (seenCanonical.has(canonicalKey)) continue;

    seenCanonical.add(canonicalKey);
    outputLines.push(`${canonicalKey}: ${value}`);
  }

  return {
    output: outputLines.join("\n").trim(),
    parsedFieldLines: outputLines.length,
  };
}

function extractProductDataFromChunkTexts(
  chunks: Array<{ text?: unknown }> | null | undefined,
  options?: {
    runtimeIgnored?: Set<string>;
  },
): {
  output: string;
  parsedFieldLines: number;
} {
  const runtimeIgnored = options?.runtimeIgnored || new Set<string>();
  const seenCanonical = new Set<string>();
  const outputLines: string[] = [];

  const tryAddField = (rawKey: string, rawValue: string) => {
    const key = rawKey.trim().toUpperCase().replace(/\s+/g, " ");
    const value = rawValue.trim().replace(/\s+/g, " ");
    if (!key || !value) return;
    if (value.length > 220) return;
    if (value.split(/\s+/).filter(Boolean).length > 24) return;
    if (/[.!?]/.test(value) && !/\b\d/.test(value)) return;
    if (isUnavailableProductValue(value)) return;

    const canonicalKey = canonicalizeProductDataKey(key);
    if (!canonicalKey) return;
    if (canonicalKey.includes("DISCREPANCY")) return;
    if (looksLikeConflictNarrativeValue(value)) return;
    if (FORBIDDEN_PRODUCT_DATA_KEYS.has(canonicalKey) || isIgnoredFieldKey(canonicalKey, runtimeIgnored)) return;
    if (isLikelyNarrativeProductDataKey(canonicalKey)) return;
    if (seenCanonical.has(canonicalKey)) return;

    seenCanonical.add(canonicalKey);
    outputLines.push(`${canonicalKey}: ${value}`);
  };

  const looksLikeNarrativeSentence = (line: string): boolean => {
    const words = line.trim().split(/\s+/).filter(Boolean).length;
    if (words <= 8) return false;
    if (/[.:;!?]/.test(line) && !/\d/.test(line)) return true;
    return false;
  };

  for (const chunk of chunks || []) {
    const text = typeof chunk?.text === "string" ? chunk.text : "";
    if (!text.trim()) continue;

    for (const rawLine of text.split("\n")) {
      const cleaned = rawLine
        .trim()
        .replace(/^[-*\u2022]+\s*/, "")
        .replace(/^\d+[).:\s-]+/, "")
        .trim();
      if (!cleaned) continue;
      if (/^VARIANT\s*:/i.test(cleaned)) continue;
      if (looksLikeNarrativeSentence(cleaned)) continue;

      const kvMatch = cleaned.match(/^([^:]{1,160})\s*:\s*(.+)$/);
      if (kvMatch) {
        tryAddField(kvMatch[1], kvMatch[2]);
        continue;
      }

      // OCR/table fallback: KEY <2+ spaces or tabs> VALUE
      const spacedMatch = cleaned.match(/^([A-Za-z][A-Za-z0-9 _/&()+.'%-]{1,80})\s{2,}(.{2,200})$/);
      if (spacedMatch) {
        tryAddField(spacedMatch[1], spacedMatch[2]);
        continue;
      }

      const tabParts = cleaned.split(/\t+/).map((part) => part.trim()).filter(Boolean);
      if (tabParts.length >= 2) {
        tryAddField(tabParts[0], tabParts.slice(1).join(" "));
      }
    }
  }

  return {
    output: outputLines.join("\n").trim(),
    parsedFieldLines: outputLines.length,
  };
}

function mergeProductDataFieldLines(
  existingSection: string,
  supplementalSection: string,
  options?: {
    runtimeIgnored?: Set<string>;
  },
): { output: string; addedLines: number; totalLines: number } {
  const runtimeIgnored = options?.runtimeIgnored || new Set<string>();
  const outputLines: string[] = [];
  const seenCanonical = new Set<string>();

  const addLine = (line: string): boolean => {
    const kvMatch = line.match(/^([^:]{1,180})\s*:\s*(.+)$/);
    if (!kvMatch) return false;
    const key = kvMatch[1].trim().toUpperCase().replace(/\s+/g, " ");
    const value = kvMatch[2].trim().replace(/\s+/g, " ");
    if (!key || !value) return false;
    if (isUnavailableProductValue(value)) return false;
    if (value.length > 220) return false;
    if (value.split(/\s+/).filter(Boolean).length > 24) return false;
    if (/[.!?]/.test(value) && !/\b\d/.test(value)) return false;

    const canonicalKey = canonicalizeProductDataKey(key);
    if (!canonicalKey) return false;
    if (canonicalKey.includes("DISCREPANCY")) return false;
    if (looksLikeConflictNarrativeValue(value)) return false;
    if (FORBIDDEN_PRODUCT_DATA_KEYS.has(canonicalKey) || isIgnoredFieldKey(canonicalKey, runtimeIgnored)) return false;
    if (isLikelyNarrativeProductDataKey(canonicalKey)) return false;
    if (seenCanonical.has(canonicalKey)) return false;

    seenCanonical.add(canonicalKey);
    outputLines.push(`${canonicalKey}: ${value}`);
    return true;
  };

  for (const rawLine of existingSection.split("\n")) {
    const cleaned = rawLine.trim();
    if (!cleaned) continue;
    if (/^VARIANT\s*:/i.test(cleaned)) {
      outputLines.push(cleaned);
      continue;
    }
    addLine(cleaned);
  }

  let addedLines = 0;
  for (const rawLine of supplementalSection.split("\n")) {
    const cleaned = rawLine.trim();
    if (!cleaned || /^VARIANT\s*:/i.test(cleaned)) continue;
    if (addLine(cleaned)) addedLines += 1;
  }

  return {
    output: outputLines.join("\n").trim(),
    addedLines,
    totalLines: outputLines.length,
  };
}

function enforceRequiredSections(
  text: string,
  requiredSections: string[],
): {
  output: string;
  recoveryUsed: boolean;
  recoveredSections: string[];
  hadSections: boolean;
} {
  const normalizedText = text.trim();
  if (requiredSections.length === 0) {
    return {
      output: normalizedText,
      recoveryUsed: false,
      recoveredSections: [],
      hadSections: Object.keys(parseSections(normalizedText)).length > 0,
    };
  }

  const parsed = parseSections(normalizedText);
  const hadSections = Object.keys(parsed).length > 0;
  const values: Record<string, string> = {};
  const recoveredSections: string[] = [];

  if (hadSections) {
    for (const [key, value] of Object.entries(parsed)) {
      values[key] = value.trim();
    }
  } else if (normalizedText) {
    // If no explicit sections were returned, preserve the model output as PRODUCT_DATA.
    values.PRODUCT_DATA = normalizedText;
  }

  for (const section of requiredSections) {
    const existing = (values[section] || "").trim();
    if (existing) continue;
    values[section] = defaultSectionContent(section);
    recoveredSections.push(section);
  }

  const orderedHeaders = [...requiredSections, ...Object.keys(values).filter((key) => !requiredSections.includes(key))];
  const uniqueOrdered = [...new Set(orderedHeaders)];
  const blocks = uniqueOrdered
    .map((header) => `===${header}===\n${(values[header] || "").trim()}`.trim())
    .filter(Boolean);
  const output = blocks.join("\n\n").trim();

  return {
    output,
    recoveryUsed: recoveredSections.length > 0 || (!hadSections && normalizedText.length > 0),
    recoveredSections,
    hadSections,
  };
}

function enforceJsonResponseGuard(
  value: unknown,
  guard: ResponseGuardConfig,
): { output: unknown; recoveryUsed: boolean; recoveredKeys: string[] } {
  const base = isPlainObject(value) ? { ...value } : {};
  const recoveredKeys: string[] = [];

  for (const key of guard.requiredJsonKeys) {
    if (Object.prototype.hasOwnProperty.call(base, key)) continue;
    recoveredKeys.push(key);
  }

  // minJsonProperties/minJsonItems are treated as validation hints, not fabrication rules.

  if (guard.minJsonItems > 0) {
    const targetKey = guard.requiredJsonKeys.find((k) => Array.isArray(base[k]));
    if (targetKey && Array.isArray(base[targetKey]) && base[targetKey].length < guard.minJsonItems) {
      // Do not fabricate rows. Keep array as-is to avoid accuracy loss.
    }
  }

  return {
    output: base,
    recoveryUsed: recoveredKeys.length > 0,
    recoveredKeys,
  };
}

function mergeTextResults(texts: string[]): string {
  const parsed = texts.map((t) => ({ raw: t, sections: parseSections(t) }));
  const hasSections = parsed.some((p) => Object.keys(p.sections).length > 0);

  if (!hasSections) {
    return [...texts].sort((a, b) => b.length - a.length)[0] || "";
  }

  const allHeaders = new Set<string>();
  for (const p of parsed) {
    for (const key of Object.keys(p.sections)) allHeaders.add(key);
  }

  const preferredOrder = ["PRODUCT_DATA", "PRODUCT_TITLE", "PRODUCT_DESCRIPTION", "CONFLICTS", "FILTERS_PROPOSAL"];
  const headers = [
    ...preferredOrder.filter((h) => allHeaders.has(h)),
    ...[...allHeaders].filter((h) => !preferredOrder.includes(h)).sort(),
  ];

  const blocks: string[] = [];

  for (const header of headers) {
    const values = parsed
      .map((p) => p.sections[header])
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);

    if (values.length === 0) continue;

    let merged = "";

    if (header === "CONFLICTS") {
      const lines = new Set<string>();
      for (const value of values) {
        for (const line of value.split("\n")) {
          const cleaned = line.replace(/^[-*\s]+/, "").trim();
          if (!cleaned || cleaned.toUpperCase() === "NONE") continue;
          lines.add(cleaned);
        }
      }
      merged = lines.size === 0 ? "- NONE" : [...lines].map((line) => `- ${line}`).join("\n");
    } else if (header === "FILTERS_PROPOSAL") {
      const byFilter = new Map<string, string>();
      for (const value of values) {
        for (const line of value.split("\n")) {
          const cleaned = line.trim();
          if (!cleaned || cleaned.toUpperCase() === "NONE") continue;
          const key = cleaned.split("|")[0]?.trim().toUpperCase() || cleaned.toUpperCase();
          if (!byFilter.has(key)) byFilter.set(key, cleaned);
        }
      }
      merged = byFilter.size === 0 ? "NONE" : [...byFilter.values()].join("\n");
    } else {
      merged = [...values].sort((a, b) => b.length - a.length)[0];
    }

    blocks.push(`===${header}===\n${merged.trim()}`);
  }

  return blocks.join("\n\n").trim();
}

function mergeJsonResults(results: unknown[]): unknown {
  const rows: Array<Record<string, unknown>> = [];
  const objects: Array<Record<string, unknown>> = [];
  const audits: CompareAuditCounts[] = [];

  for (const result of results) {
    if (!isPlainObject(result)) continue;

    const extracted = result.extracted_data;
    if (Array.isArray(extracted)) {
      for (const row of extracted) {
        if (isPlainObject(row)) rows.push(row);
      }
      const remainder: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result)) {
        if (key === "extracted_data") continue;
        remainder[key] = value;
      }
      const parsedAudit = parseComparisonAudit(result.comparison_audit);
      if (parsedAudit) audits.push(parsedAudit);
      if (Object.keys(remainder).length > 0) {
        objects.push(remainder);
      }
      continue;
    }

    const parsedAudit = parseComparisonAudit(result.comparison_audit);
    if (parsedAudit) audits.push(parsedAudit);
    objects.push(result);
  }

  const merged: Record<string, unknown> = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (!hasMeaningfulValue(merged[key]) && hasMeaningfulValue(value)) {
        merged[key] = value;
      }
    }
  }

  if (rows.length > 0) {
    const mergedAudit = mergeComparisonAudits(audits);
    return {
      ...merged,
      extracted_data: mergeCompareRows(rows),
      ...(mergedAudit ? { comparison_audit: mergedAudit } : {}),
    };
  }

  const mergedAudit = mergeComparisonAudits(audits);
  if (mergedAudit) {
    return {
      ...merged,
      comparison_audit: mergedAudit,
    };
  }

  return merged;
}

function getCompareCoverageScore(result: unknown): { inventoryTotal: number; extractedCount: number } {
  if (!isPlainObject(result)) {
    return { inventoryTotal: 0, extractedCount: 0 };
  }

  const extractedData = Array.isArray(result.extracted_data)
    ? result.extracted_data.filter((row) => isPlainObject(row)).length
    : 0;
  const audit = parseComparisonAudit(result.comparison_audit);
  const inventoryTotal = audit ? Math.max(0, audit.fields_a + audit.fields_b) : 0;

  return {
    inventoryTotal,
    extractedCount: extractedData,
  };
}

async function finalizeJob(
  supabase: any,
  job: JobRecord,
  counts: ChunkCounts,
  startedAt: number,
): Promise<FinalizeOutcome> {
  const { data: doneChunks } = await supabase
    .from("ai_job_chunks")
    .select("chunk_index, result, timing")
    .eq("job_id", job.id)
    .eq("status", "done")
    .order("chunk_index", { ascending: true });

  const { data: allChunks } = await supabase
    .from("ai_job_chunks")
    .select("chunk_index, chunk_type, status, latency_ms, error, timing, text, created_at, updated_at")
    .eq("job_id", job.id)
    .order("chunk_index", { ascending: true });

  const payload = isPlainObject(job.request_payload) ? job.request_payload : {};
  const basePrompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const jobType = typeof payload.type === "string" ? payload.type : typeof job.type === "string" ? job.type : "generic";
  const jsonMode = Boolean(payload.jsonMode || payload.mode === "json");
  const responseGuard = normalizeResponseGuard(payload);
  const runtimeIgnoredFieldKeys = parseIgnoreFieldHintsFromPrompt(basePrompt);
  const requestedVariant = extractRequestedVariantFromPrompt(basePrompt);
  const configFlags = isPlainObject(payload.configFlags) ? payload.configFlags : {};
  const requestFiles = Array.isArray(payload.files)
    ? payload.files.filter((file): file is Record<string, unknown> => isPlainObject(file))
    : [];
  const requestFileLabels = requestFiles
    .map((file) =>
      String(file.label || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  const strictSectionValidation =
    typeof configFlags.strictSectionValidation === "boolean" ? configFlags.strictSectionValidation : false;
  const strictTitleValidation =
    typeof configFlags.strictTitleValidation === "boolean" ? configFlags.strictTitleValidation : false;
  const strictDescriptionValidation =
    typeof configFlags.strictDescriptionValidation === "boolean" ? configFlags.strictDescriptionValidation : false;

  const chunkPayloads: unknown[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let geminiMs = 0;

  for (const chunk of doneChunks || []) {
    const chunkResult = isPlainObject(chunk.result) ? chunk.result : {};
    const inner = chunkResult.result ?? chunkResult.data ?? chunk.result;
    chunkPayloads.push(inner);

    if (isPlainObject(chunkResult.usage)) {
      inputTokens += Number(chunkResult.usage.inputTokens || 0);
      outputTokens += Number(chunkResult.usage.outputTokens || 0);
    }

    if (isPlainObject(chunk.timing)) {
      geminiMs += Number(chunk.timing.gemini_ms || 0);
    }
  }

  const mergedRaw = jsonMode
    ? mergeJsonResults(chunkPayloads)
    : mergeTextResults(chunkPayloads.map((v) => toStringSafe(v)).filter(Boolean));
  let sectionRecoveryUsed = false;
  let recoveredSections: string[] = [];
  let jsonRecoveryUsed = false;
  let recoveredJsonKeys: string[] = [];
  let merged = mergedRaw;
  let compareValidationSummary: Record<string, unknown> | null = null;
  let productDataValidationSummary: Record<string, unknown> | null = null;

  if (jsonMode) {
    const enforcedJson = enforceJsonResponseGuard(mergedRaw, responseGuard);
    merged = enforcedJson.output;
    jsonRecoveryUsed = enforcedJson.recoveryUsed;
    recoveredJsonKeys = enforcedJson.recoveredKeys;
  } else {
    const enforced = enforceRequiredSections(toStringSafe(mergedRaw), responseGuard.requiredSections);
    merged = enforced.output;
    sectionRecoveryUsed = enforced.recoveryUsed;
    recoveredSections = enforced.recoveredSections;
  }

  // Always sanitize PRODUCT_DATA narrative leakage for generate_data jobs,
  // even when strict section validation is disabled.
  if (!jsonMode && jobType === "generate_data") {
    const mergedText = toStringSafe(merged);
    const mergedSections = parseSections(mergedText);
    const hasExplicitSections = Object.keys(mergedSections).length > 0;
    const expectsProductDataSection =
      strictSectionValidation || responseGuard.requiredSections.includes("PRODUCT_DATA");
    const productDataRaw = (
      mergedSections.PRODUCT_DATA || (hasExplicitSections || !expectsProductDataSection ? "" : mergedText)
    ).trim();
    if (productDataRaw) {
      const normalizedProductData = normalizeProductDataSection(productDataRaw, {
        runtimeIgnored: runtimeIgnoredFieldKeys,
        targetVariant: requestedVariant,
      });
      productDataValidationSummary = {
        total_input_lines: normalizedProductData.totalInputLines,
        parsed_field_lines: normalizedProductData.parsedFieldLines,
        dropped_non_field_lines: normalizedProductData.droppedNonFieldLines,
        forbidden_keys_removed: normalizedProductData.forbiddenKeysRemoved,
        has_discrepancy_line: normalizedProductData.hasDiscrepancyLine,
        discrepancy_lines_moved: normalizedProductData.discrepancyLines.length,
        has_variant_blocks: normalizedProductData.hasVariantBlocks,
        duplicate_canonical_keys_removed: normalizedProductData.duplicateCanonicalKeysRemoved,
        variants_removed: normalizedProductData.variantsRemoved,
        source_file_labels: requestFileLabels,
      };

      let shouldReserializeSections = false;
      if (hasExplicitSections || responseGuard.requiredSections.length > 0) {
        if (normalizedProductData.output && normalizedProductData.output !== productDataRaw) {
          mergedSections.PRODUCT_DATA = normalizedProductData.output;
          shouldReserializeSections = true;
        }
        if (normalizedProductData.discrepancyLines.length > 0) {
          const mergedConflicts = mergeConflictSectionLines(
            typeof mergedSections.CONFLICTS === "string" ? mergedSections.CONFLICTS : "",
            normalizedProductData.discrepancyLines,
          );
          if (mergedConflicts && mergedConflicts !== (mergedSections.CONFLICTS || "")) {
            mergedSections.CONFLICTS = mergedConflicts;
            shouldReserializeSections = true;
          }
        }
        if (shouldReserializeSections) {
          merged = serializeSections(mergedSections);
        }
      } else if (normalizedProductData.output && normalizedProductData.output !== productDataRaw) {
        // No explicit section contract: still return normalized KEY: VALUE output.
        merged = normalizedProductData.output;
      }
    }
  }

  // Final guard: strip chain-of-thought/manual-check narrative leakage from structured outputs.
  if (jsonMode) {
    const sanitized = sanitizeCompareRowsLeakage(merged);
    if (sanitized.removed > 0) {
      merged = sanitized.output;
      compareValidationSummary = {
        ...(compareValidationSummary || {}),
        narrative_rows_removed: sanitized.removed,
      };
    }
  } else {
    const mergedText = toStringSafe(merged);
    if (shouldSanitizeStructuredText(mergedText)) {
      const sanitized = sanitizeStructuredTextLeakage(mergedText);
      if (sanitized.removed > 0 && sanitized.output) {
        merged = sanitized.output;
        productDataValidationSummary = {
          ...(productDataValidationSummary || {}),
          narrative_lines_removed: sanitized.removed,
        };
      }
    }
  }

  // Helper: purge ai_cache entries for all chunks of this job.
  // Called when finalizeJob detects a validation failure so stale/bad results
  // are not re-served on the next attempt with the same files+prompt.
  const invalidateCacheForJob = async (): Promise<void> => {
    try {
      // Reconstruct cache hashes for each chunk (mirrors processChunk logic)
      const cachePayload = isPlainObject(job.request_payload) ? job.request_payload : {};
      const cacheConfigFlags = isPlainObject(cachePayload.configFlags) ? cachePayload.configFlags : {};
      const cacheDisabled = typeof cacheConfigFlags.disableCache === "boolean" ? cacheConfigFlags.disableCache : true;
      if (cacheDisabled) {
        return;
      }
      const cacheType = typeof cachePayload.type === "string" ? cachePayload.type : job.type;
      const cacheJsonMode = Boolean(cachePayload.jsonMode || cachePayload.mode === "json");
      const cachePrompt = typeof cachePayload.prompt === "string" ? cachePayload.prompt : "";
      const cacheFileRefs = sanitizeFileRefs(cachePayload.files);
      const hashesToDelete = new Set<string>();
      const fileDigestCache = new Map<string, { digest: string; mimeType: string; bytesLength: number }>();

      const getFileDigestMeta = async (ref: {
        bucket: string;
        path: string;
        label: string;
        filename: string;
      }): Promise<{ digest: string; mimeType: string; bytesLength: number }> => {
        const key = `${ref.bucket}/${ref.path}`;
        const cachedMeta = fileDigestCache.get(key);
        if (cachedMeta) return cachedMeta;

        const cachedBytes = getCachedFileBytes(key);
        if (cachedBytes) {
          touchCachedFileBytes(key);
        }
        const bytes = cachedBytes ?? (await downloadFileBytes(supabase, ref.bucket, ref.path));
        if (!cachedBytes) setCachedFileBytes(key, bytes);

        const meta = {
          digest: await sha256HexBytes(bytes),
          mimeType: inferMimeType(ref.filename, bytes),
          bytesLength: bytes.length,
        };
        fileDigestCache.set(key, meta);
        return meta;
      };

      for (const chunk of allChunks || []) {
        const chunkIdx = typeof chunk.chunk_index === "number" ? chunk.chunk_index : 0;
        const chunkText = typeof chunk.text === "string" ? chunk.text : "";
        const chunkTimingObj = isPlainObject(chunk.timing) ? chunk.timing : {};
        const chunkDirect = Boolean(chunkTimingObj.direct_files_mode);
        const totalChunks = counts.total || 1;

        // Rebuild the prompt exactly as processChunk does
        const chunkPrompt = buildChunkPrompt(cachePrompt, chunkIdx, totalChunks, cacheJsonMode, cacheType, chunkDirect);

        // Quick hash (path-based)
        const quickInput = chunkDirect
          ? JSON.stringify({
              model: ENFORCED_MODEL,
              type: cacheType,
              mode: cacheJsonMode ? "json" : "text",
              chunk_index: chunkIdx,
              prompt: chunkPrompt,
              files: cacheFileRefs.map((ref) => `${ref.bucket}/${ref.path}|${ref.label}|${ref.filename}`),
            })
          : [ENFORCED_MODEL, cacheType, cacheJsonMode ? "json" : "text", String(chunkIdx), chunkPrompt, chunkText].join(
              "|",
            );
        hashesToDelete.add(await sha256Hex(quickInput));

        // Direct-files mode also stores a content hash (bytes+digest based).
        // Invalidate both hash paths so failed outputs cannot be re-served.
        if (chunkDirect && cacheFileRefs.length > 0) {
          const orderedForHash = [...cacheFileRefs].sort((a, b) => {
            const aScore = a.label === "instructions" ? 0 : 1;
            const bScore = b.label === "instructions" ? 0 : 1;
            if (aScore !== bScore) return aScore - bScore;
            const filenameDiff = a.filename.localeCompare(b.filename);
            if (filenameDiff !== 0) return filenameDiff;
            return a.path.localeCompare(b.path);
          });
          const contentDigests: string[] = [];
          for (const ref of orderedForHash) {
            const meta = await getFileDigestMeta(ref);
            contentDigests.push(`${ref.label}|${ref.filename}|${meta.mimeType}|${meta.bytesLength}|${meta.digest}`);
          }
          const contentInput = JSON.stringify({
            model: ENFORCED_MODEL,
            type: cacheType,
            mode: cacheJsonMode ? "json" : "text",
            chunk_index: chunkIdx,
            prompt: chunkPrompt,
            files: contentDigests,
          });
          hashesToDelete.add(await sha256Hex(contentInput));
        }
      }

      const hashList = [...hashesToDelete];
      if (hashList.length > 0) {
        const { error: delErr } = await supabase.from("ai_cache").delete().in("hash", hashList);
        if (delErr) {
          console.warn("AI_CACHE_INVALIDATE_FAILED:", delErr.message);
        } else {
          console.log(`AI_CACHE_INVALIDATED: ${hashList.length} entries for job ${job.id}`);
        }
      }
    } catch (err) {
      console.warn("AI_CACHE_INVALIDATE_ERROR:", err);
    }
  };

  const failValidation = async (
    errorMessage: string,
    reason: string,
    extraDebug: Record<string, unknown> = {},
  ): Promise<FinalizeOutcome> => {
    // Purge cached results so the bad output isn't re-served on retry
    await invalidateCacheForJob();
    const totalMs = Date.now() - startedAt;
    const timing = {
      ...(job.timing || {}),
      chunk_count: counts.total,
      chunks_done: counts.done,
      chunks_error: counts.error,
      chunks_cancelled: counts.cancelled,
      gemini_ms: geminiMs,
      total_ms: totalMs,
      output_chars: computeOutputChars(merged),
      failed_at: new Date().toISOString(),
      validation_failed: true,
      validation_failed_reason: reason,
    };

    await updateJob(supabase, job.id, {
      status: "error",
      progress: 0,
      error: errorMessage,
      model_used: ENFORCED_MODEL,
      latency_ms: totalMs,
      timing,
      result: {
        success: false,
        error: errorMessage,
        data: merged,
        result: merged,
        usage: {
          inputTokens,
          outputTokens,
        },
        meta: {
          model: ENFORCED_MODEL,
          chunked: true,
          chunksTotal: counts.total,
          chunksDone: counts.done,
          chunksError: counts.error,
          latencyMs: totalMs,
          debug: {
            worker: "ai-worker",
            finalized_at: new Date().toISOString(),
            chunk_details: (allChunks || []).map((row: unknown) =>
              summarizeChunkForDebug(
                row as {
                  chunk_index?: unknown;
                  chunk_type?: unknown;
                  status?: unknown;
                  latency_ms?: unknown;
                  error?: unknown;
                  timing?: unknown;
                  text?: unknown;
                  created_at?: unknown;
                  updated_at?: unknown;
                },
              ),
            ),
            required_sections: responseGuard.requiredSections,
            required_json_keys: responseGuard.requiredJsonKeys,
            section_recovery_used: sectionRecoveryUsed,
            section_recovered: recoveredSections,
            json_recovery_used: jsonRecoveryUsed,
            json_recovered_keys: recoveredJsonKeys,
            product_data_validation: productDataValidationSummary,
            strict_section_validation: strictSectionValidation,
            strict_title_validation: strictTitleValidation,
            strict_description_validation: strictDescriptionValidation,
            validation_error: errorMessage,
            timing,
            ...extraDebug,
          },
        },
      },
    });
    return { status: "error", reason };
  };

  const queueValidationRetry = async (
    reason: string,
    buildPrompt: (attempt: number, basePrompt: string) => string,
    extraTiming: Record<string, unknown> = {},
    allowAutoRetry = false,
  ): Promise<{ queued: boolean; maxRetries: number; usedRetries: number; skippedByPolicy: boolean }> => {
    const timingObject = isPlainObject(job.timing) ? job.timing : {};
    const usedRetriesRaw = Number(timingObject.validation_retries_used || 0);
    const usedRetries = Number.isFinite(usedRetriesRaw) && usedRetriesRaw > 0 ? Math.floor(usedRetriesRaw) : 0;
    const maxRetriesRaw = Number(payload.maxValidationRetries ?? 0);
    const maxRetries = Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0 ? Math.floor(maxRetriesRaw) : 0;

    if (!allowAutoRetry) {
      return { queued: false, maxRetries, usedRetries, skippedByPolicy: true };
    }

    if (usedRetries >= maxRetries) {
      return { queued: false, maxRetries, usedRetries, skippedByPolicy: false };
    }

    const attempt = usedRetries + 1;
    const basePrompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const retryPrompt = buildPrompt(attempt, basePrompt);
    const nowIso = new Date().toISOString();
    const nextPayload = {
      ...payload,
      prompt: retryPrompt,
    };
    const nextTiming = {
      ...(job.timing || {}),
      validation_retries_used: attempt,
      validation_retry_max: maxRetries,
      validation_retry_last_reason: reason,
      validation_retry_last_at: nowIso,
      ...extraTiming,
    };

    const { error: chunkResetError } = await supabase
      .from("ai_job_chunks")
      .update({
        status: "queued",
        error: null,
        result: null,
        latency_ms: null,
        updated_at: nowIso,
      })
      .eq("job_id", job.id);

    if (chunkResetError) {
      console.error(`Failed to reset chunks for validation retry (${job.id}):`, chunkResetError.message);
      return { queued: false, maxRetries, usedRetries, skippedByPolicy: false };
    }

    const { data: retryJob } = await supabase
      .from("ai_jobs")
      .update({
        status: "queued",
        progress: 5,
        error: null,
        result: null,
        latency_ms: null,
        request_payload: nextPayload,
        timing: nextTiming,
        updated_at: nowIso,
      })
      .eq("id", job.id)
      .in("status", ["queued", "running"])
      .select("id")
      .maybeSingle();

    if (!retryJob) {
      return { queued: false, maxRetries, usedRetries, skippedByPolicy: false };
    }

    await triggerWorker(job.id);
    return { queued: true, maxRetries, usedRetries, skippedByPolicy: false };
  };

  const queueCriticalValidationRetry = async (
    reason: string,
    failingSections: string[],
    options?: { allowProductDataAutoRetry?: boolean },
  ): Promise<{ queued: boolean; maxRetries: number; usedRetries: number; skippedByPolicy: boolean }> => {
    const allowAutoRetry =
      failingSections.length === 1 &&
      (failingSections[0] === "PRODUCT_TITLE" ||
        (failingSections[0] === "PRODUCT_DATA" && options?.allowProductDataAutoRetry === true));

    return await queueValidationRetry(
      reason,
      (attempt, basePrompt) => buildCriticalSectionRetryPrompt(basePrompt, attempt, failingSections),
      {
        validation_retry_last_sections: failingSections,
      },
      allowAutoRetry,
    );
  };

  const queueProductDataValidationRetry = async (
    validationReason: string,
    humanReason: string,
    allowAutoRetry = false,
  ): Promise<{ queued: boolean; maxRetries: number; usedRetries: number; skippedByPolicy: boolean }> => {
    return await queueValidationRetry(
      validationReason,
      (attempt, basePrompt) => buildProductDataComplianceRetryPrompt(basePrompt, attempt, humanReason),
      {
        validation_retry_context: "product_data_compliance",
        validation_retry_last_product_reason: humanReason,
      },
      allowAutoRetry,
    );
  };

  const isCompareLikeJsonJob =
    jsonMode &&
    (jobType === "pdf_compare" || (requestFileLabels.includes("supplier") && requestFileLabels.includes("ls")));

  const queueCompareLikeValidationRetry = async (
    validationReason: string,
    humanReason: string,
  ): Promise<{ queued: boolean; maxRetries: number; usedRetries: number; skippedByPolicy: boolean }> => {
    const shouldAutoRetry = [
      "json_output_empty",
      "json_output_below_minimum_properties",
      "compare_extracted_data_not_array",
      "compare_empty_extracted_data_without_explicit_identical_evidence",
      "compare_missing_required_comparison_audit",
      "compare_invalid_comparison_audit",
      "compare_rows_not_reportable",
      "compare_reportable_rows_below_minimum",
    ].includes(validationReason);

    return await queueValidationRetry(
      validationReason,
      (attempt, basePrompt) => buildCompareJsonRetryPrompt(basePrompt, attempt, humanReason),
      {
        validation_retry_context: "compare_json",
        validation_retry_last_compare_reason: humanReason,
      },
      shouldAutoRetry,
    );
  };

  if (jsonMode && isPlainObject(merged)) {
    const jsonPropertyCount = Object.keys(merged).length;
    const responseGuardDebug = {
      required_json_keys: responseGuard.requiredJsonKeys,
      min_json_properties: responseGuard.minJsonProperties,
      min_json_items: responseGuard.minJsonItems,
    };

    if (jsonPropertyCount === 0) {
      const humanReason =
        "The model returned an empty JSON object. Re-read all provided authority inputs and return a non-empty valid JSON result exactly matching the required compare/output schema.";
      const retryInfo = isCompareLikeJsonJob
        ? await queueCompareLikeValidationRetry("json_output_empty", humanReason)
        : await queueValidationRetry(
            "json_output_empty",
            (attempt, basePrompt) => buildCriticalSectionRetryPrompt(basePrompt, attempt, []),
            { validation_retry_context: "json_output_empty" },
          );
      if (retryInfo.queued) {
        return {
          status: "retry",
          reason: "json_validation_retry_queued",
        };
      }
      return await failValidation("AI returned empty structured output. Please try again.", "json_output_empty", {
        response_guard: responseGuardDebug,
        validation_retry: {
          context: isCompareLikeJsonJob ? "compare_json" : "generic_json",
          used: retryInfo.usedRetries,
          max: retryInfo.maxRetries,
          skipped_by_policy: retryInfo.skippedByPolicy,
        },
      });
    }

    if (responseGuard.minJsonProperties > 0 && jsonPropertyCount < responseGuard.minJsonProperties) {
      const humanReason = `The model returned ${jsonPropertyCount} JSON properties but at least ${responseGuard.minJsonProperties} are required. Return a complete valid JSON result exactly matching the required schema.`;
      const retryInfo = isCompareLikeJsonJob
        ? await queueCompareLikeValidationRetry("json_output_below_minimum_properties", humanReason)
        : await queueValidationRetry(
            "json_output_below_minimum_properties",
            (attempt, basePrompt) => buildCriticalSectionRetryPrompt(basePrompt, attempt, []),
            {
              validation_retry_context: "json_output_below_minimum_properties",
              validation_retry_last_json_property_count: jsonPropertyCount,
            },
          );
      if (retryInfo.queued) {
        return {
          status: "retry",
          reason: "json_validation_retry_queued",
        };
      }
      return await failValidation(
        `AI returned too little structured output (${jsonPropertyCount}/${responseGuard.minJsonProperties} required properties). Please try again.`,
        "json_output_below_minimum_properties",
        {
          response_guard: responseGuardDebug,
          json_property_count: jsonPropertyCount,
          validation_retry: {
            context: isCompareLikeJsonJob ? "compare_json" : "generic_json",
            used: retryInfo.usedRetries,
            max: retryInfo.maxRetries,
            skipped_by_policy: retryInfo.skippedByPolicy,
          },
        },
      );
    }
  }

  if (jsonMode && jobType === "pdf_compare") {
    const queueCompareValidationRetry = queueCompareLikeValidationRetry;

    const mergedObject = isPlainObject(merged) ? merged : {};
    const recoverCompareRowArray = (
      root: Record<string, unknown>,
    ): { rows: Record<string, unknown>[]; sourceKey: string | null; recovered: boolean } => {
      const directKeys = ["extracted_data", "rows", "comparison_rows", "data"];
      for (const key of directKeys) {
        const value = root[key];
        if (!Array.isArray(value)) continue;
        const rows = value.filter((row): row is Record<string, unknown> => isPlainObject(row));
        return { rows, sourceKey: key, recovered: key !== "extracted_data" };
      }

      for (const [key, value] of Object.entries(root)) {
        if (!Array.isArray(value) || value.length === 0) continue;
        const rows = value.filter((row): row is Record<string, unknown> => isPlainObject(row));
        if (rows.length === 0) continue;
        return { rows, sourceKey: key, recovered: key !== "extracted_data" };
      }

      return { rows: [], sourceKey: null, recovered: false };
    };
    const recoveredCompareRows = recoverCompareRowArray(mergedObject);
    const extractedDataValue = Array.isArray(mergedObject.extracted_data)
      ? mergedObject.extracted_data
      : recoveredCompareRows.sourceKey
        ? recoveredCompareRows.rows
        : mergedObject.extracted_data;
    let comparisonAudit = parseComparisonAudit(mergedObject.comparison_audit);
    let comparisonAuditFallbackUsed = false;
    let comparisonAuditFallbackReason: string | null = null;
    const extractedDataRowsRaw = Array.isArray(extractedDataValue)
      ? extractedDataValue.filter((row): row is Record<string, unknown> => isPlainObject(row))
      : [];
    const ignoredRows = extractedDataRowsRaw.filter((row) =>
      isIgnoredFieldKey(String(row.field || ""), runtimeIgnoredFieldKeys),
    );
    const extractedDataRows = mergeCompareRows(
      extractedDataRowsRaw
        .filter((row) => !isIgnoredFieldKey(String(row.field || ""), runtimeIgnoredFieldKeys))
        .map((row) => normalizeCompareOutputRow(row)),
    );
    const reportableRows = extractedDataRows.filter((row) => isReportableCompareRow(row));

    const applyFallbackComparisonAudit = (reason: string): CompareAuditCounts => {
      const fallbackAudit = inferComparisonAuditFromRows(extractedDataRows);
      mergedObject.comparison_audit = fallbackAudit;
      merged = mergedObject;
      comparisonAudit = fallbackAudit;
      comparisonAuditFallbackUsed = true;
      comparisonAuditFallbackReason = reason;
      return fallbackAudit;
    };

    if (Array.isArray(extractedDataValue)) {
      mergedObject.extracted_data = extractedDataRows;
      merged = mergedObject;
    }

    compareValidationSummary = {
      extracted_rows_total_raw: extractedDataRowsRaw.length,
      extracted_rows_ignored_removed: ignoredRows.length,
      extracted_rows_total: extractedDataRows.length,
      extracted_rows_reportable: reportableRows.length,
      recovered_extracted_data: recoveredJsonKeys.includes("extracted_data") || recoveredCompareRows.recovered,
      extracted_data_source_key: recoveredCompareRows.sourceKey,
      recovered_comparison_audit: recoveredJsonKeys.includes("comparison_audit"),
      min_json_items_required: responseGuard.minJsonItems,
      comparison_audit: comparisonAudit,
      comparison_audit_fallback_used: comparisonAuditFallbackUsed,
      comparison_audit_fallback_reason: comparisonAuditFallbackReason,
    };

    if (recoveredJsonKeys.includes("extracted_data")) {
      // If extracted_data was missing from the model output, it could mean:
      // (a) The model couldn't parse the PDFs at all, OR
      // (b) The documents are identical and the model returned no differences.
      // Accept case (b) — treat empty extracted_data as "documents identical".
      // Only fail if we also have no reportable rows AND the audit shows zero fields processed.
      const auditFieldsTotal = comparisonAudit ? (comparisonAudit.fields_a || 0) + (comparisonAudit.fields_b || 0) : 0;
      const hasAnyData = extractedDataRows.length > 0 || auditFieldsTotal > 0;
      const sameProductAssessment = isPlainObject(mergedObject.same_product_assessment)
        ? mergedObject.same_product_assessment as Record<string, unknown>
        : null;
      const sameProductFlag = sameProductAssessment?.same_product === true;
      const sameProductConfidence = Number(sameProductAssessment?.confidence);
      const sameProductReason =
        typeof sameProductAssessment?.reason === "string" ? sameProductAssessment.reason : "";
      const explicitNoDifferenceReason =
        /\b(no\s+(material\s+)?(differences?|conflicts?)|identical|same\s+product)\b/i.test(sameProductReason);

      if (!hasAnyData) {
        const allowEmptyAsIdentical =
          sameProductFlag && Number.isFinite(sameProductConfidence) && sameProductConfidence >= 80 && explicitNoDifferenceReason;

        if (allowEmptyAsIdentical) {
          console.log("COMPARE_VALIDATION: extracted_data recovered as empty — accepted due to explicit high-confidence same_product_assessment");
          mergedObject.extracted_data = [];
          mergedObject.comparison_audit = {
            identical: 0,
            equivalent: 0,
            different: 0,
            added: 0,
            ignored: 0,
            fields_a: 0,
            fields_b: 0,
          };
          merged = mergedObject;
        } else {
          const retryInfo = await queueCompareValidationRetry(
            "compare_empty_extracted_data_without_explicit_identical_evidence",
            "extracted_data was empty without explicit high-confidence same_product_assessment evidence",
          );
          if (retryInfo.queued) {
            return {
              status: "retry",
              reason: "compare_validation_retry_queued",
            };
          }
          return await failValidation(
            "Compare output was empty and lacked explicit high-confidence identical-document evidence.",
            "compare_empty_extracted_data_without_explicit_identical_evidence",
            {
              compare_validation: {
                ...compareValidationSummary,
                same_product_assessment: sameProductAssessment,
              },
              validation_retry: {
                queued: false,
                used: retryInfo.usedRetries,
                max: retryInfo.maxRetries,
                skipped_by_policy: retryInfo.skippedByPolicy,
              },
            },
          );
        }
      }
    }

    if (recoveredJsonKeys.includes("comparison_audit")) {
      const retryInfo = await queueCompareValidationRetry(
        "compare_missing_required_comparison_audit",
        "missing required key: comparison_audit",
      );
      if (retryInfo.queued) {
        return {
          status: "retry",
          reason: "compare_validation_retry_queued",
        };
      }
      comparisonAudit = applyFallbackComparisonAudit("missing required key: comparison_audit");
      compareValidationSummary = {
        ...(compareValidationSummary || {}),
        comparison_audit: comparisonAudit,
        comparison_audit_fallback_used: comparisonAuditFallbackUsed,
        comparison_audit_fallback_reason: comparisonAuditFallbackReason,
      };
    }

    if (!Array.isArray(extractedDataValue)) {
      const auditFieldsTotal = comparisonAudit ? (comparisonAudit.fields_a || 0) + (comparisonAudit.fields_b || 0) : 0;
      if (recoveredCompareRows.sourceKey || auditFieldsTotal > 0) {
        mergedObject.extracted_data = extractedDataRows;
        merged = mergedObject;
        compareValidationSummary = {
          ...(compareValidationSummary || {}),
          extracted_rows_total_raw: extractedDataRowsRaw.length,
          extracted_rows_total: extractedDataRows.length,
          extracted_rows_reportable: reportableRows.length,
          recovered_extracted_data: true,
          extracted_data_source_key: recoveredCompareRows.sourceKey ?? "inferred-empty",
        };
      } else {
        const retryInfo = await queueCompareValidationRetry(
          "compare_extracted_data_not_array",
          "extracted_data was not an array",
        );
        if (retryInfo.queued) {
          return {
            status: "retry",
            reason: "compare_validation_retry_queued",
          };
        }
        return await failValidation(
          "The AI returned an unexpected format when comparing documents. This can happen with complex or unusual PDFs. Please try again — if the issue persists, check that both files are standard product datasheets.",
          "compare_extracted_data_not_array",
          {
            compare_validation: {
              ...compareValidationSummary,
              extracted_data_type: typeof extractedDataValue,
            },
            validation_retry: {
              queued: false,
              used: retryInfo.usedRetries,
              max: retryInfo.maxRetries,
            },
          },
        );
      }
    }

    if (!comparisonAudit) {
      const retryInfo = await queueCompareValidationRetry(
        "compare_invalid_comparison_audit",
        "comparison_audit missing required numeric counts",
      );
      if (retryInfo.queued) {
        return {
          status: "retry",
          reason: "compare_validation_retry_queued",
        };
      }
      comparisonAudit = applyFallbackComparisonAudit("comparison_audit missing required numeric counts");
      compareValidationSummary = {
        ...(compareValidationSummary || {}),
        comparison_audit: comparisonAudit,
        comparison_audit_fallback_used: comparisonAuditFallbackUsed,
        comparison_audit_fallback_reason: comparisonAuditFallbackReason,
      };
    }

    if (!comparisonAudit) {
      return await failValidation(
        "comparison_audit was missing or invalid and could not be inferred.",
        "compare_invalid_comparison_audit",
        {
          compare_validation: compareValidationSummary,
        },
      );
    }

    const classifiedTotal =
      comparisonAudit.identical +
      comparisonAudit.equivalent +
      comparisonAudit.different +
      comparisonAudit.added +
      comparisonAudit.ignored;
    const inventoryTotal = comparisonAudit.fields_a + comparisonAudit.fields_b;
    if (classifiedTotal !== inventoryTotal) {
      // Auto-correct the audit from actual extracted data instead of expensive Gemini retry.
      // The extracted_data rows are ground truth; the model just miscounted in the audit summary.
      console.warn(
        `Audit totals mismatch (${classifiedTotal}/${inventoryTotal}), auto-correcting from extracted_data rows`,
      );
      comparisonAudit = applyFallbackComparisonAudit(
        `audit totals mismatch auto-corrected (${classifiedTotal}/${inventoryTotal})`,
      );
      comparisonAuditFallbackUsed = true;
      compareValidationSummary = {
        ...(compareValidationSummary || {}),
        comparison_audit: comparisonAudit,
        comparison_audit_fallback_used: true,
        comparison_audit_fallback_reason: `audit totals mismatch auto-corrected (${classifiedTotal}/${inventoryTotal})`,
      };
    }

    if (extractedDataRows.length > 0 && reportableRows.length === 0) {
      const retryInfo = await queueCompareValidationRetry(
        "compare_rows_not_reportable",
        "rows were present but none were reportable after normalization",
      );
      if (retryInfo.queued) {
        return {
          status: "retry",
          reason: "compare_validation_retry_queued",
        };
      }
      return await failValidation(
        "Compare output contained rows but none were reportable after normalization",
        "compare_rows_not_reportable",
        {
          compare_validation: compareValidationSummary,
          validation_retry: {
            queued: false,
            used: retryInfo.usedRetries,
            max: retryInfo.maxRetries,
          },
        },
      );
    }

    if (responseGuard.minJsonItems > 0 && reportableRows.length < responseGuard.minJsonItems) {
      const retryInfo = await queueCompareValidationRetry(
        "compare_reportable_rows_below_minimum",
        `reportable rows below minimum (${reportableRows.length}/${responseGuard.minJsonItems})`,
      );
      if (retryInfo.queued) {
        return {
          status: "retry",
          reason: "compare_validation_retry_queued",
        };
      }
      return await failValidation(
        `Compare output returned ${reportableRows.length} reportable row(s), below required minimum ${responseGuard.minJsonItems}`,
        "compare_reportable_rows_below_minimum",
        {
          compare_validation: compareValidationSummary,
          validation_retry: {
            queued: false,
            used: retryInfo.usedRetries,
            max: retryInfo.maxRetries,
          },
        },
      );
    }
  }

  const shouldValidateCriticalSections =
    !jsonMode &&
    strictSectionValidation &&
    responseGuard.requiredSections.some(
      (section) => section === "PRODUCT_DATA" || (strictTitleValidation && section === "PRODUCT_TITLE") || (strictDescriptionValidation && section === "PRODUCT_DESCRIPTION"),
    );

  if (shouldValidateCriticalSections) {
    const mergedText = toStringSafe(merged);
    const mergedSections = parseSections(mergedText);
    const recoveredCritical = recoveredSections.filter(
      (section) => section === "PRODUCT_DATA" || (strictTitleValidation && section === "PRODUCT_TITLE") || (strictDescriptionValidation && section === "PRODUCT_DESCRIPTION"),
    );
    const titleValue = (mergedSections.PRODUCT_TITLE || "").split("\n")[0]?.trim() || "";
    const descriptionValue = (mergedSections.PRODUCT_DESCRIPTION || "").trim();
    let productDataValue = (mergedSections.PRODUCT_DATA || "").trim();

    if (jobType === "generate_data") {
      const productDataValueBeforeNormalization = productDataValue;
      const normalizedProductData = normalizeProductDataSection(productDataValue, {
        runtimeIgnored: runtimeIgnoredFieldKeys,
        targetVariant: requestedVariant,
      });
      productDataValidationSummary = {
        total_input_lines: normalizedProductData.totalInputLines,
        parsed_field_lines: normalizedProductData.parsedFieldLines,
        dropped_non_field_lines: normalizedProductData.droppedNonFieldLines,
        forbidden_keys_removed: normalizedProductData.forbiddenKeysRemoved,
        has_discrepancy_line: normalizedProductData.hasDiscrepancyLine,
        discrepancy_lines_moved: normalizedProductData.discrepancyLines.length,
        has_variant_blocks: normalizedProductData.hasVariantBlocks,
        duplicate_canonical_keys_removed: normalizedProductData.duplicateCanonicalKeysRemoved,
        variants_removed: normalizedProductData.variantsRemoved,
      };

      if (normalizedProductData.discrepancyLines.length > 0) {
        const mergedConflicts = mergeConflictSectionLines(
          typeof mergedSections.CONFLICTS === "string" ? mergedSections.CONFLICTS : "",
          normalizedProductData.discrepancyLines,
        );
        if (mergedConflicts && mergedConflicts !== (mergedSections.CONFLICTS || "")) {
          mergedSections.CONFLICTS = mergedConflicts;
          merged = serializeSections(mergedSections);
        }
      }

      if (normalizedProductData.output && normalizedProductData.output !== productDataValue) {
        mergedSections.PRODUCT_DATA = normalizedProductData.output;
        merged = serializeSections(mergedSections);
        productDataValue = normalizedProductData.output;
      }

      if (normalizedProductData.parsedFieldLines === 0) {
        const looseProductData = extractLooseProductDataLines(productDataValueBeforeNormalization, {
          runtimeIgnored: runtimeIgnoredFieldKeys,
        });
        if (looseProductData.parsedFieldLines >= 3) {
          mergedSections.PRODUCT_DATA = looseProductData.output;
          merged = serializeSections(mergedSections);
          productDataValue = looseProductData.output;
          productDataValidationSummary = {
            ...(productDataValidationSummary || {}),
            loose_fallback_used: true,
            loose_fallback_field_lines: looseProductData.parsedFieldLines,
          };
        }
      }

      if (normalizedProductData.parsedFieldLines === 0 && !productDataValue) {
        const chunkTextFallback = extractProductDataFromChunkTexts(
          (allChunks || []) as Array<{ text?: unknown }>,
          {
            runtimeIgnored: runtimeIgnoredFieldKeys,
          },
        );
        if (chunkTextFallback.parsedFieldLines >= 4) {
          mergedSections.PRODUCT_DATA = chunkTextFallback.output;
          merged = serializeSections(mergedSections);
          productDataValue = chunkTextFallback.output;
          productDataValidationSummary = {
            ...(productDataValidationSummary || {}),
            chunk_text_fallback_used: true,
            chunk_text_fallback_field_lines: chunkTextFallback.parsedFieldLines,
          };
        }
      }

      const chunkTextSupplement = extractProductDataFromChunkTexts(
        (allChunks || []) as Array<{ text?: unknown }>,
        {
          runtimeIgnored: runtimeIgnoredFieldKeys,
        },
      );
      if (productDataValue && chunkTextSupplement.parsedFieldLines > 0) {
        const mergedProductData = mergeProductDataFieldLines(productDataValue, chunkTextSupplement.output, {
          runtimeIgnored: runtimeIgnoredFieldKeys,
        });
        if (mergedProductData.addedLines > 0) {
          mergedSections.PRODUCT_DATA = mergedProductData.output;
          merged = serializeSections(mergedSections);
          productDataValue = mergedProductData.output;
          productDataValidationSummary = {
            ...(productDataValidationSummary || {}),
            chunk_text_supplement_scanned: true,
            chunk_text_supplement_candidates: chunkTextSupplement.parsedFieldLines,
            chunk_text_supplement_added_lines: mergedProductData.addedLines,
            product_data_total_field_lines_after_supplement: mergedProductData.totalLines,
          };
        }
      }

      if (productDataValue) {
        const aliasDedupedProductData = dedupeEquivalentProductDataAliases(productDataValue);
        if (aliasDedupedProductData.output && aliasDedupedProductData.output !== productDataValue) {
          mergedSections.PRODUCT_DATA = aliasDedupedProductData.output;
          merged = serializeSections(mergedSections);
          productDataValue = aliasDedupedProductData.output;
        }
        if (aliasDedupedProductData.removedLineCount > 0) {
          productDataValidationSummary = {
            ...(productDataValidationSummary || {}),
            equivalent_alias_lines_removed: aliasDedupedProductData.removedLineCount,
          };
        }
      }

      if (normalizedProductData.parsedFieldLines === 0 && !productDataValue) {
        const hasSubstantialStructuredCandidate =
          normalizedProductData.totalInputLines >= 3 &&
          productDataValueBeforeNormalization.length >= 80 &&
          !/^MISSING\s*:\s*MISSING$/i.test(productDataValueBeforeNormalization);
        const retryInfo = await queueProductDataValidationRetry(
          "product_data_no_valid_field_lines",
          "PRODUCT_DATA had no valid KEY: VALUE lines after normalization",
          hasSubstantialStructuredCandidate,
        );
        if (retryInfo.queued) {
          return {
            status: "retry",
            reason: "product_data_validation_retry_queued",
          };
        }
        return await failValidation(
          "PRODUCT_DATA did not contain valid KEY: VALUE lines",
          "product_data_no_valid_field_lines",
          {
            validation_retry: {
              queued: false,
              used: retryInfo.usedRetries,
              max: retryInfo.maxRetries,
              skipped_by_policy: retryInfo.skippedByPolicy,
              confidence_gate_passed: hasSubstantialStructuredCandidate,
            },
          },
        );
      }

      const conflictsValue = (mergedSections.CONFLICTS || "").trim();
      const filterProposalSummary = summarizeFilterProposalConfidences(
        parseFilterProposalSection((mergedSections.FILTERS_PROPOSAL || "").trim()),
      );
      const isTwoSourceProductCompare =
        requestFileLabels.includes("datasheet") && requestFileLabels.includes("website");
      const suspiciousAllVeryHighConfidence =
        filterProposalSummary.nonMissingCount >= 6 &&
        filterProposalSummary.highConfidenceCount === filterProposalSummary.nonMissingCount;
      const suspiciousNoConflictOverconfidence =
        isTwoSourceProductCompare &&
        !hasNonNoneConflicts(conflictsValue) &&
        filterProposalSummary.nonMissingCount >= 4 &&
        (filterProposalSummary.exact100Count === filterProposalSummary.nonMissingCount ||
          (filterProposalSummary.exact100Count >= 5 && filterProposalSummary.exact100Ratio >= 0.8) ||
          suspiciousAllVeryHighConfidence);

      productDataValidationSummary = {
        ...(productDataValidationSummary || {}),
        filter_confidence_summary: filterProposalSummary,
        is_two_source_compare: isTwoSourceProductCompare,
        suspicious_no_conflict_overconfidence: suspiciousNoConflictOverconfidence,
      };

      if (suspiciousNoConflictOverconfidence) {
        const retryInfo = await queueProductDataValidationRetry(
          "two_source_no_conflicts_with_overconfident_filters",
          `Two-source generate_data output reported no conflicts while ${filterProposalSummary.exact100Count}/${filterProposalSummary.nonMissingCount} non-missing filters were scored 100 confidence and ${filterProposalSummary.highConfidenceCount}/${filterProposalSummary.nonMissingCount} were scored 95+ confidence. Re-check cross-document conflicts and confidence realism.`,
          false,
        );
        if (retryInfo.queued) {
          return {
            status: "retry",
            reason: "product_data_validation_retry_queued",
          };
        }
        // Do not hard-fail the job after retry budget is exhausted.
        // This guard is heuristic and can produce false positives on genuinely
        // well-aligned two-source documents with many explicit fields.
        productDataValidationSummary = {
          ...(productDataValidationSummary || {}),
          conflict_plausibility_warning: true,
          conflict_plausibility_warning_reason: "two_source_no_conflicts_with_overconfident_filters",
          validation_retry: {
            queued: false,
            used: retryInfo.usedRetries,
            max: retryInfo.maxRetries,
            skipped_by_policy: retryInfo.skippedByPolicy,
          },
        };
      }

      if (hasNonNoneConflicts(conflictsValue) && !normalizedProductData.hasDiscrepancyLine) {
        // Non-blocking: conflicts are already surfaced via ===CONFLICTS=== and UI conflict panel.
        // Missing a dedicated discrepancy line in PRODUCT_DATA should not fail the whole job.
        productDataValidationSummary = {
          ...(productDataValidationSummary || {}),
          missing_discrepancy_line: true,
        };
      }
    }

    const hasDataPlaceholder = /^MISSING\s*:\s*MISSING$/i.test(productDataValue);
    const missingCriticalSections: string[] = [];
    if (!productDataValue || hasDataPlaceholder) missingCriticalSections.push("PRODUCT_DATA");
    if (strictTitleValidation && !titleValue) missingCriticalSections.push("PRODUCT_TITLE");
    if (strictDescriptionValidation && !descriptionValue) missingCriticalSections.push("PRODUCT_DESCRIPTION");

    if (recoveredCritical.length > 0 || missingCriticalSections.length > 0) {
      const failingSections = [...new Set([...recoveredCritical, ...missingCriticalSections])];
      const isProductDataPlaceholderFailure = failingSections.length === 1 && failingSections[0] === "PRODUCT_DATA";
      const productDataParsedFieldLines = Number(productDataValidationSummary?.parsed_field_lines || 0);
      const productDataLooseFallbackFieldLines = Number(productDataValidationSummary?.loose_fallback_field_lines || 0);
      const productDataTotalInputLines = Number(productDataValidationSummary?.total_input_lines || 0);
      const hasSubstantialProductDataRetryCandidate =
        productDataParsedFieldLines >= 2 ||
        productDataLooseFallbackFieldLines >= 3 ||
        (!hasDataPlaceholder && productDataValue.length >= 120 && productDataTotalInputLines >= 5);
      const hasDatasheetAndWebsite = requestFileLabels.includes("datasheet") && requestFileLabels.includes("website");
      const errorMessage = isProductDataPlaceholderFailure
        ? hasDatasheetAndWebsite
          ? "AI could not extract PRODUCT_DATA from the uploaded files after all retries. Check that the datasheet and website PDF describe the same product, include selectable text (not image-only scans), then run Generate Data again."
          : "AI could not extract PRODUCT_DATA from the uploaded file after all retries. Check that the PDF contains selectable text (not an image-only scan), then run Generate Data again."
        : `Critical required sections missing or placeholder after merge: ${failingSections.join(", ")}`;
      const retryInfo = await queueCriticalValidationRetry(
        "critical_required_sections_missing_or_placeholder",
        failingSections,
        {
          allowProductDataAutoRetry: isProductDataPlaceholderFailure ? hasSubstantialProductDataRetryCandidate : false,
        },
      );
      if (retryInfo.queued) {
        return {
          status: "retry",
          reason: "critical_required_sections_retry_queued",
        };
      }
      return await failValidation(errorMessage, "critical_required_sections_missing_or_placeholder", {
        ui_error_code: isProductDataPlaceholderFailure
          ? "product_data_placeholder_after_retries"
          : "critical_required_sections_missing_or_placeholder",
        ui_actionable: isProductDataPlaceholderFailure,
        ui_retry_recommended: true,
        ui_failing_sections: failingSections,
        validation_retry: {
          queued: false,
          used: retryInfo.usedRetries,
          max: retryInfo.maxRetries,
          skipped_by_policy: retryInfo.skippedByPolicy,
          confidence_gate_passed: isProductDataPlaceholderFailure ? hasSubstantialProductDataRetryCandidate : null,
        },
      });
    }
  }

  const totalMs = Date.now() - startedAt;

  const timing = {
    ...(job.timing || {}),
    chunk_count: counts.total,
    chunks_done: counts.done,
    chunks_error: counts.error,
    chunks_cancelled: counts.cancelled,
    gemini_ms: geminiMs,
    total_ms: totalMs,
    output_chars: computeOutputChars(merged),
    finished_at: new Date().toISOString(),
  };

  const result = {
    success: true,
    data: merged,
    result: merged,
    usage: {
      inputTokens,
      outputTokens,
    },
    meta: {
      model: ENFORCED_MODEL,
      chunked: true,
      chunksTotal: counts.total,
      chunksDone: counts.done,
      chunksError: counts.error,
      latencyMs: totalMs,
      debug: {
        worker: "ai-worker",
        finalized_at: new Date().toISOString(),
        chunk_details: (allChunks || []).map((row: unknown) =>
          summarizeChunkForDebug(
            row as {
              chunk_index?: unknown;
              chunk_type?: unknown;
              status?: unknown;
              latency_ms?: unknown;
              error?: unknown;
              timing?: unknown;
              text?: unknown;
              created_at?: unknown;
              updated_at?: unknown;
            },
          ),
        ),
        required_sections: responseGuard.requiredSections,
        required_json_keys: responseGuard.requiredJsonKeys,
        section_recovery_used: sectionRecoveryUsed,
        section_recovered: recoveredSections,
        json_recovery_used: jsonRecoveryUsed,
        json_recovered_keys: recoveredJsonKeys,
        product_data_validation: productDataValidationSummary,
        strict_section_validation: strictSectionValidation,
        strict_title_validation: strictTitleValidation,
        strict_description_validation: strictDescriptionValidation,
        compare_validation: compareValidationSummary,
        timing,
      },
    },
  };

  await updateJob(supabase, job.id, {
    status: "done",
    progress: 100,
    result,
    error: null,
    model_used: ENFORCED_MODEL,
    latency_ms: totalMs,
    timing,
  });
  return { status: "done" };
}

async function markJobError(supabase: any, job: JobRecord, errorMessage: string, startedAt: number): Promise<void> {
  const safeErrorMessage = sanitizeUserFacingAiError(errorMessage);
  const totalMs = Date.now() - startedAt;
  const { data: allChunks } = await supabase
    .from("ai_job_chunks")
    .select("chunk_index, chunk_type, status, latency_ms, error, timing, text, created_at, updated_at")
    .eq("job_id", job.id)
    .order("chunk_index", { ascending: true });

  const timing = {
    ...(job.timing || {}),
    total_ms: totalMs,
    failed_at: new Date().toISOString(),
  };

  await updateJob(supabase, job.id, {
    status: "error",
    progress: 0,
    error: safeErrorMessage,
    model_used: ENFORCED_MODEL,
    latency_ms: totalMs,
    timing,
    result: {
      success: false,
      error: safeErrorMessage,
      meta: {
        model: ENFORCED_MODEL,
        latencyMs: totalMs,
        debug: {
          worker: "ai-worker",
          failed_at: new Date().toISOString(),
          chunk_details: (allChunks || []).map((row: unknown) =>
            summarizeChunkForDebug(
              row as {
                chunk_index?: unknown;
                chunk_type?: unknown;
                status?: unknown;
                latency_ms?: unknown;
                error?: unknown;
                timing?: unknown;
                text?: unknown;
                created_at?: unknown;
                updated_at?: unknown;
              },
            ),
          ),
          timing,
        },
      },
    },
  });
}

async function cleanupBucketFiles(supabase: any, payload: Record<string, unknown>): Promise<void> {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "pdf_compare") {
    // Compare flows can run multiple client-orchestrated passes against the same uploaded PDFs.
    // The browser cleans these refs after the full compare sequence completes.
    return;
  }

  const fileRefs = sanitizeFileRefs(payload.files);
  const bucketMap = new Map<string, string[]>();

  for (const ref of fileRefs) {
    const paths = bucketMap.get(ref.bucket) || [];
    paths.push(ref.path);
    bucketMap.set(ref.bucket, paths);
  }

  for (const [bucket, paths] of bucketMap) {
    if (paths.length === 0) continue;
    try {
      await supabase.storage.from(bucket).remove(paths);
    } catch (err) {
      console.warn(`Failed to cleanup files in ${bucket}:`, err);
    }
  }

}

async function processChunk(
  supabase: any,
  job: JobRecord,
  chunk: ChunkRecord,
  countsBefore: ChunkCounts,
): Promise<void> {
  const payload = isPlainObject(job.request_payload) ? job.request_payload : {};
  const basePrompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const type = typeof payload.type === "string" ? payload.type : job.type || "generic";
  const jsonMode = Boolean(payload.jsonMode || payload.mode === "json");
  const configFlags = isPlainObject(payload.configFlags) ? payload.configFlags : {};
  const disableCache = typeof configFlags.disableCache === "boolean" ? configFlags.disableCache : true;
  const chunkTiming = isPlainObject(chunk.timing) ? chunk.timing : {};
  const directFilesMode = Boolean(chunkTiming.direct_files_mode);

  const prompt = buildChunkPrompt(
    basePrompt,
    chunk.chunk_index,
    countsBefore.total || 1,
    jsonMode,
    type,
    directFilesMode,
  );
  const promptChars = prompt.length + chunk.text.length;

  const { data: claimedChunk } = await supabase
    .from("ai_job_chunks")
    .update({
      status: "running",
      error: null,
      timing: {
        ...(chunk.timing || {}),
        started_at: new Date().toISOString(),
        prompt_chars: promptChars,
        direct_files_mode: directFilesMode,
        input_file_count: directFilesMode ? sanitizeFileRefs(payload.files).length : 0,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", chunk.id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();

  if (!claimedChunk) {
    return;
  }

  const chunkStart = Date.now();
  console.log(
    "AI_CHUNK_START",
    JSON.stringify({
      jobId: job.id,
      chunkIndex: chunk.chunk_index,
      chunkType: chunk.chunk_type,
      input_chars: chunk.text.length,
      direct_files_mode: directFilesMode,
      json_mode: jsonMode,
      model: ENFORCED_MODEL,
    }),
  );

  let chunkHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const touchChunkHeartbeat = async () => {
    try {
      await supabase
        .from("ai_job_chunks")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", chunk.id)
        .eq("status", "running");
    } catch (heartbeatErr) {
      console.warn(
        `AI_CHUNK_HEARTBEAT_FAILED jobId=${job.id} chunkIndex=${chunk.chunk_index}: ${heartbeatErr instanceof Error ? heartbeatErr.message : String(heartbeatErr)}`,
      );
    }
  };
  const stopChunkHeartbeat = () => {
    if (!chunkHeartbeatTimer) return;
    clearInterval(chunkHeartbeatTimer);
    chunkHeartbeatTimer = null;
  };

  chunkHeartbeatTimer = setInterval(() => {
    void touchChunkHeartbeat();
  }, CHUNK_HEARTBEAT_INTERVAL_MS);
  void touchChunkHeartbeat();

  try {
    const cacheHashes = new Set<string>();
    let quickHash: string | null = null;
    const readCached = async (cacheHash: string) => {
      const { data } = await supabase
        .from("ai_cache")
        .select("result")
        .eq("hash", cacheHash)
        .eq("mode", type)
        .eq("chunk_index", chunk.chunk_index)
        .eq("model", ENFORCED_MODEL)
        .maybeSingle();
      return data;
    };

  if (!disableCache) {
    const hashInput = directFilesMode
      ? JSON.stringify({
          model: ENFORCED_MODEL,
          type,
          mode: jsonMode ? "json" : "text",
          chunk_index: chunk.chunk_index,
          prompt,
          files: sanitizeFileRefs(payload.files).map((ref) => `${ref.bucket}/${ref.path}|${ref.label}|${ref.filename}`),
        })
      : [ENFORCED_MODEL, type, jsonMode ? "json" : "text", String(chunk.chunk_index), prompt, chunk.text].join("|");
    quickHash = await sha256Hex(hashInput);
    cacheHashes.add(quickHash);
    const cachedQuick = await readCached(quickHash);
    if (cachedQuick?.result) {
      const totalMs = Date.now() - chunkStart;
      const timing = {
        ...(chunk.timing || {}),
        download_ms: 0,
        extract_ms: 0,
        chunk_count: 1,
        gemini_ms: 0,
        total_ms: totalMs,
        prompt_chars: promptChars,
        output_chars: computeOutputChars(cachedQuick.result),
        cache_hit: true,
        http_status: 200,
        source: "cache",
        finished_at: new Date().toISOString(),
      };

      await updateChunk(supabase, chunk.id, {
        status: "done",
        result: cachedQuick.result,
        error: null,
        latency_ms: totalMs,
        timing,
      });

      console.log(
        "AI_TIMING",
        JSON.stringify({ jobId: job.id, chunkIndex: chunk.chunk_index, gemini_ms: 0, total_ms: totalMs }),
      );
      console.log(
        "AI_CHUNK_END",
        JSON.stringify({
          jobId: job.id,
          chunkIndex: chunk.chunk_index,
          status: "done",
          source: "cache",
          total_ms: totalMs,
        }),
      );
      return;
    }
  }

  let preDownloadedFiles: DownloadedDirectFileRef[] | undefined;
  let preDownloadedMs = 0;
  let preDownloadedTotalBytes = 0;
  // Check if Gemini file URIs were pre-uploaded during ensureChunksExist
  const storedGeminiUris = Array.isArray(chunkTiming.gemini_file_uris)
    ? (chunkTiming.gemini_file_uris as Array<{ fileUri: string; displayName: string; mimeType: string; sizeBytes: number; label: string; filename: string }>)
    : null;
  const hasPreUploadedUris = storedGeminiUris !== null && storedGeminiUris.length > 0;

  if (directFilesMode && !hasPreUploadedUris) {
    // Standard path: no pre-uploaded URIs, must download files for direct mode
    const refs = sanitizeFileRefs(payload.files);
    const allowMissingInstruction = isAllowMissingInstructionEnabled(payload.configFlags);
    if (refs.length > 0) {
      const downloadStartedAt = Date.now();
      const downloadResults = await Promise.allSettled(
        refs.map(async (ref) => {
          let cached: Uint8Array | null = null;
          const cacheKey = `${ref.bucket}/${ref.path}`;
          if (!disableCache) {
            cached = getCachedFileBytes(cacheKey);
            if (cached) {
              touchCachedFileBytes(cacheKey);
            }
          }
          const bytes = cached ?? (await downloadFileBytes(supabase, ref.bucket, ref.path));
          if (!disableCache && !cached) setCachedFileBytes(cacheKey, bytes);
          return { ...ref, bytes, mimeType: inferMimeType(ref.filename, bytes) } as DownloadedDirectFileRef;
        }),
      );

      const downloadedRefs: DownloadedDirectFileRef[] = [];
      for (let i = 0; i < downloadResults.length; i++) {
        const result = downloadResults[i];
        if (result.status === "fulfilled") {
          downloadedRefs.push(result.value);
          continue;
        }
        const ref = refs[i];
        if (shouldIgnoreMissingInstructionDownload(ref, result.reason, allowMissingInstruction)) {
          console.warn(
            `AI_OPTIONAL_INSTRUCTION_SKIPPED bucket=${ref.bucket} path=${ref.path} filename=${ref.filename}`,
          );
          continue;
        }
        throw result.reason;
      }

      preDownloadedFiles = downloadedRefs;
      preDownloadedMs = Date.now() - downloadStartedAt;
      preDownloadedTotalBytes = preDownloadedFiles.reduce((sum, f) => sum + f.bytes.length, 0);

      if (!disableCache) {
        const orderedForHash = [...preDownloadedFiles].sort((a, b) => {
          const aScore = a.label === "instructions" ? 0 : 1;
          const bScore = b.label === "instructions" ? 0 : 1;
          if (aScore !== bScore) return aScore - bScore;
          const filenameDiff = a.filename.localeCompare(b.filename);
          if (filenameDiff !== 0) return filenameDiff;
          return a.path.localeCompare(b.path);
        });
        const fileDigests: string[] = [];
        for (const file of orderedForHash) {
          const digest = await sha256HexBytes(file.bytes);
          fileDigests.push(`${file.label}|${file.filename}|${file.mimeType}|${file.bytes.length}|${digest}`);
        }
        const contentHash = await sha256Hex(
          JSON.stringify({
            model: ENFORCED_MODEL,
            type,
            mode: jsonMode ? "json" : "text",
            chunk_index: chunk.chunk_index,
            prompt,
            files: fileDigests,
          }),
        );
        cacheHashes.add(contentHash);

        if (!quickHash || contentHash !== quickHash) {
          const cachedContent = await readCached(contentHash);
          if (cachedContent?.result) {
            const totalMs = Date.now() - chunkStart;
            const timing = {
              ...(chunk.timing || {}),
              download_ms: preDownloadedMs,
              extract_ms: 0,
              chunk_count: 1,
              gemini_ms: 0,
              total_ms: totalMs,
              prompt_chars: promptChars,
              output_chars: computeOutputChars(cachedContent.result),
              cache_hit: true,
              http_status: 200,
              source: "cache_content_hash",
              direct_files_mode: true,
              input_file_count: preDownloadedFiles.length,
              input_file_bytes: preDownloadedTotalBytes,
              finished_at: new Date().toISOString(),
            };

            await updateChunk(supabase, chunk.id, {
              status: "done",
              result: cachedContent.result,
              error: null,
              latency_ms: totalMs,
              timing,
            });

            console.log(
              "AI_TIMING",
              JSON.stringify({ jobId: job.id, chunkIndex: chunk.chunk_index, gemini_ms: 0, total_ms: totalMs }),
            );
            console.log(
              "AI_CHUNK_END",
              JSON.stringify({
                jobId: job.id,
                chunkIndex: chunk.chunk_index,
                status: "done",
                source: "cache_content_hash",
                total_ms: totalMs,
              }),
            );
            return;
          }
        }
      }
    }
  }

  const jobSystemPrompt =
    typeof payload.systemPrompt === "string" && payload.systemPrompt.trim() ? payload.systemPrompt.trim() : undefined;

  // Read temperature and strictJson from configFlags stored in job payload
  const jobConfigFlags = isPlainObject(payload.configFlags) ? payload.configFlags : {};
  const jobTemperature =
    typeof jobConfigFlags.temperature === "number" && Number.isFinite(jobConfigFlags.temperature as number)
      ? (jobConfigFlags.temperature as number)
      : undefined;
  const jobStrictJson = typeof jobConfigFlags.strictJson === "boolean" ? jobConfigFlags.strictJson : false;

  let chunkCall = directFilesMode
    ? await callChunkGeminiWithFiles(
        supabase,
        job.id,
        chunk.chunk_index,
        prompt,
        jsonMode,
        payload,
        preDownloadedFiles,
        preDownloadedMs,
        jobSystemPrompt,
        jobTemperature,
        jobStrictJson,
        undefined,
        hasPreUploadedUris ? storedGeminiUris! : undefined,
      )
    : await callChunkGemini(
        job.id,
        chunk.chunk_index,
        prompt,
        chunk.text,
        jsonMode,
        type,
        jobSystemPrompt,
        jobTemperature,
        jobStrictJson,
      );

  let usedTextFallback = false;
  let textFallbackReason: string | null = null;
  let textFallbackExtractMs = 0;
  let usedCompareCoverageRescue = false;
  let compareCoverageBefore: { inventoryTotal: number; extractedCount: number } | null = null;
  let compareCoverageAfter: { inventoryTotal: number; extractedCount: number } | null = null;

  const directCallFailed = chunkCall.status < 200 || chunkCall.status >= 300 || chunkCall.payload.success !== true;
  if (directFilesMode && directCallFailed) {
    const directFailureMessage =
      typeof chunkCall.payload.error === "string"
        ? trimPreview(chunkCall.payload.error, 260)
        : `http_${chunkCall.status}`;

    try {
      const allRefs = sanitizeFileRefs(payload.files);
      const nonInstructionRefs = allRefs.filter((ref) => !isInstructionLikeFile(ref));
      const refs = nonInstructionRefs.length > 0 ? nonInstructionRefs : allRefs;
      const allowMissingInstruction = isAllowMissingInstructionEnabled(payload.configFlags);
      const fallbackExtractStartedAt = Date.now();
      const extracted = await extractFiles(supabase, refs, preDownloadedFiles, allowMissingInstruction);
      textFallbackExtractMs = Date.now() - fallbackExtractStartedAt;

      const singlePass = buildSinglePassChunkFromFiles(extracted.files);
      const fallbackChunks = singlePass.chunks.length > 0 ? singlePass.chunks : buildChunksFromFiles(extracted.files);
      const fallbackChunkText =
        fallbackChunks[chunk.chunk_index]?.text ||
        fallbackChunks[0]?.text ||
        normalizeText(extracted.files.map((file) => file.pages.join("\n")).join("\n\n"));

      if (fallbackChunkText.trim().length > 0) {
        const fallbackPrompt = buildChunkPrompt(
          basePrompt,
          chunk.chunk_index,
          countsBefore.total || 1,
          jsonMode,
          type,
          false,
        );
        const fallbackCall = await callChunkGemini(
          job.id,
          chunk.chunk_index,
          fallbackPrompt,
          fallbackChunkText,
          jsonMode,
          type,
          jobSystemPrompt,
          jobTemperature,
          jobStrictJson,
        );

        if (fallbackCall.status >= 200 && fallbackCall.status < 300 && fallbackCall.payload.success === true) {
          chunkCall = fallbackCall;
          usedTextFallback = true;
          textFallbackReason = directFailureMessage;
          console.warn(
            `AI_DIRECT_FILES_FALLBACK_SUCCESS jobId=${job.id} chunkIndex=${chunk.chunk_index} reason=${directFailureMessage}`,
          );
        } else {
          const fallbackError =
            typeof fallbackCall.payload.error === "string"
              ? trimPreview(fallbackCall.payload.error, 260)
              : `http_${fallbackCall.status}`;
          chunkCall.payload.error = `Direct-files mode failed (${directFailureMessage}); text fallback failed (${fallbackError})`;
          chunkCall.status = fallbackCall.status;
          console.warn(
            `AI_DIRECT_FILES_FALLBACK_FAILED jobId=${job.id} chunkIndex=${chunk.chunk_index} direct=${directFailureMessage} fallback=${fallbackError}`,
          );
        }
      } else {
        chunkCall.payload.error = `Direct-files mode failed (${directFailureMessage}); text fallback had no extractable content`;
        console.warn(
          `AI_DIRECT_FILES_FALLBACK_NO_TEXT jobId=${job.id} chunkIndex=${chunk.chunk_index} reason=${directFailureMessage}`,
        );
      }
    } catch (fallbackErr) {
      const fallbackError =
        fallbackErr instanceof Error ? trimPreview(fallbackErr.message, 260) : trimPreview(String(fallbackErr), 260);
      chunkCall.payload.error = `Direct-files mode failed (${directFailureMessage}); text fallback exception (${fallbackError})`;
      console.warn(
        `AI_DIRECT_FILES_FALLBACK_EXCEPTION jobId=${job.id} chunkIndex=${chunk.chunk_index} direct=${directFailureMessage} fallback=${fallbackError}`,
      );
    }
  }

  let usedOcrRescue = false;
  let ocrRescueReason: string | null = null;
  if (!directFilesMode && chunkCall.status >= 200 && chunkCall.status < 300 && chunkCall.payload.success === true) {
    const refs = sanitizeFileRefs(payload.files);
    const hasNonInstructionRefs = refs.some((ref) => !isInstructionLikeFile(ref));
    const allowOcrRescue =
      type === "generate_data" &&
      !jsonMode &&
      refs.length > 0 &&
      hasNonInstructionRefs &&
      (typeof jobConfigFlags.directFiles === "boolean" ? jobConfigFlags.directFiles : true);

    if (allowOcrRescue) {
      const candidateOutput = toStringSafe(chunkCall.payload.result ?? chunkCall.payload.data);
      const placeholderDetected = looksLikePlaceholderProductData(candidateOutput);
      const lowEvidenceDetected = hasLowStructuredEvidence(candidateOutput);
      if (placeholderDetected || lowEvidenceDetected) {
        ocrRescueReason = placeholderDetected
          ? "placeholder_product_data_detected"
          : "low_structured_evidence_detected";
        try {
          const ocrCall = await callChunkGeminiWithFiles(
            supabase,
            job.id,
            chunk.chunk_index,
            prompt,
            jsonMode,
            payload,
            undefined,
            0,
            jobSystemPrompt,
            jobTemperature,
            jobStrictJson,
            chunk.text,
          );
          if (ocrCall.status >= 200 && ocrCall.status < 300 && ocrCall.payload.success === true) {
            const ocrOutput = toStringSafe(ocrCall.payload.result ?? ocrCall.payload.data);
            const ocrPlaceholder = looksLikePlaceholderProductData(ocrOutput);
            const ocrLowEvidence = hasLowStructuredEvidence(ocrOutput);
            const keepOcr = !ocrPlaceholder && (!ocrLowEvidence || placeholderDetected);
            if (keepOcr) {
              chunkCall = ocrCall;
              usedOcrRescue = true;
              console.warn(
                `AI_OCR_RESCUE_SUCCESS jobId=${job.id} chunkIndex=${chunk.chunk_index} reason=${ocrRescueReason}`,
              );
            } else {
              console.warn(
                `AI_OCR_RESCUE_SKIPPED jobId=${job.id} chunkIndex=${chunk.chunk_index} reason=${ocrRescueReason} ocr_placeholder=${ocrPlaceholder} ocr_low_evidence=${ocrLowEvidence}`,
              );
            }
          }
        } catch (ocrErr) {
          console.warn(
            `AI_OCR_RESCUE_EXCEPTION jobId=${job.id} chunkIndex=${chunk.chunk_index}: ${ocrErr instanceof Error ? trimPreview(ocrErr.message, 260) : trimPreview(String(ocrErr), 260)}`,
          );
        }
      }
    }
  }

  const chunkSucceeded = chunkCall.status >= 200 && chunkCall.status < 300 && chunkCall.payload.success === true;
  if (directFilesMode && chunkSucceeded && jsonMode && type === "pdf_compare") {
    const currentResult = isPlainObject(chunkCall.payload.result)
      ? chunkCall.payload.result
      : isPlainObject(chunkCall.payload.data)
        ? chunkCall.payload.data
        : null;
    const currentCoverage = getCompareCoverageScore(currentResult);
    compareCoverageBefore = currentCoverage;

    const shouldAttemptCoverageRescue =
      currentCoverage.inventoryTotal === 0 ||
      currentCoverage.extractedCount === 0 ||
      currentCoverage.inventoryTotal <= COMPARE_MIN_INVENTORY_TOTAL_FOR_SKIP_RESCUE ||
      currentCoverage.extractedCount <= COMPARE_MIN_INVENTORY_TOTAL_FOR_SKIP_RESCUE;

    if (shouldAttemptCoverageRescue) {
      try {
        const allRefs = sanitizeFileRefs(payload.files);
        const nonInstructionRefs = allRefs.filter((ref) => !isInstructionLikeFile(ref));
        const refs = nonInstructionRefs.length > 0 ? nonInstructionRefs : allRefs;
        const allowMissingInstruction = isAllowMissingInstructionEnabled(payload.configFlags);
        const extracted = await extractFiles(supabase, refs, preDownloadedFiles, allowMissingInstruction);
        const singlePass = buildSinglePassChunkFromFiles(extracted.files);
        const fallbackChunks = singlePass.chunks.length > 0 ? singlePass.chunks : buildChunksFromFiles(extracted.files);
        const fallbackChunkText =
          fallbackChunks[chunk.chunk_index]?.text ||
          fallbackChunks[0]?.text ||
          normalizeText(extracted.files.map((file) => file.pages.join("\n")).join("\n\n"));

        if (fallbackChunkText.trim().length > 0) {
          const fallbackPrompt = buildChunkPrompt(
            basePrompt,
            chunk.chunk_index,
            countsBefore.total || 1,
            jsonMode,
            type,
            false,
          );
          const fallbackCall = await callChunkGemini(
            job.id,
            chunk.chunk_index,
            fallbackPrompt,
            fallbackChunkText,
            jsonMode,
            type,
            jobSystemPrompt,
            jobTemperature,
            jobStrictJson,
          );

          if (fallbackCall.status >= 200 && fallbackCall.status < 300 && fallbackCall.payload.success === true) {
            const fallbackResult = isPlainObject(fallbackCall.payload.result)
              ? fallbackCall.payload.result
              : isPlainObject(fallbackCall.payload.data)
                ? fallbackCall.payload.data
                : null;
            const fallbackCoverage = getCompareCoverageScore(fallbackResult);
            compareCoverageAfter = fallbackCoverage;

            const fallbackIsBetter =
              fallbackCoverage.inventoryTotal > currentCoverage.inventoryTotal ||
              (fallbackCoverage.inventoryTotal === currentCoverage.inventoryTotal &&
                fallbackCoverage.extractedCount > currentCoverage.extractedCount);

            if (fallbackIsBetter) {
              chunkCall = fallbackCall;
              usedCompareCoverageRescue = true;
              console.warn(
                `AI_COMPARE_COVERAGE_RESCUE_SUCCESS jobId=${job.id} chunkIndex=${chunk.chunk_index} before=${currentCoverage.inventoryTotal}/${currentCoverage.extractedCount} after=${fallbackCoverage.inventoryTotal}/${fallbackCoverage.extractedCount}`,
              );
            }
          }
        }
      } catch (coverageErr) {
        console.warn(
          `AI_COMPARE_COVERAGE_RESCUE_EXCEPTION jobId=${job.id} chunkIndex=${chunk.chunk_index}: ${coverageErr instanceof Error ? trimPreview(coverageErr.message, 260) : trimPreview(String(coverageErr), 260)}`,
        );
      }
    }
  }

  const totalMs = Date.now() - chunkStart;

  if (chunkCall.status === 429) {
    const retryCount = Number((chunk.timing || {}).retry_count || 0);

    await updateChunk(supabase, chunk.id, {
      status: "error",
      error: "Rate limited by Gemini (429). Please retry manually.",
      latency_ms: totalMs,
      timing: {
        ...(chunk.timing || {}),
        retry_count: retryCount,
        total_ms: totalMs,
        http_status: 429,
        gemini_error: typeof chunkCall.payload.error === "string" ? trimPreview(chunkCall.payload.error, 300) : "429",
        finished_at: new Date().toISOString(),
      },
    });
    console.log(
      "AI_CHUNK_END",
      JSON.stringify({
        jobId: job.id,
        chunkIndex: chunk.chunk_index,
        status: "error",
        http_status: 429,
        reason: "rate_limited_manual_retry",
      }),
    );
    return;
  }

  if (chunkCall.status < 200 || chunkCall.status >= 300 || chunkCall.payload.success !== true) {
    await updateChunk(supabase, chunk.id, {
      status: "error",
      error:
        typeof chunkCall.payload.error === "string"
          ? chunkCall.payload.error
          : `Chunk processor failed with HTTP ${chunkCall.status}`,
      latency_ms: totalMs,
      timing: {
        ...(chunk.timing || {}),
        total_ms: totalMs,
        http_status: chunkCall.status,
        gemini_error:
          typeof chunkCall.payload.error === "string"
            ? trimPreview(chunkCall.payload.error, 420)
            : `http_${chunkCall.status}`,
        direct_files_text_fallback_used: usedTextFallback,
        direct_files_text_fallback_reason: textFallbackReason,
        direct_files_text_fallback_extract_ms: textFallbackExtractMs,
        finished_at: new Date().toISOString(),
      },
    });
    console.log(
      "AI_CHUNK_END",
      JSON.stringify({
        jobId: job.id,
        chunkIndex: chunk.chunk_index,
        status: "error",
        http_status: chunkCall.status,
        error:
          typeof chunkCall.payload.error === "string"
            ? trimPreview(chunkCall.payload.error, 220)
            : `http_${chunkCall.status}`,
      }),
    );
    return;
  }

  const geminiMeta = isPlainObject(chunkCall.payload.meta) ? chunkCall.payload.meta : {};
  const geminiTiming = isPlainObject(geminiMeta.timing) ? geminiMeta.timing : {};
  const resultPayload = {
    success: true,
    result: chunkCall.payload.result,
    data: chunkCall.payload.data,
    usage: chunkCall.payload.usage,
    meta: chunkCall.payload.meta,
  };

  const timing = {
    ...(chunk.timing || {}),
    download_ms: Number(geminiTiming.download_ms || 0),
    extract_ms: Number(geminiTiming.extract_ms || 0),
    chunk_count: 1,
    gemini_ms: Number(geminiTiming.gemini_ms || geminiMeta.latencyMs || 0),
    total_ms: totalMs,
    prompt_chars: Number(geminiTiming.prompt_chars || promptChars),
    output_chars: computeOutputChars(chunkCall.payload.result ?? chunkCall.payload.data),
    cache_hit: false,
    http_status: 200,
    source: usedTextFallback ? "gemini_direct_files_text_fallback" : directFilesMode ? "gemini_direct_files" : "gemini",
    direct_files_mode: directFilesMode && !usedTextFallback,
    direct_files_text_fallback_used: usedTextFallback,
    direct_files_text_fallback_reason: textFallbackReason,
    direct_files_text_fallback_extract_ms: textFallbackExtractMs,
    ocr_rescue_used: usedOcrRescue,
    ocr_rescue_reason: ocrRescueReason,
    compare_coverage_rescue_used: usedCompareCoverageRescue,
    compare_coverage_before: compareCoverageBefore,
    compare_coverage_after: compareCoverageAfter,
    input_file_count: Number(geminiTiming.input_file_count || 0),
    input_file_bytes: Number(geminiTiming.input_file_bytes || 0),
    finished_at: new Date().toISOString(),
  };

  await updateChunk(supabase, chunk.id, {
    status: "done",
    result: resultPayload,
    error: null,
    latency_ms: totalMs,
    timing,
  });

  const cacheRows = [...cacheHashes].map((cacheHash) => ({
    hash: cacheHash,
    mode: type,
    chunk_index: chunk.chunk_index,
    model: ENFORCED_MODEL,
    result: resultPayload,
    created_at: new Date().toISOString(),
  }));

  if (!disableCache && cacheRows.length > 0) {
    await supabase.from("ai_cache").upsert(cacheRows, { onConflict: "hash,mode,chunk_index,model" });
  }

  console.log(
    "AI_TIMING",
    JSON.stringify({
      jobId: job.id,
      chunkIndex: chunk.chunk_index,
      gemini_ms: timing.gemini_ms,
      total_ms: timing.total_ms,
    }),
  );
    console.log(
      "AI_CHUNK_END",
      JSON.stringify({
        jobId: job.id,
        chunkIndex: chunk.chunk_index,
        status: "done",
        http_status: 200,
        gemini_ms: timing.gemini_ms,
        total_ms: timing.total_ms,
        output_chars: timing.output_chars,
      }),
    );
  } finally {
    stopChunkHeartbeat();
  }
}

async function processJob(supabase: any, job: JobRecord): Promise<{ jobId: string; status: string }> {
  const startedAt = Date.now();

  const payload = isPlainObject(job.request_payload) ? job.request_payload : {};
  payload.model = ENFORCED_MODEL;
  console.log(
    "AI_JOB_START",
    JSON.stringify({
      jobId: job.id,
      type: job.type,
      status: job.status,
      has_files: Array.isArray(payload.files) ? payload.files.length : 0,
      document_text_chars: typeof payload.documentText === "string" ? payload.documentText.length : 0,
      mode: payload.mode ?? null,
      json_mode: Boolean(payload.jsonMode || payload.mode === "json"),
    }),
  );

  const baseTiming = {
    ...(job.timing || {}),
    worker_started_at: new Date().toISOString(),
  };

  // Only set progress to 5 if job was just claimed from queued (not re-entered by duplicate worker)
  const currentProgress = job.status === "queued" ? 5 : undefined;
  const updateFields: Record<string, unknown> = {
    status: "running",
    model_used: ENFORCED_MODEL,
    timing: baseTiming,
    request_payload: payload,
  };
  if (currentProgress !== undefined) {
    updateFields.progress = currentProgress;
  }
  await updateJob(supabase, job.id, updateFields);

  try {
    const countsAfterPrepare = await ensureChunksExist(supabase, {
      ...job,
      request_payload: payload,
      timing: baseTiming,
    });
    console.log(
      "AI_JOB_PREPARED",
      JSON.stringify({
        jobId: job.id,
        chunks_total: countsAfterPrepare.total,
        chunks_queued: countsAfterPrepare.queued,
        chunks_running: countsAfterPrepare.running,
        chunks_done: countsAfterPrepare.done,
        chunks_error: countsAfterPrepare.error,
      }),
    );

    // ── Two-phase split for free-tier edge runtime budgets ──
    // If chunk creation took significant time (file downloads, extraction),
    // defer chunk processing to a continuation invocation so each stays under 60s.
    const elapsedSinceStart = Date.now() - startedAt;
    const PHASE_SPLIT_THRESHOLD_MS = 15_000; // 15s — if we've used this much, split
    if (
      elapsedSinceStart > PHASE_SPLIT_THRESHOLD_MS &&
      countsAfterPrepare.queued > 0 &&
      countsAfterPrepare.done === 0
    ) {
      console.log(
        "AI_JOB_PHASE_SPLIT",
        JSON.stringify({
          jobId: job.id,
          elapsed_ms: elapsedSinceStart,
          queued_chunks: countsAfterPrepare.queued,
          reason: "deferring_chunk_processing_to_continuation",
        }),
      );
      // Trigger a continuation worker to process chunks in a fresh invocation
      triggerWorker(job.id);
      return { jobId: job.id, status: "running" };
    }

    const queuedChunksResponse = await supabase
      .from("ai_job_chunks")
      .select("id, chunk_index, chunk_type, text, status, timing, result, error")
      .eq("job_id", job.id)
      .eq("status", "queued")
      .order("chunk_index", { ascending: true })
      .limit(MAX_CHUNKS_PER_INVOCATION);

    const queuedChunks = (queuedChunksResponse.data || []) as ChunkRecord[];

    if (queuedChunks.length > 0) {
      await runWithConcurrency(queuedChunks, CHUNK_CONCURRENCY, async (chunk) => {
        await processChunk(supabase, job, chunk, countsAfterPrepare);
      });
    }

    const counts = await getChunkCounts(supabase, job.id);

    const progress = counts.total > 0 ? Math.min(95, Math.max(10, Math.floor((counts.done / counts.total) * 90))) : 10;

    await updateJob(supabase, job.id, {
      progress,
      timing: {
        ...baseTiming,
        chunk_count: counts.total,
        chunks_done: counts.done,
        chunks_queued: counts.queued,
        chunks_running: counts.running,
        chunks_error: counts.error,
        chunks_cancelled: counts.cancelled,
      },
    });

    if (counts.total > 0 && counts.done === counts.total) {
      const finalizeOutcome = await finalizeJob(supabase, job, counts, startedAt);
      if (finalizeOutcome.status === "retry") {
        console.log(
          "AI_JOB_END",
          JSON.stringify({
            jobId: job.id,
            status: "retry",
            reason: finalizeOutcome.reason || "validation_retry",
            total_ms: Date.now() - startedAt,
            chunks_total: counts.total,
            chunks_done: counts.done,
            chunks_error: counts.error,
          }),
        );
        return { jobId: job.id, status: "running" };
      }
      if (finalizeOutcome.status === "error") {
        await cleanupBucketFiles(supabase, payload);
        console.log(
          "AI_JOB_END",
          JSON.stringify({
            jobId: job.id,
            status: "error",
            reason: finalizeOutcome.reason || "finalize_validation_error",
            total_ms: Date.now() - startedAt,
            chunks_total: counts.total,
            chunks_done: counts.done,
            chunks_error: counts.error,
          }),
        );
        return { jobId: job.id, status: "error" };
      }
      await cleanupBucketFiles(supabase, payload);
      console.log(
        "AI_JOB_END",
        JSON.stringify({
          jobId: job.id,
          status: "done",
          total_ms: Date.now() - startedAt,
          chunks_total: counts.total,
          chunks_done: counts.done,
          chunks_error: counts.error,
        }),
      );
      return { jobId: job.id, status: "done" };
    }

    if (counts.queued === 0 && counts.running === 0 && counts.done === 0 && counts.error > 0) {
      const { data: failedChunks } = await supabase
        .from("ai_job_chunks")
        .select("chunk_index, error")
        .eq("job_id", job.id)
        .eq("status", "error")
        .order("chunk_index", { ascending: true })
        .limit(1);

      const firstChunkError = (failedChunks?.[0]?.error || "").toString().trim();
      const timingObj = isPlainObject(job.timing) ? job.timing : {};
      const transportRetriesUsedRaw = Number(timingObj.transport_retries_used || 0);
      const transportRetriesUsed =
        Number.isFinite(transportRetriesUsedRaw) && transportRetriesUsedRaw > 0
          ? Math.floor(transportRetriesUsedRaw)
          : 0;

      if (isTransportConnectivityMessage(firstChunkError) && transportRetriesUsed < AI_JOB_TRANSPORT_RETRY_MAX) {
        const nowIso = new Date().toISOString();
        const nextRetryCount = transportRetriesUsed + 1;

        await supabase
          .from("ai_job_chunks")
          .update({
            status: "queued",
            error: null,
            result: null,
            latency_ms: null,
            updated_at: nowIso,
          })
          .eq("job_id", job.id)
          .eq("status", "error");

        await updateJob(supabase, job.id, {
          status: "queued",
          progress: 5,
          error: null,
          result: null,
          latency_ms: null,
          timing: {
            ...(job.timing || {}),
            transport_retries_used: nextRetryCount,
            transport_retry_max: AI_JOB_TRANSPORT_RETRY_MAX,
            transport_retry_last_error: trimPreview(firstChunkError, 420),
            transport_retry_last_at: nowIso,
          },
        });

        triggerWorker(job.id);
        console.warn(
          `AI_JOB_TRANSPORT_RETRY_QUEUED jobId=${job.id} retry=${nextRetryCount}/${AI_JOB_TRANSPORT_RETRY_MAX} reason=${trimPreview(firstChunkError, 220)}`,
        );
        return { jobId: job.id, status: "running" };
      }

      const sanitizedFirstChunkError = firstChunkError ? sanitizeUserFacingAiError(trimPreview(firstChunkError, 420)) : "";
      const errorMessage = sanitizedFirstChunkError || "All chunks failed";

      await markJobError(supabase, job, errorMessage, startedAt);
      await cleanupBucketFiles(supabase, payload);
      console.log(
        "AI_JOB_END",
        JSON.stringify({
          jobId: job.id,
          status: "error",
          reason: "all_chunks_failed",
          first_chunk_error: firstChunkError ? trimPreview(firstChunkError, 220) : null,
          total_ms: Date.now() - startedAt,
          chunks_total: counts.total,
          chunks_error: counts.error,
        }),
      );
      return { jobId: job.id, status: "error" };
    }

    if (counts.queued === 0 && counts.running === 0 && counts.done > 0 && counts.error > 0) {
      const finalizeOutcome = await finalizeJob(supabase, job, counts, startedAt);
      if (finalizeOutcome.status === "retry") {
        console.log(
          "AI_JOB_END",
          JSON.stringify({
            jobId: job.id,
            status: "retry",
            reason: finalizeOutcome.reason || "validation_retry_partial_success",
            total_ms: Date.now() - startedAt,
            chunks_total: counts.total,
            chunks_done: counts.done,
            chunks_error: counts.error,
          }),
        );
        return { jobId: job.id, status: "running" };
      }
      if (finalizeOutcome.status === "error") {
        await cleanupBucketFiles(supabase, payload);
        console.log(
          "AI_JOB_END",
          JSON.stringify({
            jobId: job.id,
            status: "error",
            reason: finalizeOutcome.reason || "finalize_validation_error_partial_success",
            total_ms: Date.now() - startedAt,
            chunks_total: counts.total,
            chunks_done: counts.done,
            chunks_error: counts.error,
          }),
        );
        return { jobId: job.id, status: "error" };
      }
      await cleanupBucketFiles(supabase, payload);
      console.log(
        "AI_JOB_END",
        JSON.stringify({
          jobId: job.id,
          status: "done",
          reason: "partial_success",
          total_ms: Date.now() - startedAt,
          chunks_total: counts.total,
          chunks_done: counts.done,
          chunks_error: counts.error,
        }),
      );
      return { jobId: job.id, status: "done" };
    }

    // Don't trigger another worker — let the status poll kick if needed
    // This prevents spawning redundant concurrent workers

    return { jobId: job.id, status: "running" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    console.error(`ai-worker job ${job.id} failed:`, message);

    await markJobError(supabase, job, message, startedAt);
    await cleanupBucketFiles(supabase, payload);
    console.log(
      "AI_JOB_END",
      JSON.stringify({
        jobId: job.id,
        status: "error",
        reason: "worker_exception",
        total_ms: Date.now() - startedAt,
        error: trimPreview(message, 280),
      }),
    );
    return { jobId: job.id, status: "error" };
  }
}

serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = getCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  const blocked = rejectIfOriginNotAllowed(origin, "POST, OPTIONS", req);
  if (blocked) return blocked;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, cors);
  }

  if (!(await hasWorkerAccess(req))) {
    return jsonResponse({ error: "Unauthorized" }, 401, cors);
  }

  try {
    // deno-lint-ignore no-explicit-any
    const supabase: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await parseJsonObject(req);
    const requestedJobId = typeof body.jobId === "string" ? body.jobId : undefined;

    const job = await claimJob(supabase, requestedJobId);
    if (!job) {
      return jsonResponse({ message: "No queued/running jobs available" }, 200, cors);
    }

    const result = await processJob(supabase, job);
    return jsonResponse({ processed: [result] }, 200, cors);
  } catch (error) {
    const errorRef = crypto.randomUUID();
    console.error("ai-worker error:", { errorRef, error });
    return jsonResponse({ error: "Internal worker error", error_ref: errorRef }, 500, cors);
  }
});
