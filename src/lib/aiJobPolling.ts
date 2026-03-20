export const AI_JOB_POLL_INTERVAL_MS = 1_500;
export const AI_JOB_MAX_WAIT_MS = 15 * 60_000;
export const AI_JOB_STALLED_STATUS_WINDOW_MS = 3 * 60_000;
export const AI_JOB_STALLED_STATUS_WINDOW_DIRECT_FILES_MS = 6 * 60_000;
export const AI_JOB_STALLED_STATUS_WINDOW_LARGE_PAYLOAD_MS = 8 * 60_000;
export const AI_JOB_DEBUG_STORAGE_KEY = "ai_job_debug_enabled_v1";

export interface AiJobStatusLike {
  status?: string | null;
  progress?: number | null;
  chunks_total?: number | null;
  chunks_done?: number | null;
  chunks_running?: number | null;
  chunks_error?: number | null;
  updated_at?: string | null;
  timing?: unknown;
}

/**
 * Returns an adaptive poll interval based on elapsed time and job state.
 * Time-based back-off is applied unconditionally so that even jobs whose
 * chunk rows appear late (worker preflight, phase-split gap) still reduce
 * poll frequency.  Chunk / status signals only refine the early phase.
 *
 * Typical reduction: ~68 polls → ~20 polls for a 110 s job.
 */
export function getAdaptivePollInterval(
  elapsedMs: number,
  status?: AiJobStatusLike | null,
): number {
  const chunksRunning = asNumber(status?.chunks_running);
  const chunksTotal  = asNumber(status?.chunks_total);
  const statusValue  = (status?.status ?? "").toLowerCase();

  // Keep completion detection responsive for active running jobs, even late-phase.
  // This trims post-completion UI lag (poll catch-up) without affecting model time.
  if (statusValue === "running" && chunksRunning > 0) {
    if (elapsedMs > 60_000) return 3_000;
    if (elapsedMs > 30_000) return 4_000;
  }

  // ── Time-based back-off (always applied first) ──────────────
  if (elapsedMs > 90_000) return 8_000;
  if (elapsedMs > 60_000) return 8_000;
  if (elapsedMs > 30_000) return 6_000;

  // ── Early phase (< 30 s): use chunk / status signals ────────
  // Worker is actively processing chunks
  if (chunksRunning > 0) return 4_000;

  // Chunks exist but none running (inter-phase gap or all queued)
  if (chunksTotal > 0) return 3_000;

  // Job marked running by the worker but no chunks yet (preflight)
  if (statusValue === "running" && elapsedMs > 10_000) return 3_000;
  if (statusValue === "running" && elapsedMs > 5_000)  return 2_500;

  // Job just queued — poll quickly for fast initial feedback
  return AI_JOB_POLL_INTERVAL_MS; // 1.5 s
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStallWindowMs(payload: AiJobStatusLike): number {
  const timing = asObject(payload.timing);
  const directFilesMode = Boolean(timing?.direct_files_mode);
  const totalFileBytes = asNumber(timing?.total_file_bytes);

  let windowMs = AI_JOB_STALLED_STATUS_WINDOW_MS;
  if (directFilesMode) {
    // Direct-file compare jobs can stay "running @ 10%" while a long chunk is processed.
    windowMs = Math.max(windowMs, AI_JOB_STALLED_STATUS_WINDOW_DIRECT_FILES_MS);
  }
  if (totalFileBytes >= 10_000_000) {
    // Large uploads need a longer no-change budget before we conclude "stalled".
    windowMs = Math.max(windowMs, AI_JOB_STALLED_STATUS_WINDOW_LARGE_PAYLOAD_MS);
  }
  return windowMs;
}

export function buildAiJobStatusSignature(payload: AiJobStatusLike): string {
  return [
    payload.status || "",
    asNumber(payload.progress),
    asNumber(payload.chunks_total),
    asNumber(payload.chunks_done),
    asNumber(payload.chunks_running),
    asNumber(payload.chunks_error),
  ].join("|");
}

export function isAiJobLikelyStalled(
  payload: AiJobStatusLike,
  lastStatusChangeAtMs: number,
  nowMs = Date.now(),
): { stalled: boolean; stalledForMs: number; stallWindowMs: number } {
  const statusValue = payload.status || "running";
  const timing = asObject(payload.timing);
  const statusUpdatedAtMs = parseTimeMs(payload.updated_at);
  const watchdogTouchedAtMs = parseTimeMs(timing?.watchdog_last_run_at);
  const activityAnchorMs = Math.max(
    lastStatusChangeAtMs || 0,
    statusUpdatedAtMs || 0,
    watchdogTouchedAtMs || 0,
  );
  const stalledForMs = Math.max(0, nowMs - activityAnchorMs);
  const stallWindowMs = getStallWindowMs(payload);
  const looksStalled = (statusValue === "queued" || statusValue === "running")
    && stalledForMs >= stallWindowMs
    && (
      asNumber(payload.chunks_running) > 0
      || (statusValue === "queued" && asNumber(payload.chunks_total) === 0)
    );

  return { stalled: looksStalled, stalledForMs, stallWindowMs };
}

export function isAiJobDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AI_JOB_DEBUG_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setAiJobDebugEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AI_JOB_DEBUG_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage errors
  }
}

export function buildAiJobStatusRequestBody(jobId: string): Record<string, unknown> {
  const normalizedJobId = typeof jobId === "string" ? jobId.trim() : "";
  if (!normalizedJobId) {
    throw new Error("Cannot request AI job status without a valid jobId.");
  }
  return isAiJobDebugEnabled()
    ? { action: "status", jobId: normalizedJobId, debug: true }
    : { action: "status", jobId: normalizedJobId };
}

export function buildAiJobListRequestBody(limit: number, autoCancelStale = false): Record<string, unknown> {
  const body: Record<string, unknown> = {
    action: "list",
    limit,
    autoCancelStale,
  };
  if (isAiJobDebugEnabled()) {
    body.debug = true;
  }
  return body;
}
