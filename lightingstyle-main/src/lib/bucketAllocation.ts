import { SUPABASE_ANON_KEY } from "@/config/publicEnv";
import { ensureEdgeAuthSession, getEdgeAuthTroubleshootingMessage } from "@/lib/edgeAuth";
import { supabase } from "@/integrations/supabase/client";

// ── Transient buckets for product entry AI (rotate to handle concurrency) ──
const PRODUCT_BUCKETS = [
  "document-uploads-1",
  "document-uploads-2",
  "document-uploads-3",
  "document-uploads-4",
];

// ── Dedicated transient bucket for Compare Two Datasheets ──
const COMPARE_BUCKET = "document-uploads-compare";

// ── Persistent bucket for admin constants ──
export const CONSTANTS_BUCKET = "document-uploads-constant";
export const FORM_IMPORTS_BUCKET = "document-uploads-form-json";

const UPLOAD_PREFIX_KEY = "bucket_upload_prefix";
const LEGACY_UPLOAD_PREFIX_KEY = "bucket_session_id";
const IS_PUBLISHABLE_KEY = SUPABASE_ANON_KEY.startsWith("sb_publishable_");
let inMemoryUploadPrefix: string | null = null;

// ── Upload prefix (unique per browser tab) ───────────────────────

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function getUploadPrefix(): string {
  const storage = getSessionStorage();
  let id =
    storage?.getItem(UPLOAD_PREFIX_KEY) ||
    storage?.getItem(LEGACY_UPLOAD_PREFIX_KEY) ||
    inMemoryUploadPrefix;
  if (!id) {
    // Use high-entropy, non-guessable IDs to reduce cross-session path guessing risk.
    const entropy = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
    id = `s_${entropy}`;
  }
  inMemoryUploadPrefix = id;
  storage?.setItem(UPLOAD_PREFIX_KEY, id);
  storage?.setItem(LEGACY_UPLOAD_PREFIX_KEY, id);
  return id;
}

// ── Shuffle for random ordering ──────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function ensureStorageUploadSession(): Promise<void> {
  await ensureEdgeAuthSession();
  if (!IS_PUBLISHABLE_KEY) return;

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw new Error(`Could not verify Supabase auth before PDF upload: ${error.message}`);
  }

  if (data.session?.access_token) return;

  throw new Error(
    "Anonymous auth is required before uploading PDFs to Supabase Storage. Enable Supabase Auth -> Providers -> Anonymous, then retry.",
  );
}

function normalizeStorageUploadError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown upload error");
  const authHint = getEdgeAuthTroubleshootingMessage(message);
  if (authHint) return new Error(authHint);
  if (/failed to fetch|networkerror/i.test(message)) {
    return new Error(
      IS_PUBLISHABLE_KEY
        ? "Could not upload PDFs to Supabase Storage. Verify anonymous auth and Storage access for this environment, then retry."
        : "Could not upload PDFs to Supabase Storage. Check your connection and retry.",
    );
  }
  return error instanceof Error ? error : new Error(message);
}

// ── Allocate a free bucket from a pool ──────────────────────────

async function allocateBucketFromPool(pool: string[]): Promise<string | null> {
  const shuffled = shuffle(pool);
  return shuffled[0] ?? null;
}

// ── Clean all files from a bucket for this session ───────────────

export async function cleanBucket(bucket: string): Promise<void> {
  const uploadPrefix = getUploadPrefix();
  try {
    const { data: subFiles } = await supabase.storage
      .from(bucket)
      .list(uploadPrefix, { limit: 500 });
    if (subFiles && subFiles.length > 0) {
      const paths = subFiles.map((f) => `${uploadPrefix}/${f.name}`);
      await supabase.storage.from(bucket).remove(paths);
    }
  } catch (err) {
    console.warn("cleanBucket error (non-fatal):", err);
  }
}

export async function releaseBucketLock(bucket: string): Promise<void> {
  void bucket;
}

// ── Upload files to a specific bucket ────────────────────────────

export async function uploadFilesToBucket(
  bucket: string,
  files: Array<{ file: File; label: string }>
): Promise<Array<{ bucket: string; path: string; filename: string; label: string }>> {
  await ensureStorageUploadSession();

  const uniqueFiles: Array<{ file: File; label: string }> = [];
  const seenFileKeys = new Set<string>();
  for (const fileEntry of files) {
    const normalizedName = (fileEntry.file.name || "").trim().toLowerCase();
    const dedupeKey = `${normalizedName}::${fileEntry.file.size}::${fileEntry.file.lastModified}`;
    if (seenFileKeys.has(dedupeKey)) continue;
    seenFileKeys.add(dedupeKey);
    uniqueFiles.push(fileEntry);
  }

  const uploadPrefix = getUploadPrefix();
  const uploadBatchId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const uploads = uniqueFiles.map(async ({ file, label }) => {
    const sanitized = `${uploadPrefix}/${uploadBatchId}/${label}-${file.name}`
      .replace(/[^\x20-\x7E/]/g, "_")
      .replace(/\s+/g, "_");

    try {
      const { error } = await supabase.storage
        .from(bucket)
        .upload(sanitized, file, { upsert: true });

      if (error) throw error;
      return { bucket, path: sanitized, filename: file.name, label };
    } catch (error) {
      throw normalizeStorageUploadError(error);
    }
  });

  return Promise.all(uploads);
}

