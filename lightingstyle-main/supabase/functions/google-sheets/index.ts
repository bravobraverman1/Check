  import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseJsonObject, getCorsHeaders, rejectIfMissingProjectKey, rejectIfOriginNotAllowed } from "../_shared/security.ts";
import {
  getGoogleAccessToken,
  parseServiceAccountKey,
  normalizePrivateKey,
  type ServiceAccountCredentials,
} from "../_shared/googleAuth.ts";
import {
  formatDimensionEntriesInSemicolonListForCsv,
  formatDimensionFilterValueForCsv,
  normalizeDimensionFilterValueForStorage,
} from "../_shared/filterDimensionFormatting.ts";
import { buildLoadingDockCsvText, LOADING_DOCK_CSV_MAX_COLS } from "../_shared/loadingDockCsv.ts";
import { parseOrderedCustomFieldSpecValues } from "../_shared/loadingDockCustomFields.ts";
import { listGoogleSheetsActions, normalizeGoogleSheetsAction } from "../_shared/googleSheetsActions.ts";
import { findDuplicateTitleInfo } from "../_shared/duplicateTitleGuard.ts";
import {
  hasNormalizedProductTitleMatch,
  normalizeProductTitleForCompare,
  normalizeProductTitleWhitespace,
} from "../_shared/productTitleNormalization.ts";
import { decideSubmitMpn, extractNumericMpnFromValue } from "../_shared/submitMpnResolution.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// ── Supabase cache helpers ──────────────────────────────────────────────────
// Uses the sheet_cache table to persist last-good Google Sheets responses
// so ALL users benefit from cached data when Google Sheets is unreachable.
function getCacheKey(action: string, body: Record<string, unknown>): string {
  if (action === "read") return "read";
  if (action === "fetch-dock-entries") return "fetch-dock-entries";
  const sku = ((body.sku as string) || "").trim();
  if (
    action === "download-csv" ||
    action === "read-dock-email" ||
    action === "read-output-work"
  ) {
    const submittedAt = typeof body.submittedAt === "string" ? body.submittedAt.trim() : "";
    return submittedAt ? `${action}:${sku}:${submittedAt}` : `${action}:${sku}`;
  }
  return `${action}:${sku}`;
}

const serviceRoleClient = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  : null;

function getServiceRoleClient() {
  return serviceRoleClient;
}

function getRequiredServiceRoleClient() {
  const sb = getServiceRoleClient();
  if (!sb) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for the MPN source-of-truth store.");
  }
  return sb;
}

type ResolvedMpnState = {
  mpn: number;
  attachment_state: "generated" | "attached";
  transition:
    | "generated_new"
    | "generated_reused"
    | "generated_and_attached"
    | "generated_now_attached"
    | "attached_reused";
  attached_sku?: string | null;
  next_mpn?: number;
  warning_code?: string | null;
  warning_title?: string | null;
  warning_message?: string | null;
};

type DraftMpnSnapshot = {
  mpn: number;
  attachment_state: "generated" | "attached";
  attached_sku?: string | null;
  current_sku?: string | null;
};

async function syncMpnAllocatorFloorWithDb(nextMpnFloor: number): Promise<number> {
  const sb = getRequiredServiceRoleClient();
  const { data, error } = await (sb as any).rpc("mpn_sync_floor", {
    p_floor_next_mpn: Number.isFinite(nextMpnFloor) && nextMpnFloor > 0 ? nextMpnFloor : null,
  });
  if (error) {
    throw new Error(`Failed to sync DB MPN floor: ${error.message}`);
  }
  const synced = Number(data);
  if (!Number.isFinite(synced) || synced <= 0) {
    throw new Error("DB MPN floor sync did not return a valid next MPN.");
  }
  return synced;
}

async function readDbNextMpn(): Promise<number> {
  const sb = getRequiredServiceRoleClient();
  const { data, error } = await (sb as any).rpc("mpn_peek_next");
  if (error) {
    throw new Error(`Failed to read DB next MPN: ${error.message}`);
  }
  const next = Number(data);
  if (!Number.isFinite(next) || next <= 0) {
    throw new Error("DB next MPN did not return a valid number.");
  }
  return next;
}

async function resolveDraftMpnStateInDb(args: {
  draftId: string;
  sku: string;
  action: "view" | "send_by_email" | "download";
  requestedMpn?: number | null;
}): Promise<ResolvedMpnState> {
  const sb = getRequiredServiceRoleClient();
  const { data, error } = await (sb as any).rpc("mpn_resolve_action", {
    p_draft_id: args.draftId,
    p_sku: args.sku,
    p_action: args.action,
    p_requested_mpn: Number.isFinite(Number(args.requestedMpn)) && Number(args.requestedMpn) > 0
      ? Number(args.requestedMpn)
      : null,
  });
  if (error) {
    throw new Error(`Failed to resolve MPN state: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("DB MPN resolver returned an invalid payload.");
  }
  const record = data as Record<string, unknown>;
  const resolvedMpn = Number(record.mpn);
  if (!Number.isFinite(resolvedMpn) || resolvedMpn <= 0) {
    throw new Error("DB MPN resolver did not return a valid MPN.");
  }
  const transition = String(record.transition ?? "").trim() as ResolvedMpnState["transition"];
  if (!transition) {
    throw new Error("DB MPN resolver did not return a valid transition.");
  }
  return {
    mpn: resolvedMpn,
    attachment_state: record.attachment_state === "attached" ? "attached" : "generated",
    transition,
    attached_sku: typeof record.attached_sku === "string" ? record.attached_sku : null,
    next_mpn: Number.isFinite(Number(record.next_mpn)) ? Number(record.next_mpn) : undefined,
    warning_code: typeof record.warning_code === "string" ? record.warning_code : null,
    warning_title: typeof record.warning_title === "string" ? record.warning_title : null,
    warning_message: typeof record.warning_message === "string" ? record.warning_message : null,
  };
}

async function releaseGeneratedDraftMpnInDb(draftId: string): Promise<void> {
  const trimmedDraftId = String(draftId ?? "").trim();
  if (!trimmedDraftId) return;
  const sb = getRequiredServiceRoleClient();
  const { error } = await (sb as any).rpc("mpn_release_generated_draft", {
    p_draft_id: trimmedDraftId,
  });
  if (error) {
    throw new Error(`Failed to release generated draft MPN: ${error.message}`);
  }
}

async function readDraftMpnSnapshotFromDb(draftId: string): Promise<DraftMpnSnapshot | null> {
  const trimmedDraftId = String(draftId ?? "").trim();
  if (!trimmedDraftId) return null;
  const sb = getRequiredServiceRoleClient();
  const { data, error } = await (sb as any)
    .from("mpn_reservations")
    .select("mpn, state, attached_sku, current_sku, updated_at")
    .eq("draft_id", trimmedDraftId)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to read draft MPN state: ${error.message}`);
  }

  const record = Array.isArray(data) ? data[0] : null;
  if (!record || typeof record !== "object") {
    return null;
  }

  const resolvedMpn = Number((record as Record<string, unknown>).mpn);
  if (!Number.isFinite(resolvedMpn) || resolvedMpn <= 0) {
    return null;
  }

  return {
    mpn: resolvedMpn,
    attachment_state: (record as Record<string, unknown>).state === "attached" ? "attached" : "generated",
    attached_sku: typeof (record as Record<string, unknown>).attached_sku === "string"
      ? String((record as Record<string, unknown>).attached_sku)
      : null,
    current_sku: typeof (record as Record<string, unknown>).current_sku === "string"
      ? String((record as Record<string, unknown>).current_sku)
      : null,
  };
}

async function allocateExternalMpnInDb(args: {
  source: "eran" | "manual_increment";
  notes?: string | null;
  sheetFloorNextMpn?: number | null;
}): Promise<{ reserved_mpn: number; next_mpn: number; source: string }> {
  const sb = getRequiredServiceRoleClient();
  const { data, error } = await (sb as any).rpc("mpn_allocate_external", {
    p_source: args.source,
    p_notes: typeof args.notes === "string" && args.notes.trim() ? args.notes.trim() : null,
    p_floor_next_mpn: Number.isFinite(Number(args.sheetFloorNextMpn)) && Number(args.sheetFloorNextMpn) > 0
      ? Number(args.sheetFloorNextMpn)
      : null,
  });
  if (error) {
    throw new Error(`Failed to allocate external MPN: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("External MPN allocator returned an invalid payload.");
  }
  const record = data as Record<string, unknown>;
  const reserved = Number(record.reserved_mpn);
  const next = Number(record.next_mpn);
  if (!Number.isFinite(reserved) || reserved <= 0 || !Number.isFinite(next) || next <= reserved) {
    throw new Error("External MPN allocator returned invalid numbers.");
  }
  return {
    reserved_mpn: reserved,
    next_mpn: next,
    source: typeof record.source === "string" ? record.source : args.source,
  };
}

async function setDbNextMpn(nextMpn: number): Promise<number> {
  const sb = getRequiredServiceRoleClient();
  const { data, error } = await (sb as any).rpc("mpn_set_next", {
    p_next_mpn: Number.isFinite(nextMpn) && nextMpn > 0 ? Math.trunc(nextMpn) : null,
  });
  if (error) {
    throw new Error(`Failed to set next MPN: ${error.message}`);
  }
  const resolved = Number(data);
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error("DB next MPN setter did not return a valid number.");
  }
  return resolved;
}

async function readCache(cacheKey: string): Promise<unknown | null> {
  try {
    const sb = getServiceRoleClient();
    if (!sb) return null;
    const { data, error } = await (sb as any)
      .from("sheet_cache")
      .select("response_data")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (error || !data) return null;
    return data.response_data;
  } catch {
    return null;
  }
}

async function writeCache(cacheKey: string, responseData: unknown): Promise<void> {
  try {
    const sb = getServiceRoleClient();
    if (!sb) return;
    await (sb as any)
      .from("sheet_cache")
      .upsert(
        { cache_key: cacheKey, response_data: responseData, updated_at: new Date().toISOString() },
        { onConflict: "cache_key" }
      );
  } catch (err) {
    console.warn("Cache write failed (non-fatal):", err);
  }
}

async function deleteCache(cacheKey: string): Promise<void> {
  try {
    const sb = getServiceRoleClient();
    if (!sb) return;
    await (sb as any)
      .from("sheet_cache")
      .delete()
      .eq("cache_key", cacheKey);
  } catch (err) {
    console.warn("Cache delete failed (non-fatal):", err);
  }
}

async function deleteCaches(cacheKeys: Array<string | null | undefined>): Promise<void> {
  const uniqueKeys = Array.from(new Set(
    cacheKeys
      .map((key) => String(key ?? "").trim())
      .filter(Boolean),
  ));
  if (uniqueKeys.length === 0) return;
  await Promise.all(uniqueKeys.map((cacheKey) => deleteCache(cacheKey)));
}

function normalizeSubmittedAtCacheKeyValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const parsedMs = parseSheetTimestampMs(trimmed);
    if (Number.isFinite(parsedMs) && parsedMs > 0) {
      return new Date(parsedMs).toISOString();
    }
    return trimmed;
  }

  const epochMs = Number(value);
  if (Number.isFinite(epochMs) && epochMs > 0) {
    return new Date(Math.trunc(epochMs)).toISOString();
  }
  return "";
}

async function invalidateDockReadCachesForSku(
  sku: string,
  submittedAtHints: Array<unknown> = [],
): Promise<void> {
  const trimmedSku = sku.trim();
  _dockEntriesCache = null;
  _dockEntriesInflight = null;
  if (!trimmedSku) {
    await deleteCaches(["fetch-dock-entries"]);
    return;
  }

  const submittedAtValues = Array.from(new Set(
    submittedAtHints
      .map((value) => normalizeSubmittedAtCacheKeyValue(value))
      .filter(Boolean),
  ));

  await deleteCaches([
    "fetch-dock-entries",
    `read-output-work:${trimmedSku}`,
    `read-dock-email:${trimmedSku}`,
    `download-csv:${trimmedSku}`,
    ...submittedAtValues.flatMap((submittedAt) => [
      `read-output-work:${trimmedSku}:${submittedAt}`,
      `read-dock-email:${trimmedSku}:${submittedAt}`,
      `download-csv:${trimmedSku}:${submittedAt}`,
    ]),
  ]);
}
// ── Read-only operation timeout ──────────────────────────────────────────────
// Wraps a promise with a hard wall-clock timeout so that Google Sheets API
// retries (which can take 4+ minutes in the worst case) don't block the
// edge function response indefinitely.
const READ_ONLY_HARD_TIMEOUT_MS = 12_000;

class ReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`Read operation timed out after ${ms}ms`);
    this.name = "ReadTimeoutError";
  }
}

function withReadTimeout<T>(promise: Promise<T>, ms = READ_ONLY_HARD_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ReadTimeoutError(ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}
// ─────────────────────────────────────────────────────────────────────────────

// getCorsHeaders + rejectIfOriginNotAllowed imported from ../_shared/security.ts

// ── Processed_At Gate ──
// Before writing to OUTPUT_Work, ensure the previous SUBMIT/SUBMIT_OVERRIDE/UPLOAD event has been
// processed (Processed_At filled). This is the "open and close gate" mechanism:
// gate closes when a new SUBMIT is written, gate opens when Processed_At appears.
// Direct dock writes complete much faster than the legacy CopyEngine path, so
// budget the gate to tolerate roughly 10 queued items before the free-tier
// wall-clock cap, instead of rejecting after only a few concurrent submits.
const PROCESSED_AT_GATE_BASE_WAIT_MS = 13_500;
const PROCESSED_AT_GATE_MAX_WAIT_MS = 135_000; // Stay under Supabase free-tier 150s wall-clock edge limit with room for read/write overhead
// IMPORTANT: Google Sheets consumer quota is only 60 read-requests/min/user.
// Polling faster than ~1s will reliably hit 429s, especially when combined with UI polling.
const PROCESSED_AT_GATE_POLL_MS = 3_000;
const PROCESSED_AT_GATE_ABANDON_MS = 300_000; // 300s (5min) — must be longer than CopyEngine execution budget (45s) + defer (30s) + safety margin
const PROCESSED_AT_GATE_READ_RETRY_MAX = 3;
const OUTPUT_WORK_LOCK_CACHE_KEY = "output-work-lock";
const OUTPUT_WORK_LOCK_STALE_MS = 45_000;
const OUTPUT_WORK_LOCK_RETRY_DELAY_MS = 1_250;
const OUTPUT_WORK_LOCK_MAX_ATTEMPTS = 20;
const NEW_NAMES_RECENT_CACHE_KEY = "new-names-recent";
const NEW_NAMES_RECENT_TTL_MS = 5 * 60 * 1000;

// ── Instant Kick: trigger Apps Script via Execution API ──
const APPS_SCRIPT_ID = Deno.env.get("APPS_SCRIPT_ID") || "";

/**
 * Best-effort Apps Script Execution API kick for Apps Script-owned pipelines
 * such as delete and email/send actions.
 */
async function kickAppsScriptFunction(
  accessToken: string,
  fnName: string,
  parameters?: unknown[],
): Promise<AppsScriptKickResult> {
  if (!APPS_SCRIPT_ID) {
    const reason = `APPS_SCRIPT_ID not configured — skipping instant kick for ${fnName}`;
    console.log(reason);
    return { status: "skipped", reason };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(`https://script.googleapis.com/v1/scripts/${APPS_SCRIPT_ID}:run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        function: fnName,
        parameters: Array.isArray(parameters) ? parameters : [],
      }),
      signal: controller.signal,
    });

    const txt = await res.text();
    if (!res.ok) {
      const error = `Instant kick failed for ${fnName} (status ${res.status}): ${txt.substring(0, 500)}`;
      console.warn(error);
      return { status: "failed", error };
    }

    let parsed: unknown = null;
    try {
      parsed = txt ? JSON.parse(txt) : null;
    } catch {
      parsed = txt;
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const executionError = (parsed as Record<string, unknown>).error;
      if (executionError && typeof executionError === "object" && !Array.isArray(executionError)) {
        const details = (executionError as Record<string, unknown>).details;
        const error = typeof details === "string"
          ? details
          : `Apps Script execution error for ${fnName}`;
        console.warn(error);
        return { status: "failed", error };
      }
      const response = (parsed as Record<string, unknown>).response;
      if (response && typeof response === "object" && !Array.isArray(response)) {
        return {
          status: "completed",
          result: (response as Record<string, unknown>).result,
        };
      }
    }

    console.log(`Instant kick ok for ${fnName} (status ${res.status})`);
    return { status: "completed", result: parsed };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      const reason = `Instant kick timed out for ${fnName} after 15s`;
      console.warn(reason);
      return { status: "timed_out", reason };
    }
    const error = `Instant kick failed for ${fnName} (non-fatal): ${err instanceof Error ? err.message : String(err)}`;
    console.warn(error);
    return { status: "failed", error };
  } finally {
    clearTimeout(timeout);
  }
}
const DOCK_ENTRIES_CACHE_TTL_MS = 2500; // supports 1s UI polling while keeping Sheets reads well under quota
const DOCK_FETCH_STALE_SERVE_TIMEOUT_MS = 8_000; // if Google takes >8s, serve stale cache immediately
const GLOBAL_DOCK_PENDING_CACHE_KEY = "dock-pending-global";
const GLOBAL_DOCK_PENDING_TTL_MS = 15 * 60 * 1000;
const ORPHAN_GLOBAL_PENDING_WITHOUT_EVENT_GRACE_MS = 30 * 1000;
const STALE_PENDING_EVENT_MAX_AGE_MS = 30 * 60 * 1000;
const SUBMIT_IDEMPOTENCY_CACHE_PREFIX = "submit-idempotency:";
const SUBMIT_IDEMPOTENCY_CLAIM_STALE_MS = 2 * 60 * 1000;
const SUBMIT_IDEMPOTENCY_EVENT_STALE_MS = 210 * 1000;
const DOCK_EMAIL_SINGLE_LOCK_CACHE_PREFIX = "dock-email-single-lock:";
const DOCK_EMAIL_SINGLE_LOCK_STALE_MS = 20_000;
const DOCK_EMAIL_SINGLE_LOCK_RETRY_DELAY_MS = 250;
const DOCK_EMAIL_SINGLE_LOCK_MAX_ATTEMPTS = 6;
const DOCK_DELETE_LOCK_CACHE_PREFIX = "dock-delete-lock:";
const DOCK_DELETE_LOCK_STALE_MS = 20_000;
const DOCK_DELETE_LOCK_RETRY_DELAY_MS = 250;
const DOCK_DELETE_LOCK_MAX_ATTEMPTS = 6;

// Delete (single): small verification window (events are queued, verification is best-effort)
const DOCK_DELETE_STABILIZE_MAX_WAIT_MS = 8_000;
const DOCK_DELETE_STABILIZE_POLL_MS = 1_500;

// Email single: do NOT block the edge function for long — just try to detect fast failures.
const EMAIL_SINGLE_VERIFY_MAX_WAIT_MS = 6_000;
const EMAIL_SINGLE_VERIFY_POLL_MS = 2_500;
// SEND_DOCK batch: CLEAR mode does direct deletion (can use longer wait), SEND mode is Apps Script-owned (short wait).
const SEND_DOCK_CLEAR_VERIFY_MAX_WAIT_MS = 8_000;
const SEND_DOCK_SEND_VERIFY_MAX_WAIT_MS = 8_000;
const SEND_DOCK_VERIFY_POLL_MS = 2_500;
const MELBOURNE_TIMEZONE = "Australia/Melbourne";

const POST_WRITE_VERIFICATION_READ_RETRY_MAX = 3;
type DockPendingActionType = "delete" | "email" | "clear" | "send";
type DockEntry = {
  id: string;
  sku: string;
  processedAt: string;
  submittedAt: string;
  pendingActionType?: DockPendingActionType;
};
type DockFormData = { sku: string; brand: string; title: string; mainCategory: string; selectedCategories: string[]; imageUrls: string[]; chatgptData: string; chatgptDescription: string; emailNotes: string; specValues: Record<string, string>; price?: string; costPrice?: string; gpsMpn?: string; };
type DockResult = {
  entries: DockEntry[];
  formDataMap?: Record<string, DockFormData>;
  titleMap?: Record<string, string>;
  errors?: Record<string, string>;
  debugReasonsBySku?: Record<string, string>;
};
let _dockEntriesCache: {
  entries: DockEntry[];
  formDataMap?: Record<string, DockFormData>;
  titleMap?: Record<string, string>;
  errors?: Record<string, string>;
  debugReasonsBySku?: Record<string, string>;
  ts: number;
} | null = null;
let _dockEntriesInflight: Promise<DockResult> | null = null;

type GlobalDockPendingEntry = {
  sku: string;
  submittedAt: string;
  submittedAtEpochMs: number;
  isOverwrite: boolean;
  expiresAt: number;
};

type OutputWorkLockEntry = {
  ownerToken: string;
  acquiredAtEpochMs: number;
  expiresAt: number;
};

type OutputWorkLockHandle = {
  ownerToken: string;
  cacheKey: string;
};

type DockEmailSingleLockEntry = {
  ownerToken: string;
  acquiredAtEpochMs: number;
  expiresAt: number;
  sku: string;
};

type DockEmailSingleLockHandle = {
  ownerToken: string;
  cacheKey: string;
};

type NewNamesRecentTitleCacheEntry = {
  normalizedTitle: string;
  title: string;
  expiresAt: number;
};

type SubmitIdempotencyRecord = {
  requestId: string;
  sku: string;
  payloadHash: string;
  isOverwrite: boolean;
  status: "in_progress" | "completed" | "failed";
  phase: "claimed" | "event_logged";
  attemptToken: string;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  eventId?: string;
  processedAt?: string;
  error?: string;
};

type SubmitIdempotencyClaimResult =
  | { kind: "legacy" }
  | { kind: "owner"; record: SubmitIdempotencyRecord }
  | { kind: "completed"; processedAt: string; eventId?: string }
  | { kind: "pending"; reason: string; eventId?: string }
  | { kind: "failed"; error: string };

type DockDeleteWaitResult =
  | { status: "completed"; processedAt: string; warning?: string }
  | { status: "pending"; reason: string }
  | { status: "failed"; error: string };

type EmailSingleWaitResult =
  | { status: "completed"; processedAt: string; warning?: string }
  | { status: "pending"; reason: string }
  | { status: "failed"; error: string };

type SendDockWaitResult =
  | { status: "completed"; processedAt: string; deleted: number; emailed: number; summary: string }
  | { status: "pending"; reason: string }
  | { status: "failed"; error: string; deleted: number; emailed: number; summary: string };

type EventRowState = {
  eventId: string;
  eventType: string;
  sku: string;
  mpn: string;
  processedAt: string;
  error: string;
};

function extractSubmittedAtEpochMsFromEventId(eventIdRaw: string | undefined): number | undefined {
  const match = String(eventIdRaw ?? "").trim().match(/^EVT-(\d{13,})$/);
  const epoch = match ? Number(match[1]) : NaN;
  return Number.isFinite(epoch) && epoch > 0 ? epoch : undefined;
}

type ParsedSendDockSummary = {
  deleted: number | null;
  expectedDeleted: number | null;
  emailed: number | null;
  hasErrors: boolean;
  fatal: boolean;
  raw: string;
};

type OutputWorkLayout = {
  headers: string[];
  productTemplateRow: string[];
  emailTemplateRow: string[];
};

type OutputWorkSeedRows = {
  headers: string[];
  productRow: string[];
  emailRow: string[];
};

type OutputWorkTemplateSnapshot = {
  layout: OutputWorkLayout;
  width: number;
  paddedRows: string[][];
};

type EnsureOutputWorkTemplateResult = {
  layout: OutputWorkLayout;
  resetApplied: boolean;
};

type SubmissionCommitResult = {
  success: boolean;
  pending?: boolean;
  error?: string;
  processedAt?: string;
  reason?: string;
};

type AppsScriptKickResult =
  | { status: "completed"; result?: unknown }
  | { status: "timed_out"; reason: string }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: string };

type StageSubmissionArgs = {
  token: string;
  sheetId: string;
  outputWorkTab: string;
  outputTemplateTab: string;
  eventsTab: string;
  sku: string;
  eventRow: string[];
  eventEpochMs: number;
  isOverwrite: boolean;
  stagedRows: OutputWorkSeedRows;
  postEventTasks?: Array<() => Promise<void>>;
};

type StageSubmissionResult = {
  eventRowNumber: number | null;
};

type DirectSubmissionCompletionArgs = {
  token: string;
  sheetId: string;
  eventsTab: string;
  dockTab: string;
  outputWorkTab: string;
  outputTemplateTab: string;
  sku: string;
  expectedMpn: number | null;
  isOverwrite: boolean;
  stagedRows: OutputWorkSeedRows;
  eventRowNumber: number | null;
  eventEpochMs: number;
  previousSubmissionEpochMs?: number | null;
};

function sanitizeGlobalDockPendingEntries(raw: unknown, now = Date.now()): GlobalDockPendingEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: GlobalDockPendingEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const sku = typeof record.sku === "string" ? record.sku.trim() : "";
    const submittedAt = typeof record.submittedAt === "string" ? record.submittedAt.trim() : "";
    const submittedAtEpochMs = Number(record.submittedAtEpochMs);
    const expiresAt = Number(record.expiresAt);
    if (!sku || !submittedAt || !Number.isFinite(submittedAtEpochMs) || !Number.isFinite(expiresAt)) continue;
    if (expiresAt <= now) continue;
    entries.push({
      sku,
      submittedAt,
      submittedAtEpochMs,
      isOverwrite: record.isOverwrite === true,
      expiresAt,
    });
  }
  return entries;
}

async function readGlobalDockPendingEntries(now = Date.now()): Promise<GlobalDockPendingEntry[]> {
  const cached = await readCache(GLOBAL_DOCK_PENDING_CACHE_KEY);
  return sanitizeGlobalDockPendingEntries(cached, now);
}

async function writeGlobalDockPendingEntries(entries: GlobalDockPendingEntry[]): Promise<void> {
  await writeCache(GLOBAL_DOCK_PENDING_CACHE_KEY, entries);
}

function buildGlobalDockPendingEntry(
  sku: string,
  submittedAtEpochMs: number,
  isOverwrite: boolean,
): GlobalDockPendingEntry {
  return {
    sku: sku.trim(),
    submittedAt: new Date(submittedAtEpochMs).toISOString(),
    submittedAtEpochMs,
    isOverwrite,
    expiresAt: submittedAtEpochMs + GLOBAL_DOCK_PENDING_TTL_MS,
  };
}

async function upsertGlobalDockPendingEntry(entry: GlobalDockPendingEntry): Promise<void> {
  const normalizedSku = normalizeSkuForCompare(entry.sku);
  if (!normalizedSku) return;

  const existing = await readGlobalDockPendingEntries();
  const next = new Map<string, GlobalDockPendingEntry>();
  for (const item of existing) {
    next.set(normalizeSkuForCompare(item.sku), item);
  }
  next.set(normalizedSku, entry);
  await writeGlobalDockPendingEntries(Array.from(next.values()));
}

async function removeGlobalDockPendingEntry(
  sku: string,
  expectedSubmittedAtEpochMs?: number | null,
): Promise<boolean> {
  const normalizedSku = normalizeSkuForCompare(sku);
  if (!normalizedSku) return false;

  const existing = await readGlobalDockPendingEntries();
  let removed = false;
  const normalizedExpectedSubmittedAtEpochMs =
    Number.isFinite(Number(expectedSubmittedAtEpochMs)) && Number(expectedSubmittedAtEpochMs) > 0
      ? Number(expectedSubmittedAtEpochMs)
      : null;
  const next = existing.filter((entry) => {
    if (normalizeSkuForCompare(entry.sku) !== normalizedSku) return true;
    if (
      normalizedExpectedSubmittedAtEpochMs !== null &&
      Number(entry.submittedAtEpochMs) !== normalizedExpectedSubmittedAtEpochMs
    ) {
      return true;
    }
    removed = true;
    return false;
  });
  if (!removed) return false;
  await writeGlobalDockPendingEntries(next);
  return true;
}

function normalizeSubmitRequestId(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/.test(value) ? value : "";
}

function createSubmitAttemptToken(): string {
  return `attempt_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseNewNamesRecentTitleCache(
  raw: unknown,
  now: number,
): Record<string, NewNamesRecentTitleCacheEntry> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const parsed: Record<string, NewNamesRecentTitleCacheEntry> = {};
  for (const [cacheKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const normalizedTitle = normalizeProductTitleForCompare(record.normalizedTitle);
    const title = normalizeProductTitleWhitespace(record.title);
    const expiresAt = Number(record.expiresAt);
    if (!normalizedTitle || !title || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
    parsed[cacheKey] = {
      normalizedTitle,
      title,
      expiresAt,
    };
  }

  return parsed;
}

async function loadNewNamesRecentTitleCache(
  now = Date.now(),
): Promise<Record<string, NewNamesRecentTitleCacheEntry>> {
  return parseNewNamesRecentTitleCache(await readCache(NEW_NAMES_RECENT_CACHE_KEY), now);
}

async function isNewNamesTitleRecentlySynced(
  normalizedTitle: string,
  now = Date.now(),
): Promise<boolean> {
  if (!normalizedTitle) return false;
  const cacheKey = await sha256Hex(normalizedTitle);
  const cache = await loadNewNamesRecentTitleCache(now);
  return cache[cacheKey]?.normalizedTitle === normalizedTitle;
}

async function rememberNewNamesTitle(
  normalizedTitle: string,
  title: string,
  now = Date.now(),
): Promise<void> {
  if (!normalizedTitle || !title) return;
  const cacheKey = await sha256Hex(normalizedTitle);
  const cache = await loadNewNamesRecentTitleCache(now);
  cache[cacheKey] = {
    normalizedTitle,
    title,
    expiresAt: now + NEW_NAMES_RECENT_TTL_MS,
  };
  await writeCache(NEW_NAMES_RECENT_CACHE_KEY, cache);
}

async function buildSubmitPayloadHash(productData: Record<string, unknown>): Promise<string> {
  const fingerprint = stableStringify({
    sku: String(productData.sku ?? "").trim(),
    brand: String(productData.brand ?? "").trim(),
    title: String(productData.title ?? "").trim(),
    mainCategory: String(productData.mainCategory ?? "").trim(),
    additionalCategories: Array.isArray(productData.additionalCategories)
      ? productData.additionalCategories.map((value) => String(value ?? "").trim())
      : [],
    imageUrls: Array.isArray(productData.imageUrls)
      ? productData.imageUrls.map((value) => String(value ?? "").trim())
      : [],
    specifications:
      productData.specifications && typeof productData.specifications === "object" && !Array.isArray(productData.specifications)
        ? Object.fromEntries(
            Object.entries(productData.specifications as Record<string, unknown>).map(([key, value]) => [
              key,
              String(value ?? "").trim(),
            ]),
          )
        : {},
    chatgptDescription: String(productData.chatgptDescription ?? "").trim(),
    chatgptData: String(productData.chatgptData ?? "").trim(),
    emailNotes: String(productData.emailNotes ?? "").trim(),
    price: String(productData.price ?? "").trim(),
    productVisible: String(productData.productVisible ?? "").trim(),
    customFields: String(productData.customFields ?? "").trim(),
    isOverwrite: productData.isOverwrite === true,
    duplicateTitleConfirmed: productData.duplicateTitleConfirmed === true,
  });
  return await sha256Hex(fingerprint);
}

function getSubmitIdempotencyCacheKey(requestId: string): string {
  return `${SUBMIT_IDEMPOTENCY_CACHE_PREFIX}${requestId}`;
}

function sanitizeSubmitIdempotencyRecord(raw: unknown): SubmitIdempotencyRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const requestId = normalizeSubmitRequestId(record.requestId);
  const sku = typeof record.sku === "string" ? record.sku.trim() : "";
  const payloadHash = typeof record.payloadHash === "string" ? record.payloadHash.trim() : "";
  const status = record.status === "completed" || record.status === "failed" ? record.status : "in_progress";
  const phase = record.phase === "event_logged" ? "event_logged" : "claimed";
  const attemptToken = typeof record.attemptToken === "string" ? record.attemptToken.trim() : "";
  const createdAtEpochMs = Number(record.createdAtEpochMs);
  const updatedAtEpochMs = Number(record.updatedAtEpochMs);
  const processedAt = typeof record.processedAt === "string" ? record.processedAt.trim() : "";
  const error = typeof record.error === "string" ? record.error.trim() : "";
  const eventId = typeof record.eventId === "string" ? record.eventId.trim() : "";
  if (!requestId || !sku || !payloadHash || !attemptToken) return null;
  if (!Number.isFinite(createdAtEpochMs) || !Number.isFinite(updatedAtEpochMs)) return null;
  return {
    requestId,
    sku,
    payloadHash,
    isOverwrite: record.isOverwrite === true,
    status,
    phase,
    attemptToken,
    createdAtEpochMs,
    updatedAtEpochMs,
    eventId: eventId || undefined,
    processedAt: processedAt || undefined,
    error: error || undefined,
  };
}

async function readSubmitIdempotencyRecord(requestId: string): Promise<SubmitIdempotencyRecord | null> {
  const normalizedRequestId = normalizeSubmitRequestId(requestId);
  if (!normalizedRequestId) return null;
  return sanitizeSubmitIdempotencyRecord(await readCache(getSubmitIdempotencyCacheKey(normalizedRequestId)));
}

async function tryInsertSubmitIdempotencyRecord(record: SubmitIdempotencyRecord): Promise<"inserted" | "duplicate"> {
  const sb = getServiceRoleClient();
  if (!sb) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for submit idempotency.");
  }

  const { error } = await (sb as any)
    .from("sheet_cache")
    .insert({
      cache_key: getSubmitIdempotencyCacheKey(record.requestId),
      response_data: record,
      updated_at: new Date(record.updatedAtEpochMs).toISOString(),
    });

  if (!error) return "inserted";
  if (isOutputWorkLockDuplicateError(error)) return "duplicate";
  throw error;
}

async function writeSubmitIdempotencyRecord(record: SubmitIdempotencyRecord): Promise<void> {
  await writeCache(getSubmitIdempotencyCacheKey(record.requestId), record);
}

async function removeSubmitIdempotencyRecord(requestId: string): Promise<void> {
  const normalizedRequestId = normalizeSubmitRequestId(requestId);
  if (!normalizedRequestId) return;
  await deleteCache(getSubmitIdempotencyCacheKey(normalizedRequestId));
}

function getSubmitIdempotencyStaleMs(record: SubmitIdempotencyRecord): number {
  return record.phase === "event_logged" ? SUBMIT_IDEMPOTENCY_EVENT_STALE_MS : SUBMIT_IDEMPOTENCY_CLAIM_STALE_MS;
}

async function inspectSubmitIdempotencyBackendState(args: {
  token: string;
  sheetId: string;
  eventsTab: string;
  dockTab: string;
  sku: string;
  isOverwrite: boolean;
}): Promise<SubmitIdempotencyClaimResult | null> {
  const [dockBlock, eventRows] = await Promise.all([
    readReadableLoadingDockBlockForSku(args.token, args.sheetId, args.dockTab, args.sku),
    readRecentEventRowsForSku(args.token, args.sheetId, args.eventsTab, args.sku),
  ]);

  const latestSubmitState = getLatestSubmitLikeEventStateForSku(eventRows, args.sku);
  if (latestSubmitState) {
    if (latestSubmitState.hasError) {
      return {
        kind: "failed",
        error: getLatestDockErrorMessageForSku(eventRows, args.sku) || `Submission for SKU "${args.sku}" failed.`,
      };
    }
    if (isSubmitLikeEventPending(latestSubmitState)) {
      return {
        kind: "pending",
        reason: `Request for SKU "${args.sku}" is already being processed.`,
      };
    }
    if (latestSubmitState.processedAt) {
      return {
        kind: "completed",
        processedAt: latestSubmitState.processedAt,
      };
    }
  }

  if (!args.isOverwrite && dockBlock) {
    return {
      kind: "pending",
      reason: `A Loading Dock row already exists for SKU "${args.sku}".`,
    };
  }

  return null;
}

function getLoadingDockTitleEntries(rows: string[][]): Array<{ sku: string; title: string }> {
  const entries: Array<{ sku: string; title: string }> = [];
  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const headers = (rows[rowIdx - 1] ?? []).map((value) => String(value ?? "").trim());
    const productRow = (rows[rowIdx] ?? []).map((value) => String(value ?? ""));
    if (headers.length === 0 || productRow.length === 0) continue;

    const skuColIdx = findCol(headers, ["Product Code/SKU", "Product ID", "SKU"]);
    const titleColIdx = findCol(headers, ["Product Name", "Name", "Title"]);
    if (skuColIdx === -1 || titleColIdx === -1) continue;

    const sku = (productRow[skuColIdx] ?? "").toString().trim();
    const title = (productRow[titleColIdx] ?? "").toString().trim();
    if (!sku || !title) continue;
    entries.push({ sku, title });
  }
  return entries;
}

async function readExistingTitlesForDuplicateCheck(
  token: string,
  sheetId: string,
  newNamesTab: string,
  existingProdsTab: string,
): Promise<string[]> {
  const [newNamesRaw, existingProdsRaw] = await Promise.all([
    getSheetValuesStrict(token, sheetId, `${newNamesTab}!A:A`),
    getSheetValuesStrict(token, sheetId, `${existingProdsTab}!B:B`),
  ]);

  const newNamesTitles = newNamesRaw.slice(1).map((row) => (row[0] ?? "").toString().trim()).filter(Boolean);
  const existingProdsTitles = existingProdsRaw.slice(1).map((row) => (row[0] ?? "").toString().trim()).filter(Boolean);
  return [...new Set([...newNamesTitles, ...existingProdsTitles])];
}

async function claimSubmitIdempotency(args: {
  token: string;
  sheetId: string;
  eventsTab: string;
  dockTab: string;
  productData: Record<string, unknown>;
  sku: string;
  isOverwrite: boolean;
}): Promise<SubmitIdempotencyClaimResult> {
  const requestId = normalizeSubmitRequestId(args.productData.requestId);
  if (!requestId) return { kind: "legacy" };

  const payloadHash = await buildSubmitPayloadHash(args.productData);
  const now = Date.now();
  const draftRecord: SubmitIdempotencyRecord = {
    requestId,
    sku: args.sku,
    payloadHash,
    isOverwrite: args.isOverwrite,
    status: "in_progress",
    phase: "claimed",
    attemptToken: createSubmitAttemptToken(),
    createdAtEpochMs: now,
    updatedAtEpochMs: now,
  };

  const insertResult = await tryInsertSubmitIdempotencyRecord(draftRecord);
  if (insertResult === "inserted") {
    return { kind: "owner", record: draftRecord };
  }

  const existing = await readSubmitIdempotencyRecord(requestId);
  if (!existing) {
    return {
      kind: "pending",
      reason: `A matching request for SKU "${args.sku}" is already being processed.`,
    };
  }

  if (
    normalizeSkuForCompare(existing.sku) !== normalizeSkuForCompare(args.sku) ||
    existing.payloadHash !== payloadHash ||
    existing.isOverwrite !== args.isOverwrite
  ) {
    return {
      kind: "failed",
      error: `Submit request ID conflict for SKU "${args.sku}". Refresh and submit again.`,
    };
  }

  const backendState = await inspectSubmitIdempotencyBackendState(args);
  if (backendState?.kind === "completed") {
    await writeSubmitIdempotencyRecord({
      ...existing,
      status: "completed",
      updatedAtEpochMs: now,
      processedAt: backendState.processedAt,
      error: undefined,
    });
    return backendState;
  }

  if (backendState?.kind === "failed") {
    await writeSubmitIdempotencyRecord({
      ...existing,
      status: "failed",
      updatedAtEpochMs: now,
      error: backendState.error,
    });
    return backendState;
  }

  if (backendState?.kind === "pending") {
    await writeSubmitIdempotencyRecord({
      ...existing,
      updatedAtEpochMs: now,
    });
    return backendState;
  }

  if (existing.status === "completed" && existing.processedAt) {
    return { kind: "completed", processedAt: existing.processedAt, eventId: existing.eventId };
  }
  if (existing.status === "failed" && existing.error) {
    return { kind: "failed", error: existing.error };
  }

  const staleMs = getSubmitIdempotencyStaleMs(existing);
  if ((now - existing.updatedAtEpochMs) <= staleMs) {
    return {
      kind: "pending",
      reason: `A matching request for SKU "${args.sku}" is already in progress.`,
      eventId: existing.eventId,
    };
  }

  const resumedRecord: SubmitIdempotencyRecord = {
    ...existing,
    status: "in_progress",
    phase: "claimed",
    attemptToken: createSubmitAttemptToken(),
    updatedAtEpochMs: now,
    error: undefined,
    processedAt: undefined,
    eventId: undefined,
  };
  await writeSubmitIdempotencyRecord(resumedRecord);
  return { kind: "owner", record: resumedRecord };
}

function parseOutputWorkLockEntry(raw: unknown): OutputWorkLockEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const ownerToken = typeof record.ownerToken === "string" ? record.ownerToken.trim() : "";
  const acquiredAtEpochMs = Number(record.acquiredAtEpochMs);
  const expiresAt = Number(record.expiresAt);
  if (!ownerToken || !Number.isFinite(acquiredAtEpochMs) || !Number.isFinite(expiresAt)) return null;
  return { ownerToken, acquiredAtEpochMs, expiresAt };
}

function isOutputWorkLockDuplicateError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message : "";
  return code === "23505" || /duplicate key/i.test(message);
}

async function readOutputWorkLockRecord(): Promise<{ entry: OutputWorkLockEntry | null; updatedAt: string }> {
  const sb = getServiceRoleClient();
  if (!sb) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for the OUTPUT_Work submit lock.");
  }

  const { data, error } = await sb
    .from("sheet_cache")
    .select("response_data,updated_at")
    .eq("cache_key", OUTPUT_WORK_LOCK_CACHE_KEY)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read OUTPUT_Work submit lock: ${error.message}`);
  }

  return {
    entry: parseOutputWorkLockEntry(data?.response_data ?? null),
    updatedAt: typeof data?.updated_at === "string" ? data.updated_at : "",
  };
}

