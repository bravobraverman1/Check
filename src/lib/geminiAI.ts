import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/config/publicEnv";
import { getEdgeAuthTroubleshootingMessage, invokeEdgeFunction } from "@/lib/edgeAuth";
import { recordTokenUsage } from "@/lib/tokenTracker";
import { AI_ENFORCED_MODEL } from "@/lib/aiPipelineConstants";
import { getSelectedAiModel } from "@/lib/aiModelSelection";
import {
  AI_JOB_MAX_WAIT_MS,
  AI_JOB_POLL_INTERVAL_MS,
  getAdaptivePollInterval,
  buildAiJobStatusSignature,
  buildAiJobStatusRequestBody,
  isAiJobLikelyStalled,
} from "@/lib/aiJobPolling";
import type { AiJobStatusLike } from "@/lib/aiJobPolling";

const ENFORCED_MODEL_FALLBACK = AI_ENFORCED_MODEL;
const AI_JOB_START_TIMEOUT_MS = 20_000;
const AI_JOB_STATUS_TIMEOUT_MS = 15_000;
const AI_JOB_CANCEL_TIMEOUT_MS = 5_000;

function getClientModel(): string {
  return getSelectedAiModel() || ENFORCED_MODEL_FALLBACK;
}

export interface GeminiProcessRequest {
  prompt: string;
  mode: "text" | "json";
  documentText?: string;
  singlePass?: boolean;
  model?: string;
  requireFiles?: boolean;
  responseGuard?: GeminiResponseGuard;
  maxValidationRetries?: number;
  configFlags?: Record<string, unknown>;
  debugActionKey?: string;
  debugPromptType?: string;
  systemPrompt?: string; // Sent as Gemini's systemInstruction for efficient processing
  type?: "pdf_compare" | "generate_data" | "text_compare" | "filter_extract" | "admin_action" | "generic";
  onProgress?: (progress: {
    jobId: string;
    status: string;
    progress: number;
    chunksTotal: number;
    chunksDone: number;
    chunksError: number;
    pollCount?: number;
    statusEndpoint?: string;
    statusPayload?: Record<string, unknown>;
  }) => void;
  files?: Array<{
    bucket: string;
    path: string;
    filename?: string;
    label?: string;
  }>;
}

export interface GeminiProcessResponse {
  success?: boolean;
  result?: string | Record<string, unknown> | Array<unknown>;
  data?: string | Record<string, unknown> | Array<unknown>;
  mode?: string;
  error?: string;
  details?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  meta?: {
    latencyMs?: number;
    fileCount?: number;
    model?: string;
    attempts?: number;
    retryUsed?: boolean;
    modelsTried?: string[];
    validationRetriesUsed?: number;
    compareRecoveryUsed?: boolean;
    compareEmptyAfterRecovery?: boolean;
    compareDiscoveryUsed?: boolean;
    compareOneSidedRepairUsed?: boolean;
    sectionRecoveryUsed?: boolean;
    chunksTotal?: number;
    chunksDone?: number;
    chunksError?: number;
    debug?: Record<string, unknown>;
  };
}

export interface GeminiResponseGuard {
  requiredSections?: string[];
  minTextLength?: number;
  requiredJsonKeys?: string[];
  minJsonProperties?: number;
  minJsonItems?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeGeminiResponsePayload(data: unknown): GeminiProcessResponse {
  if (!data || typeof data !== "object") {
    return {};
  }

  const payload = data as Record<string, unknown>;
  const normalizedResult = payload.result ?? payload.data;

  return {
    ...(payload as GeminiProcessResponse),
    ...(normalizedResult !== undefined ? { result: normalizedResult as GeminiProcessResponse["result"] } : {}),
    ...(payload.data !== undefined
      ? { data: payload.data as GeminiProcessResponse["data"] }
      : normalizedResult !== undefined
        ? { data: normalizedResult as GeminiProcessResponse["data"] }
        : {}),
  };
}

function parseJsonResult(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function normalizeInvokeError(error: unknown): GeminiProcessResponse {
  console.error("Error calling AI job pipeline:", error);
  let detail = "";

  try {
    if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
      const message = (error as { message: string }).message;
      const jsonMatch = message.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        detail = parsed.error || message;
      } else {
        detail = message;
      }
    } else {
      detail = JSON.stringify(error);
    }
  } catch {
    detail = error instanceof Error ? error.message : JSON.stringify(error);
  }

