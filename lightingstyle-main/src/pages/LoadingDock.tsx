import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Download,
  Eye,
  FileText,
  Trash2,
  Send,
  Loader2,
  Pencil,
  Mail,
  XCircle,
  AlertCircle,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  fetchRecentSubmissions,
  deleteSubmission,
  sendAllAndClearDock,
  clearDock,
  markSkuComplete,
  type RecentSubmission,
} from "@/lib/api";
import {
  readDockEmail,
  saveDockEmail,
  readOutputWorkForSku,
  uploadCsvToOutputWork,
  downloadCsvForSku,
  checkDockRowStatus,
  logEmailSingle,
  clearDockFailures,
  getLastFormDataMap,
  getLastFormDataMapMeta,
  getLastDockEntriesMeta,
  getLastDockPendingActionsMap,
  getLastErrorsMap,
  isEdgeFunctionTimeoutErrorMessage,
  type OutputWorkFormData,
} from "@/lib/supabaseGoogleSheets";
import {
  getDockFormSnapshot,
  getDockFormSnapshotFiles,
  isDockFormSnapshotCompatible,
  isDockFormSnapshotSubmissionMatch,
  upsertDockFormSnapshot,
  type DockFormSnapshot,
} from "@/lib/dockFormSnapshots";
import {
  cleanupOrphanedSharedDockFormSnapshots,
  deleteSharedDockFormSnapshotsForSku,
  getSharedDockFormSnapshotForSubmission,
  saveSharedDockFormSnapshot,
} from "@/lib/sharedDockFormSnapshots";
import {
  listPendingDockSubmits,
  persistPendingDockSubmit,
  removePendingDockSubmit,
  PENDING_DOCK_SUBMIT_TTL_MS,
} from "@/lib/loadingDockPending";
import { ProductViewDialog } from "@/components/ProductViewDialog";
import { FormSection } from "@/components/FormSection";
import { Textarea } from "@/components/ui/textarea";
import { normalizeProductTitleWhitespace } from "@/lib/productTitleNormalization";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatDockTimestampLocal, hasCompletedProcessedAt, parseDockTimestamp } from "@/lib/loadingDockTime";
import { getTabScopedStorageKey } from "@/lib/browserTabScope";
/*
 * ═══════════════════════════════════════════════════════════════
 * LOADING DOCK — STATE MACHINE & GHOST ROW ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════
 *
 * Badge States (per row):
 *   "none"       → Row is idle/completed. All actions enabled.
 *   "processing" → Submission in-flight or awaiting processedAt.
 *                   Sub-labels: "Processing" (new) / "Overriding" (overwrite).
 *                   All row actions DISABLED.
 *   "failed"     → Backend error or stale-processing timeout.
 *                   All row actions DISABLED. Use "Clear Failed" to reset.
 *   Action label → "Deleting…" / "Sending…" / "Clearing…"
 *                   All row actions DISABLED while action runs.
 *
 * Badge priority: actionLabel > processing > failed > none
 * Hysteresis: BADGE_STATE_TRANSITION_HOLD_MS prevents flicker
 *             between poll cycles (holds non-"none" → "none" for 800ms).
 *
 * Ghost Rows (optimistic submit entries):
 *   1. Form dispatches "optimistic-submit" → injectPendingSubmit()
 *      creates ghost with empty processedAt, persists to localStorage.
 *   2. Ghost replaces real row for same SKU in mergePendingSubmits().
 *   3. On submit success → "optimistic-submit-complete" event →
 *      finalizePendingSubmitGhost() clears ghost, injects real row.
 *   4. On submit failure → "optimistic-submit-cancel" event →
 *      clearPendingSubmitGhost() removes ghost entirely.
 *   5. Safety nets:
 *      - TTL expiration (PENDING_DOCK_SUBMIT_TTL_MS = 15min)
 *      - Orphan threshold (25s base) if no backend evidence appears
 *      - Backend error detection auto-clears matching ghosts
 *
 * Row Locking (rowDisabled):
 *   rowIsLocked = processing badge | backend error | pending ghost |
 *                 forced pending | action label
 *   rowIsBusy   = local operation in progress (edit/download/view/send/guard)
 *   rowDisabled = rowIsLocked || rowIsBusy
 *
 * Action Guards:
 *   - Read-only (View, Load, Download, Edit Email): fast-path from cache,
 *     no network check. Blocked only if row state is locked.
 *   - Mutations (Delete, Send Email): full server-side checkDockRowStatus()
 *     to verify no concurrent operations from other sessions.
 *   - Bulk (Send All, Clear Dock): blocked if ANY row is locked.
 *
 * Forced Pending (forcedPendingSkusRef):
 *   Set when checkDockRowStatus returns pending during a guard check.
 *   Cleared by: useEffect reconciliation on each poll, TTL expiration,
 *   or finalizePendingSubmitGhost.
 *
 * Override Tracking (overrideSkusRef):
 *   Set when ghost is injected with isOverwrite=true.
 *   Cleared by: useEffect when row is no longer processing,
 *   or finalizePendingSubmitGhost/clearPendingSubmitGhost.
 * ═══════════════════════════════════════════════════════════════
 */

const PAGE_SIZE = 10;
const FORM_STATE_KEY = "productFormState";
const FORM_STATE_STORAGE_KEY = getTabScopedStorageKey(FORM_STATE_KEY);

// Polling tuned to stay well under Google Sheets consumer read quota.
// (The edge function also caches aggressively, but frontend polling is still the biggest lever.)
const POLL_IDLE_MS = 30_000; // idle poll (reduced from 60s to catch external changes faster)
const POLL_SETTLING_MS = 8_000; // settling after processing completes
const POLL_ACTIVE_MS = 1_500; // any activity detected (local OR remote) — fast enough to resolve badges quickly
const POLL_RESUME_DELAY_MS = 1_500; // delay before resuming polling after a mutation completes
const SETTLING_WINDOW_MS = 15_000; // how long to stay at settling after activity ends before going idle
const ACTION_GUARD_REFRESH_TIMEOUT_MS = 900; // keep action clicks responsive even if a refetch is slow
const MUTATION_PAUSE_MAX_MS = 30_000; // safety cap — auto-resume polling if a mutation hangs
const ACTION_GUARD_BURST_MS = 15_000; // brief active polling after any dock action click
const READ_ONLY_FRESH_FETCH_TIMEOUT_MS = 8_000;
const LOAD_INTO_FORM_NEWER_DATA_MAX_RETRIES = 3;
const LOAD_INTO_FORM_NEWER_DATA_RETRY_DELAY_MS = 500;
const MAX_SYNCED_DOCK_FORM_DATA_AGE_MS = 10_000;
const MAX_SYNCED_DOCK_CSV_AGE_MS = 10_000;
const MAX_SYNCED_DOCK_EMAIL_AGE_MS = 10_000;
const DOCK_SUBMISSION_MATCH_TOLERANCE_MS = 5_000;
const PENDING_REMOVE_MS = 45_000; // keep optimistic removals hidden long enough for queued DOCK_DELETE events
const RECENT_CSV_UPLOAD_TTL_MS = 120_000;
const FORCED_PENDING_TTL_MS = 45_000; // 45s — forced badge clears if backend hasn't confirmed; useEffect reconciles sooner
const FORCE_FRESH_DOCK_READ_TTL_MS = 45_000;
const ORPHAN_PENDING_NO_BACKEND_BASE_MS = 25_000; // no Events/Dock evidence should self-heal quickly
const ORPHAN_PENDING_NO_BACKEND_MAX_MS = 120_000;
const STALE_PROCESSING_BASE_MS = 5 * 60_000; // 5 min base — edge function targets <30s, but Sheets API can lag
const STALE_PROCESSING_MAX_MS = 10 * 60_000; // 10 min cap — generous enough for retries + queue depth
const BADGE_STATE_TRANSITION_HOLD_MS = 800; // light hysteresis — just enough to smooth one poll cycle
const SHARED_DOCK_SNAPSHOT_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
const SHARED_DOCK_SNAPSHOT_SWEEP_KEY = "lightingstyle.sharedDockSnapshotSweepAt.v1";
const READ_ONLY_DOCK_ACTIONS = new Set(["View", "Load into Form", "Download", "Edit Email", "Save Email"]);
const ROW_LEVEL_MUTATION_DOCK_ACTIONS = new Set(["Send Email", "Delete"]);

type StableDockBadgeState = "processing" | "failed" | "none";

type DockLoadedFormState = OutputWorkFormData & {
  heldDockSku: string;
  loadedDockSourceSku: string;
  loadedDockSourceTitle: string;
  datasheetUrl: string;
  webpageUrl: string;
  additionalInstructions: string;
  additionalInstructionsData: string;
  otherValues: Record<string, string>;
  loadedFromDockAt: number;
  loadedDockSubmissionEpochMs?: number;
  loadedDockSubmissionSku?: string;
};

type CachedDockCsvEntry = {
  csvText: string;
  submittedAt: string;
  cachedAtMs: number;
};

type CachedDockEmailEntry = {
  email: string;
  submittedAt: string;
  cachedAtMs: number;
};

type PendingDockRemovalEntry = {
  expiresAt: number;
  submittedAt: string;
};

type DockEditEventDetail = DockLoadedFormState & {
  datasheetFile?: File | null;
  websitePdfFile?: File | null;
};

function buildDockFormSnapshotDraftFromLoadedState(
  formState: DockLoadedFormState,
  options?: { submittedAtEpochMs?: number | null; submittedAtSource?: "client" | "backend" },
): Omit<DockFormSnapshot, "savedAtEpochMs" | "fingerprint"> {
  const submittedAtEpochMs =
    Number.isFinite(Number(options?.submittedAtEpochMs)) && Number(options?.submittedAtEpochMs) > 0
      ? Number(options?.submittedAtEpochMs)
      : Number.isFinite(Number(formState.loadedDockSubmissionEpochMs)) && Number(formState.loadedDockSubmissionEpochMs) > 0
        ? Number(formState.loadedDockSubmissionEpochMs)
        : undefined;

  return {
    sku: String(formState.sku ?? "").trim(),
    heldDockSku: String(formState.heldDockSku ?? "").trim(),
    brand: String(formState.brand ?? "").trim(),
    price: String(formState.price ?? "").trim(),
    title: String(formState.title ?? "").trim(),
    mainCategory: String(formState.mainCategory ?? "").trim(),
    selectedCategories: Array.isArray(formState.selectedCategories) ? [...formState.selectedCategories] : [],
    imageUrls: Array.isArray(formState.imageUrls) ? formState.imageUrls.map((value) => String(value ?? "").trim()).filter(Boolean) : [],
    chatgptData: String(formState.chatgptData ?? ""),
    chatgptDescription: String(formState.chatgptDescription ?? ""),
    emailNotes: String(formState.emailNotes ?? ""),
    datasheetUrl: String(formState.datasheetUrl ?? "").trim(),
    webpageUrl: String(formState.webpageUrl ?? "").trim(),
    specValues: { ...(formState.specValues ?? {}) },
    otherValues: { ...(formState.otherValues ?? {}) },
    additionalInstructions: String(formState.additionalInstructions ?? ""),
    additionalInstructionsData: String(formState.additionalInstructionsData ?? ""),
    loadedDockSubmissionEpochMs:
      Number.isFinite(Number(formState.loadedDockSubmissionEpochMs)) && Number(formState.loadedDockSubmissionEpochMs) > 0
        ? Number(formState.loadedDockSubmissionEpochMs)
        : submittedAtEpochMs,
    loadedDockSubmissionSku: String(formState.loadedDockSubmissionSku ?? formState.sku ?? "").trim(),
    submittedAtEpochMs,
    submittedAtSource: submittedAtEpochMs ? (options?.submittedAtSource ?? "backend") : undefined,
  };
}

function readSharedDockSnapshotSweepAt(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(SHARED_DOCK_SNAPSHOT_SWEEP_KEY);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeSharedDockSnapshotSweepAt(epochMs: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SHARED_DOCK_SNAPSHOT_SWEEP_KEY, String(Math.trunc(epochMs)));
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Compute the stale-processing threshold for a given item based on its
 * queue position among all currently-processing items.
 * 1st item → 25s, 2nd → 50s, 3rd → 75s, etc.
 * When the queue is empty the counter resets automatically.
 */
function getStaleThresholdForItem(
  sub: { processedAt?: string; submittedAt: string },
  allItems: Array<{ processedAt?: string; submittedAt: string }>,
): number {
  // Gather all items that are still processing (no completed processedAt)
  const processing = allItems.filter(
    (item) => !hasCompletedProcessedAt(item.processedAt),
  );
  if (processing.length === 0) return STALE_PROCESSING_BASE_MS;

  // Sort by submittedAt ascending (earliest first = position 0)
  const sorted = [...processing].sort(
    (a, b) => parseDockTimestamp(a.submittedAt) - parseDockTimestamp(b.submittedAt),
  );
  const position = sorted.findIndex(
    (item) => item.submittedAt === sub.submittedAt,
  );
  const idx = position >= 0 ? position : sorted.length;
  return Math.min(STALE_PROCESSING_BASE_MS * (idx + 1), STALE_PROCESSING_MAX_MS);
}

/**
 * Check if an item with empty processedAt has been waiting so long
 * that it should be considered stale (i.e., processing failed silently).
 */
function isStaleProcessing(
  sub: { processedAt?: string; submittedAt: string },
  allItems: Array<{ processedAt?: string; submittedAt: string }> = [],
): boolean {
  if (hasCompletedProcessedAt(sub.processedAt)) return false;
  const submittedMs = parseDockTimestamp(sub.submittedAt);
  if (!Number.isFinite(submittedMs) || submittedMs <= 0) return false;
  const threshold = getStaleThresholdForItem(sub, allItems);
  return (Date.now() - submittedMs) > threshold;
}

function getOrphanPendingThresholdForItem(
  sub: { processedAt?: string; submittedAt: string },
  allItems: Array<{ processedAt?: string; submittedAt: string }>,
): number {
  const processing = allItems.filter((item) => !hasCompletedProcessedAt(item.processedAt));
  if (processing.length === 0) return ORPHAN_PENDING_NO_BACKEND_BASE_MS;

  const sorted = [...processing].sort(
    (a, b) => parseDockTimestamp(a.submittedAt) - parseDockTimestamp(b.submittedAt),
  );
  const position = sorted.findIndex((item) => item.submittedAt === sub.submittedAt);
  const idx = position >= 0 ? position : sorted.length;
  return Math.min(ORPHAN_PENDING_NO_BACKEND_BASE_MS * (idx + 1), ORPHAN_PENDING_NO_BACKEND_MAX_MS);
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  result.push(current);
  return result;
}

function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '"') {
      current += ch;
      // Escaped quote inside quoted CSV field ("")
      if (inQuotes && normalized[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "\n" && !inQuotes) {
      if (current.trim()) rows.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) rows.push(current);
  return rows;
}

function normalizeCsvHeader(raw: string): string {
  return (raw ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.,;:]+$/g, "");
}

function extractSkuFromCsv(csvText: string): string {
  const rows = splitCsvRows(csvText);
  if (rows.length < 2) return "";

  const headers = parseCsvLine(rows[0]).map((h) => (h ?? "").replace(/^\uFEFF/, "").trim());
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const values = parseCsvLine(rows[rowIndex]).map((v) => (v ?? "").toString().trim());
    if (values.every((v) => !v)) continue;

    const byExact = new Map<string, string>();
    const byNormalized = new Map<string, string>();

    headers.forEach((header, index) => {
      const value = values[index] ?? "";
      const exact = header.trim();
      if (exact && !byExact.has(exact)) byExact.set(exact, value);
      const normalized = normalizeCsvHeader(header);
      if (normalized && !byNormalized.has(normalized)) byNormalized.set(normalized, value);
    });

    for (const alias of ["Product Code/SKU", "Product ID", "SKU"]) {
      const exact = byExact.get(alias);
      if (exact && exact.trim()) return exact.trim();
      const normalized = byNormalized.get(normalizeCsvHeader(alias));
      if (normalized && normalized.trim()) return normalized.trim();
    }
  }

  return "";
}

function mapCsvUploadError(error?: string): { title: string; description: string; variant?: "destructive" } {
  const fallback = { title: "Upload issue", description: "Upload could not complete — try again shortly. If this persists, contact Eran.", variant: "destructive" } as const;
  if (!error) return fallback;

  const normalized = error.toLowerCase();

  if (normalized.includes("already in the loading dock")) {
    return {
      title: "Already in Loading Dock",
      description: "This SKU is already in the Loading Dock, so no new upload is needed.",
    };
  }

  if (
    normalized.includes("does not match the required template") ||
    normalized.includes("doesn’t match the required template") ||
    normalized.includes("doesn't match the required template") ||
    normalized.includes("csv format isn’t supported") ||
    normalized.includes("csv format isn't supported") ||
    normalized.includes("missing sku")
  ) {
    return {
      title: "CSV format not supported",
      description:
        "This file doesn’t match the expected template. Please export a product CSV with a valid SKU column and try again.",
      variant: "destructive",
    };
  }

  return { title: "Upload issue", description: error };
}

