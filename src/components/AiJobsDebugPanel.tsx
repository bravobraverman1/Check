import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeAuth";
import { AI_ACTION_DEFINITIONS, AI_PROMPT_OPTIONS } from "@/lib/aiRoutingConfig";
import {
  buildAiJobListRequestBody,
  buildAiJobStatusRequestBody,
  isAiJobDebugEnabled,
  setAiJobDebugEnabled,
} from "@/lib/aiJobPolling";

interface ChunkCounts {
  total: number;
  queued: number;
  running: number;
  done: number;
  error: number;
  cancelled: number;
}

interface JobRow {
  id: string;
  type: string;
  status: string;
  progress: number;
  model_used: string | null;
  latency_ms: number | null;
  error: string | null;
  timing: Record<string, unknown> | null;
  request_payload?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  chunk_counts: ChunkCounts;
  debug?: {
    chunk_details?: Array<Record<string, unknown>>;
  };
}

interface JobStatusDebugPayload {
  jobId: string;
  type: string;
  status: string;
  progress: number;
  result: unknown;
  error: string | null;
  model_used: string | null;
  latency_ms: number | null;
  timing: Record<string, unknown> | null;
  chunks_total: number;
  chunks_done: number;
  chunks_queued: number;
  chunks_running: number;
  chunks_error: number;
  chunks_cancelled: number;
  created_at: string;
  updated_at: string;
  debug?: Record<string, unknown>;
}

const ACTION_BY_ID = new Map(AI_ACTION_DEFINITIONS.map((action) => [action.id, action]));
const PROMPT_BY_VALUE = new Map(AI_PROMPT_OPTIONS.map((option) => [option.value, option.label]));
const LEGACY_TYPE_LABELS: Record<string, string> = {
  generate_data: "Form | Generate Data",
  generic: "Generic",
  pdf_compare: "Admin Compare | PDF Compare",
  admin_action: "Admin Action",
  text_compare: "Form | Text Compare",
  filter_extract: "Form | Filter Extract",
};
const ACTION_DEBUG_TYPE_NAMES: Record<string, string> = {
  product_generate_two_pdfs: "Form_aiData_twoPdfs",
  product_generate_datasheet_only: "Form_aiData_datasheetOnly",
  product_generate_webpage_only: "Form_aiData_webpageOnly",
  compare_two_datasheets: "Admin_pdfCompare",
};

function getActionDebugTypeName(actionKey: string, promptType: string): string {
  if (actionKey === "product_generate_description_technical") {
    return promptType === "admin_technical" ? "Admin_createDesc_technical" : "Form_titleDesc_technical";
  }
  if (actionKey === "product_generate_description_marketing") {
    return promptType === "admin_marketing" ? "Admin_createDesc_marketing" : "Form_titleDesc_marketing";
  }
  return ACTION_DEBUG_TYPE_NAMES[actionKey] || "";
}