async function tryInsertOutputWorkLock(entry: OutputWorkLockEntry): Promise<boolean> {
  const sb = getServiceRoleClient();
  if (!sb) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for the OUTPUT_Work submit lock.");
  }

  const { error } = await sb
    .from("sheet_cache")
    .insert({
      cache_key: OUTPUT_WORK_LOCK_CACHE_KEY,
      response_data: entry,
      updated_at: new Date(entry.acquiredAtEpochMs).toISOString(),
    });

  if (!error) return true;
  if (isOutputWorkLockDuplicateError(error)) return false;
  throw new Error(`Failed to create OUTPUT_Work submit lock: ${error.message}`);
}

async function replaceStaleOutputWorkLock(
  expectedUpdatedAt: string,
  entry: OutputWorkLockEntry,
): Promise<boolean> {
  if (!expectedUpdatedAt) return false;
  const sb = getServiceRoleClient();
  if (!sb) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for the OUTPUT_Work submit lock.");
  }

  const { data, error } = await sb
    .from("sheet_cache")
    .update({
      response_data: entry,
      updated_at: new Date(entry.acquiredAtEpochMs).toISOString(),
    })
    .eq("cache_key", OUTPUT_WORK_LOCK_CACHE_KEY)
    .eq("updated_at", expectedUpdatedAt)
    .select("response_data");

  if (error) {
    throw new Error(`Failed to replace stale OUTPUT_Work submit lock: ${error.message}`);
  }

  if (!Array.isArray(data) || data.length !== 1) return false;
  return parseOutputWorkLockEntry(data[0]?.response_data)?.ownerToken === entry.ownerToken;
}

function findLoadingDockSkuRowIndex(colERows: string[][], sku: string): number {
  const targetSku = normalizeSkuForCompare(sku);
  if (!targetSku) return -1;

  // Prefer the newest matching block (scan bottom-up).
  // Expected 4-row layout SKU rows are idx 2, 6, 10, ...
  for (let i = colERows.length - 1; i >= 2; i--) {
    if ((i - 2) % 4 !== 0) continue;
    if (normalizeSkuForCompare(colERows[i]?.[0]) === targetSku) {
      return i;
    }
  }

  // Fallback: tolerate layout drift, still prefer newest.
  for (let i = colERows.length - 1; i >= 2; i--) {
    if (normalizeSkuForCompare(colERows[i]?.[0]) === targetSku) {
      return i;
    }
  }

  return -1;
}

function toColumnLetter(colNum: number): string {
  let n = colNum;
  let result = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

async function readReadableLoadingDockBlockForSku(
  token: string,
  sheetId: string,
  dockTab: string,
  sku: string,
): Promise<{ skuRowIdx: number; headers: string[]; productRow: string[]; emailRow: string[] } | null> {
  const trimmedSku = sku.trim();
  if (!trimmedSku) return null;

  const dockColE = await getSheetValues(token, sheetId, `${dockTab}!E:E`);
  const skuRowIdx = findLoadingDockSkuRowIndex(dockColE, trimmedSku);
  if (skuRowIdx === -1) return null;

  const skuRowNumber = skuRowIdx + 1;
  const blockRows = await getSheetValues(token, sheetId, `${dockTab}!A${Math.max(1, skuRowNumber - 1)}:ZZ${skuRowNumber + 1}`);
  const headerRow = blockRows[0] ?? [];
  const productRow = blockRows[1] ?? [];
  const emailRow = blockRows[2] ?? [];
  const headers = headerRow.map((h: string) => (h ?? "").toString().trim());
  if (headers.length === 0) return null;

  const skuColIdx = findCol(headers, ["Product Code/SKU", "Product ID", "SKU"]);
  if (skuColIdx === -1) return null;

  const rowSku = normalizeSkuForCompare(productRow[skuColIdx]);
  if (rowSku && rowSku !== normalizeSkuForCompare(trimmedSku)) return null;

  return {
    skuRowIdx,
    headers,
    productRow,
    emailRow,
  };
}

async function readRecentEventRowsForSku(
  token: string,
  sheetId: string,
  eventsTab: string,
  sku: string,
  lookbackRows = 24,
): Promise<string[][]> {
  const trimmedSku = sku.trim();
  if (!trimmedSku) return [];

  const eventSkuRows = await getSheetValues(token, sheetId, `${eventsTab}!D:D`);
  let lastMatchRowNumber = -1;
  for (let i = eventSkuRows.length - 1; i >= 1; i--) {
    const cellValue = (eventSkuRows[i]?.[0] ?? "").toString().trim();
    if (!cellValue) continue;
    const affectsSku = parseSkuList(cellValue).some(
      (listedSku) => normalizeSkuForCompare(listedSku) === normalizeSkuForCompare(trimmedSku),
    );
    if (affectsSku) {
      lastMatchRowNumber = i + 1;
      break;
    }
  }

  if (lastMatchRowNumber === -1) return [];

  const windowStartRowNumber = Math.max(2, lastMatchRowNumber - lookbackRows);
  return await getSheetValues(token, sheetId, `${eventsTab}!A${windowStartRowNumber}:G${lastMatchRowNumber}`, { render: "unformatted" });
}

function normalizeSkuForCompare(raw: unknown): string {
  return (raw ?? "").toString().trim().toUpperCase();
}

function normalizeBrandForLookup(raw: unknown): string {
  return (raw ?? "").toString().trim().toUpperCase();
}

function buildBrandNameMap(rows: string[][]): Map<string, string> {
  const brandNameMap = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const brand = normalizeBrandForLookup(row[0] ?? "");
    const brandName = (row[1] ?? "").toString().trim();
    if (!brand || !brandName || brandNameMap.has(brand)) continue;
    brandNameMap.set(brand, brandName);
  }
  return brandNameMap;
}

function resolveBrandName(brand: unknown, brandNameMap: Map<string, string>): string {
  const trimmedBrand = (brand ?? "").toString().trim();
  if (!trimmedBrand) return "";
  return brandNameMap.get(normalizeBrandForLookup(trimmedBrand)) ?? trimmedBrand;
}

function buildProductBrandMap(rows: string[][]): Map<string, string> {
  const productBrandMap = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const sku = normalizeSkuForCompare(row[0] ?? "");
    const brand = (row[1] ?? "").toString().trim();
    if (!sku || !brand || productBrandMap.has(sku)) continue;
    productBrandMap.set(sku, brand);
  }
  return productBrandMap;
}

function resolveBrandNameForSku(
  sku: unknown,
  productBrandMap: Map<string, string>,
  brandNameMap: Map<string, string>,
  fallbackBrand?: unknown,
): string {
  const productBrand = productBrandMap.get(normalizeSkuForCompare(sku));
  if (productBrand) {
    return resolveBrandName(productBrand, brandNameMap);
  }
  return resolveBrandName(fallbackBrand, brandNameMap);
}

function isSubmitLikeEventType(eventType: string): eventType is "SUBMIT" | "SUBMIT_OVERRIDE" | "UPLOAD" {
  return eventType === "SUBMIT" || eventType === "SUBMIT_OVERRIDE" || eventType === "UPLOAD";
}

function isCompletionEventType(eventType: string): boolean {
  return eventType === "COPY_ENGINE_RUN_COMPLETE" || eventType === "MPN_RESERVE_WEB_BATCH";
}

function getPendingDockActionStates(eventRows: string[][], dockSkuSet: Set<string>): Record<string, DockPendingActionType> {
  const pendingBySku: Record<string, DockPendingActionType> = {};
  const resolvedSkus = new Set<string>();
  const now = Date.now();

  const markResolved = (rawSku: string, actionType?: DockPendingActionType) => {
    const normalizedSku = normalizeSkuForCompare(rawSku);
    if (!normalizedSku || resolvedSkus.has(normalizedSku) || !dockSkuSet.has(normalizedSku)) return;
    resolvedSkus.add(normalizedSku);
    if (actionType) pendingBySku[normalizedSku] = actionType;
  };

  for (let i = eventRows.length - 1; i >= 1; i--) {
    const row = eventRows[i] ?? [];
    const eventType = (row[2] ?? "").toString().trim().toUpperCase();
    const processedAt = (row[5] ?? "").toString().trim();
    const errorMsg = (row[6] ?? "").toString().trim();
    const eventEpochMs = extractEventEpochMs(
      (row[0] ?? "").toString(),
      (row[1] ?? "").toString(),
    );
    const isFreshPending =
      !processedAt &&
      !errorMsg &&
      eventEpochMs > 0 &&
      (now - eventEpochMs) <= STALE_PENDING_EVENT_MAX_AGE_MS;

    if (eventType === "DOCK_DELETE") {
      markResolved((row[3] ?? "").toString(), isFreshPending ? "delete" : undefined);
      continue;
    }

    if (eventType === "EMAIL_SINGLE") {
      markResolved((row[3] ?? "").toString(), isFreshPending ? "email" : undefined);
      continue;
    }

    if (eventType === "SEND_DOCK") {
      const mode = (row[4] ?? "").toString().trim().toUpperCase();
      const actionType: DockPendingActionType = mode === "SEND" ? "send" : "clear";
      for (const sku of parseSkuList((row[3] ?? "").toString())) {
        markResolved(sku, isFreshPending ? actionType : undefined);
      }
    }
  }

  return pendingBySku;
}

function findReadableLoadingDockBlock(
  allRows: string[][],
  sku: string,
): { skuRowIdx: number; headers: string[]; productRow: string[]; emailRow: string[] } | null {
  const targetSku = normalizeSkuForCompare(sku);
  if (!targetSku) return null;

  const candidateIdxs: number[] = [];
  for (let i = allRows.length - 1; i >= 2; i--) {
    const candidateSku = normalizeSkuForCompare(allRows[i]?.[4]);
    if (candidateSku === targetSku) candidateIdxs.push(i);
  }

  for (const skuRowIdx of candidateIdxs) {
    const headerRow = allRows[skuRowIdx - 1] ?? [];
    const productRow = allRows[skuRowIdx] ?? [];
    const emailRow = allRows[skuRowIdx + 1] ?? [];
    const headers = headerRow.map((h: string) => (h ?? "").toString().trim());
    if (headers.length === 0) continue;

    const skuColIdx = findCol(headers, ["Product Code/SKU", "Product ID", "SKU"]);
    if (skuColIdx === -1) continue;

    const rowSku = normalizeSkuForCompare(productRow[skuColIdx]);
    if (rowSku && rowSku !== targetSku) continue;

    return { skuRowIdx, headers, productRow, emailRow };
  }

  return null;
}

async function getLatestOutputWorkRowsForSku(
  token: string,
  sheetId: string,
  outputWorkTab: string,
  sku: string,
  readMode: "strict" | "lenient" = "lenient",
): Promise<{ headers: string[]; productRow: string[]; emailRow: string[]; productRowNum: number; emailRowNum: number } | null> {
  const targetSku = normalizeSkuForCompare(sku);
  if (!targetSku) return null;

  const readValues = readMode === "strict" ? getSheetValuesStrict : getSheetValues;

  const headerWindowRows = await readValues(token, sheetId, `${outputWorkTab}!1:20`);
  const layout = resolveOutputWorkLayout(headerWindowRows);
  const headers = (layout?.headers ?? (headerWindowRows[0] ?? [])).map((h: string) => (h ?? "").toString().trim());
  if (headers.length === 0) return null;

  const skuColIdx = findCol(headers, ["Product Code/SKU", "Product ID", "SKU"]);
  if (skuColIdx === -1) return null;

  const toColumnLetter = (colNum: number): string => {
    let n = colNum;
    let result = "";
    while (n > 0) {
      const remainder = (n - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      n = Math.floor((n - 1) / 26);
    }
    return result;
  };

  const skuColLetter = toColumnLetter(skuColIdx + 1);
  const skuColRows = await readValues(token, sheetId, `${outputWorkTab}!${skuColLetter}:${skuColLetter}`);

  let outputSkuRowIdx = -1;
  for (let i = skuColRows.length - 1; i >= 1; i--) {
    if (normalizeSkuForCompare(skuColRows[i]?.[0]) === targetSku) {
      outputSkuRowIdx = i;
      break;
    }
  }
  if (outputSkuRowIdx === -1) return null;

  const productRowNum = outputSkuRowIdx + 1;
  const emailRowNum = productRowNum + 1;
  const [productRowData, emailRowData] = await Promise.all([
    readValues(token, sheetId, `${outputWorkTab}!${productRowNum}:${productRowNum}`),
    readValues(token, sheetId, `${outputWorkTab}!${emailRowNum}:${emailRowNum}`),
  ]);

  return {
    headers,
    productRow: productRowData[0] ?? [],
    emailRow: emailRowData[0] ?? [],
    productRowNum,
    emailRowNum,
  };
}

function extractEventEpochMs(timestampRaw: string, eventIdRaw: string): number {
  const eventIdMatch = eventIdRaw.trim().match(/^EVT-(\d{13,})$/);
  if (eventIdMatch) {
    const epoch = Number(eventIdMatch[1]);
    if (Number.isFinite(epoch) && epoch > 0) return epoch;
  }
  return parseSheetTimestampMs(timestampRaw);
}

function getLatestSubmitLikeEventStateForSku(
  eventRows: string[][],
  sku: string,
): {
  eventType: "SUBMIT" | "SUBMIT_OVERRIDE" | "UPLOAD";
  processedAt: string;
  hasError: boolean;
  eventEpochMs: number;
  submittedAt: string;
} | null {
  const targetSku = normalizeSkuForCompare(sku);
  if (!targetSku) return null;
  let sawErrorAfterSubmitLike = false;
  let latestCompletionProcessedAt = "";

  for (let i = eventRows.length - 1; i >= 1; i--) {
    const row = eventRows[i] ?? [];
    const eventType = (row[2] ?? "").toString().trim().toUpperCase();
    const eventSku = normalizeSkuForCompare(row[3]);
    const processedAt = (row[5] ?? "").toString().trim();
    if (eventSku !== targetSku) continue;
    if (eventType === "ERROR" || eventType === "DOCK_DELETE") {
      sawErrorAfterSubmitLike = true;
      continue;
    }
    if (isCompletionEventType(eventType) && processedAt) {
      if (!latestCompletionProcessedAt) latestCompletionProcessedAt = processedAt;
      continue;
    }
    if (!isSubmitLikeEventType(eventType)) continue;

    const eventEpochMs = extractEventEpochMs(
      (row[0] ?? "").toString(),
      (row[1] ?? "").toString(),
    );

    return {
      eventType,
      processedAt: processedAt || latestCompletionProcessedAt,
      hasError: Boolean((row[6] ?? "").toString().trim()) || sawErrorAfterSubmitLike,
      eventEpochMs,
      submittedAt: normalizeTimestampForClient(
        (row[0] ?? "").toString(),
        (row[1] ?? "").toString(),
      ),
    };
  }
  return null;
}

function isSubmitLikeEventPending(
  state: { eventType: "SUBMIT" | "SUBMIT_OVERRIDE" | "UPLOAD"; processedAt: string; hasError: boolean; eventEpochMs: number } | null,
): boolean {
  if (!state) return false;
  const processedAt = state.processedAt.trim();
  if (processedAt || state.hasError) return false;

  // Self-heal stale pending events that never got processedAt due upstream failures.
  if (state.eventEpochMs > 0 && (Date.now() - state.eventEpochMs) > STALE_PENDING_EVENT_MAX_AGE_MS) {
    return false;
  }

  return true;
}

function getSubmittedAtHint(body: Record<string, unknown>): string {
  return typeof body.submittedAt === "string" ? body.submittedAt.trim() : "";
}

function validateSubmittedAtHintForSku(
  eventRows: string[][],
  sku: string,
  submittedAtHint: string,
): {
  state: "ok" | "pending" | "changed";
  latestSubmittedAt: string;
} {
  if (!submittedAtHint) {
    return { state: "ok", latestSubmittedAt: "" };
  }

  const latestSubmitState = getLatestSubmitLikeEventStateForSku(eventRows, sku);
  const latestSubmittedAt = latestSubmitState?.submittedAt?.trim() || "";

  if (latestSubmitState && isSubmitLikeEventPending(latestSubmitState)) {
    return { state: "pending", latestSubmittedAt };
  }

  if (latestSubmittedAt && !timestampsRoughlyMatch(submittedAtHint, latestSubmittedAt)) {
    return { state: "changed", latestSubmittedAt };
  }

  return { state: "ok", latestSubmittedAt };
}

function getLatestDockErrorMessageForSku(eventRows: string[][], sku: string): string {
  const targetSku = normalizeSkuForCompare(sku);
  if (!targetSku) return "";

  for (let i = eventRows.length - 1; i >= 1; i--) {
    const row = eventRows[i] ?? [];
    const eventType = (row[2] ?? "").toString().trim().toUpperCase();
    const eventSku = normalizeSkuForCompare(row[3]);
    const errorMsg = (row[6] ?? "").toString().trim();
    if (eventSku !== targetSku) continue;
    if ((eventType === "ERROR" || eventType === "DOCK_DELETE") && errorMsg) return errorMsg;
    if ((eventType === "SUBMIT" || eventType === "SUBMIT_OVERRIDE" || eventType === "UPLOAD") && errorMsg) return errorMsg;
  }

  return "";
}

async function readEventRowState(
  token: string,
  sheetId: string,
  eventsTab: string,
  rowNumber: number | null,
): Promise<EventRowState | null> {
  if (!rowNumber || rowNumber < 2) return null;

  const rows = await getSheetValuesStrict(token, sheetId, `${eventsTab}!A${rowNumber}:G${rowNumber}`, { render: "unformatted" });
  const row = rows[0] ?? [];
  if (!row.some((cell) => String(cell ?? "").trim() !== "")) return null;

  return {
    eventId: (row[1] ?? "").toString().trim(),
    eventType: (row[2] ?? "").toString().trim().toUpperCase(),
    sku: (row[3] ?? "").toString().trim(),
    mpn: (row[4] ?? "").toString().trim(),
    processedAt: normalizeTimestampForClient(row[5]),
    error: (row[6] ?? "").toString().trim(),
  };
}

function buildLoadingDockSkuSet(rows: string[][]): Set<string> {
  const skus = new Set<string>();

  for (let headerRowIdx = 1; headerRowIdx < rows.length; headerRowIdx += 4) {
    const productRowIdx = headerRowIdx + 1;
    if (productRowIdx >= rows.length) break;

    const headers = (rows[headerRowIdx] ?? []).map((value) => String(value ?? "").trim());
    const productRow = (rows[productRowIdx] ?? []).map((value) => String(value ?? "").trim());
    const skuColIdx = findCol(headers, ["Product Code/SKU", "Product ID", "SKU"]);
    if (skuColIdx === -1) continue;

    const normalizedSku = normalizeSkuForCompare(productRow[skuColIdx] ?? "");
    if (normalizedSku) skus.add(normalizedSku);
  }

  return skus;
}

function listRemainingDockSkus(rows: string[][], targetSkus: string[]): string[] {
  const dockSkuSet = buildLoadingDockSkuSet(rows);
  const remaining: string[] = [];
  const seen = new Set<string>();

  for (const sku of targetSkus) {
    const normalizedSku = normalizeSkuForCompare(sku);
    if (!normalizedSku || seen.has(normalizedSku)) continue;
    seen.add(normalizedSku);
    if (dockSkuSet.has(normalizedSku)) {
      remaining.push(sku.trim());
    }
  }

  return remaining;
}

function parseSendDockSummary(summary: string): ParsedSendDockSummary {
  const raw = summary.trim();
  const deletedMatch = raw.match(/OK:\s*(\d+)\s*\/\s*(\d+)\s*deleted/i);
  const emailedMatch = raw.match(/,\s*(\d+)\s+emailed/i);

  return {
    deleted: deletedMatch ? Number(deletedMatch[1]) : null,
    expectedDeleted: deletedMatch ? Number(deletedMatch[2]) : null,
    emailed: emailedMatch ? Number(emailedMatch[1]) : null,
    hasErrors: /\bERRORS:/i.test(raw),
    fatal: /\bFATAL:/i.test(raw),
    raw,
  };
}

function isNonFatalDockActionWarning(raw: string): boolean {
  return /^warn:/i.test(raw.trim());
}

async function waitForDockDeleteCompletion(
  token: string,
  sheetId: string,
  args: {
    eventsTab: string;
    dockTab: string;
    sku: string;
    eventRowNumber: number | null;
  },
): Promise<DockDeleteWaitResult> {
  const startedAt = Date.now();
  let consecutiveReadFailures = 0;
  let lastProcessedAt = "";
  let lastError = "";

  while (true) {
    try {
      const eventState = await readEventRowState(token, sheetId, args.eventsTab, args.eventRowNumber);
      consecutiveReadFailures = 0;

      lastProcessedAt = eventState?.processedAt ?? "";
      lastError = eventState?.error ?? "";

      // Treat Processed_At as the source of truth for completion.
      // Dock row deletion can lag due to Sheets caching, so do not fail-fast on "still present" checks.
      if (lastProcessedAt) {
        if (lastError && isNonFatalDockActionWarning(lastError)) {
          return { status: "completed", processedAt: lastProcessedAt, warning: lastError };
        }
        if (lastError && !/sku block not found in loading dock/i.test(lastError)) {
          return { status: "failed", error: lastError };
        }
        return { status: "completed", processedAt: lastProcessedAt };
      }
    } catch (error) {
      consecutiveReadFailures++;
      // Verification reads are best-effort; don't fail the delete if quota is tight.
      if (consecutiveReadFailures >= POST_WRITE_VERIFICATION_READ_RETRY_MAX) {
        return {
          status: "pending",
          reason: `Delete for SKU "${args.sku}" is queued, but verification is rate-limited. Please refresh Loading Dock in a moment.`,
        };
      }
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= DOCK_DELETE_STABILIZE_MAX_WAIT_MS) {
      if (!lastProcessedAt) {
        return {
          status: "pending",
          reason: `Delete for SKU "${args.sku}" is still processing after ${Math.round(elapsed / 1000)} seconds.`,
        };
      }

      if (lastError && isNonFatalDockActionWarning(lastError)) {
        return { status: "completed", processedAt: lastProcessedAt, warning: lastError };
      }

      if (lastError && !/sku block not found in loading dock/i.test(lastError)) {
        return { status: "failed", error: lastError };
      }

      return { status: "completed", processedAt: lastProcessedAt };
    }

    await sleepMs(DOCK_DELETE_STABILIZE_POLL_MS);
  }
}

async function waitForEmailSingleCompletion(
  token: string,
  sheetId: string,
  args: {
    eventsTab: string;
    dockTab: string;
    sku: string;
    eventRowNumber: number | null;
  },
): Promise<EmailSingleWaitResult> {
  const startedAt = Date.now();
  let consecutiveReadFailures = 0;
  let lastProcessedAt = "";
  let lastError = "";

  while (true) {
    try {
      // Only read event state — dock row verification is less critical for email-then-delete.
      const eventState = await readEventRowState(token, sheetId, args.eventsTab, args.eventRowNumber);
      consecutiveReadFailures = 0;

      lastProcessedAt = eventState?.processedAt ?? "";
      lastError = eventState?.error ?? "";

      // Warnings mean the email pipeline completed, but a follow-up sync needs attention.
      if (lastProcessedAt && lastError && isNonFatalDockActionWarning(lastError)) {
        return { status: "completed", processedAt: lastProcessedAt, warning: lastError };
      }

      // If processed with error, return failure.
      if (lastProcessedAt && lastError) {
        return { status: "failed", error: lastError };
      }

      // If processed without error, consider it completed.
      // Dock row removal can lag due to Sheets caching — don't fail on that.
      if (lastProcessedAt) {
        return { status: "completed", processedAt: lastProcessedAt };
      }
    } catch {
      consecutiveReadFailures++;
      // Verification reads are best-effort — don't fail email due to rate limits.
      if (consecutiveReadFailures >= POST_WRITE_VERIFICATION_READ_RETRY_MAX) {
        return {
          status: "pending",
          reason: `Email for SKU "${args.sku}" is queued, but verification is rate-limited. Please refresh Loading Dock in a moment.`,
        };
      }
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= EMAIL_SINGLE_VERIFY_MAX_WAIT_MS) {
      if (!lastProcessedAt) {
        return {
          status: "pending",
          reason: `Email for SKU "${args.sku}" is queued and will be processed shortly.`,
        };
      }

      if (lastError && isNonFatalDockActionWarning(lastError)) {
        return { status: "completed", processedAt: lastProcessedAt, warning: lastError };
      }

      if (lastError) {
        return { status: "failed", error: lastError };
      }

      return { status: "completed", processedAt: lastProcessedAt };
    }

    await sleepMs(EMAIL_SINGLE_VERIFY_POLL_MS);
  }
}

async function waitForSendDockCompletion(
  token: string,
  sheetId: string,
  args: {
    eventsTab: string;
    dockTab: string;
    targetSkus: string[];
    mode: "SEND" | "CLEAR";
    eventRowNumber: number | null;
  },
): Promise<SendDockWaitResult> {
  const startedAt = Date.now();
  let consecutiveReadFailures = 0;
  let lastProcessedAt = "";
  let lastSummary = "";

  // Use appropriate timeout based on mode: CLEAR does direct deletion in this function,
  // SEND relies on Apps Script (email + delete) so we just do a quick verification window.
  const maxWaitMs = args.mode === "CLEAR" ? SEND_DOCK_CLEAR_VERIFY_MAX_WAIT_MS : SEND_DOCK_SEND_VERIFY_MAX_WAIT_MS;
  const modeLabel = args.mode === "SEND" ? "Send All" : "Clear Dock";

  while (true) {
    try {
      // Only read event state — dock verification consumes quota and can lag.
      const eventState = await readEventRowState(token, sheetId, args.eventsTab, args.eventRowNumber);
      consecutiveReadFailures = 0;

      lastProcessedAt = eventState?.processedAt ?? "";
      lastSummary = eventState?.error ?? "";

      const parsedSummary = parseSendDockSummary(lastSummary);
      const deleted = parsedSummary.deleted ?? args.targetSkus.length;
      const emailed = args.mode === "SEND" ? (parsedSummary.emailed ?? deleted) : 0;

      if (lastProcessedAt && (parsedSummary.fatal || parsedSummary.hasErrors)) {
        return {
          status: "failed",
          error: parsedSummary.raw || `${modeLabel} completed with errors.`,
          deleted,
          emailed,
          summary: parsedSummary.raw,
        };
      }

      // If processed without fatal error, consider it completed.
      if (lastProcessedAt) {
        return {
          status: "completed",
          processedAt: lastProcessedAt,
          deleted,
          emailed,
          summary: parsedSummary.raw,
        };
      }
    } catch {
      consecutiveReadFailures++;
      // Verification reads are best-effort — don't fail batch due to rate limits.
      if (consecutiveReadFailures >= POST_WRITE_VERIFICATION_READ_RETRY_MAX) {
        return {
          status: "pending",
          reason: `${modeLabel} is queued, but verification is rate-limited. Refresh Loading Dock in a moment.`,
        };
      }
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWaitMs) {
      const parsedSummary = parseSendDockSummary(lastSummary);
      const deleted = parsedSummary.deleted ?? 0;
      const emailed = args.mode === "SEND" ? (parsedSummary.emailed ?? 0) : 0;

      if (!lastProcessedAt) {
        return {
          status: "pending",
          reason: `${modeLabel} is queued and will complete shortly.`,
        };
      }

      if (parsedSummary.fatal || parsedSummary.hasErrors) {
        return {
          status: "failed",
          error: parsedSummary.raw || `${modeLabel} completed with partial results.`,
          deleted,
          emailed,
          summary: parsedSummary.raw,
        };
      }

      return {
        status: "completed",
        processedAt: lastProcessedAt,
        deleted,
        emailed,
        summary: parsedSummary.raw,
      };
    }

    await sleepMs(SEND_DOCK_VERIFY_POLL_MS);
  }
}

function hasActiveGlobalPendingForSku(
  globalPendingEntries: GlobalDockPendingEntry[],
  sku: string,
): boolean {
  const targetSku = normalizeSkuForCompare(sku);
  if (!targetSku) return false;
  return globalPendingEntries.some((entry) => normalizeSkuForCompare(entry.sku) === targetSku);
}

function getGlobalPendingEntryForSku(
  globalPendingEntries: GlobalDockPendingEntry[],
  sku: string,
): GlobalDockPendingEntry | null {
  const targetSku = normalizeSkuForCompare(sku);
  if (!targetSku) return null;
  return globalPendingEntries.find((entry) => normalizeSkuForCompare(entry.sku) === targetSku) ?? null;
}

function isDockMutationPendingForSku(
  eventRows: string[][],
  globalPendingEntries: GlobalDockPendingEntry[],
  sku: string,
): boolean {
  const normalizedSku = normalizeSkuForCompare(sku);
  if (!normalizedSku) return false;
  const pendingDockActions = getPendingDockActionStates(eventRows, new Set([normalizedSku]));
  return isSubmitLikeEventPending(getLatestSubmitLikeEventStateForSku(eventRows, sku))
    || hasActiveGlobalPendingForSku(globalPendingEntries, sku)
    || Boolean(pendingDockActions[normalizedSku]);
}

function parseSkuList(raw: string): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const sku = part.trim();
    const normalizedSku = normalizeSkuForCompare(sku);
    if (!normalizedSku || seen.has(normalizedSku)) continue;
    seen.add(normalizedSku);
    ordered.push(sku);
  }
  return ordered;
}

/**
 * Processed_At Gate: ensures ALL previous SUBMIT/UPLOAD events have completed
 * (Processed_At column filled) before allowing a new write to OUTPUT_Work.
 * This prevents race conditions where a second submission overwrites OUTPUT_Work
 * before CopyEngine finishes processing the first one.
 *
 * Scales timeout dynamically from the base queue wait budget.
 * Current tuning uses 13.5s per pending item, so the gate tolerates
 * roughly 10 queued items before it hits the free-tier wall-clock cap.
 *
 * Returns immediately if no pending events exist or if the gate opens within timeout.
 * Throws if the gate doesn't open within the scaled timeout.
 */
async function waitForProcessedAtGate(token: string, sheetId: string, eventsTab: string): Promise<void> {
  // LOADING DOCK IS NO LONGER IN USE - Bypass the gate completely so actions don't hang
  // waiting for Apps Script or legacy processors.
  return;

  const writeEventTypes = ["SUBMIT", "SUBMIT_OVERRIDE", "UPLOAD", "FORM_EMAIL"];
  const startedAt = Date.now();
  let dynamicMaxWaitMs = PROCESSED_AT_GATE_BASE_WAIT_MS;
  let consecutiveReadFailures = 0;

  while (true) {
    let rows: string[][] = [];
    try {
      // Single read of the full Events table (columns A-G) — avoids burning two reads
      // per poll cycle. For large event sheets, only scan the last 80 rows.
      const allRows = await getSheetValuesStrict(token, sheetId, `${eventsTab}!A:G`);
      const lastRow = allRows.length;
      const scanStart = Math.max(1, lastRow - 79);
      rows = allRows.slice(scanStart);
      consecutiveReadFailures = 0;
    } catch (error) {
      consecutiveReadFailures++;
      if (consecutiveReadFailures < PROCESSED_AT_GATE_READ_RETRY_MAX) {
        console.warn(
          `Processed_At gate read failed (${consecutiveReadFailures}/${PROCESSED_AT_GATE_READ_RETRY_MAX}) — retrying`,
          error,
        );
        await sleepMs(PROCESSED_AT_GATE_POLL_MS);
        continue;
      }
      throw new Error(
        "Could not verify the CopyEngine queue state in Google Sheets. Write blocked to avoid overwriting OUTPUT_Work; please retry.",
      );
    }

    if (rows.length === 0) return;

    // Scan ALL rows in the window (not just bottom-up with early break).
    // Pending events may be interleaved with completed non-SUBMIT events.
    const now = Date.now();
    let pendingCount = 0;
    let hasAnyPending = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const eventId = (rows[i]?.[1] ?? "").toString().trim();
      const eventType = (rows[i]?.[2] ?? "").toString().trim().toUpperCase();
      if (!eventId.startsWith("EVT-")) continue;
      if (!writeEventTypes.includes(eventType)) continue;

      const processedAt = (rows[i]?.[5] ?? "").toString().trim();
      const errorMsg = (rows[i]?.[6] ?? "").toString().trim();

      // Skip completed events — but DON'T break, there may be older pending ones
      if (processedAt || errorMsg) continue;

      const match = eventId.match(/^EVT-(\d{13,})$/);
      const epoch = match ? parseInt(match[1], 10) : 0;
      if (epoch > 0 && (now - epoch) > PROCESSED_AT_GATE_ABANDON_MS) {
        continue; // abandoned
      }

      pendingCount++;
      hasAnyPending = true;
    }

    if (!hasAnyPending) return;

    dynamicMaxWaitMs = Math.min(
      PROCESSED_AT_GATE_MAX_WAIT_MS,
      Math.max(PROCESSED_AT_GATE_BASE_WAIT_MS, pendingCount * PROCESSED_AT_GATE_BASE_WAIT_MS),
    );

    const elapsed = now - startedAt;
    if (elapsed >= dynamicMaxWaitMs) {
      throw new Error(`Another product is still being processed (${pendingCount} item${pendingCount !== 1 ? "s" : ""} in queue, waited ${Math.round(elapsed / 1000)}s). Please wait a moment and try again.`);
    }

    console.log(`Processed_At gate: ${pendingCount} pending item(s), waiting (${Math.round(elapsed / 1000)}s / ${Math.round(dynamicMaxWaitMs / 1000)}s max)...`);
    await sleepMs(PROCESSED_AT_GATE_POLL_MS);
  }
}

function getTimezoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const rawHour = get("hour");
  // Some Intl builds can emit midnight as 24:00:00 for Melbourne local time.
  // Treat that as same-day 00:00:00 so client and edge parsing stay aligned.
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = get("minute");
  const second = get("second");
  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtcMs - utcMs;
}

function melbourneLocalToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let utcMs = localAsUtcMs;
  for (let i = 0; i < 3; i++) {
    const offsetMs = getTimezoneOffsetMs(MELBOURNE_TIMEZONE, utcMs);
    const next = localAsUtcMs - offsetMs;
    if (Math.abs(next - utcMs) < 500) break;
    utcMs = next;
  }
  return utcMs;
}

function parseGoogleSheetsSerialTimestamp(raw: string | number): number {
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric > 1e11) return Math.round(numeric);
  if (numeric < 20_000 || numeric > 80_000) return 0;
  return Math.round((numeric - 25569) * 86_400_000);
}

function parseSheetTimestampMs(raw: unknown): number {
  if (raw == null) return 0;
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }

  const serialMs = parseGoogleSheetsSerialTimestamp(raw as string | number);
  if (serialMs > 0) return serialMs;

  const trimmed = String(raw).trim();
  if (!trimmed) return 0;

  const dayFirstDateTimeMatch = trimmed.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{2}):(\d{2})(?::(\d{2}))?(?:\s*(AEST|AEDT))?$/i,
  );
  if (dayFirstDateTimeMatch) {
    const day = Number(dayFirstDateTimeMatch[1]);
    const month = Number(dayFirstDateTimeMatch[2]);
    const year = Number(dayFirstDateTimeMatch[3]);
    const hour = Number(dayFirstDateTimeMatch[4]);
    const minute = Number(dayFirstDateTimeMatch[5]);
    const second = Number(dayFirstDateTimeMatch[6] ?? "0");
    const tzAbbr = (dayFirstDateTimeMatch[7] ?? "").toUpperCase();
    if (tzAbbr === "AEST" || tzAbbr === "AEDT") {
      const offset = tzAbbr === "AEST" ? "+10:00" : "+11:00";
      const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${offset}`;
      const parsed = Date.parse(iso);
      if (Number.isFinite(parsed)) return parsed;
    }
    return melbourneLocalToUtcMs(year, month, day, hour, minute, second);
  }

  const dayFirstDateMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dayFirstDateMatch) {
    return melbourneLocalToUtcMs(
      Number(dayFirstDateMatch[3]),
      Number(dayFirstDateMatch[2]),
      Number(dayFirstDateMatch[1]),
      0,
      0,
      0,
    );
  }

  const isoLikeDateTimeMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*(AEST|AEDT))?$/i,
  );
  if (isoLikeDateTimeMatch) {
    const year = Number(isoLikeDateTimeMatch[1]);
    const month = Number(isoLikeDateTimeMatch[2]);
    const day = Number(isoLikeDateTimeMatch[3]);
    const hour = Number(isoLikeDateTimeMatch[4]);
    const minute = Number(isoLikeDateTimeMatch[5]);
    const second = Number(isoLikeDateTimeMatch[6] ?? "0");
    const tzAbbr = (isoLikeDateTimeMatch[7] ?? "").toUpperCase();
    if (tzAbbr === "AEST" || tzAbbr === "AEDT") {
      const offset = tzAbbr === "AEST" ? "+10:00" : "+11:00";
      const iso = `${isoLikeDateTimeMatch[1]}-${isoLikeDateTimeMatch[2]}-${isoLikeDateTimeMatch[3]}T${isoLikeDateTimeMatch[4]}:${isoLikeDateTimeMatch[5]}:${String(second).padStart(2, "0")}${offset}`;
      const parsed = Date.parse(iso);
      if (Number.isFinite(parsed)) return parsed;
    }
    return melbourneLocalToUtcMs(year, month, day, hour, minute, second);
  }

  const isoLikeDateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoLikeDateMatch) {
    return melbourneLocalToUtcMs(
      Number(isoLikeDateMatch[1]),
      Number(isoLikeDateMatch[2]),
      Number(isoLikeDateMatch[3]),
      0,
      0,
      0,
    );
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMelbourneDateTimeParts(date: Date): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MELBOURNE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";

  const rawHour = get("hour");

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: rawHour === "24" ? "00" : rawHour,
    minute: get("minute"),
    second: get("second"),
  };
}

function getMelbourneTimeZoneAbbreviation(date: Date): string {
  const offsetHours = getTimezoneOffsetMs(MELBOURNE_TIMEZONE, date.getTime()) / 3_600_000;
  if (Math.abs(offsetHours - 11) < 0.01) return "AEDT";
  if (Math.abs(offsetHours - 10) < 0.01) return "AEST";
  const sign = offsetHours >= 0 ? "+" : "-";
  const abs = Math.abs(offsetHours);
  const hours = String(Math.trunc(abs)).padStart(2, "0");
  const minutes = String(Math.round((abs % 1) * 60)).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

function normalizeTimestampForClient(raw: unknown, eventIdRaw = ""): string {
  const eventIdMatch = eventIdRaw.trim().match(/^EVT-(\d{13,})$/);
  if (eventIdMatch) {
    const epoch = Number(eventIdMatch[1]);
    if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch).toISOString();
  }
  const parsedMs = parseSheetTimestampMs(raw);
  if (parsedMs > 0) return new Date(parsedMs).toISOString();
  return String(raw ?? "").trim();
}

function timestampsRoughlyMatch(leftRaw: unknown, rightRaw: unknown, toleranceMs = 5_000): boolean {
  const leftMs = parseSheetTimestampMs(leftRaw);
  const rightMs = parseSheetTimestampMs(rightRaw);
  if (!Number.isFinite(leftMs) || leftMs <= 0 || !Number.isFinite(rightMs) || rightMs <= 0) {
    return false;
  }
  return Math.abs(leftMs - rightMs) <= toleranceMs;
}

/** Melbourne-local timestamp string (used in Events logging across all handlers) */
function melbourneTimestamp(date = new Date()): string {
  const parts = getMelbourneDateTimeParts(date);
  const tzAbbr = getMelbourneTimeZoneAbbreviation(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${tzAbbr}`;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// OUTPUT_Work submits use a brief backend lease while the edge function stages the
// next product. CopyEngine still uses DocumentLock, and Processed_At remains the
// main "queue open/closed" signal for the frontend and subsequent writes.

function hasLikelyOutputWorkHeaders(row: string[]): boolean {
  const normalized = row
    .map((v) => (v ?? "").toString().trim().toLowerCase())
    .filter(Boolean);
  if (normalized.length < 3) return false;

  const requiredHints = ["product code/sku", "product name", "product description"];
  return requiredHints.every((hint) => normalized.includes(hint));
}

function resolveOutputWorkLayout(rows: string[][]): OutputWorkLayout | null {
  if (!rows.length) return null;

  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = (rows[i] ?? []).map((h) => (h ?? "").toString().trim());
    if (hasLikelyOutputWorkHeaders(row)) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    for (let i = 0; i < rows.length; i++) {
      const row = (rows[i] ?? []).map((h) => (h ?? "").toString().trim());
      if (row.filter(Boolean).length >= 3) {
        headerIdx = i;
        break;
      }
    }
  }

  if (headerIdx === -1) return null;

  const headers = (rows[headerIdx] ?? []).map((h) => (h ?? "").toString().trim());
  if (headers.length === 0) return null;

  const productTemplateRow = (rows[headerIdx + 1] ?? []).map((v) => (v ?? "").toString());
  const emailTemplateRow = (rows[headerIdx + 2] ?? []).map((v) => (v ?? "").toString());

  return {
    headers,
    productTemplateRow,
    emailTemplateRow,
  };
}

async function writeSheetBlock(
  token: string,
  sheetId: string,
  startRange: string,
  rows: string[][],
  options?: { valueInputOption?: "USER_ENTERED" | "RAW" },
): Promise<void> {
  const sanitizedRows = rows.map((row) =>
    row.map((cell) => sanitizeForFormulas((cell ?? "").toString()))
  );
  const valueInputOption = options?.valueInputOption ?? "USER_ENTERED";

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(startRange)}?valueInputOption=${valueInputOption}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: sanitizedRows }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to write block ${startRange}: ${errText}`);
  }
}

async function clearSheetRange(
  token: string,
  sheetId: string,
  range: string,
): Promise<void> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:clear`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to clear range ${range}: ${errText}`);
  }
}

async function updateSheetRange(
  token: string,
  sheetId: string,
  range: string,
  rows: string[][],
  options?: { valueInputOption?: "USER_ENTERED" | "RAW" },
): Promise<void> {
  await writeSheetBlock(token, sheetId, range, rows, options);
}

type BatchValueUpdate = { range: string; values: string[][] };

async function batchUpdateSheetValues(
  token: string,
  sheetId: string,
  updates: BatchValueUpdate[],
): Promise<void> {
  if (updates.length === 0) return;

  const sanitized = updates.map((u) => ({
    range: u.range,
    values: u.values.map((row) => row.map((cell) => sanitizeForFormulas((cell ?? "").toString()))),
  }));

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: sanitized }),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to batch update values: ${errText}`);
  }
}

async function acquireOutputWorkLock(): Promise<OutputWorkLockHandle> {
  const ownerToken = `EDGE_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const sb = getServiceRoleClient();

  if (!sb) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for strict OUTPUT_Work locking. Write blocked to avoid concurrent staging.");
  }

  for (let attempt = 1; attempt <= OUTPUT_WORK_LOCK_MAX_ATTEMPTS; attempt++) {
    const now = Date.now();
    const entry: OutputWorkLockEntry = {
      ownerToken,
      acquiredAtEpochMs: now,
      expiresAt: now + OUTPUT_WORK_LOCK_STALE_MS,
    };

    const inserted = await tryInsertOutputWorkLock(entry);
    if (inserted) {
      return { ownerToken, cacheKey: OUTPUT_WORK_LOCK_CACHE_KEY };
    }

    const current = await readOutputWorkLockRecord();
    const currentEntry = current.entry;
    const isStale = !currentEntry || currentEntry.expiresAt <= now;
    if (isStale) {
      const replaced = await replaceStaleOutputWorkLock(current.updatedAt, entry);
      if (replaced) {
        return { ownerToken, cacheKey: OUTPUT_WORK_LOCK_CACHE_KEY };
      }
    }

    await sleepMs(OUTPUT_WORK_LOCK_RETRY_DELAY_MS);
  }

  throw new Error("Could not acquire the OUTPUT_Work submit lock. Another submission is still starting; please retry.");
}

async function releaseOutputWorkLock(lock: OutputWorkLockHandle | null): Promise<void> {
  if (!lock) return;

  const sb = getServiceRoleClient();
  if (!sb) return;

  try {
    const current = await readOutputWorkLockRecord();
    if (current.entry?.ownerToken !== lock.ownerToken) return;

    const { error } = await sb
      .from("sheet_cache")
      .delete()
      .eq("cache_key", lock.cacheKey);
    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    console.warn("Failed to release OUTPUT_Work lock:", error);
  }
}

function parseDockEmailSingleLockEntry(raw: unknown): DockEmailSingleLockEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const ownerToken = typeof record.ownerToken === "string" ? record.ownerToken.trim() : "";
  const acquiredAtEpochMs = Number(record.acquiredAtEpochMs);
  const expiresAt = Number(record.expiresAt);
  const sku = typeof record.sku === "string" ? record.sku.trim() : "";
  if (!ownerToken || !Number.isFinite(acquiredAtEpochMs) || !Number.isFinite(expiresAt) || !sku) return null;
  return { ownerToken, acquiredAtEpochMs, expiresAt, sku };
}

async function readDockEmailSingleLockRecord(cacheKey: string): Promise<{ entry: DockEmailSingleLockEntry | null; updatedAt: string }> {
  const sb = getServiceRoleClient();
  if (!sb) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for strict Loading Dock email locking.");
  }

  const { data, error } = await sb
    .from("sheet_cache")
    .select("response_data,updated_at")
    .eq("cache_key", cacheKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read Loading Dock email lock: ${error.message}`);
  }

  return {
    entry: parseDockEmailSingleLockEntry(data?.response_data ?? null),
    updatedAt: typeof data?.updated_at === "string" ? data.updated_at : "",
  };
}

async function tryInsertDockEmailSingleLock(cacheKey: string, entry: DockEmailSingleLockEntry): Promise<boolean> {
  const sb = getServiceRoleClient();
  if (!sb) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for strict Loading Dock email locking.");
  }

  const { error } = await sb
    .from("sheet_cache")
    .insert({
      cache_key: cacheKey,
      response_data: entry,
      updated_at: new Date(entry.acquiredAtEpochMs).toISOString(),
    });

  if (!error) return true;
  if (isOutputWorkLockDuplicateError(error)) return false;
  throw new Error(`Failed to create Loading Dock email lock: ${error.message}`);
}

async function replaceStaleDockEmailSingleLock(
  cacheKey: string,
  expectedUpdatedAt: string,
  entry: DockEmailSingleLockEntry,
): Promise<boolean> {
  if (!expectedUpdatedAt) return false;
  const sb = getServiceRoleClient();
  if (!sb) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for strict Loading Dock email locking.");
  }

  const { data, error } = await sb
    .from("sheet_cache")
    .update({
      response_data: entry,
      updated_at: new Date(entry.acquiredAtEpochMs).toISOString(),
    })
    .eq("cache_key", cacheKey)
    .eq("updated_at", expectedUpdatedAt)
    .select("response_data");

  if (error) {
    throw new Error(`Failed to replace stale Loading Dock email lock: ${error.message}`);
  }

  if (!Array.isArray(data) || data.length !== 1) return false;
  return parseDockEmailSingleLockEntry(data[0]?.response_data)?.ownerToken === entry.ownerToken;
}

async function acquireDockEmailSingleLock(sku: string): Promise<DockEmailSingleLockHandle> {
  const normalizedSku = normalizeSkuForCompare(sku);
  if (!normalizedSku) {
    throw new Error("Invalid SKU for Loading Dock email lock.");
  }

  const ownerToken = `EDGE_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const cacheKey = `${DOCK_EMAIL_SINGLE_LOCK_CACHE_PREFIX}${normalizedSku}`;

  for (let attempt = 1; attempt <= DOCK_EMAIL_SINGLE_LOCK_MAX_ATTEMPTS; attempt++) {
    const now = Date.now();
    const entry: DockEmailSingleLockEntry = {
      ownerToken,
      acquiredAtEpochMs: now,
      expiresAt: now + DOCK_EMAIL_SINGLE_LOCK_STALE_MS,
      sku: normalizedSku,
    };

    const inserted = await tryInsertDockEmailSingleLock(cacheKey, entry);
    if (inserted) {
      return { ownerToken, cacheKey };
    }

    const current = await readDockEmailSingleLockRecord(cacheKey);
    const currentEntry = current.entry;
    const isStale = !currentEntry || currentEntry.expiresAt <= now;
    if (isStale) {
      const replaced = await replaceStaleDockEmailSingleLock(cacheKey, current.updatedAt, entry);
      if (replaced) {
        return { ownerToken, cacheKey };
      }
    }

    await sleepMs(DOCK_EMAIL_SINGLE_LOCK_RETRY_DELAY_MS);
  }

  throw new Error(`Email for SKU "${normalizedSku}" is already being queued by another request. Refresh and try again.`);
}

async function releaseDockEmailSingleLock(lock: DockEmailSingleLockHandle | null): Promise<void> {
  if (!lock) return;

  const sb = getServiceRoleClient();
  if (!sb) return;

  try {
    const current = await readDockEmailSingleLockRecord(lock.cacheKey);
    if (current.entry?.ownerToken !== lock.ownerToken) return;

    const { error } = await sb
      .from("sheet_cache")
      .delete()
      .eq("cache_key", lock.cacheKey);
    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    console.warn("Failed to release Loading Dock email lock:", error);
  }
}

async function acquireDockDeleteLock(sku: string): Promise<DockEmailSingleLockHandle> {
  const normalizedSku = normalizeSkuForCompare(sku);
  if (!normalizedSku) {
    throw new Error("Invalid SKU for Loading Dock delete lock.");
  }

  const ownerToken = `EDGE_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const cacheKey = `${DOCK_DELETE_LOCK_CACHE_PREFIX}${normalizedSku}`;

  for (let attempt = 1; attempt <= DOCK_DELETE_LOCK_MAX_ATTEMPTS; attempt++) {
    const now = Date.now();
    const entry: DockEmailSingleLockEntry = {
      ownerToken,
      acquiredAtEpochMs: now,
      expiresAt: now + DOCK_DELETE_LOCK_STALE_MS,
      sku: normalizedSku,
    };

    const inserted = await tryInsertDockEmailSingleLock(cacheKey, entry);
    if (inserted) {
      return { ownerToken, cacheKey };
    }

    const current = await readDockEmailSingleLockRecord(cacheKey);
    const currentEntry = current.entry;
    const isStale = !currentEntry || currentEntry.expiresAt <= now;
    if (isStale) {
      const replaced = await replaceStaleDockEmailSingleLock(cacheKey, current.updatedAt, entry);
      if (replaced) {
        return { ownerToken, cacheKey };
      }
    }

    await sleepMs(DOCK_DELETE_LOCK_RETRY_DELAY_MS);
  }

  throw new Error(`Delete for SKU "${normalizedSku}" is already being queued by another request. Refresh and try again.`);
}

async function releaseDockDeleteLock(lock: DockEmailSingleLockHandle | null): Promise<void> {
  if (!lock) return;

  const sb = getServiceRoleClient();
  if (!sb) return;

  try {
    const current = await readDockEmailSingleLockRecord(lock.cacheKey);
    if (current.entry?.ownerToken !== lock.ownerToken) return;

    const { error } = await sb
      .from("sheet_cache")
      .delete()
      .eq("cache_key", lock.cacheKey);
    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    console.warn("Failed to release Loading Dock delete lock:", error);
  }
}

async function syncProductsTodoCompleteForSku(
  token: string,
  sheetId: string,
  productsTab: string,
  sku: string,
): Promise<string | undefined> {
  try {
    const rows = await getSheetValues(token, sheetId, `${productsTab}!A:C`);
    const trimmedSku = sku.trim();
    let foundRow = -1;
    let currentStatus = "";
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i]?.[0] ?? "").toString().trim() === trimmedSku) {
        foundRow = i + 1;
        currentStatus = (rows[i]?.[2] ?? "").toString().trim().toUpperCase();
        break;
      }
    }
    if (foundRow === -1) {
      return "WARN: Entry removed, but SKU was not found in PRODUCTS TO DO for COMPLETE sync.";
    }
    if (currentStatus === "COMPLETE") return undefined;
    await updateSheetCell(token, sheetId, productsTab, foundRow, "C", "COMPLETE");
    return undefined;
  } catch (err) {
    console.warn(`Failed to mark ${sku} COMPLETE after dock delete:`, err);
    return "WARN: Entry removed, but COMPLETE status could not be updated.";
  }
}

function getCellByAliases(
  headers: string[],
  row: string[],
  aliases: string[],
): string {
  const idx = findCol(headers, aliases);
  return idx === -1 ? "" : (row[idx] ?? "").toString().trim();
}

async function reserveNextWebMpn(
  token: string,
  sheetId: string,
  eventsTab: string,
  sku: string,
): Promise<number> {
  const DEFAULT_START = 57324;
  const panelRows = await getSheetValuesStrict(token, sheetId, `${eventsTab}!I3:I8`);
  const label = (panelRows[0]?.[0] ?? "").toString().trim();
  let nextMpn = Number(panelRows[1]?.[0]);
  if (label !== "NEXT_MPN" || !Number.isFinite(nextMpn) || nextMpn <= 0) {
    nextMpn = DEFAULT_START;
    await updateSheetRange(token, sheetId, `${eventsTab}!I3:I4`, [["NEXT_MPN"], [String(DEFAULT_START)]]);
  }

  const reserved = nextMpn;
  const after = reserved + 1;
  const statusMsg = `Web reserved ${reserved}, NEXT_MPN -> ${after} (${melbourneTimestamp()})`;
  await updateSheetRange(token, sheetId, `${eventsTab}!I4:I5`, [[String(after)], [statusMsg]]);

  const ts = melbourneTimestamp();
  const eventId = `EVT-${Date.now()}`;
  await appendEventRowStrict(token, sheetId, eventsTab, [ts, eventId, "MPN_RESERVE_WEB", sku, String(reserved), ts, ""]);
  return reserved;
}

const OUTPUT_TEMPLATE_SNAPSHOT_CACHE_TTL_MS = 10 * 60 * 1000;

type CachedOutputWorkTemplateSnapshotRecord = {
  cachedAtEpochMs: number;
  snapshot: OutputWorkTemplateSnapshot;
};

let _outputWorkTemplateSnapshotMemCache: {
  cacheKey: string;
  record: CachedOutputWorkTemplateSnapshotRecord;
} | null = null;

function buildOutputWorkTemplateSnapshotCacheKey(sheetId: string, outputTemplateTab: string): string {
  return `output_template_snapshot:${sheetId}:${outputTemplateTab}`;
}

function parseCachedOutputWorkTemplateSnapshotRecord(raw: unknown): CachedOutputWorkTemplateSnapshotRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const cachedAtEpochMs = Number(record.cachedAtEpochMs);
  if (!Number.isFinite(cachedAtEpochMs) || cachedAtEpochMs <= 0) return null;

  const snapshotRaw = record.snapshot;
  if (!snapshotRaw || typeof snapshotRaw !== "object" || Array.isArray(snapshotRaw)) return null;
  const snapshot = snapshotRaw as Record<string, unknown>;

  const width = Number(snapshot.width);
  if (!Number.isFinite(width) || width <= 0) return null;

  const layoutRaw = snapshot.layout;
  if (!layoutRaw || typeof layoutRaw !== "object" || Array.isArray(layoutRaw)) return null;
  const layout = layoutRaw as Record<string, unknown>;

  const headers = layout.headers;
  const productTemplateRow = layout.productTemplateRow;
  const emailTemplateRow = layout.emailTemplateRow;
  if (!Array.isArray(headers) || !Array.isArray(productTemplateRow) || !Array.isArray(emailTemplateRow)) return null;

  const paddedRowsRaw = snapshot.paddedRows;
  if (!Array.isArray(paddedRowsRaw)) return null;
  const paddedRows: string[][] = [];
  for (const row of paddedRowsRaw as unknown[]) {
    if (!Array.isArray(row)) return null;
    paddedRows.push(row.map((c) => (c ?? "").toString()));
  }

  return {
    cachedAtEpochMs,
    snapshot: {
      layout: {
        headers: (headers as unknown[]).map((v) => (v ?? "").toString()),
        productTemplateRow: (productTemplateRow as unknown[]).map((v) => (v ?? "").toString()),
        emailTemplateRow: (emailTemplateRow as unknown[]).map((v) => (v ?? "").toString()),
      },
      width,
      paddedRows,
    },
  };
}