// Listen for force-sync events and refresh recent-submissions
const useForceSyncRecentSubmissions = (queryClient: QueryClient) => {
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
    };
    window.addEventListener("force-sync-recent-submissions", handler);
    return () => window.removeEventListener("force-sync-recent-submissions", handler);
  }, [queryClient]);
};

/** Returns true if the form currently has non-default (non-empty) data in localStorage */
function isFormDirty(): boolean {
  try {
    const stored = localStorage.getItem(FORM_STATE_STORAGE_KEY);
    if (!stored) return false;
    const s = JSON.parse(stored);
    return !!(
      s.sku?.trim() ||
      s.title?.trim() ||
      s.chatgptData?.trim() ||
      s.chatgptDescription?.trim() ||
      s.emailNotes?.trim() ||
      s.selectedCategories?.length > 0 ||
      s.imageUrls?.some((u: string) => u?.trim())
    );
  } catch {
    return false;
  }
}

function getBackendPendingActionLabel(actionType?: RecentSubmission["pendingActionType"]): string | null {
  if (actionType === "delete" || actionType === "clear") return "Removing";
  if (actionType === "email" || actionType === "send") return "Sending";
  return null;
}

function isSameDockSubmissionTimestamp(
  leftTimestamp?: string | null,
  rightTimestamp?: string | null,
  toleranceMs = DOCK_SUBMISSION_MATCH_TOLERANCE_MS,
): boolean {
  const leftMs = parseDockTimestamp(String(leftTimestamp ?? ""));
  const rightMs = parseDockTimestamp(String(rightTimestamp ?? ""));
  if (!Number.isFinite(leftMs) || leftMs <= 0 || !Number.isFinite(rightMs) || rightMs <= 0) {
    return false;
  }
  return Math.abs(leftMs - rightMs) <= toleranceMs;
}

function buildDockSubmissionCacheKey(
  sku: string,
  submittedAt?: string | null,
): string {
  const normalizedSku = String(sku ?? "").trim().toUpperCase();
  const normalizedSubmittedAt = String(submittedAt ?? "").trim();
  return normalizedSubmittedAt ? `${normalizedSku}::${normalizedSubmittedAt}` : normalizedSku;
}

function clearDockSubmissionScopedEntries<T>(map: Map<string, T>, rawSku: string): void {
  const displaySku = rawSku.trim();
  const normalizedSku = displaySku.toUpperCase();
  if (!normalizedSku) return;

  for (const key of Array.from(map.keys())) {
    if (
      key === displaySku ||
      key === normalizedSku ||
      key.startsWith(`${normalizedSku}::`) ||
      (displaySku && key.startsWith(`${displaySku}::`))
    ) {
      map.delete(key);
    }
  }
}