  if (/abort|timed?\s*out|signal/i.test(detail)) {
    detail = "AI processing timed out. Please retry.";
  }
  if (/failed to send a request to the edge function/i.test(detail)) {
    detail = "Cannot reach Supabase Edge Functions. Deploy ai-jobs and ai-worker, then hard-refresh the app.";
  }
  const edgeAuthHint = getEdgeAuthTroubleshootingMessage(detail);
  if (edgeAuthHint) {
    detail = edgeAuthHint;
  }

  return {
    success: false,
    error: detail || "Failed to process AI request",
    details: detail,
    meta: {
      model: getClientModel(),
      debug: {
        invoke_error: detail,
      },
    },
  };
}

function inferType(request: GeminiProcessRequest): GeminiProcessRequest["type"] {
  if (request.type) return request.type;

  const labels = (request.files || [])
    .map((f) => (f.label || "").toLowerCase());

  if (labels.includes("supplier") && labels.includes("ls")) {
    return "pdf_compare";
  }

  if ((request.files || []).length > 0) {
    return "generate_data";
  }

  if (request.documentText?.trim()) {
    return "text_compare";
  }

  return "generic";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactStatusPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const debug = isPlainObject(payload.debug) ? payload.debug : {};
  const chunkDetails = Array.isArray(debug.chunk_details)
    ? debug.chunk_details.slice(0, 40).map((item) => {
      if (!isPlainObject(item)) return item;
      return {
        chunk_index: item.chunk_index ?? null,
        chunk_type: item.chunk_type ?? null,
        status: item.status ?? null,
        latency_ms: item.latency_ms ?? null,
        error: item.error ?? null,
        text_chars: item.text_chars ?? null,
        timing: item.timing ?? null,
      };
    })
    : [];
  return {
    status: payload.status ?? null,
    progress: payload.progress ?? 0,
    error: payload.error ?? null,
    model_used: payload.model_used ?? null,
    latency_ms: payload.latency_ms ?? null,
    chunks_total: payload.chunks_total ?? 0,
    chunks_done: payload.chunks_done ?? 0,
    chunks_error: payload.chunks_error ?? 0,
    chunks_queued: payload.chunks_queued ?? 0,
    chunks_running: payload.chunks_running ?? 0,
    chunks_cancelled: payload.chunks_cancelled ?? 0,
    timing: payload.timing ?? null,
    debug: {
      source: debug.source ?? null,
      observed_at: debug.observed_at ?? null,
      pipeline_hint: debug.pipeline_hint ?? null,
      request_summary: debug.request_summary ?? null,
      chunk_details: chunkDetails,
    },
  };
}