async function loadOutputWorkTemplateSnapshot(
  token: string,
  sheetId: string,
  outputTemplateTab: string,
  fallbackTemplateTabs: string[] = [],
): Promise<OutputWorkTemplateSnapshot> {
  const now = Date.now();
  const cacheKey = buildOutputWorkTemplateSnapshotCacheKey(sheetId, outputTemplateTab);

  let fallbackSnapshot: OutputWorkTemplateSnapshot | null = null;

  // 1) In-memory cache (best-effort)
  if (_outputWorkTemplateSnapshotMemCache?.cacheKey === cacheKey) {
    const ageMs = now - _outputWorkTemplateSnapshotMemCache.record.cachedAtEpochMs;
    fallbackSnapshot = _outputWorkTemplateSnapshotMemCache.record.snapshot;
    if (ageMs >= 0 && ageMs <= OUTPUT_TEMPLATE_SNAPSHOT_CACHE_TTL_MS) {
      return _outputWorkTemplateSnapshotMemCache.record.snapshot;
    }
  }

  // 2) Persistent cache (sheet_cache) so all users share a snapshot
  const cachedRaw = await readCache(cacheKey);
  const cachedRecord = parseCachedOutputWorkTemplateSnapshotRecord(cachedRaw);
  if (cachedRecord) {
    _outputWorkTemplateSnapshotMemCache = { cacheKey, record: cachedRecord };
    const ageMs = now - cachedRecord.cachedAtEpochMs;
    fallbackSnapshot = fallbackSnapshot ?? cachedRecord.snapshot;
    if (ageMs >= 0 && ageMs <= OUTPUT_TEMPLATE_SNAPSHOT_CACHE_TTL_MS) {
      return cachedRecord.snapshot;
    }
  }

  // 3) Live read (source of truth)
  try {
    const candidateTabs = uniqueNonEmpty([outputTemplateTab, ...fallbackTemplateTabs]);
    let templateRows: string[][] | null = null;
    let templateLayout: OutputWorkLayout | null = null;
    let lastLiveReadError: unknown = null;

    for (const candidateTab of candidateTabs) {
      try {
        const candidateRows = await getSheetValuesStrict(token, sheetId, `${candidateTab}!1:10`);
        const candidateLayout = resolveOutputWorkLayout(candidateRows);
        if (!candidateLayout) {
          throw new Error(`No headers found in ${candidateTab} template rows`);
        }
        templateRows = candidateRows;
        templateLayout = candidateLayout;
        break;
      } catch (error) {
        lastLiveReadError = error;
        console.warn(
          `Failed to read output template snapshot from ${candidateTab}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    if (!templateRows || !templateLayout) {
      throw (lastLiveReadError instanceof Error
        ? lastLiveReadError
        : new Error("No headers found in OUTPUT_Template template rows"));
    }

    const width = Math.max(
      1,
      templateLayout.headers.length,
      ...templateRows.map((r) => r.length),
    );
    const paddedTemplateRows = templateRows.map((row) => {
      const next = row.map((c) => (c ?? "").toString());
      while (next.length < width) next.push("");
      return next;
    });

    const snapshot: OutputWorkTemplateSnapshot = {
      layout: templateLayout,
      width,
      paddedRows: paddedTemplateRows,
    };

    const record: CachedOutputWorkTemplateSnapshotRecord = {
      cachedAtEpochMs: now,
      snapshot,
    };

    _outputWorkTemplateSnapshotMemCache = { cacheKey, record };
    await writeCache(cacheKey, record);
    return snapshot;
  } catch (error) {
    if (fallbackSnapshot) {
      console.warn(
        `Failed to read ${outputTemplateTab}!1:10; using cached OUTPUT_Template snapshot (stale ok).`,
        error,
      );
      return fallbackSnapshot;
    }
    throw error;
  }
}

function normalizeOutputWorkRowsForTemplateCompare(
  rows: string[][],
  width: number,
  expectedRowCount: number,
): string[][] {
  const normalized: string[][] = [];
  for (let i = 0; i < expectedRowCount; i++) {
    const next = (rows[i] ?? []).map((c) => (c ?? "").toString());
    while (next.length < width) next.push("");
    normalized.push(next.slice(0, width));
  }
  return normalized;
}

async function resetOutputWorkFromTemplate(
  token: string,
  sheetId: string,
  outputWorkTab: string,
  outputTemplateTab: string,
  fallbackTemplateTabs: string[] = [],
): Promise<OutputWorkLayout> {
  const templateSnapshot = await loadOutputWorkTemplateSnapshot(
    token,
    sheetId,
    outputTemplateTab,
    fallbackTemplateTabs,
  );
  const expectedResetRows = normalizeOutputWorkRowsForTemplateCompare(
    templateSnapshot.paddedRows,
    templateSnapshot.width,
    templateSnapshot.paddedRows.length,
  );

  await clearSheetRange(token, sheetId, `${outputWorkTab}!A:ZZ`);
  await writeSheetBlock(token, sheetId, `${outputWorkTab}!A1`, templateSnapshot.paddedRows);

  const resetRows = await getSheetValuesStrict(token, sheetId, `${outputWorkTab}!1:10`);
  const normalizedResetRows = normalizeOutputWorkRowsForTemplateCompare(
    resetRows,
    templateSnapshot.width,
    templateSnapshot.paddedRows.length,
  );
  const matchesTemplate = JSON.stringify(normalizedResetRows) === JSON.stringify(expectedResetRows);
  if (!matchesTemplate) {
    throw new Error(
      "[resetOutputWorkFromTemplate] OUTPUT_Work did not match OUTPUT_Template after reset;"
      + ` templateRows=${expectedResetRows.length}; resetRows=${normalizedResetRows.length}; width=${templateSnapshot.width}`,
    );
  }
  return templateSnapshot.layout;
}

async function ensureOutputWorkMatchesTemplate(
  token: string,
  sheetId: string,
  outputWorkTab: string,
  outputTemplateTab: string,
  phase: string,
): Promise<EnsureOutputWorkTemplateResult> {
  const templateSnapshot = await loadOutputWorkTemplateSnapshot(token, sheetId, outputTemplateTab);
  const expectedRows = normalizeOutputWorkRowsForTemplateCompare(
    templateSnapshot.paddedRows,
    templateSnapshot.width,
    templateSnapshot.paddedRows.length,
  );
  const currentRows = await getSheetValuesStrict(token, sheetId, `${outputWorkTab}!1:10`);
  const normalizedCurrentRows = normalizeOutputWorkRowsForTemplateCompare(
    currentRows,
    templateSnapshot.width,
    templateSnapshot.paddedRows.length,
  );
  const alreadyTemplate = JSON.stringify(normalizedCurrentRows) === JSON.stringify(expectedRows);

  if (alreadyTemplate) {
    // Already matches — no reset or verification needed
    return { layout: templateSnapshot.layout, resetApplied: false };
  }

  await clearSheetRange(token, sheetId, `${outputWorkTab}!A:ZZ`);
  await writeSheetBlock(token, sheetId, `${outputWorkTab}!A1`, templateSnapshot.paddedRows);

  const verifiedRows = await getSheetValuesStrict(token, sheetId, `${outputWorkTab}!1:10`);
  const normalizedVerifiedRows = normalizeOutputWorkRowsForTemplateCompare(
    verifiedRows,
    templateSnapshot.width,
    templateSnapshot.paddedRows.length,
  );
  const matchesTemplate = JSON.stringify(normalizedVerifiedRows) === JSON.stringify(expectedRows);
  if (!matchesTemplate) {
    throw new Error(
      `[ensureOutputWorkMatchesTemplate:${phase}] OUTPUT_Work did not match OUTPUT_Template;`
      + ` resetApplied=yes;`
      + ` templateRows=${expectedRows.length}; verifiedRows=${normalizedVerifiedRows.length}; width=${templateSnapshot.width}`,
    );
  }

  return {
    layout: templateSnapshot.layout,
    resetApplied: true,
  };
}

async function enterOutputWorkSubmissionWindow(
  token: string,
  sheetId: string,
  eventsTab: string,
): Promise<OutputWorkLockHandle> {
  await waitForProcessedAtGate(token, sheetId, eventsTab);
  const lock = await acquireOutputWorkLock();
  try {
    await waitForProcessedAtGate(token, sheetId, eventsTab);
    return lock;
  } catch (error) {
    await releaseOutputWorkLock(lock);
    throw error;
  }
}

function buildOutputWorkSeedRows(layout: OutputWorkLayout): OutputWorkSeedRows {
  const headers = layout.headers.map((header) => (header ?? "").toString());
  const productRow = new Array(headers.length).fill("");
  const emailRow = new Array(headers.length).fill("");

  for (let i = 0; i < Math.min(layout.productTemplateRow.length, headers.length); i++) {
    productRow[i] = layout.productTemplateRow[i] ?? "";
  }
  for (let i = 0; i < Math.min(layout.emailTemplateRow.length, headers.length); i++) {
    emailRow[i] = layout.emailTemplateRow[i] ?? "";
  }

  return { headers, productRow, emailRow };
}

async function writeSeededOutputWorkRows(
  token: string,
  sheetId: string,
  outputWorkTab: string,
  rows: OutputWorkSeedRows,
): Promise<void> {
  const blankRow = new Array(rows.headers.length).fill("");
  await writeSheetBlock(token, sheetId, `${outputWorkTab}!A1`, [
    rows.headers,
    rows.productRow,
    rows.emailRow,
    blankRow,
    blankRow,
  ]);
}

async function syncTitleToNewNamesIfMissing(
  token: string,
  sheetId: string,
  newNamesTab: string,
  title: string,
): Promise<void> {
  const trimmedTitle = normalizeProductTitleWhitespace(title);
  const normalizedTitle = normalizeProductTitleForCompare(trimmedTitle);
  if (!trimmedTitle || !normalizedTitle) return;

  try {
    // Sheets append visibility can lag for a short time. Keep a short-lived
    // recent-title cache so back-to-back submits do not re-append the same name.
    if (await isNewNamesTitleRecentlySynced(normalizedTitle)) return;

    const existingNameRows = await getSheetValuesStrict(token, sheetId, `${newNamesTab}!A:A`);
    const existingNames = existingNameRows.map((row) => row[0] ?? "");
    if (hasNormalizedProductTitleMatch(existingNames, trimmedTitle)) {
      await rememberNewNamesTitle(normalizedTitle, trimmedTitle);
      return;
    }

    await appendRow(token, sheetId, `${newNamesTab}!A:A`, [trimmedTitle]);
    await rememberNewNamesTitle(normalizedTitle, trimmedTitle);
  } catch (error) {
    console.warn("Failed to sync NewNames (non-fatal):", error);
  }
}

async function stageSubmissionEvent(args: StageSubmissionArgs): Promise<StageSubmissionResult> {
  let appendedEventRowNumber: number | null = null;
  const expectedMpn = extractNumericMpnFromValue(args.eventRow[4]);
  try {
    await writeSeededOutputWorkRows(args.token, args.sheetId, args.outputWorkTab, args.stagedRows);

    // Give the Sheets backend a brief moment to expose the fresh OUTPUT_Work state
    // before the event row is appended.
    await sleepMs(200);

    const stagedRowsRead = await getSheetValuesStrict(args.token, args.sheetId, `${args.outputWorkTab}!1:5`);
    const stagedWidth = Math.max(
      args.stagedRows.headers.length,
      ...stagedRowsRead.map((row) => row.length),
      1,
    );
    const normalizeRows = (rows: string[][]): string[][] => rows.map((row) => {
      const next = row.map((value) => (value ?? "").toString());
      while (next.length < stagedWidth) next.push("");
      return next.slice(0, stagedWidth);
    });
    const expectedRows = normalizeRows([
      args.stagedRows.headers,
      args.stagedRows.productRow,
      args.stagedRows.emailRow,
      new Array(args.stagedRows.headers.length).fill(""),
      new Array(args.stagedRows.headers.length).fill(""),
    ]);
    const actualRows = normalizeRows([
      stagedRowsRead[0] ?? [],
      stagedRowsRead[1] ?? [],
      stagedRowsRead[2] ?? [],
      stagedRowsRead[3] ?? [],
      stagedRowsRead[4] ?? [],
    ]);
    const skuColIdx = findCol(args.stagedRows.headers, ["Product Code/SKU", "Product ID", "SKU"]);
    const observedSku = skuColIdx === -1
      ? ""
      : normalizeSkuForCompare(actualRows[1]?.[skuColIdx] ?? "");
    const expectedSku = normalizeSkuForCompare(args.sku);
    const stagedMatches = JSON.stringify(actualRows) === JSON.stringify(expectedRows);
    if (!stagedMatches || observedSku !== expectedSku) {
      throw new Error(
        "[stageSubmissionEvent] OUTPUT_Work staging verification failed;"
        + ` expectedSku=${args.sku}; observedSku=${observedSku || "blank"};`
        + ` stagedMatches=${stagedMatches ? "yes" : "no"};`
        + ` headerCount=${args.stagedRows.headers.length}; stagedWidth=${stagedWidth}`,
      );
    }

    for (const task of args.postEventTasks ?? []) {
      await task();
    }

    const appendResult = await appendEventRowStrict(args.token, args.sheetId, args.eventsTab, args.eventRow);
    appendedEventRowNumber = appendResult.rowNumber;
    await upsertGlobalDockPendingEntry(
      buildGlobalDockPendingEntry(args.sku, args.eventEpochMs, args.isOverwrite),
    );
    return { eventRowNumber: appendedEventRowNumber };
  } catch (error) {
    try {
      await removeGlobalDockPendingEntry(args.sku, args.eventEpochMs);
    } catch (pendingCleanupError) {
      console.warn("Failed to remove global pending entry during staging rollback:", pendingCleanupError);
    }
    try {
      await ensureOutputWorkMatchesTemplate(
        args.token,
        args.sheetId,
        args.outputWorkTab,
        args.outputTemplateTab,
        "stage_rollback",
      );
    } catch (resetError) {
      console.warn("Failed to reset OUTPUT_Work during staging rollback:", resetError);
    }
    if (appendedEventRowNumber) {
      try {
        await markSubmitEventProcessed(
          args.token,
          args.sheetId,
          args.eventsTab,
          appendedEventRowNumber,
          melbourneTimestamp(),
          expectedMpn,
          `[stageSubmissionEvent] ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch (eventMarkError) {
        console.warn("Failed to mark staged submit event as errored:", eventMarkError);
      }
    }
    throw error;
  }
}

function padRowToWidth(row: string[], width: number): string[] {
  const next = row.map((value) => (value ?? "").toString());
  while (next.length < width) next.push("");
  return next.slice(0, width);
}

function buildLoadingDockWriteRows(
  stagedRows: OutputWorkSeedRows,
  width: number,
): string[][] {
  return [
    padRowToWidth(stagedRows.headers, width),
    padRowToWidth(stagedRows.productRow, width),
    padRowToWidth(stagedRows.emailRow, width),
    new Array(width).fill(""),
  ];
}

function findNextLoadingDockHeaderRow(allRows: string[][]): number {
  if (allRows.length < 2) return 2;

  let lastHeaderRow: number | null = null;
  for (let headerRowIdx = 1; headerRowIdx < allRows.length; headerRowIdx += 4) {
    const productRowIdx = headerRowIdx + 1;
    if (productRowIdx >= allRows.length) break;

    const headers = (allRows[headerRowIdx] ?? []).map((value) => String(value ?? "").trim());
    const skuColIdx = findCol(headers, ["Product Code/SKU", "Product ID", "SKU"]);
    if (skuColIdx === -1) continue;

    const productSku = String(allRows[productRowIdx]?.[skuColIdx] ?? "").trim();
    if (productSku) lastHeaderRow = headerRowIdx + 1;
  }

  return lastHeaderRow === null ? 2 : lastHeaderRow + 4;
}

async function markSubmitEventProcessed(
  token: string,
  sheetId: string,
  eventsTab: string,
  rowNumber: number | null,
  processedAt: string,
  expectedMpn: number | null,
  error = "",
): Promise<void> {
  if (!rowNumber || rowNumber < 2) return;
  await updateSheetRange(token, sheetId, `${eventsTab}!E${rowNumber}:G${rowNumber}`, [[
    expectedMpn ? String(expectedMpn) : "",
    processedAt,
    error,
  ]], { valueInputOption: "RAW" });
}

async function completeSubmissionDirectly(args: DirectSubmissionCompletionArgs): Promise<SubmissionCommitResult> {
  let currentStage = "read_loading_dock";
  let dockRowCount = 0;
  let writeStartRow: number | null = null;
  const stageHistory: string[] = [];
  try {
    // The pre-stage reset already happened before OUTPUT_Work was populated.
    // Do not reset here, because the staged rows must remain available until the dock write completes.
    stageHistory.push("pre_reset_output_work(already_verified_during_stage)");

    const dockRows = await getSheetValuesFromTabCandidates(
      args.token,
      args.sheetId,
      [args.dockTab, "Loading Dock", "LOADING_DOCK", "LoadingDock"],
      "A:ZZ",
    );
    dockRowCount = dockRows.length;
    stageHistory.push(`read_loading_dock(rows=${dockRowCount})`);

    const existingDockBlock = findReadableLoadingDockBlock(dockRows, args.sku);
    if (args.isOverwrite && !existingDockBlock) {
      throw new Error(`Override target SKU "${args.sku}" is missing from Loading Dock during final write.`);
    }
    if (!args.isOverwrite && existingDockBlock) {
      throw new Error(`SKU "${args.sku}" already exists in Loading Dock during final write.`);
    }

    const width = Math.max(
      args.stagedRows.headers.length,
      ...dockRows.map((row) => row.length),
      1,
    );
    const rowsToWrite = buildLoadingDockWriteRows(args.stagedRows, width);
    writeStartRow = args.isOverwrite && existingDockBlock
      ? Math.max(1, existingDockBlock.skuRowIdx)
      : findNextLoadingDockHeaderRow(dockRows);

    currentStage = "write_loading_dock";
    await writeSheetBlock(args.token, args.sheetId, `${args.dockTab}!A${writeStartRow}`, rowsToWrite);
    stageHistory.push(`write_loading_dock(startRow=${writeStartRow}, width=${width})`);

    currentStage = "verify_loading_dock";
    await sleepMs(500);
    const writtenDockRows = await getSheetValuesStrict(
      args.token,
      args.sheetId,
      `${args.dockTab}!A${writeStartRow}:ZZ${writeStartRow + 2}`,
    );
    const writtenDockHeaders = (writtenDockRows[0] ?? []).map((value) => String(value ?? "").trim());
    const writtenDockProductRow = (writtenDockRows[1] ?? []).map((value) => String(value ?? ""));
    const writtenDockSkuCol = findCol(writtenDockHeaders, ["Product Code/SKU", "Product ID", "SKU"]);
    const writtenDockSku = writtenDockSkuCol === -1
      ? ""
      : normalizeSkuForCompare(writtenDockProductRow[writtenDockSkuCol] ?? "");
    const writtenDockMpn = extractNumericMpnFromValue(
      getCellByAliases(
        writtenDockHeaders,
        writtenDockProductRow,
        ["GPS Manufacturer Part Number", "Manufacturer Part Number", "MPN"],
      ),
    );
    if (writtenDockSkuCol === -1 || writtenDockSku !== normalizeSkuForCompare(args.sku)) {
      throw new Error(
        `Loading Dock verification failed; expected SKU "${args.sku}" but found "${writtenDockSku || "blank"}" at row ${writeStartRow + 1} after write.`,
      );
    }
    if (args.expectedMpn !== null && writtenDockMpn !== args.expectedMpn) {
      throw new Error(
        `Loading Dock verification failed; expected MPN ${args.expectedMpn} but found ${writtenDockMpn ?? "blank"} after write.`,
      );
    }
    stageHistory.push(`verify_loading_dock(sku=${args.sku}, mpn=${writtenDockMpn ?? "blank"})`);
    await invalidateDockReadCachesForSku(args.sku, [args.eventEpochMs, args.previousSubmissionEpochMs]);
    stageHistory.push("invalidate_dock_caches");

    currentStage = "reset_output_work";
    const outputWorkReset = await ensureOutputWorkMatchesTemplate(
      args.token,
      args.sheetId,
      args.outputWorkTab,
      args.outputTemplateTab,
      "post_dock_write",
    );
    stageHistory.push(`reset_output_work(${outputWorkReset.resetApplied ? "reset_applied" : "already_template"})`);
    stageHistory.push("verify_output_work_reset(verified_in_ensure)");

    currentStage = "mark_event_processed";
    const processedAt = melbourneTimestamp();
    await markSubmitEventProcessed(
      args.token,
      args.sheetId,
      args.eventsTab,
      args.eventRowNumber,
      processedAt,
      args.expectedMpn,
      "",
    );
    stageHistory.push(`mark_event_processed(processedAt=${processedAt})`);

    currentStage = "log_completion_event";
    try {
      await appendEventRowStrict(args.token, args.sheetId, args.eventsTab, [
        processedAt,
        `EVT-${Date.now()}`,
        "COPY_ENGINE_RUN_COMPLETE",
        args.sku,
        args.expectedMpn ? String(args.expectedMpn) : "",
        processedAt,
        "",
      ]);
      stageHistory.push(`log_completion_event(processedAt=${processedAt})`);
    } catch (completionLogError) {
      console.warn("COPY_ENGINE_RUN_COMPLETE append failed after successful direct submit:", completionLogError);
      stageHistory.push("log_completion_event(non_fatal_fail)");
    }

    try {
      await removeGlobalDockPendingEntry(args.sku, args.eventEpochMs);
    } catch (pendingCleanupError) {
      console.warn("Failed to remove global pending entry after direct submission success:", pendingCleanupError);
      stageHistory.push("pending_cleanup(non_fatal_fail)");
    }
    return { success: true, processedAt };
  } catch (error) {
    const processedAt = melbourneTimestamp();
    const baseMessage = error instanceof Error ? error.message : String(error);
    const errorMessage = [
      `stage=${currentStage}`,
      `sku=${args.sku}`,
      `mode=${args.isOverwrite ? "override" : "submit"}`,
      `dockRows=${dockRowCount}`,
      `writeStartRow=${writeStartRow ?? "unknown"}`,
      `expectedMpn=${args.expectedMpn ?? "blank"}`,
      `history=${stageHistory.join(" > ") || "none"}`,
      baseMessage,
    ].join("; ");

    // If the dock write already succeeded (past "write_loading_dock" stage),
    // the product IS in the Loading Dock. Treat post-write failures
    // (verify, reset, mark) as non-fatal: mark the event as success so the
    // UI does not flash a "Failed" badge for a product that actually landed.
    const POST_WRITE_STAGES = ["verify_loading_dock", "reset_output_work", "mark_event_processed", "log_completion_event"];
    const dockWriteAlreadySucceeded = POST_WRITE_STAGES.includes(currentStage);

    try {
      await removeGlobalDockPendingEntry(args.sku, args.eventEpochMs);
    } catch (pendingCleanupError) {
      console.warn("Failed to remove global pending entry after direct submission failure:", pendingCleanupError);
    }
    try {
      await ensureOutputWorkMatchesTemplate(
        args.token,
        args.sheetId,
        args.outputWorkTab,
        args.outputTemplateTab,
        dockWriteAlreadySucceeded ? "direct_submit_post_write_cleanup" : "direct_submit_failure",
      );
    } catch (resetError) {
      console.warn("Failed to reset OUTPUT_Work after direct submission failure:", resetError);
    }

    if (dockWriteAlreadySucceeded) {
      // Dock write succeeded; mark event as processed WITHOUT an error so the
      // Loading Dock UI shows the product as complete, not failed.
      console.warn(
        `[directSubmitPipeline] Post-write failure treated as success (stage=${currentStage}, sku=${args.sku}): ${baseMessage}`,
      );
      try {
        await markSubmitEventProcessed(
          args.token,
          args.sheetId,
          args.eventsTab,
          args.eventRowNumber,
          processedAt,
          args.expectedMpn,
          "", // no error — dock write was successful
        );
      } catch (eventMarkError) {
        console.warn("Failed to mark post-write-success event as processed:", eventMarkError);
      }
      return { success: true, processedAt };
    }

    // Dock write did NOT succeed — genuine failure.
    try {
      await markSubmitEventProcessed(
        args.token,
        args.sheetId,
        args.eventsTab,
        args.eventRowNumber,
        processedAt,
        args.expectedMpn,
        `[directSubmitPipeline] ${errorMessage}`,
      );
    } catch (eventMarkError) {
      console.warn("Failed to mark direct submit event as errored:", eventMarkError);
    }
    return { success: false, error: errorMessage };
  }
}

function applyOutputHtmlReplacements(text: string): string {
  return String(text || "")
    .replace(/°/g, "&deg;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/≤/g, "&le;")
    .replace(/≥/g, "&ge;");
}

function decodePossiblyEscapedHtml(text: string): string {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;|#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function normalizeCategoryCell(value: string): string {
  return String(value || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(";");
}

function normalizeSemicolonListCellForOutput(header: string, value: string): string {
  const normalized = normalizeCategoryCell(value);
  const key = normalizeHeaderKey(header);
  if (
    key === "productcustomfields" ||
    key === "customfields" ||
    key === "filters" ||
    key === "attributes" ||
    key === "specifications"
  ) {
    return formatDimensionEntriesInSemicolonListForCsv(normalized);
  }
  return normalized;
}

function formatSemicolonListCellForCsv(value: string): string {
  return formatDimensionEntriesInSemicolonListForCsv(value);
}

function normalizeHeaderKey(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSemicolonListHeader(header: string): boolean {
  const key = normalizeHeaderKey(header);
  return key === "category"
    || key === "categories"
    || key === "gpscategory"
    || key === "productcustomfields"
    || key === "customfields"
    || key === "filters"
    || key === "attributes"
    || key === "specifications";
}

function transform_INPUT_B4(cellText: string): string {
  let text = String(cellText || "").trim();
  if (!text) return "";

  // Exact replacement order matching BigCommerce format
  text = text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00B0/g, "&deg;")
    .replace(/\u1D52/g, "&deg;")
    .replace(/\n/g, " <br/><strong>")
    .replace(/: /g, ":</strong> ")
    .replace(/\u2014/g, "-")
    .replace(/['\u2018\u2019]/g, "&#39;")
    .replace(/\u00E9/g, "&eacute;")
    .replace(/\u2265/g, "&ge;")
    .replace(/\u2013/g, "-");

  return `<p><strong>${text} <br/></p>`;
}

function escapeDescriptionText(text: string): string {
  return text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00B0/g, "&deg;")
    .replace(/\u1D52/g, "&deg;")
    .replace(/\u2014/g, "-")
    .replace(/['\u2018\u2019]/g, "&#39;")
    .replace(/\u00E9/g, "&eacute;")
    .replace(/\u2265/g, "&ge;")
    .replace(/\u2013/g, "-");
}

function transform_INPUT_B7(cellText: string): string {
  if (cellText === "" || cellText === null || cellText === undefined) return "";
  const normalized = String(cellText).replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  return normalized
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeDescriptionText(paragraph).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

/**
 * Format product description + spec data into the standard HTML format
 * used by the Google Sheets "Product Description" column.
 */
function formatProductDescriptionHtml(description: string, specData: string): string {
  const transformedB7 = transform_INPUT_B7(description || "");
  const transformedB4 = transform_INPUT_B4(specData || "");
  if (!transformedB4) return transformedB7;
  if (!transformedB7) return transformedB4;
  return `${transformedB7}${transformedB4}`;
}

/**
 * Reverse-parse the HTML Product Description back into plain-text
 * description and KEY: VALUE spec data.
 *
 * Handles both old format (<p>desc</p><p><strong>specs<br/></p>)
 * and new format (multiple <p>desc</p> ... <p><strong>KEY:</strong> val <br/>...</p>).
 */
function parseHtmlDescriptionBack(htmlDesc: string): { description: string; specData: string } {
  if (!htmlDesc || !htmlDesc.trim()) return { description: "", specData: "" };
  const normalizedHtmlDesc = decodePossiblyEscapedHtml(htmlDesc);

  const normalizeHtmlBlockToText = (value: string): string =>
    unescapeHtmlEntities(
      String(value || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/\u00A0/g, " ")
        .trim(),
    );

  const normalizeSpecLine = (value: string): string =>
    value
      .replace(/\s+/g, " ")
      .replace(/\s*:\s*/g, ": ")
      .trim();

  const isSpecLine = (value: string): boolean => {
    const line = value.trim();
    if (!line) return false;
    if (!line.includes(":")) return false;
    if (line.length > 220) return false;
    return /^[A-Za-z0-9][A-Za-z0-9\s/#&()+.%,-]{1,120}:\s*\S.+$/.test(line);
  };

  const classifyParagraphBlocks = (
    rawBlocks: string[],
  ): { description: string; specData: string } => {
    const blocks = rawBlocks
      .map((block) => normalizeHtmlBlockToText(block))
      .filter(Boolean);
    if (blocks.length === 0) return { description: "", specData: "" };

    const descriptionParts: string[] = [];
    const specLines: string[] = [];
    let specMode = false;

    for (const block of blocks) {
      const lines = block
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) continue;

      const specLikeCount = lines.filter(isSpecLine).length;
      const looksLikeSpecBlock = specLikeCount > 0 && specLikeCount >= Math.ceil(lines.length / 2);

      if (!specMode && !looksLikeSpecBlock) {
        descriptionParts.push(lines.join(" "));
        continue;
      }

      specMode = true;
      for (const line of lines) {
        if (!line) continue;
        specLines.push(normalizeSpecLine(line));
      }
    }

    if (specLines.length === 0) {
      return { description: descriptionParts.join("\n\n").trim() || blocks.join("\n\n").trim(), specData: "" };
    }

    return {
      description: descriptionParts.join("\n\n").trim(),
      specData: specLines.join("\n"),
    };
  };

  // ── Strategy ──────────────────────────────────────────────────────────
  // Find the first occurrence of a spec-style pattern:
  //   <strong>KEY:</strong> or <b>KEY:</b>
  // Everything BEFORE that marker is description; everything from there
  // onwards is spec data.  This is more robust than relying on <p> block
  // boundaries, which can vary across BigCommerce exports, manual edits,
  // and Google Sheets API responses.
  // ─────────────────────────────────────────────────────────────────────

  // Match the first <strong>KEY:</strong> or <b>KEY:</b> pattern
  const specStartMatch = normalizedHtmlDesc.match(/<(strong|b)>[^<]+?:\s*<\/\1>/i);

  if (!specStartMatch || specStartMatch.index === undefined) {
    // No spec-style entries found — everything is description
    const pBlocks: string[] = [];
    const pRegex = /<p>([\s\S]*?)<\/p>/gi;
    let m: RegExpExecArray | null;
    while ((m = pRegex.exec(normalizedHtmlDesc)) !== null) {
      pBlocks.push(m[1]);
    }
    if (pBlocks.length === 0) {
      const plain = normalizeHtmlBlockToText(normalizedHtmlDesc);
      const plainLines = plain
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const specLike = plainLines.filter(isSpecLine).map(normalizeSpecLine);
      if (specLike.length > 0) {
        return { description: "", specData: specLike.join("\n") };
      }
      return { description: plain, specData: "" };
    }
    const classified = classifyParagraphBlocks(pBlocks);
    if (classified.description || classified.specData) return classified;
    return { description: "", specData: "" };
  }

  // Split at the spec start position
  const descHtml = normalizedHtmlDesc.slice(0, specStartMatch.index);
  const specHtml = normalizedHtmlDesc.slice(specStartMatch.index);

  // ── Parse description portion ────────────────────────────────────────
  // Extract <p> blocks, or fall back to stripping tags
  const descPBlocks: string[] = [];
  const pRegex = /<p>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRegex.exec(descHtml)) !== null) {
    descPBlocks.push(m[1]);
  }
  let description: string;
  if (descPBlocks.length > 0) {
    description = descPBlocks
      .map((b) => unescapeHtmlEntities(
        b.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim()
      ))
      .filter(Boolean)
      .join("\n\n");
  } else {
    // No <p> tags in desc portion — strip all tags
    description = unescapeHtmlEntities(
      descHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim()
    );
  }

  // ── Parse spec portion ───────────────────────────────────────────────
  // Remove wrapping <p>...</p> if present, then split on <br/> or <br>
  const specContent = specHtml
    .replace(/^<p>/i, "")
    .replace(/<\/p>\s*$/i, "")
    .replace(/<\/p>\s*<p>/gi, "<br/>");

  const specLines = specContent
    .split(/<br\s*\/?>/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const parsed: string[] = [];
  for (const line of specLines) {
    const cleaned = normalizeHtmlBlockToText(
      line.replace(/<\/?(strong|b)>/gi, "").trim(),
    );
    if (cleaned) parsed.push(cleaned);
  }
  const specData = parsed.join("\n");

  return { description, specData };
}

function normalizeProductDescriptionCell(htmlDesc: string): string {
  if (!htmlDesc || !htmlDesc.trim()) return "";
  const parsed = parseHtmlDescriptionBack(htmlDesc);
  if (!parsed.description && !parsed.specData) return htmlDesc;
  return formatProductDescriptionHtml(parsed.description, parsed.specData);
}

function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&deg;/g, "°")
    .replace(/&#39;/g, "'")
    .replace(/&eacute;/g, "é")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&le;/g, "≤")
    .replace(/&ge;/g, "≥")
    .replace(/&amp;/g, "&");
}

// Validate tabNames parameter
function isValidTabNames(tabNames: unknown): boolean {
  // Allow undefined, null, or empty object (but not arrays)
  if (
    tabNames === undefined ||
    tabNames === null ||
    (typeof tabNames === "object" && !Array.isArray(tabNames) && Object.keys(tabNames).length === 0)
  ) {
    return true;
  }
  if (typeof tabNames !== "object" || Array.isArray(tabNames)) return false;
  const obj = tabNames as Record<string, unknown>;
  // Allow empty strings (they'll fall back to defaults via resolveTabName)
  return Object.values(obj).every((v) => typeof v === "string" && v.length < 255);
}

// parseServiceAccountKey + normalizePrivateKey imported from ../_shared/googleAuth.ts

serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Reject disallowed origins for browser-origin requests.
  const originReject = rejectIfOriginNotAllowed(origin, "POST, OPTIONS", req);
  if (originReject) return originReject;

  try {
    let body;
    try {
      body = await parseJsonObject(req);
    } catch (parseError) {
      console.error("Invalid JSON in request body:", parseError);
      return new Response(
        JSON.stringify({ error: "Invalid JSON in request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // INPUT VALIDATION: Validate action parameter
    const action = normalizeGoogleSheetsAction(body.action);
    if (!action) {
      console.error("Invalid action:", { received: body.action, keys: Object.keys(body) });
      return new Response(
        JSON.stringify({
          error: "Invalid action parameter",
          receivedAction: body.action ?? null,
          requestKeys: Object.keys(body),
          allowedActions: listGoogleSheetsActions(),
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // INPUT VALIDATION: Validate tabNames parameter
    const tabNames = body.tabNames as Record<string, string> | undefined;
    if (!isValidTabNames(tabNames)) {
      console.error("Invalid tabNames (type:", typeof tabNames, ", value:", tabNames, ")");
      return new Response(
        JSON.stringify({ error: "Invalid tabNames parameter", received: tabNames }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authRejected = await rejectIfMissingProjectKey(req, corsHeaders);
    if (authRejected) return authRejected;

    // Global cooldown is checked inline where Events are written

    // SECURITY: Only use server-side secrets from Deno.env, never from request body
    // This prevents exposing credentials to the client
    const serviceAccountKey = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    const sheetId = Deno.env.get("GOOGLE_SHEET_ID");

    // If no credentials configured, return flag to use defaults
    if (!serviceAccountKey || !sheetId) {
      console.log("Google Sheets credentials not configured, using defaults");
      return new Response(
        JSON.stringify({ useDefaults: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse service account key
    const keyData = parseServiceAccountKey(serviceAccountKey);
    if (!keyData) {
      console.error("Invalid GOOGLE_SERVICE_ACCOUNT_KEY: unable to parse JSON");
      return new Response(
        JSON.stringify({ error: "Invalid GOOGLE_SERVICE_ACCOUNT_KEY JSON" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    keyData.private_key = normalizePrivateKey(keyData.private_key);

    if (!keyData.client_email || !keyData.private_key) {
      console.error("Invalid GOOGLE_SERVICE_ACCOUNT_KEY: missing fields");
      return new Response(
        JSON.stringify({ error: "Invalid GOOGLE_SERVICE_ACCOUNT_KEY: missing required fields" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get access token via JWT (shared auth module)
    // script.external_request scope allows calling Apps Script Execution API for instant kick
    const accessToken = await getGoogleAccessToken(keyData, [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/script.external_request",
    ]);

    // (SKU locking removed — replaced by global cooldown on Events writes)

    if (action === "read") {
      const cacheKey = getCacheKey(action, body);
      try {
        const result = await readAllSheets(accessToken, sheetId, tabNames);
        // Fire-and-forget cache write
        writeCache(cacheKey, result).catch(() => {});
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        console.warn("Google Sheets read failed, trying cache:", err);
        const cached = await readCache(cacheKey);
        if (cached) {
          return new Response(JSON.stringify({ ...(cached as Record<string, unknown>), cached: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw err; // No cache available, let outer catch handle
      }
    }

    if (action === "write") {
      // INPUT VALIDATION: Validate rowData
      const { rowData } = body;
      if (!Array.isArray(rowData) || !rowData.every((cell) => typeof cell === "string" && cell.length < 10000)) {
        console.error("Invalid rowData:", rowData);
        return new Response(
          JSON.stringify({ error: "Invalid rowData parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      await appendRow(accessToken, sheetId, resolveTabName(tabNames, "RESPONSES", "RESPONSES"), rowData);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "write-categories") {
      // INPUT VALIDATION: Validate categoryPaths
      const { categoryPaths } = body;
      if (!Array.isArray(categoryPaths) || !categoryPaths.every((p) => typeof p === "string" && p.length > 0 && p.length < 1000)) {
        console.error("Invalid categoryPaths:", categoryPaths);
        return new Response(
          JSON.stringify({ error: "Invalid categoryPaths parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      await clearAndWriteCategories(
        accessToken,
        sheetId,
        categoryPaths,
        resolveTabName(tabNames, "CATEGORIES", "CATEGORIES")
      );
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "write-brands") {
      // INPUT VALIDATION: Validate brands
      const { brands } = body;
      if (
        !Array.isArray(brands) ||
        !brands.every(
          (b) =>
            typeof b === "object" &&
            typeof b.brand === "string" &&
            b.brand.length > 0 &&
            b.brand.length < 255 &&
            typeof b.brandName === "string" &&
            b.brandName.length < 255 &&
            typeof b.website === "string" &&
            b.website.length < 2000
        )
      ) {
        console.error("Invalid brands:", brands);
        return new Response(
          JSON.stringify({ error: "Invalid brands parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      await clearAndWriteBrands(
        accessToken,
        sheetId,
        brands,
        resolveTabName(tabNames, "BRANDS", "BRANDS")
      );
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "write-legal") {
      const { propertyName, value } = body;
      if (
        typeof propertyName !== "string" ||
        typeof value !== "string" ||
        propertyName.trim().length === 0 ||
        value.trim().length === 0 ||
        propertyName.length > 255 ||
        value.length > 255
      ) {
        console.error("Invalid legal value payload:", { propertyName, value });
        return new Response(
          JSON.stringify({ error: "Invalid legal value payload" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Write the property name exactly as received — the sheet defines the naming
      const basePropertyName = propertyName.trim();

      await addLegalValueToLegalTab(
        accessToken,
        sheetId,
        resolveTabName(tabNames, "LEGAL", "LEGAL"),
        basePropertyName,
        value
      );

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update-sku-visibility") {
      const { sku } = body;
      if (typeof sku !== "string" || sku.trim().length === 0 || sku.length > 255) {
        return new Response(
          JSON.stringify({ error: "Invalid SKU parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // IMPORTANT: PRODUCTS TO DO column D is VLOOKUP-driven in Sheets.
      // Never write to that formula column directly.
      // Visibility source-of-truth lives in PRODUCTS column D.
      const productsTab = resolveTabName(tabNames, "PRODUCTS", "Products");
      const rows = await getSheetValues(accessToken, sheetId, `${productsTab}!A:D`);
      const trimmedSku = sku.trim();
      const normalizedSku = normalizeSkuForCompare(trimmedSku);
      let foundRow = -1;
      let currentVisibility = "";
      for (let i = 1; i < rows.length; i++) {
        if (normalizeSkuForCompare(rows[i]?.[0] ?? "") === normalizedSku) {
          foundRow = i + 1;
          currentVisibility = (rows[i]?.[3] ?? "").toString().trim();
          break;
        }
      }
      if (foundRow === -1) {
        return new Response(
          JSON.stringify({ success: false, error: `SKU "${trimmedSku}" was not found` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const visNum = parseFloat(currentVisibility);
      if (!isNaN(visNum) && visNum === 1) {
        return new Response(
          JSON.stringify({ success: false, alreadyState: true, error: `SKU "${trimmedSku}" is already visible` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      await updateSheetCell(accessToken, sheetId, productsTab, foundRow, "D", "1");
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update-sku-status") {
      const { sku, status } = body;
      if (typeof sku !== "string" || sku.trim().length === 0 || sku.length > 255) {
        return new Response(
          JSON.stringify({ error: "Invalid SKU parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const validStatuses = ["TO_DO", "COMPLETE", "NOT_FOR_SALE"];
      if (typeof status !== "string" || !validStatuses.includes(status)) {
        return new Response(
          JSON.stringify({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const productsTab = resolveTabName(tabNames, "PRODUCTS_TODO", "PRODUCTS TO DO");
      const rows = await getSheetValues(accessToken, sheetId, `${productsTab}!A:C`);
      const trimmedSku = sku.trim();
      const normalizedSku = normalizeSkuForCompare(trimmedSku);
      let foundRow = -1;
      let currentStatus = "";
      for (let i = 1; i < rows.length; i++) {
        if (normalizeSkuForCompare(rows[i]?.[0] ?? "") === normalizedSku) {
          foundRow = i + 1;
          currentStatus = (rows[i]?.[2] ?? "").toString().trim().toUpperCase();
          break;
        }
      }
      if (foundRow === -1) {
        return new Response(
          JSON.stringify({ success: false, error: `SKU "${trimmedSku}" was not found` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (currentStatus === status) {
        const label = status === "NOT_FOR_SALE" ? "NOT FOR SALE" : status === "COMPLETE" ? "COMPLETE" : "TO DO";
        return new Response(
          JSON.stringify({ success: false, alreadyState: true, error: `SKU "${trimmedSku}" is already ${label}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // If NOT_FOR_SALE, check cooldown BEFORE updating status (to avoid partial writes)
      if (status === "NOT_FOR_SALE") {
        const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
        
        // Now safe to update status and log event
        await updateSheetCell(accessToken, sheetId, productsTab, foundRow, "C", status);
        
        const melbourneTime = melbourneTimestamp();
        const eventId = `EVT-${Date.now()}`;
        const eventRow = [
          melbourneTime,         // A: Timestamp
          eventId,               // B: Event_ID
          "MARK_NOT_FOR_SALE",   // C: Event_Type
          trimmedSku,            // D: SKU/Submission
          "",                    // E: Processed_At (filled by Apps Script)
          "",                    // F: Error
        ];
        await appendEventRowStrict(accessToken, sheetId, eventsTab, eventRow);
      } else {
        // For other status changes (COMPLETE, TO_DO), just update the cell
        await updateSheetCell(accessToken, sheetId, productsTab, foundRow, "C", status);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Lightweight status check (used by frontend before submit / NFS) ──
    if (action === "check-sku-status") {
      const { sku } = body;
      if (typeof sku !== "string" || sku.trim().length === 0 || sku.length > 255) {
        return new Response(
          JSON.stringify({ error: "Invalid SKU parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const productsToDoTab = resolveTabName(tabNames, "PRODUCTS_TODO", "PRODUCTS TO DO");
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
      const trimmedSku = sku.trim();
      const normalizedSku = normalizeSkuForCompare(trimmedSku);

      // Parallel fetch: both reads are independent
      const [rows, eventsRows] = await Promise.all([
        getSheetValues(accessToken, sheetId, `${productsToDoTab}!A:C`),
        getSheetValues(accessToken, sheetId, `${eventsTab}!A:D`, { render: "unformatted" }),
      ]);

      let status = "";
      for (let i = 1; i < rows.length; i++) {
        if (normalizeSkuForCompare(rows[i]?.[0] ?? "") === normalizedSku) {
          status = (rows[i]?.[2] ?? "").toString().trim().toUpperCase();
          break;
        }
      }
      return new Response(
        JSON.stringify({ status, recentSubmit: false }), // Decoupled from Loading Dock SUBMIT queue
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "check-dock-row-status") {
      try {
        const { sku } = body;
        if (typeof sku !== "string" || sku.trim().length === 0 || sku.length > 255) {
          return new Response(
            JSON.stringify({ error: "Invalid SKU parameter" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const trimmedSku = sku.trim();
        const normalizedSku = normalizeSkuForCompare(trimmedSku);
        const dockTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
        const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
        const [dockBlock, eventRows, globalPendingEntries] = await withReadTimeout(Promise.all([
          readReadableLoadingDockBlockForSku(accessToken, sheetId, dockTab, trimmedSku),
          readRecentEventRowsForSku(accessToken, sheetId, eventsTab, trimmedSku),
          readGlobalDockPendingEntries(),
        ]));

        const latestSubmitState = getLatestSubmitLikeEventStateForSku(eventRows, trimmedSku);
        const latestErrorMessage = getLatestDockErrorMessageForSku(eventRows, trimmedSku);
        const existsInDock = dockBlock !== null;
        const pendingDockActionsBySku = getPendingDockActionStates(eventRows, new Set([normalizedSku]));
        const pendingActionType = pendingDockActionsBySku[normalizedSku];
        const dockActionPending = Boolean(pendingActionType);
        const actionableErrorMessage =
          existsInDock && /no sku found in output_work/i.test(latestErrorMessage)
            ? ""
            : latestErrorMessage;
        const activeGlobalPendingEntry = getGlobalPendingEntryForSku(globalPendingEntries, trimmedSku);
        const hasGlobalPending = activeGlobalPendingEntry !== null;
        const orphanedGlobalPendingWithoutEvent =
          hasGlobalPending &&
          latestSubmitState === null &&
          !latestErrorMessage &&
          !existsInDock &&
          (Date.now() - activeGlobalPendingEntry!.submittedAtEpochMs) > ORPHAN_GLOBAL_PENDING_WITHOUT_EVENT_GRACE_MS;

        const staleGlobalPending =
          hasGlobalPending &&
          (
            existsInDock ||
            (latestSubmitState !== null && !isSubmitLikeEventPending(latestSubmitState)) ||
            (latestSubmitState === null && Boolean(latestErrorMessage)) ||
            orphanedGlobalPendingWithoutEvent
          );
        if (staleGlobalPending) {
          const nextGlobalPendingEntries = globalPendingEntries.filter(
            (entry) => normalizeSkuForCompare(entry.sku) !== normalizedSku,
          );
          writeGlobalDockPendingEntries(nextGlobalPendingEntries).catch(() => {});
        }

        const eventPending = isSubmitLikeEventPending(latestSubmitState);
        const globalPendingActive = !staleGlobalPending && hasGlobalPending;

        // Dock actions must stay blocked while a newer submit/override/upload is
        // still pending, even if an older dock row for the SKU already exists.
        const pending = eventPending || globalPendingActive;
        const actionable = existsInDock && !pending && !dockActionPending && !actionableErrorMessage;

        return new Response(
          JSON.stringify({
            success: true,
            sku: trimmedSku,
            existsInDock,
            pending,
            dockActionPending,
            actionable,
            pendingActionType,
            latestSubmittedAt: latestSubmitState?.submittedAt || undefined,
            error: actionableErrorMessage || undefined,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (err) {
        console.warn("check-dock-row-status failed:", err);
        return new Response(
          JSON.stringify({
            success: false,
            existsInDock: false,
            pending: false,
            actionable: false,
            error: err instanceof Error ? err.message : "Dock status unavailable",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (action === "upsert-dock-pending") {
      const pending = body.pending;
      if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
        return new Response(
          JSON.stringify({ error: "Invalid pending parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const sku = ((pending as Record<string, unknown>).sku ?? "").toString().trim();
      if (!sku) {
        return new Response(
          JSON.stringify({ error: "Invalid SKU parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const submittedAtEpochMsRaw = Number((pending as Record<string, unknown>).submittedAtEpochMs);
      const submittedAtEpochMs = Number.isFinite(submittedAtEpochMsRaw) && submittedAtEpochMsRaw > 0
        ? submittedAtEpochMsRaw
        : Date.now();
      const submittedAt = ((pending as Record<string, unknown>).submittedAt ?? "").toString().trim() ||
        new Date(submittedAtEpochMs).toISOString();
      const expiresAtRaw = Number((pending as Record<string, unknown>).expiresAt);
      const expiresAt = Number.isFinite(expiresAtRaw) && expiresAtRaw > submittedAtEpochMs
        ? expiresAtRaw
        : submittedAtEpochMs + GLOBAL_DOCK_PENDING_TTL_MS;
      const isOverwrite = (pending as Record<string, unknown>).isOverwrite === true;
      const now = Date.now();
      const existing = await readGlobalDockPendingEntries(now);
      const bySku = new Map<string, GlobalDockPendingEntry>();
      for (const entry of existing) {
        bySku.set(normalizeSkuForCompare(entry.sku), entry);
      }
      bySku.set(normalizeSkuForCompare(sku), {
        sku,
        submittedAt,
        submittedAtEpochMs,
        isOverwrite,
        expiresAt,
      });
      await writeGlobalDockPendingEntries(Array.from(bySku.values()));
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "remove-dock-pending") {
      const pending = body.pending;
      if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
        return new Response(
          JSON.stringify({ error: "Invalid pending parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const sku = ((pending as Record<string, unknown>).sku ?? "").toString().trim();
      if (!sku) {
        return new Response(
          JSON.stringify({ error: "Invalid SKU parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const submittedAtEpochMsRaw = Number((pending as Record<string, unknown>).submittedAtEpochMs);
      const removed = await removeGlobalDockPendingEntry(
        sku,
        Number.isFinite(submittedAtEpochMsRaw) && submittedAtEpochMsRaw > 0 ? submittedAtEpochMsRaw : null,
      );
      return new Response(JSON.stringify({ success: true, removed }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "write-output") {
      const { productData } = body;
      if (!productData || typeof productData !== "object") {
        return new Response(
          JSON.stringify({ error: "Invalid productData parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const skuCheck = (productData as Record<string, any>).sku ?? "";
      if (typeof skuCheck !== "string" || !skuCheck.trim()) {
        return new Response(
          JSON.stringify({ error: "Missing SKU in productData" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Global cooldown prevents concurrent submissions from any user
      const outputWorkTab = resolveTabName(tabNames, "OUTPUT_WORK", "OUTPUT_Work");
      const outputTemplateTab = resolveTabName(tabNames, "OUTPUT_TEMPLATE", "OUTPUT_Template");
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
      const productsToDoTab = resolveTabName(tabNames, "PRODUCTS_TODO", "PRODUCTS TO DO");
      const productsTab = resolveTabName(tabNames, "PRODUCTS", "Products");
      const dockTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
      const newNamesTab = resolveTabName(tabNames, "NEW_NAMES", "NewNames");
      const existingProdsTab = resolveTabName(tabNames, "EXISTING_PRODS", "ExistingProds");
      const trimmedSkuCheck = skuCheck.trim();
      const isOverwrite = (productData as Record<string, unknown>).isOverwrite === true;
      const duplicateTitleConfirmed = (productData as Record<string, unknown>).duplicateTitleConfirmed === true;
      const loadedDockSubmissionEpochMsRaw = Number((productData as Record<string, unknown>).loadedDockSubmissionEpochMs);
      const loadedDockSubmissionEpochMs =
        Number.isFinite(loadedDockSubmissionEpochMsRaw) && loadedDockSubmissionEpochMsRaw > 0
          ? loadedDockSubmissionEpochMsRaw
          : null;
      const submitIdempotency = await claimSubmitIdempotency({
        token: accessToken,
        sheetId,
        eventsTab,
        dockTab,
        productData: productData as Record<string, unknown>,
        sku: trimmedSkuCheck,
        isOverwrite,
      });
      if (submitIdempotency.kind === "completed") {
        return new Response(JSON.stringify({
          success: true,
          processedAt: submitIdempotency.processedAt,
          submittedAtEpochMs: extractSubmittedAtEpochMsFromEventId(submitIdempotency.eventId),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (submitIdempotency.kind === "pending") {
        return new Response(JSON.stringify({
          success: true,
          pending: true,
          reason: submitIdempotency.reason,
          submittedAtEpochMs: extractSubmittedAtEpochMsFromEventId(submitIdempotency.eventId),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (submitIdempotency.kind === "failed") {
        return new Response(JSON.stringify({ success: false, error: submitIdempotency.error }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let outputWorkLock: OutputWorkLockHandle | null = null;
      let submitEventStaged = false;
      const clearUncommittedSubmitIdempotency = async () => {
        if (submitIdempotency.kind !== "owner" || submitEventStaged) return;
        await removeSubmitIdempotencyRecord(submitIdempotency.record.requestId);
      };
      try {
        // Step 1: wait for the prior event to fully settle, then enter the single-writer window.
        outputWorkLock = await enterOutputWorkSubmissionWindow(accessToken, sheetId, eventsTab);

        if (submitIdempotency.kind === "owner") {
          const currentRecord = await readSubmitIdempotencyRecord(submitIdempotency.record.requestId);
          if (!currentRecord) {
            return new Response(JSON.stringify({
              success: true,
              pending: true,
              reason: `Request for SKU "${trimmedSkuCheck}" is still being recovered.`,
              submittedAtEpochMs: undefined,
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          if (currentRecord.attemptToken !== submitIdempotency.record.attemptToken) {
            if (currentRecord.status === "completed" && currentRecord.processedAt) {
              return new Response(JSON.stringify({
                success: true,
                processedAt: currentRecord.processedAt,
                submittedAtEpochMs: extractSubmittedAtEpochMsFromEventId(currentRecord.eventId),
              }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            if (currentRecord.status === "failed" && currentRecord.error) {
              return new Response(JSON.stringify({ success: false, error: currentRecord.error }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            return new Response(JSON.stringify({
              success: true,
              pending: true,
              reason: `A newer retry for SKU "${trimmedSkuCheck}" took over this request.`,
              submittedAtEpochMs: extractSubmittedAtEpochMsFromEventId(currentRecord.eventId),
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }

        const [statusRows, productsRows, dockRows, existingTitles, eventRows] = await Promise.all([
          getSheetValuesStrict(accessToken, sheetId, `${productsToDoTab}!A:C`),
          getSheetValuesStrict(accessToken, sheetId, `${productsTab}!A:D`),
          getSheetValuesFromTabCandidates(accessToken, sheetId, [dockTab, "Loading Dock", "LOADING_DOCK", "LoadingDock"], "A:ZZ"),
          readExistingTitlesForDuplicateCheck(accessToken, sheetId, newNamesTab, existingProdsTab),
          isOverwrite && loadedDockSubmissionEpochMs
            ? readRecentEventRowsForSku(accessToken, sheetId, eventsTab, trimmedSkuCheck)
            : Promise.resolve([] as string[][]),
        ]);

      // Verify SKU is still TO_DO (PRODUCTS TO DO tab: col A = SKU, col C = Status)
      let currentStatus = "";
      for (let i = 1; i < statusRows.length; i++) {
        if (normalizeSkuForCompare(statusRows[i]?.[0] ?? "") === normalizeSkuForCompare(trimmedSkuCheck)) {
          currentStatus = (statusRows[i]?.[2] ?? "").toString().trim().toUpperCase();
          break;
        }
      }
      if (currentStatus && currentStatus !== "TO_DO") {
        await clearUncommittedSubmitIdempotency();
        return new Response(
          JSON.stringify({ success: false, error: `SKU "${trimmedSkuCheck}" is no longer TO_DO (current status: ${currentStatus}). Another user may have changed it.` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const existingDockBlock = findReadableLoadingDockBlock(dockRows, trimmedSkuCheck);
      if (isOverwrite && !existingDockBlock) {
        await clearUncommittedSubmitIdempotency();
        return new Response(
          JSON.stringify({ success: false, error: `Override requires SKU "${trimmedSkuCheck}" to already exist in Loading Dock.` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (!isOverwrite && existingDockBlock) {
        await clearUncommittedSubmitIdempotency();
        return new Response(
          JSON.stringify({ success: false, error: `SKU "${trimmedSkuCheck}" is already in the Loading Dock. Use overwrite to replace it.` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (isOverwrite && loadedDockSubmissionEpochMs && existingDockBlock) {
        const latestSubmitState = getLatestSubmitLikeEventStateForSku(eventRows, trimmedSkuCheck);
        const currentDockSubmissionEpochMs =
          latestSubmitState && Number.isFinite(latestSubmitState.eventEpochMs) && latestSubmitState.eventEpochMs > 0
            ? latestSubmitState.eventEpochMs
            : null;
        const hasMeaningfulNewerSubmission =
          Boolean(currentDockSubmissionEpochMs)
          && Number(currentDockSubmissionEpochMs) > Number(loadedDockSubmissionEpochMs)
          && !timestampsRoughlyMatch(currentDockSubmissionEpochMs, loadedDockSubmissionEpochMs);

        if (hasMeaningfulNewerSubmission) {
          await clearUncommittedSubmitIdempotency();
          return new Response(
            JSON.stringify({
              success: false,
              error: `SKU "${trimmedSkuCheck}" was updated in Loading Dock after you loaded it. Reload it before overwriting so you do not replace newer changes.`,
              errorCode: "STALE_OVERWRITE",
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      // Step 2: reset OUTPUT_Work and seed fresh rows from the template before filling them.
      const outputWorkLayout = await resetOutputWorkFromTemplate(
        accessToken,
        sheetId,
        outputWorkTab,
        outputTemplateTab,
      );
      const stagedRows = buildOutputWorkSeedRows(outputWorkLayout);
      const headers = stagedRows.headers;
      const productRow = stagedRows.productRow;
      const emailRow = stagedRows.emailRow;

      // Step 2: Build column index map
      const colMap: Record<string, number> = {};
      headers.forEach((h: string, i: number) => { if (h) colMap[h] = i; });

      const {
        sku = "",
        mpnDraftId = "",
        title = "",
        brand = "",
        mainCategory = "",
        additionalCategories = [],
        imageUrls = [],
        specifications = {},
        chatgptDescription = "",
        chatgptData = "",
        price = "",
        productVisible = "",
        customFields = "",
        emailNotes = "",
      } = productData as Record<string, any>;

      const setCol = (header: string, value: string) => {
        if (colMap[header] !== undefined) productRow[colMap[header]] = sanitizeForFormulas(value);
      };
      const setEmailCol = (header: string, value: string) => {
        if (colMap[header] !== undefined) emailRow[colMap[header]] = sanitizeForFormulas(value);
      };

      const trimmedTitle = (title || "").trim();
      if (!duplicateTitleConfirmed) {
        const duplicateTitleInfo = findDuplicateTitleInfo({
          title: trimmedTitle,
          currentSku: trimmedSkuCheck,
          existingTitles,
          loadingDockTitles: [], // Decoupled from Loading Dock
        });
        if (duplicateTitleInfo) {
          await clearUncommittedSubmitIdempotency();
          return new Response(
            JSON.stringify({
              success: false,
              error: `Duplicate Product Name: "${duplicateTitleInfo.title}" already exists in ${duplicateTitleInfo.sources.join(" & ")}.`,
              errorCode: "DUPLICATE_TITLE",
              duplicateTitle: duplicateTitleInfo.title,
              duplicateTitleSources: duplicateTitleInfo.sources,
              requiresConfirmation: true,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      setCol("Product Name", trimmedTitle);
      setCol("Product Code/SKU", sku);
      setCol("Brand Name", brand);
      // If chatgptDescription arrives as HTML (legacy frontend), extract plain text first
      let descForHtml = (chatgptDescription || "").trim();
      if (/<\/?p>|<br\s*\/?>/i.test(descForHtml)) {
        descForHtml = descForHtml
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>\s*<p>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&deg;/g, "°").replace(/&eacute;/g, "é")
          .replace(/&le;/g, "≤").replace(/&ge;/g, "≥")
          .trim();
      }
      const htmlDescription = formatProductDescriptionHtml(descForHtml, chatgptData || "");
      setCol("Product Description", htmlDescription);
      setCol("Price", price ? String(price) : "");

      // Visibility from Products sheet (source-of-truth: Products col D, never PRODUCTS TO DO col D)
      let resolvedVisible = "N";
      for (let i = 1; i < productsRows.length; i++) {
        if (normalizeSkuForCompare(productsRows[i]?.[0] ?? "") === normalizeSkuForCompare(sku)) {
          const vis = (productsRows[i]?.[3] ?? "").toString().trim();
          resolvedVisible = vis === "1" ? "Y" : "N";
          break;
        }
      }
      setCol("Product Visible?", resolvedVisible);

      // Category
      const allCategories = [mainCategory, ...(additionalCategories || [])]
        .map((category) => String(category || "").trim())
        .filter(Boolean);
      setCol("Category", allCategories.join(";"));

      // Images: min 8 columns, up to 20
      const imageCount = Math.min(Math.max(imageUrls.length, 8), 20);
      for (let i = 0; i < imageCount; i++) {
        const n = i + 1;
        const url = i < imageUrls.length ? (imageUrls[i] ?? "").toString().trim() : "";
        setCol(`Product Image File - ${n}`, url);
        setCol(`Product Image Is Thumbnail - ${n}`, i === 0 ? "Y" : "N");
        setCol(`Product Image Sort - ${n}`, String(i));
      }

      // Page Title & Meta Description (dynamic, based on title)
      setCol("Page Title", `${trimmedTitle} | Lighting Style`);
      setCol("Meta Description", `Buy online, 60% off sale! You will love the ${trimmedTitle}. We have the largest range of lighting in Australia.`);

      // GPS Category (dynamic, from category picker) — all categories, main first
      setCol("GPS Category", allCategories.join(";"));

      // Product Custom Fields from filters/specifications
      // ONLY use the pre-built customFields string from the frontend.
      // Do NOT fall back to raw specifications — those contain ALL spec values
      // (including ones not visible for the current category) with internal keys.
      if (customFields) {
        setCol("Product Custom Fields", normalizeSemicolonListCellForOutput("Product Custom Fields", String(customFields)));
      }

      let reservedMpn: number | null = null;
      const submitMpnDecision = decideSubmitMpn({
        isOverwrite,
        existingMpnRaw: getCellByAliases(
          existingDockBlock?.headers ?? [],
          existingDockBlock?.productRow ?? [],
          ["GPS Manufacturer Part Number", "Manufacturer Part Number", "MPN"],
        ),
        sku: trimmedSkuCheck,
      });
      if (submitMpnDecision.kind === "error") {
        await clearUncommittedSubmitIdempotency();
        return new Response(
          JSON.stringify({ success: false, error: submitMpnDecision.error }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (submitMpnDecision.kind === "reuse-existing") {
        reservedMpn = submitMpnDecision.mpn;
      } else {
        reservedMpn = await reserveNextWebMpn(accessToken, sheetId, eventsTab, trimmedSkuCheck);
      }
      setCol("GPS Manufacturer Part Number", reservedMpn ? String(reservedMpn) : "");
      if (reservedMpn) {
        setCol("Search Keywords", `${reservedMpn},${reservedMpn}-L`);
      }

      // Email row: only dynamic fields
      // J4 (email row Product Description) = Notes for Email Body, NOT the HTML description
      setEmailCol("Option Set Align", "Email:");
      setEmailCol("Product Description", emailNotes || "");

      const submitEventEpochMs = Date.now();
      const melbourneTime = melbourneTimestamp();
      const eventId = `EVT-${submitEventEpochMs}`;
      const submitEventType = isOverwrite ? "SUBMIT_OVERRIDE" : "SUBMIT";
      const eventRow = [
        melbourneTime,
        eventId,
        submitEventType,
        sku,
        reservedMpn ? String(reservedMpn) : "",
        "",
        "",
      ];
      // Step 3: stage OUTPUT_Work, append the exact event row, and register global pending.
      const stagedEvent = await stageSubmissionEvent({
        token: accessToken,
        sheetId,
        outputWorkTab,
        outputTemplateTab,
        eventsTab,
        sku: trimmedSkuCheck,
        eventRow,
        eventEpochMs: submitEventEpochMs,
        isOverwrite,
        stagedRows,
        postEventTasks: [
          () => syncTitleToNewNamesIfMissing(accessToken, sheetId, newNamesTab, trimmedTitle),
        ],
      });
      submitEventStaged = true;
      if (submitIdempotency.kind === "owner") {
        await writeSubmitIdempotencyRecord({
          ...submitIdempotency.record,
          phase: "event_logged",
          updatedAtEpochMs: Date.now(),
          eventId,
        });
      }

      console.log(`Product ${sku} written to OUTPUT_Work, ${submitEventType} event logged (MPN ${reservedMpn ?? "none"})`);
      await releaseOutputWorkLock(outputWorkLock);
      outputWorkLock = null;
      // Step 4: once the event is durably logged, write/overwrite Loading Dock directly,
      // reset OUTPUT_Work back to template, then mark Processed_At.
      const completion = await completeSubmissionDirectly({
        token: accessToken,
        sheetId,
        eventsTab,
        dockTab,
        outputWorkTab,
        outputTemplateTab,
        sku: trimmedSkuCheck,
        expectedMpn: reservedMpn,
        isOverwrite,
        stagedRows,
        eventRowNumber: stagedEvent.eventRowNumber,
        eventEpochMs: submitEventEpochMs,
        previousSubmissionEpochMs: isOverwrite ? loadedDockSubmissionEpochMs : null,
      });

      if (completion.success && !completion.pending) {
        if (submitIdempotency.kind === "owner") {
          await writeSubmitIdempotencyRecord({
            ...submitIdempotency.record,
            phase: "event_logged",
            status: "completed",
            updatedAtEpochMs: Date.now(),
            eventId,
            processedAt: completion.processedAt,
            error: undefined,
          });
        }
        return new Response(JSON.stringify({
          success: true,
          processedAt: completion.processedAt,
          submittedAtEpochMs: submitEventEpochMs,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (completion.pending) {
        if (submitIdempotency.kind === "owner") {
          await writeSubmitIdempotencyRecord({
            ...submitIdempotency.record,
            phase: "event_logged",
            status: "in_progress",
            updatedAtEpochMs: Date.now(),
            eventId,
            error: undefined,
          });
        }
        return new Response(JSON.stringify({
          success: true,
          pending: true,
          reason: completion.reason,
          submittedAtEpochMs: submitEventEpochMs,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

        if (submitIdempotency.kind === "owner") {
          await writeSubmitIdempotencyRecord({
            ...submitIdempotency.record,
            phase: "event_logged",
            status: "failed",
            updatedAtEpochMs: Date.now(),
            eventId,
            error: completion.error,
          });
        }
        return new Response(JSON.stringify({ success: false, error: completion.error }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        if (submitIdempotency.kind === "owner") {
          if (!submitEventStaged) {
            await removeSubmitIdempotencyRecord(submitIdempotency.record.requestId);
          } else {
            await writeSubmitIdempotencyRecord({
              ...submitIdempotency.record,
              phase: "event_logged",
              status: "failed",
              updatedAtEpochMs: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        throw error;
      } finally {
        await releaseOutputWorkLock(outputWorkLock);
      }

    }

    if (action === "send-form-email" || action === "download-form-csv") {
      try {
      const { productData } = body;
      if (!productData || typeof productData !== "object") {
        return new Response(
          JSON.stringify({ error: "Invalid productData parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const skuCheck = (productData as Record<string, any>).sku ?? "";
      if (typeof skuCheck !== "string" || !skuCheck.trim()) {
        return new Response(
          JSON.stringify({ error: "Missing SKU in productData" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const outputWorkTab = resolveTabName(tabNames, "OUTPUT_WORK", "OUTPUT_Work");
      const outputTemplateTab = resolveTabName(tabNames, "OUTPUT_TEMPLATE", "OUTPUT_Template");
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
      const productsTab = resolveTabName(tabNames, "PRODUCTS", "Products");
      const brandsTab = resolveTabName(tabNames, "BRANDS", "Brands");
      const trimmedSkuCheck = skuCheck.trim();
      const isDownloadAction = action === "download-form-csv";
      const {
        sku = "",
        mpnDraftId: productMpnDraftId = "",
        title = "",
        brand = "",
        mainCategory = "",
        additionalCategories = [],
        imageUrls = [],
        chatgptDescription = "",
        chatgptData = "",
        price = "",
        customFields = "",
        emailNotes = "",
        gpsMpn = "",
        retailPrice: incomingRetailPrice = "",
      } = productData as Record<string, any>;

      const trimmedDraftId = String(productMpnDraftId || "").trim();
      if (!trimmedDraftId) {
        return new Response(JSON.stringify({
          success: false,
          error: "MPN draftId is required. Refresh the form and try again.",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }

      // If the payload already carries a valid MPN (e.g. from a CSV import),
      // reuse it directly instead of going through the DB allocator which
      // would treat it as "claimed" under a different draft and allocate a
      // brand-new number.
      const explicitMpn = Number.isFinite(Number(gpsMpn)) && Number(gpsMpn) > 0 ? Number(gpsMpn) : null;
      let resolvedFormMpn: ResolvedMpnState;
      if (explicitMpn) {
        resolvedFormMpn = {
          mpn: explicitMpn,
          attachment_state: "attached",
          transition: "attached_reused",
          attached_sku: trimmedSkuCheck,
          next_mpn: undefined,
          warning_code: null,
          warning_title: null,
          warning_message: null,
        };
      } else {
        resolvedFormMpn = await resolveDraftMpnStateInDb({
          draftId: trimmedDraftId,
          sku: trimmedSkuCheck,
          action: isDownloadAction ? "download" : "send_by_email",
          requestedMpn: null,
        });
      }
      const effectiveMpn = String(resolvedFormMpn.mpn || "").trim();
      if (!effectiveMpn) {
        return new Response(JSON.stringify({
          success: false,
          error: "MPN could not be resolved for this action.",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }

      // Keep the Events panel (I4/I5) in sync whenever a new MPN is attached.
      // "attached_reused" means no counter was consumed; all other transitions
      // advance next_mpn in the DB so the panel must reflect that.
      const panelNextMpn = Number(resolvedFormMpn.next_mpn);
      if (Number.isFinite(panelNextMpn) && panelNextMpn > 0 && resolvedFormMpn.transition !== "attached_reused") {
        const actionLabel = isDownloadAction ? "Download" : "Send By Email";
        const panelStatus = `${actionLabel} (${trimmedSkuCheck}): MPN ${effectiveMpn} attached — next ${panelNextMpn} (${melbourneTimestamp()})`;
        batchUpdateSheetValues(accessToken, sheetId, [
          { range: `${eventsTab}!I4`, values: [[String(panelNextMpn)]] },
          { range: `${eventsTab}!I5`, values: [[panelStatus]] },
        ]).catch((err) => {
          console.warn("MPN panel sync after attach failed (non-fatal):", err instanceof Error ? err.message : err);
        });
      }

      if (isDownloadAction) {
        try {
          const loadTemplateSnapshotWithRetry = async () => {
            try {
              return await loadOutputWorkTemplateSnapshot(accessToken, sheetId, outputTemplateTab, [
                outputWorkTab,
                "OUTPUT_Template",
                "OUTPUT_Work",
              ]);
            } catch (firstError) {
              console.warn(
                `Download CSV: first template snapshot read failed for ${trimmedSkuCheck}; retrying once.`,
                firstError instanceof Error ? firstError.message : firstError,
              );
              await sleep(750);
              return await loadOutputWorkTemplateSnapshot(accessToken, sheetId, outputTemplateTab, [
                outputWorkTab,
                "OUTPUT_Template",
                "OUTPUT_Work",
              ]);
            }
          };

          const [productsRows, brandsRows, templateSnapshot] = await Promise.all([
            (async () => {
              try {
                return await getSheetValuesFromTabCandidates(
                  accessToken,
                  sheetId,
                  [productsTab, "Products"],
                  "A:D",
                );
              } catch (error) {
                console.warn(
                  `Download CSV: failed to read Products visibility rows; defaulting visibility to N for ${trimmedSkuCheck}.`,
                  error instanceof Error ? error.message : error,
                );
                return [];
              }
            })(),
            (async () => {
              try {
                return await getSheetValues(accessToken, sheetId, `${brandsTab}!A:B`);
              } catch (error) {
                console.warn(
                  `Download CSV: failed to read Brands rows; using provided brand fallback for ${trimmedSkuCheck}.`,
                  error instanceof Error ? error.message : error,
                );
                return [];
              }
            })(),
            loadTemplateSnapshotWithRetry(),
          ]);
          const resolvedBrandName = resolveBrandNameForSku(
            trimmedSkuCheck,
            buildProductBrandMap(productsRows),
            buildBrandNameMap(brandsRows),
            brand,
          );

          const stagedRows = buildOutputWorkSeedRows(templateSnapshot.layout);
          const headers = stagedRows.headers;
          const productRow = stagedRows.productRow;
          const emailRow = stagedRows.emailRow;
          const colMap: Record<string, number> = {};
          headers.forEach((h: string, i: number) => { if (h) colMap[h] = i; });

          const setCol = (header: string, value: string) => {
            if (colMap[header] !== undefined) productRow[colMap[header]] = sanitizeForFormulas(value);
          };
          const setEmailCol = (header: string, value: string) => {
            if (colMap[header] !== undefined) emailRow[colMap[header]] = sanitizeForFormulas(value);
          };

          const trimmedTitle = String(title || "").trim();
          setCol("Product Name", trimmedTitle);
          setCol("Product Code/SKU", String(sku || "").trim());
          setCol("Brand Name", resolvedBrandName);

          let descForHtml = String(chatgptDescription || "").trim();
          if (/<\/?p>|<br\s*\/?>/i.test(descForHtml)) {
            descForHtml = descForHtml
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<\/p>\s*<p>/gi, "\n")
              .replace(/<[^>]+>/g, "")
              .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
              .replace(/&deg;/g, "°").replace(/&eacute;/g, "é")
              .replace(/&le;/g, "≤").replace(/&ge;/g, "≥")
              .trim();
          }
          setCol("Product Description", formatProductDescriptionHtml(descForHtml, String(chatgptData || "")));
          // Price: strip currency symbols/commas, output as plain integer
          const numericPrice = parseInt(String(price || "0").replace(/[^0-9.-]/g, ""), 10) || 0;
          setCol("Price", numericPrice > 0 ? String(numericPrice) : "");

          // Retail Price: use browser-cached value if valid, otherwise generate
          const parsedIncomingRetailPrice = parseInt(String(incomingRetailPrice || "0").replace(/[^0-9.-]/g, ""), 10);
          let resolvedRetailPrice: number;
          if (parsedIncomingRetailPrice > 0) {
            resolvedRetailPrice = parsedIncomingRetailPrice;
          } else if (numericPrice > 0) {
            // Equivalent to =ROUND(RANDBETWEEN(1.3*K2, 1.4*K2), 0)
            const min = Math.ceil(1.3 * numericPrice);
            const max = Math.floor(1.4 * numericPrice);
            resolvedRetailPrice = min + Math.floor(Math.random() * (max - min + 1));
          } else {
            resolvedRetailPrice = 0;
          }
          if (resolvedRetailPrice > 0) {
            setCol("Retail Price", String(resolvedRetailPrice));
          }

          let resolvedVisible = "N";
          for (let i = 1; i < productsRows.length; i++) {
            if (normalizeSkuForCompare(productsRows[i]?.[0] ?? "") === normalizeSkuForCompare(trimmedSkuCheck)) {
              const vis = (productsRows[i]?.[3] ?? "").toString().trim();
              resolvedVisible = vis === "1" ? "Y" : "N";
              break;
            }
          }
          setCol("Product Visible?", resolvedVisible);

          const allCategories = [mainCategory, ...(additionalCategories || [])]
            .map((category) => String(category || "").trim())
            .filter(Boolean);
          setCol("Category", allCategories.join(";"));
          setCol("GPS Category", allCategories.join(";"));

          const trimmedImageUrls = Array.isArray(imageUrls)
            ? imageUrls.map((url) => String(url ?? "").trim()).filter(Boolean)
            : [];
          const imageSlotCount = Math.min(Math.max(trimmedImageUrls.length, 8), 20);
          for (let i = 0; i < imageSlotCount; i++) {
            const n = i + 1;
            const url = i < trimmedImageUrls.length ? trimmedImageUrls[i] : "";
            setCol(`Product Image File - ${n}`, url);
            setCol(`Product Image Is Thumbnail - ${n}`, i === 0 ? "Y" : "N");
            setCol(`Product Image Sort - ${n}`, String(i));
          }

          setCol("Page Title", `${trimmedTitle} | Lighting Style`);
          setCol("Meta Description", `Buy online, 60% off sale! You will love the ${trimmedTitle}. We have the largest range of lighting in Australia.`);

          if (customFields) {
            setCol("Product Custom Fields", normalizeSemicolonListCellForOutput("Product Custom Fields", String(customFields)));
          }

          setCol("GPS Manufacturer Part Number", effectiveMpn);
          setCol("Search Keywords", `${effectiveMpn},${effectiveMpn}-L`);

          setEmailCol("Option Set Align", "Email:");
          setEmailCol("Product Description", String(emailNotes || ""));

          const csvText = buildLoadingDockCsvText(headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
          const ts = melbourneTimestamp();
          const eventId = `EVT-${Date.now()}`;
          const statusMsg = `Download prepared CSV for SKU ${trimmedSkuCheck} with MPN ${effectiveMpn} (${ts})`;
          let appendedEventRowNumber: number | null = null;
          try {
            const [statusWrite, eventAppend] = await Promise.allSettled([
              batchUpdateSheetValues(accessToken, sheetId, [{ range: `${eventsTab}!I5`, values: [[statusMsg]] }]),
              appendEventRowStrict(accessToken, sheetId, eventsTab, [
                ts,
                eventId,
                "FORM_DOWNLOAD",
                trimmedSkuCheck,
                effectiveMpn,
                ts,
                resolvedFormMpn.warning_message ?? "",
              ]),
            ]);

            if (statusWrite.status === "rejected") {
              console.warn(
                `Download CSV: non-fatal status panel update failure for ${trimmedSkuCheck}.`,
                statusWrite.reason instanceof Error ? statusWrite.reason.message : statusWrite.reason,
              );
            }

            if (eventAppend.status === "fulfilled") {
              appendedEventRowNumber = eventAppend.value.rowNumber;
            } else {
              console.warn(
                `Download CSV: non-fatal event logging failure for ${trimmedSkuCheck}.`,
                eventAppend.reason instanceof Error ? eventAppend.reason.message : eventAppend.reason,
              );
            }
          } catch (error) {
            console.warn(
              `Download CSV: non-fatal event logging failure for ${trimmedSkuCheck}.`,
              error instanceof Error ? error.message : error,
            );
          }
          return new Response(JSON.stringify({
            success: true,
            csvText,
            filename: `${trimmedSkuCheck}.csv`,
            mpn: effectiveMpn,
            retailPrice: resolvedRetailPrice > 0 ? String(resolvedRetailPrice) : undefined,
            warningTitle: resolvedFormMpn.warning_title ?? undefined,
            warningMessage: resolvedFormMpn.warning_message ?? undefined,
            eventId,
            eventRowNumber: appendedEventRowNumber,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Download CSV failed for ${trimmedSkuCheck}:`, errorMessage);
          return new Response(JSON.stringify({
            success: false,
            error: `Could not prepare CSV right now. Please retry in a few seconds. ${errorMessage}`,
            mpn: effectiveMpn,
            warningTitle: resolvedFormMpn.warning_title ?? undefined,
            warningMessage: resolvedFormMpn.warning_message ?? undefined,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      let outputWorkLock: OutputWorkLockHandle | null = null;

      try {
        outputWorkLock = await enterOutputWorkSubmissionWindow(accessToken, sheetId, eventsTab);

        const [outputWorkLayout, productsRows, brandsRows] = await Promise.all([
          resetOutputWorkFromTemplate(
            accessToken,
            sheetId,
            outputWorkTab,
            outputTemplateTab,
            [
              outputWorkTab,
              "OUTPUT_Template",
              "OUTPUT_Work",
            ],
          ),
          // Visibility source-of-truth: Products tab col D (never PRODUCTS TO DO col D which is a VLOOKUP formula)
          getSheetValues(accessToken, sheetId, `${productsTab}!A:D`).catch(() => [] as string[][]),
          getSheetValues(accessToken, sheetId, `${brandsTab}!A:B`).catch(() => [] as string[][]),
        ]);
        const resolvedBrandName = resolveBrandNameForSku(
          trimmedSkuCheck,
          buildProductBrandMap(productsRows),
          buildBrandNameMap(brandsRows),
          brand,
        );

        const stagedRows = buildOutputWorkSeedRows(outputWorkLayout);
        const headers = stagedRows.headers;
        const productRow = stagedRows.productRow;
        const emailRow = stagedRows.emailRow;
        const colMap: Record<string, number> = {};
        headers.forEach((h: string, i: number) => { if (h) colMap[h] = i; });

        const setCol = (header: string, value: string) => {
          if (colMap[header] !== undefined) productRow[colMap[header]] = sanitizeForFormulas(value);
        };
        const setEmailCol = (header: string, value: string) => {
          if (colMap[header] !== undefined) emailRow[colMap[header]] = sanitizeForFormulas(value);
        };

        const trimmedTitle = String(title || "").trim();
        setCol("Product Name", trimmedTitle);
        setCol("Product Code/SKU", String(sku || "").trim());
        setCol("Brand Name", resolvedBrandName);

        let descForHtml = String(chatgptDescription || "").trim();
        if (/<\/?p>|<br\s*\/?>/i.test(descForHtml)) {
          descForHtml = descForHtml
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>\s*<p>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/&deg;/g, "°").replace(/&eacute;/g, "é")
            .replace(/&le;/g, "≤").replace(/&ge;/g, "≥")
            .trim();
        }
        setCol("Product Description", formatProductDescriptionHtml(descForHtml, String(chatgptData || "")));
        // Price: strip currency symbols/commas, output as plain integer
        const numericPrice = parseInt(String(price || "0").replace(/[^0-9.-]/g, ""), 10) || 0;
        setCol("Price", numericPrice > 0 ? String(numericPrice) : "");

        // Retail Price: use browser-cached value if valid, otherwise generate
        const parsedIncomingRetailPrice = parseInt(String(incomingRetailPrice || "0").replace(/[^0-9.-]/g, ""), 10);
        let resolvedRetailPrice: number;
        if (parsedIncomingRetailPrice > 0) {
          resolvedRetailPrice = parsedIncomingRetailPrice;
        } else if (numericPrice > 0) {
          const min = Math.ceil(1.3 * numericPrice);
          const max = Math.floor(1.4 * numericPrice);
          resolvedRetailPrice = min + Math.floor(Math.random() * (max - min + 1));
        } else {
          resolvedRetailPrice = 0;
        }
        if (resolvedRetailPrice > 0) {
          setCol("Retail Price", String(resolvedRetailPrice));
        }

        // Visibility from Products sheet (source-of-truth: Products col D, never PRODUCTS TO DO col D)
        let resolvedVisible = "N";
        for (let i = 1; i < productsRows.length; i++) {
          if (normalizeSkuForCompare(productsRows[i]?.[0] ?? "") === normalizeSkuForCompare(sku)) {
            const vis = (productsRows[i]?.[3] ?? "").toString().trim();
            resolvedVisible = vis === "1" ? "Y" : "N";
            break;
          }
        }
        setCol("Product Visible?", resolvedVisible);

        const allCategories = [mainCategory, ...(additionalCategories || [])]
          .map((category) => String(category || "").trim())
          .filter(Boolean);
        setCol("Category", allCategories.join(";"));
        setCol("GPS Category", allCategories.join(";"));

        const trimmedImageUrls = Array.isArray(imageUrls)
          ? imageUrls.map((url) => String(url ?? "").trim()).filter(Boolean)
          : [];
        const imageSlotCount = Math.min(Math.max(trimmedImageUrls.length, 8), 20);
        for (let i = 0; i < imageSlotCount; i++) {
          const n = i + 1;
          const url = i < trimmedImageUrls.length ? trimmedImageUrls[i] : "";
          setCol(`Product Image File - ${n}`, url);
          setCol(`Product Image Is Thumbnail - ${n}`, i === 0 ? "Y" : "N");
          setCol(`Product Image Sort - ${n}`, String(i));
        }

        setCol("Page Title", `${trimmedTitle} | Lighting Style`);
        setCol("Meta Description", `Buy online, 60% off sale! You will love the ${trimmedTitle}. We have the largest range of lighting in Australia.`);

        if (customFields) {
          setCol("Product Custom Fields", normalizeSemicolonListCellForOutput("Product Custom Fields", String(customFields)));
        }

        setCol("GPS Manufacturer Part Number", effectiveMpn);
        if (effectiveMpn) {
          setCol("Search Keywords", `${effectiveMpn},${effectiveMpn}-L`);
        }

        setEmailCol("Option Set Align", "Email:");
        setEmailCol("Product Description", String(emailNotes || ""));

        await writeSeededOutputWorkRows(accessToken, sheetId, outputWorkTab, stagedRows);

        const eventId = `EVT-${Date.now()}`;
        const eventRow = [
          melbourneTimestamp(),
          eventId,
          "FORM_EMAIL",
          trimmedSkuCheck,
          effectiveMpn,
          "",
          resolvedFormMpn.warning_message ?? "",
        ];
        const appendedEvent = await appendEventRowStrict(accessToken, sheetId, eventsTab, eventRow);

        return new Response(JSON.stringify({
          success: true,
          pending: true,
          reason: `Email queued for SKU "${trimmedSkuCheck}" and will be processed shortly.`,
          mpn: effectiveMpn,
          retailPrice: resolvedRetailPrice > 0 ? String(resolvedRetailPrice) : undefined,
          warningTitle: resolvedFormMpn.warning_title ?? undefined,
          warningMessage: resolvedFormMpn.warning_message ?? undefined,
          eventId,
          eventRowNumber: appendedEvent.rowNumber,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } finally {
        // FORM_EMAIL leaves OUTPUT_Work intact so Apps Script can read it,
        // then EmailSingle.gs resets it after the queued email is processed.
        await releaseOutputWorkLock(outputWorkLock);
      }
      } catch (outerError) {
        // Outer catch for errors before the action-specific try/catch (e.g., MPN DB errors)
        const msg = outerError instanceof Error ? outerError.message : String(outerError);
        console.error(`${action} outer error for action:`, msg);
        return new Response(JSON.stringify({
          success: false,
          error: msg,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (action === "check-sku-temp-csv") {
      const { sku } = body;
      if (typeof sku !== "string" || sku.trim().length === 0 || sku.length > 255) {
        return new Response(
          JSON.stringify({ error: "Invalid SKU parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const tempCsvTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
      try {
        const rows = await getSheetValues(accessToken, sheetId, `${tempCsvTab}!E:E`);
        const trimmedSku = sku.trim();
        const exists = rows.some((row: string[]) => (row[0] ?? "").toString().trim() === trimmedSku);
        return new Response(JSON.stringify({ exists }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        // If tab doesn't exist, SKU can't exist there
        console.warn("Could not read Loading Dock tab:", err);
        return new Response(JSON.stringify({ exists: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (action === "log-dock-delete") {
      // Logs a DOCK_DELETE event to the Events tab for the given SKU.
      // We ALSO attempt to delete the block directly via Sheets API so this never depends on
      // Apps Script trigger timing (Apps Script remains a fallback / auditor).
      const { sku } = body;
      if (typeof sku !== "string" || sku.trim().length === 0 || sku.length > 255) {
        return new Response(
          JSON.stringify({ error: "Invalid SKU parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const trimmedSku = sku.trim();
      const submittedAtHint = getSubmittedAtHint(body);
      const markCompleteRequested = body.markComplete === true;
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
      const dockTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
      const productsTab = resolveTabName(tabNames, "PRODUCTS_TODO", "PRODUCTS TO DO");
      let deleteLock: DockEmailSingleLockHandle | null = null;

      try {
        deleteLock = await acquireDockDeleteLock(trimmedSku);

        const [eventRows, globalPendingEntries] = await Promise.all([
          readRecentEventRowsForSku(accessToken, sheetId, eventsTab, trimmedSku),
          readGlobalDockPendingEntries(),
        ]);

        if (submittedAtHint) {
          const validation = validateSubmittedAtHintForSku(eventRows, trimmedSku, submittedAtHint);
          if (validation.state === "pending") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `Product ${trimmedSku} is still being processed in the background queue. Please wait a few seconds and try again.`,
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          if (validation.state === "changed") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `SKU "${trimmedSku}" has newer Loading Dock data. Refresh and try again.`,
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }

        if (isDockMutationPendingForSku(eventRows, globalPendingEntries, trimmedSku)) {
          return new Response(
            JSON.stringify({
              success: false,
              error: `SKU "${trimmedSku}" still has a pending submit or override. Delete is blocked until Processed_At is filled.`,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        const melbourneTime = melbourneTimestamp();
        const eventId = `EVT-${Date.now()}`;
        const eventRow = [
          melbourneTime, // A: Timestamp (Melbourne)
          eventId,       // B: Event_ID
          "DOCK_DELETE", // C: Event_Type
          trimmedSku,    // D: SKU
          markCompleteRequested ? "COMPLETE" : "", // E: mode
          "",            // F: Processed_At
          "",            // G: Error / warning
        ];

        const appendedDeleteEvent = await appendEventRowStrict(accessToken, sheetId, eventsTab, eventRow);
        console.log(`DOCK_DELETE event logged for SKU: ${trimmedSku}`);

        // Invalidate dock cache so the next fetch reflects this action.
        _dockEntriesCache = null;
        _dockEntriesInflight = null;
        await deleteCaches(["fetch-dock-entries"]);

        // Best-effort: delete dock block directly (fast + reliable), then mark Processed_At.
        // If this fails (quota, transient), Apps Script will still process the DOCK_DELETE event later.
        const eventRowNumber = appendedDeleteEvent.rowNumber;
        try {
          const dockBlock = await readReadableLoadingDockBlockForSku(accessToken, sheetId, dockTab, trimmedSku);
          const processedAt = melbourneTimestamp();

          if (dockBlock) {
            const blockStartRowNumber = Math.max(2, dockBlock.skuRowIdx); // header row (1-indexed) == skuRowIdx
            const rowNumbers = [
              blockStartRowNumber,
              blockStartRowNumber + 1,
              blockStartRowNumber + 2,
              blockStartRowNumber + 3,
            ];
            await deleteSheetRows(accessToken, sheetId, dockTab, rowNumbers);
            const warning =
              markCompleteRequested
                ? await syncProductsTodoCompleteForSku(accessToken, sheetId, productsTab, trimmedSku)
                : undefined;
            await updateSheetRange(accessToken, sheetId, `${eventsTab}!F${eventRowNumber}:G${eventRowNumber}`, [[processedAt, warning || ""]], { valueInputOption: "RAW" });
            _dockEntriesCache = null;
            _dockEntriesInflight = null;
            await deleteCaches(["fetch-dock-entries"]);
            return new Response(JSON.stringify({ success: true, processedAt, warning }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          // Not found — still mark processed (informational)
          await updateSheetRange(accessToken, sheetId, `${eventsTab}!F${eventRowNumber}:G${eventRowNumber}`, [[processedAt, "SKU block not found in Loading Dock"]], { valueInputOption: "RAW" });
          _dockEntriesCache = null;
          _dockEntriesInflight = null;
          await deleteCaches(["fetch-dock-entries"]);
          return new Response(JSON.stringify({ success: true, processedAt, note: "SKU block not found in Loading Dock" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err) {
          console.warn("Direct DOCK_DELETE failed (will rely on Apps Script):", err);
        }

        await kickAppsScriptFunction(accessToken, "processDeleteDockEvents");

        const completion = await waitForDockDeleteCompletion(accessToken, sheetId, {
          eventsTab,
          dockTab,
          sku: trimmedSku,
          eventRowNumber: appendedDeleteEvent.rowNumber,
        });

        if (completion.status === "completed") {
          _dockEntriesCache = null;
          _dockEntriesInflight = null;
          await deleteCaches(["fetch-dock-entries"]);
          return new Response(JSON.stringify({ success: true, processedAt: completion.processedAt, warning: completion.warning }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Never hard-fail deletes due to timing/quota — the event is logged and will be processed.
        return new Response(JSON.stringify({
          success: true,
          pending: true,
          reason: completion.status === "pending" ? completion.reason : "Delete queued; verification did not complete in time.",
          warning: completion.status === "failed" ? completion.error : undefined,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } finally {
        await releaseDockDeleteLock(deleteLock);
      }
    }

    if (action === "log-email-single") {
      // Logs an EMAIL_SINGLE event to the Events tab for the given SKU.
      // This is an async, Apps Script-owned pipeline — the edge function should NOT block waiting for it.
      const { sku } = body;
      if (typeof sku !== "string" || sku.trim().length === 0 || sku.length > 255) {
        return new Response(
          JSON.stringify({ error: "Invalid SKU parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const trimmedSku = sku.trim();
      const submittedAtHint = getSubmittedAtHint(body);
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
      const dockTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
      let emailLock: DockEmailSingleLockHandle | null = null;

      try {
        emailLock = await acquireDockEmailSingleLock(trimmedSku);

        const [eventRows, globalPendingEntries] = await Promise.all([
          readRecentEventRowsForSku(accessToken, sheetId, eventsTab, trimmedSku),
          readGlobalDockPendingEntries(),
        ]);

        if (submittedAtHint) {
          const validation = validateSubmittedAtHintForSku(eventRows, trimmedSku, submittedAtHint);
          if (validation.state === "pending") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `Product ${trimmedSku} is still being processed in the background queue. Please wait a few seconds and try again.`,
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          if (validation.state === "changed") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `SKU "${trimmedSku}" has newer Loading Dock data. Refresh and try again.`,
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }

        if (isDockMutationPendingForSku(eventRows, globalPendingEntries, trimmedSku)) {
          return new Response(
            JSON.stringify({
              success: false,
              error: `SKU "${trimmedSku}" still has a pending submit or override. Email is blocked until Processed_At is filled.`,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        // NOTE: EMAIL_SINGLE does NOT wait at the Processed_At gate.
        // It doesn't touch OUTPUT_Work — it only reads from Loading Dock.
        const melbourneTime = melbourneTimestamp();
        const eventId = `EVT-${Date.now()}`;
        const eventRow = [
          melbourneTime, // A: Timestamp (Melbourne)
          eventId,       // B: Event_ID
          "EMAIL_SINGLE",// C: Event_Type
          trimmedSku,    // D: SKU
          "",            // E: MPN (not applicable)
          "",            // F: Processed_At (filled by Apps Script)
          "",            // G: Error / warning
        ];

        const appendedEmailEvent = await appendEventRowStrict(accessToken, sheetId, eventsTab, eventRow);
        console.log(`EMAIL_SINGLE event logged for SKU: ${trimmedSku}`);
        _dockEntriesCache = null;
        _dockEntriesInflight = null;
        await deleteCaches(["fetch-dock-entries"]);
        await kickAppsScriptFunction(accessToken, "processEmailSingleEvents");

        const completion = await waitForEmailSingleCompletion(accessToken, sheetId, {
          eventsTab,
          dockTab,
          sku: trimmedSku,
          eventRowNumber: appendedEmailEvent.rowNumber,
        });

        if (completion.status === "completed") {
          return new Response(JSON.stringify({
            success: true,
            processedAt: completion.processedAt,
            warning: completion.warning,
            eventId,
            eventRowNumber: appendedEmailEvent.rowNumber,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (completion.status === "failed") {
          return new Response(JSON.stringify({
            success: false,
            error: completion.error,
            eventId,
            eventRowNumber: appendedEmailEvent.rowNumber,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Pending is the normal path — the event is logged and will be processed.
        return new Response(JSON.stringify({
          success: true,
          pending: true,
          reason: completion.reason,
          eventId,
          eventRowNumber: appendedEmailEvent.rowNumber,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } finally {
        await releaseDockEmailSingleLock(emailLock);
      }
    }

    if (action === "log-send-dock") {
      // Logs a SEND_DOCK event with all SKUs (comma-separated) and mode (SEND/CLEAR).
      // For CLEAR mode, we execute deletions directly (Apps Script becomes fallback).
      // For SEND mode, Apps Script handles emailing + deletion.
      const { skus, mode } = body;
      if (typeof skus !== "string" || skus.trim().length === 0 || skus.length > 10000) {
        return new Response(
          JSON.stringify({ error: "Invalid skus parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const validMode = (mode === "SEND" || mode === "CLEAR") ? mode : "CLEAR";
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
      const dockTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
      const targetSkus = parseSkuList(skus);
      if (targetSkus.length === 0) {
        return new Response(
          JSON.stringify({ error: "No valid SKUs were provided" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const [eventRows, globalPendingEntries] = await Promise.all([
        getSheetValuesFromTabCandidates(accessToken, sheetId, [eventsTab, "Events", "EVENTS"], "A:G", { render: "unformatted" }),
        readGlobalDockPendingEntries(),
      ]);
      const blockedSkus = targetSkus.filter((sku) => isDockMutationPendingForSku(eventRows, globalPendingEntries, sku));
      if (blockedSkus.length > 0) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `Loading Dock still has pending submit/override work for: ${blockedSkus.slice(0, 5).join(", ")}${blockedSkus.length > 5 ? " ..." : ""}. Send/Clear is blocked until Processed_At is filled.`,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const melbourneTime = melbourneTimestamp();
      const eventId = `EVT-${Date.now()}`;
      const eventRow = [
        melbourneTime,    // A: Timestamp (Melbourne)
        eventId,          // B: Event_ID
        "SEND_DOCK",      // C: Event_Type
        targetSkus.join(","), // D: SKU list (comma-separated)
        validMode,        // E: Mode (SEND or CLEAR)
        "",               // F: Processed_At
        "",               // G: Result summary
      ];
      const appendedSendDockEvent = await appendEventRowStrict(accessToken, sheetId, eventsTab, eventRow);
      const eventRowNumber = appendedSendDockEvent.rowNumber;
      console.log(`SEND_DOCK event logged: mode=${validMode}, skus=${targetSkus.join(",").substring(0, 100)}`);

      // Invalidate dock cache so the next fetch reflects this action.
      _dockEntriesCache = null;

      // ── CLEAR mode: execute deletions directly ──
      if (validMode === "CLEAR") {
        try {
          const dockTabCandidates = [dockTab, "Loading Dock", "LOADING_DOCK", "LoadingDock"];
          const dockRows = await getSheetValuesFromTabCandidates(accessToken, sheetId, dockTabCandidates, "A:ZZ");

          // Collect all row numbers to delete (4 rows per SKU block), bottom-up.
          const rowNumbersToDelete: number[] = [];
          let deletedCount = 0;
          for (const sku of targetSkus) {
            const dockBlock = findReadableLoadingDockBlock(dockRows, sku);
            if (dockBlock) {
              const blockStartRowNumber = Math.max(2, dockBlock.skuRowIdx);
              rowNumbersToDelete.push(
                blockStartRowNumber,
                blockStartRowNumber + 1,
                blockStartRowNumber + 2,
                blockStartRowNumber + 3,
              );
              deletedCount++;
            }
          }

          if (rowNumbersToDelete.length > 0) {
            await deleteSheetRows(accessToken, sheetId, dockTab, rowNumbersToDelete);
          }

          const processedAt = melbourneTimestamp();
          const summary = `Deleted ${deletedCount}/${targetSkus.length}`;
          await updateSheetRange(accessToken, sheetId, `${eventsTab}!F${eventRowNumber}:G${eventRowNumber}`, [[processedAt, summary]], { valueInputOption: "RAW" });
          _dockEntriesCache = null;

          return new Response(JSON.stringify({
            success: true,
            processedAt,
            deleted: deletedCount,
            emailed: 0,
            summary,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err) {
          console.warn("Direct CLEAR batch failed (will rely on Apps Script):", err);
        }
      }

      // ── SEND mode OR direct-clear failed: rely on Apps Script ──
      await kickAppsScriptFunction(accessToken, "processSendDockEvents");

      const completion = await waitForSendDockCompletion(accessToken, sheetId, {
        eventsTab,
        dockTab,
        targetSkus,
        mode: validMode,
        eventRowNumber: appendedSendDockEvent.rowNumber,
      });

      if (completion.status === "completed") {
        _dockEntriesCache = null;
        return new Response(JSON.stringify({
          success: true,
          processedAt: completion.processedAt,
          deleted: completion.deleted,
          emailed: completion.emailed,
          summary: completion.summary,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Never hard-fail batch operations due to timing — the event is logged and will be processed.
      return new Response(JSON.stringify({
        success: true,
        pending: true,
        deleted: completion.status === "failed" ? completion.deleted : 0,
        emailed: completion.status === "failed" ? completion.emailed : 0,
        summary: completion.status === "failed" ? completion.summary : "",
        reason: completion.status === "pending" ? completion.reason : "Batch queued; verification did not complete in time.",
        warning: completion.status === "failed" ? completion.error : undefined,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── MPN Panel Actions ──────────────────────────────────────────────────
    if (
      action === "mpn-peek" ||
      action === "log-form-mpn-sku-change" ||
      action === "resolve-form-mpn-state" ||
      action === "release-form-generated-mpn" ||
      action === "mpn-increment" ||
      action === "mpn-eran" ||
      action === "mpn-set-next" ||
      action === "mpn-commit"
    ) {
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events") ?? "Events";
      const DEFAULT_START = 57324;

      // Helper: read I3:I8 in one call
      async function readMpnPanel(): Promise<{ nextMpn: number; status: string; eranMsg: string; eranValue: number | null }> {
        const rows = await getSheetValues(accessToken!, sheetId!, `${eventsTab}!I3:I8`);
        const label = (rows[0]?.[0] ?? "").toString().trim();
        let nextMpn = Number(rows[1]?.[0]);
        const status = (rows[2]?.[0] ?? "").toString();
        const eranMsg = (rows[4]?.[0] ?? "").toString();
        const eranValRaw = rows[5]?.[0];
        const eranValue = eranValRaw ? Number(eranValRaw) : null;

        // Auto-init if needed
        if (label !== "NEXT_MPN" || !Number.isFinite(nextMpn) || nextMpn <= 0) {
          nextMpn = DEFAULT_START;
          await updateCellRange(accessToken!, sheetId!, `${eventsTab}!I3:I4`, [["NEXT_MPN"], [String(DEFAULT_START)]]);
        }
        return { nextMpn, status, eranMsg, eranValue };
      }

      // Helper: write cells
      async function updateCellRange(token: string, sid: string, range: string, values: string[][]) {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
        const res = await fetch(url, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values }),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Failed to update cells: ${errText}`);
        }
      }

      // melbTime() now uses the module-level melbourneTimestamp()

      if (action === "mpn-peek") {
        const panel = await readMpnPanel();
        const nextMpn = await readDbNextMpn();
        if (panel.nextMpn !== nextMpn) {
          await updateCellRange(accessToken!, sheetId!, `${eventsTab}!I4:I4`, [[String(nextMpn)]]);
        }
        return new Response(JSON.stringify({ success: true, nextMpn, status: panel.status, eranMsg: panel.eranMsg, eranValue: panel.eranValue }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (action === "resolve-form-mpn-state") {
        const draftId = String(body.draftId ?? "").trim();
        const sku = String(body.sku ?? "").trim();
        const source = String(body.source ?? "View").trim() || "View";
        const requestedMpn = Number(body.requestedMpn);
        const normalizedAction =
          source === "Send By Email"
            ? "send_by_email"
            : source === "Download"
              ? "download"
              : "view";

        if (!draftId) {
          return new Response(JSON.stringify({ success: false, error: "draftId is required" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
          });
        }
        if (!sku) {
          return new Response(JSON.stringify({ success: false, error: "SKU is required" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
          });
        }

        const resolved = await resolveDraftMpnStateInDb({
          draftId,
          sku,
          action: normalizedAction,
          requestedMpn: Number.isFinite(requestedMpn) && requestedMpn > 0 ? requestedMpn : null,
        });

        const nextMpn = Number.isFinite(Number(resolved.next_mpn)) && Number(resolved.next_mpn) > 0
          ? Number(resolved.next_mpn)
          : await readDbNextMpn();

        const hasAttachmentJustHappened =
          resolved.transition === "generated_and_attached"
          || resolved.transition === "generated_now_attached";
        const hasPreviewIncrementWarning = Boolean(resolved.warning_message);

        const statusMsg = hasAttachmentJustHappened
          ? hasPreviewIncrementWarning
            ? `${source}: MPN ${resolved.mpn} attached to SKU ${sku} after the previously displayed MPN was already claimed (${melbourneTimestamp()})`
            : `${source}: MPN ${resolved.mpn} attached to SKU ${sku} (${melbourneTimestamp()})`
          : hasPreviewIncrementWarning
            ? `Displayed MPN moved to ${resolved.mpn} because the previous number was already claimed (${melbourneTimestamp()})`
            : "";

        const ts = melbourneTimestamp();
        const eventId = `EVT-${Date.now()}`;
        const eventType = hasAttachmentJustHappened
          ? "MPN_ATTACH_WEB"
          : hasPreviewIncrementWarning
            ? "MPN_PREVIEW_INCREMENT_WEB"
            : "";
        try {
          if (statusMsg) {
            await updateCellRange(accessToken, sheetId, `${eventsTab}!I4:I5`, [[String(nextMpn)], [statusMsg]]);
          } else {
            await updateCellRange(accessToken, sheetId, `${eventsTab}!I4:I4`, [[String(nextMpn)]]);
          }
          if (eventType) {
            await appendEventRowStrict(
              accessToken,
              sheetId,
              eventsTab,
              [
                ts,
                eventId,
                eventType,
                sku,
                String(resolved.mpn),
                ts,
                resolved.warning_message ?? "",
              ],
            );
          }
        } catch (error) {
          console.warn(
            `resolve-form-mpn-state: non-fatal Events sheet write failure for sku=${sku} mpn=${resolved.mpn}`,
            error instanceof Error ? error.message : error,
          );
        }

        return new Response(JSON.stringify({
          success: true,
          mpn: String(resolved.mpn),
          attachmentState: resolved.attachment_state,
          transition: resolved.transition,
          nextMpn,
          status: statusMsg,
          warningTitle: resolved.warning_title ?? undefined,
          warningMessage: resolved.warning_message ?? undefined,
          warningCode: resolved.warning_code ?? undefined,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (action === "release-form-generated-mpn") {
        const draftId = String(body.draftId ?? "").trim();
        if (!draftId) {
          return new Response(JSON.stringify({ success: false, error: "draftId is required" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
          });
        }

        await releaseGeneratedDraftMpnInDb(draftId);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (action === "log-form-mpn-sku-change") {
        const draftId = String(body.draftId ?? "").trim();
        const fromSku = String(body.fromSku ?? "").trim();
        const toSku = String(body.toSku ?? "").trim();
        if (!draftId) {
          return new Response(JSON.stringify({ success: false, error: "draftId is required" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
          });
        }
        if (!fromSku) {
          return new Response(JSON.stringify({ success: false, error: "fromSku is required" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
          });
        }
        if (!toSku) {
          return new Response(JSON.stringify({ success: false, error: "toSku is required" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
          });
        }

        const snapshot = await readDraftMpnSnapshotFromDb(draftId);
        if (!snapshot) {
          // No draft yet (user hasn't triggered View/Send/Download) — nothing to log, return success
          return new Response(JSON.stringify({ success: true, skipped: true, reason: "No draft MPN state exists yet" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const statusMsg = snapshot.attachment_state === "attached"
          ? `SKU changed from ${fromSku} to ${toSku}. Attached MPN ${snapshot.mpn} remains with ${fromSku}; ${toSku} requires a new MPN flow (${melbourneTimestamp()})`
          : `SKU changed from ${fromSku} to ${toSku}. MPN ${snapshot.mpn} retained; not attached yet (${melbourneTimestamp()})`;
        const ts = melbourneTimestamp();
        const eventId = `EVT-${Date.now()}`;
        try {
          await updateCellRange(accessToken, sheetId, `${eventsTab}!I5:I5`, [[statusMsg]]);
          await appendEventRowStrict(
            accessToken,
            sheetId,
            eventsTab,
            [
              ts,
              eventId,
              snapshot.attachment_state === "attached" ? "MPN_SKU_CHANGE_ATTACHED_WEB" : "MPN_SKU_CHANGE_GENERATED_WEB",
              `${fromSku}→${toSku}`,
              String(snapshot.mpn),
              ts,
              "",
            ],
          );
        } catch (error) {
          console.warn(
            `log-form-mpn-sku-change: non-fatal Events sheet write failure for draft=${draftId}`,
            error instanceof Error ? error.message : error,
          );
        }
        return new Response(JSON.stringify({
          success: true,
          status: statusMsg,
          attachmentState: snapshot.attachment_state,
          mpn: String(snapshot.mpn),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (action === "mpn-increment") {
        const panel = await readMpnPanel();
        const allocation = await allocateExternalMpnInDb({
          source: "manual_increment",
          notes: "Manual increment from Events panel",
          sheetFloorNextMpn: null,
        });
        const before = allocation.reserved_mpn;
        const after = allocation.next_mpn;
        const statusMsg = `Manual increment: ${before} → ${after} (${melbourneTimestamp()})`;
        await updateCellRange(accessToken, sheetId, `${eventsTab}!I4:I5`, [[String(after)], [statusMsg]]);
        // Log event
        const ts = melbourneTimestamp();
        const eventId = `EVT-${Date.now()}`;
        await appendEventRowStrict(accessToken, sheetId, eventsTab, [ts, eventId, "MPN_INCREMENT_PRODUCTS", "", String(before), ts, ""]);
        return new Response(JSON.stringify({ success: true, nextMpn: after, status: statusMsg }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (action === "mpn-eran") {
        const panel = await readMpnPanel();
        const allocation = await allocateExternalMpnInDb({
          source: "eran",
          notes: "Reserved from Events panel for Eran",
          sheetFloorNextMpn: null,
        });
        const reserved = allocation.reserved_mpn;
        const after = allocation.next_mpn;
        const ddmmyy = new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Melbourne", day: "2-digit", month: "2-digit", year: "2-digit" });
        const statusMsg = `Eran reserved ${reserved}, NEXT_MPN → ${after} (${melbourneTimestamp()})`;
        const eranMsg = `Eran (${ddmmyy}) use:`;
        // Update I4 (next), I5 (status), I6 (clear), I7 (eran msg), I8 (eran value)
        await updateCellRange(accessToken, sheetId, `${eventsTab}!I4:I8`, [
          [String(after)], [statusMsg], [""], [eranMsg], [String(reserved)]
        ]);
        // Log event
        const ts = melbourneTimestamp();
        const eventId = `EVT-${Date.now()}`;
        await appendEventRowStrict(accessToken, sheetId, eventsTab, [ts, eventId, "MPN_RESERVE_ERAN", "", String(reserved), ts, ""]);
        return new Response(JSON.stringify({ success: true, nextMpn: after, reservedMpn: reserved, status: statusMsg, eranMsg, eranValue: reserved }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (action === "mpn-set-next") {
        const requestedNextMpn = Number(body.nextMpn);
        if (!Number.isFinite(requestedNextMpn) || requestedNextMpn <= 0) {
          return new Response(JSON.stringify({ success: false, error: "nextMpn must be a positive number" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
          });
        }

        const resolvedNextMpn = await setDbNextMpn(Math.trunc(requestedNextMpn));
        const statusMsg = `Next MPN set to ${resolvedNextMpn} (${melbourneTimestamp()})`;
        await updateCellRange(accessToken, sheetId, `${eventsTab}!I4:I5`, [[String(resolvedNextMpn)], [statusMsg]]);
        return new Response(JSON.stringify({
          success: true,
          nextMpn: resolvedNextMpn,
          status: statusMsg,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (action === "mpn-commit") {
        const { sku, reservedMpn } = body;
        const mpn = Number(reservedMpn);
        if (!Number.isFinite(mpn) || mpn <= 0) {
          return new Response(JSON.stringify({ success: false, error: "Invalid reservedMpn" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
          });
        }
        const after = mpn + 1;
        const statusMsg = `Web generated and attached MPN ${mpn} to SKU ${String(sku || "").trim()}, NEXT_MPN → ${after} (${melbourneTimestamp()})`;
        await updateCellRange(accessToken, sheetId, `${eventsTab}!I4:I5`, [[String(after)], [statusMsg]]);
        const ts = melbourneTimestamp();
        const eventId = `EVT-${Date.now()}`;
        await appendEventRowStrict(accessToken, sheetId, eventsTab, [ts, eventId, "MPN_ATTACH_WEB", String(sku || ""), String(mpn), ts, ""]);
        return new Response(JSON.stringify({ success: true, nextMpn: after, status: statusMsg, attachmentState: "attached" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (action === "fetch-dock-entries") {
      const tempCsvTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
      const includeFormDataMap = body.includeFormDataMap === true;
      const includeTitleMap = body.includeTitleMap === true;
      const includeDebug = body.includeDebug === true;
      try {
        const now = Date.now();
        if (_dockEntriesCache && (now - _dockEntriesCache.ts) < DOCK_ENTRIES_CACHE_TTL_MS) {
          return new Response(JSON.stringify({
            entries: _dockEntriesCache.entries,
            formDataMap: includeFormDataMap ? _dockEntriesCache.formDataMap : undefined,
            titleMap: includeTitleMap ? _dockEntriesCache.titleMap : undefined,
            errors: _dockEntriesCache.errors,
            debugReasonsBySku: includeDebug ? _dockEntriesCache.debugReasonsBySku : undefined,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (!_dockEntriesInflight) {
          _dockEntriesInflight = (async (): Promise<DockResult> => {
            const dockTabCandidates = [tempCsvTab, "Loading Dock", "LOADING_DOCK", "LoadingDock"];
            const eventsTabCandidates = [eventsTab, "Events", "EVENTS"];
            // Read the FULL dock sheet (all columns) + events
            const [allRows, eventRows, globalPendingEntries] = await Promise.all([
              getSheetValuesFromTabCandidates(accessToken, sheetId, dockTabCandidates, "A:ZZ"),
              getSheetValuesFromTabCandidates(accessToken, sheetId, eventsTabCandidates, "A:G", { render: "unformatted" }),
              readGlobalDockPendingEntries(),
            ]);

            // Column E is index 4 (0-based). SKUs at rows 3,7,11... => idx 2,6,10...
            const skuSet = new Set<string>();
            const normalizedSkuSet = new Set<string>();
            const skuList: string[] = [];
            const skuRowMap: Record<string, number> = {}; // normalized sku -> 0-based row index of SKU row
            for (let i = 2; i < allRows.length; i += 4) {
              const val = ((allRows[i]?.[4]) ?? "").toString().trim();
              if (!val) continue;
              const normalized = normalizeSkuForCompare(val);
              if (!normalized) continue;
              if (!skuSet.has(val) && !normalizedSkuSet.has(normalized)) {
                skuSet.add(val);
                normalizedSkuSet.add(normalized);
                skuList.push(val);
              }
              // Always keep the latest seen row for this SKU (overwrite-safe).
              skuRowMap[normalized] = i;
            }
            if (skuList.length === 0) {
              for (let i = 2; i < allRows.length; i++) {
                const val = ((allRows[i]?.[4]) ?? "").toString().trim();
                if (!val) continue;
                const norm = val.toLowerCase();
                if (norm === "product code/sku" || norm === "sku") continue;
                const normalized = normalizeSkuForCompare(val);
                if (!normalized) continue;
                if (!skuSet.has(val) && !normalizedSkuSet.has(normalized)) {
                  skuSet.add(val);
                  normalizedSkuSet.add(normalized);
                  skuList.push(val);
                }
                // Keep newest row for duplicates in fallback scan too.
                skuRowMap[normalized] = i;
              }
            }

            // Build events map
            const skuDateMap: Record<string, string> = {};
            const skuTimestampMap: Record<string, string> = {};
            const skuHasErrorOrDeleteMap: Record<string, boolean> = {};
            const skuHasSubmitLikeMap: Record<string, boolean> = {};
            const skuPendingFreshMap: Record<string, boolean> = {};
            const skuLatestErrorMap: Record<string, string> = {};
            const skuDisplayMap: Record<string, string> = {};
            for (let i = 1; i < eventRows.length; i++) {
              const row = eventRows[i] ?? [];
              const timestamp = (row[0] ?? "").toString().trim();
              const eventId = (row[1] ?? "").toString().trim();
              const eventType = (row[2] ?? "").toString().trim().toUpperCase();
              const eventSkuRaw = (row[3] ?? "").toString().trim();
              const eventSku = normalizeSkuForCompare(eventSkuRaw);
              const processedAt = (row[5] ?? "").toString().trim();
              const errorMsg = (row[6] ?? "").toString().trim();

              if (!eventSku) continue;
              if (!skuDisplayMap[eventSku]) skuDisplayMap[eventSku] = eventSkuRaw || eventSku;
              const normalizedTimestamp = normalizeTimestampForClient(timestamp, eventId);
              const normalizedProcessedAt = normalizeTimestampForClient(processedAt);

              if (isSubmitLikeEventType(eventType)) {
                const eventEpochMs = extractEventEpochMs(timestamp, eventId);
                const stalePending =
                  !processedAt &&
                  !errorMsg &&
                  eventEpochMs > 0 &&
                  (Date.now() - eventEpochMs) > STALE_PENDING_EVENT_MAX_AGE_MS;

                skuDateMap[eventSku] = normalizedProcessedAt;
                skuTimestampMap[eventSku] = normalizedTimestamp;
                skuHasSubmitLikeMap[eventSku] = true;
                skuPendingFreshMap[eventSku] = !stalePending;
                // If this SUBMIT/UPLOAD row explicitly has an error message in Col G, mark it as errored.
                skuHasErrorOrDeleteMap[eventSku] = Boolean(errorMsg);
                if (errorMsg) {
                  skuLatestErrorMap[eventSku] = errorMsg;
                } else {
                  delete skuLatestErrorMap[eventSku];
                }
              } else if (isCompletionEventType(eventType) && normalizedProcessedAt) {
                if (skuHasSubmitLikeMap[eventSku]) {
                  skuDateMap[eventSku] = normalizedProcessedAt;
                  if (!skuTimestampMap[eventSku]) skuTimestampMap[eventSku] = normalizedTimestamp;
                }
              } else if (eventType === "ERROR" || eventType === "DOCK_DELETE") {
                skuHasErrorOrDeleteMap[eventSku] = true;
                // Only track errors from genuine ERROR events, not from DOCK_DELETE.
                // DOCK_DELETE "SKU block not found" is informational, not a submission failure.
                // Without this filter, a DOCK_DELETE error can overwrite the cleared error from
                // a successful SUBMIT, making the frontend show a false "Submission failed" toast.
                if (errorMsg && eventType !== "DOCK_DELETE") skuLatestErrorMap[eventSku] = errorMsg;
              }
            }

            const nextGlobalPendingEntries = globalPendingEntries.filter((entry) => {
              const normalizedSku = normalizeSkuForCompare(entry.sku);
              if (!normalizedSku) return false;
              if (skuHasErrorOrDeleteMap[normalizedSku]) return false;
              // If the SKU already exists in the dock, processing completed.
              if (normalizedSkuSet.has(normalizedSku)) return false;
              const submitState = getLatestSubmitLikeEventStateForSku(eventRows, entry.sku);
              if (
                submitState === null &&
                (Date.now() - entry.submittedAtEpochMs) > ORPHAN_GLOBAL_PENDING_WITHOUT_EVENT_GRACE_MS
              ) {
                return false;
              }
              if (submitState && !isSubmitLikeEventPending(submitState)) return false;
              return true;
            });

            const shouldRewriteGlobalPending =
              nextGlobalPendingEntries.length !== globalPendingEntries.length ||
              nextGlobalPendingEntries.some((entry, index) => globalPendingEntries[index]?.sku !== entry.sku);
            if (shouldRewriteGlobalPending) {
              writeGlobalDockPendingEntries(nextGlobalPendingEntries).catch(() => {});
            }

            for (const entry of nextGlobalPendingEntries) {
              const normalizedSku = normalizeSkuForCompare(entry.sku);
              if (!normalizedSku) continue;
              if (!skuDisplayMap[normalizedSku]) skuDisplayMap[normalizedSku] = entry.sku;
              // Force the dock list to reflect the active pending state for this SKU.
              // Without this, an older completed SUBMIT row can keep the item looking
              // actionable in the table while row-level guards still correctly block it.
              skuTimestampMap[normalizedSku] = entry.submittedAt;
              skuDateMap[normalizedSku] = "";
              skuHasSubmitLikeMap[normalizedSku] = true;
              skuPendingFreshMap[normalizedSku] = true;
            }

            const pendingDockActionsBySku = getPendingDockActionStates(
              eventRows,
              new Set(Object.keys(skuRowMap)),
            );

            // INJECT PENDING SKUS INTO LIST:
            // Items still in queue (processedAt === "") may not yet exist in Loading Dock.
            // Do not inject errored or deleted SKUs.
            for (const [evtSku, processedAt] of Object.entries(skuDateMap)) {
              const isFreshPending = skuPendingFreshMap[evtSku] ?? true;
              if (processedAt === "" && isFreshPending && !normalizedSkuSet.has(evtSku) && !skuHasErrorOrDeleteMap[evtSku]) {
                const displaySku = skuDisplayMap[evtSku] || evtSku;
                skuList.push(displaySku);
                normalizedSkuSet.add(evtSku);
              }
            }

            // Parse form data from 4-row blocks (normalizeColName + findCol from module scope)

            const formDataMap: Record<string, DockFormData> = {};
            const titleMap: Record<string, string> = {};
            const readableDockSkuSet = new Set<string>();
            for (const sku of skuList) {
              const normalizedSku = normalizeSkuForCompare(sku);
              const isFreshPending = skuPendingFreshMap[normalizedSku] ?? true;
              const isPendingSubmit =
                Boolean(skuHasSubmitLikeMap[normalizedSku]) &&
                (skuDateMap[normalizedSku] ?? "").trim() === "" &&
                isFreshPending &&
                !skuHasErrorOrDeleteMap[normalizedSku];
              // Never expose old row data while latest submit/overwrite is still processing.
              // BUT if the SKU exists in the dock, processing completed — always expose data.
              if (isPendingSubmit && skuRowMap[normalizedSku] === undefined) continue;

              const skuIdx = skuRowMap[normalizedSku];
              if (skuIdx === undefined) continue;
              const headerRow = allRows[skuIdx - 1] ?? [];
              const productRow = allRows[skuIdx] ?? [];
              const emailRow = allRows[skuIdx + 1] ?? [];
              const headers = headerRow.map((h: string) => (h ?? "").toString().trim());
              if (headers.length === 0) continue;
              const skuColIdx = findCol(headers, ["Product Code/SKU", "Product ID", "SKU"]);
              if (skuColIdx === -1) continue;
              const rowSku = normalizeSkuForCompare(productRow[skuColIdx]);
              if (rowSku && rowSku !== normalizedSku) continue;
              readableDockSkuSet.add(normalizedSku);

              const getByAlias = (aliases: string[], row: string[] = productRow): string => {
                const idx = findCol(headers, aliases);
                return idx !== -1 ? (row[idx] ?? "").toString() : "";
              };

              const title = getByAlias(["Product Name", "Name", "Title"]);
              if (title.trim()) {
                titleMap[sku] = title.trim();
              }
              const brand = getByAlias(["Brand Name", "Brand"]);
              const htmlDesc = getByAlias(["Product Description", "Description"]);
              const categoryRaw = getByAlias(["Category", "Categories"]);
              const cfRaw = getByAlias(["Product Custom Fields", "Custom Fields", "Specifications", "Filters", "Attributes"]);
              const emailNotes = getByAlias(["Product Description", "Description"], emailRow);

              let chatgptDescription = "";
              let chatgptData = "";
              const parsed = parseHtmlDescriptionBack(htmlDesc);
              chatgptDescription = parsed.description;
              chatgptData = parsed.specData;
              if (!chatgptDescription && !chatgptData) {
                chatgptDescription = htmlDesc.replace(/<[^>]*>/g, "").trim();
              }

              const allCategories = categoryRaw.split(/;\s*/).map((c: string) => c.trim()).filter(Boolean);
              const imageUrls: string[] = [];
              for (let n = 1; n <= 20; n++) {
                const aliases = [`product image file - ${n}`, `image file - ${n}`, `image url - ${n}`];
                const idx = findCol(headers, aliases);
                if (idx !== -1) {
                  const url = (productRow[idx] ?? "").toString().trim();
                  if (url) imageUrls.push(url);
                }
              }
              const specValues = cfRaw.trim() ? parseOrderedCustomFieldSpecValues(cfRaw) : {};
              const price = getByAlias(["Price"]) || getByAlias(["Sale Price"]);
              const costPrice = getByAlias(["Retail Price"]) || getByAlias(["Cost Price"]) || getByAlias(["RRP"]);
              const gpsMpn = getByAlias(["GPS Manufacturer Part Number", "Manufacturer Part Number", "MPN"]);

              formDataMap[sku] = {
                sku,
                brand: brand.trim(),
                title: title.trim(),
                mainCategory: allCategories[0] ?? "",
                selectedCategories: allCategories,
                imageUrls: imageUrls.length > 0 ? imageUrls : [""],
                chatgptData,
                chatgptDescription,
                emailNotes,
                specValues,
                price: price || "",
                costPrice: costPrice || "",
                gpsMpn: gpsMpn || "",
              };
            }

            const entries = skuList.map((sku) => {
              const nSku = normalizeSkuForCompare(sku);
              let processedAt = skuDateMap[nSku] || "";
              const hasUnreadableDockRow = skuRowMap[nSku] !== undefined && !readableDockSkuSet.has(nSku);
              if (hasUnreadableDockRow) processedAt = "";
              // If the SKU exists in the dock but processedAt is empty
              // (stale Events row), treat it as completed so the frontend
              // doesn't grey it out or trigger rapid polling.
              // BUT: never self-heal when the latest SUBMIT is a fresh pending one —
              // the SKU may already be in the dock from a previous submit, and the
              // new submit (e.g. override) needs to show as "Processing".
              const hasFreshPendingSubmit =
                Boolean(skuHasSubmitLikeMap[nSku]) &&
                (skuPendingFreshMap[nSku] ?? false) &&
                !skuHasErrorOrDeleteMap[nSku];
              if (!processedAt && skuRowMap[nSku] !== undefined && !hasUnreadableDockRow && !hasFreshPendingSubmit) {
                processedAt = skuTimestampMap[nSku] || new Date().toISOString();
              }
              return {
                id: sku,
                sku,
                processedAt,
                submittedAt: skuTimestampMap[nSku] || "",
                pendingActionType: pendingDockActionsBySku[nSku],
              };
            });

            const errors: Record<string, string> = {};
            for (const [normalizedSku, errorMessage] of Object.entries(skuLatestErrorMap)) {
              const trimmedError = errorMessage.trim();
              if (!trimmedError) continue;

              // Self-heal legacy false-failure rows: if the SKU is already readable in
              // Loading Dock, suppress this specific stale OUTPUT_Work miss error.
              if (
                /no sku found in output_work/i.test(trimmedError) &&
                readableDockSkuSet.has(normalizedSku)
              ) {
                continue;
              }

              const displaySku = skuDisplayMap[normalizedSku] || normalizedSku;
              errors[displaySku] = trimmedError;
            }

            const debugReasonsBySku: Record<string, string> = {};
            for (const sku of skuList) {
              const normalizedSku = normalizeSkuForCompare(sku);
              const hasDockRow = skuRowMap[normalizedSku] !== undefined;
              const readableDockRow = readableDockSkuSet.has(normalizedSku);
              const hasSubmitLike = Boolean(skuHasSubmitLikeMap[normalizedSku]);
              const latestProcessedAt = (skuDateMap[normalizedSku] ?? "").trim();
              const hasErrorOrDelete = Boolean(skuHasErrorOrDeleteMap[normalizedSku]);
              const hasGlobalPending = nextGlobalPendingEntries.some(
                (entry) => normalizeSkuForCompare(entry.sku) === normalizedSku,
              );

              if (hasErrorOrDelete) {
                debugReasonsBySku[sku] = "error-or-delete-event";
              } else if (hasDockRow && !readableDockRow) {
                debugReasonsBySku[sku] = "dock-row-unreadable-block";
              } else if (!hasDockRow && hasSubmitLike && !latestProcessedAt) {
                debugReasonsBySku[sku] = hasGlobalPending ? "pending-global-no-dock-row" : "pending-event-no-dock-row";
              } else if (hasDockRow && readableDockRow && latestProcessedAt) {
                debugReasonsBySku[sku] = "ready-readable-dock";
              } else if (!hasDockRow && latestProcessedAt) {
                debugReasonsBySku[sku] = "completed-event-no-dock-row";
              } else {
                debugReasonsBySku[sku] = "unknown-state";
              }
            }

            return { entries, formDataMap, titleMap, errors, debugReasonsBySku };
          })();
        }

        // Race the inflight fetch against a stale-serve timeout.
        // If Google Sheets is slow (>8s), serve from DB cache immediately
        // while the background fetch continues to update caches for next request.
        const STALE_SERVE = Symbol("stale-serve");
        const raceResult = await Promise.race([
          _dockEntriesInflight.then((r) => ({ type: "fresh" as const, data: r })),
          new Promise<{ type: typeof STALE_SERVE }>((resolve) =>
            setTimeout(() => resolve({ type: STALE_SERVE }), DOCK_FETCH_STALE_SERVE_TIMEOUT_MS)
          ),
        ]);

        if (raceResult.type === STALE_SERVE) {
          // Google is slow — serve stale data NOW, let background fetch update caches
          _dockEntriesInflight?.then((freshResult) => {
            _dockEntriesCache = {
              entries: freshResult.entries,
              formDataMap: freshResult.formDataMap,
              titleMap: freshResult.titleMap,
              errors: freshResult.errors,
              debugReasonsBySku: freshResult.debugReasonsBySku,
              ts: Date.now(),
            };
            _dockEntriesInflight = null;
            writeCache(getCacheKey(action, body), {
              entries: freshResult.entries,
              formDataMap: freshResult.formDataMap,
              titleMap: freshResult.titleMap,
              errors: freshResult.errors,
              debugReasonsBySku: freshResult.debugReasonsBySku,
            }).catch(() => {});
          }).catch(() => { _dockEntriesInflight = null; });

          // Try in-memory cache first, then DB cache
          if (_dockEntriesCache) {
            return new Response(JSON.stringify({
              entries: _dockEntriesCache.entries,
              formDataMap: includeFormDataMap ? _dockEntriesCache.formDataMap : undefined,
              titleMap: includeTitleMap ? _dockEntriesCache.titleMap : undefined,
              errors: _dockEntriesCache.errors,
              debugReasonsBySku: includeDebug ? _dockEntriesCache.debugReasonsBySku : undefined,
              stale: true,
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          const dbCachedStale = await readCache(getCacheKey(action, body));
          if (dbCachedStale && typeof dbCachedStale === "object" && "entries" in (dbCachedStale as any)) {
            const cachedRecord = dbCachedStale as Record<string, unknown>;
            return new Response(JSON.stringify({
              ...cachedRecord,
              formDataMap: includeFormDataMap ? cachedRecord.formDataMap : undefined,
              titleMap: includeTitleMap ? cachedRecord.titleMap : undefined,
              debugReasonsBySku: includeDebug ? cachedRecord.debugReasonsBySku : undefined,
              stale: true,
              cached: true,
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          // No cache at all — return empty stale
          return new Response(JSON.stringify({
            entries: [],
            stale: true,
            degraded: true,
            error: "Loading Dock data is still loading — will update shortly",
          }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const result = raceResult.data;
        _dockEntriesInflight = null;
        _dockEntriesCache = {
          entries: result.entries,
          formDataMap: result.formDataMap,
          titleMap: result.titleMap,
          errors: result.errors,
          debugReasonsBySku: result.debugReasonsBySku,
          ts: Date.now(),
        };
        writeCache(getCacheKey(action, body), {
          entries: result.entries,
          formDataMap: result.formDataMap,
          titleMap: result.titleMap,
          errors: result.errors,
          debugReasonsBySku: result.debugReasonsBySku,
        }).catch(() => {});

        return new Response(JSON.stringify({
          entries: result.entries,
          formDataMap: includeFormDataMap ? result.formDataMap : undefined,
          titleMap: includeTitleMap ? result.titleMap : undefined,
          errors: result.errors,
          debugReasonsBySku: includeDebug ? result.debugReasonsBySku : undefined,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Could not fetch dock entries:", err && ((err as any).stack || (err as any).message || err));
        if (_dockEntriesCache) {
          return new Response(JSON.stringify({
            entries: _dockEntriesCache.entries,
            formDataMap: includeFormDataMap ? _dockEntriesCache.formDataMap : undefined,
            titleMap: includeTitleMap ? _dockEntriesCache.titleMap : undefined,
            errors: _dockEntriesCache.errors,
            debugReasonsBySku: includeDebug ? _dockEntriesCache.debugReasonsBySku : undefined,
            stale: true,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const dbCached = await readCache(getCacheKey(action, body));
        if (dbCached && typeof dbCached === "object" && "entries" in (dbCached as any)) {
          const cachedRecord = dbCached as Record<string, unknown>;
          return new Response(JSON.stringify({
            ...cachedRecord,
            formDataMap: includeFormDataMap ? cachedRecord.formDataMap : undefined,
            titleMap: includeTitleMap ? cachedRecord.titleMap : undefined,
            debugReasonsBySku: includeDebug ? cachedRecord.debugReasonsBySku : undefined,
            stale: true,
            cached: true,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          entries: [],
          stale: true,
          degraded: true,
          error: "Failed to fetch Loading Dock entries",
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } finally {
        _dockEntriesInflight = null;
      }
    }

    if (action === "clear-dock-failures") {
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
      const skusRaw = (body.skus ?? []) as unknown;
      const skus = Array.isArray(skusRaw) ? skusRaw.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
      if (skus.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "skus[] is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const eventRows = await getSheetValues(accessToken, sheetId, `${eventsTab}!A:G`);
      const targetSet = new Set(skus.map(normalizeSkuForCompare).filter(Boolean));

      const updates: BatchValueUpdate[] = [];
      const cleared: string[] = [];
      const skipped: string[] = [];

      // Walk bottom-up so we clear the latest error-bearing row per SKU.
      // Must match ALL event types that getLatestDockErrorMessageForSku detects,
      // otherwise the UI shows "Failed" but Clear Failed can't find the row.
      const remaining = new Set(targetSet);
      for (let i = eventRows.length - 1; i >= 1 && remaining.size > 0; i--) {
        const row = eventRows[i] ?? [];
        const skuNorm = normalizeSkuForCompare(row[3] ?? "");
        const errorMsg = (row[6] ?? "").toString().trim();
        if (!skuNorm || !remaining.has(skuNorm)) continue;
        if (!errorMsg) continue;
        // Accept ANY event type with an error in column G — mirrors getLatestDockErrorMessageForSku

        // Column G = error message. Clear ONLY the error (keep timestamps/audit rows intact).
        const rowNumber = i + 1; // 1-indexed sheet row
        updates.push({ range: `${eventsTab}!G${rowNumber}`, values: [[""]] });
        remaining.delete(skuNorm);
        cleared.push(skuNorm);
      }

      for (const skuNorm of remaining) skipped.push(skuNorm);

      await batchUpdateSheetValues(accessToken, sheetId, updates);

      // Drop cached dock entries so next poll reflects cleared errors immediately.
      _dockEntriesCache = null;
      _dockEntriesInflight = null;

      return new Response(JSON.stringify({ success: true, cleared, skipped, updated: updates.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "read-dock-email") {
      const { sku } = body;
      if (typeof sku !== "string" || !sku.trim()) {
        return new Response(JSON.stringify({ error: "Invalid SKU" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cacheKey = getCacheKey(action, body);
      const submittedAtHint = getSubmittedAtHint(body);
      try {
        const dockTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
        const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
        const trimmedSku = sku.trim();
        let latestSubmittedAt = "";

        if (submittedAtHint) {
          const eventRows = await withReadTimeout(
            readRecentEventRowsForSku(accessToken, sheetId, eventsTab, trimmedSku),
          );
          const validation = validateSubmittedAtHintForSku(eventRows, trimmedSku, submittedAtHint);
          latestSubmittedAt = validation.latestSubmittedAt;

          if (validation.state === "pending") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `Product ${trimmedSku} is still being processed in the background queue. Please wait a few seconds and try again.`,
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          if (validation.state === "changed") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `SKU "${trimmedSku}" has newer Loading Dock data. Refresh and try again.`,
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }

        // Read-only: skip redundant pending check (guard already verified).
        const dockBlock = await withReadTimeout(readReadableLoadingDockBlockForSku(accessToken, sheetId, dockTab, trimmedSku));

        if (!dockBlock) {
          return new Response(JSON.stringify({ success: false, error: `SKU "${trimmedSku}" not found in Loading Dock` }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const emailColIdx = findCol(dockBlock.headers, ["Product Description", "Description"]);
        const emailContent = emailColIdx !== -1 ? (dockBlock.emailRow[emailColIdx] ?? "").toString() : "";
        const emailRowNumber = dockBlock.skuRowIdx + 2;
        const result = {
          success: true,
          email: emailContent,
          row: emailRowNumber,
          submittedAt: latestSubmittedAt || submittedAtHint || undefined,
        };
        writeCache(cacheKey, result).catch(() => {});
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        console.warn("read-dock-email failed, trying cache:", err);
        if (!submittedAtHint) {
          const cached = await readCache(cacheKey);
          if (cached) {
            return new Response(JSON.stringify({ ...(cached as Record<string, unknown>), cached: true }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        throw err;
      }
    }

    if (action === "save-dock-email") {
      // Writes new email content to column J of the Email row for the given SKU.
      const { sku, emailContent } = body;
      if (typeof sku !== "string" || !sku.trim()) {
        return new Response(JSON.stringify({ error: "Invalid SKU" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (typeof emailContent !== "string") {
        return new Response(JSON.stringify({ error: "Invalid emailContent" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const dockTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
      const trimmedSku = sku.trim();
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
      const submittedAtHint = getSubmittedAtHint(body);
      const [dockBlock, eventRows] = await Promise.all([
        readReadableLoadingDockBlockForSku(accessToken, sheetId, dockTab, trimmedSku),
        readRecentEventRowsForSku(accessToken, sheetId, eventsTab, trimmedSku),
      ]);
      const validation = validateSubmittedAtHintForSku(eventRows, trimmedSku, submittedAtHint);
      if (validation.state === "pending") {
        return new Response(JSON.stringify({
          success: false,
          pending: true,
          error: `SKU "${trimmedSku}" is still processing the latest submission.`,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (validation.state === "changed") {
        return new Response(JSON.stringify({
          success: false,
          error: `SKU "${trimmedSku}" has newer Loading Dock data. Refresh and try again.`,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!dockBlock) {
        return new Response(JSON.stringify({ success: false, error: `SKU "${trimmedSku}" not found in Loading Dock` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const emailColIdx = findCol(dockBlock.headers, ["Product Description", "Description"]);
      if (emailColIdx === -1) {
        return new Response(JSON.stringify({ success: false, error: "Could not locate email column in Loading Dock" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const emailColLetter = toColumnLetter(emailColIdx + 1);
      const emailRowNumber = dockBlock.skuRowIdx + 2; // 1-indexed
      await updateSheetCell(accessToken, sheetId, dockTab, emailRowNumber, emailColLetter, emailContent);
      const effectiveSubmittedAt = validation.latestSubmittedAt || submittedAtHint || "";
      _dockEntriesCache = null;
      _dockEntriesInflight = null;
      await deleteCaches([
        "fetch-dock-entries",
        `read-dock-email:${trimmedSku}`,
        `read-output-work:${trimmedSku}`,
        effectiveSubmittedAt ? `read-dock-email:${trimmedSku}:${effectiveSubmittedAt}` : null,
        effectiveSubmittedAt ? `read-output-work:${trimmedSku}:${effectiveSubmittedAt}` : null,
      ]);
      console.log(`Email saved for SKU ${trimmedSku} at row ${emailRowNumber}`);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "read-sku-details") {
      const trimmedSku = String(body.sku ?? "").trim();
      const normalizedSku = normalizeSkuForCompare(trimmedSku);
      if (!normalizedSku) {
        return new Response(JSON.stringify({ success: false, error: "Invalid SKU" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const productsTodoTab = resolveTabName(tabNames, "PRODUCTS_TODO", "Products To Do");
      const productsMainTab = resolveTabName(tabNames, "PRODUCTS", "Products");
      const brandsTab = resolveTabName(tabNames, "BRANDS", "Brands");
      const [productsMainRaw, productsTodoRaw, brandsRaw] = await Promise.all([
        getSheetValues(accessToken, sheetId, `${productsMainTab}!A:D`),
        getSheetValues(accessToken, sheetId, `${productsTodoTab}!A:B`),
        getSheetValues(accessToken, sheetId, `${brandsTab}!A:B`),
      ]);
      const brandNameMap = buildBrandNameMap(brandsRaw);

      let brand = "";
      let price = "";
      let visibility = "";
      let found = false;

      for (let i = 1; i < productsMainRaw.length; i++) {
        const row = productsMainRaw[i];
        if (normalizeSkuForCompare(row[0] ?? "") !== normalizedSku) continue;
        brand = resolveBrandName(row[1], brandNameMap);
        price = (row[2] ?? "").toString().trim();
        visibility = (row[3] ?? "").toString().trim();
        found = true;
        break;
      }

      if (!brand) {
        for (let i = 1; i < productsTodoRaw.length; i++) {
          const row = productsTodoRaw[i];
          if (normalizeSkuForCompare(row[0] ?? "") !== normalizedSku) continue;
          brand = resolveBrandName(row[1], brandNameMap);
          found = true;
          break;
        }
      }

      if (!found) {
        return new Response(JSON.stringify({ success: false, error: `SKU "${trimmedSku}" was not found` }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ success: true, brand, price, visibility }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "read-output-work") {
      const { sku } = body;
      if (typeof sku !== "string" || !sku.trim()) {
        return new Response(JSON.stringify({ error: "Invalid SKU" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cacheKey = getCacheKey(action, body);
      const submittedAtHint = getSubmittedAtHint(body);
      try {
        const trimmedSku = sku.trim();
        const dockTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
        const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
        let latestSubmittedAt = "";

        if (submittedAtHint) {
          const eventRows = await withReadTimeout(
            readRecentEventRowsForSku(accessToken, sheetId, eventsTab, trimmedSku),
          );
          const validation = validateSubmittedAtHintForSku(eventRows, trimmedSku, submittedAtHint);
          latestSubmittedAt = validation.latestSubmittedAt;

          if (validation.state === "pending") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `Product ${trimmedSku} is still being processed in the background queue. Please wait a few seconds and try again.`,
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          if (validation.state === "changed") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `SKU "${trimmedSku}" has newer Loading Dock data. Refresh and try again.`,
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }

        const dockBlock = await withReadTimeout(readReadableLoadingDockBlockForSku(accessToken, sheetId, dockTab, trimmedSku));
        if (!dockBlock) {
          return new Response(JSON.stringify({ success: false, error: `SKU "${trimmedSku}" not found in Loading Dock` }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const headers = dockBlock.headers;
        const productRow = dockBlock.productRow;
        const emailRow = dockBlock.emailRow;

        if (headers.length === 0) {
          return new Response(JSON.stringify({ error: "No headers found in Loading Dock block" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const getByAlias = (aliases: string[], row: string[] = productRow): string => {
          const idx = findCol(headers, aliases);
          return idx !== -1 ? (row[idx] ?? "").toString() : "";
        };

        const title       = getByAlias(["Product Name", "Name", "Title"]);
        const brand       = getByAlias(["Brand Name", "Brand"]);
        const htmlDesc    = getByAlias(["Product Description", "Description"]);
        const categoryRaw = getByAlias(["Category", "Categories"]);
        const cfRaw       = getByAlias([
          "Product Custom Fields",
          "Custom Fields",
          "Specifications",
          "Filters",
          "Attributes",
        ]);
        const emailNotes  = getByAlias(["Product Description", "Description"], emailRow);

        let chatgptDescription = "";
        let chatgptData = "";
        const parsed = parseHtmlDescriptionBack(htmlDesc);
        chatgptDescription = parsed.description;
        chatgptData = parsed.specData;
        if (!chatgptDescription && !chatgptData) {
          chatgptDescription = htmlDesc.replace(/<[^>]*>/g, "").trim();
        }

        const allCategories = categoryRaw.split(/;\s*/).map((c: string) => c.trim()).filter(Boolean);
        const mainCategory  = allCategories[0] ?? "";

        const imageUrls: string[] = [];
        for (let n = 1; n <= 20; n++) {
          const aliases = [`product image file - ${n}`, `image file - ${n}`, `image url - ${n}`];
          const idx = findCol(headers, aliases);
          if (idx !== -1) {
            const url = (productRow[idx] ?? "").toString().trim();
            if (url) imageUrls.push(url);
          }
        }

        const specValues = cfRaw.trim() ? parseOrderedCustomFieldSpecValues(cfRaw) : {};

        const price     = getByAlias(["Price"]) || getByAlias(["Sale Price"]);
        const costPrice = getByAlias(["Retail Price"]) || getByAlias(["Cost Price"]) || getByAlias(["RRP"]);
        const gpsMpn    = getByAlias(["GPS Manufacturer Part Number", "Manufacturer Part Number", "MPN"]);

        const responseData = {
          success: true,
          submittedAt: latestSubmittedAt || submittedAtHint || undefined,
          formData: {
            sku: trimmedSku,
            brand: brand.trim(),
            title: title.trim(),
            mainCategory,
            selectedCategories: allCategories,
            imageUrls: imageUrls.length > 0 ? imageUrls : [""],
            chatgptData,
            chatgptDescription,
            emailNotes,
            specValues,
            price: price || "",
            costPrice: costPrice || "",
            gpsMpn: gpsMpn || "",
          },
        };
        writeCache(cacheKey, responseData).catch(() => {});
        return new Response(JSON.stringify(responseData), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        console.warn("read-output-work failed, trying cache:", err);
        if (!submittedAtHint) {
          const cached = await readCache(cacheKey);
          if (cached) {
            return new Response(JSON.stringify({ ...(cached as Record<string, unknown>), cached: true, stale: true }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        throw err;
      }
    }
    // ── upload-csv: Parse a 2-row CSV and write directly to OUTPUT_Work ──────
    if (action === "upload-csv") {
      const { csvText } = body as Record<string, any>;
      if (typeof csvText !== "string" || !csvText.trim()) {
        return new Response(JSON.stringify({ error: "csvText is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Parse CSV rows (handles quoted fields with commas inside)
      function parseCsvLine(line: string): string[] {
        const result: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let ci = 0; ci < line.length; ci++) {
          const ch = line[ci];
          if (ch === '"') {
            if (inQuotes && line[ci + 1] === '"') { current += '"'; ci++; }
            else { inQuotes = !inQuotes; }
          } else if (ch === "," && !inQuotes) {
            result.push(current); current = "";
          } else {
            current += ch;
          }
        }
        result.push(current);
        return result;
      }

      // Split CSV into logical rows respecting quoted fields (which may contain newlines)
      function splitCsvRows(text: string): string[] {
        const rows: string[] = [];
        let current = "";
        let inQuotes = false;
        const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        for (let i = 0; i < normalized.length; i++) {
          const ch = normalized[i];
          if (ch === '"') {
            inQuotes = !inQuotes;
            current += ch;
          } else if (ch === "\n" && !inQuotes) {
            if (current.trim()) rows.push(current);
            current = "";
          } else {
            current += ch;
          }
        }
        if (current.trim()) rows.push(current);
        return rows;
      }

      const lines = splitCsvRows(csvText);
      if (lines.length < 2) {
        return new Response(JSON.stringify({ error: "CSV must have at least 2 rows (header + data)" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const normalizeHeaderName = (raw: string): string =>
        (raw ?? "")
          .toString()
          .replace(/^\uFEFF/, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
          .replace(/[.,;:]+$/g, "");

      const csvHeaders = parseCsvLine(lines[0]).map((h) => (h ?? "").toString().replace(/^\uFEFF/, "").trim());
      const csvDataRow = parseCsvLine(lines[1]);

      // Build a map from CSV header → value
      const csvMap: Record<string, string> = {};
      const csvMapNormalized = new Map<string, string>();
      csvHeaders.forEach((h, i) => {
        const key = (h ?? "").trim();
        const value = (csvDataRow[i] ?? "").toString().trim();
        if (key) {
          csvMap[key] = value;
          const normalized = normalizeHeaderName(key);
          if (normalized && !csvMapNormalized.has(normalized)) {
            csvMapNormalized.set(normalized, value);
          }
        }
      });

      const getCsvByAlias = (aliases: string[]): string => {
        for (const alias of aliases) {
          const exact = csvMap[alias];
          if (exact !== undefined && exact !== "") return exact;
          const normalized = csvMapNormalized.get(normalizeHeaderName(alias));
          if (normalized !== undefined && normalized !== "") return normalized;
        }
        return "";
      };

      // Find the SKU from common CSV column names
      const csvSku = getCsvByAlias(["Product Code/SKU", "Product ID", "SKU"]);
      if (!csvSku) {
        return new Response(JSON.stringify({ error: "This CSV does not match the required template. Include a Product Code/SKU (or Product ID/SKU) column with a value." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const outputWorkTab = resolveTabName(tabNames, "OUTPUT_WORK", "OUTPUT_Work");
      const outputTemplateTab = resolveTabName(tabNames, "OUTPUT_TEMPLATE", "OUTPUT_Template");
      const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
      const productsToDoTab = resolveTabName(tabNames, "PRODUCTS_TODO", "PRODUCTS TO DO");
      const productsTab = resolveTabName(tabNames, "PRODUCTS", "Products");
      const dockTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
      const trimmedCsvSku = csvSku.trim();

      // Fast pre-check: reject duplicates before lock/cooldown/template work.
      try {
        const dockColE = await getSheetValues(accessToken, sheetId, `${dockTab}!E:E`);
        if (findLoadingDockSkuRowIndex(dockColE, trimmedCsvSku) !== -1) {
          return new Response(JSON.stringify({ success: false, error: `SKU "${trimmedCsvSku}" is already in the Loading Dock` }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      } catch (err) {
        console.warn("Could not run pre-upload duplicate check (continuing):", err);
      }

      let outputWorkLock: OutputWorkLockHandle | null = null;
      try {
        // Step 1: wait for the prior event to fully settle, then enter the single-writer window.
        outputWorkLock = await enterOutputWorkSubmissionWindow(accessToken, sheetId, eventsTab);

        const [productsRows, statusRows, dockRows] = await Promise.all([
          getSheetValuesStrict(accessToken, sheetId, `${productsTab}!A:D`),
          getSheetValuesStrict(accessToken, sheetId, `${productsToDoTab}!A:C`),
          getSheetValuesFromTabCandidates(accessToken, sheetId, [dockTab, "Loading Dock", "LOADING_DOCK", "LoadingDock"], "A:ZZ"),
        ]);

      if (findReadableLoadingDockBlock(dockRows, trimmedCsvSku)) {
        return new Response(JSON.stringify({ success: false, error: `SKU "${trimmedCsvSku}" is already in the Loading Dock` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Step 2: reset OUTPUT_Work and seed fresh rows from the template before filling them.
      const outputWorkLayout = await resetOutputWorkFromTemplate(
        accessToken,
        sheetId,
        outputWorkTab,
        outputTemplateTab,
      );
      const stagedRows = buildOutputWorkSeedRows(outputWorkLayout);
      const workHeaders = stagedRows.headers;
      const productRow = stagedRows.productRow;
      const emailRow = stagedRows.emailRow;

      // Find the SKU row in PRODUCTS TO DO (col A = SKU, col C = Status) to reset status to TO_DO on upload
      let todoRowNum = -1;
      for (let i = 1; i < statusRows.length; i++) {
        if (normalizeSkuForCompare(statusRows[i]?.[0] ?? "") === normalizeSkuForCompare(trimmedCsvSku)) {
          todoRowNum = i + 1;
          break;
        }
      }

      const colMap: Record<string, number> = {};
      workHeaders.forEach((h: string, i: number) => { if (h) colMap[h] = i; });
      const normalizedColMap = new Map<string, number>();
      workHeaders.forEach((h: string, i: number) => {
        const normalized = normalizeHeaderName(h);
        if (normalized && !normalizedColMap.has(normalized)) normalizedColMap.set(normalized, i);
      });

      const setWCol = (header: string, value: string) => {
        if (colMap[header] !== undefined && value !== undefined) {
          productRow[colMap[header]] = sanitizeForFormulas(value);
        }
      };
      const setECol = (header: string, value: string) => {
        if (colMap[header] !== undefined && value !== undefined) {
          emailRow[colMap[header]] = sanitizeForFormulas(value);
        }
      };

      // Map every CSV column directly to OUTPUT_Work by matching header names exactly,
      // then handle special columns that need extra logic.
      // First: direct 1-to-1 passthrough for all matched headers
      const mappedColumns = new Set<number>();
      csvHeaders.forEach((csvH: string) => {
        const key = (csvH ?? "").trim();
        const val = csvMap[key] ?? "";
        if (key && colMap[key] !== undefined) {
          const idx = colMap[key];
          productRow[idx] = sanitizeForFormulas(val);
          mappedColumns.add(idx);
          return;
        }
        if (key) {
          const idx = normalizedColMap.get(normalizeHeaderName(key));
          if (idx !== undefined) {
            productRow[idx] = sanitizeForFormulas(val);
            mappedColumns.add(idx);
          }
        }
      });
      if (mappedColumns.size === 0) {
        return new Response(JSON.stringify({ error: "This CSV format is not supported for this template. Please export a 2-row product CSV and try again." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      for (let c = 0; c < workHeaders.length; c++) {
        const headerName = (workHeaders[c] ?? "").toString();
        const normalizedHeader = normalizeHeaderName(headerName);
        if (normalizedHeader === "productdescription" || normalizedHeader === "description") {
          productRow[c] = normalizeProductDescriptionCell(productRow[c] || "");
          continue;
        }
        if (isSemicolonListHeader(headerName)) {
          productRow[c] = normalizeSemicolonListCellForOutput(headerName, productRow[c] || "");
          continue;
        }
        productRow[c] = normalizeDimensionFilterValueForStorage(headerName, productRow[c] || "");
      }

      const csvCategory = getCsvByAlias(["Category"]);
      if (csvCategory !== "") {
        setWCol("Category", normalizeSemicolonListCellForOutput("Category", csvCategory));
      }
      const csvGpsCategory = getCsvByAlias(["GPS Category"]);
      if (csvGpsCategory !== "") {
        setWCol("GPS Category", normalizeSemicolonListCellForOutput("GPS Category", csvGpsCategory));
      }

      // Visibility always from Products tab col D (source-of-truth). CSV's own Product Visible? is ignored.
      // Visibility changes must be made through Product Options only.
      let resolvedVisible = "N";
      for (let i = 1; i < productsRows.length; i++) {
        if (normalizeSkuForCompare(productsRows[i]?.[0] ?? "") === normalizeSkuForCompare(trimmedCsvSku)) {
          const vis = (productsRows[i]?.[3] ?? "").toString().trim();
          resolvedVisible = vis === "1" ? "Y" : "N";
          break;
        }
      }
      setWCol("Product Visible?", resolvedVisible);

      // Images: find all "Product Image File - N" and related columns from CSV
      // (already mapped by passthrough above, but ensure sort/thumbnail are consistent)
      let maxImageIdx = 0;
      for (let n = 1; n <= 20; n++) {
        const fileHeader = `Product Image File - ${n}`;
        const fileValue = getCsvByAlias([fileHeader]);
        if (fileValue && fileValue.trim()) maxImageIdx = n;
      }
      const keepMax = Math.max(8, maxImageIdx);
      for (let n = 1; n <= keepMax; n++) {
        const fileHeader = `Product Image File - ${n}`;
        const thumbHeader = `Product Image Is Thumbnail - ${n}`;
        const sortHeader = `Product Image Sort - ${n}`;
        const idHeader = `Product Image ID - ${n}`;
        const fileValue = getCsvByAlias([fileHeader]);
        const thumbValue = getCsvByAlias([thumbHeader]);
        const sortValue = getCsvByAlias([sortHeader]);
        const idValue = getCsvByAlias([idHeader]);
        // Only set if not already set by passthrough
        if (fileValue !== "") setWCol(fileHeader, fileValue);
        if (thumbValue !== "") setWCol(thumbHeader, thumbValue);
        else setWCol(thumbHeader, n === 1 ? "Y" : "N");
        if (sortValue !== "") setWCol(sortHeader, sortValue);
        else setWCol(sortHeader, String(n - 1));
        if (idValue !== "") setWCol(idHeader, idValue);
      }

      // Email row: Option Set Align = "Email:", Product Description = email notes column if present
      const emailNotes = getCsvByAlias(["Email Notes", "Notes for Email Body"]);
      setECol("Option Set Align", "Email:");
      setECol("Product Description", emailNotes);

      let reservedMpn = extractNumericMpnFromValue(
        getCsvByAlias(["GPS Manufacturer Part Number", "Manufacturer Part Number", "MPN"]),
      );
      if (!reservedMpn) {
        reservedMpn = await reserveNextWebMpn(accessToken, sheetId, eventsTab, trimmedCsvSku);
      }
      setWCol("GPS Manufacturer Part Number", String(reservedMpn));
      setWCol("Search Keywords", `${reservedMpn},${reservedMpn}-L`);

      // Prepare UPLOAD event payload
      const uploadEventEpochMs = Date.now();
      const melbourneTime = melbourneTimestamp();
      const eventId = `EVT-${uploadEventEpochMs}`;
      const eventRow = [melbourneTime, eventId, "UPLOAD", trimmedCsvSku, String(reservedMpn), "", ""];
      // Step 3: stage OUTPUT_Work, append the exact event row, and register global pending.
      const stagedEvent = await stageSubmissionEvent({
        token: accessToken,
        sheetId,
        outputWorkTab,
        outputTemplateTab,
        eventsTab,
        sku: trimmedCsvSku,
        eventRow,
        eventEpochMs: uploadEventEpochMs,
        isOverwrite: false,
        stagedRows,
        postEventTasks: todoRowNum !== -1
          ? [() => updateSheetCell(accessToken, sheetId, productsToDoTab, todoRowNum, "C", "TO_DO")]
          : undefined,
      });

      console.log(`CSV upload: SKU ${trimmedCsvSku} written to OUTPUT_Work, UPLOAD event logged (MPN ${reservedMpn}), status→TO_DO.`);
      await releaseOutputWorkLock(outputWorkLock);
      outputWorkLock = null;
      // Step 4: once the event is durably logged, write Loading Dock directly,
      // reset OUTPUT_Work back to template, then mark Processed_At.
      const completion = await completeSubmissionDirectly({
        token: accessToken,
        sheetId,
        eventsTab,
        dockTab,
        outputWorkTab,
        outputTemplateTab,
        sku: trimmedCsvSku,
        expectedMpn: reservedMpn,
        isOverwrite: false,
        stagedRows,
        eventRowNumber: stagedEvent.eventRowNumber,
        eventEpochMs: uploadEventEpochMs,
        previousSubmissionEpochMs: null,
      });

      if (completion.success && !completion.pending) {
        return new Response(JSON.stringify({
          success: true,
          sku: trimmedCsvSku,
          processedAt: completion.processedAt,
          submittedAtEpochMs: uploadEventEpochMs,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (completion.pending) {
        return new Response(JSON.stringify({
          success: true,
          sku: trimmedCsvSku,
          pending: true,
          reason: completion.reason,
          submittedAtEpochMs: uploadEventEpochMs,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ success: false, error: completion.error }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      } finally {
        await releaseOutputWorkLock(outputWorkLock);
      }
    }

    // ── download-csv: Return the header+product rows for a SKU as CSV text ──
    if (action === "download-csv") {
      const { sku } = body as Record<string, any>;
      if (typeof sku !== "string" || !sku.trim()) {
        return new Response(JSON.stringify({ error: "Invalid SKU" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cacheKey = getCacheKey(action, body);
      const submittedAtHint = getSubmittedAtHint(body);
      try {
        const trimmedSku = (sku as string).trim();
        const dockTab = resolveTabName(tabNames, "LOADING_DOCK", "Loading Dock");
        const eventsTab = resolveTabName(tabNames, "EVENTS", "Events");
        let latestSubmittedAt = "";

        if (submittedAtHint) {
          const eventRows = await withReadTimeout(
            readRecentEventRowsForSku(accessToken, sheetId, eventsTab, trimmedSku),
          );
          const validation = validateSubmittedAtHintForSku(eventRows, trimmedSku, submittedAtHint);
          latestSubmittedAt = validation.latestSubmittedAt;

          if (validation.state === "pending") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `Product ${trimmedSku} is still being processed in the background queue. Please wait a few seconds and try again.`,
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          if (validation.state === "changed") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `SKU "${trimmedSku}" has newer Loading Dock data. Refresh and try again.`,
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }

        const dockBlock = await withReadTimeout(readReadableLoadingDockBlockForSku(accessToken, sheetId, dockTab, trimmedSku));
        if (!dockBlock) {
          return new Response(JSON.stringify({ success: false, error: `SKU "${trimmedSku}" not found in Loading Dock` }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const csvText = buildLoadingDockCsvText(
          dockBlock.headers,
          dockBlock.productRow,
          LOADING_DOCK_CSV_MAX_COLS,
        );

        const responseData = {
          success: true,
          csvText,
          sku: trimmedSku,
          submittedAt: latestSubmittedAt || submittedAtHint || undefined,
        };
        writeCache(cacheKey, responseData).catch(() => {});
        return new Response(JSON.stringify(responseData), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        console.warn("download-csv failed, trying cache:", err);
        if (!submittedAtHint) {
          const cached = await readCache(cacheKey);
          if (cached) {
            return new Response(JSON.stringify({ ...(cached as Record<string, unknown>), cached: true, stale: true }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        throw err;
      }
    }

    // ── AI Logging: write a row to AI_Logging tab with rich text diffs ──
    if (action === "write-ai-log") {
      const { logEntry } = body as { logEntry?: any };
      if (!logEntry || typeof logEntry !== "object") {
        return new Response(JSON.stringify({ error: "logEntry is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const aiLogTab = resolveTabName(tabNames, "AI_LOGGING", "AI_Logging");
      const sku = String(logEntry.sku || "").trim();
      const rawTs = logEntry.timestamp ? new Date(logEntry.timestamp) : new Date();
      const timestamp = melbourneTimestamp(rawTs);
      const replaceRowNumber = Number(logEntry.replaceRowNumber ?? 0);
      const shouldReplaceRow = Number.isFinite(replaceRowNumber) && replaceRowNumber > 1;

      if (!sku) {
        return new Response(JSON.stringify({ error: "logEntry.sku is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Build row values: SKU | Timestamp | AI-Data Gen | AI-Data Edit | AI-Desc Gen | AI-Desc Edit | Filters Gen | Filters Edit | Conflicts
      const rowValues = [
        sku,
        timestamp,
        logEntry.aiData?.generated || "",
        logEntry.aiData?.edited || "",
        logEntry.aiDescription?.generated || "",
        logEntry.aiDescription?.edited || "",
        logEntry.filters?.generated || "",
        logEntry.filters?.edited || "",
        logEntry.conflicts || "",
      ];

      // Ensure headers exist in row 1
      const AI_LOG_HEADERS = ["SKU", "Timestamp", "AI-Data (Generated)", "AI-Data (Edited)", "AI-Description (Generated)", "AI-Description (Edited)", "Filters (Generated)", "Filters (Edited)", "Conflicts"];
      try {
        const existingHeaders = await getSheetValues(accessToken, sheetId, `${aiLogTab}!A1:I1`);
        if (!existingHeaders || existingHeaders.length === 0 || !existingHeaders[0]?.[0]) {
          await writeSheetBlock(accessToken, sheetId, `${aiLogTab}!A1`, [AI_LOG_HEADERS]);
        }
      } catch {
        // Tab might not exist — try writing headers anyway, will fail if tab doesn't exist
        try {
          await writeSheetBlock(accessToken, sheetId, `${aiLogTab}!A1`, [AI_LOG_HEADERS]);
        } catch (headerErr) {
          return new Response(JSON.stringify({ error: `AI logging tab not found. Please create a tab named "${aiLogTab}" in your Google Sheet. Error: ${headerErr}` }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      let rowNumber: number | null = null;
      if (shouldReplaceRow) {
        await updateSheetRange(
          accessToken,
          sheetId,
          `${aiLogTab}!A${replaceRowNumber}:I${replaceRowNumber}`,
          [rowValues],
          { valueInputOption: "RAW" },
        );
        rowNumber = replaceRowNumber;
      } else {
        const appendResult = await appendRow(accessToken, sheetId, `${aiLogTab}!A:I`, rowValues, {
          valueInputOption: "RAW",
        });
        rowNumber = extractLastRowNumberFromUpdatedRange(appendResult.updatedRange);
      }

      // Apply formatting: black text for plain columns, rich text diffs for edited columns
      try {
        const tabId = await getSheetTabId(accessToken, sheetId, aiLogTab);
        // targetRow is 0-indexed in batchUpdate requests
        const targetRow = Math.max(1, Number(rowNumber ?? 2)) - 1;

        const requests: any[] = [];

        // Clip wrapping + black text for the entire row (A-I, columns 0-8)
        requests.push({
          repeatCell: {
            range: {
              sheetId: tabId,
              startRowIndex: targetRow,
              endRowIndex: targetRow + 1,
              startColumnIndex: 0,
              endColumnIndex: 9,
            },
            cell: {
              userEnteredFormat: {
                wrapStrategy: "CLIP",
                textFormat: {
                  foregroundColorStyle: { rgbColor: { red: 0, green: 0, blue: 0 } },
                  bold: false,
                  strikethrough: false,
                },
              },
            },
            fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.textFormat",
          },
        });

        // Wrap Filters + Conflicts columns: G (Generated), H (Edited), I (Conflicts)
        requests.push({
          repeatCell: {
            range: {
              sheetId: tabId,
              startRowIndex: targetRow,
              endRowIndex: targetRow + 1,
              startColumnIndex: 6,
              endColumnIndex: 9,
            },
            cell: {
              userEnteredFormat: {
                wrapStrategy: "WRAP",
              },
            },
            fields: "userEnteredFormat.wrapStrategy",
          },
        });

        // Rich text formatting for edited columns (D, F, H) if diff data is provided
        const diffs = logEntry.diffs as Record<string, Array<{ t: string; d: "u" | "a" | "r" }>> | undefined;
        if (diffs && Object.keys(diffs).length > 0) {
          // Map field names to column indices (0-indexed): aiData->3, aiDescription->5, filters->7
          const fieldColMap: Record<string, number> = {
            aiData: 3,
            aiDescription: 5,
            filters: 7,
          };

          for (const [field, diffTokens] of Object.entries(diffs)) {
            const colIdx = fieldColMap[field];
            if (colIdx === undefined || !diffTokens || diffTokens.length === 0) continue;

            // Build the full text and textFormatRuns
            let fullText = "";
            const formatRuns: Array<{ startIndex: number; format: any }> = [];
            let currentIdx = 0;

            for (const token of diffTokens) {
              const text = token.t;
              if (!text) continue;

              if (token.d === "a") {
                formatRuns.push({
                  startIndex: currentIdx,
                  format: {
                    foregroundColorStyle: { rgbColor: { red: 0, green: 0.6, blue: 0.1 } },
                    bold: true,
                  },
                });
              } else if (token.d === "r") {
                formatRuns.push({
                  startIndex: currentIdx,
                  format: {
                    foregroundColorStyle: { rgbColor: { red: 0.8, green: 0, blue: 0 } },
                    strikethrough: true,
                  },
                });
              } else {
                formatRuns.push({
                  startIndex: currentIdx,
                  format: {
                    foregroundColorStyle: { rgbColor: { red: 0, green: 0, blue: 0 } },
                    bold: false,
                    strikethrough: false,
                  },
                });
              }

              fullText += text;
              currentIdx += text.length;
            }

            if (fullText) {
              requests.push({
                updateCells: {
                  range: {
                    sheetId: tabId,
                    startRowIndex: targetRow,
                    endRowIndex: targetRow + 1,
                    startColumnIndex: colIdx,
                    endColumnIndex: colIdx + 1,
                  },
                  rows: [{
                    values: [{
                      userEnteredValue: { stringValue: fullText },
                      textFormatRuns: formatRuns,
                    }],
                  }],
                  fields: "userEnteredValue,textFormatRuns",
                },
              });
            }
          }
        }

        if (requests.length > 0) {
          const batchRes = await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ requests }),
            }
          );
          if (!batchRes.ok) {
            const errText = await batchRes.text();
            console.error("Rich text formatting failed (non-fatal):", errText);
          }
        }
      } catch (rtErr) {
        console.error("Cell formatting failed (non-fatal):", rtErr);
      }

      return new Response(JSON.stringify({ success: true, rowNumber: rowNumber ?? undefined }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    const errorRef = crypto.randomUUID();
    console.error("Edge function error:", { errorRef, error });
    // Last-resort: try DB cache for cacheable read actions
    try {
      const body2 = { action: "", ...({} as any) };
      // We can't easily re-parse the body here, but individual action handlers
      // already have their own cache fallbacks. This outer catch is for
      // failures that happen before reaching an action handler (e.g., auth errors).
    } catch { /* ignore */ }
    return new Response(
      JSON.stringify({ error: "Google Sheets request failed", error_ref: errorRef }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// --- Google Auth helpers ---

// getAccessToken, base64UrlEncodeUtf8, importPrivateKey, sign
// replaced by ../_shared/googleAuth.ts (getGoogleAccessToken)

// --- Column-matching helpers (shared across actions) ---

/** Normalize a column header for fuzzy matching: lowercase, strip diacritics + whitespace */
function normalizeColName(s: string): string {
  return s.toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[_\s]+/g, " ").trim();
}

/** Find a column index using exact → starts-with → contains matching against aliases. Returns -1 if not found. */
function findCol(hdrs: string[], aliases: string[]): number {
  const norm = hdrs.map((h) => normalizeColName(h));
  const normAliases = aliases.map(normalizeColName);
  for (const a of normAliases) { const i = norm.indexOf(a); if (i !== -1) return i; }
  for (const a of normAliases) { const i = norm.findIndex((h) => h.startsWith(a)); if (i !== -1) return i; }
  for (const a of normAliases) { const i = norm.findIndex((h) => h.includes(a)); if (i !== -1) return i; }
  return -1;
}

// --- Sheets API helpers ---

/**
 * Sanitize cell values to prevent formula injection.
 * Prepend single quote to values starting with =, +, -, @, or tab character.
 */
function sanitizeForFormulas(value: string): string {
  if (!value || typeof value !== "string") return value;
  const firstChar = value.charAt(0);
  if (firstChar === "=" || firstChar === "+" || firstChar === "-" || firstChar === "@" || firstChar === "\t") {
    return "'" + value;
  }
  return value;
}

function resolveTabName(
  tabNames: Record<string, string> | undefined,
  key: string,
  fallback: string
): string {
  const value = tabNames?.[key];
  return value && typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after") ?? res.headers.get("Retry-After");
  if (!raw) return null;
  const secs = Number.parseInt(raw, 10);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SheetReadRenderOption = "formatted" | "unformatted";

function buildSheetValuesUrl(sheetId: string, range: string, render: SheetReadRenderOption): string {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`);
  if (render === "unformatted") {
    url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
    url.searchParams.set("dateTimeRenderOption", "SERIAL_NUMBER");
  }
  return url.toString();
}

function normalizeSheetValues(data: { values?: unknown[][] }): string[][] {
  return (data.values ?? []).map((row) =>
    (row ?? []).map((cell) => {
      if (cell == null) return "";
      return typeof cell === "string" ? cell : String(cell);
    }),
  );
}

async function getSheetValues(
  token: string,
  sheetId: string,
  range: string,
  options?: { render?: SheetReadRenderOption },
): Promise<string[][]> {
  const render = options?.render ?? "formatted";
  const url = buildSheetValuesUrl(sheetId, range, render);

  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.status === 429) {
      const errText = await res.text();
      const retryAfter = getRetryAfterMs(res);
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s (capped)
      const baseWaitMs = Math.min(60_000, 2000 * Math.pow(2, attempt));
      const jitter = Math.floor(Math.random() * 500);
      const waitMs = (retryAfter ?? baseWaitMs) + jitter;
      console.warn(
        `Sheets API 429 (read quota) for range ${range} — attempt ${attempt + 1}/${maxAttempts}, retrying in ${waitMs}ms:`,
        errText.substring(0, 500),
      );
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Sheets API error for range ${range}:`, errText);
      return [];
    }

    const data = await res.json();
    return normalizeSheetValues(data);
  }

  console.error(`Sheets API 429 (read quota) exhausted retries for range ${range}`);
  return [];
}

async function getSheetValuesStrict(
  token: string,
  sheetId: string,
  range: string,
  options?: { render?: SheetReadRenderOption },
): Promise<string[][]> {
  const render = options?.render ?? "formatted";
  const url = buildSheetValuesUrl(sheetId, range, render);

  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.status === 429) {
      const errText = await res.text();
      const retryAfter = getRetryAfterMs(res);
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s (capped)
      const baseWaitMs = Math.min(60_000, 2000 * Math.pow(2, attempt));
      const jitter = Math.floor(Math.random() * 500);
      const waitMs = (retryAfter ?? baseWaitMs) + jitter;
      console.warn(
        `Sheets API 429 (read quota) for range ${range} — attempt ${attempt + 1}/${maxAttempts}, retrying in ${waitMs}ms:`,
        errText.substring(0, 500),
      );
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Sheets API error for range ${range}: ${errText}`);
    }

    const data = await res.json();
    return normalizeSheetValues(data);
  }

  throw new Error(`Sheets API 429 (read quota) exhausted retries for range ${range}`);
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = (value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function getSheetValuesFromTabCandidates(
  token: string,
  sheetId: string,
  tabCandidates: string[],
  a1Suffix: string,
  options?: { render?: SheetReadRenderOption },
): Promise<string[][]> {
  const tabs = uniqueNonEmpty(tabCandidates);
  if (tabs.length === 0) throw new Error(`No tab candidates provided for suffix ${a1Suffix}`);

  let lastErr: unknown = null;
  for (const tab of tabs) {
    const range = `${tab}!${a1Suffix}`;
    try {
      return await getSheetValuesStrict(token, sheetId, range, options);
    } catch (err) {
      lastErr = err;
      console.warn(`Sheet read failed for range ${range}:`, err instanceof Error ? err.message : err);
    }
  }

  if (lastErr) {
    console.warn(
      `All tab candidates failed for suffix ${a1Suffix}:`,
      lastErr instanceof Error ? lastErr.message : lastErr
    );
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`All tab candidates failed for suffix ${a1Suffix}`);
  }
  throw new Error(`All tab candidates failed for suffix ${a1Suffix}`);
}

async function appendRow(
  token: string,
  sheetId: string,
  sheet: string,
  rowData: string[],
  options?: { valueInputOption?: "USER_ENTERED" | "RAW" },
): Promise<{ updatedRows: number; updatedRange: string }> {
  // Sanitize all row data to prevent formula injection
  const sanitizedData = rowData.map(sanitizeForFormulas);
  const valueInputOption = options?.valueInputOption ?? "USER_ENTERED";

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}:append?valueInputOption=${valueInputOption}&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [sanitizedData] }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to append row: ${errText}`);
  }

  const result = await res.json();
  const updatedRows = Number(result?.updates?.updatedRows ?? 0);
  const updatedRange = String(result?.updates?.updatedRange ?? result?.tableRange ?? "unknown");
  console.log(`appendRow: ${updatedRows} row(s) written to ${updatedRange} (sheet: ${sheet})`);
  if (updatedRows === 0) {
    console.warn("appendRow returned 0 updatedRows.", JSON.stringify(result));
  }

  return { updatedRows, updatedRange };
}

function extractLastRowNumberFromUpdatedRange(updatedRange: string): number | null {
  const matches = updatedRange.match(/(\d+)(?::[A-Z]+(\d+))?$/i);
  if (!matches) return null;
  const endRow = Number(matches[2] ?? matches[1]);
  return Number.isFinite(endRow) && endRow > 0 ? endRow : null;
}

async function appendEventRowStrict(
  token: string,
  sheetId: string,
  eventsTab: string,
  rowData: Array<string | number | null | undefined>,
): Promise<{ rowNumber: number | null }> {
  const normalized = rowData
    .slice(0, 7)
    .map((value) => sanitizeForFormulas((value ?? "").toString()));
  while (normalized.length < 7) normalized.push("");

  // Fast path: structural append (INSERT_ROWS) so Apps Script onChange fires immediately.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const appendResult = await appendRow(token, sheetId, `${eventsTab}!A:G`, normalized, { valueInputOption: "RAW" });
    if (appendResult.updatedRows > 0) {
      console.log(
        `appendEventRowStrict: appended event=${normalized[2]} sku=${normalized[3]} range=${appendResult.updatedRange} attempt=${attempt}`,
      );
      return { rowNumber: extractLastRowNumberFromUpdatedRange(appendResult.updatedRange) };
    }
    if (attempt < 3) {
      await sleepMs(150 * attempt);
    }
  }

  // Fallback: guarantee the row is written even if append metadata is inconsistent.
  const rows = await getSheetValues(token, sheetId, `${eventsTab}!A:G`);
  let lastDataRow = 1; // assume row 1 header
  for (let i = rows.length - 1; i >= 1; i--) {
    const row = rows[i] ?? [];
    const hasData = row.some((cell) => String(cell ?? "").trim() !== "");
    if (hasData) {
      lastDataRow = i + 1;
      break;
    }
  }

  const targetRow = Math.max(2, lastDataRow + 1);
  await writeSheetBlock(token, sheetId, `${eventsTab}!A${targetRow}`, [normalized], { valueInputOption: "RAW" });
  console.warn(
    `appendEventRowStrict fallback write ${eventsTab}!A${targetRow}:G${targetRow} event=${normalized[2]} sku=${normalized[3]}`,
  );
  return { rowNumber: targetRow };
}

// Helper: get the numeric sheet ID for a tab by name (with per-request caching)
const _tabIdCache = new Map<string, number>();

async function getSheetTabId(token: string, spreadsheetId: string, sheetName: string): Promise<number> {
  const cacheKey = `${spreadsheetId}:${sheetName}`;
  if (_tabIdCache.has(cacheKey)) return _tabIdCache.get(cacheKey)!;

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Failed to get sheet metadata (${res.status}): ${errText}`);
  }
  const metadata = (await res.json()) as any;
  // Cache ALL tabs from this response so we never call this endpoint again
  for (const s of metadata.sheets ?? []) {
    if (s.properties?.title) {
      _tabIdCache.set(`${spreadsheetId}:${s.properties.title}`, s.properties.sheetId);
    }
  }
  const tabId = _tabIdCache.get(cacheKey);
  if (tabId === undefined) throw new Error(`Sheet tab "${sheetName}" not found`);
  return tabId;
}

// Helper: delete a single row and shift everything below up
async function deleteSheetRow(token: string, spreadsheetId: string, sheetName: string, rowNumber: number): Promise<void> {
  const tabId = await getSheetTabId(token, spreadsheetId, sheetName);

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: { sheetId: tabId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber },
          },
        }],
      }),
    });

    if (res.ok) return;

    if (res.status === 429 || res.status === 503) {
      const errText = await res.text().catch(() => "");
      const retryAfter = getRetryAfterMs(res);
      const baseWaitMs = 1500 * (attempt + 1);
      const waitMs = (retryAfter ?? baseWaitMs) + Math.floor(Math.random() * 250);
      console.warn(`Sheets API ${res.status} for delete row ${rowNumber} — retrying in ${waitMs}ms:`, errText.substring(0, 400));
      await sleepMs(waitMs);
      continue;
    }

    const errText = await res.text().catch(() => "");
    throw new Error(`Failed to delete row ${rowNumber}: ${errText}`);
  }

  throw new Error(`Failed to delete row ${rowNumber}: exhausted retries`);
}

/**
 * Batch-delete multiple rows in a single Sheets API call.
 * Rows are sorted bottom-to-top internally so indices remain valid
 * as Google processes each deleteDimension sequentially within the batch.
 */
async function deleteSheetRows(
  token: string,
  spreadsheetId: string,
  sheetName: string,
  rowNumbers: number[],
): Promise<void> {
  if (rowNumbers.length === 0) return;
  if (rowNumbers.length === 1) {
    return deleteSheetRow(token, spreadsheetId, sheetName, rowNumbers[0]);
  }

  const tabId = await getSheetTabId(token, spreadsheetId, sheetName);
  // Sort descending so each deletion doesn't shift subsequent target rows
  const sorted = [...rowNumbers].sort((a, b) => b - a);
  const requests = sorted.map((row) => ({
    deleteDimension: {
      range: { sheetId: tabId, dimension: "ROWS", startIndex: row - 1, endIndex: row },
    },
  }));

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      },
    );

    if (res.ok) return;

    if (res.status === 429 || res.status === 503) {
      const errText = await res.text().catch(() => "");
      const retryAfter = getRetryAfterMs(res);
      const baseWaitMs = 1500 * (attempt + 1);
      const waitMs = (retryAfter ?? baseWaitMs) + Math.floor(Math.random() * 250);
      console.warn(`Sheets API ${res.status} for batch-delete ${rowNumbers.length} rows — retrying in ${waitMs}ms:`, errText.substring(0, 400));
      await sleepMs(waitMs);
      continue;
    }

    const errText = await res.text().catch(() => "");
    throw new Error(`Failed to batch-delete ${rowNumbers.length} rows: ${errText}`);
  }

  throw new Error(`Failed to batch-delete ${rowNumbers.length} rows: exhausted retries`);
}

// Helper: insert a blank row at position, then write data into it
async function insertSheetRow(token: string, spreadsheetId: string, sheetName: string, rowNumber: number, rowData: string[]): Promise<void> {
  const tabId = await getSheetTabId(token, spreadsheetId, sheetName);
  // Insert blank row
  const insertRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        insertDimension: {
          range: { sheetId: tabId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber },
          inheritFromBefore: false,
        },
      }],
    }),
  });
  if (!insertRes.ok) {
    const errText = await insertRes.text();
    throw new Error(`Failed to insert row at ${rowNumber}: ${errText}`);
  }

  // Write data into the new row
  const sanitizedData = rowData.map(sanitizeForFormulas);
  const range = `${sheetName}!A${rowNumber}`;
  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [sanitizedData] }),
    }
  );
  if (!writeRes.ok) {
    const errText = await writeRes.text();
    throw new Error(`Failed to write data to inserted row ${rowNumber}: ${errText}`);
  }
}

// Helper: update a single cell value in place (no shifting)
async function updateSheetCell(token: string, spreadsheetId: string, sheetName: string, rowNumber: number, col: string, value: string): Promise<void> {
  const range = `${sheetName}!${col}${rowNumber}`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[sanitizeForFormulas(value)]] }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to update cell ${range}: ${errText}`);
  }
}

async function readAllSheets(
  token: string,
  sheetId: string,
  tabNames?: Record<string, string>
) {
  // Read all tabs in parallel
  const productsTab = resolveTabName(tabNames, "PRODUCTS_TODO", "PRODUCTS TO DO");
  const categoriesTab = resolveTabName(tabNames, "CATEGORIES", "CATEGORIES");
  const propertiesTab = resolveTabName(tabNames, "PROPERTIES", "PROPERTIES");
  const legalTab = resolveTabName(tabNames, "LEGAL", "LEGAL");
  const brandsTab = resolveTabName(tabNames, "BRANDS", "BRANDS");
  const masterDefaultsTab = resolveTabName(tabNames, "MASTER_DEFAULTS", "MASTER_DEFAULTS");
  const newNamesTab = resolveTabName(tabNames, "NEW_NAMES", "NewNames");
  const existingProdsTab = resolveTabName(tabNames, "EXISTING_PRODS", "ExistingProds");
  const productsMainTab = resolveTabName(tabNames, "PRODUCTS", "Products");
  const [productsRaw, productsMainRaw, categoriesRaw, propertiesRaw, legalRaw, brandsRaw, masterDefaultsRaw, newNamesRaw, existingProdsRaw] = await Promise.all([
    getSheetValues(token, sheetId, `${productsTab}!A:D`),
    getSheetValues(token, sheetId, `${productsMainTab}!A:C`),
    getSheetValues(token, sheetId, `${categoriesTab}!A:D`),
    getSheetValues(token, sheetId, `${propertiesTab}!A:D`),
    getSheetValues(token, sheetId, `${legalTab}!A:AZ`),
    getSheetValues(token, sheetId, `${brandsTab}!A:C`),
    getSheetValues(token, sheetId, `${masterDefaultsTab}!A:AZ`),
    getSheetValues(token, sheetId, `${newNamesTab}!A:A`),
    getSheetValues(token, sheetId, `${existingProdsTab}!B:B`),
  ]);

  // Build price lookup from Products tab: Column A = SKU, Column C = Price
  const priceMap = new Map<string, string>();
  for (let i = 1; i < productsMainRaw.length; i++) {
    const row = productsMainRaw[i];
    const sku = normalizeSkuForCompare(row[0] ?? "");
    const price = (row[2] ?? "").toString().trim();
    if (sku) priceMap.set(sku, price);
  }

  const productBrandMap = buildProductBrandMap(productsMainRaw);
  const brandNameMap = buildBrandNameMap(brandsRaw);

  // Parse PRODUCTS TO DO: SKU (A), Brand (B), Status (C), Visibility (D) - skip header row
  // Only include SKUs where Status = "TO_DO" and Visibility is exactly 1
  const products = productsRaw.slice(1).map((row) => ({
    sku: (row[0] ?? "").toString().trim(),
    brand: (row[1] ?? "").toString().trim(),
    status: (row[2] ?? "").toString().trim(),
    visibility: parseInt(row[3] ?? "0", 10),
  }))
    .filter((p) => p.sku && p.status === "TO_DO" && p.visibility === 1)
    .map((p) => ({
      sku: p.sku,
      brand: resolveBrandNameForSku(p.sku, productBrandMap, brandNameMap, p.brand),
      exampleTitle: p.sku,
      price: priceMap.get(normalizeSkuForCompare(p.sku)) ?? "",
    }));

  // Parse CATEGORIES: full path strings -> build tree
  // STRICT: Read ONLY from CATEGORIES tab, skip header row (row 1), data starts at row 2
  const categoryPaths = categoriesRaw.slice(1).map((row) => {
    const path = row[0] ?? "";
    // Trim whitespace from the entire path and from each segment
    return path.trim();
  }).filter((p) => p.length > 0);
  
  // If no categories found, log warning but allow fallback to defaults
  if (categoryPaths.length === 0) {
    console.warn("WARNING: CATEGORIES tab is empty or missing data. Using default categories. To configure, add category paths to the CATEGORIES sheet starting at row 2 (e.g., 'Indoor Lights/Wall Lights')");
    return { useDefaults: true };
  }
  
  const categories = buildCategoryTree(categoryPaths);
  
  // Count actual leaf paths (not tree nodes) for logging
  const leafPathCount = categoryPaths.length;
  console.log(`Successfully read ${leafPathCount} category paths from CATEGORIES tab`);

  // Parse LEGAL (row-based):
  //   Column A = Filter name
  //   Column B = Mandatory flag: "TRUE" or "T" = required, "FALSE" or "F" = optional
  //   Column C = Unit suffix (e.g. "mm", "°", "cm", "m³/h") — may be empty
  //   Column D+ = Allowed values (values start at column D, index 3)
  // Note: "*" in filter names has NO special meaning — strip it for clean display.
  const legalRows = legalRaw.slice(1).map((row) => {
    const rawName = (row[0] ?? "").trim();
    // Strip any "*" characters from the name — they are no longer used for mandatory signalling
    const name = rawName.replace(/\*/g, "").replace(/\s{2,}/g, " ").trim();
    // Column B: mandatory flag — "TRUE" or "T" (case-insensitive) means required
    const mandatoryRaw = (row[1] ?? "").toString().trim().toUpperCase();
    const required = mandatoryRaw === "TRUE" || mandatoryRaw === "T";
    // Column C: unit suffix (e.g. "mm", "°")
    const unitSuffix = (row[2] ?? "").toString().trim() || undefined;
    // Values start at column D (index 3)
    const values = row.slice(3).map((v) => (v ?? "").toString().trim()).filter(Boolean);
    return { name, required, unitSuffix, values };
  }).filter((r) => r.name);

  const legalValues = legalRows.flatMap((row) =>
    row.values.map((value) => ({
      propertyName: row.name,
      allowedValue: value,
    }))
  );

  const properties = legalRows.map((row) => ({
    name: row.name,
    key: toPropertyKey(row.name),
    inputType: row.values.length > 0 ? "dropdown" : "text",
    section: "Filters",
    required: row.required,
    unitSuffix: row.unitSuffix,
  }));

  // Parse master filter lookup from CATEGORIES tab: Column A = category_path, B = Name Structure, C = Name Example, D = Master Filter Default Name (row 2+)
  // masterLookup includes ALL rows with a categoryPath (needed for Name Structure / Name Example display).
  // The defaultName filter is only applied when resolving which Master Filter Default to use,
  // NOT when looking up naming templates — otherwise categories with Name Structure but no
  // Master Filter Default would be silently excluded.
  const masterLookup = categoriesRaw.slice(1).map((row) => ({
    categoryPath: (row[0] ?? "").trim().replace(/\/{2,}/g, "/").replace(/\/$/, ""),
    nameStructure: (row[1] ?? "").trim(),
    nameExample: (row[2] ?? "").trim(),
    defaultName: (row[3] ?? "").trim(),
  })).filter((m) => m.categoryPath);

  // Parse MASTER_DEFAULTS: Column A = default_name, Columns B+ = filter names (row 2+)
  const masterDefaults: Array<{ name: string; allowedProperties: string[] }> = [];
  for (let i = 1; i < masterDefaultsRaw.length; i++) {
    const row = masterDefaultsRaw[i];
    const name = (row?.[0] ?? "").trim();
    if (!name) continue;
    const filters = row.slice(1).map((v: string) => (v ?? "").toString().trim()).filter(Boolean);
    masterDefaults.push({ name, allowedProperties: filters });
  }

  // Parse BRANDS: Brand, BrandName, Website (skip header row)
  const brands = brandsRaw.slice(1).map((row) => ({
    brand: row[0] ?? "",
    brandName: row[1] ?? "",
    website: row[2] ?? "",
  })).filter((b) => b.brand);

  // Parse existing titles from NewNames (Col A, row 2+) and ExistingProds (Col B, row 2+)
  const newNamesTitles = newNamesRaw.slice(1).map((row) => (row[0] ?? "").toString().trim()).filter(Boolean);
  const existingProdsTitles = existingProdsRaw.slice(1).map((row) => (row[0] ?? "").toString().trim()).filter(Boolean);
  const existingTitles = [...new Set([...newNamesTitles, ...existingProdsTitles])];

  if (properties.length === 0) {
    return { products, brands, categories, properties: [], legalValues: [], categoryPathCount: leafPathCount, masterLookup, masterDefaults, existingTitles };
  }

  return { 
    products, 
    brands, 
    categories, 
    properties, 
    legalValues, 
    categoryPathCount: leafPathCount,
    masterLookup,
    masterDefaults,
    existingTitles,
  };
}

function toPropertyKey(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
  if (!cleaned) return "";
  const parts = cleaned.split(" ");
  return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

function columnLetter(index: number): string {
  let n = index + 1;
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

async function addLegalValueToLegalTab(
  token: string,
  sheetId: string,
  legalTab: string,
  propertyName: string,
  value: string
): Promise<void> {
  const trimmedName = propertyName.trim();
  const trimmedValue = value.trim();
  if (!trimmedName || !trimmedValue) return;

  const rows = await getSheetValues(token, sheetId, `${legalTab}!A:AZ`);
  let rowIndex = -1;
  let rowValues: string[] = [];

  for (let i = 1; i < rows.length; i += 1) {
    // Strip "*" from sheet name for matching (sheet may still have legacy "*" in names)
    const name = (rows[i]?.[0] ?? "").toString().replace(/\*/g, "").replace(/\s{2,}/g, " ").trim();
    if (name === trimmedName) {
      rowIndex = i + 1; // 1-based for sheets
      rowValues = rows[i] ?? [];
      break;
    }
  }

  if (rowIndex === -1) {
    // New row: Col A = name, Col B = FALSE (not mandatory by default), Col C = value
    await appendRow(token, sheetId, legalTab, [trimmedName, "FALSE", trimmedValue]);
    return;
  }

  // Values live in columns C+ (index 2+); col B (index 1) is the mandatory flag
  const existingValues = rowValues.slice(2).map((v) => (v ?? "").toString().trim()).filter(Boolean);
  if (existingValues.includes(trimmedValue)) return;

  // Next empty column is after col B (mandatory) + existing values; minimum col C (index 2)
  const nextColIndex = Math.max(rowValues.length, 2);

  // Auto-expand sheet if column exceeds current grid limits
  try {
    const tabId = await getSheetTabId(token, sheetId, legalTab);
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (metaRes.ok) {
      const metaData = await metaRes.json();
      const sheet = metaData.sheets?.find((s: any) => s.properties?.sheetId === tabId);
      const currentMaxCols = sheet?.properties?.gridProperties?.columnCount ?? 30;
      if (nextColIndex >= currentMaxCols) {
        const expandRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              requests: [{
                appendDimension: {
                  sheetId: tabId,
                  dimension: "COLUMNS",
                  length: 10,
                },
              }],
            }),
          }
        );
        if (!expandRes.ok) {
          console.error("Failed to expand sheet columns:", await expandRes.text());
        }
      }
    }
  } catch (expandErr) {
    console.error("Sheet expansion check failed (non-fatal):", expandErr);
  }

  const col = columnLetter(nextColIndex);
  const range = `${legalTab}!${col}${rowIndex}`;

  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(updateUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [[sanitizeForFormulas(trimmedValue)]] }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to update LEGAL value: ${errText}`);
  }
}

function buildCategoryTree(paths: string[]) {
  interface TreeNode {
    name: string;
    children?: TreeNode[];
  }

  const root: TreeNode[] = [];

  for (const path of paths) {
    const parts = path.split("/").map((s) => s.trim()).filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      let existing = current.find((n) => n.name === name);
      if (!existing) {
        existing = { name };
        if (i < parts.length - 1) {
          existing.children = [];
        }
        current.push(existing);
      }
      if (i < parts.length - 1) {
        if (!existing.children) existing.children = [];
        current = existing.children;
      }
    }
  }

  return root;
}

async function clearAndWriteCategories(
  token: string,
  sheetId: string,
  categoryPaths: string[],
  categoriesTab: string
): Promise<void> {
  const sanitizedNewPaths = categoryPaths.map(sanitizeForFormulas);

  // Read current state from sheet
  const currentRows = await getSheetValues(token, sheetId, `${categoriesTab}!A:A`);
  const currentPaths: string[] = [];
  for (let i = 1; i < currentRows.length; i++) {
    const val = (currentRows[i]?.[0] ?? "").toString().trim();
    if (val) currentPaths.push(val);
  }

  const newSet = new Set(sanitizedNewPaths);
  const currentSet = new Set(currentPaths);

  // Detect what changed
  const pathsToDelete: number[] = []; // row indices (0-based within data)
  currentPaths.forEach((path, idx) => {
    if (!newSet.has(path)) pathsToDelete.push(idx);
  });

  const pathsToAdd: string[] = [];
  sanitizedNewPaths.forEach((path) => {
    if (!currentSet.has(path)) pathsToAdd.push(path);
  });

  if (pathsToDelete.length === 0 && pathsToAdd.length === 0) {
    console.log("No category changes detected");
    return;
  }

  // SAFETY: Abort if diff would mass-delete (>50% of rows AND >5 rows)
  // This catches corrupted/default data being written over real data
  if (currentPaths.length > 0 && pathsToDelete.length > 5 && pathsToDelete.length > currentPaths.length * 0.5) {
    throw new Error(
      `SAFETY ABORT: Category sync would delete ${pathsToDelete.length} of ${currentPaths.length} rows (${Math.round(pathsToDelete.length / currentPaths.length * 100)}%). ` +
      `This looks like corrupted or default data being written over real data. No changes were made. ` +
      `If this is intentional, delete categories manually in the Google Sheet.`
    );
  }

  // Batch-delete all rows in a single API call (sorted bottom-to-top internally)
  const deleteRows = pathsToDelete.map((dataIdx) => dataIdx + 2); // +1 header, +1 for 1-based
  await deleteSheetRows(token, sheetId, categoriesTab, deleteRows);
  if (deleteRows.length > 0) {
    console.log(`Deleted ${deleteRows.length} category rows in one batch`);
  }

  // After deletions, re-read to get accurate row count for inserts
  if (pathsToAdd.length > 0) {
    const updatedRows = await getSheetValues(token, sheetId, `${categoriesTab}!A:A`);
    // Find last non-empty data row
    let lastDataRow = 1; // header
    for (let i = updatedRows.length - 1; i >= 1; i--) {
      if ((updatedRows[i]?.[0] ?? "").toString().trim()) { lastDataRow = i + 1; break; }
    }
    // Insert new paths after the last data row
    for (const path of pathsToAdd) {
      lastDataRow++;
      await insertSheetRow(token, sheetId, categoriesTab, lastDataRow, [path]);
      console.log(`Inserted category at row ${lastDataRow}: ${path}`);
    }
  }

  console.log(`Category sync: ${deleteRows.length} deleted, ${pathsToAdd.length} added`);
}

async function clearAndWriteBrands(
  token: string,
  sheetId: string,
  brands: Array<{ brand: string; brandName: string; website: string }>,
  brandsTab: string
): Promise<void> {
  const sanitizedNew = brands.map((b) => ({
    key: `${sanitizeForFormulas(b.brand)}|${sanitizeForFormulas(b.brandName)}|${sanitizeForFormulas(b.website)}`,
    data: [sanitizeForFormulas(b.brand), sanitizeForFormulas(b.brandName), sanitizeForFormulas(b.website)],
  }));

  // Read current state from sheet
  const currentRows = await getSheetValues(token, sheetId, `${brandsTab}!A:C`);
  const currentBrands: Array<{ key: string; row: number }> = [];
  for (let i = 1; i < currentRows.length; i++) {
    const brand = (currentRows[i]?.[0] ?? "").toString().trim();
    if (!brand) continue;
    const brandName = (currentRows[i]?.[1] ?? "").toString().trim();
    const website = (currentRows[i]?.[2] ?? "").toString().trim();
    currentBrands.push({ key: `${brand}|${brandName}|${website}`, row: i + 1 });
  }

  const newKeySet = new Set(sanitizedNew.map((b) => b.key));
  const currentKeySet = new Set(currentBrands.map((b) => b.key));

  // Detect what changed
  const rowsToDelete: number[] = [];
  currentBrands.forEach((b) => {
    if (!newKeySet.has(b.key)) rowsToDelete.push(b.row);
  });

  const brandsToAdd = sanitizedNew.filter((b) => !currentKeySet.has(b.key));

  if (rowsToDelete.length === 0 && brandsToAdd.length === 0) {
    console.log("No brand changes detected");
    return;
  }

  // SAFETY: Abort if diff would mass-delete (>50% of rows AND >5 rows)
  if (currentBrands.length > 0 && rowsToDelete.length > 5 && rowsToDelete.length > currentBrands.length * 0.5) {
    throw new Error(
      `SAFETY ABORT: Brand sync would delete ${rowsToDelete.length} of ${currentBrands.length} rows (${Math.round(rowsToDelete.length / currentBrands.length * 100)}%). ` +
      `This looks like corrupted or default data being written over real data. No changes were made. ` +
      `If this is intentional, delete brands manually in the Google Sheet.`
    );
  }

  // Batch-delete all rows in a single API call (sorted bottom-to-top internally)
  await deleteSheetRows(token, sheetId, brandsTab, rowsToDelete);
  if (rowsToDelete.length > 0) {
    console.log(`Deleted ${rowsToDelete.length} brand rows in one batch`);
  }

  // After deletions, re-read for accurate row count
  if (brandsToAdd.length > 0) {
    const updatedRows = await getSheetValues(token, sheetId, `${brandsTab}!A:C`);
    let lastDataRow = 1;
    for (let i = updatedRows.length - 1; i >= 1; i--) {
      if ((updatedRows[i]?.[0] ?? "").toString().trim()) { lastDataRow = i + 1; break; }
    }
    for (const { data } of brandsToAdd) {
      lastDataRow++;
      await insertSheetRow(token, sheetId, brandsTab, lastDataRow, data);
      console.log(`Inserted brand at row ${lastDataRow}: ${data[0]}`);
    }
  }

  console.log(`Brand sync: ${rowsToDelete.length} deleted, ${brandsToAdd.length} added`);
}