function buildAuthoritativeDockFormState(
  formData: OutputWorkFormData,
  snapshot?: DockFormSnapshot | null,
  options?: { preferSnapshot?: boolean; requestedSku?: string; rowSubmittedAtEpochMs?: number | null },
): DockLoadedFormState {
  const compatibleSnapshot =
    snapshot && (options?.preferSnapshot || isDockFormSnapshotCompatible(snapshot, formData))
      ? snapshot
      : null;
  const normalizeCategoryList = (values: unknown): string[] => {
    if (!Array.isArray(values)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const normalized = String(value ?? "").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  };
  const formSelectedCategories = normalizeCategoryList(formData.selectedCategories);
  const snapshotSelectedCategories = normalizeCategoryList(compatibleSnapshot?.selectedCategories);
  const formImageUrls = Array.isArray(formData.imageUrls)
    ? formData.imageUrls.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  const snapshotImageUrls = Array.isArray(compatibleSnapshot?.imageUrls)
    ? compatibleSnapshot.imageUrls.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  const imageUrls = snapshotImageUrls.length > 0 ? snapshotImageUrls : formImageUrls;
  const snapshotMainCategory = String(compatibleSnapshot?.mainCategory ?? "").trim();
  const formMainCategory = String(formData.mainCategory ?? "").trim();
  const mainCategory = snapshotMainCategory || formMainCategory || snapshotSelectedCategories[0] || formSelectedCategories[0] || "";
  const selectedCategoriesSource = snapshotSelectedCategories.length > 0 ? snapshotSelectedCategories : formSelectedCategories;
  const selectedCategories = mainCategory && !selectedCategoriesSource.includes(mainCategory)
    ? [mainCategory, ...selectedCategoriesSource]
    : selectedCategoriesSource;
  const resolvedSku =
    String(options?.requestedSku ?? "").trim() ||
    String(compatibleSnapshot?.sku ?? "").trim() ||
    String(formData.sku ?? "").trim();

  return {
    sku: resolvedSku,
    heldDockSku: String(compatibleSnapshot?.heldDockSku ?? "").trim(),
    loadedDockSourceSku: resolvedSku,
    loadedDockSourceTitle: normalizeProductTitleWhitespace(
      String(compatibleSnapshot?.title ?? formData.title ?? ""),
    ),
    brand: compatibleSnapshot?.brand ?? String(formData.brand ?? "").trim(),
    price: compatibleSnapshot?.price ?? String(formData.price ?? "").trim(),
    title: compatibleSnapshot?.title ?? String(formData.title ?? "").trim(),
    chatgptData: compatibleSnapshot?.chatgptData ?? String(formData.chatgptData ?? ""),
    chatgptDescription: compatibleSnapshot?.chatgptDescription ?? String(formData.chatgptDescription ?? ""),
    datasheetUrl: compatibleSnapshot?.datasheetUrl ?? "",
    webpageUrl: compatibleSnapshot?.webpageUrl ?? "",
    selectedCategories,
    mainCategory,
    imageUrls: imageUrls.length > 0 ? imageUrls : [""],
    specValues: compatibleSnapshot?.specValues && Object.keys(compatibleSnapshot.specValues).length > 0
      ? { ...compatibleSnapshot.specValues }
      : { ...(formData.specValues ?? {}) },
    otherValues: { ...(compatibleSnapshot?.otherValues ?? {}) },
    emailNotes: compatibleSnapshot?.emailNotes ?? String(formData.emailNotes ?? ""),
    // Title/description and AI-data instructions must only come from the
    // authoritative snapshot for the current submission, never a stale SKU snapshot.
    additionalInstructions: compatibleSnapshot?.additionalInstructions ?? "",
    additionalInstructionsData: compatibleSnapshot?.additionalInstructionsData ?? "",
    loadedFromDockAt: Date.now(),
    loadedDockSubmissionEpochMs:
      Number.isFinite(Number(options?.rowSubmittedAtEpochMs)) && Number(options?.rowSubmittedAtEpochMs) > 0
        ? Number(options?.rowSubmittedAtEpochMs)
        : undefined,
    loadedDockSubmissionSku:
      Number.isFinite(Number(options?.rowSubmittedAtEpochMs)) && Number(options?.rowSubmittedAtEpochMs) > 0
        ? resolvedSku
        : "",
  };
}

const LegacyLoadingDock = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useForceSyncRecentSubmissions(queryClient);
  const [dragOver, setDragOver] = useState(false);
  const [page, setPage] = useState(0);
  const [deleteSku, setDeleteSku] = useState<string | null>(null);
  const [markCompleteOnDelete, setMarkCompleteOnDelete] = useState(false);
  const [confirmSendAll, setConfirmSendAll] = useState(false);
  const [confirmClearDock, setConfirmClearDock] = useState(false);
  const [downloadingSkus, setDownloadingSkus] = useState<Set<string>>(new Set());

  // Edit action state
  const [editingSku, setEditingSku] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [dirtyWarnSku, setDirtyWarnSku] = useState<string | null>(null);

  // Edit Email dialog state
  const [emailDialogSku, setEmailDialogSku] = useState<string | null>(null);
  const [emailDialogSubmittedAt, setEmailDialogSubmittedAt] = useState<string | null>(null);
  const [emailContent, setEmailContent] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);

  // View dialog state
  const [viewOpen, setViewOpen] = useState(false);
  const [viewData, setViewData] = useState<OutputWorkFormData | null>(null);
  const [viewLoading, setViewLoading] = useState<string | null>(null);
  const [sendingEmailSku, setSendingEmailSku] = useState<string | null>(null);
  const [sendEmailConfirmSku, setSendEmailConfirmSku] = useState<string | null>(null);
  const [guardingActionSku, setGuardingActionSku] = useState<string | null>(null);
  const [guardingActionLabel, setGuardingActionLabel] = useState<string | null>(null);
  const [guardingBulkAction, setGuardingBulkAction] = useState<"send-all" | "clear-dock" | null>(null);
  const [dateSortDirection, setDateSortDirection] = useState<"desc" | "asc">("desc");
  const pendingCsvSkusRef = useRef<Set<string>>(new Set());
  const recentCsvUploadsRef = useRef<Map<string, number>>(new Map());
  const csvCache = useRef<Map<string, CachedDockCsvEntry>>(new Map());

  // ── Optimistic submit entries: persist until the real entry appears in polled data ──
  const pendingSubmitsRef = useRef<
    Map<
      string,
      {
        entry: RecentSubmission;
        expiresAt: number;
        submittedAtMs: number;
        isOverwrite: boolean;
      }
    >
  >(new Map());

  const scrollDockListToPage = useCallback((pageIndex: number) => {
    setPage(Math.max(0, pageIndex));
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, []);

  const buildPendingSubmitState = useCallback(
    (detail: {
      sku: string;
      submittedAt?: string;
      submittedAtEpochMs?: number;
      isOverwrite?: boolean;
      expiresAt?: number;
      source?: "submit" | "csv";
    }) => {
      const normalizedSku = detail.sku.trim().toUpperCase();
      if (!normalizedSku) return null;

      const submittedAtMs = Number.isFinite(detail.submittedAtEpochMs)
        ? Number(detail.submittedAtEpochMs)
        : Date.now();
      const submittedAt = detail.submittedAt?.trim() || new Date(submittedAtMs).toISOString();
      return {
        normalizedSku,
        state: {
          entry: {
            id: `${detail.source === "csv" ? "pending-csv" : "pending-submit"}-${normalizedSku}-${submittedAtMs}`,
            sku: detail.sku.trim(),
            submittedAt,
            // Empty processedAt = row stays locked until the real sheet data confirms it.
            // The badge text is decided later from isOverwrite / upload state.
            processedAt: "",
          },
          expiresAt: detail.expiresAt ?? Date.now() + PENDING_DOCK_SUBMIT_TTL_MS,
          submittedAtMs,
          isOverwrite: detail.isOverwrite === true,
        },
      };
    },
    [],
  );

  const pruneForceFreshDockReads = useCallback(() => {
    const now = Date.now();
    const forceFresh = forceFreshDockReadsRef.current;
    for (const [sku, expiresAt] of forceFresh.entries()) {
      if (expiresAt <= now) forceFresh.delete(sku);
    }
  }, []);

  const markSkuAsForceFreshDockRead = useCallback((rawSku: string) => {
    const displaySku = rawSku.trim();
    const normalizedSku = displaySku.toUpperCase();
    if (!normalizedSku) return;
    forceFreshDockReadsRef.current.set(normalizedSku, Date.now() + FORCE_FRESH_DOCK_READ_TTL_MS);
    clearDockSubmissionScopedEntries(outputWorkCache.current, rawSku);
    clearDockSubmissionScopedEntries(outputWorkInflight.current, rawSku);
    clearDockSubmissionScopedEntries(csvCache.current, rawSku);
    clearDockSubmissionScopedEntries(emailCache.current, rawSku);
    clearDockSubmissionScopedEntries(emailInflight.current, rawSku);
  }, []);

  const clearForceFreshDockRead = useCallback((rawSku: string) => {
    const normalizedSku = rawSku.trim().toUpperCase();
    if (!normalizedSku) return;
    forceFreshDockReadsRef.current.delete(normalizedSku);
  }, []);

  const shouldForceFreshDockRead = useCallback((rawSku: string) => {
    pruneForceFreshDockReads();
    const normalizedSku = rawSku.trim().toUpperCase();
    if (!normalizedSku) return false;
    return forceFreshDockReadsRef.current.has(normalizedSku);
  }, [pruneForceFreshDockReads]);

  const injectPendingSubmit = useCallback(
    (
      detail: {
        sku: string;
        submittedAt?: string;
        submittedAtEpochMs?: number;
        isOverwrite?: boolean;
        expiresAt?: number;
        source?: "submit" | "csv";
      },
      options?: { scrollToTop?: boolean; persist?: boolean },
    ) => {
      const built = buildPendingSubmitState(detail);
      if (!built) return;

      const { normalizedSku, state } = built;
      pendingSubmitsRef.current.set(normalizedSku, state);
      if (state.isOverwrite) {
        overrideSkusRef.current.add(normalizedSku);
      }
      if (options?.persist !== false) {
        persistPendingDockSubmit({
          sku: state.entry.sku,
          submittedAt: state.entry.submittedAt,
          submittedAtEpochMs: state.submittedAtMs,
          isOverwrite: state.isOverwrite,
          expiresAt: state.expiresAt,
        });
      }

      markSkuAsForceFreshDockRead(state.entry.sku);
      csvCache.current.delete(state.entry.sku);
      csvCache.current.delete(normalizedSku);
      if (options?.scrollToTop) {
        const currentRows = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? [];
        const replacingExistingSku = currentRows.some((row) => row.sku.trim().toUpperCase() === normalizedSku);
        const projectedCount = replacingExistingSku ? currentRows.length : currentRows.length + 1;
        const targetPage = dateSortDirection === "desc"
          ? 0
          : Math.max(0, Math.ceil(projectedCount / PAGE_SIZE) - 1);
        scrollDockListToPage(targetPage);
      }

      queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) => {
        const list = old ? [...old] : [];
        const withoutSku = list.filter((row) => row.sku.trim().toUpperCase() !== normalizedSku);
        withoutSku.unshift(state.entry);
        return withoutSku;
      });
      setDockUiVersion((n) => n + 1);
    },
    [buildPendingSubmitState, dateSortDirection, markSkuAsForceFreshDockRead, queryClient, scrollDockListToPage],
  );

  const clearPendingSubmitGhost = useCallback(
    (rawSku: string) => {
      const normalizedSku = rawSku.trim().toUpperCase();
      if (!normalizedSku) return;

      pendingSubmitsRef.current.delete(normalizedSku);
      pendingCsvSkusRef.current.delete(normalizedSku);
      overrideSkusRef.current.delete(normalizedSku);
      forcedPendingSkusRef.current.delete(normalizedSku);
      removePendingDockSubmit(normalizedSku);
      clearForceFreshDockRead(normalizedSku);

      queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) => {
        if (!old) return old;
        return old.filter((row) => {
          if (row.sku.trim().toUpperCase() !== normalizedSku) return true;
          return !row.id.startsWith("pending-submit-") && !row.id.startsWith("pending-csv-");
        });
      });
      setDockUiVersion((n) => n + 1);
    },
    [clearForceFreshDockRead, queryClient],
  );

  const finalizePendingSubmitGhost = useCallback(
    (
      rawSku: string,
      processedAt?: string,
      options?: {
        submittedAt?: string;
        submittedAtEpochMs?: number;
      },
    ) => {
      const normalizedSku = rawSku.trim().toUpperCase();
      const displaySku = rawSku.trim();
      if (!normalizedSku) return;

      const pendingState = pendingSubmitsRef.current.get(normalizedSku) ?? null;
      const resolvedSubmittedAtEpochMs =
        Number.isFinite(Number(options?.submittedAtEpochMs)) && Number(options?.submittedAtEpochMs) > 0
          ? Number(options?.submittedAtEpochMs)
          : null;
      const submittedAt = options?.submittedAt?.trim()
        || (resolvedSubmittedAtEpochMs ? new Date(resolvedSubmittedAtEpochMs).toISOString() : "")
        || pendingState?.entry.submittedAt
        || new Date().toISOString();

      pendingSubmitsRef.current.delete(normalizedSku);
      pendingCsvSkusRef.current.delete(normalizedSku);
      overrideSkusRef.current.delete(normalizedSku);
      forcedPendingSkusRef.current.delete(normalizedSku);
      removePendingDockSubmit(normalizedSku);
      markSkuAsForceFreshDockRead(displaySku);

      queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) => {
        const list = old ? [...old] : [];
        const withoutSku = list.filter((row) => row.sku.trim().toUpperCase() !== normalizedSku);
        if (!processedAt?.trim()) return withoutSku;
        withoutSku.push({
          id: displaySku || normalizedSku,
          sku: displaySku || normalizedSku,
          submittedAt,
          processedAt,
        });
        return withoutSku;
      });
      setDockUiVersion((n) => n + 1);
    },
    [markSkuAsForceFreshDockRead, queryClient],
  );

  useEffect(() => {
    const persistedPending = listPendingDockSubmits();
    if (persistedPending.length === 0) return;

    for (const pending of persistedPending) {
      injectPendingSubmit(pending, { scrollToTop: true, persist: false });
    }

    queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
      /* non-fatal */
    });
  }, [injectPendingSubmit, queryClient]);

  /** Listen for optimistic-submit events dispatched by ProductEntryForm */
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        sku: string;
        submittedAt?: string;
        submittedAtEpochMs?: number;
        isOverwrite?: boolean;
      } | undefined;
      if (!detail?.sku) return;

      injectPendingSubmit(detail, { scrollToTop: true, persist: true });
      // Pull latest quickly, but keep pending row locked until processed.
      queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
        /* non-fatal */
      });
    };
    window.addEventListener("optimistic-submit", handler);
    return () => window.removeEventListener("optimistic-submit", handler);
  }, [injectPendingSubmit, queryClient]);

  useEffect(() => {
    const handleComplete = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        sku?: string;
        processedAt?: string;
        submittedAt?: string;
        submittedAtEpochMs?: number;
      } | undefined;
      if (!detail?.sku) return;

      // Force-resume polling so the invalidation actually fetches fresh data
      // (otherwise mutationActiveRef blocks the queryFn and returns cached data)
      mutationActiveRef.current = false;
      mutationPausedAtRef.current = 0;

      finalizePendingSubmitGhost(detail.sku, detail.processedAt, {
        submittedAt: detail.submittedAt,
        submittedAtEpochMs: detail.submittedAtEpochMs,
      });
      queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
        /* non-fatal */
      });
    };

    const handleCancel = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        sku?: string;
      } | undefined;
      if (!detail?.sku) return;

      clearPendingSubmitGhost(detail.sku);
      queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
        /* non-fatal */
      });
    };

    window.addEventListener("optimistic-submit-complete", handleComplete);
    window.addEventListener("optimistic-submit-cancel", handleCancel);
    return () => {
      window.removeEventListener("optimistic-submit-complete", handleComplete);
      window.removeEventListener("optimistic-submit-cancel", handleCancel);
    };
  }, [clearPendingSubmitGhost, finalizePendingSubmitGhost, queryClient]);

  const getNewestSubmissionMs = useCallback((row: RecentSubmission): number => {
    const submittedMs = parseDockTimestamp(row.submittedAt);
    const processedMs = parseDockTimestamp(row.processedAt);
    return Math.max(submittedMs, processedMs);
  }, []);

  const shouldResolvePendingSubmit = useCallback(
    (
      pendingSubmittedAtMs: number,
      realRowsForSku: RecentSubmission[],
    ): boolean => {
      const allPending = Array.from(pendingSubmitsRef.current.values()).map(
        (p) => ({ processedAt: p.entry.processedAt, submittedAt: p.entry.submittedAt }),
      );
      const self = { processedAt: "", submittedAt: new Date(pendingSubmittedAtMs).toISOString() };
      const orphanThreshold = getOrphanPendingThresholdForItem(self, allPending);
      const elapsedMs = Date.now() - pendingSubmittedAtMs;

      if (realRowsForSku.length === 0) {
        // No real rows exist in the sheet for this SKU.
        // This means the optimistic row never got backend evidence, so self-heal
        // much faster than genuine Processing rows that do have Events data.
        return elapsedMs > orphanThreshold;
      }
      let newest = realRowsForSku[0];
      for (const row of realRowsForSku) {
        if (getNewestSubmissionMs(row) > getNewestSubmissionMs(newest)) newest = row;
      }
      const newestMs = getNewestSubmissionMs(newest);
      const hasAnyPendingBackendEvidence = realRowsForSku.some(
        (row) => !hasCompletedProcessedAt(row.processedAt),
      );
      // If the only backend evidence for this SKU is an older completed row,
      // this local pending submit never reached the backend and should self-heal
      // on the shorter orphan threshold instead of hanging for the full TTL.
      if (!hasAnyPendingBackendEvidence && newestMs < pendingSubmittedAtMs - 2_000) {
        return elapsedMs > orphanThreshold;
      }
      if (!hasCompletedProcessedAt(newest.processedAt) && !isStaleProcessing(newest, realRowsForSku)) return false;
      // Small tolerance for backend/client clock skew.
      return newestMs >= pendingSubmittedAtMs - 2_000;
    },
    [getNewestSubmissionMs],
  );

  // Keep pending submit rows at top (especially overwrite), hide stale real row until done.
  const mergePendingSubmits = useCallback(
    (rows: RecentSubmission[]): RecentSubmission[] => {
      const now = Date.now();
      const merged = [...rows];
      const pending = pendingSubmitsRef.current;

      for (const [normalizedSku, pendingState] of pending.entries()) {
        const { entry, expiresAt, submittedAtMs } = pendingState;
        if (expiresAt <= now) {
          pending.delete(normalizedSku);
          pendingCsvSkusRef.current.delete(normalizedSku);
          overrideSkusRef.current.delete(normalizedSku);
          forcedPendingSkusRef.current.delete(normalizedSku);
          removePendingDockSubmit(normalizedSku);
          continue;
        }
        const realRowsForSku = merged.filter((row) => row.sku.trim().toUpperCase() === normalizedSku);
        if (shouldResolvePendingSubmit(submittedAtMs, realRowsForSku)) {
          pending.delete(normalizedSku);
          pendingCsvSkusRef.current.delete(normalizedSku);
          overrideSkusRef.current.delete(normalizedSku);
          forcedPendingSkusRef.current.delete(normalizedSku);
          removePendingDockSubmit(normalizedSku);
          continue;
        }
        // Hide stale real rows for this SKU until overwrite/submit is fully processed.
        for (let i = merged.length - 1; i >= 0; i--) {
          if (merged[i].sku.trim().toUpperCase() === normalizedSku) {
            merged.splice(i, 1);
          }
        }
        merged.unshift(entry);
      }
      return merged;
    },
    [shouldResolvePendingSubmit],
  );

  // overlayPendingSubmitsForDisplay removed — mergePendingSubmits already runs
  // in the queryFn, so submissions already contains the merged result.
  // Running it again was redundant processing on every render cycle.

  const pruneRecentCsvUploads = useCallback(() => {
    const now = Date.now();
    const recent = recentCsvUploadsRef.current;
    for (const [sku, expiresAt] of recent.entries()) {
      if (expiresAt <= now) recent.delete(sku);
    }
  }, []);

  const rememberRecentCsvUpload = useCallback(
    (sku: string) => {
      const normalized = sku.trim().toUpperCase();
      if (!normalized) return;
      pruneRecentCsvUploads();
      recentCsvUploadsRef.current.set(normalized, Date.now() + RECENT_CSV_UPLOAD_TTL_MS);
    },
    [pruneRecentCsvUploads],
  );

  // Mutation-aware polling: pause during actions, use longer interval after actions
  const mutationActiveRef = useRef(false);
  const mutationPausedAtRef = useRef(0); // when mutation pause started
  const resumeAtRef = useRef(0); // timestamp when polling should resume after a mutation

  /** Call before starting any mutation to pause polling */
  const pausePolling = useCallback(() => {
    mutationActiveRef.current = true;
    mutationPausedAtRef.current = Date.now();
  }, []);

  /** Call after a mutation completes to resume polling with a delay */
  const resumePolling = useCallback(() => {
    mutationActiveRef.current = false;
    mutationPausedAtRef.current = 0;
    resumeAtRef.current = Date.now() + POLL_RESUME_DELAY_MS;
  }, []);

  const pendingRemovedSkusRef = useRef<Map<string, PendingDockRemovalEntry>>(new Map());
  const forcedPendingSkusRef = useRef<Map<string, number>>(new Map());
  /** SKUs that were submitted as overrides — persists after pendingSubmitsRef is pruned */
  const overrideSkusRef = useRef<Set<string>>(new Set());
  /** SKUs currently mid-action (delete/send/clear). Value = label shown in badge (e.g. "Removing…") */
  const actionPendingSkusRef = useRef<Map<string, string>>(new Map());
  /** Sticky per-SKU badge state to smooth rapid Processing/Failed flips across polling ticks. */
  const stableBadgeStateRef = useRef<Map<string, { state: StableDockBadgeState; changedAt: number }>>(new Map());
  const forceFreshDockReadsRef = useRef<Map<string, number>>(new Map());
  const [dockUiVersion, setDockUiVersion] = useState(0);
  // lastImmediateRefreshAtRef removed — forceImmediateDockRefresh was pruned
  /** Fingerprint of dock state — detects changes from ANY user (including other computers) */
  const lastDockFingerprintRef = useRef("");
  /** Timestamp when an external change was detected — triggers faster polling */
  const changeDetectedAtRef = useRef(0);
  /** Short active-polling burst after any dock action click, even before the backend state settles. */
  const forcedActivePollingUntilRef = useRef(0);

  const resolveStableDockBadgeState = useCallback((sku: string, nextState: StableDockBadgeState): StableDockBadgeState => {
    const normalizedSku = sku.trim().toUpperCase();
    if (!normalizedSku) return nextState;

    const now = Date.now();
    const map = stableBadgeStateRef.current;
    const prev = map.get(normalizedSku);
    if (!prev) {
      map.set(normalizedSku, { state: nextState, changedAt: now });
      return nextState;
    }

    if (prev.state === nextState) return nextState;

    if (
      prev.state !== "none" &&
      now - prev.changedAt < BADGE_STATE_TRANSITION_HOLD_MS
    ) {
      return prev.state;
    }

    map.set(normalizedSku, { state: nextState, changedAt: now });
    return nextState;
  }, []);

  const prunePendingRemovals = useCallback(() => {
    const now = Date.now();
    const pending = pendingRemovedSkusRef.current;
    for (const [sku, entry] of pending.entries()) {
      if ((entry?.expiresAt ?? 0) <= now) pending.delete(sku);
    }
  }, []);

  const pruneForcedPendingSkus = useCallback(() => {
    const now = Date.now();
    const forced = forcedPendingSkusRef.current;
    for (const [sku, expiresAt] of forced.entries()) {
      if (expiresAt <= now) forced.delete(sku);
    }
  }, []);

  const markSkuAsForcedPending = useCallback(
    (rawSku: string) => {
      const normalizedSku = rawSku.trim().toUpperCase();
      if (!normalizedSku) return;
      forcedPendingSkusRef.current.set(normalizedSku, Date.now() + FORCED_PENDING_TTL_MS);
      queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) => {
        if (!old) return old;
        return old.map((row) =>
          row.sku.trim().toUpperCase() === normalizedSku
            ? { ...row, processedAt: "" }
            : row,
        );
      });
    },
    [queryClient],
  );

  const clearForcedPendingSku = useCallback((rawSku: string) => {
    const normalizedSku = rawSku.trim().toUpperCase();
    if (!normalizedSku) return;
    forcedPendingSkusRef.current.delete(normalizedSku);
  }, []);

  const markActionPending = useCallback((skus: string[], label: string) => {
    const map = actionPendingSkusRef.current;
    for (const rawSku of skus) {
      const sku = rawSku.trim().toUpperCase();
      if (sku) map.set(sku, label);
    }
    setDockUiVersion((n) => n + 1);
  }, []);

  const clearActionPending = useCallback((skus: string[]) => {
    const map = actionPendingSkusRef.current;
    for (const rawSku of skus) {
      const sku = rawSku.trim().toUpperCase();
      if (sku) map.delete(sku);
    }
    setDockUiVersion((n) => n + 1);
  }, []);

  const addPendingRemovals = useCallback((entries: Array<string | { sku: string; submittedAt?: string | null }>) => {
    const expiresAt = Date.now() + PENDING_REMOVE_MS;
    const pending = pendingRemovedSkusRef.current;
    for (const entry of entries) {
      const rawSku = typeof entry === "string" ? entry : entry.sku;
      const sku = rawSku.trim().toUpperCase();
      if (!sku) continue;
      pending.set(sku, {
        expiresAt,
        submittedAt: typeof entry === "string" ? "" : entry.submittedAt?.trim() || "",
      });
    }
  }, []);

  const clearPendingRemovals = useCallback((skus: string[]) => {
    const pending = pendingRemovedSkusRef.current;
    for (const rawSku of skus) {
      const sku = rawSku.trim().toUpperCase();
      if (sku) pending.delete(sku);
    }
  }, []);

  const filterPendingRemovals = useCallback(
    (rows: RecentSubmission[]): RecentSubmission[] => {
      prunePendingRemovals();
      const pending = pendingRemovedSkusRef.current;
      if (pending.size === 0) return rows;
      return rows.filter((row) => {
        const normalizedSku = row.sku.trim().toUpperCase();
        const pendingEntry = pending.get(normalizedSku);
        if (!pendingEntry) return true;
        if (!pendingEntry.submittedAt) return false;
        const matchesRemovedSubmission = isSameDockSubmissionTimestamp(pendingEntry.submittedAt, row.submittedAt);
        if (!matchesRemovedSubmission) {
          pending.delete(normalizedSku);
          return true;
        }
        return false;
      });
    },
    [prunePendingRemovals],
  );

  const {
    data: submissions = [],
    isLoading,
    refetch: refetchSubmissions,
  } = useQuery({
    queryKey: ["recent-submissions"],
    queryFn: async () => {
      // Skip fetch if a mutation is active (let optimistic UI stay stable)
      if (mutationActiveRef.current) {
        return queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? [];
      }
      try {
        const latest = await fetchRecentSubmissions({ includeFormDataMap: true });
        const filtered = filterPendingRemovals(latest);
        const merged = mergePendingSubmits(filtered);
        const pendingActionFingerprint = Array.from(Object.entries(getLastDockPendingActionsMap() ?? {}))
          .map(([sku, actionType]) => `${sku.trim().toUpperCase()}:${actionType}`)
          .sort()
          .join("|");

        // ── Change detection: detect activity from OTHER users ──
        // Build a fingerprint from SKU list + processedAt values.
        // If it differs from last fetch, another user submitted/deleted/processed something.
        const fingerprint = merged
          .map((s) => `${s.sku}:${s.processedAt ?? ""}:${s.pendingActionType ?? ""}`)
          .sort()
          .join("|") + `::${pendingActionFingerprint}`;
        if (lastDockFingerprintRef.current && fingerprint !== lastDockFingerprintRef.current) {
          changeDetectedAtRef.current = Date.now();
        }
        lastDockFingerprintRef.current = fingerprint;

        return merged;
      } catch (err) {
        // On error, return EMPTY — the Google Sheet is the single source of truth.
        // Never show stale/cached data that might not reflect the real sheet state.
        console.warn("Failed to fetch submissions:", err);
        return mergePendingSubmits([]);
      }
    },
    refetchInterval: () => {
      // Pause polling entirely during mutations (with safety timeout)
      if (mutationActiveRef.current) {
        if (mutationPausedAtRef.current > 0 && Date.now() - mutationPausedAtRef.current > MUTATION_PAUSE_MAX_MS) {
          // Safety: mutation hung — force resume
          console.warn("[LoadingDock] Mutation pause exceeded timeout, auto-resuming polling");
          mutationActiveRef.current = false;
          mutationPausedAtRef.current = 0;
        } else {
          return false;
        }
      }

      pruneForcedPendingSkus();
      const cached = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) || [];

      // Detect ANY activity: local pending, backend processing, action badges, backend-failure badges, or external changes
      const hasLocalPending = pendingSubmitsRef.current.size > 0 || pendingCsvSkusRef.current.size > 0;
      const hasActionPending = actionPendingSkusRef.current.size > 0;
      const hasForcedPending = forcedPendingSkusRef.current.size > 0;
      const errorsMap = getLastErrorsMap() ?? {};
      const pendingActionsMap = getLastDockPendingActionsMap() ?? {};
      const hasBackendErrorBadge = cached.some((sub) => {
        const normalizedSku = sub.sku.trim().toUpperCase();
        return Boolean(errorsMap[normalizedSku]);
      });
      const hasBackendPendingAction = cached.some((sub) => {
        const normalizedSku = sub.sku.trim().toUpperCase();
        return Boolean(sub.pendingActionType) || Boolean(pendingActionsMap[normalizedSku]);
      });
      const hasProcessing = cached.some((sub) => {
        return !hasCompletedProcessedAt(sub.processedAt) || Boolean(sub.pendingActionType);
      });
      const hasAnyActivity = hasLocalPending || hasProcessing || hasActionPending || hasForcedPending || hasBackendErrorBadge;
      if (Date.now() < forcedActivePollingUntilRef.current) {
        changeDetectedAtRef.current = Date.now();
        return POLL_ACTIVE_MS;
      }

      // ── TIER 1: Active processing (any user) → 1s polling ──
      if (hasAnyActivity || hasBackendPendingAction) {
        // Track when activity was last seen for settling window
        changeDetectedAtRef.current = Date.now();
        return POLL_ACTIVE_MS;
      }

      // ── TIER 2: Settling — processing just finished → 8s for 15s ──
      if (changeDetectedAtRef.current > 0) {
        const sinceLastActivity = Date.now() - changeDetectedAtRef.current;
        if (sinceLastActivity < SETTLING_WINDOW_MS) {
          return POLL_SETTLING_MS;
        }
        changeDetectedAtRef.current = 0;
      }

      // ── TIER 3: Truly idle → 30s ──
      return POLL_IDLE_MS;
    },
    refetchIntervalInBackground: false, // don't poll when tab is hidden
    retry: 2,
    retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 15000),
    staleTime: 750, // must be shorter than POLL_ACTIVE_MS so every poll fetches fresh data
    refetchOnMount: true,
    refetchOnWindowFocus: true,  // instant refresh when user switches back to this tab
    placeholderData: (previousData) => previousData,
  });

  const refreshRecentSubmissionsForAction = useCallback(async (): Promise<RecentSubmission[]> => {
    const guardedRefetch = refetchSubmissions().catch(() => null);
    const refetchResult = await Promise.race([
      guardedRefetch,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), ACTION_GUARD_REFRESH_TIMEOUT_MS);
      }),
    ]);

    return refetchResult && Array.isArray(refetchResult.data)
      ? refetchResult.data
      : queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? [];
  }, [queryClient, refetchSubmissions]);

  // Safety: when tab regains visibility, clear any stuck mutation pause and trigger a settling burst
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        if (mutationActiveRef.current && mutationPausedAtRef.current > 0 && Date.now() - mutationPausedAtRef.current > 5_000) {
          mutationActiveRef.current = false;
          mutationPausedAtRef.current = 0;
        }
        // Kick into settling tier to catch up after tab was hidden
        changeDetectedAtRef.current = Date.now();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // submissions already has pending submits merged via mergePendingSubmits in the queryFn
  const displaySubmissions = submissions;

  const startDockActionPollingBurst = useCallback(() => {
    const now = Date.now();
    changeDetectedAtRef.current = now;
    forcedActivePollingUntilRef.current = now + ACTION_GUARD_BURST_MS;
  }, []);

  // forceImmediateDockRefresh removed — React Query's refetchOnWindowFocus handles tab-focus refreshes.
  // The visibility recovery useEffect (line ~1245) handles stuck mutation pauses.

  // Manual focus/visibility/pageshow handlers removed — React Query's
  // refetchOnWindowFocus: true (line ~1226) already handles tab-focus refreshes.
  // Having both caused double-refresh bursts that hammered the edge function.

  const buildBackendErrorsBySku = useCallback(() => {
    const raw = getLastErrorsMap() ?? {};
    const map = new Map<string, string>();
    for (const [sku, message] of Object.entries(raw)) {
      const normalizedSku = sku.trim().toUpperCase();
      const trimmedMessage = (message ?? "").toString().trim();
      if (!normalizedSku || !trimmedMessage) continue;
      map.set(normalizedSku, trimmedMessage);
    }
    return map;
  }, []);

  const buildBackendPendingActionsBySku = useCallback(() => {
    const raw = getLastDockPendingActionsMap() ?? {};
    const map = new Map<string, NonNullable<RecentSubmission["pendingActionType"]>>();
    for (const [sku, actionType] of Object.entries(raw)) {
      const normalizedSku = sku.trim().toUpperCase();
      if (!normalizedSku) continue;
      if (actionType !== "delete" && actionType !== "email" && actionType !== "clear" && actionType !== "send") continue;
      map.set(normalizedSku, actionType);
    }
    return map;
  }, []);

  // Memoize using dockUiVersion as an additional trigger — this bumps on
  // any state change that should recompute badges (action pending, ghost inject/clear, etc.).
  const backendErrorsBySku = useMemo(() => buildBackendErrorsBySku(), [buildBackendErrorsBySku, dockUiVersion, submissions]);
  const backendPendingActionsBySku = useMemo(() => buildBackendPendingActionsBySku(), [buildBackendPendingActionsBySku, dockUiVersion, submissions]);
  const sharedSnapshotSweepInFlightRef = useRef(false);

  const isSubmissionLocked = useCallback(
    (
      sub: RecentSubmission,
      errorsBySku: Map<string, string>,
      allRows: RecentSubmission[] = submissions,
    ) => {
      const normalizedSku = sub.sku.trim().toUpperCase();
      const rowHasBackendPendingAction = Boolean(sub.pendingActionType) || backendPendingActionsBySku.has(normalizedSku);
      const rowIsProcessing =
        rowHasBackendPendingAction ||
        (!hasCompletedProcessedAt(sub.processedAt) && !isStaleProcessing(sub, allRows));
      const rowHasBackendError = errorsBySku.has(normalizedSku);
      const rowHasPendingGhost =
        pendingSubmitsRef.current.has(normalizedSku) || pendingCsvSkusRef.current.has(normalizedSku);
      const rowHasForcedPending = forcedPendingSkusRef.current.has(normalizedSku);
      return rowIsProcessing || rowHasBackendError || rowHasPendingGhost || rowHasForcedPending;
    },
    [backendPendingActionsBySku, submissions],
  );

  const showDockActionBlockedToast = useCallback(
    (actionLabel: string, sku?: string, reason?: "processing" | "error" | "pending" | "other-user") => {
      const reasonLabel = reason === "error"
        ? "has an error"
        : reason === "pending"
        ? "is still being submitted"
        : reason === "other-user"
        ? "is being processed by another session"
        : "is still processing";

      toast({
        title: reason === "error" ? "Action blocked" : "Still processing\u2026",
        description: sku
          ? `${sku} ${reasonLabel}, so ${actionLabel.toLowerCase()} is not available yet.`
          : `Some Loading Dock items are still processing, so ${actionLabel.toLowerCase()} is not available yet.`,
        variant: "destructive",
      });
    },
    [toast],
  );

  const syncSkuCompleteInBackground = useCallback(
    (sku: string, actionLabel: "Email" | "Delete") => {
      void (async () => {
        try {
          const result = await markSkuComplete(sku);
          if (result.success || result.alreadyState) return;
          toast({
            title: "Status sync issue",
            description: `${actionLabel} succeeded for ${sku}, but marking it COMPLETE did not finish. Check Product Options if needed.`,
            variant: "destructive",
          });
        } catch (err) {
          console.warn(`Failed to mark ${sku} as COMPLETE after ${actionLabel.toLowerCase()}:`, err);
          toast({
            title: "Status sync issue",
            description: `${actionLabel} succeeded for ${sku}, but marking it COMPLETE did not finish. Check Product Options if needed.`,
            variant: "destructive",
          });
        }
      })();
    },
    [toast],
  );

  const refreshDockActionGuard = useCallback(
    async (options: { actionLabel: string; sku?: string }): Promise<boolean> => {
      const normalizedSku = options.sku?.trim().toUpperCase() || "";
      const isReadOnlyAction = READ_ONLY_DOCK_ACTIONS.has(options.actionLabel);
      const isRowLevelMutationAction = ROW_LEVEL_MUTATION_DOCK_ACTIONS.has(options.actionLabel);
      startDockActionPollingBurst();

      const currentRows = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions;
      const currentErrorsBySku = buildBackendErrorsBySku();
      const currentPendingActionsBySku = buildBackendPendingActionsBySku();

      if (normalizedSku && isReadOnlyAction) {
        const currentRow = currentRows.find((row) => row.sku.trim().toUpperCase() === normalizedSku);
        const hasPendingGhost = pendingSubmitsRef.current.has(normalizedSku) || pendingCsvSkusRef.current.has(normalizedSku);
        const hasForcedPending = forcedPendingSkusRef.current.has(normalizedSku);
        const hasError = currentErrorsBySku.has(normalizedSku);
        const hasBackendPendingAction = currentRow
          ? Boolean(currentRow.pendingActionType) || currentPendingActionsBySku.has(normalizedSku)
          : false;
        const isProcessing = currentRow
          ? hasBackendPendingAction ||
            (!hasCompletedProcessedAt(currentRow.processedAt) && !isStaleProcessing(currentRow, currentRows))
          : false;

        if (!currentRow) {
          toast({
            title: "Item no longer available",
            description: `${options.sku} was removed by another user or action.`,
            variant: "destructive",
          });
          return false;
        }

        if (hasPendingGhost) {
          showDockActionBlockedToast(options.actionLabel, options.sku, "pending");
          return false;
        }

        if (hasError || hasForcedPending || isProcessing) {
          showDockActionBlockedToast(
            options.actionLabel,
            options.sku,
            hasError ? "error" : hasBackendPendingAction ? "other-user" : "processing",
          );
          return false;
        }

        // ── FAST PATH: Local state says row is completed & actionable ──
        // Skip the expensive checkDockRowStatus network call for read-only actions.
        // The local state is refreshed every poll cycle (1-3s during activity, 8s settling)
        // so it's reliable enough for reads. Mutations still do the full server check.
        clearForcedPendingSku(options.sku ?? normalizedSku);
        return true;
      }

      if (normalizedSku && isRowLevelMutationAction) {
        const currentRow = currentRows.find((row) => row.sku.trim().toUpperCase() === normalizedSku);
        if (!currentRow) {
          toast({
            title: "Item no longer available",
            description: `${options.sku} was removed by another user or action.`,
            variant: "destructive",
          });
          return false;
        }

        const hasPendingGhost = pendingSubmitsRef.current.has(normalizedSku) || pendingCsvSkusRef.current.has(normalizedSku);
        const hasForcedPending = forcedPendingSkusRef.current.has(normalizedSku);
        const hasError = currentErrorsBySku.has(normalizedSku);
        const hasBackendPendingAction = Boolean(currentRow.pendingActionType) || currentPendingActionsBySku.has(normalizedSku);
        const isProcessing =
          hasBackendPendingAction ||
          (!hasCompletedProcessedAt(currentRow.processedAt) && !isStaleProcessing(currentRow, currentRows));

        if (hasPendingGhost) {
          showDockActionBlockedToast(options.actionLabel, options.sku, "pending");
          return false;
        }

        if (hasError || hasForcedPending || isProcessing) {
          showDockActionBlockedToast(
            options.actionLabel,
            options.sku,
            hasError ? "error" : hasBackendPendingAction ? "other-user" : "processing",
          );
          return false;
        }

        setGuardingActionSku(normalizedSku);
        setGuardingActionLabel(options.actionLabel);

        try {
          const rowStatus = await checkDockRowStatus(options.sku ?? normalizedSku);

          if (rowStatus.success) {
            const rowStatusPending = rowStatus.pending || rowStatus.dockActionPending;
            const locked =
              !rowStatus.existsInDock ||
              rowStatusPending ||
              !rowStatus.actionable ||
              Boolean(rowStatus.error?.trim());
            if (locked) {
              if (rowStatusPending) {
                markSkuAsForcedPending(options.sku ?? normalizedSku);
              } else {
                clearForcedPendingSku(options.sku ?? normalizedSku);
              }
              queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
                /* non-fatal */
              });
              if (!rowStatus.existsInDock) {
                toast({
                  title: "Item no longer available",
                  description: `${options.sku} was removed by another user or action.`,
                  variant: "destructive",
                });
                return false;
              }
              const reason = rowStatus.error?.trim() ? "error" : rowStatusPending ? "other-user" : "processing";
              showDockActionBlockedToast(options.actionLabel, options.sku, reason);
              return false;
            }

            const backendSubmittedAt = rowStatus.latestSubmittedAt?.trim();
            const currentSubmittedAt = currentRow.submittedAt?.trim();
            if (
              backendSubmittedAt &&
              currentSubmittedAt &&
              !isSameDockSubmissionTimestamp(currentSubmittedAt, backendSubmittedAt)
            ) {
              const refreshedRows = await refreshRecentSubmissionsForAction();
              const refreshedRow = refreshedRows.find((row) => row.sku.trim().toUpperCase() === normalizedSku);
              if (!refreshedRow) {
                toast({
                  title: "Item no longer available",
                  description: `${options.sku} was removed by another user or action.`,
                  variant: "destructive",
                });
                return false;
              }
              if (!isSameDockSubmissionTimestamp(refreshedRow.submittedAt, backendSubmittedAt)) {
                toast({
                  title: "Loading Dock updated",
                  description: `${options.sku} changed in another session. Review the latest row and try again.`,
                  variant: "destructive",
                });
                return false;
              }
            }
          } else {
            // Status check failed — allow through; server validates independently.
            console.warn(`[guard] checkDockRowStatus failed for ${normalizedSku}, proceeding (server validates independently)`);
          }

          clearForcedPendingSku(options.sku ?? normalizedSku);
          return true;
        } finally {
          setGuardingActionSku((current) => (current === normalizedSku ? null : current));
          setGuardingActionLabel((current) => (current === options.actionLabel ? null : current));
        }
      }

      if (!normalizedSku && !isReadOnlyAction) {
        const hasLockedCurrentRows =
          currentRows.some((row) => isSubmissionLocked(row, currentErrorsBySku, currentRows)) ||
          pendingSubmitsRef.current.size > 0 ||
          pendingCsvSkusRef.current.size > 0;
        if (hasLockedCurrentRows) {
          showDockActionBlockedToast(options.actionLabel);
          return false;
        }
      }

      // ── Always refresh dock data on any action click ──
      // Use a short timeout so clicks don't feel frozen if the network is slow.
      const freshRows = await refreshRecentSubmissionsForAction();
      const freshErrorsBySku = buildBackendErrorsBySku();
      const freshPendingActionsBySku = buildBackendPendingActionsBySku();

      // ── FAST PATH: If the item is clearly not locked, skip ALL network calls ──
      if (normalizedSku) {
        const currentRow = freshRows.find((row) => row.sku.trim().toUpperCase() === normalizedSku);
        if (!currentRow) {
          // Item no longer exists — another user may have deleted it
          toast({
            title: "Item no longer available",
            description: `${options.sku} was removed by another user or action.`,
            variant: "destructive",
          });
          return false;
        }
        const hasPendingGhost = pendingSubmitsRef.current.has(normalizedSku) || pendingCsvSkusRef.current.has(normalizedSku);
        const hasForcedPending = forcedPendingSkusRef.current.has(normalizedSku);
        const hasError = freshErrorsBySku.has(normalizedSku);
        const hasBackendPendingAction = Boolean(currentRow?.pendingActionType) || freshPendingActionsBySku.has(normalizedSku);
        const isProcessing = currentRow
          ? hasBackendPendingAction ||
            (!hasCompletedProcessedAt(currentRow.processedAt) && !isStaleProcessing(currentRow, freshRows))
          : false;

        const clearlyNotLocked = !isProcessing && !hasError && !hasPendingGhost && !hasForcedPending;
        if (clearlyNotLocked) {
          return true;
        }
        // Single-SKU non-read-only, non-row-level actions should have been
        // caught by the row-level mutation path above. If we reach here,
        // the item IS locked according to fresh data — block it.
        showDockActionBlockedToast(options.actionLabel, options.sku,
          freshErrorsBySku.has(normalizedSku) ? "error" : "processing");
        return false;
      } else {
        // Bulk action: if no rows are locked, proceed immediately.
        const anyLocked = freshRows.some((sub) => isSubmissionLocked(sub, freshErrorsBySku, freshRows)) ||
          pendingSubmitsRef.current.size > 0 ||
          pendingCsvSkusRef.current.size > 0;
        if (!anyLocked) {
          return true;
        }
        // Rows are locked — block the bulk action.
        showDockActionBlockedToast(options.actionLabel);
        return false;
      }
    },
    [buildBackendErrorsBySku, buildBackendPendingActionsBySku, clearForcedPendingSku, isSubmissionLocked, queryClient, refreshRecentSubmissionsForAction, showDockActionBlockedToast, startDockActionPollingBurst, submissions, toast],
  );

  const surfacedBackendErrorRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const affectedSkus: string[] = [];
    const pendingSubmits = pendingSubmitsRef.current;
    const pendingCsv = pendingCsvSkusRef.current;
    const surfaced = surfacedBackendErrorRef.current;

    for (const [normalizedSku, message] of backendErrorsBySku.entries()) {
      const hasPendingGhost = pendingSubmits.has(normalizedSku) || pendingCsv.has(normalizedSku);
      if (!hasPendingGhost) continue;

      pendingSubmits.delete(normalizedSku);
      pendingCsv.delete(normalizedSku);
      overrideSkusRef.current.delete(normalizedSku);
      removePendingDockSubmit(normalizedSku);
      affectedSkus.push(normalizedSku);

      if (surfaced.get(normalizedSku) !== message) {
        surfaced.set(normalizedSku, message);
        toast({
          variant: "destructive",
          title: "Submission failed",
          description: `${normalizedSku}: ${message}. Re-submit the product from the Form. If this keeps happening, contact Eran.`,
        });
      }
    }

    for (const key of Array.from(surfaced.keys())) {
      if (!backendErrorsBySku.has(key)) surfaced.delete(key);
    }

    if (affectedSkus.length === 0) return;
    const affected = new Set(affectedSkus);
    queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) => {
      if (!old) return old;
      return old.filter((row) => {
        const normalizedSku = row.sku.trim().toUpperCase();
        if (!affected.has(normalizedSku)) return true;
        return !row.id.startsWith("pending-submit-") && !row.id.startsWith("pending-csv-");
      });
    });
    queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
      /* non-fatal */
    });
  }, [backendErrorsBySku, queryClient, toast]);

  const sortedSubmissions = useMemo(() => {
    const next = [...displaySubmissions];
    next.sort((a, b) => {
      const aTs = parseDockTimestamp(a.processedAt || a.submittedAt);
      const bTs = parseDockTimestamp(b.processedAt || b.submittedAt);
      if (aTs !== bTs) {
        return dateSortDirection === "desc" ? bTs - aTs : aTs - bTs;
      }
      return a.sku.localeCompare(b.sku);
    });
    return next;
  }, [displaySubmissions, dateSortDirection]);

  const failedSkus = useMemo(() => {
    if (sortedSubmissions.length === 0) return [] as string[];
    const out: string[] = [];
    for (const sub of sortedSubmissions) {
      const normalized = sub.sku.trim().toUpperCase();
      if (!normalized) continue;
      if (backendErrorsBySku.has(normalized)) out.push(sub.sku.trim());
    }
    return out;
  }, [backendErrorsBySku, sortedSubmissions]);

  const clearFailedMutation = useMutation({
    mutationFn: async (skus: string[]) => {
      return await clearDockFailures(skus);
    },
    onMutate: () => {
      pausePolling();
    },
    onSuccess: async (result, skus) => {
      if (!result.success) {
        toast({ title: "Sync issue", description: result.error || "Failed to clear failures — try again shortly. If this persists, contact Eran.", variant: "destructive" });
        return;
      }

      const clearedNorm = new Set((result.cleared ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean));
      for (const sku of (skus ?? [])) {
        const n = sku.trim().toUpperCase();
        if (!n) continue;
        if (clearedNorm.has(n)) {
          stableBadgeStateRef.current.delete(n);
          surfacedBackendErrorRef.current.delete(n);
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
      toast({
        title: "Cleared",
        description: `Cleared ${result.cleared.length} failed item${result.cleared.length === 1 ? "" : "s"}.`,
      });
    },
    onError: () => {
      toast({ title: "Sync issue", description: "Failed to clear failures — try again shortly. If this persists, contact Eran.", variant: "destructive" });
    },
    onSettled: () => {
      resumePolling();
    },
  });

  const handleClearFailed = useCallback(() => {
    if (failedSkus.length === 0) return;
    clearFailedMutation.mutate(failedSkus);
  }, [clearFailedMutation, failedSkus]);

  useEffect(() => {
    const visibleSkus = new Set(submissions.map((row) => row.sku.trim().toUpperCase()));
    const stableMap = stableBadgeStateRef.current;
    for (const sku of Array.from(stableMap.keys())) {
      if (!visibleSkus.has(sku)) stableMap.delete(sku);
    }
  }, [submissions]);

  const hasLockedRows = useMemo(
    () =>
      submissions.some((sub) => isSubmissionLocked(sub, backendErrorsBySku, submissions)),
    [backendErrorsBySku, isSubmissionLocked, submissions],
  );

  useEffect(() => {
    pruneRecentCsvUploads();
    if (submissions.length === 0) return;
    const recent = recentCsvUploadsRef.current;
    const pendingCsvSkus = pendingCsvSkusRef.current;
    for (const row of submissions) {
      if (row.id.startsWith("pending-csv-")) continue;
      const normalized = row.sku.trim().toUpperCase();
      if (!normalized) continue;
      recent.delete(normalized);

      // Release upload-pending lock only after backend completion (or explicit backend error).
      if (pendingCsvSkus.has(normalized)) {
        const isComplete = hasCompletedProcessedAt(row.processedAt) || backendErrorsBySku.has(normalized);
        if (isComplete) pendingCsvSkus.delete(normalized);
      }
    }
  }, [submissions, pruneRecentCsvUploads, backendErrorsBySku]);

  useEffect(() => {
    pruneForcedPendingSkus();
    const forcedPending = forcedPendingSkusRef.current;
    if (forcedPending.size === 0) return;

    const dockEntriesMeta = getLastDockEntriesMeta();
    if (dockEntriesMeta.stale || dockEntriesMeta.degraded) return;

    const visibleSkus = new Set(submissions.map((row) => row.sku.trim().toUpperCase()).filter(Boolean));
    for (const row of submissions) {
      const normalizedSku = row.sku.trim().toUpperCase();
      if (!forcedPending.has(normalizedSku)) continue;
      if (backendErrorsBySku.has(normalizedSku) || hasCompletedProcessedAt(row.processedAt)) {
        forcedPending.delete(normalizedSku);
      }
    }
    for (const sku of Array.from(forcedPending.keys())) {
      if (!visibleSkus.has(sku)) forcedPending.delete(sku);
    }
  }, [backendErrorsBySku, pruneForcedPendingSkus, submissions]);

  // ── Override flag cleanup (moved from render path to useEffect) ──
  // When a SKU is no longer processing/pending/forced, clear its override flag
  // so the badge correctly transitions from "Overriding" → cleared.
  useEffect(() => {
    const overrides = overrideSkusRef.current;
    if (overrides.size === 0) return;

    for (const normalizedSku of Array.from(overrides)) {
      const hasPendingGhost = pendingSubmitsRef.current.has(normalizedSku) || pendingCsvSkusRef.current.has(normalizedSku);
      const hasForcedPending = forcedPendingSkusRef.current.has(normalizedSku);
      const row = submissions.find((s) => s.sku.trim().toUpperCase() === normalizedSku);
      const isProcessing = row ? !hasCompletedProcessedAt(row.processedAt) && !isStaleProcessing(row, submissions) : false;

      if (!isProcessing && !hasPendingGhost && !hasForcedPending) {
        overrides.delete(normalizedSku);
      }
    }
  }, [submissions]);

  useEffect(() => {
    const dockEntriesMeta = getLastDockEntriesMeta();
    if (dockEntriesMeta.stale || dockEntriesMeta.degraded) return;
    if (sharedSnapshotSweepInFlightRef.current) return;

    const now = Date.now();
    const lastSweepAt = readSharedDockSnapshotSweepAt();
    if ((now - lastSweepAt) < SHARED_DOCK_SNAPSHOT_SWEEP_INTERVAL_MS) return;

    const activeSkus = Array.from(new Set([
      ...submissions.map((entry) => entry.sku.trim()),
      ...Array.from(pendingSubmitsRef.current.values()).map((entry) => entry.entry.sku.trim()),
      ...Array.from(pendingCsvSkusRef.current.values()),
    ].filter(Boolean)));
    const previousSweepAt = lastSweepAt;

    sharedSnapshotSweepInFlightRef.current = true;
    writeSharedDockSnapshotSweepAt(now);
    void cleanupOrphanedSharedDockFormSnapshots(activeSkus).catch((error) => {
      console.warn("Failed to sweep orphaned shared Loading Dock snapshots:", error);
      writeSharedDockSnapshotSweepAt(previousSweepAt > 0 ? previousSweepAt : 0);
    }).finally(() => {
      sharedSnapshotSweepInFlightRef.current = false;
    });
  }, [submissions]);

  const totalPages = Math.max(1, Math.ceil(sortedSubmissions.length / PAGE_SIZE));
  const paged = sortedSubmissions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  /** Optimistically remove SKUs while temporarily filtering them from polled results. */
  const optimisticRemove = useCallback(
    (skusToRemove: string[]) => {
      const normalizedSkus = skusToRemove.map((sku) => sku.trim().toUpperCase()).filter(Boolean);
      if (normalizedSkus.length === 0) return;
      addPendingRemovals(normalizedSkus);
      // Also clear any optimistic submit entries so they don't get re-injected
      for (const sku of normalizedSkus) {
        pendingSubmitsRef.current.delete(sku);
        pendingCsvSkusRef.current.delete(sku);
        overrideSkusRef.current.delete(sku);
        removePendingDockSubmit(sku);
      }
      const removeSet = new Set(normalizedSkus);
      queryClient.cancelQueries({ queryKey: ["recent-submissions"] });
      queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) =>
        old ? old.filter((s) => !removeSet.has(s.sku.trim().toUpperCase())) : [],
      );
    },
    [queryClient, addPendingRemovals],
  );

  const cleanupSharedDockSnapshots = useCallback((skus: string[]) => {
    const normalizedSkus = Array.from(new Set(
      skus
        .map((sku) => sku.trim().toUpperCase())
        .filter(Boolean),
    ));
    if (normalizedSkus.length === 0) return;

    void Promise.allSettled(
      normalizedSkus.map((sku) => deleteSharedDockFormSnapshotsForSku(sku)),
    ).then((results) => {
      const failedSkus = normalizedSkus.filter((_, index) => results[index]?.status === "rejected");
      if (failedSkus.length > 0) {
        console.warn("Failed to prune shared Loading Dock snapshots for removed SKUs:", failedSkus);
      }
    });
  }, []);

  const deleteMutation = useMutation({
    mutationFn: ({ sku, submittedAt, shouldComplete }: { sku: string; submittedAt?: string; shouldComplete?: boolean }) =>
      deleteSubmission(sku, sku, { submittedAt, markComplete: shouldComplete === true }),
    onMutate: async ({ sku }) => {
      pausePolling();
      markActionPending([sku], "Deleting…");
    },
    onSuccess: (result, { sku, submittedAt, shouldComplete }) => {
      if (result?.pending) {
        clearActionPending([sku]);
        markSkuAsForcedPending(sku);
        markSkuAsForceFreshDockRead(sku);
        queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
          /* non-fatal */
        });
        toast({
          title: "Delete queued",
          description: result.reason || `Delete for ${sku} is queued and will complete shortly — refresh in a moment.`,
        });
        return;
      }

      // Now confirmed by server — hide the row
      clearActionPending([sku]);
      clearPendingSubmitGhost(sku);
      addPendingRemovals([{ sku, submittedAt }]);
      queryClient.cancelQueries({ queryKey: ["recent-submissions"] });
      queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) =>
        old ? old.filter((s) => s.sku.trim().toUpperCase() !== sku.trim().toUpperCase()) : [],
      );
      cleanupSharedDockSnapshots([sku]);
      markSkuAsForceFreshDockRead(sku);
      if (shouldComplete && result?.warning?.trim()) {
        syncSkuCompleteInBackground(sku, "Delete");
        toast({ title: "Removed", description: "Entry removed from dock. COMPLETE status is retrying in the background." });
        return;
      }
      if (shouldComplete) {
        toast({ title: "Removed", description: "Entry removed from dock and marked COMPLETE." });
        return;
      }
      toast({ title: "Removed", description: "Entry removed from dock." });
    },
    onError: (_error, { sku }) => {
      clearActionPending([sku]);
      queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
      toast({ title: "Sync issue", description: "Failed to remove entry — try again shortly. If this persists, contact Eran.", variant: "destructive" });
    },
    onSettled: () => {
      resumePolling();
    },
  });

  const persistLoadedDockSnapshot = useCallback(
    (
      formState: DockLoadedFormState,
      options?: {
        submittedAtEpochMs?: number | null;
        submittedAtSource?: "client" | "backend";
        datasheetFile?: File | null;
        websitePdfFile?: File | null;
        syncShared?: boolean;
        reason?: string;
      },
    ): DockFormSnapshot | null => {
      const snapshotRecord = upsertDockFormSnapshot(
        buildDockFormSnapshotDraftFromLoadedState(formState, {
          submittedAtEpochMs: options?.submittedAtEpochMs,
          submittedAtSource: options?.submittedAtSource,
        }),
        {
          datasheetFile: options?.datasheetFile ?? null,
          websitePdfFile: options?.websitePdfFile ?? null,
        },
      );

      if (
        snapshotRecord &&
        options?.syncShared !== false &&
        Number.isFinite(Number(snapshotRecord.submittedAtEpochMs)) &&
        Number(snapshotRecord.submittedAtEpochMs) > 0
      ) {
        void saveSharedDockFormSnapshot(snapshotRecord).catch((error) => {
          console.warn(
            `[LoadingDock] shared snapshot sync failed after ${options?.reason ?? "dock action"} for ${snapshotRecord.sku}:`,
            error,
          );
        });
      }

      return snapshotRecord;
    },
    [],
  );

  const primeUploadedDockSnapshot = useCallback(
    async (sku: string, submittedAtEpochMs?: number) => {
      if (!Number.isFinite(Number(submittedAtEpochMs)) || Number(submittedAtEpochMs) <= 0) return;

      const submittedAtIso = new Date(Number(submittedAtEpochMs)).toISOString();
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await readOutputWorkForSku(sku, {
          timeoutMs: READ_ONLY_FRESH_FETCH_TIMEOUT_MS,
          submittedAt: submittedAtIso,
        }).catch((error) => ({
          success: false as const,
          error: error instanceof Error ? error.message : String(error),
        }));

        if (result.success && result.formData) {
          const authoritativeFormState = buildAuthoritativeDockFormState(result.formData, null, {
            requestedSku: sku,
            rowSubmittedAtEpochMs: Number(submittedAtEpochMs),
          });
          persistLoadedDockSnapshot(authoritativeFormState, {
            submittedAtEpochMs,
            submittedAtSource: "backend",
            syncShared: true,
            reason: "CSV upload",
          });
          return;
        }

        if (attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 300 * (attempt + 1)));
        }
      }

      console.warn(`[LoadingDock] Could not prime shared snapshot after CSV upload for ${sku}.`);
    },
    [persistLoadedDockSnapshot],
  );

  /** Process a CSV File object: read text, call edge function, refresh */
  const processCsvFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".csv")) {
        toast({ variant: "destructive", title: "Invalid File", description: "Please upload a .csv file." });
        return;
      }
      pausePolling();
      let pendingSku = "";
      try {
        const csvText = await file.text();
        const parsedSku = extractSkuFromCsv(csvText);
        if (!parsedSku) {
          toast({
            variant: "destructive",
            title: "CSV format not supported",
            description:
              "This file doesn’t match the expected template. Please export a product CSV with a valid SKU column and try again.",
          });
          resumePolling();
          return;
        }

        const trimmedSku = parsedSku.trim();
        const normalizedSku = trimmedSku.toUpperCase();
        const cachedSubmissions = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? [];
        const alreadyInDock = cachedSubmissions.some((entry) => entry.sku.trim().toUpperCase() === normalizedSku);
        pruneRecentCsvUploads();
        const recentlyUploaded = recentCsvUploadsRef.current.has(normalizedSku);

        if (alreadyInDock || pendingCsvSkusRef.current.has(normalizedSku) || recentlyUploaded) {
          toast({
            title: "Already in Loading Dock",
            description: `SKU ${trimmedSku} is already in the Loading Dock.`,
          });
          resumePolling();
          return;
        }

        pendingSku = normalizedSku;
        pendingCsvSkusRef.current.add(normalizedSku);

        const csvSubmittedAt = new Date().toISOString();
        injectPendingSubmit(
          {
            sku: trimmedSku,
            submittedAt: csvSubmittedAt,
            submittedAtEpochMs: Date.now(),
            isOverwrite: false,
            source: "csv",
          },
          { scrollToTop: true, persist: false },
        );

        toast({ title: "CSV Upload Started", description: `Uploading ${trimmedSku} to Loading Dock.` });

        // Run background task
        (async () => {
          try {
            const result = await uploadCsvToOutputWork(csvText);
            if (result.success) {
              if (result.pending) {
                queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
                toast({
                  title: "Upload still processing",
                  description: `CSV for ${trimmedSku} is taking longer than usual. It may still appear shortly in Loading Dock.`,
                });
                return;
              }
              const uploadedSku = (result.sku || trimmedSku).trim();
              if (uploadedSku) {
                clearPendingRemovals([uploadedSku]);
                rememberRecentCsvUpload(uploadedSku);
                finalizePendingSubmitGhost(uploadedSku, result.processedAt);
                void primeUploadedDockSnapshot(uploadedSku, result.submittedAtEpochMs);
              }
              queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
              toast({
                title: "CSV Uploaded",
                description: `SKU ${uploadedSku || trimmedSku} is now in Loading Dock.`,
              });
            } else {
              const details = mapCsvUploadError(result.error);
              toast(details);
              if (pendingSku) clearPendingSubmitGhost(pendingSku);
              queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (isEdgeFunctionTimeoutErrorMessage(message)) {
              toast({
                title: "Upload still processing",
                description: `CSV for ${trimmedSku} is taking longer than usual. It may still appear shortly in Loading Dock.`,
              });
              queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
              return;
            }
            toast({ title: "Upload issue", description: "Background upload failed — try again shortly. If this persists, contact Eran.", variant: "destructive" });
            if (pendingSku) clearPendingSubmitGhost(pendingSku);
            queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
          } finally {
            resumePolling();
          }
        })();
      } catch (err) {
        toast({ title: "Upload issue", description: "Upload could not complete — try again shortly. If this persists, contact Eran.", variant: "destructive" });
        if (pendingSku) clearPendingSubmitGhost(pendingSku);
        resumePolling();
      }
    },
    [
      toast,
      queryClient,
      clearPendingRemovals,
      pausePolling,
      resumePolling,
      pruneRecentCsvUploads,
      rememberRecentCsvUpload,
      clearPendingSubmitGhost,
      finalizePendingSubmitGhost,
      injectPendingSubmit,
      primeUploadedDockSnapshot,
    ],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) processCsvFile(file);
    },
    [processCsvFile],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processCsvFile(file);
      // Reset input so the same file can be re-uploaded
      e.target.value = "";
    },
    [processCsvFile],
  );

  const getSubmissionHintForSku = useCallback(
    (
      sku: string,
      rows: RecentSubmission[] = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions,
    ): string | undefined => {
      const normalizedSku = sku.trim().toUpperCase();
      if (!normalizedSku) return undefined;
      return rows.find((row) => row.sku.trim().toUpperCase() === normalizedSku)?.submittedAt?.trim() || undefined;
    },
    [queryClient, submissions],
  );

  const getCachedDockCsvForSubmission = useCallback(
    (
      sku: string,
      rows: RecentSubmission[] = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions,
    ): string | null => {
      const normalizedSku = sku.trim().toUpperCase();
      if (!normalizedSku || shouldForceFreshDockRead(normalizedSku)) return null;

      const dockEntriesMeta = getLastDockEntriesMeta();
      if (dockEntriesMeta.stale || dockEntriesMeta.degraded) return null;

      const matchingRow = rows.find((row) => row.sku.trim().toUpperCase() === normalizedSku);
      if (!matchingRow || !hasCompletedProcessedAt(matchingRow.processedAt) || Boolean(matchingRow.pendingActionType)) {
        return null;
      }

      const cachedEntry = csvCache.current.get(normalizedSku) ?? csvCache.current.get(sku);
      if (!cachedEntry?.csvText?.trim()) return null;
      if (
        !cachedEntry.submittedAt ||
        !isSameDockSubmissionTimestamp(cachedEntry.submittedAt, matchingRow.submittedAt)
      ) {
        csvCache.current.delete(normalizedSku);
        csvCache.current.delete(sku);
        return null;
      }
      if (
        !Number.isFinite(cachedEntry.cachedAtMs) ||
        cachedEntry.cachedAtMs <= 0 ||
        (Date.now() - cachedEntry.cachedAtMs) > MAX_SYNCED_DOCK_CSV_AGE_MS
      ) {
        csvCache.current.delete(normalizedSku);
        csvCache.current.delete(sku);
        return null;
      }

      return cachedEntry.csvText;
    },
    [queryClient, shouldForceFreshDockRead, submissions],
  );

  /** Download the 2-row CSV for a given SKU from Loading Dock */
  const handleDownload = useCallback(
    async (sku: string) => {
      setDownloadingSkus((prev) => new Set(prev).add(sku));
      try {
        const allowed = await refreshDockActionGuard({ sku, actionLabel: "Download" });
        if (!allowed) return;

        const latestRows = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions;
        const normalizedSku = sku.trim().toUpperCase();
        const submittedAtHint = getSubmissionHintForSku(sku, latestRows);
        const cachedCsv = getCachedDockCsvForSubmission(sku, latestRows);
        const result = cachedCsv
          ? { success: true as const, csvText: cachedCsv }
          : await downloadCsvForSku(sku, { submittedAt: submittedAtHint });

        if (!result.success || !result.csvText) {
          const isTimeout = result.error && /\b(timed?\s*out|timeout|abort(?:ed)?)\b/i.test(result.error);
          toast({
            title: isTimeout ? "Download timed out" : "Still processing...",
            description: isTimeout
              ? `The download for ${sku} timed out due to temporary server load. The product data is safe — please try again in a few seconds.`
              : (result.error || `Product ${sku} is still being processed in the background queue. Please wait a few seconds and try again.`),
            variant: "destructive",
          });
          return;
        }

        const resolvedCsvText = result.csvText;
        const cacheEntry: CachedDockCsvEntry = {
          csvText: resolvedCsvText,
          submittedAt: result.submittedAt?.trim() || submittedAtHint || "",
          cachedAtMs: Date.now(),
        };
        csvCache.current.set(normalizedSku, cacheEntry);
        csvCache.current.set(sku, cacheEntry);
        clearForceFreshDockRead(normalizedSku);
        const blob = new Blob([resolvedCsvText], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${sku}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        const isTimeout = /\b(timed?\s*out|timeout|abort(?:ed)?)\b/i.test(message);
        toast({
          title: isTimeout ? "Download timed out" : "Download failed",
          description: isTimeout
            ? `The download for ${sku} timed out due to temporary server load. The product data is safe — please try again in a few seconds.`
            : `Could not download CSV for ${sku}. Please try again in a few seconds.`,
          variant: "destructive",
        });
      } finally {
        setDownloadingSkus((prev) => {
          const s = new Set(prev);
          s.delete(sku);
          return s;
        });
      }
    },
    [clearForceFreshDockRead, getCachedDockCsvForSubmission, getSubmissionHintForSku, queryClient, refreshDockActionGuard, submissions, toast],
  );

  // handleComingSoon removed — was dead code (no UI references it)

  const handleSendEmail = useCallback(
    async (sku: string, options?: { skipGuard?: boolean }) => {
      // Badge should already be set by caller; set it here too for direct calls
      pausePolling();
      markActionPending([sku], "Sending…");

      if (!options?.skipGuard) {
        const allowed = await refreshDockActionGuard({ sku, actionLabel: "Send Email" });
        if (!allowed) {
          clearActionPending([sku]);
          resumePolling();
          return;
        }
      }

      (async () => {
        try {
          const latestRows = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions;
          const submittedAtHint = getSubmissionHintForSku(sku, latestRows);
          const result = await logEmailSingle(sku, { submittedAt: submittedAtHint });

          // Normal case: Apps Script work is queued; don't show as a hard failure.
          if (result.success && result.pending) {
            clearActionPending([sku]);
            markSkuAsForcedPending(sku);
            markSkuAsForceFreshDockRead(sku);
            queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
              /* non-fatal */
            });
            toast({
              title: "Email queued",
              description: result.reason || `Email for ${sku} is queued and will send shortly — refresh in a moment.`,
            });
            return;
          }

          if (result.success) {
            // Server confirmed — now hide the row
            clearActionPending([sku]);
            clearPendingSubmitGhost(sku);
            addPendingRemovals([{ sku, submittedAt: submittedAtHint }]);
            queryClient.cancelQueries({ queryKey: ["recent-submissions"] });
            queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) =>
              old ? old.filter((s) => s.sku.trim().toUpperCase() !== sku.trim().toUpperCase()) : [],
            );
            cleanupSharedDockSnapshots([sku]);
            markSkuAsForceFreshDockRead(sku);
            if (result.warning?.trim()) {
              syncSkuCompleteInBackground(sku, "Email");
              toast({
                title: "Email Sent",
                description: `Email was sent for ${sku}. COMPLETE status is retrying in the background.`,
              });
            } else {
              toast({ title: "Email Sent", description: `Email was sent for ${sku} and marked COMPLETE.` });
            }
          } else {
            clearActionPending([sku]);
            queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
              /* non-fatal */
            });
            toast({ title: "Sync issue", description: result.error || "Failed to queue email — try again shortly. If this persists, contact Eran.", variant: "destructive" });
          }
        } catch {
          clearActionPending([sku]);
          queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
          toast({ title: "Sync issue", description: "Could not send email right now — try again shortly. If this persists, contact Eran.", variant: "destructive" });
        } finally {
          resumePolling();
        }
      })();
    },
    [toast, queryClient, submissions, getSubmissionHintForSku, addPendingRemovals, cleanupSharedDockSnapshots, clearActionPending, clearPendingSubmitGhost, markActionPending, markSkuAsForceFreshDockRead, markSkuAsForcedPending, pausePolling, refreshDockActionGuard, resumePolling, syncSkuCompleteInBackground],
  );

  /** Caches for last successful reads – survive HMR / transient failures */
  const outputWorkCache = useRef<Map<string, OutputWorkFormData>>(new Map());
  const outputWorkInflight = useRef<Map<string, Promise<{ success: boolean; formData?: OutputWorkFormData; error?: string }>>>(
    new Map(),
  );
  const emailCache = useRef<Map<string, CachedDockEmailEntry>>(new Map());
  const emailInflight = useRef<Map<string, Promise<{ success: boolean; email?: string; row?: number; submittedAt?: string; error?: string }>>>(
    new Map(),
  );

  // Pre-populate outputWorkCache from formDataMap returned by fetchDockEntries
  useEffect(() => {
    const processingSkuSet = new Set(
      submissions
        .filter((row) => !hasCompletedProcessedAt(row.processedAt))
        .map((row) => row.sku.trim().toUpperCase()),
    );
    for (const key of Array.from(outputWorkCache.current.keys())) {
      if (processingSkuSet.has(key.trim().toUpperCase())) {
        outputWorkCache.current.delete(key);
      }
    }

    const formDataMap = getLastFormDataMap();
    if (formDataMap) {
      for (const [sku, formData] of Object.entries(formDataMap)) {
        const normalizedSku = sku.trim().toUpperCase();
        if (processingSkuSet.has(normalizedSku) || shouldForceFreshDockRead(normalizedSku)) continue;
        outputWorkCache.current.set(normalizedSku, formData);
      }
    }
  }, [shouldForceFreshDockRead, submissions]);

  /** Fetch product data and open view dialog */
  /** Retry wrapper – attempts up to `retries` times with a delay between attempts */
  const retryFetch = useCallback(async <T,>(fn: () => Promise<T>, retries = 2, delayMs = 2000): Promise<T> => {
    let lastError: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (i < retries) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  }, []);

  const getCachedOutputWork = useCallback((sku: string): OutputWorkFormData | null => {
    const normalizedSku = sku.trim().toUpperCase();
    if (!normalizedSku) return null;
    if (shouldForceFreshDockRead(normalizedSku)) return null;

    const formDataMap = getLastFormDataMap();
    const cached =
      outputWorkCache.current.get(normalizedSku) ??
      outputWorkCache.current.get(sku) ??
      formDataMap?.[normalizedSku] ??
      formDataMap?.[sku];

    if (cached) {
      outputWorkCache.current.set(normalizedSku, cached);
      return cached;
    }

    if (!formDataMap) return null;
    for (const [key, formData] of Object.entries(formDataMap)) {
      if (key.trim().toUpperCase() !== normalizedSku) continue;
      outputWorkCache.current.set(normalizedSku, formData);
      return formData;
    }

    return null;
  }, [shouldForceFreshDockRead]);

  const getSyncedDockFormData = useCallback(
    (sku: string, rows: RecentSubmission[] = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions): OutputWorkFormData | null => {
      const normalizedSku = sku.trim().toUpperCase();
      if (!normalizedSku) return null;
      if (shouldForceFreshDockRead(normalizedSku)) return null;

      const dockEntriesMeta = getLastDockEntriesMeta();
      const formDataMeta = getLastFormDataMapMeta();
      if (dockEntriesMeta.stale || dockEntriesMeta.degraded || formDataMeta.stale || formDataMeta.degraded) {
        return null;
      }
      if (
        !Number.isFinite(formDataMeta.syncedAtMs) ||
        formDataMeta.syncedAtMs <= 0 ||
        (Date.now() - formDataMeta.syncedAtMs) > MAX_SYNCED_DOCK_FORM_DATA_AGE_MS
      ) {
        return null;
      }

      const matchingRow = rows.find((row) => row.sku.trim().toUpperCase() === normalizedSku);
      if (!matchingRow || !hasCompletedProcessedAt(matchingRow.processedAt) || Boolean(matchingRow.pendingActionType)) {
        return null;
      }

      const formDataMap = getLastFormDataMap();
      if (!formDataMap) return null;

      const direct =
        formDataMap[normalizedSku] ??
        formDataMap[sku];
      if (direct) {
        outputWorkCache.current.set(normalizedSku, direct);
        return direct;
      }

      for (const [key, formData] of Object.entries(formDataMap)) {
        if (key.trim().toUpperCase() !== normalizedSku) continue;
        outputWorkCache.current.set(normalizedSku, formData);
        return formData;
      }

      return null;
    },
    [queryClient, shouldForceFreshDockRead, submissions],
  );

  const getCachedDockEmailForSubmission = useCallback(
    (
      sku: string,
      rows: RecentSubmission[] = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions,
    ): string | null => {
      const normalizedSku = sku.trim().toUpperCase();
      if (!normalizedSku) return null;
      if (shouldForceFreshDockRead(normalizedSku)) return null;

      const matchingRow = rows.find((row) => row.sku.trim().toUpperCase() === normalizedSku);
      if (!matchingRow || !hasCompletedProcessedAt(matchingRow.processedAt) || Boolean(matchingRow.pendingActionType)) {
        return null;
      }

      const cachedEntry = emailCache.current.get(normalizedSku) ?? emailCache.current.get(sku);
      if (!cachedEntry) return null;
      if (
        !cachedEntry.submittedAt ||
        !isSameDockSubmissionTimestamp(cachedEntry.submittedAt, matchingRow.submittedAt)
      ) {
        clearDockSubmissionScopedEntries(emailCache.current, sku);
        return null;
      }
      if (
        !Number.isFinite(cachedEntry.cachedAtMs) ||
        cachedEntry.cachedAtMs <= 0 ||
        (Date.now() - cachedEntry.cachedAtMs) > MAX_SYNCED_DOCK_EMAIL_AGE_MS
      ) {
        clearDockSubmissionScopedEntries(emailCache.current, sku);
        return null;
      }

      return cachedEntry.email;
    },
    [queryClient, shouldForceFreshDockRead, submissions],
  );

  const readOutputWorkCached = useCallback(
    async (
      sku: string,
      options?: { preferFresh?: boolean; freshTimeoutMs?: number; retries?: number; submittedAt?: string },
    ): Promise<{ success: boolean; formData?: OutputWorkFormData; error?: string }> => {
      const normalizedSku = sku.trim().toUpperCase();
      if (!options?.preferFresh) {
        const cached = getCachedOutputWork(sku);
        if (cached) return { success: true, formData: cached };
      }

      const requestKey = buildDockSubmissionCacheKey(normalizedSku, options?.submittedAt);
      const inFlight = outputWorkInflight.current.get(requestKey);
      if (inFlight) return inFlight;

      const request: Promise<{ success: boolean; formData?: OutputWorkFormData; error?: string }> = retryFetch(async () => {
        const result = await readOutputWorkForSku(sku, {
          timeoutMs: options?.freshTimeoutMs ?? READ_ONLY_FRESH_FETCH_TIMEOUT_MS,
          submittedAt: options?.submittedAt,
        });
        if (!result.success && result.error && isEdgeFunctionTimeoutErrorMessage(result.error)) {
          throw new Error(result.error);
        }
        return result;
      }, options?.retries ?? 1, 1500)
        .catch((err) => ({
          success: false,
          formData: undefined,
          error: err instanceof Error ? err.message : "Unknown error",
        }))
        .then((result) => {
          if (result.success && result.formData) {
            outputWorkCache.current.set(normalizedSku, result.formData);
            clearForceFreshDockRead(normalizedSku);
            return result;
          }

          // Timeout/network fallback: prefer cached form data over hard failure so
          // read-only actions (Load into Form / View) remain usable under load.
          const fallbackCached = getCachedOutputWork(sku);
          if (
            fallbackCached &&
            result.error &&
            /\b(timed?\s*out|timeout|abort(?:ed)?|network)\b/i.test(result.error)
          ) {
            outputWorkCache.current.set(normalizedSku, fallbackCached);
            return { success: true, formData: fallbackCached };
          }

          return result;
        })
        .finally(() => {
          outputWorkInflight.current.delete(requestKey);
        });

      outputWorkInflight.current.set(requestKey, request);
      return request;
    },
    [clearForceFreshDockRead, getCachedOutputWork, retryFetch],
  );

  const readDockEmailCached = useCallback(
    async (
      sku: string,
      options?: { submittedAt?: string },
    ): Promise<{ success: boolean; email?: string; row?: number; submittedAt?: string; error?: string }> => {
      const normalizedSku = sku.trim().toUpperCase();
      const submittedAtHint = options?.submittedAt?.trim() || "";
      const submissionKey = buildDockSubmissionCacheKey(normalizedSku, submittedAtHint);
      const cached = emailCache.current.get(normalizedSku) ?? emailCache.current.get(sku);
      if (
        cached &&
        (!submittedAtHint || isSameDockSubmissionTimestamp(cached.submittedAt, submittedAtHint))
      ) {
        return { success: true, email: cached.email, submittedAt: cached.submittedAt };
      }

      const inFlight = emailInflight.current.get(submissionKey);
      if (inFlight) return inFlight;

      const request = readDockEmail(sku, { submittedAt: submittedAtHint || undefined })
        .then((result) => {
          if (result.success) {
            const resolvedSubmittedAt = result.submittedAt?.trim() || submittedAtHint;
            const cacheEntry: CachedDockEmailEntry = {
              email: result.email ?? "",
              submittedAt: resolvedSubmittedAt,
              cachedAtMs: Date.now(),
            };
            emailCache.current.set(normalizedSku, cacheEntry);
            emailCache.current.set(sku, cacheEntry);
          }
          return result;
        })
        .finally(() => {
          emailInflight.current.delete(submissionKey);
        });

      emailInflight.current.set(submissionKey, request);
      return request;
    },
    [],
  );

  const handleView = useCallback(
    async (sku: string) => {
      setViewLoading(sku);
      try {
        const allowed = await refreshDockActionGuard({ sku, actionLabel: "View" });
        if (!allowed) return;

        let latestRows = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions;
        let syncedFormData = getSyncedDockFormData(sku, latestRows);
        if (!syncedFormData) {
          latestRows = await refreshRecentSubmissionsForAction();
          syncedFormData = getSyncedDockFormData(sku, latestRows);
        }

        if (syncedFormData) {
          setViewData(syncedFormData);
          setViewOpen(true);
          return;
        }

        let submittedAtHint = getSubmissionHintForSku(sku, latestRows);
        let result = await readOutputWorkCached(sku, {
          preferFresh: true,
          freshTimeoutMs: READ_ONLY_FRESH_FETCH_TIMEOUT_MS,
          retries: 0,
          submittedAt: submittedAtHint,
        });

        // Retry once with fresh hint if server reports newer data
        if (
          !result.success &&
          result.error &&
          /newer loading dock data/i.test(result.error)
        ) {
          latestRows = await refreshRecentSubmissionsForAction();
          syncedFormData = getSyncedDockFormData(sku, latestRows);
          if (syncedFormData) {
            setViewData(syncedFormData);
            setViewOpen(true);
            return;
          }
          submittedAtHint = getSubmissionHintForSku(sku, latestRows);
          result = await readOutputWorkCached(sku, {
            preferFresh: true,
            freshTimeoutMs: READ_ONLY_FRESH_FETCH_TIMEOUT_MS,
            retries: 0,
            submittedAt: submittedAtHint,
          });
        }

        if (result.success && result.formData) {
          outputWorkCache.current.set(sku.trim().toUpperCase(), result.formData);
          setViewData(result.formData);
          setViewOpen(true);
          return;
        }
        const errorMsg = "error" in result ? (result as { error?: string }).error : undefined;
        console.warn(`Could not load view data for ${sku}:`, errorMsg);
        toast({
          title: "Could not load data",
          description: errorMsg || `Could not load data for ${sku}. Refresh and try again. If this persists, contact Eran.`,
          variant: "destructive",
        });
      } catch (err) {
        console.warn(`View fetch failed for ${sku}, no cache available:`, err);
        toast({
          title: "Could not load data",
          description: `Could not load data for ${sku}. Refresh and try again. If this persists, contact Eran.`,
          variant: "destructive",
        });
      } finally {
        setViewLoading(null);
      }
    },
    [getSubmissionHintForSku, getSyncedDockFormData, queryClient, readOutputWorkCached, refreshDockActionGuard, refreshRecentSubmissionsForAction, submissions, toast],
  );

  /** Actually fetch Loading Dock data and populate the form, then navigate */
  const doEdit = useCallback(
    async (sku: string, options?: { skipFreshGuard?: boolean }) => {
      setEditingSku(sku);
      setEditLoading(true);
      try {
        if (!options?.skipFreshGuard) {
          const allowed = await refreshDockActionGuard({ sku, actionLabel: "Load into Form" });
          if (!allowed) return;
        }

        let latestRows = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions;
        let syncedFormData = getSyncedDockFormData(sku, latestRows);
        if (!syncedFormData) {
          latestRows = await refreshRecentSubmissionsForAction();
          syncedFormData = getSyncedDockFormData(sku, latestRows);
        }

        let submittedAtHint = getSubmissionHintForSku(sku, latestRows);
        let result = syncedFormData
          ? { success: true as const, formData: syncedFormData }
          : await readOutputWorkCached(sku, {
            preferFresh: true,
            freshTimeoutMs: READ_ONLY_FRESH_FETCH_TIMEOUT_MS,
            retries: 0,
            submittedAt: submittedAtHint,
          });

        // Rapid Load -> Submit -> Load cycles can briefly race the backend's latest submittedAt.
        // Retry with refreshed rows/hints a few times before surfacing a cross-session conflict.
        for (
          let attempt = 0;
          !result.success
          && result.error
          && /newer loading dock data/i.test(result.error)
          && attempt < LOAD_INTO_FORM_NEWER_DATA_MAX_RETRIES;
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, LOAD_INTO_FORM_NEWER_DATA_RETRY_DELAY_MS));
          latestRows = await refreshRecentSubmissionsForAction();
          syncedFormData = getSyncedDockFormData(sku, latestRows);
          submittedAtHint = getSubmissionHintForSku(sku, latestRows);
          result = syncedFormData
            ? { success: true as const, formData: syncedFormData }
            : await readOutputWorkCached(sku, {
              preferFresh: true,
              freshTimeoutMs: READ_ONLY_FRESH_FETCH_TIMEOUT_MS,
              retries: 0,
              submittedAt: submittedAtHint,
            });
        }

        if (!result.success || !result.formData) {
          const errorMsg = result.error || "";
          const isNotFound = /not found/i.test(errorMsg);
          const isInvalidAction = /invalid action/i.test(errorMsg);
          const isNewerSubmission = /newer loading dock data/i.test(errorMsg);
          console.warn(`Could not load edit data for ${sku}:`, errorMsg);
          if (isInvalidAction) {
            toast({
              title: "Edge function outdated",
              description: `The backend does not support this action yet. Please redeploy the google-sheets edge function.`,
              variant: "destructive",
            });
          } else if (isNotFound) {
            toast({
              title: "SKU not available",
              description: `${sku} was not found in the Loading Dock. It may have been deleted or is still syncing — refresh and try again.`,
              variant: "destructive",
            });
          } else if (isNewerSubmission) {
            toast({
              title: "Loading Dock updated",
              description: `${sku} changed in another session. Refresh and try again.`,
              variant: "destructive",
            });
          } else {
            const isTimeout = /\b(timed?\s*out|timeout|abort(?:ed)?)\b/i.test(errorMsg);
            toast({
              title: isTimeout ? "Request timed out" : "Still processing...",
              description: isTimeout
                ? `Loading data for ${sku} timed out due to temporary server load. Please try again in a few seconds.`
                : `Product ${sku} is still being processed in the background. Please wait a few seconds and try again.`,
              variant: "destructive",
            });
          }
          return;
        }
        outputWorkCache.current.set(sku.trim().toUpperCase(), result.formData);
        const matchingSubmission = latestRows.find((entry) => entry.sku.trim().toUpperCase() === sku.trim().toUpperCase());
        const rowSubmittedAtEpochMs = matchingSubmission ? parseDockTimestamp(matchingSubmission.submittedAt) : NaN;
        const rowSubmissionCompleted = hasCompletedProcessedAt(matchingSubmission?.processedAt);
        const [sharedSnapshotResult, localSnapshot] = await Promise.all([
          getSharedDockFormSnapshotForSubmission(
            sku,
            Number.isFinite(rowSubmittedAtEpochMs) ? rowSubmittedAtEpochMs : null,
          ).catch(() => ({ snapshot: null, files: null })),
          Promise.resolve(getDockFormSnapshot(sku)),
        ]);
        const localPreferSnapshot =
          isDockFormSnapshotSubmissionMatch(
            localSnapshot,
            Number.isFinite(rowSubmittedAtEpochMs) ? rowSubmittedAtEpochMs : null,
          ) || isDockFormSnapshotCompatible(localSnapshot, result.formData);
        const sharedSnapshot = sharedSnapshotResult.snapshot;
        const sharedPreferSnapshot =
          rowSubmissionCompleted &&
          isDockFormSnapshotSubmissionMatch(
            sharedSnapshot,
            Number.isFinite(rowSubmittedAtEpochMs) ? rowSubmittedAtEpochMs : null,
          );
        let snapshot = localSnapshot;
        let snapshotFiles =
          localSnapshot
            ? getDockFormSnapshotFiles(sku)
            : null;
        let preferSnapshot =
          localPreferSnapshot;

        if (
          sharedSnapshot &&
          sharedPreferSnapshot &&
          (
            !snapshot ||
            !preferSnapshot ||
            sharedSnapshot.savedAtEpochMs > (snapshot.savedAtEpochMs ?? 0)
          )
        ) {
          snapshot = sharedSnapshot;
          snapshotFiles = null;
          preferSnapshot = true;
        }

        const fallbackPreferSnapshot =
          isDockFormSnapshotSubmissionMatch(
            snapshot,
            Number.isFinite(rowSubmittedAtEpochMs) ? rowSubmittedAtEpochMs : null,
          ) || isDockFormSnapshotCompatible(snapshot, result.formData);
        if (!preferSnapshot) preferSnapshot = fallbackPreferSnapshot;
        const selectedSnapshotFiles = preferSnapshot ? snapshotFiles : null;
        const authoritativeFormState = buildAuthoritativeDockFormState(result.formData, snapshot, {
          preferSnapshot,
          requestedSku: sku,
          rowSubmittedAtEpochMs: Number.isFinite(rowSubmittedAtEpochMs) ? rowSubmittedAtEpochMs : null,
        });

        // When using a shared snapshot with no local files, create stub File
        // objects from the snapshot's datasheetUrl / webpageUrl so the form
        // can display them and re-attach on next submit.
        let resolvedDatasheetFile: File | null = selectedSnapshotFiles?.datasheetFile ?? null;
        let resolvedWebsitePdfFile: File | null = selectedSnapshotFiles?.websitePdfFile ?? null;
        if (!resolvedDatasheetFile && preferSnapshot && snapshot?.datasheetUrl) {
          const name = snapshot.datasheetUrl.split("/").pop() || "datasheet.pdf";
          resolvedDatasheetFile = new File([], name, { type: "application/pdf" });
        }
        if (!resolvedWebsitePdfFile && preferSnapshot && snapshot?.webpageUrl) {
          const name = snapshot.webpageUrl.split("/").pop() || "website.pdf";
          resolvedWebsitePdfFile = new File([], name, { type: "application/pdf" });
        }

        persistLoadedDockSnapshot(authoritativeFormState, {
          submittedAtEpochMs: Number.isFinite(rowSubmittedAtEpochMs) ? rowSubmittedAtEpochMs : null,
          submittedAtSource: "backend",
          datasheetFile: resolvedDatasheetFile,
          websitePdfFile: resolvedWebsitePdfFile,
          syncShared: true,
          reason: "Load into Form",
        });

        const eventDetail: DockEditEventDetail = {
          ...authoritativeFormState,
          datasheetFile: resolvedDatasheetFile,
          websitePdfFile: resolvedWebsitePdfFile,
        };
        localStorage.setItem(FORM_STATE_STORAGE_KEY, JSON.stringify(authoritativeFormState));
        window.dispatchEvent(new CustomEvent("dock-edit-load", { detail: eventDetail }));
        navigate("/");
        toast({ title: "Form populated", description: `Loaded data for ${sku} — review and re-submit when ready.` });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn("Edit load failed:", errMsg);
        const isInvalidAction = /invalid action/i.test(errMsg);
        toast({
          title: isInvalidAction ? "Edge function outdated" : "Could not load data",
          description: isInvalidAction
            ? "The backend does not support this action yet. Please redeploy the google-sheets edge function."
            : `Could not load data for ${sku}. Refresh and try again. If this persists, contact Eran.`,
          variant: "destructive",
        });
      } finally {
        setEditLoading(false);
        setEditingSku(null);
      }
    },
    [getSubmissionHintForSku, getSyncedDockFormData, navigate, persistLoadedDockSnapshot, queryClient, readOutputWorkCached, refreshDockActionGuard, refreshRecentSubmissionsForAction, submissions, toast],
  );

  /** Handle Edit button click — check for dirty form first */
  const handleEdit = useCallback(
    (sku: string) => {
      if (isFormDirty()) {
        setDirtyWarnSku(sku);
      } else {
        void doEdit(sku);
      }
    },
    [doEdit],
  );

  const handleSendAll = useCallback(async () => {
    const latestRows = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions;
    const skus = latestRows.map((s) => s.sku.trim()).filter(Boolean);
    if (skus.length === 0) return;

    // Show badges immediately before guard check
    pausePolling();
    markActionPending(skus, "Sending…");

    const allowed = await refreshDockActionGuard({ actionLabel: "Send All & Clear Dock" });
    if (!allowed) {
      clearActionPending(skus);
      resumePolling();
      return;
    }

    (async () => {
      try {
        const result = await sendAllAndClearDock(skus);

        // Pending: operation is queued but not confirmed yet — don't hide rows immediately
        if (result.pending) {
          clearActionPending(skus);
          for (const sku of skus) {
            markSkuAsForcedPending(sku);
          }
          queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
            /* non-fatal */
          });
          toast({
            title: "Send All queued",
            description: result.reason || "Emails are queued and will send shortly — refresh in a moment.",
          });
          return;
        }

        if (result.failed.length > 0) {
          clearActionPending(skus);
          queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
          toast({
            title: "Partially Sent",
            description: `${result.sent} sent, ${result.failed.length} failed.`,
          });
        } else {
          // All confirmed — hide all rows
          clearActionPending(skus);
          addPendingRemovals(skus);
          for (const sku of skus) {
            clearPendingSubmitGhost(sku);
          }
          queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], () => []);
          cleanupSharedDockSnapshots(skus);
          toast({ title: "All Sent", description: `${result.sent} emails sent and marked COMPLETE.` });
        }
      } catch {
        clearActionPending(skus);
        queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
        toast({ title: "Sync issue", description: "Failed to send — try again shortly. If this persists, contact Eran.", variant: "destructive" });
      } finally {
        resumePolling();
      }
    })();
  }, [
    addPendingRemovals,
    clearActionPending,
    cleanupSharedDockSnapshots,
    clearPendingSubmitGhost,
    markActionPending,
    markSkuAsForcedPending,
    pausePolling,
    queryClient,
    refreshDockActionGuard,
    resumePolling,
    submissions,
    toast,
  ]);

  const handleClearDock = useCallback(async () => {
    const latestRows = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions;
    const skus = latestRows.map((s) => s.sku.trim()).filter(Boolean);
    if (skus.length === 0) return;

    // Show badges immediately before guard check
    pausePolling();
    markActionPending(skus, "Clearing…");

    const allowed = await refreshDockActionGuard({ actionLabel: "Clear Dock" });
    if (!allowed) {
      clearActionPending(skus);
      resumePolling();
      return;
    }

    (async () => {
      try {
        const result = await clearDock(skus);

        // Pending: direct delete fell through to Apps Script fallback — don't hide rows immediately
        if (result.pending) {
          clearActionPending(skus);
          for (const sku of skus) {
            markSkuAsForcedPending(sku);
          }
          queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
            /* non-fatal */
          });
          toast({
            title: "Clear Dock queued",
            description: result.reason || "Clear is queued and will complete shortly — refresh in a moment.",
          });
          return;
        }

        if (result.failed.length > 0) {
          clearActionPending(skus);
          queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
          toast({
            title: "Partially Cleared",
            description: `${result.cleared} removed, ${result.failed.length} failed.`,
          });
        } else {
          clearActionPending(skus);
          addPendingRemovals(skus);
          for (const sku of skus) {
            clearPendingSubmitGhost(sku);
          }
          queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], () => []);
          cleanupSharedDockSnapshots(skus);
          toast({ title: "Dock Cleared", description: `${result.cleared} entries removed.` });
        }
      } catch {
        clearActionPending(skus);
        queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
        toast({ title: "Sync issue", description: "Failed to clear dock — try again shortly. If this persists, contact Eran.", variant: "destructive" });
      } finally {
        resumePolling();
      }
    })();
  }, [
    addPendingRemovals,
    clearActionPending,
    cleanupSharedDockSnapshots,
    clearPendingSubmitGhost,
    markActionPending,
    markSkuAsForcedPending,
    pausePolling,
    queryClient,
    refreshDockActionGuard,
    resumePolling,
    submissions,
    toast,
  ]);

  // Open the Edit Email dialog and load current email content from Sheets
  const handleEditEmail = useCallback(
    async (sku: string) => {
      try {
        const allowed = await refreshDockActionGuard({ sku, actionLabel: "Edit Email" });
        if (!allowed) return;

        const latestRows = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions;
        const submittedAtHint = getSubmissionHintForSku(sku, latestRows);
        const cached = getCachedDockEmailForSubmission(sku, latestRows);
        setEmailDialogSku(sku);
        setEmailDialogSubmittedAt(submittedAtHint ?? null);
        if (cached !== null) {
          setEmailContent(cached);
          setEmailLoading(false);
        } else {
          setEmailContent("");
          setEmailLoading(true);
        }

        let email: string | undefined;
        let loadError = "";
        try {
          const result = cached !== null
            ? { success: true as const, email: cached }
            : await readDockEmailCached(sku, { submittedAt: submittedAtHint });
          if (result.success) {
            email = result.email ?? "";
          } else {
            loadError = result.error || "";
          }
        } catch {
          // network error – fall through to cache
        }
        if (email === undefined) {
          const cachedEmail = getCachedDockEmailForSubmission(sku, latestRows);
          if (cachedEmail !== null) email = cachedEmail;
        }
        if (email !== undefined) {
          setEmailContent(email);
        } else {
          console.warn(`Could not load email for ${sku}`);
          setEmailDialogSku(null);
          setEmailDialogSubmittedAt(null);
          toast({
            title: "Could not load email",
            description: loadError || `Email content for ${sku} is not available yet — it may still be processing. Wait a moment and try again. If this persists, contact Eran.`,
            variant: "destructive",
          });
        }
      } catch {
        console.warn(`Email fetch failed for ${sku}`);
        setEmailDialogSku(null);
        setEmailDialogSubmittedAt(null);
        toast({
          title: "Could not load email",
          description: `Email content for ${sku} could not be retrieved. Wait a moment and try again. If this persists, contact Eran.`,
          variant: "destructive",
        });
      } finally {
        setEmailLoading(false);
      }
    },
    [getCachedDockEmailForSubmission, getSubmissionHintForSku, queryClient, readDockEmailCached, refreshDockActionGuard, submissions, toast],
  );

  const handleSaveEmail = useCallback(async () => {
    if (!emailDialogSku) return;
    const sku = emailDialogSku;
    const submittedAtHint = emailDialogSubmittedAt?.trim() || undefined;
    const allowed = await refreshDockActionGuard({ sku, actionLabel: "Save Email" });
    if (!allowed) return;
    setEmailDialogSku(null); // Instant close
    setEmailDialogSubmittedAt(null);

    (async () => {
      try {
        const result = await saveDockEmail(sku, emailContent, { submittedAt: submittedAtHint });
        if (result.success) {
          const normalizedSku = sku.trim().toUpperCase();
          const cacheEntry: CachedDockEmailEntry = {
            email: emailContent,
            submittedAt: submittedAtHint || "",
            cachedAtMs: Date.now(),
          };
          emailCache.current.set(normalizedSku, cacheEntry);
          emailCache.current.set(sku, cacheEntry);
          markSkuAsForceFreshDockRead(sku);
          queryClient.invalidateQueries({ queryKey: ["recent-submissions"] }).catch(() => {
            /* non-fatal */
          });
          toast({ title: "Saved", description: `Email updated for ${sku}.` });
        } else {
          toast({ title: "Sync issue", description: result.error || "Could not save email — try again shortly. If this persists, contact Eran.", variant: "destructive" });
        }
      } catch {
        toast({ title: "Sync issue", description: "Could not save email — try again shortly. If this persists, contact Eran.", variant: "destructive" });
      }
    })();
  }, [emailContent, emailDialogSku, emailDialogSubmittedAt, markSkuAsForceFreshDockRead, queryClient, refreshDockActionGuard, toast]);

  const formatDate = (sub: { processedAt?: string; submittedAt?: string }) => {
    const primary = hasCompletedProcessedAt(sub.processedAt) ? sub.processedAt : sub.submittedAt;
    return formatDockTimestampLocal(primary);
  };

  return (
    <div className="space-y-6">
      {/* Recent Submissions */}
      <FormSection title="Recent Submissions" defaultOpen collapsible={false}>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
        ) : sortedSubmissions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No submissions yet.</p>
        ) : (
          <>
            <div className="border border-border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">SKU</TableHead>
                    <TableHead className="text-xs">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1 -ml-1 text-xs font-semibold"
                        onClick={() => {
                          setDateSortDirection((prev) => (prev === "desc" ? "asc" : "desc"));
                          setPage(0);
                        }}
                      >
                        Date / Time
                        {dateSortDirection === "desc" ? (
                          <ArrowDown className="h-3.5 w-3.5 ml-1" />
                        ) : (
                          <ArrowUp className="h-3.5 w-3.5 ml-1" />
                        )}
                      </Button>
                    </TableHead>
                    <TableHead className="text-xs text-right pr-[18.4rem]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(() => {
                    // Build queue position map: all rows currently processing, ordered by submittedAt
                    const processingQueue: { sku: string; submittedAt: string }[] = [];
                    for (const sub of paged) {
                      const nSku = sub.sku.trim().toUpperCase();
                      const isProc = !hasCompletedProcessedAt(sub.processedAt) && !isStaleProcessing(sub, paged);
                      const isPendingGhost = pendingSubmitsRef.current.has(nSku) || pendingCsvSkusRef.current.has(nSku);
                      const isForcedPending = forcedPendingSkusRef.current.has(nSku);
                      const hasError = backendErrorsBySku.has(nSku);
                      const actionLabel = actionPendingSkusRef.current.get(nSku) ?? null;
                      if (!hasError && !actionLabel && (isProc || isPendingGhost || isForcedPending)) {
                        processingQueue.push({ sku: nSku, submittedAt: sub.submittedAt || "" });
                      }
                    }
                    // Also count items from other pages that are processing
                    let globalProcessingBefore = 0;
                    for (const sub of sortedSubmissions) {
                      const nSku = sub.sku.trim().toUpperCase();
                      if (paged.some(p => p.sku.trim().toUpperCase() === nSku)) continue;
                      const isProc = !hasCompletedProcessedAt(sub.processedAt) && !isStaleProcessing(sub, sortedSubmissions);
                      const isPendingGhost = pendingSubmitsRef.current.has(nSku) || pendingCsvSkusRef.current.has(nSku);
                      const isForcedPending = forcedPendingSkusRef.current.has(nSku);
                      const hasError = backendErrorsBySku.has(nSku);
                      const actionLabel = actionPendingSkusRef.current.get(nSku) ?? null;
                      if (!hasError && !actionLabel && (isProc || isPendingGhost || isForcedPending)) {
                        globalProcessingBefore++;
                      }
                    }
                    const totalProcessing = globalProcessingBefore + processingQueue.length;

                    return paged.map((sub) => {
                    const normalizedSku = sub.sku.trim().toUpperCase();
                    const pendingSubmitState = pendingSubmitsRef.current.get(normalizedSku) ?? null;
                    const rowGuardAction = guardingActionSku === normalizedSku ? guardingActionLabel : null;
                    const rowBackendPendingAction = sub.pendingActionType ?? backendPendingActionsBySku.get(normalizedSku) ?? null;
                    const rowIsProcessing = !rowBackendPendingAction && !hasCompletedProcessedAt(sub.processedAt);
                    const rowIsStale = rowIsProcessing && isStaleProcessing(sub, displaySubmissions);
                    const rowHasBackendError = backendErrorsBySku.has(normalizedSku);
                    const rowHasPendingGhost =
                      pendingSubmitsRef.current.has(normalizedSku) || pendingCsvSkusRef.current.has(normalizedSku);
                    const rowHasForcedPending = forcedPendingSkusRef.current.has(normalizedSku);
                    const rowHasLocalOverwritePending = pendingSubmitState?.isOverwrite === true;
                    const rowActionPendingLabel =
                      actionPendingSkusRef.current.get(normalizedSku) ??
                      getBackendPendingActionLabel(rowBackendPendingAction) ??
                      null;
                    const rowShowsProcessingIndicatorRaw =
                      !rowActionPendingLabel &&
                      !rowHasBackendError &&
                      !rowIsStale &&
                      (rowHasForcedPending || rowIsProcessing || rowHasPendingGhost);
                    const rowShowsFailedIndicatorRaw = !rowShowsProcessingIndicatorRaw && (rowHasBackendError || rowIsStale);
                    const rowStableBadgeState = rowActionPendingLabel
                      ? "none"
                      : resolveStableDockBadgeState(
                        normalizedSku,
                        rowShowsProcessingIndicatorRaw ? "processing" : rowShowsFailedIndicatorRaw ? "failed" : "none",
                      );
                    const rowShowsProcessingIndicator = rowStableBadgeState === "processing";
                    const rowShowsFailedIndicator = rowStableBadgeState === "failed";
                    const rowIsLocked =
                      rowShowsProcessingIndicator ||
                      rowHasBackendError ||
                      rowHasPendingGhost ||
                      rowHasForcedPending ||
                      !!rowActionPendingLabel;
                    // When any action is active on this row, disable ALL other buttons instantly
                    const rowIsBusy = (editLoading && editingSku === sub.sku) || downloadingSkus.has(sub.sku) || viewLoading === sub.sku || sendingEmailSku === sub.sku || guardingActionSku === normalizedSku;
                    const rowDisabled = rowIsLocked || rowIsBusy;

                    // Determine badge label: overrides get "Overriding", new submits/uploads get "Processing".
                    const isOverride = rowShowsProcessingIndicator && (rowHasForcedPending || rowHasLocalOverwritePending || overrideSkusRef.current.has(normalizedSku));
                    // Clear override flag once processing is complete
                    // Override flag cleanup is handled by useEffect below (not during render)
                    // Queue position for processing/override badges
                    const queueIdx = processingQueue.findIndex(q => q.sku === normalizedSku);
                    const queuePosition = queueIdx >= 0 ? globalProcessingBefore + queueIdx + 1 : 0;
                    const processingBadgeLabel = isOverride
                      ? (totalProcessing > 1 && queuePosition > 0 ? `Overriding ${queuePosition}` : "Overriding")
                      : (totalProcessing > 1 && queuePosition > 0 ? `Processing ${queuePosition}` : "Processing");

                    // For action pending labels, also add queue position
                    const actionBadgeLabel = rowActionPendingLabel ?? "";

                    return (
                      <TableRow key={sub.id} className={rowActionPendingLabel ? "opacity-50" : ""}>
                        <TableCell className="font-mono text-xs">
                          <div className="flex items-center gap-2">
                            <span>{sub.sku}</span>
                            {rowActionPendingLabel && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-muted-foreground/30 bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                {actionBadgeLabel}
                              </span>
                            )}
                            {!rowActionPendingLabel && rowShowsProcessingIndicator && (
                              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                                isOverride
                                  ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                                  : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                              }`}>
                                <Loader2 className="h-3 w-3 animate-spin" />
                                {processingBadgeLabel}
                              </span>
                            )}
                            {!rowActionPendingLabel && rowShowsFailedIndicator && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300 cursor-help"
                                title={rowHasBackendError ? backendErrorsBySku.get(normalizedSku) : "Processing timed out — this SKU may not have been saved correctly."}
                              >
                                <AlertCircle className="h-3 w-3" />
                                Failed
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatDate(sub)}</TableCell>
                        <TableCell className="flex justify-end gap-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={rowDisabled}
                            onClick={() => handleEdit(sub.sku)}
                          >
                            {editLoading && editingSku === sub.sku ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <Pencil className="h-3 w-3 mr-1" />
                            )}
                            Load into Form
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={rowDisabled}
                            onClick={() => handleDownload(sub.sku)}
                          >
                            {downloadingSkus.has(sub.sku) ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <Download className="h-3 w-3 mr-1" />
                            )}
                            Download
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={rowDisabled}
                            onClick={() => handleView(sub.sku)}
                          >
                            {viewLoading === sub.sku ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <Eye className="h-3 w-3 mr-1" />
                            )}
                            View
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={rowDisabled}
                            onClick={() => handleEditEmail(sub.sku)}
                          >
                            {rowGuardAction === "Edit Email" ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <Mail className="h-3 w-3 mr-1" />
                            )}
                            Edit Email
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={rowDisabled}
                            onClick={() => {
                              setSendEmailConfirmSku(sub.sku);
                            }}
                          >
                            {sendingEmailSku === sub.sku || rowGuardAction === "Send Email" ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <Send className="h-3 w-3 mr-1" />
                            )}
                            Send Email
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-muted-foreground hover:text-destructive"
                            disabled={rowDisabled}
                            onClick={() => {
                              setDeleteSku(sub.sku);
                            }}
                          >
                            {rowGuardAction === "Delete" ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  });
                  })()}
                </TableBody>
              </Table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-3">
                <p className="text-xs text-muted-foreground">
                  Page {page + 1} of {totalPages}
                </p>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </FormSection>

      {/* Send All & Clear Dock */}
      {sortedSubmissions.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {failedSkus.length > 0 ? `${failedSkus.length} failed item${failedSkus.length === 1 ? "" : "s"}` : "No failures detected"}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleClearFailed}
              disabled={failedSkus.length === 0 || clearFailedMutation.isPending || mutationActiveRef.current}
            >
              {clearFailedMutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  Clearing…
                </>
              ) : (
                <>
                  <XCircle className="h-3.5 w-3.5 mr-1" />
                  Clear Failed
                </>
              )}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConfirmClearDock(true);
              }}
              className="h-9"
              disabled={hasLockedRows || guardingBulkAction !== null}
            >
              {guardingBulkAction === "clear-dock" ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <XCircle className="h-4 w-4 mr-1.5" />
              )}
              Clear Dock
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirmSendAll(true);
              }}
              className="h-9"
              disabled={hasLockedRows || guardingBulkAction !== null}
            >
              {guardingBulkAction === "send-all" ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-1.5" />
              )}
              Send All & Clear Dock
            </Button>
          </div>
        </div>
      )}

      {/* Edit Email Dialog */}
      <Dialog
        open={emailDialogSku !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEmailDialogSku(null);
            setEmailDialogSubmittedAt(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Email — {emailDialogSku}</DialogTitle>
          </DialogHeader>
          {emailLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading email content…</span>
            </div>
          ) : (
            <Textarea
              value={emailContent}
              onChange={(e) => setEmailContent(e.target.value)}
              placeholder="Email content for this SKU…"
              className="min-h-[320px] text-sm font-mono"
            />
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEmailDialogSku(null);
                setEmailDialogSubmittedAt(null);
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSaveEmail} disabled={emailLoading}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dirty Form Warning */}
      <AlertDialog open={dirtyWarnSku !== null} onOpenChange={(open) => !open && setDirtyWarnSku(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Load entry into form?</AlertDialogTitle>
            <AlertDialogDescription>
              The entry form already has data filled in. Loading{" "}
              <strong className="font-semibold text-foreground">{dirtyWarnSku}</strong> will replace the current form
              data with this dock entry. Nothing is submitted or saved — you can review and edit before using "Move to
              Loading Dock".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDirtyWarnSku(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const sku = dirtyWarnSku;
                setDirtyWarnSku(null);
                if (sku) doEdit(sku);
              }}
            >
              Load Entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={deleteSku !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteSku(null);
            setMarkCompleteOnDelete(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove entry?</AlertDialogTitle>
            <AlertDialogDescription>This will remove the submission from the dock list.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2 px-1 pb-2">
            <Checkbox
              id="mark-complete-on-delete"
              checked={markCompleteOnDelete}
              onCheckedChange={(checked) => setMarkCompleteOnDelete(checked === true)}
            />
            <label htmlFor="mark-complete-on-delete" className="text-sm cursor-pointer select-none">
              Mark as Complete in Products To Do
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (deleteSku) {
                  const sku = deleteSku;
                  const shouldComplete = markCompleteOnDelete;
                  const latestRows = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? submissions;
                  const submittedAtHint = getSubmissionHintForSku(sku, latestRows);
                  setDeleteSku(null);
                  setMarkCompleteOnDelete(false);
                  // Show badge immediately before guard check
                  markActionPending([sku], "Deleting…");
                  const allowed = await refreshDockActionGuard({ sku, actionLabel: "Delete" });
                  if (!allowed) {
                    clearActionPending([sku]);
                    return;
                  }
                  deleteMutation.mutate({ sku, shouldComplete, submittedAt: submittedAtHint });
                } else {
                  setDeleteSku(null);
                  setMarkCompleteOnDelete(false);
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProductViewDialog open={viewOpen} onOpenChange={setViewOpen} data={viewData} />

      {/* Send Email Confirmation */}
      <AlertDialog open={sendEmailConfirmSku !== null} onOpenChange={(open) => !open && setSendEmailConfirmSku(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send Email for {sendEmailConfirmSku}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will send an email with the product CSV for <strong>{sendEmailConfirmSku}</strong> and mark the SKU
              as <strong>COMPLETE</strong> in PRODUCTS TO DO.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (sendEmailConfirmSku) {
                  const sku = sendEmailConfirmSku;
                  setSendEmailConfirmSku(null);
                  // handleSendEmail shows the badge immediately now
                  await handleSendEmail(sku, { skipGuard: false });
                } else {
                  setSendEmailConfirmSku(null);
                }
              }}
            >
              Send & Mark Complete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Send All Confirmation */}
      <AlertDialog open={confirmSendAll} onOpenChange={setConfirmSendAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send All & Clear Dock?</AlertDialogTitle>
            <AlertDialogDescription>
              This will send <strong>{submissions.length}</strong> individual email{submissions.length !== 1 ? "s" : ""}{" "}
              (one per SKU) and mark all as <strong>COMPLETE</strong>. The dock will be cleared after emails are sent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                setConfirmSendAll(false);
                await handleSendAll();
              }}
            >
              Send All ({submissions.length})
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear Dock Confirmation */}
      <AlertDialog open={confirmClearDock} onOpenChange={setConfirmClearDock}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear Entire Dock?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove all <strong>{submissions.length}</strong> entries from the Loading Dock{" "}
              <strong>without sending emails</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                setConfirmClearDock(false);
                await handleClearDock();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Clear All ({submissions.length})
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

const LoadingDockStub = () => {
  return (
    <div className="flex flex-col items-center justify-center h-[50vh] space-y-4">
      <AlertCircle className="h-12 w-12 text-muted-foreground" />
      <h2 className="text-xl font-semibold">Loading Dock is No Longer in Use</h2>
      <p className="text-muted-foreground text-center max-w-md">
        The Loading Dock has been deprecated. All product actions should now be performed directly from the Product Entry Form.
      </p>
    </div>
  );
};

export default LoadingDockStub;