export async function uploadJsonToFormImportBucket(
  payload: unknown,
  options?: {
    filenamePrefix?: string;
    label?: string;
    pathPrefix?: string;
    fixedFilename?: string;
  },
): Promise<{ bucket: string; path: string; filename: string; label: string }> {
  await ensureStorageUploadSession();

  const safePrefix = String(options?.filenamePrefix ?? "form-import")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "form-import";
  const safeFixedFilename = String(options?.fixedFilename ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-");
  const filename = safeFixedFilename || `${safePrefix}-${Date.now()}.json`;
  const file = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const uploadPrefix = getUploadPrefix();
  const rootPrefix = String(options?.pathPrefix ?? "form-imports")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/") || "form-imports";
  const path = safeFixedFilename
    ? `${rootPrefix}/${uploadPrefix}/${filename}`
    : `${rootPrefix}/${uploadPrefix}/${Date.now()}-${filename}`;
  try {
    const { error } = await supabase.storage
      .from(FORM_IMPORTS_BUCKET)
      .upload(path, file, { upsert: true, contentType: "application/json" });

    if (error) throw error;
  } catch (error) {
    throw normalizeStorageUploadError(error);
  }

  return {
    bucket: FORM_IMPORTS_BUCKET,
    path,
    filename,
    label: options?.label ?? "json",
  };
}

async function removeUploadedFiles(
  bucket: string,
  fileRefs: Array<{ path: string }>,
): Promise<void> {
  const paths = fileRefs.map((ref) => ref.path).filter(Boolean);
  if (paths.length === 0) return;
  await supabase.storage.from(bucket).remove(paths);
}

/**
 * Allocate a bucket from the product pool without auto-cleanup.
 * Used by the async job pipeline where the worker handles cleanup.
 */
export async function allocateProductBucket(): Promise<string | null> {
  let bucket: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    bucket = await allocateBucketFromPool(PRODUCT_BUCKETS);
    if (bucket) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
  }
  return bucket;
}

// ── Core withBucket logic ─────────────────────────────────────────

async function withSpecificBucket<T>(
  bucketName: string,
  files: Array<{ file: File; label: string }>,
  callback: (fileRefs: Array<{ bucket: string; path: string; filename: string; label: string }>) => Promise<T>
): Promise<T> {
  try {
    const fileRefs = await uploadFilesToBucket(bucketName, files);
    const result = await callback(fileRefs);
    return result;
  } finally {
    await cleanBucket(bucketName);
  }
}

// ── Main public API: transient bucket for product AI calls ───────

/**
 * Allocate from the product bucket pool (1-4), upload files, run callback,
 * then delete all files and release the bucket.
 */
export async function withBucket<T>(
  files: Array<{ file: File; label: string }>,
  callback: (fileRefs: Array<{ bucket: string; path: string; filename: string; label: string }>) => Promise<T>
): Promise<T> {
  // Retry allocation up to 3 times
  let bucket: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    bucket = await allocateBucketFromPool(PRODUCT_BUCKETS);
    if (bucket) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
  }

  if (!bucket) {
    throw new Error(
      "All upload slots are currently in use. Please try again in a few minutes."
    );
  }

  try {
    const fileRefs = await uploadFilesToBucket(bucket, files);
    const result = await callback(fileRefs);
    return result;
  } finally {
    await cleanBucket(bucket);
  }
}

/**
 * Use the dedicated Compare Two Datasheets bucket.
 * No lock-file rotation needed — it's a single dedicated bucket.
 */
export async function withCompareBucket<T>(
  files: Array<{ file: File; label: string }>,
  callback: (fileRefs: Array<{ bucket: string; path: string; filename: string; label: string }>) => Promise<T>
): Promise<T> {
  let fileRefs: Array<{ bucket: string; path: string; filename: string; label: string }> = [];
  try {
    fileRefs = await uploadFilesToBucket(COMPARE_BUCKET, files);
    return await callback(fileRefs);
  } finally {
    // Compare cleanup should not block showing results.
    // Remove only this run's uploaded paths to avoid races with subsequent runs.
    if (fileRefs.length > 0) {
      void removeUploadedFiles(COMPARE_BUCKET, fileRefs).catch(() => undefined);
    }
  }
}

export async function uploadFilesToCompareBucket(
  files: Array<{ file: File; label: string }>,
): Promise<Array<{ bucket: string; path: string; filename: string; label: string }>> {
  return uploadFilesToBucket(COMPARE_BUCKET, files);
}

export async function removeCompareUploadedFiles(
  fileRefs: Array<{ bucket: string; path: string; filename: string; label: string }>,
): Promise<void> {
  await removeUploadedFiles(COMPARE_BUCKET, fileRefs);
}

/** Get the list of all transient bucket names (for admin/cleanup) */
export function getBucketNames() {
  return [...PRODUCT_BUCKETS, COMPARE_BUCKET];
}