async function invokeAiJobsWithTimeout(
  body: Record<string, unknown>,
  timeoutMs: number,
  actionLabel: string,
): Promise<{ data: unknown; error: unknown }> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ data: unknown; error: unknown }>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        data: null,
        error: new Error(`ai-jobs ${actionLabel} timed out after ${Math.floor(timeoutMs / 1000)}s`),
      });
    }, timeoutMs);
  });

  const result = await Promise.race([
    invokeEdgeFunction("ai-jobs", { body }),
    timeoutPromise,
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  return result;
}

async function invokeStart(
  startPayload: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  return invokeAiJobsWithTimeout(
    { action: "start", ...startPayload },
    AI_JOB_START_TIMEOUT_MS,
    "start",
  );
}

/**
 * Call the unified AI job pipeline (ai-jobs -> ai-worker -> ai-jobs status).
 * No UI component should bypass this and invoke edge functions directly.
 */
export async function callGeminiProcessor(
  request: GeminiProcessRequest,
): Promise<GeminiProcessResponse> {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return {
        success: false,
        error: "Supabase not configured",
        details: "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY",
      };
    }

    const type = inferType(request);
    const onProgress = request.onProgress;
    const singlePass = typeof request.singlePass === "boolean"
      ? request.singlePass
      : true;
    const requestedFlags = isPlainObject(request.configFlags)
      ? request.configFlags
      : {};
    const configFlags = {
      ...requestedFlags,
      singlePass: typeof requestedFlags.singlePass === "boolean"
        ? requestedFlags.singlePass
        : singlePass,
      directFiles: typeof requestedFlags.directFiles === "boolean"
        ? requestedFlags.directFiles
        : true,
      disableCache: typeof requestedFlags.disableCache === "boolean"
        ? requestedFlags.disableCache
        : true,
    };
    const clientStartedAt = Date.now();
    const debugEvents: Array<Record<string, unknown>> = [];
    let pollCount = 0;

    const maxValidationRetriesRaw = Number(request.maxValidationRetries ?? 0);
    const maxValidationRetries = Number.isFinite(maxValidationRetriesRaw) && maxValidationRetriesRaw >= 0
      ? Math.min(1, Math.floor(maxValidationRetriesRaw))
      : 0;
    const modelForRequest = getClientModel();
    const effectivePrompt = request.prompt;

    const startPayload: Record<string, unknown> = {
      type,
      prompt: effectivePrompt,
      documentText: request.documentText || "",
      files: request.files || [],
      requireFiles: Boolean(request.requireFiles),
      responseGuard: request.responseGuard || null,
      maxValidationRetries,
      jsonMode: request.mode === "json",
      mode: request.mode,
      model: modelForRequest,
      configFlags,
      ...(typeof request.debugActionKey === "string" && request.debugActionKey.trim()
        ? { debugActionKey: request.debugActionKey.trim() }
        : {}),
      ...(typeof request.debugPromptType === "string" && request.debugPromptType.trim()
        ? { debugPromptType: request.debugPromptType.trim() }
        : {}),
      ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    };
    debugEvents.push({
      t: new Date().toISOString(),
      stage: "start_request",
      type,
      mode: request.mode,
      config_flags: configFlags,
      has_files: Array.isArray(request.files) ? request.files.length : 0,
      document_text_chars: (request.documentText || "").length,
    });

    const {
      data: startData,
      error: startError,
    } = await invokeStart(startPayload);

    if (startError) {
      debugEvents.push({
        t: new Date().toISOString(),
        stage: "start_error",
        error: startError,
      });
      return normalizeInvokeError(startError);
    }

    const jobId = (startData as { jobId?: string } | null)?.jobId;
    debugEvents.push({
      t: new Date().toISOString(),
      stage: "start_response",
      response: startData,
      jobId: jobId || null,
    });
    if (!jobId) {
      return {
        success: false,
        error: "No job ID returned from ai-jobs",
        meta: {
          model: modelForRequest,
          latencyMs: Date.now() - clientStartedAt,
          debug: {
            events: debugEvents,
          },
        },
      };
    }

    onProgress?.({
      jobId,
      status: "queued",
      progress: 0,
      chunksTotal: 0,
      chunksDone: 0,
      chunksError: 0,
      pollCount: 0,
      statusEndpoint: "ai-jobs",
    });

    const pollStarted = Date.now();
    let lastStatusSignature = "";
    let lastStatusChangeAt = Date.now();
    let currentPollInterval = AI_JOB_POLL_INTERVAL_MS;
    let lastStatusPayloadForBackoff: AiJobStatusLike | null = null;

    while (Date.now() - pollStarted < AI_JOB_MAX_WAIT_MS) {
      await sleep(currentPollInterval);
      pollCount += 1;

      const { data: statusData, error: statusError } = await invokeAiJobsWithTimeout(
        buildAiJobStatusRequestBody(jobId),
        AI_JOB_STATUS_TIMEOUT_MS,
        "status",
      );

      if (statusError) {
        debugEvents.push({
          t: new Date().toISOString(),
          stage: "poll_error",
          poll: pollCount,
          error: statusError,
        });
        // Transient polling error: keep polling.
        continue;
      }

      const statusPayload = (statusData || {}) as {
        status?: string;
        progress?: number;
        result?: unknown;
        error?: string | null;
        model_used?: string | null;
        latency_ms?: number | null;
        chunks_total?: number;
        chunks_done?: number;
        chunks_error?: number;
        chunks_queued?: number;
        chunks_running?: number;
        chunks_cancelled?: number;
        debug?: Record<string, unknown>;
      };
      const compact = compactStatusPayload(statusPayload as Record<string, unknown>);
      debugEvents.push({
        t: new Date().toISOString(),
        stage: "poll_status",
        poll: pollCount,
        payload: compact,
      });
      if (debugEvents.length > 180) {
        debugEvents.splice(0, debugEvents.length - 180);
      }

      const statusSignature = buildAiJobStatusSignature(statusPayload);
      if (statusSignature !== lastStatusSignature) {
        lastStatusSignature = statusSignature;
        lastStatusChangeAt = Date.now();
      }

      const statusValue = statusPayload.status || "running";
      if (statusValue === "not_found") {
        return {
          success: false,
          error: "AI job no longer exists",
          details: "The AI job could not be found anymore. Please retry the action.",
          meta: {
            model: modelForRequest,
            latencyMs: Date.now() - clientStartedAt,
            chunksTotal: 0,
            chunksDone: 0,
            chunksError: 0,
            debug: {
              client_started_at: new Date(clientStartedAt).toISOString(),
              client_finished_at: new Date().toISOString(),
              client_total_ms: Date.now() - clientStartedAt,
              poll_count: pollCount,
              status_endpoint: "ai-jobs",
              events: debugEvents,
              final_status: compact,
            },
          },
        };
      }
      const { stalled: looksStalled, stalledForMs } = isAiJobLikelyStalled(
        statusPayload,
        lastStatusChangeAt,
      );
      if (looksStalled) {
        const stallReason = `AI job stalled for ${Math.floor(stalledForMs / 1000)}s with no progress`;
        debugEvents.push({
          t: new Date().toISOString(),
          stage: "stalled_job_detected",
          poll: pollCount,
          stall_reason: stallReason,
          payload: compact,
        });
        await invokeAiJobsWithTimeout(
          { action: "cancel", jobId },
          AI_JOB_CANCEL_TIMEOUT_MS,
          "cancel",
        ).catch(() => null);
        return {
          success: false,
          error: "AI job stalled",
          details: `${stallReason}. Job was cancelled and can be retried.`,
          meta: {
            model: statusPayload.model_used || modelForRequest,
            latencyMs: Date.now() - clientStartedAt,
            chunksTotal: statusPayload.chunks_total,
            chunksDone: statusPayload.chunks_done,
            chunksError: statusPayload.chunks_error,
            debug: {
              client_started_at: new Date(clientStartedAt).toISOString(),
              client_finished_at: new Date().toISOString(),
              client_total_ms: Date.now() - clientStartedAt,
              poll_count: pollCount,
              status_endpoint: "ai-jobs",
              events: debugEvents,
              final_status: compact,
              stalled: true,
            },
          },
        };
      }

      // Adapt polling interval based on elapsed time and job state
      lastStatusPayloadForBackoff = statusPayload;
      currentPollInterval = getAdaptivePollInterval(
        Date.now() - pollStarted,
        lastStatusPayloadForBackoff,
      );

      onProgress?.({
        jobId,
        status: statusValue,
        progress: Number(statusPayload.progress || 0),
        chunksTotal: Number(statusPayload.chunks_total || 0),
        chunksDone: Number(statusPayload.chunks_done || 0),
        chunksError: Number(statusPayload.chunks_error || 0),
        pollCount,
        statusEndpoint: "ai-jobs",
        statusPayload: compact,
      });

      if (statusPayload.status === "done") {
        const normalized = normalizeGeminiResponsePayload(statusPayload.result);

        const response: GeminiProcessResponse = normalized.success === undefined
          ? {
              success: true,
              result: (normalized.result ?? normalized.data ?? statusPayload.result) as string | unknown[] | Record<string, unknown>,
              data: (normalized.data ?? normalized.result ?? statusPayload.result) as string | unknown[] | Record<string, unknown>,
              meta: {
                ...(normalized.meta || {}),
                model: statusPayload.model_used || modelForRequest,
                latencyMs: statusPayload.latency_ms ?? undefined,
                chunksTotal: statusPayload.chunks_total,
                chunksDone: statusPayload.chunks_done,
                chunksError: statusPayload.chunks_error,
                debug: {
                  client_started_at: new Date(clientStartedAt).toISOString(),
                  client_finished_at: new Date().toISOString(),
                  client_total_ms: Date.now() - clientStartedAt,
                  poll_count: pollCount,
                  status_endpoint: "ai-jobs",
                  events: debugEvents,
                  final_status: compact,
                },
              },
            }
          : {
              ...normalized,
              meta: {
                ...(normalized.meta || {}),
                model: statusPayload.model_used || normalized.meta?.model || modelForRequest,
                latencyMs: statusPayload.latency_ms ?? normalized.meta?.latencyMs,
                chunksTotal: statusPayload.chunks_total,
                chunksDone: statusPayload.chunks_done,
                chunksError: statusPayload.chunks_error,
                debug: {
                  client_started_at: new Date(clientStartedAt).toISOString(),
                  client_finished_at: new Date().toISOString(),
                  client_total_ms: Date.now() - clientStartedAt,
                  poll_count: pollCount,
                  status_endpoint: "ai-jobs",
                  events: debugEvents,
                  final_status: compact,
                },
              },
            };

        if (response.success && response.usage) {
          recordTokenUsage({
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            model: response.meta?.model || modelForRequest,
          });
        }

        return response;
      }

      if (statusPayload.status === "error" || statusPayload.status === "cancelled") {
        return {
          success: false,
          error: statusPayload.error || "AI job failed",
          details: statusPayload.error || "AI job failed",
          meta: {
            model: statusPayload.model_used || modelForRequest,
            latencyMs: statusPayload.latency_ms ?? undefined,
            chunksTotal: statusPayload.chunks_total,
            chunksDone: statusPayload.chunks_done,
            chunksError: statusPayload.chunks_error,
            debug: {
              client_started_at: new Date(clientStartedAt).toISOString(),
              client_finished_at: new Date().toISOString(),
              client_total_ms: Date.now() - clientStartedAt,
              poll_count: pollCount,
              status_endpoint: "ai-jobs",
              events: debugEvents,
              final_status: compact,
            },
          },
        };
      }
    }

    return {
      success: false,
      error: "AI job polling timed out",
      details: "Job exceeded client polling timeout.",
      meta: {
        model: modelForRequest,
        latencyMs: Date.now() - clientStartedAt,
        debug: {
          client_started_at: new Date(clientStartedAt).toISOString(),
          client_finished_at: new Date().toISOString(),
          client_total_ms: Date.now() - clientStartedAt,
          poll_count: pollCount,
          status_endpoint: "ai-jobs",
          events: debugEvents,
          timeout: true,
        },
      },
    };
  } catch (error) {
    console.error("Exception calling AI pipeline:", error);
    const detail = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: detail,
      details: detail,
      meta: {
        model: getClientModel(),
        debug: {
          exception: detail,
        },
      },
    };
  }
}

export async function testGeminiConnection(): Promise<boolean> {
  try {
    const healthcheckContext = [
      "Healthcheck context: This is a synthetic admin connectivity test payload.",
      "It is intentionally verbose to satisfy backend confidence gates that require a minimum readable text length.",
      "No product facts are requested and no uploaded files are required for this test.",
      "Please return only the requested JSON status.",
    ].join(" ");

    const response = await callGeminiProcessor({
      prompt: "Return this exact JSON: {\"status\":\"connected\"}",
      mode: "json",
      documentText: healthcheckContext,
      type: "admin_action",
    });

    // Connectivity test should validate pipeline availability, not strict model phrasing.
    if (response.error || !response.success) return false;

    const parsed = parseJsonResult(response.result);
    if (isPlainObject(parsed) && typeof parsed.status === "string") return true;
    if (typeof response.result === "string" && response.result.trim().length > 0) return true;
    if (response.data !== undefined && response.data !== null) return true;
    return false;
  } catch (error) {
    console.error("Gemini connection test failed:", error);
    return false;
  }
}
