import { useState, useRef, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getEdgeAuthTroubleshootingMessage, invokeEdgeFunction } from "@/lib/edgeAuth";
import { recordTokenUsage } from "@/lib/tokenTracker";
import { getSelectedAiModel } from "@/lib/aiModelSelection";
import {
  AI_JOB_MAX_WAIT_MS,
  AI_JOB_POLL_INTERVAL_MS,
  getAdaptivePollInterval,
  buildAiJobStatusRequestBody,
  buildAiJobStatusSignature,
  isAiJobLikelyStalled,
} from "@/lib/aiJobPolling";
import type { AiJobStatusLike } from "@/lib/aiJobPolling";

export type JobStatus = "idle" | "uploading" | "queued" | "running" | "done" | "error" | "cancelled";

interface AiJobResult {
  success?: boolean;
  result?: unknown;
  data?: unknown;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
  meta?: Record<string, unknown>;
}

interface UseAiJobReturn {
  jobId: string | null;
  status: JobStatus;
  progress: number;
  chunksDone: number;
  chunksTotal: number;
  chunksError: number;
  result: AiJobResult | null;
  error: string | null;
  latencyMs: number | null;
  modelUsed: string | null;
  statusPayload: Record<string, unknown> | null;
  startJob: (payload: {
    type?: string;
    prompt: string;
    files: Array<{ bucket: string; path: string; filename: string; label: string }>;
    documentText?: string;
    bucket: string;
    mode?: string;
    requireFiles?: boolean;
    responseGuard?: unknown;
    maxValidationRetries?: number;
    model?: string;
    jsonMode?: boolean;
    configFlags?: Record<string, unknown>;
    debugActionKey?: string;
    debugPromptType?: string;
    systemPrompt?: string;
  }) => Promise<string | null>;
  cancelJob: () => Promise<void>;
  reset: () => void;
}

interface UseAiJobOptions {
  autoRecoverOnMount?: boolean;
}

const AI_JOB_SESSION_KEY = "active_ai_job_state_v1";
const AI_CLIENT_SESSION_ID_KEY = "ai_client_session_id_v1";
const AI_JOB_START_SOFT_TIMEOUT_MS = 12_000;
const AI_JOB_START_HARD_TIMEOUT_MS = 45_000;
const AI_JOB_START_SOFT_RECOVERY_DELAY_MS = 2_500;
const AI_JOB_START_RECOVERY_POLL_INTERVAL_MS = 1_200;
const AI_JOB_START_RECOVERY_WINDOW_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startAiJobRequest(body: Record<string, unknown>) {
  return await invokeEdgeFunction("ai-jobs", {
    body: { action: "start", ...body },
  });
}

function getOrCreateClientSessionId(): string {
  if (typeof window === "undefined") return `srv-${Date.now()}`;

  try {
    const existing = sessionStorage.getItem(AI_CLIENT_SESSION_ID_KEY);
    if (existing && existing.trim()) return existing.trim();
  } catch {
    // Ignore storage failures
  }

  const fallback =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `sess-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    sessionStorage.setItem(AI_CLIENT_SESSION_ID_KEY, fallback);
  } catch {
    // Ignore storage failures
  }
  return fallback;
}

interface PersistedAiJobState {
  jobId: string;
  status: JobStatus;
  progress: number;
  chunksDone: number;
  chunksTotal: number;
  chunksError: number;
  error: string | null;
  latencyMs: number | null;
  modelUsed: string | null;
  statusPayload?: Record<string, unknown> | null;
}

function readPersistedJobState(): PersistedAiJobState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(AI_JOB_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedAiJobState;
    if (!parsed || typeof parsed !== "object" || typeof parsed.jobId !== "string" || !parsed.jobId.trim()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePersistedJobState(state: PersistedAiJobState): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(AI_JOB_SESSION_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures
  }
}

function clearPersistedJobState(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(AI_JOB_SESSION_KEY);
  } catch {
    // Ignore storage failures
  }
}

function isHardReloadNavigation(): boolean {
  if (typeof window === "undefined") return false;

  try {
    const navEntries = typeof performance !== "undefined"
      ? performance.getEntriesByType("navigation")
      : [];
    const nav = navEntries[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === "reload") return true;
  } catch {
    // Ignore and fall back
  }

  try {
    const legacyNav = (performance as Performance & { navigation?: { type?: number } }).navigation;
    return legacyNav?.type === 1;
  } catch {
    return false;
  }
}

function withInvokeTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.floor(timeoutMs / 1000)}s`));
    }, timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJobNotFoundInvokeError(error: unknown, data?: unknown): boolean {
  const candidates: string[] = [];

  if (error instanceof Error && error.message) {
    candidates.push(error.message);
  } else if (typeof error === "string") {
    candidates.push(error);
  } else if (isPlainObject(error)) {
    const message = error.message;
    if (typeof message === "string") candidates.push(message);
    const details = error.details;
    if (typeof details === "string") candidates.push(details);
    const hint = error.hint;
    if (typeof hint === "string") candidates.push(hint);
    const context = error.context;
    if (typeof context === "string") candidates.push(context);
  }

  if (isPlainObject(data)) {
    const message = data.error;
    if (typeof message === "string") candidates.push(message);
    const details = data.details;
    if (typeof details === "string") candidates.push(details);
  }

  const haystack = candidates.join(" | ");
  return /job not found/i.test(haystack) || /returned 404/i.test(haystack);
}