function formatMs(ms: number | null): string {
  if (!ms || ms <= 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getPayloadField(payload: Record<string, unknown> | null, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function formatJobType(job: JobRow): string {
  const payload = asRecord(job.request_payload);
  const timing = asRecord(job.timing);
  const debugMeta = asRecord(timing?.debug_meta);
  const actionKey = getPayloadField(payload, "debugActionKey") || getPayloadField(debugMeta, "debug_action_key");
  const promptType = getPayloadField(payload, "debugPromptType") || getPayloadField(debugMeta, "debug_prompt_type");
  const action = actionKey ? ACTION_BY_ID.get(actionKey as (typeof AI_ACTION_DEFINITIONS)[number]["id"]) : undefined;
  const promptLabel = promptType ? (PROMPT_BY_VALUE.get(promptType) || promptType) : "";
  const actionDebugType = actionKey ? getActionDebugTypeName(actionKey, promptType) : "";

  if (actionDebugType) {
    return [actionDebugType, promptLabel ? `Prompt: ${promptLabel}` : ""].filter(Boolean).join(" | ");
  }

  const parts = [
    action?.group || "",
    action?.label || "",
    promptLabel ? `Prompt: ${promptLabel}` : "",
  ].filter(Boolean);

  if (parts.length > 0) return parts.join(" | ");
  return LEGACY_TYPE_LABELS[job.type] || job.type;
}

export function AiJobsDebugPanel() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number>(0);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [statusByJobId, setStatusByJobId] = useState<Record<string, JobStatusDebugPayload>>({});
  const [loadingStatusJobId, setLoadingStatusJobId] = useState<string | null>(null);
  const [cancellingStale, setCancellingStale] = useState(false);
  const [hardResetting, setHardResetting] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState<boolean>(() => isAiJobDebugEnabled());
  const pollInFlightRef = useRef(false);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error: invokeError } = await invokeEdgeFunction("ai-jobs", {
        body: buildAiJobListRequestBody(20, true),
      });
      if (invokeError) {
        setError(invokeError.message || "Failed to load jobs");
        return;
      }

      const rows = Array.isArray((data as { jobs?: unknown })?.jobs)
        ? ((data as { jobs: JobRow[] }).jobs || [])
        : [];
      setJobs(rows);
      setError(null);
      setLastUpdated(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }, []);

  const cancelStaleJobs = useCallback(async () => {
    setCancellingStale(true);
    try {
      const { error: invokeError } = await invokeEdgeFunction("ai-jobs", {
        body: { action: "cancel_stale" },
      });

      if (invokeError) {
        setError(invokeError.message || "Failed to cancel stale jobs");
        return;
      }

      setError(null);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel stale jobs");
    } finally {
      setCancellingStale(false);
    }
  }, [loadJobs]);

  const loadJobStatus = useCallback(async (jobId: string) => {
    setLoadingStatusJobId(jobId);
    try {
      const { data, error: invokeError } = await invokeEdgeFunction("ai-jobs", {
        body: buildAiJobStatusRequestBody(jobId),
      });
      if (invokeError) {
        setError(invokeError.message || `Failed to load debug for ${jobId}`);
        return;
      }

      if (data && typeof data === "object") {
        setStatusByJobId((prev) => ({
          ...prev,
          [jobId]: data as JobStatusDebugPayload,
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to load debug for ${jobId}`);
    } finally {
      setLoadingStatusJobId((current) => (current === jobId ? null : current));
    }
  }, []);

  const hardResetJobs = useCallback(async () => {
    setHardResetting(true);
    try {
      const { error: invokeError } = await invokeEdgeFunction("ai-jobs", {
        body: { action: "hard_reset" },
      });

      if (invokeError) {
        const { data: listData, error: listError } = await invokeEdgeFunction("ai-jobs", {
          body: buildAiJobListRequestBody(100, false),
        });
        if (listError) {
          setError(invokeError.message || listError.message || "Failed to hard reset AI jobs");
          return;
        }

        const listedJobs = Array.isArray((listData as { jobs?: unknown })?.jobs)
          ? ((listData as { jobs: JobRow[] }).jobs || [])
          : [];
        const activeJobIds = listedJobs
          .filter((job) => job.status === "queued" || job.status === "running")
          .map((job) => job.id)
          .filter(Boolean);

        if (activeJobIds.length > 0) {
          const cancelResults = await Promise.allSettled(
            activeJobIds.map((id) => invokeEdgeFunction("ai-jobs", {
              body: { action: "cancel", jobId: id },
            })),
          );
          const failed = cancelResults.reduce((count, result) => {
            if (result.status === "rejected") return count + 1;
            return result.value?.error ? count + 1 : count;
          }, 0);
          if (failed > 0) {
            setError(`Hard reset partially completed (${activeJobIds.length - failed}/${activeJobIds.length} jobs cancelled)`);
          }
        }
      }

      setExpandedJobId(null);
      setStatusByJobId({});
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to hard reset AI jobs");
    } finally {
      setHardResetting(false);
    }
  }, [loadJobs]);

  const toggleExpanded = useCallback(async (job: JobRow) => {
    if (expandedJobId === job.id) {
      setExpandedJobId(null);
      return;
    }
    setExpandedJobId(job.id);
    if (!statusByJobId[job.id]) {
      await loadJobStatus(job.id);
    }
  }, [expandedJobId, loadJobStatus, statusByJobId]);

  const toggleDebug = useCallback(() => {
    const next = !debugEnabled;
    setDebugEnabled(next);
    setAiJobDebugEnabled(next);
    void loadJobs();
  }, [debugEnabled, loadJobs]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void tick();
      }, 8000);
    };

    const tick = async () => {
      if (cancelled) return;
      if (pollInFlightRef.current) {
        schedule();
        return;
      }
      pollInFlightRef.current = true;
      try {
        await loadJobs();
      } finally {
        pollInFlightRef.current = false;
        schedule();
      }
    };

    void loadJobs();
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [loadJobs]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Live queue visibility for AI jobs and chunk timing.
        </p>
        <div className="flex items-center gap-2">
          {lastUpdated > 0 && (
            <span className="text-[11px] text-muted-foreground">
              Updated {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={toggleDebug}
          >
            Debug Poll: {debugEnabled ? "ON" : "OFF"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={hardResetJobs}
            disabled={loading || cancellingStale || hardResetting}
          >
            {hardResetting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            Hard Reset AI
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={cancelStaleJobs}
            disabled={loading || cancellingStale || hardResetting}
          >
            {cancellingStale ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            Cancel Stuck
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={loadJobs} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      <div className="overflow-auto border rounded-md">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left px-2 py-2">Created</th>
              <th className="text-left px-2 py-2">Type</th>
              <th className="text-left px-2 py-2">Status</th>
              <th className="text-left px-2 py-2">Chunks</th>
              <th className="text-left px-2 py-2">Progress</th>
              <th className="text-left px-2 py-2">Model</th>
              <th className="text-left px-2 py-2">Latency</th>
              <th className="text-left px-2 py-2">Error</th>
              <th className="text-left px-2 py-2">Debug</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-2 py-4 text-center text-muted-foreground">
                  {loading ? "Loading jobs..." : "No AI jobs found yet."}
                </td>
              </tr>
            ) : (
              jobs.map((job) => {
                const counts = job.chunk_counts || {
                  total: 0,
                  queued: 0,
                  running: 0,
                  done: 0,
                  error: 0,
                  cancelled: 0,
                };

                return (
                  <Fragment key={job.id}>
                    <tr className="border-t">
                      <td className="px-2 py-2 whitespace-nowrap">{formatDate(job.created_at)}</td>
                      <td className="px-2 py-2 max-w-[340px] truncate" title={formatJobType(job)}>
                        {formatJobType(job)}
                      </td>
                      <td className="px-2 py-2">{job.status}</td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {counts.done}/{counts.total}
                        {counts.error > 0 ? ` (err ${counts.error})` : ""}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">{job.progress}%</td>
                      <td className="px-2 py-2 whitespace-nowrap">{job.model_used || "-"}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{formatMs(job.latency_ms)}</td>
                      <td className="px-2 py-2 text-destructive max-w-[260px] truncate" title={job.error || ""}>
                        {job.error || "-"}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2"
                          onClick={() => void toggleExpanded(job)}
                          disabled={loadingStatusJobId === job.id}
                        >
                          {loadingStatusJobId === job.id ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                              Loading
                            </>
                          ) : expandedJobId === job.id ? "Hide" : "Inspect"}
                        </Button>
                      </td>
                    </tr>
                    {expandedJobId === job.id && (
                      <tr className="border-t bg-muted/10">
                        <td colSpan={9} className="p-2">
                          <pre className="max-h-[360px] overflow-auto rounded border bg-background p-2 text-[11px] whitespace-pre-wrap break-words">
                            {JSON.stringify(
                              statusByJobId[job.id] || {
                                message: "No detailed status loaded yet",
                                list_debug_chunk_details: job.debug?.chunk_details || [],
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