export function useAiJob(options: UseAiJobOptions = {}): UseAiJobReturn {
  const autoRecoverOnMount = options.autoRecoverOnMount ?? true;
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [chunksDone, setChunksDone] = useState(0);
  const [chunksTotal, setChunksTotal] = useState(0);
  const [chunksError, setChunksError] = useState(0);
  const [result, setResult] = useState<AiJobResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);
  const [statusPayload, setStatusPayload] = useState<Record<string, unknown> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);
  const activeJobIdRef = useRef<string | null>(null);
  const pollGenerationRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const lastStatusSignatureRef = useRef("");
  const lastStatusChangeAtRef = useRef(0);
  const clientSessionIdRef = useRef<string>(getOrCreateClientSessionId());
  const recoverLatestJobRef = useRef<() => Promise<string | null>>(async () => null);
  const hydratedRef = useRef(false);
  const hydratingFromStorageRef = useRef(true);
  const manualStartRef = useRef(false);
  const serverProgressRef = useRef(0);
  const interpolationRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningStartRef = useRef<number>(0);
  const lastPersistWriteAtRef = useRef(0);

  const setTrackedJobId = useCallback((next: string | null) => {
    activeJobIdRef.current = next;
    setJobId(next);
  }, []);

  const stopInterpolation = useCallback(() => {
    if (interpolationRef.current) {
      clearInterval(interpolationRef.current);
      interpolationRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    pollGenerationRef.current += 1;
    pollInFlightRef.current = false;
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    stopInterpolation();
  }, [stopInterpolation]);

  // Smooth interpolation: while "running", gradually advance the displayed
  // progress from the server-reported value toward ~90% based on elapsed time.
  // Uses an asymptotic curve so it slows down as it approaches 90%.
  const startInterpolation = useCallback(() => {
    stopInterpolation();
    if (!runningStartRef.current) {
      runningStartRef.current = Date.now();
    }
    interpolationRef.current = setInterval(() => {
      const server = serverProgressRef.current;
      const elapsed = Date.now() - runningStartRef.current;
      // Asymptotic curve: approaches 90 over ~120s, never exceeds 90
      // Formula: target = server + (90 - server) * (1 - e^(-elapsed/60000))
      const ceiling = 90;
      const range = Math.max(0, ceiling - server);
      const target = server + range * (1 - Math.exp(-elapsed / 60000));
      const rounded = Math.min(ceiling, Math.floor(target));
      setProgress((prev) => Math.max(prev, rounded));
    }, 1_000);
  }, [stopInterpolation]);

  const reset = useCallback(() => {
    stopPolling();
    setTrackedJobId(null);
    setStatus("idle");
    setProgress(0);
    setChunksDone(0);
    setChunksTotal(0);
    setChunksError(0);
    setResult(null);
    setError(null);
    setLatencyMs(null);
    setModelUsed(null);
    setStatusPayload(null);
    serverProgressRef.current = 0;
    runningStartRef.current = 0;
    lastStatusSignatureRef.current = "";
    lastStatusChangeAtRef.current = 0;
    clearPersistedJobState();
    lastPersistWriteAtRef.current = 0;
  }, [setTrackedJobId, stopPolling]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const handleJobData = useCallback(
    (jobData: {
      status: string;
      progress: number;
      result: AiJobResult | null;
      error: string | null;
      model_used: string | null;
      latency_ms: number | null;
      chunks_total?: number;
      chunks_done?: number;
      chunks_error?: number;
    }): boolean => {
      const totalChunks = Number(jobData.chunks_total || 0);
      const doneChunks = Number(jobData.chunks_done || 0);
      const errorChunks = Number(jobData.chunks_error || 0);
      setChunksTotal(totalChunks);
      setChunksDone(doneChunks);
      setChunksError(errorChunks);

      // Track the real server-reported progress for interpolation baseline
      const serverCandidate =
        totalChunks > 0 && jobData.status !== "done"
          ? Math.max(jobData.progress || 0, Math.min(99, Math.floor((doneChunks / totalChunks) * 100)))
          : jobData.progress || 0;
      serverProgressRef.current = Math.max(serverProgressRef.current, serverCandidate);

      // For multi-chunk jobs with real progress, update directly
      if (totalChunks > 1 && jobData.status !== "done") {
        const chunkBased = Math.min(99, Math.floor((doneChunks / totalChunks) * 100));
        const candidate = Math.max(jobData.progress || 0, chunkBased);
        setProgress((prev) => Math.max(prev, candidate));
      }
      // For single-chunk or no-chunk jobs, let interpolation handle the smooth progress

      if (jobData.status === "queued") {
        setStatus("queued");
        setError(null);
        stopInterpolation();
      }

      if (jobData.status === "running") {
        setStatus("running");
        setError(null);
        // Start smooth interpolation for running jobs
        if (!interpolationRef.current) {
          startInterpolation();
        }
      }

      if (jobData.status === "done") {
        stopInterpolation();
        setStatus("done");
        setProgress(100);
        setResult(jobData.result);
        setLatencyMs(jobData.latency_ms);
        setModelUsed(jobData.model_used);
        setError(null);
        serverProgressRef.current = 0;
        runningStartRef.current = 0;

        if (jobData.result?.usage) {
          recordTokenUsage({
            inputTokens: jobData.result.usage.inputTokens,
            outputTokens: jobData.result.usage.outputTokens,
            model: jobData.model_used || "unknown",
          });
        }
        return true; // terminal
      }

      if (jobData.status === "error") {
        stopInterpolation();
        setStatus("error");
        setResult(jobData.result);
        setError(jobData.error || "Processing failed. Please retry.");
        setLatencyMs(jobData.latency_ms);
        serverProgressRef.current = 0;
        runningStartRef.current = 0;
        return true; // terminal
      }

      if (jobData.status === "cancelled") {
        stopInterpolation();
        setStatus("cancelled");
        setError("Job cancelled.");
        serverProgressRef.current = 0;
        runningStartRef.current = 0;
        return true; // terminal
      }

      if (jobData.status === "not_found") {
        stopInterpolation();
        setStatus("idle");
        setResult(null);
        setError("Previous AI job no longer exists. Start the action again.");
        setLatencyMs(null);
        setModelUsed(null);
        serverProgressRef.current = 0;
        runningStartRef.current = 0;
        return true; // terminal
      }

      return false; // keep polling
    },
    [startInterpolation, stopInterpolation],
  );

  const extractInvokeErrorMessage = useCallback((invokeError: unknown, data: unknown): string => {
    const base =
      typeof invokeError === "object" && invokeError !== null && "message" in invokeError
        ? String((invokeError as { message?: unknown }).message || "")
        : "";
    if (base && !/non-2xx/i.test(base)) {
      return getEdgeAuthTroubleshootingMessage(base) || base;
    }
    if (data && typeof data === "object" && "error" in (data as Record<string, unknown>)) {
      const serverError = (data as Record<string, unknown>).error;
      if (typeof serverError === "string" && serverError.trim()) {
        const normalized = serverError.trim();
        return getEdgeAuthTroubleshootingMessage(normalized) || normalized;
      }
    }
    if (base) {
      const jsonMatch = base.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
            const normalized = parsed.error.trim();
            return getEdgeAuthTroubleshootingMessage(normalized) || normalized;
          }
        } catch {
          // Ignore parse errors
        }
      }
      if (/non-2xx/i.test(base)) {
        return "Edge function returned an error. Check ai-jobs/ai-worker deployment and AI model settings, then retry.";
      }
      return base;
    }
    return "Failed to start AI processing";
  }, []);

  const pollStatus = useCallback(
    (id: string) => {
      const normalizedId = typeof id === "string" ? id.trim() : "";
      if (!normalizedId) {
        stopPolling();
        setTrackedJobId(null);
        setStatus("idle");
        setError("AI job reference was missing. Start the action again.");
        return;
      }

      activeJobIdRef.current = normalizedId;
      pollStartRef.current = Date.now();
      lastStatusSignatureRef.current = "";
      lastStatusChangeAtRef.current = Date.now();
      stopPolling();
      const pollGeneration = pollGenerationRef.current;
      let lastPollStatus: AiJobStatusLike | null = null;

      const scheduleNext = () => {
        if (pollGenerationRef.current !== pollGeneration) return;
        if (activeJobIdRef.current !== normalizedId) return;
        const interval = getAdaptivePollInterval(Date.now() - pollStartRef.current, lastPollStatus);
        pollRef.current = setTimeout(() => {
          void tick();
        }, interval);
      };

      const tick = async () => {
        if (pollGenerationRef.current !== pollGeneration) return;
        if (activeJobIdRef.current !== normalizedId) return;
        if (Date.now() - pollStartRef.current > AI_JOB_MAX_WAIT_MS) {
          stopPolling();
          if (activeJobIdRef.current !== normalizedId) return;
          setStatus("error");
          setError("Job timed out while waiting for completion. You can retry.");
          return;
        }
        if (pollInFlightRef.current) {
          scheduleNext();
          return;
        }

        pollInFlightRef.current = true;
        let terminal = false;
        try {
          const { data, error: invokeError } = await invokeEdgeFunction("ai-jobs", {
            body: buildAiJobStatusRequestBody(normalizedId),
          });

          if (invokeError) {
            if (isJobNotFoundInvokeError(invokeError, data)) {
              const recoveredJobId = await recoverLatestJobRef.current();
              if (recoveredJobId) {
                terminal = true;
                stopPolling();
                return;
              }
              stopPolling();
              if (activeJobIdRef.current === normalizedId) {
                setTrackedJobId(null);
                setStatus("idle");
                setProgress(0);
                setChunksDone(0);
                setChunksTotal(0);
                setChunksError(0);
                setResult(null);
                setError("Previous AI job no longer exists. Start the action again.");
                setLatencyMs(null);
                setModelUsed(null);
                setStatusPayload(null);
                clearPersistedJobState();
              }
              terminal = true;
              return;
            }
            console.warn("AI status poll error:", invokeError);
            return;
          }
          if (pollGenerationRef.current !== pollGeneration) return;
          if (activeJobIdRef.current !== normalizedId) return;

          setStatusPayload(data && typeof data === "object" ? (data as Record<string, unknown>) : null);

          const jobData = data as {
            status: string;
            progress: number;
            result: AiJobResult | null;
            error: string | null;
            model_used: string | null;
            latency_ms: number | null;
            chunks_total?: number;
            chunks_done?: number;
            chunks_error?: number;
            chunks_running?: number;
          };

          if (jobData.status === "not_found") {
            const recoveredJobId = await recoverLatestJobRef.current();
            if (recoveredJobId) {
              terminal = true;
              stopPolling();
              return;
            }
            stopPolling();
            if (activeJobIdRef.current === normalizedId) {
              setTrackedJobId(null);
              setStatus("idle");
              setProgress(0);
              setChunksDone(0);
              setChunksTotal(0);
              setChunksError(0);
              setResult(null);
              setError("Previous AI job no longer exists. Start the action again.");
              setLatencyMs(null);
              setModelUsed(null);
              setStatusPayload(data as Record<string, unknown>);
              clearPersistedJobState();
            }
            terminal = true;
            return;
          }

          const statusSignature = buildAiJobStatusSignature(jobData);
          if (statusSignature !== lastStatusSignatureRef.current) {
            lastStatusSignatureRef.current = statusSignature;
            lastStatusChangeAtRef.current = Date.now();
          }
          // Update backoff state for adaptive polling interval
          lastPollStatus = jobData;
          const { stalled, stalledForMs } = isAiJobLikelyStalled(jobData, lastStatusChangeAtRef.current || Date.now());
          if (stalled) {
            stopPolling();
            await invokeEdgeFunction("ai-jobs", {
              body: { action: "cancel", jobId: normalizedId },
            }).catch(() => null);
            setStatus("error");
            setError(
              `AI job stalled for ${Math.floor(stalledForMs / 1000)}s with no progress. Job cancelled; retry to continue.`,
            );
            terminal = true;
            return;
          }

          terminal = handleJobData(jobData);
          if (terminal) stopPolling();
        } catch (err) {
          if (isJobNotFoundInvokeError(err)) {
            const recoveredJobId = await recoverLatestJobRef.current();
            if (recoveredJobId) {
              terminal = true;
              stopPolling();
              return;
            }
            stopPolling();
            if (activeJobIdRef.current === normalizedId) {
              setTrackedJobId(null);
              setStatus("idle");
              setProgress(0);
              setChunksDone(0);
              setChunksTotal(0);
              setChunksError(0);
              setResult(null);
              setError("Previous AI job no longer exists. Start the action again.");
              setLatencyMs(null);
              setModelUsed(null);
              setStatusPayload(null);
              clearPersistedJobState();
            }
            terminal = true;
            return;
          }
          console.warn("ai-jobs poll exception:", err);
        } finally {
          pollInFlightRef.current = false;
        }

        if (!terminal) {
          scheduleNext();
        }
      };

      scheduleNext();
    },
    [stopPolling, handleJobData, setTrackedJobId],
  );

  const resumeJob = useCallback(
    async (id: string) => {
      const normalizedId = typeof id === "string" ? id.trim() : "";
      if (!normalizedId) {
        setTrackedJobId(null);
        setStatus("idle");
        setError("AI job reference was missing. Start the action again.");
        clearPersistedJobState();
        return;
      }

      if (manualStartRef.current) {
        return;
      }
      activeJobIdRef.current = normalizedId;
      try {
        const { data, error: invokeError } = await invokeEdgeFunction("ai-jobs", {
          body: buildAiJobStatusRequestBody(normalizedId),
        });
        if (manualStartRef.current) {
          return;
        }
        if (activeJobIdRef.current !== normalizedId) {
          return;
        }

        if (invokeError) {
          if (isJobNotFoundInvokeError(invokeError, data)) {
            const recoveredJobId = await recoverLatestJobRef.current();
            if (recoveredJobId) {
              return;
            }
            setTrackedJobId(null);
            setStatus("idle");
            setProgress(0);
            setChunksDone(0);
            setChunksTotal(0);
            setChunksError(0);
            setResult(null);
            setError("Previous AI job no longer exists. Start the action again.");
            setLatencyMs(null);
            setModelUsed(null);
            setStatusPayload(null);
            clearPersistedJobState();
            return;
          }
          const msg = extractInvokeErrorMessage(invokeError, data);
          setStatus("error");
          setError(msg);
          return;
        }

        setStatusPayload(data && typeof data === "object" ? (data as Record<string, unknown>) : null);

        const jobData = data as {
          status: string;
          progress: number;
          result: AiJobResult | null;
          error: string | null;
          model_used: string | null;
          latency_ms: number | null;
          chunks_total?: number;
          chunks_done?: number;
          chunks_error?: number;
          chunks_running?: number;
        };

        if (jobData.status === "not_found") {
          const recoveredJobId = await recoverLatestJobRef.current();
          if (recoveredJobId) {
            return;
          }
          setTrackedJobId(null);
          setStatus("idle");
          setProgress(0);
          setChunksDone(0);
          setChunksTotal(0);
          setChunksError(0);
          setResult(null);
          setError("Previous AI job no longer exists. Start the action again.");
          setLatencyMs(null);
          setModelUsed(null);
          setStatusPayload(data as Record<string, unknown>);
          clearPersistedJobState();
          return;
        }

        lastStatusSignatureRef.current = buildAiJobStatusSignature(jobData);
        lastStatusChangeAtRef.current = Date.now();

        const terminal = handleJobData(jobData);
        if (!terminal) {
          pollStatus(normalizedId);
        }
      } catch (err) {
        if (isJobNotFoundInvokeError(err)) {
          const recoveredJobId = await recoverLatestJobRef.current();
          if (recoveredJobId) {
            return;
          }
          setTrackedJobId(null);
          setStatus("idle");
          setProgress(0);
          setChunksDone(0);
          setChunksTotal(0);
          setChunksError(0);
          setResult(null);
          setError("Previous AI job no longer exists. Start the action again.");
          setLatencyMs(null);
          setModelUsed(null);
          setStatusPayload(null);
          clearPersistedJobState();
          return;
        }
        const msg = err instanceof Error ? err.message : "Failed to resume job status";
        setStatus("error");
        setError(msg);
      }
    },
    [extractInvokeErrorMessage, handleJobData, pollStatus, setTrackedJobId],
  );

  const recoverLatestJob = useCallback(async (): Promise<string | null> => {
    const sessionId = clientSessionIdRef.current;
    if (!sessionId) return null;
    if (manualStartRef.current) return null;

    try {
      const { data, error: invokeError } = await invokeEdgeFunction("ai-jobs", {
        body: {
          action: "recover_latest",
          clientSessionId: sessionId,
          types: ["generate_data", "pdf_compare", "text_compare", "filter_extract", "admin_action", "generic"],
        },
      });

      if (invokeError) {
        console.warn("AI recover_latest error:", invokeError);
        return null;
      }
      if (manualStartRef.current) return null;

      const payload = data as {
        job?: {
          jobId: string;
          status: string;
          progress: number;
          result: AiJobResult | null;
          error: string | null;
          model_used: string | null;
          latency_ms: number | null;
          chunks_total?: number;
          chunks_done?: number;
          chunks_error?: number;
        } | null;
      } | null;
      setStatusPayload(data && typeof data === "object" ? (data as Record<string, unknown>) : null);
      const job = payload?.job;
      if (!job?.jobId) return null;

      setTrackedJobId(job.jobId);
      lastStatusSignatureRef.current = buildAiJobStatusSignature({
        status: job.status,
        progress: job.progress,
        chunks_total: job.chunks_total,
        chunks_done: job.chunks_done,
        chunks_error: job.chunks_error,
      });
      lastStatusChangeAtRef.current = Date.now();
      const terminal = handleJobData({
        status: job.status,
        progress: job.progress,
        result: job.result || null,
        error: job.error || null,
        model_used: job.model_used || null,
        latency_ms: job.latency_ms || null,
        chunks_total: job.chunks_total,
        chunks_done: job.chunks_done,
        chunks_error: job.chunks_error,
      });
      if (!terminal) {
        pollStatus(job.jobId);
      }
      return job.jobId;
    } catch (err) {
      console.warn("AI recover_latest exception:", err);
      return null;
    }
  }, [handleJobData, pollStatus, setTrackedJobId]);

  useEffect(() => {
    recoverLatestJobRef.current = recoverLatestJob;
  }, [recoverLatestJob]);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    let cancelled = false;

    if (isHardReloadNavigation()) {
      clearPersistedJobState();
      hydratingFromStorageRef.current = false;
      return () => {
        cancelled = true;
      };
    }

    if (!autoRecoverOnMount) {
      clearPersistedJobState();
      hydratingFromStorageRef.current = false;
      return () => {
        cancelled = true;
      };
    }

    const restored = readPersistedJobState();
    if (!restored || !restored.jobId) {
      hydratingFromStorageRef.current = false;
      return () => {
        cancelled = true;
      };
    }
    const restoredIsActive = restored.status === "uploading" || restored.status === "queued" || restored.status === "running";
    if (!restoredIsActive) {
      clearPersistedJobState();
      hydratingFromStorageRef.current = false;
      return () => {
        cancelled = true;
      };
    }
    if (manualStartRef.current) {
      hydratingFromStorageRef.current = false;
      return () => {
        cancelled = true;
      };
    }

    setTrackedJobId(restored.jobId);
    setStatus(restored.status);
    setProgress(restored.progress || 0);
    setChunksDone(restored.chunksDone || 0);
    setChunksTotal(restored.chunksTotal || 0);
    setChunksError(restored.chunksError || 0);
    setError(restored.error || null);
    setLatencyMs(restored.latencyMs ?? null);
    setModelUsed(restored.modelUsed ?? null);
    setStatusPayload(restored.statusPayload ?? null);

    void resumeJob(restored.jobId).finally(() => {
      if (!cancelled) {
        hydratingFromStorageRef.current = false;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [autoRecoverOnMount, recoverLatestJob, resumeJob, setTrackedJobId]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (hydratingFromStorageRef.current) return;
    if (!jobId || status === "idle") {
      clearPersistedJobState();
      lastPersistWriteAtRef.current = 0;
      return;
    }

    const isTerminalStatus = status === "done" || status === "error" || status === "cancelled";
    if (isTerminalStatus) {
      clearPersistedJobState();
      lastPersistWriteAtRef.current = 0;
      return;
    }
    const now = Date.now();
    if (now - lastPersistWriteAtRef.current < 2_000) {
      return;
    }
    lastPersistWriteAtRef.current = now;

    writePersistedJobState({
      jobId,
      status,
      progress,
      chunksDone,
      chunksTotal,
      chunksError,
      error,
      latencyMs,
      modelUsed,
      statusPayload,
    });
  }, [jobId, status, progress, chunksDone, chunksTotal, chunksError, error, latencyMs, modelUsed, statusPayload]);

  const recoverLatestJobAfterStartFailure = useCallback(async (): Promise<string | null> => {
    const retryDelays = [250, 1_000, 2_500];
    manualStartRef.current = false;

    for (const delayMs of retryDelays) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      const recoveredJobId = await recoverLatestJob();
      if (recoveredJobId) {
        return recoveredJobId;
      }
    }

    return null;
  }, [recoverLatestJob]);

  const recoverLatestJobWhileStartPending = useCallback(async (): Promise<string | null> => {
    await sleep(AI_JOB_START_SOFT_RECOVERY_DELAY_MS);
    manualStartRef.current = false;

    const deadline = Date.now() + AI_JOB_START_RECOVERY_WINDOW_MS;
    while (Date.now() < deadline) {
      const recoveredJobId = await recoverLatestJob();
      if (recoveredJobId) {
        return recoveredJobId;
      }
      await sleep(AI_JOB_START_RECOVERY_POLL_INTERVAL_MS);
    }

    return null;
  }, [recoverLatestJob]);

  const startJob = useCallback(
    async (payload: Parameters<UseAiJobReturn["startJob"]>[0]): Promise<string | null> => {
      manualStartRef.current = true;
      hydratingFromStorageRef.current = false;
      reset();
      setStatus("queued");
      setProgress(0);

      try {
        const rawConfigFlags =
          payload.configFlags && typeof payload.configFlags === "object" ? payload.configFlags : {};
        const startBody = {
          ...payload,
          model: getSelectedAiModel(),
          clientSessionId: clientSessionIdRef.current,
          configFlags: {
            ...rawConfigFlags,
            singlePass: typeof rawConfigFlags.singlePass === "boolean" ? rawConfigFlags.singlePass : true,
            directFiles: typeof rawConfigFlags.directFiles === "boolean" ? rawConfigFlags.directFiles : true,
            disableCache: typeof rawConfigFlags.disableCache === "boolean" ? rawConfigFlags.disableCache : true,
          },
        };

        const invokeTask = withInvokeTimeout(
          startAiJobRequest(startBody),
          AI_JOB_START_HARD_TIMEOUT_MS,
          "AI job start",
        ).then(
          ({ data, error }) => ({
            kind: "invoke" as const,
            data,
            invokeError: error,
            thrownError: null as unknown,
          }),
          (error) => ({
            kind: "invoke" as const,
            data: null as unknown,
            invokeError: null as unknown,
            thrownError: error,
          }),
        );

        const recoverySuccessTask = (async () => {
          const recoveredJobId = await recoverLatestJobWhileStartPending();
          if (!recoveredJobId) {
            return await new Promise<never>(() => {});
          }
          return {
            kind: "recovered" as const,
            jobId: recoveredJobId,
          };
        })();

        const softTimeoutTask = (async () => {
          await sleep(AI_JOB_START_SOFT_TIMEOUT_MS);
          return {
            kind: "soft-timeout" as const,
          };
        })();

        let startOutcome = await Promise.race([invokeTask, recoverySuccessTask, softTimeoutTask]);

        if (startOutcome.kind === "soft-timeout") {
          setStatus("queued");
          setProgress((prev) => Math.max(prev, 5));
          const softRetryInvokeTask = withInvokeTimeout(
            startAiJobRequest(startBody),
            15_000,
            "AI job start soft retry",
          ).then(
            ({ data, error }) => ({
              kind: "invoke" as const,
              data,
              invokeError: error,
              thrownError: null as unknown,
            }),
            (error) => ({
              kind: "invoke" as const,
              data: null as unknown,
              invokeError: null as unknown,
              thrownError: error,
            }),
          );
          startOutcome = await Promise.race([invokeTask, softRetryInvokeTask, recoverySuccessTask]);
        }

        if (startOutcome.kind === "recovered") {
          return startOutcome.jobId;
        }

        const { data, invokeError, thrownError } = startOutcome;

        if (thrownError) {
          const retryResult = await withInvokeTimeout(startAiJobRequest(startBody), 10_000, "AI job start retry").then(
            ({ data, error }) => ({ data, invokeError: error, thrownError: null as unknown }),
            (error) => ({ data: null as unknown, invokeError: null as unknown, thrownError: error }),
          );

          if (!retryResult.thrownError && !retryResult.invokeError) {
            const retryData = retryResult.data as {
              jobId?: string;
              status?: string;
              progress?: number;
              result?: AiJobResult | null;
              error?: string | null;
              latency_ms?: number | null;
              model_used?: string | null;
              chunks_total?: number;
              chunks_done?: number;
              chunks_error?: number;
            };
            if (retryData?.jobId) {
              setTrackedJobId(retryData.jobId);
              setStatusPayload(
                retryResult.data && typeof retryResult.data === "object"
                  ? (retryResult.data as Record<string, unknown>)
                  : null,
              );
              if (retryData.status === "done" || retryData.status === "error") {
                handleJobData({
                  status: retryData.status,
                  progress: retryData.status === "done" ? 100 : retryData.progress || 0,
                  result: retryData.result || null,
                  error: retryData.error || null,
                  model_used: retryData.model_used || null,
                  latency_ms: retryData.latency_ms || null,
                  chunks_total: retryData.chunks_total,
                  chunks_done: retryData.chunks_done,
                  chunks_error: retryData.chunks_error,
                });
              } else {
                setStatus(retryData.status === "running" ? "running" : "queued");
                setProgress(retryData.progress || 5);
                pollStatus(retryData.jobId);
              }
              return retryData.jobId;
            }
          }

          const recoveredJobId = await recoverLatestJobAfterStartFailure();
          if (recoveredJobId) {
            return recoveredJobId;
          }
          const msg = thrownError instanceof Error ? thrownError.message : "Failed to start processing";
          setStatus("error");
          setError(msg);
          return null;
        }

        if (invokeError) {
          const retryResult = await withInvokeTimeout(startAiJobRequest(startBody), 10_000, "AI job start retry").then(
            ({ data, error }) => ({ data, invokeError: error, thrownError: null as unknown }),
            (error) => ({ data: null as unknown, invokeError: null as unknown, thrownError: error }),
          );

          if (!retryResult.thrownError && !retryResult.invokeError) {
            const retryData = retryResult.data as {
              jobId?: string;
              status?: string;
              progress?: number;
              result?: AiJobResult | null;
              error?: string | null;
              latency_ms?: number | null;
              model_used?: string | null;
              chunks_total?: number;
              chunks_done?: number;
              chunks_error?: number;
            };
            if (retryData?.jobId) {
              setTrackedJobId(retryData.jobId);
              setStatusPayload(
                retryResult.data && typeof retryResult.data === "object"
                  ? (retryResult.data as Record<string, unknown>)
                  : null,
              );
              if (retryData.status === "done" || retryData.status === "error") {
                handleJobData({
                  status: retryData.status,
                  progress: retryData.status === "done" ? 100 : retryData.progress || 0,
                  result: retryData.result || null,
                  error: retryData.error || null,
                  model_used: retryData.model_used || null,
                  latency_ms: retryData.latency_ms || null,
                  chunks_total: retryData.chunks_total,
                  chunks_done: retryData.chunks_done,
                  chunks_error: retryData.chunks_error,
                });
              } else {
                setStatus(retryData.status === "running" ? "running" : "queued");
                setProgress(retryData.progress || 5);
                pollStatus(retryData.jobId);
              }
              return retryData.jobId;
            }
          }

          const recoveredJobId = await recoverLatestJobAfterStartFailure();
          if (recoveredJobId) {
            return recoveredJobId;
          }
          let msg = extractInvokeErrorMessage(invokeError, data);
          if (/failed to send a request to the edge function/i.test(msg)) {
            msg = "Cannot reach Edge Functions. Deploy ai-jobs and ai-worker, then hard-refresh.";
          }
          setStatus("error");
          setError(msg);
          return null;
        }

        const startData = data as {
          jobId: string;
          status: string;
          progress?: number;
          result?: AiJobResult | null;
          error?: string | null;
          latency_ms?: number | null;
          model_used?: string | null;
          chunks_total?: number;
          chunks_done?: number;
          chunks_error?: number;
        };

        if (!startData?.jobId) {
          const recoveredJobId = await recoverLatestJobAfterStartFailure();
          if (recoveredJobId) {
            return recoveredJobId;
          }
          setStatus("error");
          setError("No job ID returned from server");
          return null;
        }

        setTrackedJobId(startData.jobId);
        setStatusPayload(data && typeof data === "object" ? (data as Record<string, unknown>) : null);

        // The start response now includes the final status if the worker completed synchronously.
        // If start reports an error caused by worker trigger timeout, keep polling this job.
        const startErrorMessage = typeof startData.error === "string" ? startData.error : "";
        const startErrorIsRecoverableTimeout =
          startData.status === "error" && /trigger_timeout/i.test(startErrorMessage);
        if ((startData.status === "done" || startData.status === "error") && !startErrorIsRecoverableTimeout) {
          handleJobData({
            status: startData.status,
            progress: startData.status === "done" ? 100 : 0,
            result: startData.result || null,
            error: startData.error || null,
            model_used: startData.model_used || null,
            latency_ms: startData.latency_ms || null,
            chunks_total: startData.chunks_total,
            chunks_done: startData.chunks_done,
            chunks_error: startData.chunks_error,
          });
          return startData.jobId;
        }

        // Job still processing — start polling
        setStatus(startData.status === "running" ? "running" : "queued");
        setProgress(startData.progress || 5);
        pollStatus(startData.jobId);

        return startData.jobId;
      } finally {
        manualStartRef.current = false;
      }
    },
    [
      reset,
      pollStatus,
      handleJobData,
      extractInvokeErrorMessage,
      setTrackedJobId,
      recoverLatestJobAfterStartFailure,
      recoverLatestJobWhileStartPending,
    ],
  );

  const cancelJob = useCallback(async () => {
    stopPolling();
    if (jobId) {
      try {
        await invokeEdgeFunction("ai-jobs", {
          body: { action: "cancel", jobId },
        });
      } catch {
        /* best effort */
      }
    }
    setStatus("cancelled");
    setProgress(0);
    setError("Job cancelled.");
  }, [jobId, stopPolling]);

  return {
    jobId,
    status,
    progress,
    chunksDone,
    chunksTotal,
    chunksError,
    result,
    error,
    latencyMs,
    modelUsed,
    statusPayload,
    startJob,
    cancelJob,
    reset,
  };
}
