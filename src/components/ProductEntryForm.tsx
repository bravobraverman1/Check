import { useState, useCallback, useMemo, useEffect, useRef, type DragEvent } from "react";
import { flushSync } from "react-dom";
import type { FilterValueSource } from "@/components/DynamicSpecifications";
import { usePdfFiles } from "@/context/PdfFilesContext";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormSection } from "@/components/FormSection";
import { CategoryTreeDropdown } from "@/components/CategoryTreeDropdown";
import { DynamicImageInputs } from "@/components/DynamicImageInputs";
import { DynamicSpecifications } from "@/components/DynamicSpecifications";
import { SkuSelector } from "@/components/SkuSelector";
import { PdfViewer } from "@/components/PdfViewer";
import { ProductViewDialog } from "@/components/ProductViewDialog";
import { CsvSnapshotViewer } from "@/components/CsvSnapshotDialog";
import { AiProgressBlock } from "@/components/AiProgressBlock";
import { AlertTriangle, CheckCircle, Download, Eye, FileText, Loader2, Send, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { useToast } from "@/hooks/use-toast";
import {
  fetchSkus,
  fetchSkuSheetDetails,
  peekNextMpnDirect,
  fetchCategories,
  fetchProperties,
  fetchRecentSubmissions,
  submitProduct,
  sendProductByEmail,
  downloadProductCsv,
  markSkuComplete,
  addLegalValue,
  type ProductPayload,
  type RecentSubmission,
  type SkuEntry,
} from "@/lib/api";
import { persistPendingDockSubmit, removePendingDockSubmit } from "@/lib/loadingDockPending";
import { removePendingSubmitRecovery, upsertPendingSubmitRecovery } from "@/lib/pendingSubmitRecovery";
import {
  getDockFormSnapshot,
  getDockFormSnapshotFiles,
  removeDockFormSnapshot,
  upsertDockFormSnapshot,
} from "@/lib/dockFormSnapshots";
import { saveSharedDockFormSnapshot } from "@/lib/sharedDockFormSnapshots";
import {
  findDuplicateTitleInfo,
  isDuplicateTitleSubmitError,
  type DuplicateTitleInfo,
} from "@/lib/duplicateTitleGuard";
import { normalizeProductTitleWhitespace } from "@/lib/productTitleNormalization";
import { ensureSubmitRequestId } from "@/lib/submitRequestId";
import { getTabScopedStorageKey } from "@/lib/browserTabScope";
import { config } from "@/config";
import { defaultProperties, type PropertyDefinition } from "@/data/defaultProperties";

import {
  checkSkuInLoadingDock,
  checkSkuStatusFresh,
  getLastDockTitleMap,
  removeGlobalPendingDockSubmit,
  persistGlobalPendingDockSubmit,
  type OutputWorkFormData,
} from "@/lib/supabaseGoogleSheets";
import {
  withBucket,
  withCompareBucket,
  allocateProductBucket,
  uploadFilesToBucket,
  cleanBucket,
  releaseBucketLock,
} from "@/lib/bucketAllocation";
import {
  parseProductCsvImport,
  type ImportedProductFormData,
  type ProductCsvImportResult,
} from "@/lib/productCsvImport";
import { supabase } from "@/integrations/supabase/client";
import { getGeminiConfig } from "@/lib/geminiConfig";
import type { GeminiProcessResponse } from "@/lib/geminiAI";
import { useAiJob } from "@/hooks/useAiJob";
import { runAiAction } from "@/lib/runAiAction";
import {
  buildCompareDatasheetsPrompt,
  buildGenerateProductDataPrompt,
  buildTitleDescriptionPrompt,
} from "@/lib/aiPromptBuilders";
import {
  extractGeminiLeadingText,
  hasGeminiSectionHeaders,
  parseGeminiSections,
  parseFilterProposals,
  type FilterProposal,
} from "@/lib/parseGeminiSections";
import {
  formatDimensionFilterValueForCsv,
  normalizeDimensionFilterValueForStorage,
} from "@/lib/filterDimensionFormatting";
import {
  extractProductDataSectionFromGenerateResponse,
  reconcileTwoPdfProductDataAndConflicts,
} from "@/lib/twoPdfPostProcess";
import {
  extractUnitFromPropertyName,
  formatNumericForInput,
  parseNumericValueForExpectedUnit,
} from "@/lib/unitNormalization";
import { getAiActionRouting, getDefaultAiRoutingConfig, type AiActionId } from "@/lib/aiRoutingConfig";
import { getAiCollisionTuningConfig, type AiCollisionTuningConfig } from "@/lib/aiCollisionTuningConfig";
import { parseTitleDescriptionJson } from "@/lib/parseTitleDescriptionJson";
import { normalizeGeneratedTitleCase } from "@/lib/normalizeGeneratedTitleCase";
import { isMissingValue, isMissingMarker, hasMissingMarkerSubstring } from "@/lib/missingValueMarkers";
import { loadPromptVariables } from "@/lib/promptVariablesCache";
import { syncGoogleSheetQueries } from "@/lib/querySync";
import { selectFirstCompatibleActivePrompt } from "@/lib/aiPromptCandidateSelection";
import {
  trackAiGenerated,
  clearAiTracking,
  buildAiLogEntry,
  buildFilterLogString,
  extractFilterKeys,
  getTrackedFilters,
  computeWordDiff,
  computeFilterDiff,
  serializeDiff,
} from "@/lib/aiLogging";
import { writeAiLogEntry } from "@/lib/supabaseGoogleSheets";
import {
  type PromptVariable,
  type PromptConfig,
  type RuntimeContext,
  type FileRef,
  getPromptVariablesInUse,
  resolvePromptVariables,
  normalizePromptVariableBindingType,
  BINDING_TYPES as RESOLVER_BINDING_TYPES,
} from "@/lib/resolvePromptVariables";

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

interface FormErrors {
  sku?: string;
  title?: string;
  category?: string;
  images?: string;
  filters?: string;
  chatgptData?: string;
  chatgptDescription?: string;
  price?: string;
}

interface GenerateLikeResponse {
  success?: boolean;
  result?: unknown;
  data?: unknown;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
  meta?: Record<string, unknown>;
}

const MINIMUM_AI_AUTOFILL_CONFIDENCE = 60;

interface FriendlyGenerateError {
  title: string;
  message: string;
  suggestion: string;
  retryRecommended: boolean;
}

interface FilterContextResult {
  masterFilterName: string;
  filters: Array<{ name: string; type: string; mandatory: boolean; allowedValues: string[]; unit?: string }>;
}

type PersistedProductFormState = {
  sku?: string;
  heldDockSku?: string;
  mpnDraftId?: string;
  gpsMpn?: string;
  mpnAttachmentState?: "none" | "attached";
  brand?: string;
  price?: string;
  retailPrice?: string;
  visibility?: string;
  title?: string;
  loadedDockSourceSku?: string;
  loadedDockSourceTitle?: string;
  chatgptData?: string;
  chatgptDescription?: string;
  datasheetUrl?: string;
  webpageUrl?: string;
  selectedCategories?: string[];
  mainCategory?: string;
  imageUrls?: string[];
  specValues?: Record<string, string>;
  otherValues?: Record<string, string>;
  emailNotes?: string;
  additionalInstructions?: string;
  additionalInstructionsData?: string;
  loadedFromDockAt?: number;
  loadedDockSubmissionEpochMs?: number;
  loadedDockSubmissionSku?: string;
};

function parsePriceNumber(rawPrice: string): number {
  return parseFloat(rawPrice.replace(/[^0-9.-]/g, ""));
}

function isValidPriceValue(rawPrice: string): boolean {
  if (!rawPrice.trim()) return false;
  const parsed = parsePriceNumber(rawPrice);
  return !Number.isNaN(parsed) && parsed > 0;
}

const INSTRUCTION_CACHE_TTL_MS = 30 * 60_000; // 30 minutes — instruction PDFs rarely change
const STORAGE_FETCH_TIMEOUT_MS = 8_000;
const FORM_SEND_ACTION_TIMEOUT_MS = 90_000;
const FORM_DOWNLOAD_ACTION_TIMEOUT_MS = 45_000;
const CSV_IMPORT_SKU_STATUS_TIMEOUT_MS = 3_500;
const FORM_ACTION_COOLDOWN_SECONDS = 3;
const GENERATE_DEBUG_EVENTS_KEY = "generate_data_debug_events_v1";
const GENERATE_DEBUG_EVENT_LIMIT = 120;
const GENERATE_DEBUG_MAX_DEPTH = 5;
const GENERATE_DEBUG_MAX_STRING = 1800;
const GENERATE_DEBUG_MAX_ARRAY = 20;
const GENERATE_DEBUG_MAX_OBJECT_KEYS = 40;
const TITLE_DESC_RUNTIME_KEY = "title_desc_runtime_v1";
const TITLE_DESC_RUNTIME_EVENT = "title-desc-runtime-update";
const LAST_CSV_IMPORT_JSON_KEY = "last_csv_import_json_ref_v1";
const CSV_IMPORT_PROPERTIES_CACHE_KEY = "csv_import_properties_cache_v1";
const SKU_LINKED_FORM_SNAPSHOTS_KEY = "sku_linked_form_snapshots_v1";
const SUBMIT_COOLDOWN_SECONDS = 4;
const RETAIL_PRICE_CACHE_KEY = "retail_price_cache_v1";
const AI_LOG_BROWSER_STATE_KEY = "lightingstyle.aiLogBrowserState.v1";
const PENDING_COMPLETE_RECOVERY_KEY = "lightingstyle.pendingCompleteRecovery";
const PENDING_COMPLETE_RECOVERY_TTL_MS = 30 * 60_000;
const PENDING_COMPLETE_RECOVERY_RETRY_INTERVAL_MS = 15_000;
const PENDING_COMPLETE_RECOVERY_MAX_ATTEMPTS = 5;

type AiLogBrowserState = Record<string, { lastSignature?: string; rowNumber?: number }>;

type PendingCompleteRecoverySource = "send_by_email" | "download";

interface PendingCompleteRecoveryEntry {
  sku: string;
  source: PendingCompleteRecoverySource;
  createdAt: number;
  lastAttemptAt: number;
  attemptCount: number;
  expiresAt: number;
}

function getCachedRetailPrice(sku: string): string {
  try {
    const cache = JSON.parse(localStorage.getItem(RETAIL_PRICE_CACHE_KEY) || "{}");
    return String(cache[sku.trim().toUpperCase()] ?? "");
  } catch { return ""; }
}

function setCachedRetailPrice(sku: string, retailPrice: string): void {
  try {
    const cache = JSON.parse(localStorage.getItem(RETAIL_PRICE_CACHE_KEY) || "{}");
    cache[sku.trim().toUpperCase()] = retailPrice;
    localStorage.setItem(RETAIL_PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch { /* non-fatal */ }
}

const PRODUCT_ENTRY_FORM_RENDER_KEY = import.meta.env.DEV ? `product-entry-form-${Date.now()}` : "product-entry-form";
// Module-level tracker survives component remounts (tab switches)
// Also persisted to sessionStorage to survive full page refreshes
const PROCESSED_JOB_KEY = "last_processed_generate_job_id_v1";
let _lastProcessedJobId: string | null = (() => {
  try {
    return sessionStorage.getItem(PROCESSED_JOB_KEY);
  } catch {
    return null;
  }
})();
const productInstructionCache = new Map<string, { file: File; loadedAt: number }>();

type TitleDescRuntimeStatus = "idle" | "running" | "done" | "error";

interface TitleDescRuntimeState {
  status: TitleDescRuntimeStatus;
  promptMode: "technical" | "marketing";
  debugOutput: string;
  title: string;
  description: string;
  updatedAt: number;
}

interface CsvImportPropertiesCache {
  cachedAt: number;
  properties: PropertyDefinition[];
}

interface StoredCsvImportState {
  sourceFilename: string;
  importedAt: string;
  sku: string;
  cachedFormData?: OutputWorkFormData;
  cachedJsonPayload?: ProductCsvImportResult["jsonPayload"];
}

function normalizeCsvSnapshotPayload(
  raw: unknown,
  fallbackState: StoredCsvImportState | null,
): ProductCsvImportResult["jsonPayload"] | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const candidate = raw as Record<string, unknown>;
    if (
      candidate.source === "form_csv_import" &&
      typeof candidate.filename === "string" &&
      typeof candidate.importedAt === "string" &&
      candidate.formData &&
      typeof candidate.formData === "object" &&
      candidate.basicFields &&
      typeof candidate.basicFields === "object"
    ) {
      return raw as ProductCsvImportResult["jsonPayload"];
    }
  }

  if (fallbackState?.cachedJsonPayload) return fallbackState.cachedJsonPayload;
  if (fallbackState) return buildCsvImportJsonPayloadFromStoredState(fallbackState);
  return null;
}

interface StoredSkuLinkedFormSnapshot {
  sku: string;
  savedAt: string;
  formState: PersistedProductFormState;
}

type StoredSkuLinkedFormSnapshotsMap = Record<string, StoredSkuLinkedFormSnapshot>;
type CsvImportBasicInfoMode = "fill_sku" | "template";

function buildCsvImportJsonPayloadFromStoredState(
  snapshot: StoredCsvImportState,
): ProductCsvImportResult["jsonPayload"] | null {
  const formData = snapshot.cachedFormData;
  if (!formData) return null;

  return {
    source: "form_csv_import",
    filename: snapshot.sourceFilename,
    importedAt: snapshot.importedAt,
    basicFields: {
      sku: formData.sku || "",
      gpsMpn: formData.gpsMpn || "",
      brand: formData.brand || "",
      title: formData.title || "",
      visibility: (formData as { visibility?: string }).visibility || "",
      price: formData.price || "",
      mainCategory: formData.mainCategory || "",
      selectedCategories: [...(formData.selectedCategories ?? [])],
      emailNotes: formData.emailNotes || "",
      description: formData.chatgptDescription || "",
    },
    images: (formData.imageUrls ?? []).map((value, index) => ({
      slot: index + 1,
      value: String(value ?? ""),
    })),
    customFields: [],
    unmappedCsvFields: {},
    formData: {
      sku: formData.sku || "",
      gpsMpn: formData.gpsMpn || "",
      brand: formData.brand || "",
      title: formData.title || "",
      visibility: (formData as { visibility?: string }).visibility || "",
      mainCategory: formData.mainCategory || "",
      selectedCategories: [...(formData.selectedCategories ?? [])],
      imageUrls: [...(formData.imageUrls ?? [])],
      chatgptData: formData.chatgptData || "",
      chatgptDescription: formData.chatgptDescription || "",
      emailNotes: formData.emailNotes || "",
      specValues: { ...(formData.specValues ?? {}) },
      otherValues: {},
      price: formData.price || "",
    },
  };
}

function normalizeSkuSnapshotKey(rawSku: string): string {
  return String(rawSku ?? "")
    .trim()
    .toUpperCase();
}

function createMpnDraftId(): string {
  return crypto.randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeToUuidDraftId(id?: string): string {
  const trimmed = String(id ?? "").trim();
  return UUID_RE.test(trimmed) ? trimmed : createMpnDraftId();
}

function defaultTitleDescRuntimeState(): TitleDescRuntimeState {
  return {
    status: "idle",
    promptMode: "technical",
    debugOutput: "",
    title: "",
    description: "",
    updatedAt: Date.now(),
  };
}

let _titleDescRuntimeState: TitleDescRuntimeState = (() => {
  try {
    const raw = sessionStorage.getItem(TITLE_DESC_RUNTIME_KEY);
    if (!raw) return defaultTitleDescRuntimeState();
    const parsed = JSON.parse(raw) as Partial<TitleDescRuntimeState>;
    if (!parsed || typeof parsed !== "object") return defaultTitleDescRuntimeState();
    const promptMode = parsed.promptMode === "marketing" ? "marketing" : "technical";
    const status: TitleDescRuntimeStatus =
      parsed.status === "running" || parsed.status === "done" || parsed.status === "error" ? parsed.status : "idle";
    return {
      status,
      promptMode,
      debugOutput: typeof parsed.debugOutput === "string" ? parsed.debugOutput : "",
      title: typeof parsed.title === "string" ? parsed.title : "",
      description: typeof parsed.description === "string" ? parsed.description : "",
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return defaultTitleDescRuntimeState();
  }
})();

function readTitleDescRuntimeState(): TitleDescRuntimeState {
  return _titleDescRuntimeState;
}

function writeTitleDescRuntimeState(patch: Partial<Omit<TitleDescRuntimeState, "updatedAt">>): TitleDescRuntimeState {
  _titleDescRuntimeState = {
    ..._titleDescRuntimeState,
    ...patch,
    updatedAt: Date.now(),
  };
  try {
    sessionStorage.setItem(TITLE_DESC_RUNTIME_KEY, JSON.stringify(_titleDescRuntimeState));
  } catch {
    // Ignore storage failures
  }
  try {
    window.dispatchEvent(new CustomEvent(TITLE_DESC_RUNTIME_EVENT, { detail: _titleDescRuntimeState }));
  } catch {
    // Ignore dispatch failures
  }
  return _titleDescRuntimeState;
}

function writeSessionObject(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures
  }
}

function compactDebugValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length <= GENERATE_DEBUG_MAX_STRING) return value;
    return `${value.slice(0, GENERATE_DEBUG_MAX_STRING)}... [truncated ${value.length - GENERATE_DEBUG_MAX_STRING} chars]`;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= GENERATE_DEBUG_MAX_DEPTH) {
    if (Array.isArray(value)) return `[array(${value.length}) truncated]`;
    return "[object truncated]";
  }
  if (Array.isArray(value)) {
    const limited = value.slice(0, GENERATE_DEBUG_MAX_ARRAY).map((item) => compactDebugValue(item, depth + 1));
    if (value.length > GENERATE_DEBUG_MAX_ARRAY) {
      limited.push(`[${value.length - GENERATE_DEBUG_MAX_ARRAY} more items truncated]`);
    }
    return limited;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const compacted = entries
      .slice(0, GENERATE_DEBUG_MAX_OBJECT_KEYS)
      .reduce<Record<string, unknown>>((acc, [key, nested]) => {
        acc[key] = compactDebugValue(nested, depth + 1);
        return acc;
      }, {});
    if (entries.length > GENERATE_DEBUG_MAX_OBJECT_KEYS) {
      compacted.__truncated_keys__ = entries.length - GENERATE_DEBUG_MAX_OBJECT_KEYS;
    }
    return compacted;
  }
  return String(value);
}

function isHardReloadNavigation(): boolean {
  if (typeof window === "undefined") return false;

  try {
    const navEntries = typeof performance !== "undefined" ? performance.getEntriesByType("navigation") : [];
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

function buildGenerateDebugSnapshot(events: Array<Record<string, unknown>>, latest?: Record<string, unknown>) {
  return JSON.stringify(
    {
      stage: typeof latest?.stage === "string" ? latest.stage : "restored",
      timestamp: typeof latest?.timestamp === "string" ? latest.timestamp : new Date().toISOString(),
      event_count: events.length,
      latest,
      events,
    },
    null,
    2,
  );
}

function clearSessionObject(key: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Ignore storage failures
  }
}

function readSessionObject<T = unknown>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readLocalObject<T = unknown>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeLocalObject(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures
  }
}

function clearLocalObject(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage failures
  }
}

function mapCsvImportErrorMessage(error?: string): { title: string; description: string } {
  const fallback = {
    title: "CSV not compatible",
    description: "This CSV is not compatible. Please use the standard product CSV template and try again.",
  };
  if (!error) return fallback;

  const normalized = error.toLowerCase();
  if (normalized.startsWith("csv required fields missing:")) {
    return {
      title: "CSV not compatible",
      description: "This CSV is missing required fields from the standard template.",
    };
  }

  if (normalized.startsWith("csv contains invalid values:")) {
    return {
      title: "CSV not compatible",
      description: "This CSV contains invalid values for required fields.",
    };
  }

  if (
    normalized.includes("does not match the required template") ||
    normalized.includes("doesn’t match the required template") ||
    normalized.includes("doesn't match the required template") ||
    normalized.includes("csv format is not supported") ||
    normalized.includes("csv format not supported") ||
    normalized.includes("csv must have at least 2 rows")
  ) {
    return {
      title: "CSV not compatible",
      description: "This CSV format is not supported. Use the standard product CSV template.",
    };
  }

  if (
    normalized.includes("host not on proxy allowlist") ||
    normalized.includes("blocked image host") ||
    normalized.includes("image url")
  ) {
    return {
      title: "CSV not compatible",
      description: "This CSV contains unsupported image links. Use direct image URLs from allowed hosts and try again.",
    };
  }

  if (normalized.includes("mpn mismatch for sku")) {
    return {
      title: "CSV MPN mismatch",
      description: error,
    };
  }

  if (
    normalized.includes("filter metadata still loading") ||
    normalized.includes("form reference data") ||
    normalized.includes("reference data to finish loading") ||
    normalized.includes("metadata still loading")
  ) {
    return {
      title: "CSV import failed",
      description:
        "The CSV import should not depend on reference data timing. Try once more. If this repeats, contact Eran.",
    };
  }

  return fallback;
}

function getCsvImportValidationIssues(result: ProductCsvImportResult): {
  missingFields: string[];
  invalidFields: string[];
} {
  const missingFields: string[] = [];
  const invalidFields: string[] = [];
  const { formData } = result;

  if (!String(formData.sku ?? "").trim()) missingFields.push("SKU");
  if (!String(formData.title ?? "").trim()) missingFields.push("Title");
  if (!String(formData.chatgptData ?? "").trim()) missingFields.push("AI-DATA");
  if (!String(formData.chatgptDescription ?? "").trim()) missingFields.push("AI-Description");
  if (!Array.isArray(formData.selectedCategories) || formData.selectedCategories.length === 0) {
    missingFields.push("Category");
  }
  if (!String(formData.mainCategory ?? "").trim()) missingFields.push("Main Category");

  const firstImage = String(formData.imageUrls?.[0] ?? "").trim();
  if (!firstImage) {
    missingFields.push("Image URL 1");
  } else {
    const validExtPattern = /\.(jpe?g|png|gif|webp)(?:[?#].*)?$/i;
    if (!validExtPattern.test(firstImage)) {
      invalidFields.push("Image URL 1 must end with .jpg, .jpeg, .png, .gif, or .webp");
    }
  }

  return { missingFields, invalidFields };
}

function isCsvImportMetadataLoadingError(error?: string): boolean {
  const normalized = String(error ?? "").toLowerCase();
  return (
    normalized.includes("filter metadata still loading") ||
    normalized.includes("form reference data") ||
    normalized.includes("reference data to finish loading") ||
    normalized.includes("metadata still loading")
  );
}

const MAX_CSV_FILE_BYTES = 6 * 1024 * 1024;
const MAX_PDF_FILE_BYTES = 25 * 1024 * 1024;
const CSV_MIME_TYPES = new Set(["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"]);
const PDF_MIME_TYPES = new Set(["application/pdf", "application/x-pdf", "binary/octet-stream"]);

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

async function validateCsvUploadFile(file: File): Promise<string | null> {
  const filename = String(file.name || "").trim();
  if (!filename.toLowerCase().endsWith(".csv")) {
    return "Only .csv files are allowed.";
  }

  const mime = String(file.type || "").toLowerCase();
  if (mime && !CSV_MIME_TYPES.has(mime)) {
    return "Unsupported CSV file type. Save/export as a standard CSV and try again.";
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    return "This CSV file is empty.";
  }

  if (file.size > MAX_CSV_FILE_BYTES) {
    return `CSV file is too large (${formatFileSize(file.size)}). Maximum allowed is ${formatFileSize(MAX_CSV_FILE_BYTES)}.`;
  }

  const sample = await file.slice(0, 4096).text();
  const trimmedSample = sample.trim();
  if (!trimmedSample) {
    return "This CSV file appears to be empty.";
  }

  if (trimmedSample.includes("\0")) {
    return "This file is not a valid text CSV (contains binary data).";
  }

  const sampleLines = trimmedSample.split(/\r?\n/).filter(Boolean);
  if (sampleLines.length < 2) {
    return "CSV must include at least a header row and one data row.";
  }

  if (!sampleLines[0].includes(",")) {
    return "CSV header looks invalid (comma-separated columns were not detected).";
  }

  return null;
}

async function validatePdfUploadFile(file: File): Promise<string | null> {
  const filename = String(file.name || "").trim();
  if (!filename.toLowerCase().endsWith(".pdf")) {
    return "Only .pdf files are allowed.";
  }

  const mime = String(file.type || "").toLowerCase();
  if (mime && !PDF_MIME_TYPES.has(mime)) {
    return "Unsupported PDF file type. Export/save as PDF and try again.";
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    return "This PDF file is empty.";
  }

  if (file.size > MAX_PDF_FILE_BYTES) {
    return `PDF file is too large (${formatFileSize(file.size)}). Maximum allowed is ${formatFileSize(MAX_PDF_FILE_BYTES)}.`;
  }

  const header = await file.slice(0, 5).text();
  if (!header.startsWith("%PDF-")) {
    return "This file does not look like a valid PDF.";
  }

  return null;
}

async function withProductStepTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.floor(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function ProductEntryFormInner() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [cooldown, setCooldown] = useState(0);
  const [sendByEmailCooldown, setSendByEmailCooldown] = useState(0);
  const [downloadActionCooldown, setDownloadActionCooldown] = useState(0);
  const [isRefreshingFormReferenceData, setIsRefreshingFormReferenceData] = useState(false);
  const formReferenceRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const lastFormReferenceRefreshAtRef = useRef(0);
  const resetTransientAiUiStateRef = useRef<() => void>(() => {});
  const resetFormRef = useRef<() => void>(() => {});

  const { data: skus = [], isLoading: isLoadingSkus } = useQuery<SkuEntry[]>({
    queryKey: ["skus", config.STATUS_TO_DO],
    queryFn: () => fetchSkus(config.STATUS_TO_DO),
    staleTime: 5 * 60_000,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ["categories"],
    queryFn: fetchCategories,
    staleTime: 5 * 60_000,
  });

  const { data: propData } = useQuery({
    queryKey: ["properties"],
    queryFn: fetchProperties,
    staleTime: 5 * 60_000,
  });

  const { data: recentSubmissions = [] } = useQuery<RecentSubmission[]>({
    queryKey: ["recent-submissions"],
    queryFn: () => fetchRecentSubmissions({ includeTitleMap: true }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    placeholderData: (previousData) => previousData,
  });

  const properties = propData?.properties ?? [];
  const [csvImportPropertiesCache, setCsvImportPropertiesCache] = useState<CsvImportPropertiesCache | null>(() =>
    readLocalObject<CsvImportPropertiesCache>(CSV_IMPORT_PROPERTIES_CACHE_KEY),
  );
  const legalValues = propData?.legalValues ?? [];
  const masterLookup = propData?.masterLookup ?? [];
  const masterDefaults = propData?.masterDefaults ?? [];
  const existingTitles = propData?.existingTitles ?? [];
  const csvImportProperties = useMemo(() => {
    if (properties.length > 0) return properties;
    if (csvImportPropertiesCache?.properties?.length) return csvImportPropertiesCache.properties;
    return defaultProperties;
  }, [csvImportPropertiesCache, properties]);

  useEffect(() => {
    if (properties.length === 0) return;
    const nextCache: CsvImportPropertiesCache = {
      cachedAt: Date.now(),
      properties,
    };
    setCsvImportPropertiesCache(nextCache);
    writeLocalObject(CSV_IMPORT_PROPERTIES_CACHE_KEY, nextCache);
  }, [properties]);

  const refreshFormReferenceData = useCallback(() => {
    const now = Date.now();
    if (formReferenceRefreshPromiseRef.current) {
      return formReferenceRefreshPromiseRef.current;
    }
    if (now - lastFormReferenceRefreshAtRef.current < 10_000) {
      return Promise.resolve();
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return Promise.resolve();
    }

    const refreshPromise = (async () => {
      setIsRefreshingFormReferenceData(true);
      try {
        await syncGoogleSheetQueries(queryClient);
        lastFormReferenceRefreshAtRef.current = Date.now();
      } finally {
        setIsRefreshingFormReferenceData(false);
      }
    })();

    formReferenceRefreshPromiseRef.current = refreshPromise;
    return refreshPromise.finally(() => {
      if (formReferenceRefreshPromiseRef.current === refreshPromise) {
        formReferenceRefreshPromiseRef.current = null;
      }
    });
  }, [queryClient]);

  // Data-driven: priority fields for conflict scoring are the mandatory/required properties.
  // Derived from the Filters sheet (Column B = required flag) — no hardcoded field names.
  const priorityFieldNames = useMemo(() => {
    const names = new Set<string>();
    for (const prop of properties) {
      if (prop.required) {
        // Normalize: strip parenthesized units, #N suffixes, non-alpha, collapse spaces → UPPER
        const normalized = prop.name
          .replace(/\s*\([^)]+\)\s*$/i, "")
          .replace(/\s*#\d+\s*$/i, "")
          .replace(/[^a-z0-9]+/gi, " ")
          .replace(/\s+/g, " ")
          .trim()
          .toUpperCase();
        if (normalized) names.add(normalized);
      }
    }
    return names;
  }, [properties]);

  // Local storage key for persisting form state
  const FORM_STATE_KEY = "productFormState";
  const formStateStorageKey = getTabScopedStorageKey(FORM_STATE_KEY);

  // Strip HTML tags from text (for editing stored HTML content as plain text)
  const stripHtml = useCallback(
    (s: string) =>
      s
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>\s*<p>/gi, "\n\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    [],
  );

  const normalizeExplicitMissingMarker = useCallback((value: string): string => {
    const normalized = value.trim().replace(/^"+|"+$/g, "");
    if (/^MISSING(?:\*{3})?(?:\s*\([^)]*\))?$/i.test(normalized)) return "MISSING***";
    return value.trim();
  }, []);

  const parseAiDataEntries = useCallback((value: string) => {
    return value
      .split("\n")
      .map((line) => {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex <= 0) return null;
        const rawName = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        if (!rawName) return null;
        return { rawName, rawValue };
      })
      .filter((entry): entry is { rawName: string; rawValue: string } => entry !== null);
  }, []);

  const normalizeAiProductDataDisplay = useCallback(
    (productDataRaw: string) => {
      const lines = productDataRaw.split("\n");
      const cleaned: string[] = [];
      let inFiltersProposal = false;

      for (const line of lines) {
        const trimmed = line.trim();

        // Detect start of a FILTERS_PROPOSAL block (colon-style header or === header)
        if (/^(?:===\s*)?FILTERS?_?PROPOSALS?\s*(?:===)?\s*:?\s*$/i.test(trimmed)) {
          inFiltersProposal = true;
          continue;
        }

        // While inside a filters proposal block, skip pipe-delimited filter rows and blank lines
        if (inFiltersProposal) {
          if (!trimmed) continue; // blank line within block
          // Filter rows look like: "Colour | Slot: #1 | Value: ..."
          if (/\|/.test(trimmed) && /\b(?:Slot|Value)\b/i.test(trimmed)) continue;
          // If we hit a normal KEY: VALUE line or another section, exit the block
          inFiltersProposal = false;
        }

        const separatorIndex = line.indexOf(":");
        if (separatorIndex <= 0) {
          cleaned.push(line);
          continue;
        }
        const rawName = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        const displayName = rawName.replace(/\s*#\d+\s*$/, "").trim();
        cleaned.push(`${displayName}: ${normalizeExplicitMissingMarker(rawValue)}`);
      }

      return cleaned.join("\n");
    },
    [normalizeExplicitMissingMarker],
  );

  // Store Loading Dock descriptions as paragraph HTML, while the form still edits plain text.
  const formatDescriptionHtml = useCallback((s: string) => {
    const normalized = s.replace(/\r\n?/g, "\n").trim();
    if (!normalized) return "";

    const escapeHtml = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    return normalized
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br/>")}</p>`)
      .join("");
  }, []);

  // Helper to load state from localStorage
  const loadFormState = (): PersistedProductFormState | null => {
    try {
      const stored = localStorage.getItem(formStateStorageKey);
      const parsed = stored ? JSON.parse(stored) : null;
      return parsed && typeof parsed === "object" ? (parsed as PersistedProductFormState) : null;
    } catch {
      return null;
    }
  };

  // Load initial state from localStorage
  const savedState = useMemo(() => loadFormState(), []);
  // Detect dock-loaded state from persisted source fields (loadedFromDockAt was never
  // reliably persisted, so derive from loadedDockSourceSku which IS persisted).
  const savedStateLoadedFromDock = Boolean(
    savedState?.loadedFromDockAt ||
    String(savedState?.loadedDockSourceSku ?? "").trim() ||
    Number(savedState?.loadedDockSubmissionEpochMs) > 0,
  );
  const shouldHydrateBasicInfoFromSavedState = savedStateLoadedFromDock;
  const initialTitleDescRuntime = useMemo(() => readTitleDescRuntimeState(), []);

  // Basic Info — SKU, brand, price, and visibility ALWAYS restore from saved state
  // so they persist across tab switches. They only reset on Clear Input, manual edit,
  // or selecting a different SKU.
  const [sku, setSku] = useState(savedState?.sku ?? "");
  const [mpnDraftId, setMpnDraftId] = useState(normalizeToUuidDraftId(savedState?.mpnDraftId));
  const [gpsMpn, setGpsMpn] = useState(savedState?.gpsMpn ?? "");
  const [mpnAttachmentState, setMpnAttachmentState] = useState<"none" | "attached">(
    savedState?.mpnAttachmentState === "attached" ? savedState.mpnAttachmentState : "none",
  );
  const [mpnLoading, setMpnLoading] = useState(false);
  const [brand, setBrand] = useState(savedState?.brand ?? "");
  const [price, setPrice] = useState<string>(savedState?.price ?? "");
  const [retailPrice, setRetailPrice] = useState<string>(savedState?.retailPrice ?? "");
  const [visibility, setVisibility] = useState<string>(savedState?.visibility ?? "");
  const [title, setTitle] = useState(
    savedStateLoadedFromDock
      ? (savedState?.title ?? "")
      : initialTitleDescRuntime.title
        ? initialTitleDescRuntime.title
        : (savedState?.title ?? ""),
  );
  const [chatgptData, setChatgptData] = useState(savedState?.chatgptData ? stripHtml(savedState.chatgptData) : "");
  const [chatgptDescription, setChatgptDescription] = useState(
    savedStateLoadedFromDock
      ? savedState?.chatgptDescription
        ? stripHtml(savedState.chatgptDescription)
        : ""
      : initialTitleDescRuntime.description
        ? initialTitleDescRuntime.description
        : savedState?.chatgptDescription
          ? stripHtml(savedState.chatgptDescription)
          : "",
  );
  const [heldDockSku, setHeldDockSku] = useState<string>(
    shouldHydrateBasicInfoFromSavedState ? (savedState?.heldDockSku ?? "") : "",
  );
  const initialLoadedDockSourceSku =
    String(savedState?.loadedDockSourceSku ?? "").trim() ||
    (savedStateLoadedFromDock ? String(savedState?.sku ?? savedState?.heldDockSku ?? "").trim() : "");
  const initialLoadedDockSourceTitle = String(savedState?.loadedDockSourceTitle ?? "").trim()
    ? normalizeProductTitleWhitespace(String(savedState?.loadedDockSourceTitle ?? ""))
    : savedStateLoadedFromDock
      ? normalizeProductTitleWhitespace(String(savedState?.title ?? ""))
      : "";
  const [loadedDockSourceSku, setLoadedDockSourceSku] = useState<string>(initialLoadedDockSourceSku);
  const [loadedDockSourceTitle, setLoadedDockSourceTitle] = useState<string>(initialLoadedDockSourceTitle);
  const [loadedDockSubmissionEpochMs, setLoadedDockSubmissionEpochMs] = useState<number | undefined>(
    Number.isFinite(Number(savedState?.loadedDockSubmissionEpochMs)) &&
      Number(savedState?.loadedDockSubmissionEpochMs) > 0
      ? Number(savedState?.loadedDockSubmissionEpochMs)
      : undefined,
  );
  const [loadedDockSubmissionSku, setLoadedDockSubmissionSku] = useState<string>(
    savedState?.loadedDockSubmissionSku ?? "",
  );
  const [additionalInstructions, setAdditionalInstructions] = useState(savedState?.additionalInstructions ?? "");
  const [additionalInstructionsData, setAdditionalInstructionsData] = useState(
    savedState?.additionalInstructionsData ?? "",
  );
  const [includeEditedAiData, setIncludeEditedAiData] = useState(false);
  const aiDataMeasureRef = useRef<HTMLDivElement | null>(null);
  const aiDataMarkersLayerRef = useRef<HTMLDivElement | null>(null);
  const aiDataMarkersContentRef = useRef<HTMLDivElement | null>(null);
  const aiDataTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previousHasAiDataBlockingIssueRef = useRef(false);

  // Supplier References (PDFs) — stored in context so they survive tab navigation
  const { datasheetFile, setDatasheetFile, websitePdfFile, setWebsitePdfFile } = usePdfFiles();
  const [datasheetUrl, setDatasheetUrl] = useState(savedState?.datasheetUrl ?? "");
  const [webpageUrl, setWebpageUrl] = useState(savedState?.webpageUrl ?? "");
  const [pdfView, setPdfView] = useState<"datasheet" | "website">("datasheet");
  const [datasheetPreviewUrl, setDatasheetPreviewUrl] = useState<string | null>(null);
  const [websitePreviewUrl, setWebsitePreviewUrl] = useState<string | null>(null);
  const [datasheetPdfData, setDatasheetPdfData] = useState<ArrayBuffer | null>(null);
  const [websitePdfData, setWebsitePdfData] = useState<ArrayBuffer | null>(null);
  const datasheetPreviewSourceKey = useMemo(
    () => (datasheetFile ? `${datasheetFile.name}|${datasheetFile.size}|${datasheetFile.lastModified}` : null),
    [datasheetFile],
  );
  const websitePreviewSourceKey = useMemo(
    () => (websitePdfFile ? `${websitePdfFile.name}|${websitePdfFile.size}|${websitePdfFile.lastModified}` : null),
    [websitePdfFile],
  );
  const csvImportInputRef = useRef<HTMLInputElement | null>(null);
  const csvPreviewInputRef = useRef<HTMLInputElement | null>(null);
  const datasheetInputRef = useRef<HTMLInputElement | null>(null);
  const websiteInputRef = useRef<HTMLInputElement | null>(null);

  // Random example title as placeholder — stabilised with useRef so it
  // doesn't re-pick every time skus re-fetches (which caused it to "pop")
  const stableExampleSeedRef = useRef<number | null>(null);
  const exampleTitle = useMemo(() => {
    const titles = skus.map((p) => p.exampleTitle).filter(Boolean);
    if (titles.length === 0) return "e.g. 10W LED Ceiling Spotlight - White";
    if (stableExampleSeedRef.current === null) {
      stableExampleSeedRef.current = Math.floor(Math.random() * titles.length);
    }
    return titles[stableExampleSeedRef.current % titles.length];
  }, [skus]);

  const buildLoadingDockTitleEntries = useCallback(
    (dockEntries: RecentSubmission[]): Array<{ sku: string; title: string }> => {
      const titleMap = getLastDockTitleMap();
      const entriesBySku = new Map<string, string>();

      for (const entry of dockEntries) {
        const rawSku = String(entry.sku ?? "").trim();
        if (!rawSku) continue;
        const normalizedSku = rawSku.toUpperCase();
        const mappedTitle = normalizeProductTitleWhitespace(titleMap?.[rawSku] ?? titleMap?.[normalizedSku] ?? "");
        if (!mappedTitle) continue;
        entriesBySku.set(normalizedSku, mappedTitle);
      }

      const currentSku = (sku.trim() || heldDockSku.trim()).toUpperCase();
      const normalizedLoadedDockSourceSku = loadedDockSourceSku.trim().toUpperCase();
      const normalizedLoadedDockSourceTitle = normalizeProductTitleWhitespace(loadedDockSourceTitle);
      // Always override with the freshly-loaded dock source title for the current SKU
      // so the self-edit check uses the exact title that was loaded, not a stale titleMap value
      if (currentSku && normalizedLoadedDockSourceSku === currentSku && normalizedLoadedDockSourceTitle) {
        entriesBySku.set(normalizedLoadedDockSourceSku, normalizedLoadedDockSourceTitle);
      }

      return Array.from(entriesBySku.entries()).map(([entrySku, entryTitle]) => ({
        sku: entrySku,
        title: entryTitle,
      }));
    },
    [heldDockSku, loadedDockSourceSku, loadedDockSourceTitle, sku],
  );

  const buildDuplicateTitleInfo = useCallback(
    (options?: {
      existingTitles?: Iterable<unknown>;
      recentSubmissions?: RecentSubmission[];
    }): DuplicateTitleInfo | null => {
      return findDuplicateTitleInfo({
        title,
        currentSku: sku.trim() || heldDockSku.trim(),
        existingTitles: options?.existingTitles ?? existingTitles,
        loadingDockTitles: buildLoadingDockTitleEntries(options?.recentSubmissions ?? recentSubmissions),
      });
    },
    [buildLoadingDockTitleEntries, title, sku, heldDockSku, existingTitles, recentSubmissions],
  );

  // Duplicate title checks:
  // - ExistingProds + NewNames (from existingTitles payload)
  // - Loading Dock (from recent submissions + cached formDataMap)
  //   but ignore if it's the same SKU currently being edited.
  const duplicateTitleInfo = buildDuplicateTitleInfo();

  // Listen for dock "Edit" events — fires when a user clicks Edit on the Loading Dock.
  // Using a custom window event so the form can be populated even if it's already mounted.
  const dockEditPendingRef = useRef(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d) return;
      aiJob.reset();
      setIsGenerating(false);
      setIsGeneratingDesc(false);
      setGenerateComplete(false);
      setDescComplete(false);
      setDescProgress(0);
      setGenerateCooldown(0);
      setPdfComparisonWarning(null);
      resetGenerateDebugOutput();
      strictValidationRetryUsedRef.current = false;
      surfacedGenerateErrorJobRef.current = null;
      generateCooldownErrorSignatureRef.current = "";
      writeTitleDescRuntimeState({
        status: "idle",
        debugOutput: "",
        title: "",
        description: "",
      });
      const loadedDockSku =
        d.loadedDockSourceSku !== undefined
          ? String(d.loadedDockSourceSku ?? "").trim()
          : d.sku !== undefined
            ? String(d.sku ?? "").trim()
            : "";
      const loadedDockTitle =
        d.loadedDockSourceTitle !== undefined
          ? normalizeProductTitleWhitespace(String(d.loadedDockSourceTitle ?? ""))
          : d.title !== undefined
            ? normalizeProductTitleWhitespace(String(d.title ?? ""))
            : "";
      setLoadedDockSourceSku(loadedDockSku);
      setLoadedDockSourceTitle(loadedDockTitle);
      if (d.sku !== undefined) setSku(d.sku);
      if (d.sku !== undefined) setHeldDockSku("");
      if (d.gpsMpn !== undefined) {
        const nextMpn = String(d.gpsMpn ?? "").trim();
        setGpsMpn(nextMpn);
        setMpnAttachmentState(nextMpn ? "attached" : "none");
      } else {
        setGpsMpn("");
        setMpnAttachmentState("none");
      }
      if (d.brand !== undefined) setBrand(d.brand);
      else setBrand("");
      if (d.price !== undefined) setPrice(String(d.price ?? ""));
      else setPrice("");
      if (d.visibility !== undefined) setVisibility(String(d.visibility ?? ""));
      else setVisibility("");
      if (d.title !== undefined) setTitle(d.title);
      else setTitle("");
      if (d.chatgptData !== undefined) setChatgptData(stripHtml(d.chatgptData));
      else setChatgptData("");
      if (d.chatgptDescription !== undefined) setChatgptDescription(stripHtml(d.chatgptDescription));
      else setChatgptDescription("");
      if (d.emailNotes !== undefined) setEmailNotes(d.emailNotes);
      else setEmailNotes("");
      if ("datasheetFile" in d) setDatasheetFile((d.datasheetFile as File | null | undefined) ?? null);
      else setDatasheetFile(null);
      if ("websitePdfFile" in d) setWebsitePdfFile((d.websitePdfFile as File | null | undefined) ?? null);
      else setWebsitePdfFile(null);
      if (d.datasheetUrl !== undefined) setDatasheetUrl(String(d.datasheetUrl ?? ""));
      else setDatasheetUrl("");
      if (d.webpageUrl !== undefined) setWebpageUrl(String(d.webpageUrl ?? ""));
      else setWebpageUrl("");
      if (d.additionalInstructions !== undefined) setAdditionalInstructions(String(d.additionalInstructions ?? ""));
      else setAdditionalInstructions("");
      if (d.additionalInstructionsData !== undefined)
        setAdditionalInstructionsData(String(d.additionalInstructionsData ?? ""));
      else setAdditionalInstructionsData("");
      if (Number.isFinite(Number(d.loadedDockSubmissionEpochMs)) && Number(d.loadedDockSubmissionEpochMs) > 0) {
        setLoadedDockSubmissionEpochMs(Number(d.loadedDockSubmissionEpochMs));
        setLoadedDockSubmissionSku(String(d.loadedDockSubmissionSku ?? d.sku ?? "").trim());
      } else {
        setLoadedDockSubmissionEpochMs(undefined);
        setLoadedDockSubmissionSku("");
      }
      if (d.mainCategory !== undefined) {
        setMainCategory(d.mainCategory);
        setMainCategorySignal((value) => value + 1);
      } else {
        setMainCategory("");
        setMainCategorySignal((value) => value + 1);
      }
      if (d.selectedCategories !== undefined) setSelectedCategories(d.selectedCategories);
      else setSelectedCategories([]);
      if (d.imageUrls !== undefined) setImageUrls(d.imageUrls.length > 0 ? d.imageUrls : [""]);
      else setImageUrls([""]);
      if (d.specValues !== undefined) setSpecValues(d.specValues);
      else setSpecValues({});
      if (d.otherValues !== undefined) setOtherValues(d.otherValues);
      else setOtherValues({});
      setErrors({});
      setMandatoryErrors(new Set());
      setConflicts([]);
      setExtractionConflicts([]);
      setFilterProposals([]);
      setFilterSources({});
      setManuallyEditedFilters(new Set());
      setIncludeEditedAiData(false);
      setLastGenerateMode("");
      clearAiTracking();
      // Mark that we need to auto-fill filters from chatgptData
      dockEditPendingRef.current = true;
    };
    window.addEventListener("dock-edit-load", handler);
    return () => window.removeEventListener("dock-edit-load", handler);
  }, []);

  const [selectedCategories, setSelectedCategories] = useState<string[]>(savedState?.selectedCategories ?? []);
  const [mainCategory, setMainCategory] = useState(savedState?.mainCategory ?? "");
  const effectiveSku = useMemo(() => sku.trim() || heldDockSku.trim(), [sku, heldDockSku]);
  const mpnPreviewRefreshRequestRef = useRef(0);
  const mpnPreviewSkuRef = useRef("");
  const lastPreviewedMpnRef = useRef("");

  const normalizeFilterNameForLookup = useCallback(
    (value: string): string =>
      value
        .replace(/\*/g, "")
        .replace(/\s*\([^)]*\)\s*$/, "")
        .replace(/\s*#\d+\s*$/, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    [],
  );

  const normalizeFilterDisplayLabel = useCallback(
    (value: string): string =>
      value
        .replace(/\s*#\d+\s*$/, "")
        .replace(/\s+/g, " ")
        .trim(),
    [],
  );

  const buildFilterContextRelevanceTokens = useCallback((): string[] => {
    const tokenSource = [effectiveSku, brand, title, mainCategory, selectedCategories.join(" ")]
      .join(" ")
      .toLowerCase();

    return Array.from(
      new Set(
        tokenSource
          .split(/[^a-z0-9]+/)
          .map((token) => token.trim())
          .filter((token) => token.length >= 3),
      ),
    );
  }, [effectiveSku, brand, title, mainCategory, selectedCategories]);

  const selectCompactAllowedExamples = useCallback(
    (allowedValues: string[], maxItems: number) => {
      if (allowedValues.length <= maxItems) return allowedValues;

      const tokens = buildFilterContextRelevanceTokens();
      const withScores = allowedValues.map((value, index) => {
        const lowered = value.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (lowered === token) score += 8;
          else if (lowered.includes(token) || token.includes(lowered)) score += 4;
        }
        if (/^\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?$/.test(value)) score += 1;
        return { value, score, index };
      });

      return withScores
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.index - b.index;
        })
        .slice(0, maxItems)
        .sort((a, b) => a.index - b.index)
        .map((item) => item.value);
    },
    [buildFilterContextRelevanceTokens],
  );

  const matchLegalDropdownValue = useCallback(
    (rawValue: string, allowedValues: string[], expectedUnit?: string): string | null => {
      const normalizedRaw = rawValue.trim();
      if (!normalizedRaw) return null;

      const normalizedRawLower = normalizedRaw.toLowerCase();
      const normalize = (value: string) =>
        value
          .toLowerCase()
          .replace(/[–—]/g, "-")
          .replace(/[^a-z0-9.%+\-\s/]/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const splitCandidates = normalizedRaw
        .split(/;|,|\//)
        .map((part) => part.trim())
        .filter(Boolean);

      const direct = allowedValues.find((allowed) => allowed.toLowerCase() === normalizedRawLower);
      if (direct) return direct;

      for (const candidate of splitCandidates) {
        const candidateMatch = allowedValues.find((allowed) => allowed.toLowerCase() === candidate.toLowerCase());
        if (candidateMatch) return candidateMatch;
      }

      const normalizedRawCompact = normalize(normalizedRaw);
      const numericValue = parseNumericValueForExpectedUnit(normalizedRaw, expectedUnit);
      if (numericValue !== null && Number.isFinite(numericValue)) {
        for (const allowed of allowedValues) {
          const range = allowed.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
          if (!range) continue;
          const min = Number.parseFloat(range[1]);
          const max = Number.parseFloat(range[2]);
          if (Number.isFinite(min) && Number.isFinite(max) && numericValue >= min && numericValue <= max) {
            return allowed;
          }
        }
      }

      const containedMatches = allowedValues
        .filter((allowed) => {
          const normalizedAllowed = normalize(allowed);
          return normalizedRawCompact.includes(normalizedAllowed) || normalizedAllowed.includes(normalizedRawCompact);
        })
        .sort((a, b) => b.length - a.length);
      if (containedMatches.length > 0) return containedMatches[0];

      const rawTokens = new Set(normalizedRawCompact.split(/\s+/).filter((token) => token.length >= 2));
      let best: { value: string; score: number } | null = null;
      for (const allowed of allowedValues) {
        const allowedTokens = normalize(allowed)
          .split(/\s+/)
          .filter((token) => token.length >= 2);
        if (allowedTokens.length === 0) continue;
        const overlap = allowedTokens.filter((token) => rawTokens.has(token)).length;
        const score = overlap / allowedTokens.length;
        if (score > 0 && (!best || score > best.score)) {
          best = { value: allowed, score };
        }
      }
      return best?.value || null;
    },
    [],
  );

  const buildCompactFilterContextString = useCallback(
    (filterCtx: FilterContextResult | null): string => {
      if (!filterCtx || filterCtx.filters.length === 0) return "";

      const byBase = new Map<
        string,
        {
          displayBase: string;
          slots: string[];
          mandatorySlots: string[];
          type: string;
          unit?: string;
          allowedValues: string[];
        }
      >();

      for (const filter of filterCtx.filters) {
        const slotMatch = filter.name.match(/#(\d+)\s*$/);
        const slot = slotMatch ? `#${slotMatch[1]}` : "#1";
        const displayBase = filter.name.replace(/\s*#\d+\s*$/, "").trim();
        const key = normalizeFilterNameForLookup(displayBase);
        const existing = byBase.get(key);
        if (!existing) {
          byBase.set(key, {
            displayBase,
            slots: [slot],
            mandatorySlots: filter.mandatory ? [slot] : [],
            type: filter.type,
            unit: filter.unit,
            allowedValues: [...new Set(filter.allowedValues)],
          });
          continue;
        }
        if (!existing.slots.includes(slot)) existing.slots.push(slot);
        if (filter.mandatory && !existing.mandatorySlots.includes(slot)) existing.mandatorySlots.push(slot);
        if (!existing.unit && filter.unit) existing.unit = filter.unit;
        if (existing.type !== "ENUM" && filter.type === "ENUM") existing.type = "ENUM";
        if (filter.type === "ENUM" && filter.allowedValues.length > 0) {
          existing.allowedValues = [...new Set([...existing.allowedValues, ...filter.allowedValues])];
        }
      }

      const groups = [...byBase.values()].sort((a, b) => a.displayBase.localeCompare(b.displayBase));
      const highValueGroups = groups.filter(
        (group) => group.mandatorySlots.length > 0 || (group.type === "ENUM" && group.allowedValues.length > 0),
      );
      if (highValueGroups.length === 0) return "";

      const groupsToInclude = highValueGroups
        .sort((a, b) => {
          const aScore = (a.mandatorySlots.length > 0 ? 2 : 0) + (a.type === "ENUM" ? 1 : 0);
          const bScore = (b.mandatorySlots.length > 0 ? 2 : 0) + (b.type === "ENUM" ? 1 : 0);
          if (bScore !== aScore) return bScore - aScore;
          return a.displayBase.localeCompare(b.displayBase);
        })
        .slice(0, 12);

      const lines: string[] = [];
      lines.push(`MASTER FILTER: ${filterCtx.masterFilterName}`);
      lines.push("");
      lines.push("FILTER ASSIGNMENT RULES:");
      lines.push("- Fill mandatory slots first, then optional slots.");
      lines.push("- Use source evidence only; if absent/unclear, output MISSING***.");
      lines.push("- ENUM values must be from legal options only.");
      lines.push("");
      lines.push("FILTERS (HIGH-VALUE COMPACT):");

      for (const group of groupsToInclude) {
        let line = `- ${group.displayBase} | Type: ${group.type} | Slots: ${group.slots.sort().join(",")}`;
        if (group.mandatorySlots.length > 0) line += ` | Mandatory Slots: ${group.mandatorySlots.sort().join(",")}`;
        if (group.unit) line += ` | Unit: ${group.unit}`;

        if (group.type === "ENUM") {
          const compactExamples = selectCompactAllowedExamples(group.allowedValues, 8);
          line += ` | AllowedCount: ${group.allowedValues.length}`;
          if (compactExamples.length > 0) {
            line += ` | AllowedExamples: ${compactExamples.join(", ")}`;
          }
        }

        lines.push(line);
      }

      if (highValueGroups.length > groupsToInclude.length) {
        lines.push(`- ... +${highValueGroups.length - groupsToInclude.length} more high-value filters`);
      }

      return lines.join("\n").trim();
    },
    [normalizeFilterNameForLookup, selectCompactAllowedExamples],
  );

  // Images
  const [imageUrls, setImageUrls] = useState<string[]>(savedState?.imageUrls ?? [""]);
  const [firstImageValid, setFirstImageValid] = useState(true);
  const firstImageDimsRef = useRef<{ width?: number; height?: number }>({});
  const handleFirstImageValidation = useCallback((valid: boolean, width?: number, height?: number) => {
    setFirstImageValid(valid);
    firstImageDimsRef.current = { width, height };
  }, []);

  // Specs
  const [specValues, setSpecValues] = useState<Record<string, string>>(savedState?.specValues ?? {});
  // Track "Other" values to persist on submit
  const [otherValues, setOtherValues] = useState<Record<string, string>>(savedState?.otherValues ?? {});

  // Email Notes
  const [emailNotes, setEmailNotes] = useState(savedState?.emailNotes ?? "");

  // Mandatory filter keys (reported by DynamicSpecifications)
  const [mandatoryFilterKeys, setMandatoryFilterKeys] = useState<string[]>([]);
  const [mandatoryErrors, setMandatoryErrors] = useState<Set<string>>(new Set());
  const [mainCategorySignal, setMainCategorySignal] = useState(0);
  const [filtersOpenSignal, setFiltersOpenSignal] = useState(0);

  const mandatoryFieldLookup = useMemo(() => {
    const lookup = new Map<string, Array<{ key: string; label: string }>>();
    for (const key of mandatoryFilterKeys) {
      const prop = properties.find((property) => property.key === key);
      const rawLabel = prop?.name?.trim() || key;
      const label = normalizeFilterDisplayLabel(rawLabel);
      const normalizedLabel = normalizeFilterNameForLookup(rawLabel);
      if (!normalizedLabel) continue;
      const existing = lookup.get(normalizedLabel) ?? [];
      if (!existing.some((entry) => entry.key === key)) {
        existing.push({ key, label });
        lookup.set(normalizedLabel, existing);
      }
    }
    return lookup;
  }, [mandatoryFilterKeys, properties, normalizeFilterDisplayLabel, normalizeFilterNameForLookup]);

  const aiDataMandatoryMissingInfo = useMemo(() => {
    const missingByKey = new Map<string, string>();
    if (!chatgptData.trim() || mandatoryFieldLookup.size === 0) {
      return {
        keys: [] as string[],
        labels: [] as string[],
      };
    }

    for (const entry of parseAiDataEntries(chatgptData)) {
      if (!isMissingMarker(entry.rawValue)) continue;
      const normalizedName = normalizeFilterNameForLookup(entry.rawName);
      const matches = mandatoryFieldLookup.get(normalizedName) ?? [];
      for (const match of matches) {
        if (!missingByKey.has(match.key)) {
          missingByKey.set(match.key, match.label);
        }
      }
    }

    return {
      keys: Array.from(missingByKey.keys()),
      labels: Array.from(new Set(missingByKey.values())),
    };
  }, [chatgptData, mandatoryFieldLookup, normalizeFilterNameForLookup, parseAiDataEntries]);

  const hasAiDataCriticalMissingValues = useMemo(() => hasMissingMarkerSubstring(chatgptData), [chatgptData]);
  const hasAiDataMandatoryMissingMarkers = aiDataMandatoryMissingInfo.keys.length > 0;
  const hasAiDataBlockingIssue = hasAiDataCriticalMissingValues || hasAiDataMandatoryMissingMarkers;
  const aiDataCriticalMissingMessage = "AI-Data: one or more critical fields missing values.";

  // Unfilled mandatory filter dropdowns (empty or isMissingValue)
  const unfilledMandatoryFilterLabels = useMemo(() => {
    const labels: string[] = [];
    for (const key of mandatoryFilterKeys) {
      const raw = specValues[key]?.trim() ?? "";
      const val = /^X$/i.test(raw) ? "" : raw;
      if (!val || isMissingValue(val)) {
        const prop = properties.find((p) => p.key === key);
        const label = normalizeFilterDisplayLabel(prop?.name?.trim() || key);
        labels.push(label);
      }
    }
    return labels;
  }, [mandatoryFilterKeys, specValues, properties, normalizeFilterDisplayLabel]);

  // Combined deduplicated warning: AI-Data MISSING*** labels + unfilled filter labels
  const combinedMissingWarning = useMemo(() => {
    const aiLabels = new Set(aiDataMandatoryMissingInfo.labels);
    // Filter labels not already covered by AI-Data missing
    const extraFilterLabels = unfilledMandatoryFilterLabels.filter((l) => !aiLabels.has(l));
    const parts: string[] = [];
    if (hasAiDataCriticalMissingValues) {
      parts.push(aiDataCriticalMissingMessage);
    } else if (aiLabels.size > 0) {
      parts.push(`AI-Data: ${[...aiLabels].join(", ")}`);
    }
    if (extraFilterLabels.length > 0) {
      parts.push(`Filter: ${extraFilterLabels.join(", ")}`);
    }
    return parts.length > 0 ? `Resolve missing fields — ${parts.join(" · ")}` : "";
  }, [
    aiDataCriticalMissingMessage,
    aiDataMandatoryMissingInfo.labels,
    hasAiDataCriticalMissingValues,
    unfilledMandatoryFilterLabels,
  ]);

  const hasCombinedMandatoryMissing = hasAiDataBlockingIssue || unfilledMandatoryFilterLabels.length > 0;

  const aiDataBlockingMessage = hasAiDataBlockingIssue ? aiDataCriticalMissingMessage : "";

  const aiDataIssueLineIndices = useMemo(() => {
    if (!chatgptData.trim()) return new Set<number>();
    const indices = new Set<number>();
    let lineIndex = 0;
    for (const line of chatgptData.split("\n")) {
      if (hasMissingMarkerSubstring(line)) indices.add(lineIndex);
      lineIndex += 1;
    }
    return indices;
  }, [chatgptData]);

  const [aiDataMarkerRenderState, setAiDataMarkerRenderState] = useState<{
    positions: number[];
    contentHeight: number;
  }>({
    positions: [],
    contentHeight: 0,
  });

  // Measure the Y positions of the MISSING*** lines once when content changes.
  useEffect(() => {
    const textarea = aiDataTextareaRef.current;
    if (!textarea) return;

    if (aiDataIssueLineIndices.size === 0) {
      setAiDataMarkerRenderState({ positions: [], contentHeight: 0 });
      return;
    }
    let frameA = 0;
    let frameB = 0;
    frameA = window.requestAnimationFrame(() => {
      frameB = window.requestAnimationFrame(() => {
        const measure = aiDataMeasureRef.current;
        if (!measure || !textarea) return;

        measure.style.width = `${textarea.clientWidth}px`;
        const lines = chatgptData.split("\n");
        const frag = document.createDocumentFragment();
        const flagged: HTMLDivElement[] = [];

        for (let i = 0; i < lines.length; i++) {
          const div = document.createElement("div");
          div.style.cssText = "white-space:pre-wrap;word-break:break-word";
          div.textContent = lines[i] || " ";
          frag.appendChild(div);
          if (aiDataIssueLineIndices.has(i)) {
            flagged.push(div);
          }
        }

        measure.innerHTML = "";
        measure.appendChild(frag);
        const positions = flagged.map((el) => el.offsetTop + el.offsetHeight / 2);
        const contentHeight = measure.scrollHeight;
        measure.innerHTML = "";
        setAiDataMarkerRenderState({ positions, contentHeight });
      });
    });
    return () => {
      window.cancelAnimationFrame(frameA);
      window.cancelAnimationFrame(frameB);
    };
  }, [chatgptData, aiDataIssueLineIndices]);

  // Keep the marker layer locked to the textarea scroll position — direct sync (no RAF throttle)
  // so chevrons bounce with elastic overscroll on macOS / touch devices.
  useEffect(() => {
    const textarea = aiDataTextareaRef.current;
    const markerContent = aiDataMarkersContentRef.current;
    if (!textarea || !markerContent) return;

    const syncLayerPosition = () => {
      markerContent.style.transform = `translate3d(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px, 0)`;
    };

    syncLayerPosition();
    textarea.addEventListener("scroll", syncLayerPosition, { passive: true });
    return () => {
      textarea.removeEventListener("scroll", syncLayerPosition);
    };
  }, [aiDataMarkerRenderState]);

  const focusAiDataSection = useCallback((options?: { focus?: boolean }) => {
    if (!options?.focus) return;
    window.setTimeout(() => {
      const section = document.getElementById("section-ai-data");
      section?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      aiDataTextareaRef.current?.focus();
    }, 20);
  }, []);

  useEffect(() => {
    if (hasAiDataBlockingIssue && !previousHasAiDataBlockingIssueRef.current) {
      focusAiDataSection();
    }
    previousHasAiDataBlockingIssueRef.current = hasAiDataBlockingIssue;
  }, [hasAiDataBlockingIssue, focusAiDataSection]);

  useEffect(() => {
    if (mandatoryErrors.size === 0) return;

    const nextMissing = new Set<string>();
    for (const key of mandatoryFilterKeys) {
      const raw = specValues[key]?.trim() ?? "";
      const val = /^X$/i.test(raw) ? "" : raw;
      if (!val) {
        nextMissing.add(key);
      }
    }

    const unchanged =
      nextMissing.size === mandatoryErrors.size && Array.from(nextMissing).every((key) => mandatoryErrors.has(key));

    if (!unchanged) {
      setMandatoryErrors(nextMissing);
    }
  }, [specValues, mandatoryFilterKeys, mandatoryErrors]);

  const mainCategoryHasFilters = useCallback(
    (categoryPath: string): boolean => {
      const normalizedSelected = categoryPath
        .trim()
        .replace(/\/{2,}/g, "/")
        .replace(/\/$/, "");
      if (!normalizedSelected || properties.length === 0 || masterLookup.length === 0 || masterDefaults.length === 0) {
        return false;
      }

      const activeLookup = masterLookup.filter((entry) => entry.defaultName && entry.defaultName.trim());
      if (activeLookup.length === 0) return false;

      const matches = activeLookup.filter((entry) => {
        const normalizedEntryPath = (entry.categoryPath || "")
          .trim()
          .replace(/\/{2,}/g, "/")
          .replace(/\/$/, "");
        if (!normalizedEntryPath) return false;
        return normalizedSelected === normalizedEntryPath || normalizedSelected.startsWith(`${normalizedEntryPath}/`);
      });
      if (matches.length === 0) return false;

      const bestMatch = matches.reduce((best, current) =>
        current.categoryPath.length > best.categoryPath.length ? current : best,
      );

      const defaultEntry = masterDefaults.find(
        (d) =>
          d.name === bestMatch.defaultName ||
          d.name.trim().toLowerCase() === bestMatch.defaultName.trim().toLowerCase(),
      );
      if (!defaultEntry || !defaultEntry.allowedProperties || defaultEntry.allowedProperties.length === 0) return false;

      return properties.some((prop) => {
        const propNoUnit = prop.name
          .replace(/\s*\([^)]*\)\s*$/, "")
          .trim()
          .toLowerCase();
        const propBase = propNoUnit.replace(/\s*#\d+\s*$/, "").trim();
        return defaultEntry.allowedProperties.some((allowed) => {
          const allowedNoUnit = allowed
            .replace(/\s*\([^)]*\)\s*$/, "")
            .trim()
            .toLowerCase();
          const allowedHasHash = /#\d+\s*$/.test(allowed.trim());
          if (allowedHasHash) return allowedNoUnit === propNoUnit;
          const allowedBase = allowedNoUnit.replace(/\s*#\d+\s*$/, "").trim();
          return allowedBase === propBase || allowedBase === propNoUnit;
        });
      });
    },
    [properties, masterLookup, masterDefaults],
  );

  const hasActiveFilters = useMemo(
    () => (mainCategory ? mainCategoryHasFilters(mainCategory) : false),
    [mainCategory, mainCategoryHasFilters],
  );

  const handleMainCategoryChange = useCallback((path: string) => {
    setMainCategory(path);
    setMainCategorySignal((value) => value + 1);
  }, []);

  // Form state
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isImportingCsv, setIsImportingCsv] = useState(false);
  const [csvImportDragOver, setCsvImportDragOver] = useState(false);
  const [csvImportConfirmOpen, setCsvImportConfirmOpen] = useState(false);

  const [csvImportBasicInfoMode, setCsvImportBasicInfoMode] = useState<CsvImportBasicInfoMode>("fill_sku");
  const [pendingCsvImportStatus, setPendingCsvImportStatus] = useState<string>("");
  const [csvUploadCloseSignal, setCsvUploadCloseSignal] = useState(0);
  const [productViewOpen, setProductViewOpen] = useState(false);
  const [productViewData, setProductViewData] = useState<OutputWorkFormData | null>(null);
  const [csvPreviewFile, setCsvPreviewFile] = useState<File | null>(null);
  const [csvPreviewSnapshot, setCsvPreviewSnapshot] = useState<ProductCsvImportResult["jsonPayload"] | null>(null);
  const [csvPreviewLoading, setCsvPreviewLoading] = useState(false);

  const [lastCsvImportState, setLastCsvImportState] = useState<StoredCsvImportState | null>(() =>
    readLocalObject<StoredCsvImportState>(LAST_CSV_IMPORT_JSON_KEY),
  );
  const pendingCsvImportFileRef = useRef<File | null>(null);
  const pendingCsvImportResultRef = useRef<ProductCsvImportResult | null>(null);

  const suppressCsvUploadAutoCollapseRef = useRef(false);
  const csvImportJustAppliedRef = useRef(false);
  const lastCsvUploadAutoCollapseSignatureRef = useRef("");
  const skuLinkedSnapshotRestoreRequestRef = useRef(0);
  const skuSheetLookupRequestRef = useRef(0);
  const sendByEmailInFlightRef = useRef(false);
  const downloadCurrentFormInFlightRef = useRef(false);
  const pendingCompleteRecoverySweepInFlightRef = useRef(false);
  const [isSendingByEmail, setIsSendingByEmail] = useState(false);
  const [skuSheetLookupLoading, setSkuSheetLookupLoading] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [downloadConfirmOpen, setDownloadConfirmOpen] = useState(false);
  const [isDownloadingFormCsv, setIsDownloadingFormCsv] = useState(false);
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);
  const [duplicateNameDialogOpen, setDuplicateNameDialogOpen] = useState(false);
  const [duplicateNameDialogInfo, setDuplicateNameDialogInfo] = useState<DuplicateTitleInfo | null>(null);
  const pendingSubmitDuplicateNameInfoRef = useRef<DuplicateTitleInfo | null>(null);

  const resolveDuplicateTitleInfoForSubmit = useCallback(async (): Promise<DuplicateTitleInfo | null> => {
    const fallback = buildDuplicateTitleInfo();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return fallback;
    }

    setIsRefreshingFormReferenceData(true);
    try {
      await syncGoogleSheetQueries(queryClient, { includeDock: true });
    } catch {
      return fallback;
    } finally {
      setIsRefreshingFormReferenceData(false);
    }

    const latestPropData = queryClient.getQueryData<{ existingTitles?: string[] }>(["properties"]);
    const latestRecentSubmissions =
      queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? recentSubmissions;
    return buildDuplicateTitleInfo({
      existingTitles: latestPropData?.existingTitles,
      recentSubmissions: latestRecentSubmissions,
    });
  }, [buildDuplicateTitleInfo, queryClient, recentSubmissions]);
  const pendingSubmitIsOverwriteRef = useRef(false);
  const pendingCompleteRecoveryStorageKey = useMemo(
    () => getTabScopedStorageKey(PENDING_COMPLETE_RECOVERY_KEY),
    [],
  );
  const isHardReloadRef = useRef(isHardReloadNavigation());
  const hardReloadCleanupAppliedRef = useRef(false);

  const activeCsvImportState = useMemo(() => lastCsvImportState, [lastCsvImportState]);
  const activeCsvSnapshotPayload = useMemo(() => {
    if (activeCsvImportState?.cachedJsonPayload) return activeCsvImportState.cachedJsonPayload;
    if (activeCsvImportState?.cachedFormData) return buildCsvImportJsonPayloadFromStoredState(activeCsvImportState);
    return null;
  }, [activeCsvImportState]);

  const openCsvPayloadInProductView = useCallback((payload: ProductCsvImportResult["jsonPayload"] | null) => {
    if (!payload) return;
    setProductViewData({
      sku: payload.basicFields.sku || "",
      brand: payload.basicFields.brand || "",
      title: payload.basicFields.title || "",
      mainCategory: payload.basicFields.mainCategory || "",
      selectedCategories: [...(payload.basicFields.selectedCategories ?? [])],
      imageUrls: payload.images.map((img) => img.value),
      chatgptData: payload.formData.chatgptData || "",
      chatgptDescription: payload.basicFields.description || "",
      emailNotes: payload.basicFields.emailNotes || "",
      specValues: { ...(payload.formData.specValues ?? {}) },
      price: payload.basicFields.price || "",
      gpsMpn: payload.basicFields.gpsMpn || "",
    });
    setProductViewOpen(true);
  }, []);

  const csvUploadAutoCollapseSignature = useMemo(
    () =>
      JSON.stringify({
        sku,
        heldDockSku,
        gpsMpn,
        brand,
        price,
        visibility,
        title,
        chatgptData,
        chatgptDescription,
        emailNotes,
        selectedCategories,
        mainCategory,
        imageUrls,
        specValues,
        otherValues,
        datasheetUrl,
        webpageUrl,
        additionalInstructions,
        additionalInstructionsData,
      }),
    [
      additionalInstructions,
      additionalInstructionsData,
      brand,
      chatgptData,
      chatgptDescription,
      datasheetUrl,
      emailNotes,
      gpsMpn,
      heldDockSku,
      imageUrls,
      mainCategory,
      otherValues,
      price,
      visibility,
      selectedCategories,
      sku,
      specValues,
      title,
      webpageUrl,
    ],
  );

  useEffect(() => {
    if (!lastCsvImportState) {
      lastCsvUploadAutoCollapseSignatureRef.current = csvUploadAutoCollapseSignature;
      return;
    }

    if (suppressCsvUploadAutoCollapseRef.current) {
      lastCsvUploadAutoCollapseSignatureRef.current = csvUploadAutoCollapseSignature;
      suppressCsvUploadAutoCollapseRef.current = false;
      return;
    }

    if (!lastCsvUploadAutoCollapseSignatureRef.current) {
      lastCsvUploadAutoCollapseSignatureRef.current = csvUploadAutoCollapseSignature;
      return;
    }

    if (lastCsvUploadAutoCollapseSignatureRef.current !== csvUploadAutoCollapseSignature) {
      lastCsvUploadAutoCollapseSignatureRef.current = csvUploadAutoCollapseSignature;
      setCsvUploadCloseSignal((value) => value + 1);
      return;
    }

    lastCsvUploadAutoCollapseSignatureRef.current = csvUploadAutoCollapseSignature;
  }, [csvUploadAutoCollapseSignature, lastCsvImportState]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => {
      setCooldown((prev) => {
        const next = prev - 1;
        if (next <= 0) clearInterval(id);
        return Math.max(0, next);
      });
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown > 0]); // only re-subscribe when transitioning to/from active

  useEffect(() => {
    if (sendByEmailCooldown <= 0) return;
    const id = setInterval(() => {
      setSendByEmailCooldown((prev) => {
        const next = prev - 1;
        if (next <= 0) clearInterval(id);
        return Math.max(0, next);
      });
    }, 1000);
    return () => clearInterval(id);
  }, [sendByEmailCooldown > 0]);

  useEffect(() => {
    if (downloadActionCooldown <= 0) return;
    const id = setInterval(() => {
      setDownloadActionCooldown((prev) => {
        const next = prev - 1;
        if (next <= 0) clearInterval(id);
        return Math.max(0, next);
      });
    }, 1000);
    return () => clearInterval(id);
  }, [downloadActionCooldown > 0]);

  useEffect(() => {
    if (mainCategory && hasActiveFilters) {
      setFiltersOpenSignal((value) => value + 1);
    }
  }, [mainCategory, hasActiveFilters, mainCategorySignal]);

  // After dock edit loads (or initial mount from localStorage), remap specValues
  // from display-name keys (e.g. "Mounting") to prop.key (e.g. "mounting1").
  // The sheet stores custom fields as "DisplayName=Value;..." so the keys are display names.
  // When a single value maps to a group (e.g. "Colour" → colour1, colour2), assign to #1 first.
  const hasAutoFilledRef = useRef(false);
  const dockEditRemapPendingRef = useRef(false);
  useEffect(() => {
    // Run when: (a) dock-edit just fired and properties are available, or
    // (b) first mount with saved specValues and properties are available.
    const isDockEditPending = dockEditPendingRef.current || dockEditRemapPendingRef.current;
    const isInitialMount =
      !hasAutoFilledRef.current && savedState?.specValues && Object.keys(savedState.specValues).length > 0;
    const shouldRun = isDockEditPending || isInitialMount;
    if (!shouldRun) return;

    // If properties haven't loaded yet, defer the remap until they arrive.
    if (properties.length === 0) {
      if (isDockEditPending) {
        dockEditPendingRef.current = false;
        dockEditRemapPendingRef.current = true;
      }
      return;
    }

    dockEditPendingRef.current = false;
    dockEditRemapPendingRef.current = false;
    hasAutoFilledRef.current = true;

    // Build a map of base-display-name (lowercase) → sorted list of prop keys (#1 first)
    const nameToKeys: Record<string, { key: string; order: number; required: boolean }[]> = {};
    for (const p of properties) {
      const cleanName = p.name
        .replace(/\s*\([^)]*\)\s*$/, "")
        .replace(/\s*#\d+\s*$/, "")
        .replace(/\*/g, "")
        .trim();
      const hashMatch = p.name.match(/#(\d+)/);
      const order = hashMatch ? parseInt(hashMatch[1], 10) : 0;
      const lowerName = cleanName.toLowerCase();
      if (!nameToKeys[lowerName]) nameToKeys[lowerName] = [];
      nameToKeys[lowerName].push({ key: p.key, order, required: !!p.required });
    }
    // Sort each group so #1 (mandatory) comes first
    for (const group of Object.values(nameToKeys)) {
      group.sort((a, b) => {
        // Required/mandatory first
        if (a.required !== b.required) return a.required ? -1 : 1;
        // Then by #number (lower first)
        return a.order - b.order;
      });
    }

    // Also build exact key→key map for already-correct keys
    const exactKeyMap: Record<string, string> = {};
    for (const p of properties) {
      exactKeyMap[p.key.toLowerCase()] = p.key;
    }

    const remapped: Record<string, string> = {};
    const sourceUpdates: Record<string, FilterValueSource> = {};
    let needsRemap = false;

    for (const [key, value] of Object.entries(specValues)) {
      if (!value) continue;

      // Check if it's already a valid prop.key
      const exactMatch = exactKeyMap[key.toLowerCase()];
      if (exactMatch && exactMatch === key) {
        remapped[key] = value;
        continue;
      }
      if (exactMatch) {
        remapped[exactMatch] = value;
        sourceUpdates[exactMatch] = "sheet" as FilterValueSource;
        needsRemap = true;
        continue;
      }

      const displayKey = key
        .replace(/\*/g, "")
        .replace(/\s*\([^)]*\)\s*$/, "")
        .trim();
      const slotMatch = displayKey.match(/#(\d+)\s*$/);
      const requestedOrder = slotMatch ? parseInt(slotMatch[1], 10) : null;
      const baseDisplayKey = displayKey.replace(/\s*#\d+\s*$/, "").trim();

      // Match by display name → assign to first available slot (#1 first),
      // or honor an explicit `#N` suffix when the dock parser preserved it.
      const group = nameToKeys[baseDisplayKey.toLowerCase()];
      if (group && group.length > 0) {
        const slot = requestedOrder
          ? (group.find((g) => g.order === requestedOrder && !remapped[g.key]) ??
            group.find((g) => g.order === requestedOrder) ??
            group.find((g) => !remapped[g.key]))
          : group.find((g) => !remapped[g.key]);
        if (slot) {
          // Normalize dimension filter values (e.g. "29cm (DIAMETER)" → "29",
          // "12cm x 34cm" → "12X34", "22m³/h" → "22") so UI components
          // like FanCutoutInput receive the raw format they expect.
          const normalizedValue = normalizeDimensionFilterValueForStorage(baseDisplayKey || key, value);
          remapped[slot.key] = normalizedValue;
          sourceUpdates[slot.key] = "sheet" as FilterValueSource;
          needsRemap = needsRemap || normalizedValue !== value || slot.key !== key;
        }
      } else {
        // Unknown key, keep as-is
        remapped[key] = value;
      }
    }

    if (needsRemap) {
      setSpecValues(remapped);
      if (Object.keys(sourceUpdates).length > 0) {
        setFilterSources((prev) => ({ ...prev, ...sourceUpdates }));
      }
    }
  }, [specValues, properties, savedState]);

  // Stable reference for skus to avoid re-triggering the network call
  const skusRef = useRef(skus);
  skusRef.current = skus;

  useEffect(() => {
    const trimmedSku = effectiveSku.trim();
    if (!trimmedSku) {
      setSkuSheetLookupLoading(false);
      setVisibility("");
      return;
    }

    setSkuSheetLookupLoading(true);

    // Resolve brand/price/visibility synchronously from already-fetched SKU list
    const normalizedSku = trimmedSku.toUpperCase();
    const cachedEntry = skusRef.current.find(
      (s) =>
        String(s.sku ?? "")
          .trim()
          .toUpperCase() === normalizedSku,
    );
    if (cachedEntry) {
      setBrand((prev) => {
        const nextBrand = String(cachedEntry.brand ?? "").trim();
        return prev === nextBrand ? prev : nextBrand;
      });
      setPrice((prev) => {
        const nextPrice = String(cachedEntry.price ?? "").trim();
        return prev === nextPrice ? prev : nextPrice;
      });
      setVisibility((prev) => {
        const nextVisibility = String(cachedEntry.visibility ?? "").trim();
        return prev === nextVisibility ? prev : nextVisibility;
      });
    }

    const requestId = skuSheetLookupRequestRef.current + 1;
    skuSheetLookupRequestRef.current = requestId;
    let cancelled = false;

    void fetchSkuSheetDetails(trimmedSku)
      .then((details) => {
        if (cancelled || skuSheetLookupRequestRef.current !== requestId) return;
        setBrand((prev) => {
          const nextBrand = String(details.brand ?? "").trim();
          return prev === nextBrand ? prev : nextBrand;
        });
        setPrice((prev) => {
          const nextPrice = String(details.price ?? "").trim();
          return prev === nextPrice ? prev : nextPrice;
        });
        setVisibility((prev) => {
          const nextVisibility = String(details.visibility ?? "").trim();
          return prev === nextVisibility ? prev : nextVisibility;
        });
      })
      .catch((error) => {
        if (cancelled || skuSheetLookupRequestRef.current !== requestId) return;
        console.warn("SKU sheet lookup failed:", error);
      })
      .finally(() => {
        if (!cancelled && skuSheetLookupRequestRef.current === requestId) {
          setSkuSheetLookupLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveSku]);

  useEffect(() => {
    if (!isValidPriceValue(price)) return;
    setErrors((prev) => {
      if (!prev.price) return prev;
      const { price: _price, ...rest } = prev;
      return rest;
    });
  }, [price]);

  // Clear validation errors as soon as the user fulfils the field
  useEffect(() => {
    if (!effectiveSku) return;
    setErrors((prev) => {
      if (!prev.sku) return prev;
      const { sku: _sku, ...rest } = prev;
      return rest;
    });
  }, [effectiveSku]);

  useEffect(() => {
    if (selectedCategories.length === 0 || !mainCategory) return;
    setErrors((prev) => {
      if (!prev.category) return prev;
      const { category: _category, ...rest } = prev;
      return rest;
    });
  }, [selectedCategories, mainCategory]);

  useEffect(() => {
    if (!imageUrls[0]?.trim()) return;
    setErrors((prev) => {
      if (!prev.images) return prev;
      const { images: _images, ...rest } = prev;
      return rest;
    });
  }, [imageUrls]);

  useEffect(() => {
    if (!title.trim()) return;
    setErrors((prev) => {
      if (!prev.title) return prev;
      const { title: _title, ...rest } = prev;
      return rest;
    });
  }, [title]);

  useEffect(() => {
    if (!chatgptData.trim()) return;
    setErrors((prev) => {
      if (!prev.chatgptData) return prev;
      const { chatgptData: _chatgptData, ...rest } = prev;
      return rest;
    });
  }, [chatgptData]);

  useEffect(() => {
    if (!chatgptDescription.trim()) return;
    setErrors((prev) => {
      if (!prev.chatgptDescription) return prev;
      const { chatgptDescription: _chatgptDescription, ...rest } = prev;
      return rest;
    });
  }, [chatgptDescription]);

  const buildCurrentPersistedFormState = useCallback(
    (): PersistedProductFormState => ({
      sku,
      heldDockSku,
      mpnDraftId,
      gpsMpn,
      mpnAttachmentState,
      brand,
      price,
      retailPrice,
      visibility,
      title,
      loadedDockSourceSku,
      loadedDockSourceTitle,
      chatgptData,
      chatgptDescription,
      datasheetUrl,
      webpageUrl,
      selectedCategories,
      mainCategory,
      imageUrls,
      specValues,
      otherValues,
      emailNotes,
      additionalInstructions,
      additionalInstructionsData,
      loadedDockSubmissionEpochMs,
      loadedDockSubmissionSku,
    }),
    [
      additionalInstructions,
      additionalInstructionsData,
      brand,
      chatgptData,
      chatgptDescription,
      datasheetUrl,
      emailNotes,
      gpsMpn,
      mpnDraftId,
      mpnAttachmentState,
      heldDockSku,
      imageUrls,
      loadedDockSourceSku,
      loadedDockSourceTitle,
      loadedDockSubmissionEpochMs,
      loadedDockSubmissionSku,
      mainCategory,
      otherValues,
      price,
      retailPrice,
      visibility,
      selectedCategories,
      sku,
      specValues,
      title,
      webpageUrl,
    ],
  );

  const applyPersistedFormStateSnapshot = useCallback(
    (snapshot: PersistedProductFormState) => {
      resetTransientAiUiStateRef.current();
      setSku(String(snapshot.sku ?? "").trim());
      setHeldDockSku(String(snapshot.heldDockSku ?? "").trim());
      setMpnDraftId(normalizeToUuidDraftId(snapshot.mpnDraftId));
      setGpsMpn(String(snapshot.gpsMpn ?? "").trim());
      setMpnAttachmentState(snapshot.mpnAttachmentState === "attached" ? snapshot.mpnAttachmentState : "none");
      setLoadedDockSourceSku(String(snapshot.loadedDockSourceSku ?? "").trim());
      setLoadedDockSourceTitle(normalizeProductTitleWhitespace(String(snapshot.loadedDockSourceTitle ?? "")));
      setLoadedDockSubmissionEpochMs(
        Number.isFinite(Number(snapshot.loadedDockSubmissionEpochMs)) &&
          Number(snapshot.loadedDockSubmissionEpochMs) > 0
          ? Number(snapshot.loadedDockSubmissionEpochMs)
          : undefined,
      );
      setLoadedDockSubmissionSku(String(snapshot.loadedDockSubmissionSku ?? "").trim());
      setBrand(String(snapshot.brand ?? "").trim());
      setPrice(String(snapshot.price ?? "").trim());
      setVisibility(String(snapshot.visibility ?? "").trim());
      setTitle(String(snapshot.title ?? "").trim());
      setChatgptData(String(snapshot.chatgptData ?? ""));
      setChatgptDescription(String(snapshot.chatgptDescription ?? ""));
      setDatasheetFile(null);
      setWebsitePdfFile(null);
      setDatasheetUrl(String(snapshot.datasheetUrl ?? "").trim());
      setWebpageUrl(String(snapshot.webpageUrl ?? "").trim());
      setSelectedCategories(
        Array.isArray(snapshot.selectedCategories) ? snapshot.selectedCategories.filter(Boolean) : [],
      );
      setMainCategory(String(snapshot.mainCategory ?? "").trim());
      setMainCategorySignal((value) => value + 1);
      setImageUrls(
        Array.isArray(snapshot.imageUrls) && snapshot.imageUrls.some((value) => String(value ?? "").trim())
          ? snapshot.imageUrls.map((value) => String(value ?? ""))
          : [""],
      );
      setSpecValues({ ...(snapshot.specValues ?? {}) });
      setOtherValues(
        snapshot.otherValues && Object.keys(snapshot.otherValues).length > 0 ? { ...snapshot.otherValues } : {},
      );
      setEmailNotes(String(snapshot.emailNotes ?? ""));
      setAdditionalInstructions(String(snapshot.additionalInstructions ?? ""));
      setAdditionalInstructionsData(String(snapshot.additionalInstructionsData ?? ""));
      setErrors({});
      setMandatoryErrors(new Set());
      setConflicts([]);
      setExtractionConflicts([]);
      setFilterProposals([]);
      setFilterSources({});
      setManuallyEditedFilters(new Set());
      setIncludeEditedAiData(false);
      setLastGenerateMode("");
      clearAiTracking();
    },
    [setDatasheetFile, setMainCategorySignal, setWebsitePdfFile],
  );

  const persistSkuLinkedFormSnapshot = useCallback(async (snapshotFormState: PersistedProductFormState) => {
    const snapshotSku = String(snapshotFormState.sku ?? "").trim();
    const snapshotKey = normalizeSkuSnapshotKey(snapshotSku);
    if (!snapshotKey) return;
    const sanitizedFormState: PersistedProductFormState =
      snapshotFormState.mpnAttachmentState === "attached"
        ? snapshotFormState
        : {
            ...snapshotFormState,
            gpsMpn: "",
            mpnAttachmentState: "none",
          };

    const existingSnapshots = readLocalObject<StoredSkuLinkedFormSnapshotsMap>(SKU_LINKED_FORM_SNAPSHOTS_KEY) ?? {};
    const savedAt = new Date().toISOString();
    const nextSnapshot: StoredSkuLinkedFormSnapshot = {
      sku: snapshotSku,
      savedAt,
      formState: sanitizedFormState,
    };
    const nextSnapshots = {
      ...existingSnapshots,
      [snapshotKey]: nextSnapshot,
    };
    writeLocalObject(SKU_LINKED_FORM_SNAPSHOTS_KEY, nextSnapshots);
  }, []);

  const restoreSkuLinkedFormSnapshot = useCallback(
    async (targetSku: string): Promise<PersistedProductFormState | null> => {
      const snapshotKey = normalizeSkuSnapshotKey(targetSku);
      if (!snapshotKey) return null;

      const storedSnapshots = readLocalObject<StoredSkuLinkedFormSnapshotsMap>(SKU_LINKED_FORM_SNAPSHOTS_KEY) ?? {};
      const storedSnapshot = storedSnapshots[snapshotKey];
      if (!storedSnapshot) return null;

      const requestId = skuLinkedSnapshotRestoreRequestRef.current + 1;
      skuLinkedSnapshotRestoreRequestRef.current = requestId;

      const applyIfCurrent = (formState: PersistedProductFormState): PersistedProductFormState | null => {
        if (skuLinkedSnapshotRestoreRequestRef.current !== requestId) return null;
        const normalizedFormState = {
          ...formState,
          sku: String(formState.sku ?? targetSku).trim() || targetSku,
        };
        applyPersistedFormStateSnapshot(normalizedFormState);
        return normalizedFormState;
      };

      if (!storedSnapshot.formState || Object.keys(storedSnapshot.formState).length === 0) {
        return null;
      }

      return applyIfCurrent(storedSnapshot.formState);
    },
    [applyPersistedFormStateSnapshot],
  );

  const handleSkuSelect = useCallback(
    (selectedSku: string, _selectedBrand: string) => {
      const trimmedSelectedSku = String(selectedSku ?? "").trim();
      const normalizedSelectedSku = trimmedSelectedSku.toUpperCase();
      const cachedEntry = skus.find(
        (s) =>
          String(s.sku ?? "")
            .trim()
            .toUpperCase() === normalizedSelectedSku,
      );
      const currentState = buildCurrentPersistedFormState();
      const currentSku = String(currentState.sku ?? "").trim();
      if (normalizeSkuSnapshotKey(trimmedSelectedSku) === normalizeSkuSnapshotKey(currentSku)) {
        return;
      }

      if (currentSku) {
        void persistSkuLinkedFormSnapshot(currentState);
      }

      setMpnDraftId(createMpnDraftId());
      setGpsMpn("");
      setMpnAttachmentState("none");
      setHeldDockSku("");
      setLoadedDockSourceSku("");
      setLoadedDockSourceTitle("");
      setLoadedDockSubmissionEpochMs(undefined);
      setLoadedDockSubmissionSku("");
      setSkuSheetLookupLoading(Boolean(trimmedSelectedSku));
      setSku(trimmedSelectedSku);
      setBrand(String(cachedEntry?.brand ?? "").trim());
      setPrice(String(cachedEntry?.price ?? "").trim());
      // Restore cached retail price for the new SKU (if previously generated)
      setRetailPrice(getCachedRetailPrice(trimmedSelectedSku));
    },
    [buildCurrentPersistedFormState, persistSkuLinkedFormSnapshot, skus],
  );

  useEffect(() => {
    const trimmedSku = effectiveSku.trim();
    const shouldPreviewNextMpn = Boolean(trimmedSku) && mpnAttachmentState !== "attached";

    if (!shouldPreviewNextMpn) {
      if (!trimmedSku) {
        setGpsMpn("");
      }
      mpnPreviewSkuRef.current = trimmedSku;
      lastPreviewedMpnRef.current = "";
      setMpnLoading(false);
      return;
    }

    // no loading indicator — just silently refresh in background

    if (mpnPreviewSkuRef.current !== trimmedSku) {
      mpnPreviewSkuRef.current = trimmedSku;
      lastPreviewedMpnRef.current = "";
    }

    let cancelled = false;
    const requestId = mpnPreviewRefreshRequestRef.current + 1;
    mpnPreviewRefreshRequestRef.current = requestId;

    const refreshNextMpn = async () => {
      try {
        const nextMpn = await peekNextMpnDirect();
        if (cancelled || mpnPreviewRefreshRequestRef.current !== requestId) return;
        // Silently update if MPN was claimed — no toast needed
        lastPreviewedMpnRef.current = nextMpn;
        setGpsMpn(nextMpn);
        setMpnLoading(false);
      } catch (error) {
        if (!cancelled) {
          console.warn("[MPN] Could not refresh next available MPN:", error);
        }
      }
    };

    void refreshNextMpn();

    return () => {
      cancelled = true;
    };
  }, [effectiveSku, mpnAttachmentState, toast]);

  const handleSpecChange = useCallback((key: string, value: string) => {
    setSpecValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleOtherValue = useCallback((propertyName: string, value: string) => {
    setOtherValues((prev) => ({ ...prev, [propertyName]: value }));
  }, []);

  useEffect(() => {
    if (datasheetFile) {
      const url = URL.createObjectURL(datasheetFile);
      setDatasheetPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setDatasheetPreviewUrl(null);
  }, [datasheetFile]);

  useEffect(() => {
    if (!datasheetFile) {
      setDatasheetPdfData(null);
      return;
    }
    let cancelled = false;
    datasheetFile
      .arrayBuffer()
      .then((buf) => {
        if (!cancelled) setDatasheetPdfData(buf);
      })
      .catch(() => {
        if (!cancelled) setDatasheetPdfData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [datasheetFile]);

  // Save form state to localStorage whenever any value changes
  useEffect(() => {
    const formState = buildCurrentPersistedFormState();
    try {
      localStorage.setItem(formStateStorageKey, JSON.stringify(formState));
    } catch {
      // Non-fatal: keep runtime state even if localStorage is unavailable.
    }
  }, [buildCurrentPersistedFormState, formStateStorageKey]);

  const recentSubmissionSkuSet = useMemo(
    () => new Set(recentSubmissions.map((entry) => entry.sku.trim().toUpperCase()).filter(Boolean)),
    [recentSubmissions],
  );

  const selectableSkus = useMemo(() => {
    const normalizedEffectiveSku = effectiveSku.trim().toUpperCase();
    return skus.filter((entry) => {
      const normalizedSku = entry.sku.trim().toUpperCase();
      if (!normalizedSku) return false;
      if (normalizedSku === normalizedEffectiveSku) return true;
      return !recentSubmissionSkuSet.has(normalizedSku);
    });
  }, [skus, recentSubmissionSkuSet, effectiveSku]);

  useEffect(() => {
    if (websitePdfFile) {
      const url = URL.createObjectURL(websitePdfFile);
      setWebsitePreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setWebsitePreviewUrl(null);
  }, [websitePdfFile]);

  useEffect(() => {
    if (!websitePdfFile) {
      setWebsitePdfData(null);
      return;
    }
    let cancelled = false;
    websitePdfFile
      .arrayBuffer()
      .then((buf) => {
        if (!cancelled) setWebsitePdfData(buf);
      })
      .catch(() => {
        if (!cancelled) setWebsitePdfData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [websitePdfFile]);

  useEffect(() => {
    if (datasheetPreviewUrl && !websitePreviewUrl) {
      setPdfView("datasheet");
    } else if (!datasheetPreviewUrl && websitePreviewUrl) {
      setPdfView("website");
    }
  }, [datasheetPreviewUrl, websitePreviewUrl]);

  // Helper: gather PDF files currently loaded in frontend for AI calls
  const getAiFiles = useCallback(() => {
    const files: Array<{ file: File; label: string }> = [];
    if (datasheetFile) files.push({ file: datasheetFile, label: "datasheet" });
    if (websitePdfFile) files.push({ file: websitePdfFile, label: "website" });
    return files;
  }, [datasheetFile, websitePdfFile]);

  /**
   * Fetch the per-prompt instruction PDF from storage (prompt-{promptType}/).
   * Returns a File object or null. Uses the instruction cache.
   */
  const fetchPromptInstructionPdf = useCallback(
    async (promptType: string): Promise<{ file: File; label: string } | null> => {
      const folder = `prompt-${promptType}`;
      const cacheKey = `__prompt_instr_${promptType}`;
      const cached = instructionCacheRef.current[cacheKey] || productInstructionCache.get(cacheKey);
      try {
        const { data: files } = await withProductStepTimeout(
          supabase.storage
            .from("document-uploads-constant")
            .list(folder, { limit: 1, sortBy: { column: "created_at", order: "desc" } }),
          STORAGE_FETCH_TIMEOUT_MS,
          `Prompt instruction list (${promptType})`,
        );
        if (!files || files.length === 0) return null;

        const latest = files[0];
        if (cached && cached.file.name === latest.name && Date.now() - cached.loadedAt < INSTRUCTION_CACHE_TTL_MS) {
          instructionCacheRef.current[cacheKey] = cached;
          return { file: cached.file, label: "instructions" };
        }

        const { data: blob } = await withProductStepTimeout(
          supabase.storage.from("document-uploads-constant").download(`${folder}/${latest.name}`),
          STORAGE_FETCH_TIMEOUT_MS,
          `Prompt instruction download (${promptType})`,
        );
        if (!blob) return null;

        const file = new File([blob], latest.name, { type: "application/pdf" });
        instructionCacheRef.current[cacheKey] = { file, loadedAt: Date.now() };
        productInstructionCache.set(cacheKey, instructionCacheRef.current[cacheKey]);
        return { file, label: "instructions" };
      } catch {
        return null;
      }
    },
    [],
  );

  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingDesc, setIsGeneratingDesc] = useState(initialTitleDescRuntime.status === "running");
  const descCancelledRef = useRef(false);
  const titleDescPreRunValuesRef = useRef<{ title: string; description: string }>({ title: "", description: "" });
  const aiJob = useAiJob();
  const [lastGenerateMode, setLastGenerateMode] = useState<string>(() => {
    // Restore from sessionStorage to survive tab switches
    try {
      return sessionStorage.getItem("last_generate_mode_v1") || "";
    } catch {
      return "";
    }
  });
  const aiJobIsActive = aiJob.status === "uploading" || aiJob.status === "queued" || aiJob.status === "running";
  const isGeneratingActive = isGenerating || aiJobIsActive;
  const [generateCooldown, setGenerateCooldown] = useState(0);
  const GENERATE_ERROR_COOLDOWN_SECONDS = 10;
  const [promptMode, setPromptMode] = useState<"technical" | "marketing">(
    initialTitleDescRuntime.promptMode === "marketing" ? "marketing" : "technical",
  );
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [extractionConflicts, setExtractionConflicts] = useState<string[]>([]);
  const [pdfComparisonWarning, setPdfComparisonWarning] = useState<string | null>(null);
  const [filterProposals, setFilterProposals] = useState<FilterProposal[]>([]);
  const [generateComplete, setGenerateComplete] = useState(false);
  const [descComplete, setDescComplete] = useState(false);
  const [descProgress, setDescProgress] = useState(0);
  const [aiCollisionTuning, setAiCollisionTuning] = useState<AiCollisionTuningConfig>(() =>
    getAiCollisionTuningConfig(),
  );
  const [filterSources, setFilterSources] = useState<Record<string, FilterValueSource>>({});
  const [manuallyEditedFilters, setManuallyEditedFilters] = useState<Set<string>>(new Set());
  const instructionCacheRef = useRef<Record<string, { file: File; loadedAt: number }>>({});
  const [generateDebugOutput, setGenerateDebugOutput] = useState("");
  const [titleDescDebugOutput, setTitleDescDebugOutput] = useState(
    savedStateLoadedFromDock ? "" : initialTitleDescRuntime.debugOutput || "",
  );
  const [generateRawPromptOutputDebug, setGenerateRawPromptOutputDebug] = useState({ prompt: "", output: "" });
  const [titleDescRawPromptOutputDebug, setTitleDescRawPromptOutputDebug] = useState({
    prompt: "",
    output: "",
  });
  const generateDebugEventsRef = useRef<Array<Record<string, unknown>>>([]);
  const aiLogInFlightBySkuRef = useRef<Set<string>>(new Set());
  const aiLogLastSignatureBySkuRef = useRef<Map<string, string>>(new Map());
  const aiLogRowNumberBySkuRef = useRef<Map<string, number>>(new Map());
  const lastJobStatusDebugSignatureRef = useRef("");
  const lastJobStatusPayloadMarkerRef = useRef("");
  const lastJobErrorDebugSignatureRef = useRef("");
  const recoveredHeuristicErrorJobRef = useRef<string | null>(null);
  const recoveredStrictErrorJobRef = useRef<string | null>(null);
  const strictValidationRetryUsedRef = useRef(false);
  const surfacedGenerateErrorJobRef = useRef<string | null>(null);
  const generateCooldownErrorSignatureRef = useRef<string>("");
  const generateSessionRef = useRef(0);

  useEffect(() => {
    const applyRuntime = () => {
      const runtime = readTitleDescRuntimeState();
      if (runtime.status === "running") {
        setIsGeneratingDesc(true);
        setDescComplete(false);
      } else if (runtime.status === "done") {
        setIsGeneratingDesc(false);
      } else if (runtime.status === "error" || runtime.status === "idle") {
        setIsGeneratingDesc(false);
        setDescComplete(false);
      }
      if (runtime.promptMode === "technical" || runtime.promptMode === "marketing") {
        setPromptMode(runtime.promptMode);
      }
      setTitleDescDebugOutput(runtime.debugOutput || "");
      if (runtime.title) {
        setTitle((prev) => (prev === runtime.title ? prev : runtime.title));
      }
      if (runtime.description) {
        setChatgptDescription((prev) => (prev === runtime.description ? prev : runtime.description));
      }
    };

    const onRuntimeUpdate = () => applyRuntime();
    window.addEventListener(TITLE_DESC_RUNTIME_EVENT, onRuntimeUpdate);
    return () => {
      window.removeEventListener(TITLE_DESC_RUNTIME_EVENT, onRuntimeUpdate);
    };
  }, []);

  useEffect(() => {
    if (!savedStateLoadedFromDock) return;
    writeTitleDescRuntimeState({
      status: "idle",
      debugOutput: "",
      title: "",
      description: "",
    });
  }, [savedStateLoadedFromDock]);

  useEffect(() => {
    // Persist selected mode across remounts even before a run starts.
    writeTitleDescRuntimeState({ promptMode });
  }, [promptMode]);

  // Persist lastGenerateMode to sessionStorage for tab-switch recovery
  useEffect(() => {
    try {
      if (lastGenerateMode) {
        sessionStorage.setItem("last_generate_mode_v1", lastGenerateMode);
      } else {
        sessionStorage.removeItem("last_generate_mode_v1");
      }
    } catch {
      /* ignore */
    }
  }, [lastGenerateMode]);

  useEffect(() => {
    const refreshTuning = () => {
      setAiCollisionTuning(getAiCollisionTuningConfig());
    };

    window.addEventListener("ai-collision-tuning-updated", refreshTuning as EventListener);
    return () => {
      window.removeEventListener("ai-collision-tuning-updated", refreshTuning as EventListener);
    };
  }, []);
  const applyGenerateDataResponseRef = useRef<
    (
      response: GenerateLikeResponse,
      opts?: {
        recoveredFromHeuristicError?: boolean;
        allowFilterAutofill?: boolean;
      },
    ) => boolean
  >(() => false);
  const combinedGenerateProgress = Math.max(aiJob.progress, 2);

  const friendlyGenerateError = useMemo<FriendlyGenerateError | null>(() => {
    if (aiJob.status !== "error") return null;

    const errorText = (aiJob.error || "").trim();
    const statusTiming =
      aiJob.statusPayload?.timing &&
      typeof aiJob.statusPayload.timing === "object" &&
      !Array.isArray(aiJob.statusPayload.timing)
        ? (aiJob.statusPayload.timing as Record<string, unknown>)
        : null;
    const resultMeta =
      aiJob.result?.meta && typeof aiJob.result.meta === "object" && !Array.isArray(aiJob.result.meta)
        ? (aiJob.result.meta as Record<string, unknown>)
        : null;
    const resultDebug =
      resultMeta?.debug && typeof resultMeta.debug === "object" && !Array.isArray(resultMeta.debug)
        ? (resultMeta.debug as Record<string, unknown>)
        : null;
    const debugTiming =
      resultDebug?.timing && typeof resultDebug.timing === "object" && !Array.isArray(resultDebug.timing)
        ? (resultDebug.timing as Record<string, unknown>)
        : null;
    const validationRetry =
      resultDebug?.validation_retry &&
      typeof resultDebug.validation_retry === "object" &&
      !Array.isArray(resultDebug.validation_retry)
        ? (resultDebug.validation_retry as Record<string, unknown>)
        : null;
    const timing = statusTiming ?? debugTiming;

    const validationReason =
      typeof timing?.validation_failed_reason === "string" ? timing.validation_failed_reason : "";
    const retryUsed = Number(timing?.validation_retries_used || validationRetry?.used || 0);
    const retryMax = Number(timing?.validation_retry_max || validationRetry?.max || 0);
    const retrySummary =
      Number.isFinite(retryUsed) && Number.isFinite(retryMax) && retryMax > 0
        ? ` (retry attempts used: ${retryUsed}/${retryMax})`
        : "";
    const uiErrorCode = typeof resultDebug?.ui_error_code === "string" ? resultDebug.ui_error_code : "";

    // -- Strict confidence-gate failures (preflight hard-stop) --
    if (/low_confidence_input/i.test(errorText)) {
      const guidance = errorText.replace(/LOW_CONFIDENCE_INPUT:\s*/i, "").trim();
      return {
        title: "Input quality check failed",
        message: "AI was intentionally blocked before processing because the input quality/confidence was too low.",
        suggestion: guidance || "Re-upload clearer PDFs with selectable text, then run Generate Data again.",
        retryRecommended: false,
      };
    }

    // -- PDF / file issues --
    if (
      uiErrorCode === "product_data_placeholder_after_retries" ||
      (validationReason === "critical_required_sections_missing_or_placeholder" && /PRODUCT_DATA/i.test(errorText))
    ) {
      return {
        title: "AI couldn\u2019t extract product data",
        message: `The AI could not read any usable product data from your PDFs${retrySummary}.`,
        suggestion:
          "Check both PDFs are for the same product and contain selectable text (not image-only scans). Re-upload cleaner files and click Generate Data again.",
        retryRecommended: true,
      };
    }

    if (validationReason === "product_data_no_valid_field_lines") {
      return {
        title: "Product data format was unusable",
        message: `The AI output did not contain valid product data lines${retrySummary}. This usually means the PDFs are image-only or contain very little readable text.`,
        suggestion:
          "Re-upload PDFs that contain selectable text (not scanned images). If the PDFs look fine, click Generate Data to try again.",
        retryRecommended: true,
      };
    }

    if (validationReason === "critical_required_sections_missing_or_placeholder") {
      return {
        title: "AI output was missing required sections",
        message: `The AI response was missing critical product data sections${retrySummary}.`,
        suggestion:
          "This usually means the PDF could not be read properly. Re-upload clearer files and click Generate Data again.",
        retryRecommended: true,
      };
    }

    // -- Empty / incomplete AI responses --
    if (validationReason === "json_output_empty") {
      return {
        title: "AI returned empty output",
        message: `No structured content was returned from the AI${retrySummary}.`,
        suggestion:
          "Click Generate Data to retry. If this keeps happening, re-upload your PDFs - they may be corrupted or unreadable.",
        retryRecommended: true,
      };
    }

    if (validationReason === "json_output_below_minimum_properties") {
      return {
        title: "AI output was incomplete",
        message: `The AI returned too few data fields${retrySummary}.`,
        suggestion:
          "Click Generate Data to retry. If repeated, ensure your source PDFs clearly include product specifications.",
        retryRecommended: true,
      };
    }

    // -- Compare-specific validation failures --
    if (validationReason === "compare_extracted_data_not_array") {
      return {
        title: "Compare output format was invalid",
        message: "The AI compare result was not in a usable format.",
        suggestion:
          "Click AI Compare to retry. If repeated, ensure both PDFs are standard datasheets with selectable text.",
        retryRecommended: true,
      };
    }

    if (
      validationReason === "compare_rows_not_reportable" ||
      validationReason === "compare_reportable_rows_below_minimum"
    ) {
      return {
        title: "Compare had too few usable rows",
        message: `The AI could not produce enough comparison rows${retrySummary}.`,
        suggestion:
          "Ensure both files are datasheets for the same product, then retry. Different products or image-only PDFs will cause this.",
        retryRecommended: true,
      };
    }

    if (validationReason === "compare_invalid_comparison_audit") {
      return {
        title: "Compare summary was invalid",
        message: "The comparison output could not be processed.",
        suggestion: "Re-upload the PDFs and click AI Compare to try again.",
        retryRecommended: true,
      };
    }

    // -- Chunk / processing failures --
    if (/all\s*chunks?\s*failed/i.test(errorText)) {
      return {
        title: "AI processing failed",
        message: "All processing chunks failed. The PDFs may be too large, corrupted, or image-only.",
        suggestion:
          "Re-upload smaller or cleaner PDFs and click Generate Data again. If the problem persists, contact Eran.",
        retryRecommended: true,
      };
    }

    // -- Rate limits --
    if (/rate limit|429/i.test(errorText)) {
      return {
        title: "AI rate limit reached",
        message: "Too many requests were sent to the AI service.",
        suggestion: "Wait 30-60 seconds, then click Generate Data again.",
        retryRecommended: true,
      };
    }

    // -- Timeouts --
    if (/timeout|timed out/i.test(errorText)) {
      return {
        title: "AI request timed out",
        message: "The AI took too long to respond.",
        suggestion: "Click Generate Data to retry. If repeated with the same files, try smaller or simpler PDFs.",
        retryRecommended: true,
      };
    }

    // -- API key / config errors (system) --
    if (/api.?key|not set|not configured|unauthorized|403|401/i.test(errorText)) {
      return {
        title: "AI service configuration error",
        message: "The AI service is not properly configured.",
        suggestion: "This is a system issue - contact Eran to resolve it.",
        retryRecommended: false,
      };
    }

    // -- Network / infrastructure errors (system) --
    if (
      /network|fetch|ECONNREFUSED|ENOTFOUND|502|503|500|internal server|connection reset|connection error|sendrequest|timed out|timeout/i.test(
        errorText,
      )
    ) {
      return {
        title: "Connection error",
        message: "Could not connect to the AI service.",
        suggestion: "Check your internet connection and click Generate Data to retry. If repeated, contact Eran.",
        retryRecommended: true,
      };
    }

    // -- Supabase / bucket errors --
    if (/bucket|storage|upload.*fail|slot/i.test(errorText)) {
      return {
        title: "File upload error",
        message: "There was a problem uploading your files to the server.",
        suggestion: "Click Generate Data to retry. If repeated, contact Eran.",
        retryRecommended: true,
      };
    }

    // -- Conflict plausibility (edge case) --
    if (/conflict plausibility/i.test(errorText)) {
      return {
        title: "AI flagged potential conflict issues",
        message: "The AI detected possible discrepancies between your two PDFs.",
        suggestion:
          "Review the results. If data looks incorrect, re-upload the correct datasheets and click Generate Data again.",
        retryRecommended: true,
      };
    }

    // -- Default fallback --
    return {
      title: "Generate Data failed",
      message: "An unexpected error occurred during AI processing.",
      suggestion:
        "Click Generate Data to retry. If this keeps happening, re-upload your PDFs. If it still fails, contact Eran.",
      retryRecommended: true,
    };
  }, [aiJob.error, aiJob.result, aiJob.status, aiJob.statusPayload]);

  const generateProgressPhase = isGeneratingActive
    ? aiJob.status === "uploading"
      ? "Uploading files"
      : aiJob.status === "queued"
        ? "Queued for AI processing"
        : aiJob.status === "running" && aiJob.chunksTotal === 0
          ? "Preparing document chunks"
          : aiJob.status === "running" && aiJob.chunksTotal > 0 && aiJob.chunksDone === 0
            ? lastGenerateMode === "TWO_PDFS"
              ? "Deep searching both PDFs"
              : "Deep searching uploaded PDF"
            : aiJob.status === "running"
              ? "Finalizing extracted data"
              : "Starting AI processing"
    : "";
  const generateProgressTags = isGeneratingActive
    ? aiJob.status === "uploading"
      ? ["Uploading files"]
      : aiJob.status === "queued"
        ? ["Queued"]
        : aiJob.status === "running" && aiJob.chunksTotal === 0
          ? ["AI started", "Chunking"]
          : aiJob.status === "running" && aiJob.chunksTotal > 0 && aiJob.chunksDone === 0
            ? ["AI started", "Deep search"]
            : aiJob.status === "running"
              ? ["Deep search", "Building results"]
              : ["Starting"]
    : [];
  const hasAiDataForTitleDesc = chatgptData.trim().length > 0;
  const canGenerateDescription = !isGeneratingActive && hasAiDataForTitleDesc && !hasCombinedMandatoryMissing;
  const titleDescLockInfo = useMemo(() => {
    if (canGenerateDescription) return null;
    if (isGeneratingActive) {
      return {
        tone: "neutral" as const,
        message: "Generate Data is still running.",
      };
    }
    if (hasCombinedMandatoryMissing && combinedMissingWarning) {
      return {
        tone: "warning" as const,
        message: combinedMissingWarning,
      };
    }
    return {
      tone: "neutral" as const,
      message: "Generate AI-Data first.",
    };
  }, [combinedMissingWarning, canGenerateDescription, hasCombinedMandatoryMissing, isGeneratingActive]);

  /** Build a text summary of filled specifications/filters for prompt injection */
  const buildSpecsSummary = useCallback((): string | undefined => {
    const filled = Object.entries(specValues)
      .filter(([, v]) => v && v.trim())
      .map(([key, value]) => {
        const prop = properties.find((p) => p.key === key);
        const label = prop?.name || key;
        return `${label}: ${value}`;
      });
    return filled.length > 0 ? filled.join("\n") : undefined;
  }, [specValues, properties]);

  const clearAiGeneratedDataAndFilters = useCallback(
    (clearData: boolean) => {
      if (clearData) {
        setChatgptData("");
      }
      setFilterProposals([]);
      setSpecValues((prev) => {
        const next = { ...prev };
        for (const [key, source] of Object.entries(filterSources)) {
          if (source === "ai" || source === "override") {
            delete next[key];
          }
        }
        return next;
      });
      setFilterSources((prev) => {
        const next = { ...prev };
        for (const [key, source] of Object.entries(prev)) {
          if (source === "ai" || source === "override") {
            delete next[key];
          }
        }
        return next;
      });
    },
    [filterSources],
  );

  const clearAiFilterBadgeStatePreservingValues = useCallback(() => {
    setFilterProposals([]);
    setFilterSources((prev) => {
      const next = { ...prev };
      for (const [key, source] of Object.entries(prev)) {
        if (source === "ai" || source === "override") {
          delete next[key];
        }
      }
      return next;
    });
  }, []);

  const mergeConflictLists = useCallback((existing: string[], next: string[]) => {
    const merged: string[] = [];
    for (const item of [...existing, ...next]) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      if (merged.some((existingItem) => existingItem.toLowerCase() === trimmed.toLowerCase())) continue;
      merged.push(trimmed);
    }
    return merged;
  }, []);

  const sanitizeTwoPdfConflictLines = useCallback(
    (lines: string[]): { lines: string[]; droppedCount: number } => {
      const cleaned: string[] = [];
      let droppedCount = 0;

      for (const rawLine of lines) {
        const trimmed = rawLine.replace(/^[-•]\s*/, "").trim();
        if (!trimmed) continue;

        const lineMatch = trimmed.match(/^([^:]+):\s*(.+)$/);
        if (!lineMatch) {
          droppedCount += 1;
          continue;
        }

        const field = lineMatch[1].trim();
        const payload = lineMatch[2].trim();
        if (field.length < 2 || payload.length < 3) {
          droppedCount += 1;
          continue;
        }

        const isSourceAwareFormat = /^datasheet\s+.*?\s+vs\.?\s+website\s+.*$/i.test(payload);
        const isGenericMismatchFormat = /^datasheet\/website mismatch/i.test(payload);
        const isInternalMismatchFormat = /^(datasheet|website)\s+internal/i.test(payload);

        if (!isSourceAwareFormat && !isGenericMismatchFormat && !isInternalMismatchFormat) {
          droppedCount += 1;
          continue;
        }

        cleaned.push(`${field}: ${payload}`);
      }

      return {
        lines: mergeConflictLists([], cleaned),
        droppedCount,
      };
    },
    [mergeConflictLists],
  );

  const preferSourceAwareTwoPdfConflicts = useCallback((lines: string[]): string[] => {
    if (lines.length === 0) return lines;

    const parsed = lines
      .map((line, index) => ({
        line: line.trim(),
        index,
      }))
      .filter((item) => item.line.length > 0)
      .map((item) => {
        const field =
          item.line
            .match(/^([^:]+):/)?.[1]
            ?.trim()
            .toUpperCase() || "";
        const sourceAware =
          /\bdatasheet\s*:\s*"?|\bwebsite\s*:\s*"?|\bdatasheet\s+.*?\s+vs\.?\s+website\s+/i.test(item.line) ||
          /\b(datasheet|website)\s+internal(?:\s+conflict)?\b/i.test(item.line) ||
          /\bdatasheet\/website mismatch\b/i.test(item.line);
        return { ...item, field, sourceAware };
      });

    const sourceAwareByField = new Set(
      parsed.filter((item) => item.field && item.sourceAware).map((item) => item.field),
    );

    return parsed
      .filter((item) => {
        if (!item.field) return true;
        if (!sourceAwareByField.has(item.field)) return true;
        return item.sourceAware;
      })
      .sort((a, b) => a.index - b.index)
      .map((item) => item.line);
  }, []);

  const formatTwoPdfConflictForDisplay = useCallback((line: string): string => {
    const trimmed = line.trim();
    if (!trimmed) return trimmed;

    const isDisplayMissingValue = (value: string) => {
      const normalized = value.trim().replace(/^"+|"+$/g, "");
      return normalized === "---" || /^MISSING(?:\*{3})?(?:\s*\([^)]*\))?$/i.test(normalized);
    };

    const sourceAwareMatch = trimmed.match(
      /^([^:]+):\s*datasheet\s+["']?(.*?)["']?\s+vs\.?\s+website\s+["']?(.*?)["']?$/i,
    );
    if (sourceAwareMatch) {
      const [, field, datasheetValue, websiteValue] = sourceAwareMatch;
      if (isDisplayMissingValue(datasheetValue) && !isDisplayMissingValue(websiteValue)) {
        return `${field.trim()}: website only "${websiteValue}"`;
      }
      if (!isDisplayMissingValue(datasheetValue) && isDisplayMissingValue(websiteValue)) {
        return `${field.trim()}: datasheet only "${datasheetValue}"`;
      }
      return trimmed;
    }

    const genericMatch = trimmed.match(/^([^:]+):\s*datasheet\/website mismatch\s*\((.*)\)$/i);
    if (!genericMatch) return trimmed;

    const field = genericMatch[1].trim();
    const payload = genericMatch[2];
    const values = Array.from(payload.matchAll(/"([^"]+)"/g))
      .map((match) => match[1].trim())
      .filter(Boolean);
    if (values.length === 0) return trimmed;

    const datasheetValue = values[0];
    const websiteValues = values.slice(1);
    const websiteValue = websiteValues.length > 0 ? websiteValues.join(" / ") : "---";
    if (isDisplayMissingValue(datasheetValue) && !isDisplayMissingValue(websiteValue)) {
      return `${field}: website only "${websiteValue}"`;
    }
    if (!isDisplayMissingValue(datasheetValue) && isDisplayMissingValue(websiteValue)) {
      return `${field}: datasheet only "${datasheetValue}"`;
    }

    return `${field}: datasheet "${datasheetValue}" vs website "${websiteValue}"`;
  }, []);

  const formatSinglePdfConflictForDisplay = useCallback((line: string): string => {
    const trimmed = line.trim();
    if (!trimmed) return trimmed;
    return trimmed.replace(/^[-•]\s*/, "");
  }, []);

  const extractConflictFieldLabels = useCallback(
    (conflictLines: string[]): string[] =>
      conflictLines.map((line) => line.match(/^([^:]+):/)?.[1]?.trim() || "").filter(Boolean),
    [],
  );

  const resetGenerateDebugOutput = useCallback(() => {
    generateDebugEventsRef.current = [];
    lastJobStatusDebugSignatureRef.current = "";
    lastJobStatusPayloadMarkerRef.current = "";
    lastJobErrorDebugSignatureRef.current = "";
    setGenerateDebugOutput("");
    setGenerateRawPromptOutputDebug({ prompt: "", output: "" });
    try {
      sessionStorage.removeItem(GENERATE_DEBUG_EVENTS_KEY);
    } catch {
      // Ignore storage failures
    }
  }, []);

  const resetTransientAiUiState = useCallback(() => {
    aiJob.reset();
    setIsGenerating(false);
    setIsGeneratingDesc(false);
    setGenerateComplete(false);
    setDescComplete(false);
    setDescProgress(0);
    setGenerateCooldown(0);
    setPdfComparisonWarning(null);
    setTitleDescRawPromptOutputDebug({ prompt: "", output: "" });
    resetGenerateDebugOutput();
    strictValidationRetryUsedRef.current = false;
    surfacedGenerateErrorJobRef.current = null;
    generateCooldownErrorSignatureRef.current = "";
    writeTitleDescRuntimeState({
      status: "idle",
      promptMode: "technical",
      debugOutput: "",
      title: "",
      description: "",
    });
  }, [aiJob, resetGenerateDebugOutput]);
  resetTransientAiUiStateRef.current = resetTransientAiUiState;

  useEffect(() => {
    if (!isHardReloadRef.current || hardReloadCleanupAppliedRef.current) return;
    hardReloadCleanupAppliedRef.current = true;
    aiJob.reset();
    resetGenerateDebugOutput();
    isHardReloadRef.current = false;
  }, [aiJob, resetGenerateDebugOutput]);

  const pushGenerateDebugEvent = useCallback((stage: string, payload: Record<string, unknown> = {}) => {
    const event = compactDebugValue({
      timestamp: new Date().toISOString(),
      stage,
      ...payload,
    }) as Record<string, unknown>;
    generateDebugEventsRef.current.push(event);
    if (generateDebugEventsRef.current.length > GENERATE_DEBUG_EVENT_LIMIT) {
      generateDebugEventsRef.current.splice(0, generateDebugEventsRef.current.length - GENERATE_DEBUG_EVENT_LIMIT);
    }
    try {
      sessionStorage.setItem(GENERATE_DEBUG_EVENTS_KEY, JSON.stringify(generateDebugEventsRef.current));
    } catch {
      // Ignore storage failures
    }
    setGenerateDebugOutput(buildGenerateDebugSnapshot(generateDebugEventsRef.current, event));
  }, []);

  const cancelActiveGeneration = useCallback(() => {
    generateSessionRef.current += 1;
    setIsGenerating(false);

    if (aiJobIsActive) {
      void aiJob.cancelJob();
    } else {
      aiJob.reset();
    }

    pushGenerateDebugEvent("user_cancelled_generation", {
      phase: "generate_data",
    });
  }, [aiJob, aiJobIsActive, pushGenerateDebugEvent]);

  // Countdown timer for cooldown
  useEffect(() => {
    if (generateCooldown <= 0) return;
    const id = setInterval(() => {
      setGenerateCooldown((prev) => {
        const next = prev - 1;
        if (next <= 0) clearInterval(id);
        return Math.max(0, next);
      });
    }, 1000);
    return () => clearInterval(id);
  }, [generateCooldown > 0]); // only re-subscribe when transitioning to/from active

  // Refs to hold forward-declared callbacks (defined later, used in runAutomaticTwoPdfCompare & applyGenerateDataResponse)
  const getFirstActivePromptRef = useRef<
    (
      promptTypes: string[],
      options?: {
        mode?: "DATASHEET_ONLY" | "WEBPAGE_ONLY" | "TWO_PDFS";
        hasDatasheetUpload?: boolean;
        hasWebsiteUpload?: boolean;
        hasCompareSupplierPdf?: boolean;
        hasCompareLsPdf?: boolean;
      },
    ) => Promise<{ prompt: string; promptType: string } | null>
  >(async () => null);
  const getFilterContextRef = useRef<() => FilterContextResult | null>(() => null);

  const applyGenerateDataResponse = useCallback(
    (
      response: GenerateLikeResponse,
      opts?: {
        recoveredFromHeuristicError?: boolean;
        allowFilterAutofill?: boolean;
        minimumAutofillConfidence?: number;
      },
    ): boolean => {
      const rawResult =
        typeof response.result === "string"
          ? response.result
          : response.result
            ? JSON.stringify(response.result, null, 2)
            : typeof response.data === "string"
              ? response.data
              : response.data
                ? JSON.stringify(response.data, null, 2)
                : "";
      setGenerateRawPromptOutputDebug((prev) => ({ ...prev, output: rawResult }));

      if (!rawResult.trim()) return false;

      const sections = parseGeminiSections(rawResult);
      const hasSectionHeaders = hasGeminiSectionHeaders(rawResult);
      const leadingPlainText = extractGeminiLeadingText(rawResult);
      let productDataSection = (sections.PRODUCT_DATA || "").trim();
      const rawConflictSection = (sections.CONFLICTS || "").trim();
      const includeConflictProcessing = lastGenerateMode === "TWO_PDFS" || rawConflictSection.length > 0;
      const normalizedConflicts = includeConflictProcessing ? rawConflictSection || "- NONE" : "- NONE";
      const hasStructuredOutput = Boolean(productDataSection);
      const responseMeta =
        response.meta && typeof response.meta === "object" && !Array.isArray(response.meta)
          ? (response.meta as Record<string, unknown>)
          : null;
      const responseDebug =
        responseMeta?.debug && typeof responseMeta.debug === "object" && !Array.isArray(responseMeta.debug)
          ? (responseMeta.debug as Record<string, unknown>)
          : null;
      const statusPayloadDebug =
        aiJob.statusPayload?.debug &&
        typeof aiJob.statusPayload.debug === "object" &&
        !Array.isArray(aiJob.statusPayload.debug)
          ? (aiJob.statusPayload.debug as Record<string, unknown>)
          : null;
      const requestSummary =
        statusPayloadDebug?.request_summary &&
        typeof statusPayloadDebug.request_summary === "object" &&
        !Array.isArray(statusPayloadDebug.request_summary)
          ? (statusPayloadDebug.request_summary as Record<string, unknown>)
          : null;
      const configFlags =
        requestSummary?.configFlags &&
        typeof requestSummary.configFlags === "object" &&
        !Array.isArray(requestSummary.configFlags)
          ? (requestSummary.configFlags as Record<string, unknown>)
          : null;
      const strictFromResult =
        typeof responseDebug?.strict_section_validation === "boolean" ? responseDebug.strict_section_validation : null;
      const strictFromRequest =
        typeof configFlags?.strictSectionValidation === "boolean" ? configFlags.strictSectionValidation : null;
      const strictSectionValidationUsed = strictFromResult ?? strictFromRequest ?? false;
      const requiredSectionsFromResult = Array.isArray(responseDebug?.required_sections)
        ? responseDebug.required_sections.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          )
        : [];
      const requiredSectionsFromStatus = Array.isArray(statusPayloadDebug?.required_sections)
        ? statusPayloadDebug.required_sections.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          )
        : [];
      const requiredSectionsUsed =
        requiredSectionsFromResult.length > 0 ? requiredSectionsFromResult : requiredSectionsFromStatus;
      const expectsStructuredSections = strictSectionValidationUsed || requiredSectionsUsed.length > 0;

      if (!hasStructuredOutput) {
        if (strictSectionValidationUsed) return false;

        const fallbackSource = leadingPlainText || (!hasSectionHeaders ? rawResult.trim() : "");
        const fallbackData = normalizeAiProductDataDisplay(fallbackSource);
        const fallbackEntries = parseAiDataEntries(fallbackData).filter((entry) => entry.rawValue.trim().length > 0);
        if (!fallbackData || fallbackEntries.length === 0) {
          if (hasSectionHeaders || (sections.FILTERS_PROPOSAL || "").trim().length > 0) {
            pushGenerateDebugEvent("proposal_only_output_rejected", {
              section_names: Object.keys(sections),
              leading_text_chars: leadingPlainText.length,
            });
            toast({
              variant: "destructive",
              title: "AI Extraction Failed",
              description:
                "AI returned filter proposals without the full product data block. Generate again or review the active prompt.",
            });
          }
          return false;
        } else {
          productDataSection = fallbackData;
        }
        pushGenerateDebugEvent(
          expectsStructuredSections
            ? "fallback_non_section_output_applied"
            : hasSectionHeaders
              ? "plain_field_output_with_trailing_sections_accepted"
              : "plain_field_output_accepted",
          {
            output_chars: fallbackData.length,
            recovered_from_heuristic_error: opts?.recoveredFromHeuristicError || false,
            required_sections: requiredSectionsUsed,
          },
        );
      }

      const normalizeFilterLookupName = (value: string): string =>
        value
          .replace(/\*/g, "")
          .replace(/\s*\([^)]*\)\s*$/, "")
          .replace(/\s{2,}/g, " ")
          .trim()
          .toLowerCase();

      const clampProposalConfidence = (value: number): number => {
        if (!Number.isFinite(value)) return 0;
        return Math.max(0, Math.min(100, Math.round(value)));
      };

      const buildFallbackFilterProposalsFromProductData = (productDataRaw: string): FilterProposal[] => {
        if (!productDataRaw.trim()) return [];

        // Uses shared missing-value normalization so legacy and new markers are treated consistently

        type ParsedProductValue = {
          exactName: string;
          baseName: string;
          value: string;
          order: number;
        };

        const parsedValues: ParsedProductValue[] = [];

        // Split compound DIMENSIONS lines into individual dimension fields
        // e.g. "DIMENSIONS: 69mm (depth) x 172mm (diameter)" → "DEPTH: 69mm" + "DIAMETER: 172mm"
        const expandDimensionLine = (rawName: string, rawValue: string, order: number): ParsedProductValue[] => {
          const key = rawName
            .replace(/\s*\([^)]*\)\s*$/i, "")
            .trim()
            .toUpperCase();
          if (key !== "DIMENSIONS" && key !== "DIMENSION" && key !== "SIZE") return [];
          const parts = rawValue.split(/\s*[x×X]\s*/);
          const extracted: ParsedProductValue[] = [];
          for (const part of parts) {
            const match = part.match(/^([\d.]+)\s*(\w*)\s*\(([^)]+)\)/);
            if (match) {
              const numericAndUnit = (match[1] + (match[2] ? match[2] : "")).trim();
              const label = match[3].trim();
              const labelName = normalizeFilterLookupName(label);
              extracted.push({
                exactName: labelName,
                baseName: labelName,
                value: numericAndUnit,
                order: order + extracted.length * 0.001,
              });
            }
          }
          return extracted;
        };

        for (const [order, line] of productDataRaw.split("\n").entries()) {
          const separatorIndex = line.indexOf(":");
          if (separatorIndex <= 0) continue;
          const rawName = line.slice(0, separatorIndex).trim();
          const rawValue = line.slice(separatorIndex + 1).trim();
          if (!rawName || !rawValue || isMissingValue(rawValue)) continue;

          // Try to expand compound dimension lines first
          const dimensionFields = expandDimensionLine(rawName, rawValue, order);
          if (dimensionFields.length > 0) {
            parsedValues.push(...dimensionFields);
            // Also keep the original DIMENSIONS entry for any filter that might match it directly
          }

          const exactName = normalizeFilterLookupName(rawName);
          const baseName = exactName.replace(/\s*#\d+\s*$/, "").trim();
          parsedValues.push({
            exactName,
            baseName,
            value: rawValue,
            order,
          });
        }

        const groupedProps = new Map<
          string,
          Array<{
            prop: (typeof properties)[number];
            fullName: string;
            order: number;
            required: boolean;
          }>
        >();

        for (const prop of properties) {
          const fullName = normalizeFilterLookupName(prop.name);
          const baseName = fullName.replace(/\s*#\d+\s*$/, "").trim();
          const hashMatch = prop.name.match(/#(\d+)/);
          const order = hashMatch ? parseInt(hashMatch[1], 10) : 0;
          const group = groupedProps.get(baseName) || [];
          group.push({
            prop,
            fullName,
            order,
            required: !!prop.required,
          });
          groupedProps.set(baseName, group);
        }

        const fallbackProposals: FilterProposal[] = [];

        for (const [baseName, group] of groupedProps.entries()) {
          let groupValues = parsedValues
            .filter((entry) => entry.baseName === baseName)
            .sort((a, b) => a.order - b.order);
          if (groupValues.length === 0) continue;

          if (group.length > 1 && groupValues.length === 1) {
            const compositeValues = groupValues[0].value
              .split(/;|\|/)
              .map((part) => part.trim())
              .filter(Boolean);
            if (compositeValues.length > 1) {
              const source = groupValues[0];
              groupValues = compositeValues.map((value, index) => ({
                ...source,
                value,
                order: source.order + index * 0.01,
              }));
            }
          }

          const sortedGroup = [...group].sort((a, b) => {
            if (a.required !== b.required) return a.required ? -1 : 1;
            return a.order - b.order;
          });

          const consumed = new Set<number>();

          for (const item of sortedGroup) {
            let matchedIndex = groupValues.findIndex(
              (entry, index) => !consumed.has(index) && entry.exactName === item.fullName,
            );
            const matchedExactly = matchedIndex >= 0;

            if (matchedIndex < 0) {
              matchedIndex = groupValues.findIndex(
                (entry, index) => !consumed.has(index) && entry.exactName === baseName,
              );
            }

            if (matchedIndex < 0) {
              matchedIndex = groupValues.findIndex((_, index) => !consumed.has(index));
            }

            if (matchedIndex < 0) continue;

            const matchedValue = groupValues[matchedIndex]?.value?.trim();
            if (!matchedValue) continue;
            consumed.add(matchedIndex);

            let proposalValue = matchedValue;
            let confidence = 0;

            if (item.prop.inputType === "dropdown") {
              const allowedValues = legalValues
                .filter((lv) => lv.propertyName === item.prop.name)
                .map((lv) => lv.allowedValue);
              if (allowedValues.length === 0) continue;
              const expectedUnit = extractUnitFromPropertyName(item.prop.name) || item.prop.unitSuffix;
              const allowedValue = matchLegalDropdownValue(matchedValue, allowedValues, expectedUnit);
              if (!allowedValue) continue;
              proposalValue = allowedValue;

              const rawTokens: string[] = matchedValue.toLowerCase().match(/[a-z0-9]+/g) || [];
              const allowTokens: string[] = allowedValue.toLowerCase().match(/[a-z0-9]+/g) || [];
              const rawNorm = rawTokens.join("");
              const allowNorm = allowTokens.join("");

              let valueConfidence = 0;
              if (rawNorm === allowNorm) {
                valueConfidence = 90;
              } else {
                const intersection = allowTokens.filter((t) => rawTokens.includes(t)).length;
                const union = new Set([...rawTokens, ...allowTokens]).size;
                const jaccard = union === 0 ? 0 : intersection / union;
                // Maps a partial match (e.g. "Warm White" vs "White" -> 0.5) to the 60s/70s range
                valueConfidence = 50 + jaccard * 35;
              }

              const fieldConfidence = matchedExactly ? 90 : 70;
              // Weighted average: 30% for finding the right field, 70% for the exactness of the value
              confidence = Math.round(fieldConfidence * 0.3 + valueConfidence * 0.7);
            } else {
              // Text / Numeric fields
              // Max 80% per business rules since we can never be 100% certain without constrained vocab
              const fieldConfidence = matchedExactly ? 80 : 68;
              const variance = Math.min(4, Math.floor(matchedValue.length / 8));
              confidence = fieldConfidence - Math.round(variance);
            }

            fallbackProposals.push({
              filterName: item.prop.name
                .replace(/\*/g, "")
                .replace(/\s*\([^)]*\)\s*$/, "")
                .trim(),
              value: proposalValue,
              confidence,
            });
          }
        }

        return fallbackProposals;
      };

      const sanitizeParsedProposalsToLegalValues = (proposals: FilterProposal[]): FilterProposal[] => {
        if (proposals.length === 0) return proposals;

        const normalizeProposalName = (value: string) =>
          value
            .replace(/\*/g, "")
            .replace(/\s*\([^)]*\)\s*$/, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const findProperty = (proposalName: string) => {
          const rawLower = normalizeProposalName(proposalName);
          const baseLower = rawLower.replace(/\s*#\d+\s*$/, "");

          let prop = properties.find((candidate) => {
            const fullName = normalizeProposalName(candidate.name);
            return fullName === rawLower;
          });
          if (prop) return prop;

          prop = properties.find((candidate) => {
            const baseName = normalizeProposalName(candidate.name).replace(/\s*#\d+\s*$/, "");
            return baseName === baseLower;
          });
          return prop || null;
        };

        return proposals.map((proposal) => {
          const prop = findProperty(proposal.filterName);
          if (!prop || prop.inputType !== "dropdown") return proposal;

          const allowedValues = legalValues.filter((lv) => lv.propertyName === prop.name).map((lv) => lv.allowedValue);
          if (allowedValues.length === 0) return proposal;

          const expectedUnit = extractUnitFromPropertyName(prop.name) || prop.unitSuffix;
          const legalValue = matchLegalDropdownValue(proposal.value, allowedValues, expectedUnit);
          if (!legalValue) {
            return {
              ...proposal,
              value: "MISSING***",
              confidence: proposal.confidence,
            };
          }

          if (legalValue === proposal.value) return proposal;
          return {
            ...proposal,
            value: legalValue,
            confidence: proposal.confidence,
          };
        });
      };

      const expandCompositeProposalValues = (proposals: FilterProposal[]): FilterProposal[] => {
        if (proposals.length === 0) return proposals;

        const normalizeProposalName = (value: string) =>
          value
            .replace(/\*/g, "")
            .replace(/\s*\([^)]*\)\s*$/, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const propertyGroupsByBaseName = new Map<string, Array<{ name: string; required: boolean; order: number }>>();
        for (const property of properties) {
          const normalizedPropertyName = normalizeProposalName(property.name);
          const baseName = normalizedPropertyName.replace(/\s*#\d+\s*$/, "");
          const slotMatch = property.name.match(/#(\d+)\s*$/);
          const order = slotMatch ? Number.parseInt(slotMatch[1], 10) : 0;
          const group = propertyGroupsByBaseName.get(baseName) || [];
          group.push({
            name: property.name
              .replace(/\*/g, "")
              .replace(/\s*\([^)]*\)\s*$/, "")
              .trim(),
            required: Boolean(property.required),
            order,
          });
          propertyGroupsByBaseName.set(baseName, group);
        }

        const expanded: FilterProposal[] = [];
        for (const proposal of proposals) {
          const normalizedName = normalizeProposalName(proposal.filterName);
          const baseName = normalizedName.replace(/\s*#\d+\s*$/, "");
          const hasExplicitSlot = /#\d+\s*$/i.test(normalizedName);
          const groupedProperties = [...(propertyGroupsByBaseName.get(baseName) || [])].sort((a, b) => {
            if (a.required !== b.required) return a.required ? -1 : 1;
            return a.order - b.order;
          });
          const propertyCount = groupedProperties.length;

          if (!hasExplicitSlot && propertyCount > 1) {
            const parts = proposal.value
              .split(/;|\|/)
              .map((part) => part.trim())
              .filter(Boolean);
            if (parts.length > 1) {
              const slotsToFill = groupedProperties.slice(0, parts.length);
              for (let index = 0; index < slotsToFill.length; index++) {
                const part = parts[index];
                const slot = slotsToFill[index];
                expanded.push({
                  ...proposal,
                  filterName: slot.name,
                  value: part,
                });
              }
              continue;
            }
          }

          expanded.push(proposal);
        }

        return expanded;
      };

      let normalizedProductDataSection = normalizeAiProductDataDisplay(productDataSection);

      if (includeConflictProcessing && !sections.CONFLICTS) {
        pushGenerateDebugEvent("section_defaults_applied", {
          missing_conflicts: true,
          recovered_from_heuristic_error: opts?.recoveredFromHeuristicError || false,
        });
      }

      let conflictLines =
        includeConflictProcessing && normalizedConflicts
          ? normalizedConflicts
              .split("\n")
              .map((l) => l.replace(/^-\s*/, "").trim())
              .filter((l) => l && l !== "NONE")
          : [];

      if (lastGenerateMode === "TWO_PDFS" && datasheetFile && websitePdfFile) {
        const reconciliation = reconcileTwoPdfProductDataAndConflicts(normalizedProductDataSection, conflictLines);
        if (reconciliation.refinedProductData.trim()) {
          normalizedProductDataSection = normalizeAiProductDataDisplay(reconciliation.refinedProductData);
        }
        if (reconciliation.inferredConflicts.length > 0) {
          conflictLines = mergeConflictLists(conflictLines, reconciliation.inferredConflicts);
        }
        conflictLines = preferSourceAwareTwoPdfConflicts(conflictLines);
        const sanitizedConflicts = sanitizeTwoPdfConflictLines(conflictLines);
        conflictLines = sanitizedConflicts.lines;
        if (sanitizedConflicts.droppedCount > 0) {
          pushGenerateDebugEvent("two_pdf_conflicts_sanitized", {
            dropped_count: sanitizedConflicts.droppedCount,
          });
        }
        if (reconciliation.dedupedLineCount > 0 || reconciliation.inferredConflicts.length > 0) {
          pushGenerateDebugEvent("two_pdf_data_reconciled", {
            deduped_line_count: reconciliation.dedupedLineCount,
            inferred_conflict_count: reconciliation.inferredConflicts.length,
          });
        }
      }

      // Derive pdfComparisonWarning from first-pass conflict count for TWO_PDFS.
      // Priority is dynamic: required filters from live property metadata.
      const normalizeConflictLabel = (value: string) =>
        value
          .replace(/\s*\([^)]*\)\s*$/i, "")
          .replace(/\s*#\d+\s*$/i, "")
          .replace(/[^a-z0-9]+/gi, " ")
          .replace(/\s+/g, " ")
          .trim()
          .toUpperCase();

      const requiredFilterFieldSet = new Set(
        properties
          .filter((property) => Boolean(property.required))
          .map((property) => normalizeConflictLabel(property.name)),
      );

      const normalizeConflictFieldForConfidence = (value: string): string =>
        normalizeConflictLabel(value)
          .replace(/\s+\d+\s*$/i, "")
          .replace(/\s+/g, " ")
          .trim();

      const conflictFieldLabels = extractConflictFieldLabels(conflictLines);
      const normalizedConflictFieldSet = new Set<string>();
      for (const label of conflictFieldLabels) {
        const normalized = normalizeConflictFieldForConfidence(label);
        if (!normalized) continue;
        normalizedConflictFieldSet.add(normalized);
      }

      const calibrateFilterProposalConfidence = (proposals: FilterProposal[]): FilterProposal[] => {
        if (proposals.length === 0) return proposals;

        const globalConflictPenalty =
          normalizedConflictFieldSet.size >= 5
            ? aiCollisionTuning.penaltyGlobalHigh
            : normalizedConflictFieldSet.size >= 3
              ? aiCollisionTuning.penaltyGlobalMedium
              : normalizedConflictFieldSet.size > 0
                ? aiCollisionTuning.penaltyGlobalLow
                : 0;

        let adjustedCount = 0;
        const adjustedProposals = proposals.map((proposal) => {
          if (!proposal || typeof proposal !== "object") return proposal;
          const normalizedCurrent = clampProposalConfidence(Number(proposal.confidence));
          if (isMissingValue(proposal.value)) {
            if (normalizedCurrent === 0) return proposal;
            adjustedCount += 1;
            return { ...proposal, confidence: 0 };
          }

          let penalty = globalConflictPenalty;
          const proposalField = normalizeConflictFieldForConfidence(proposal.filterName);
          if (proposalField && normalizedConflictFieldSet.has(proposalField)) {
            penalty += requiredFilterFieldSet.has(proposalField)
              ? aiCollisionTuning.penaltyFieldRequired
              : aiCollisionTuning.penaltyFieldOptional;
          }

          const adjustedConfidence = clampProposalConfidence(Math.max(5, normalizedCurrent - penalty));
          if (adjustedConfidence === normalizedCurrent) return { ...proposal, confidence: normalizedCurrent };
          adjustedCount += 1;
          return { ...proposal, confidence: adjustedConfidence };
        });

        if (adjustedCount > 0) {
          pushGenerateDebugEvent("filter_confidence_recalibrated", {
            conflict_field_count: normalizedConflictFieldSet.size,
            adjusted_proposal_count: adjustedCount,
            total_proposals: proposals.length,
          });
        }

        return adjustedProposals;
      };

      if (lastGenerateMode === "TWO_PDFS" && conflictLines.length > 0) {
        const highPriorityCount = conflictFieldLabels.filter((label) =>
          requiredFilterFieldSet.has(normalizeConflictLabel(label)),
        ).length;
        const shouldWarn =
          conflictFieldLabels.length >= 4 ||
          (conflictFieldLabels.length >= 3 && highPriorityCount >= 2) ||
          highPriorityCount >= 3;
        setPdfComparisonWarning(
          shouldWarn
            ? "Multiple differences detected between Datasheet and Website PDFs. Review the conflict report below."
            : null,
        );
      } else {
        setPdfComparisonWarning(null);
      }

      setConflicts(includeConflictProcessing ? conflictLines : []);
      setExtractionConflicts(lastGenerateMode === "TWO_PDFS" ? conflictLines : []);

      const explicitlyMissingFilterKeys = new Set<string>();
      const explicitlyMissingFilterLabels = new Set<string>();
      for (const entry of parseAiDataEntries(normalizedProductDataSection)) {
        if (!isMissingValue(entry.rawValue)) continue;
        const normalizedName = normalizeFilterNameForLookup(entry.rawName);
        if (!normalizedName) continue;
        const matchedProps = properties.filter(
          (property) => normalizeFilterNameForLookup(property.name) === normalizedName,
        );
        for (const property of matchedProps) {
          explicitlyMissingFilterKeys.add(property.key);
          explicitlyMissingFilterLabels.add(normalizeFilterDisplayLabel(property.name));
        }
      }

      if (explicitlyMissingFilterKeys.size > 0) {
        pushGenerateDebugEvent("explicit_missing_filter_fields_detected", {
          filter_keys: Array.from(explicitlyMissingFilterKeys),
          filter_labels: Array.from(explicitlyMissingFilterLabels),
        });
      }

      const matchesExplicitlyMissingFilter = (filterName: string): boolean => {
        const normalizedName = normalizeFilterNameForLookup(filterName);
        if (!normalizedName) return false;
        return properties.some(
          (property) =>
            explicitlyMissingFilterKeys.has(property.key) &&
            normalizeFilterNameForLookup(property.name) === normalizedName,
        );
      };

      const rawFilterProposalSection = (sections.FILTERS_PROPOSAL || "").trim();
      let parsedProposals = rawFilterProposalSection
        ? sanitizeParsedProposalsToLegalValues(parseFilterProposals(rawFilterProposalSection))
        : [];

      parsedProposals = expandCompositeProposalValues(parsedProposals);
      parsedProposals = parsedProposals.filter((proposal) => !matchesExplicitlyMissingFilter(proposal.filterName));

      const fallbackDerivedProposals = buildFallbackFilterProposalsFromProductData(normalizedProductDataSection).filter(
        (proposal) => !matchesExplicitlyMissingFilter(proposal.filterName),
      );

      if (parsedProposals.length > 0 && fallbackDerivedProposals.length > 0) {
        const normalizeProposalKey = (value: string) =>
          value
            .replace(/\*/g, "")
            .replace(/\s*\([^)]*\)\s*$/, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const existingKeys = new Set(parsedProposals.map((proposal) => normalizeProposalKey(proposal.filterName)));
        const missingFallbackProposals = fallbackDerivedProposals.filter(
          (proposal) => !existingKeys.has(normalizeProposalKey(proposal.filterName)),
        );

        if (missingFallbackProposals.length > 0) {
          parsedProposals = [...parsedProposals, ...missingFallbackProposals];
          pushGenerateDebugEvent("fallback_filter_proposals_merged_for_missing_fields", {
            parsed_proposal_count: parsedProposals.length - missingFallbackProposals.length,
            merged_missing_count: missingFallbackProposals.length,
          });
        }
      }

      if (parsedProposals.length === 0) {
        parsedProposals = fallbackDerivedProposals;
        if (parsedProposals.length > 0) {
          pushGenerateDebugEvent(
            rawFilterProposalSection
              ? "fallback_filter_proposals_derived_from_product_data"
              : "filter_proposals_derived_from_product_data",
            {
              proposal_count: parsedProposals.length,
              recovered_from_heuristic_error: opts?.recoveredFromHeuristicError || false,
            },
          );
        }
      }

      parsedProposals = calibrateFilterProposalConfidence(parsedProposals);

      setChatgptData(normalizedProductDataSection);
      trackAiGenerated("aiData", normalizedProductDataSection);

      if (explicitlyMissingFilterKeys.size > 0) {
        setSpecValues((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const key of explicitlyMissingFilterKeys) {
            if (key in next) {
              delete next[key];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        setFilterSources((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const key of explicitlyMissingFilterKeys) {
            if (key in next) {
              delete next[key];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }

      const aiGeneratedByPropKey: Record<string, string> = {};

      if (parsedProposals.length > 0) {
        setFilterProposals(parsedProposals);

        const allowFilterAutofill = opts?.allowFilterAutofill ?? true;
        const minimumAutofillConfidence = opts?.minimumAutofillConfidence ?? MINIMUM_AI_AUTOFILL_CONFIDENCE;

        if (allowFilterAutofill && parsedProposals.length > 0) {
          const usedPropKeys = new Set<string>();

          for (const proposal of parsedProposals) {
            if (isMissingValue(proposal.value) || proposal.confidence < minimumAutofillConfidence) continue;

            const proposalRaw = proposal.filterName.trim();
            const proposalRawLower = proposalRaw.toLowerCase();
            const proposalBaseLower = proposalRaw.replace(/\s*#\d+\s*$/, "").toLowerCase();

            let prop = properties.find((p) => {
              if (usedPropKeys.has(p.key)) return false;
              const fullName = p.name
                .replace(/\*/g, "")
                .replace(/\s*\([^)]*\)\s*$/, "")
                .trim()
                .toLowerCase();
              return fullName === proposalRawLower;
            });

            if (!prop) {
              prop = properties.find((p) => {
                if (usedPropKeys.has(p.key)) return false;
                const baseName = p.name
                  .replace(/\*/g, "")
                  .replace(/\s*\([^)]*\)\s*$/, "")
                  .replace(/\s*#\d+\s*$/, "")
                  .trim()
                  .toLowerCase();
                return baseName === proposalBaseLower;
              });
            }

            if (!prop) continue;
            usedPropKeys.add(prop.key);

            const knownUnit = extractUnitFromPropertyName(prop.name) || prop.unitSuffix;

            if (prop.inputType === "dropdown") {
              const allowed = legalValues.filter((lv) => lv.propertyName === prop.name).map((lv) => lv.allowedValue);
              const legalValue = matchLegalDropdownValue(proposal.value, allowed, knownUnit);

              if (!legalValue) continue;

              const hadPreviousValue = !!specValues[prop.key]?.trim();
              handleSpecChange(prop.key, legalValue);
              setFilterSources((prev) => ({
                ...prev,
                [prop.key]: (hadPreviousValue ? "override" : "ai") as FilterValueSource,
              }));
              aiGeneratedByPropKey[prop.key] = legalValue;
              continue;
            }

            const hadPreviousValue = !!specValues[prop.key]?.trim();

            if (prop.inputType === "number" || knownUnit) {
              const numericValue = parseNumericValueForExpectedUnit(proposal.value, knownUnit);
              if (numericValue !== null) {
                const appliedValue = formatNumericForInput(numericValue);
                handleSpecChange(prop.key, appliedValue);
                setFilterSources((prev) => ({
                  ...prev,
                  [prop.key]: (hadPreviousValue ? "override" : "ai") as FilterValueSource,
                }));
                aiGeneratedByPropKey[prop.key] = appliedValue;
                continue;
              }
              continue;
            }

            const strippedValue = proposal.value.trim();
            const commonUnits2 = [
              "mm",
              "cm",
              "m",
              "kg",
              "g",
              "lb",
              "lbs",
              "°",
              "deg",
              "V",
              "W",
              "A",
              "lm",
              "K",
              "hr",
              "hrs",
              "hours",
              "h",
              "in",
              "ft",
            ];
            let appliedValue = strippedValue;
            for (const u of commonUnits2) {
              if (
                appliedValue.length > u.length &&
                appliedValue.toLowerCase().endsWith(u.toLowerCase()) &&
                /\d/.test(appliedValue.charAt(appliedValue.length - u.length - 1))
              ) {
                appliedValue = appliedValue.slice(0, -u.length).trim();
                break;
              }
            }
            handleSpecChange(prop.key, appliedValue);
            setFilterSources((prev) => ({
              ...prev,
              [prop.key]: (hadPreviousValue ? "override" : "ai") as FilterValueSource,
            }));
            aiGeneratedByPropKey[prop.key] = appliedValue;
          }
        }

        const logCtx = getFilterContextRef.current();
        const logVisKeys = new Set<string>();
        if (logCtx) {
          for (const f of logCtx.filters) {
            const matched = properties.filter((p) => {
              const pName = p.name.replace(/\s*\([^)]*\)\s*$/, "").trim();
              return (
                pName === f.name || pName.replace(/\s*#\d+\s*$/, "").trim() === f.name.replace(/\s*#\d+\s*$/, "").trim()
              );
            });
            for (const m of matched) logVisKeys.add(m.key);
          }
        }
        const generatedFilterParts = properties
          .filter((prop) => {
            if (logVisKeys.size > 0 && !logVisKeys.has(prop.key)) return false;
            const value = aiGeneratedByPropKey[prop.key];
            return typeof value === "string" && value.trim().length > 0;
          })
          .map((prop) => {
            const displayName = prop.name
              .replace(/\*/g, "")
              .replace(/\s*\([^)]*\)\s*$/, "")
              .trim();
            const value = aiGeneratedByPropKey[prop.key].trim();
            return `${displayName}=${value}`;
          });

        if (generatedFilterParts.length > 0) {
          trackAiGenerated("filters", generatedFilterParts.join(";"));
        }
      } else {
        setFilterProposals([]);
      }

      const retainedAiManagedKeys = new Set<string>([
        ...explicitlyMissingFilterKeys,
        ...Object.keys(aiGeneratedByPropKey),
      ]);

      setSpecValues((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const [key, source] of Object.entries(filterSources)) {
          if (source !== "ai" && source !== "override") continue;
          if (retainedAiManagedKeys.has(key)) continue;
          if (key in next) {
            delete next[key];
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      setFilterSources((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const [key, source] of Object.entries(prev)) {
          if (source !== "ai" && source !== "override") continue;
          if (retainedAiManagedKeys.has(key)) continue;
          delete next[key];
          changed = true;
        }
        return changed ? next : prev;
      });

      setIsGenerating(false);
      setGenerateComplete(true);
      return true;
    },
    [
      aiCollisionTuning.penaltyFieldOptional,
      aiCollisionTuning.penaltyFieldRequired,
      aiCollisionTuning.penaltyGlobalHigh,
      aiCollisionTuning.penaltyGlobalLow,
      aiCollisionTuning.penaltyGlobalMedium,
      aiJob.statusPayload,
      datasheetFile,
      extractConflictFieldLabels,
      handleSpecChange,
      legalValues,
      lastGenerateMode,
      manuallyEditedFilters,
      matchLegalDropdownValue,
      mergeConflictLists,
      normalizeFilterDisplayLabel,
      normalizeFilterNameForLookup,
      parseAiDataEntries,
      preferSourceAwareTwoPdfConflicts,
      normalizeAiProductDataDisplay,
      properties,
      pushGenerateDebugEvent,
      filterSources,
      specValues,
      websitePdfFile,
    ],
  );

  applyGenerateDataResponseRef.current = applyGenerateDataResponse;

  const displayedTwoPdfConflicts = useMemo(() => {
    const merged = mergeConflictLists(extractionConflicts, conflicts);
    const sanitized = sanitizeTwoPdfConflictLines(merged);
    const preferred = preferSourceAwareTwoPdfConflicts(sanitized.lines);
    const formatted = preferred.map(formatTwoPdfConflictForDisplay);
    return mergeConflictLists([], formatted);
  }, [
    conflicts,
    extractionConflicts,
    formatTwoPdfConflictForDisplay,
    mergeConflictLists,
    preferSourceAwareTwoPdfConflicts,
    sanitizeTwoPdfConflictLines,
  ]);

  const displayedSinglePdfConflicts = useMemo(() => {
    const formatted = conflicts.map(formatSinglePdfConflictForDisplay);
    return mergeConflictLists([], formatted);
  }, [conflicts, formatSinglePdfConflictForDisplay, mergeConflictLists]);

  const aiLogConflictsText = useMemo(() => {
    const visibleConflicts =
      lastGenerateMode === "TWO_PDFS" ? displayedTwoPdfConflicts : displayedSinglePdfConflicts;
    return visibleConflicts.map((line) => String(line ?? "").trim()).filter(Boolean).join("\n");
  }, [displayedSinglePdfConflicts, displayedTwoPdfConflicts, lastGenerateMode]);

  // Keep local UI state in sync with persisted/resumed AI job status.
  // Only sync FROM aiJob → isGenerating, never fight an active manual start.
  const manualGenerateRef = useRef(false);
  useEffect(() => {
    if (aiJobIsActive && !isGenerating) {
      setIsGenerating(true);
      return;
    }

    // Don't clear isGenerating during the manual start window —
    // the handler sets isGenerating(true) then calls aiJob.reset() which
    // briefly makes aiJobIsActive false before startJob sets it to queued.
    if (!aiJobIsActive && isGenerating && !manualGenerateRef.current) {
      setIsGenerating(false);
    }
  }, [aiJobIsActive, isGenerating]);

  // Simulated progress for Title & Description (synchronous call)
  useEffect(() => {
    if (!isGeneratingDesc) {
      setDescProgress(0);
      return;
    }
    setDescProgress(2);
    const start = Date.now();
    const id = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      // Asymptotic curve: approaches 90% over ~120s
      const progress = Math.min(90, 2 + 88 * (1 - Math.exp(-elapsed / 40)));
      const next = Math.round(progress);
      setDescProgress((prev) => (next > prev ? next : prev));
    }, 500);
    return () => clearInterval(id);
  }, [isGeneratingDesc]);

  const getFirstActivePrompt = useCallback(
    async (
      promptTypes: string[],
      options?: {
        mode?: "DATASHEET_ONLY" | "WEBPAGE_ONLY" | "TWO_PDFS";
        hasDatasheetUpload?: boolean;
        hasWebsiteUpload?: boolean;
        hasCompareSupplierPdf?: boolean;
        hasCompareLsPdf?: boolean;
      },
    ): Promise<{ prompt: string; promptType: string } | null> => {
      const compatibilityContext: RuntimeContext = {
        datasheetUpload:
          options?.hasDatasheetUpload === false || options?.mode === "WEBPAGE_ONLY"
            ? null
            : { bucket: "", path: "", filename: "datasheet.pdf", label: "datasheet" },
        websiteUpload:
          options?.hasWebsiteUpload === false || options?.mode === "DATASHEET_ONLY"
            ? null
            : { bucket: "", path: "", filename: "website.pdf", label: "website_pdf" },
        compareSupplierPdf:
          options?.hasCompareSupplierPdf === false
            ? null
            : { bucket: "", path: "", filename: "supplier.pdf", label: "supplier" },
        compareLsPdf:
          options?.hasCompareLsPdf === false ? null : { bucket: "", path: "", filename: "ls.pdf", label: "ls" },
      };

      return selectFirstCompatibleActivePrompt(promptTypes, compatibilityContext);
    },
    [],
  );

  // Helper: build the filter context for the prompt
  const getFilterContext = useCallback(() => {
    if (!mainCategory) return null;
    const normalizedSelected = mainCategory
      .trim()
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "");
    const activeLookup = masterLookup.filter((entry) => entry.defaultName?.trim());
    if (activeLookup.length === 0 || masterDefaults.length === 0) return null;

    const matches = activeLookup.filter((entry) => {
      const entryPath = (entry.categoryPath || "")
        .trim()
        .replace(/\/{2,}/g, "/")
        .replace(/\/$/, "");
      if (!entryPath) return false;
      return normalizedSelected === entryPath || normalizedSelected.startsWith(entryPath + "/");
    });
    if (matches.length === 0) return null;

    const bestMatch = matches.reduce((best, current) =>
      current.categoryPath.length > best.categoryPath.length ? current : best,
    );
    const defaultEntry = masterDefaults.find(
      (d) => d.name.trim().toLowerCase() === bestMatch.defaultName.trim().toLowerCase(),
    );
    if (!defaultEntry || defaultEntry.allowedProperties.length === 0) return null;

    // Build filter list with allowed values
    const filterList: Array<{
      name: string;
      type: string;
      mandatory: boolean;
      allowedValues: string[];
      unit?: string;
    }> = [];
    for (const allowedProp of defaultEntry.allowedProperties) {
      const allowedNoUnit = allowedProp
        .replace(/\s*\([^)]*\)\s*$/, "")
        .trim()
        .toLowerCase();
      const allowedHasHash = /#\d+\s*$/.test(allowedProp.trim());
      // Find matching properties (may be multiple if no #N in allowed)
      const matchedProps = properties.filter((p) => {
        const propNoUnit = p.name
          .replace(/\s*\([^)]*\)\s*$/, "")
          .trim()
          .toLowerCase();
        const propBase = propNoUnit.replace(/\s*#\d+\s*$/, "").trim();
        if (allowedHasHash) return allowedNoUnit === propNoUnit;
        const allowedBase = allowedNoUnit.replace(/\s*#\d+\s*$/, "").trim();
        return allowedBase === propBase || allowedBase === propNoUnit;
      });
      for (const prop of matchedProps) {
        const unitMatch = prop.name.match(/\(([^)]+)\)\s*$/);
        const unit = unitMatch ? unitMatch[1] : undefined;
        const displayName = prop.name
          .replace(/\s*\([^)]*\)\s*$/, "")
          .replace(/\s*#\d+\s*$/, "")
          .trim();
        const allowed = legalValues.filter((lv) => lv.propertyName === prop.name).map((lv) => lv.allowedValue);
        const type = prop.inputType === "dropdown" ? "ENUM" : prop.inputType === "number" ? "NUMBER" : "TEXT";
        // Include #N suffix in name for AI context if present
        const hashMatch = prop.name.match(/#(\d+)\s*(?:\([^)]*\))?\s*$/);
        const contextName = hashMatch ? `${displayName} #${hashMatch[1]}` : displayName;
        if (filterList.some((f) => f.name === contextName)) continue;
        filterList.push({ name: contextName, type, mandatory: prop.required ?? false, allowedValues: allowed, unit });
      }
    }

    return { masterFilterName: bestMatch.defaultName, filters: filterList };
  }, [mainCategory, masterLookup, masterDefaults, properties, legalValues]);

  // Sync refs for forward-declared callbacks
  getFirstActivePromptRef.current = getFirstActivePrompt;
  getFilterContextRef.current = getFilterContext;

  const handleGenerateTitleAndData = useCallback(
    async (
      explicitMode?: "DATASHEET_ONLY" | "WEBPAGE_ONLY" | "TWO_PDFS",
      options?: { forceValidationRetry?: boolean; retryFromJobId?: string | null },
    ) => {
      if (!options?.forceValidationRetry) {
        strictValidationRetryUsedRef.current = false;
      } else {
        strictValidationRetryUsedRef.current = true;
      }

      if (!getGeminiConfig().enabled) {
        toast({
          title: "Gemini AI is disabled",
          description: "Enable Gemini AI in the Admin panel → Gemini AI Setup before using this feature.",
          variant: "destructive",
        });
        return;
      }

      // Clear previous AI tracking so stale data isn't logged
      clearAiTracking();

      const allAiFiles = getAiFiles();
      const hasDatasheetFile = allAiFiles.some((file) => file.label === "datasheet");
      const hasWebsiteFile = allAiFiles.some((file) => file.label === "website");

      const inferredMode: "DATASHEET_ONLY" | "WEBPAGE_ONLY" | "TWO_PDFS" =
        hasDatasheetFile && hasWebsiteFile ? "TWO_PDFS" : hasDatasheetFile ? "DATASHEET_ONLY" : "WEBPAGE_ONLY";

      const requestedMode = explicitMode || inferredMode;
      const mode: "DATASHEET_ONLY" | "WEBPAGE_ONLY" | "TWO_PDFS" =
        requestedMode === "DATASHEET_ONLY" && !hasDatasheetFile && hasWebsiteFile
          ? "WEBPAGE_ONLY"
          : requestedMode === "WEBPAGE_ONLY" && !hasWebsiteFile && hasDatasheetFile
            ? "DATASHEET_ONLY"
            : requestedMode;

      if (mode === "TWO_PDFS" && (!hasDatasheetFile || !hasWebsiteFile)) {
        toast({
          title: "Two PDFs required",
          description: "Upload both Supplier Datasheet and Supplier Website PDFs before running Two-PDF generation.",
          variant: "destructive",
        });
        return;
      }

      let aiFiles = allAiFiles;
      if (mode === "DATASHEET_ONLY") {
        aiFiles = aiFiles.filter((file) => file.label === "datasheet");
      } else if (mode === "WEBPAGE_ONLY") {
        aiFiles = aiFiles.filter((file) => file.label === "website");
      }
      if (aiFiles.length === 0) {
        toast({
          title: "No files",
          description: "Please upload a datasheet or website PDF first.",
          variant: "destructive",
        });
        return;
      }

      // Duplicate PDF detection for TWO_PDFS mode
      if (aiFiles.length === 2) {
        const [a, b] = aiFiles;
        if (a.file.size === b.file.size && a.file.name === b.file.name) {
          const SAMPLE_BYTES = 64 * 1024;
          const compareBytes = (left: Uint8Array, right: Uint8Array) => {
            if (left.length !== right.length) return false;
            for (let i = 0; i < left.length; i++) {
              if (left[i] !== right[i]) return false;
            }
            return true;
          };

          const compareSlice = async (start: number, end: number) => {
            const [leftBuf, rightBuf] = await Promise.all([
              a.file.slice(start, end).arrayBuffer(),
              b.file.slice(start, end).arrayBuffer(),
            ]);
            return compareBytes(new Uint8Array(leftBuf), new Uint8Array(rightBuf));
          };

          const fileSize = a.file.size;
          const firstSampleEnd = Math.min(SAMPLE_BYTES, fileSize);
          const lastSampleStart = Math.max(0, fileSize - SAMPLE_BYTES);
          const middleSampleStart = Math.max(0, Math.floor(fileSize / 2) - Math.floor(SAMPLE_BYTES / 2));
          const middleSampleEnd = Math.min(fileSize, middleSampleStart + SAMPLE_BYTES);

          const [firstMatches, lastMatches, middleMatches] = await Promise.all([
            compareSlice(0, firstSampleEnd),
            compareSlice(lastSampleStart, fileSize),
            compareSlice(middleSampleStart, middleSampleEnd),
          ]);

          if (firstMatches && lastMatches && middleMatches) {
            toast({
              title: "Duplicate PDFs detected",
              description: "The datasheet and website PDF are the same file. Please upload two different documents.",
              variant: "destructive",
            });
            return;
          }
        }
      }

      // Immediately clear AI-Data so user sees instant feedback
      // Title is NOT cleared here — it's generated separately via "Generate Title & Description"
      // Filters are NOT cleared — they persist until user clicks "Clear All Filters"
      generateSessionRef.current += 1;
      const currentGenerateSession = generateSessionRef.current;
      setErrors((prev) => {
        if (!prev.chatgptData) return prev;
        const { chatgptData: _chatgptData, ...rest } = prev;
        return rest;
      });
      setChatgptData("");
      setPdfComparisonWarning(null);
      setConflicts([]);
      setExtractionConflicts([]);
      clearAiFilterBadgeStatePreservingValues();
      setGenerateComplete(false);

      resetGenerateDebugOutput();
      manualGenerateRef.current = true;
      setIsGenerating(true);
      aiJob.reset();

      setLastGenerateMode(mode);
      const routingActionId: AiActionId =
        mode === "TWO_PDFS"
          ? "product_generate_two_pdfs"
          : mode === "DATASHEET_ONLY"
            ? "product_generate_datasheet_only"
            : "product_generate_webpage_only";
      const routingConfig = getAiActionRouting(routingActionId);
      const defaultPromptCandidates = getDefaultAiRoutingConfig()[routingActionId].promptCandidates;
      const promptCandidates =
        routingConfig.promptCandidates.length > 0 ? routingConfig.promptCandidates : defaultPromptCandidates;
      pushGenerateDebugEvent("init", {
        mode,
        routing_action: routingActionId,
        client_feature_flags: {
          two_pdf_compare_gate: true,
          backend_warning_rejection: true,
          local_pdf_support_validation: true,
        },
        prompt_candidates: promptCandidates,
        require_instruction_pdf: routingConfig.requireInstructionPdf,
        strict_response_guard: routingConfig.strictResponseGuard,
        files_uploaded_by_user: aiFiles.map(({ label, file }) => ({
          label,
          filename: file.name,
          mime: file.type,
          size_bytes: file.size,
        })),
        sku: effectiveSku || null,
        brand: brand.trim() || null,
        main_category: mainCategory.trim() || null,
        selected_categories: selectedCategories,
      });

      try {
        if (!routingConfig.enabled) {
          toast({
            variant: "destructive",
            title: "Action Disabled in Admin",
            description: "Enable this Generate Data action in Admin → AI Routing Options.",
          });
          manualGenerateRef.current = false;
          setIsGenerating(false);
          return;
        }

        // Fetch active prompt + per-prompt instruction PDF + legacy instruction in parallel
        pushGenerateDebugEvent("loading_prompt_and_instruction_files", {
          prompt_candidates: promptCandidates,
        });
        const activePromptSelection = await getFirstActivePrompt(promptCandidates, {
          mode,
          hasDatasheetUpload: hasDatasheetFile,
          hasWebsiteUpload: hasWebsiteFile,
        });

        if (!activePromptSelection?.prompt) {
          toast({
            variant: "destructive",
            title: "No Active Prompt",
            description: `Create and activate one of: ${promptCandidates.join(", ")}.`,
          });
          manualGenerateRef.current = false;
          setIsGenerating(false);
          return;
        }
        const activePrompt = activePromptSelection.prompt;
        const selectedPromptType = activePromptSelection.promptType;
        const promptHasTemplateVariables = activePrompt.includes("{{");

        // Resolve prompt variables first so we only fetch instruction PDFs when prompt/routing actually needs them.
        const promptVariables = promptHasTemplateVariables ? await loadPromptVariables(selectedPromptType) : [];
        const activePromptVariables = promptHasTemplateVariables
          ? getPromptVariablesInUse({
              promptType: selectedPromptType,
              activeVersionContent: activePrompt,
              variables: promptVariables,
            })
          : [];
        const hasVariables = activePromptVariables.length > 0;
        const usesBinding = (bindingType: PromptVariable["bindingType"]) =>
          activePromptVariables.some(
            (variable) => normalizePromptVariableBindingType(String(variable.bindingType || "")) === bindingType,
          );
        const instructionVarNamesInPrompt = activePromptVariables
          .filter(
            (variable) => normalizePromptVariableBindingType(String(variable.bindingType || "")) === "instruction_pdf",
          )
          .map((variable) => variable.name)
          .filter(Boolean);

        const shouldResolveInstructionPdf =
          routingConfig.requireInstructionPdf || instructionVarNamesInPrompt.length > 0;
        let perPromptInstrPdf: { file: File; label: string; promptType: string } | null = null;
        if (shouldResolveInstructionPdf) {
          const perPrompt = await fetchPromptInstructionPdf(selectedPromptType);
          perPromptInstrPdf = perPrompt ? { ...perPrompt, promptType: selectedPromptType } : null;
        }

        const instructionPdfFile = perPromptInstrPdf;

        if (routingConfig.requireInstructionPdf && !instructionPdfFile) {
          toast({
            variant: "destructive",
            title: "Missing Instruction PDF",
            description: "Upload an Instruction PDF in Admin → AI Prompts for this prompt type.",
          });
          manualGenerateRef.current = false;
          setIsGenerating(false);
          return;
        }

        pushGenerateDebugEvent("prompt_and_instruction_files_loaded", {
          prompt_type_selected: activePromptSelection?.promptType || null,
          prompt_chars: activePromptSelection?.prompt.length || 0,
          should_resolve_instruction_pdf: shouldResolveInstructionPdf,
          per_prompt_instruction_pdf: perPromptInstrPdf?.file?.name || null,
          instruction_used: instructionPdfFile?.file?.name || null,
        });

        // ── Variable resolver ──
        const shouldAttachInstructionPdf = Boolean(
          instructionPdfFile && (routingConfig.requireInstructionPdf || instructionVarNamesInPrompt.length > 0),
        );
        pushGenerateDebugEvent("instruction_attach_decision", {
          has_instruction_pdf: Boolean(instructionPdfFile),
          should_attach_instruction_pdf: shouldAttachInstructionPdf,
          required_by_routing: routingConfig.requireInstructionPdf,
          instruction_vars_in_prompt: instructionVarNamesInPrompt,
        });

        // Build runtime context for the resolver (file refs are dummy — actual upload happens later)
        // We use placeholder FileRefs because we just need labels/validation now;
        // the actual file upload uses the File objects from getAiFiles().
        // Build filter context string for prompt variable
        const filterContextString = usesBinding("form_filter_context")
          ? buildCompactFilterContextString(getFilterContext())
          : "";
        const hasHighValueFilterContext = usesBinding("form_filter_context") && filterContextString.length > 0;

        const runtimeCtx: RuntimeContext = {
          instructionPdf:
            shouldAttachInstructionPdf && instructionPdfFile
              ? {
                  bucket: "document-uploads-constant",
                  path: "",
                  filename: instructionPdfFile.file.name,
                  label: "instructions",
                }
              : null,
          datasheetUpload:
            usesBinding("supplier_datasheet_pdf") && datasheetFile
              ? { bucket: "", path: "", filename: datasheetFile.name, label: "datasheet" }
              : null,
          websiteUpload:
            usesBinding("supplier_website_pdf") && websitePdfFile
              ? { bucket: "", path: "", filename: websitePdfFile.name, label: "website_pdf" }
              : null,
          formSku: usesBinding("form_sku") ? effectiveSku || undefined : undefined,
          formBrand: usesBinding("form_brand") ? brand || undefined : undefined,
          formTitle: usesBinding("form_title") ? title || undefined : undefined,
          formDescription: usesBinding("form_description") ? chatgptDescription || undefined : undefined,
          formMainCategory: usesBinding("form_main_category") ? mainCategory || undefined : undefined,
          formSelectedCategories: usesBinding("form_selected_categories")
            ? selectedCategories.length > 0
              ? selectedCategories.join(", ")
              : undefined
            : undefined,
          editedAiDataText: usesBinding("form_ai_data_edited") ? chatgptData.trim() || undefined : undefined,
          formSpecificationsSummary: usesBinding("form_specifications_summary") ? buildSpecsSummary() : undefined,
          formImageUrls: usesBinding("form_image_urls") ? imageUrls.filter(Boolean).join("\n") || undefined : undefined,
          formEmailNotes: usesBinding("form_email_notes") ? emailNotes || undefined : undefined,
          additionalInstructionsData: usesBinding("additional_instructions_data")
            ? additionalInstructionsData.trim() || undefined
            : undefined,
          formFilterContext: usesBinding("form_filter_context") ? filterContextString || undefined : undefined,
        };

        // Resolve variables in admin prompt (if variables are defined)
        let resolvedAdminPrompt = activePrompt;
        let resolverDebug: unknown = null;
        const resolverRequestedLabels = new Set<string>();

        if (promptHasTemplateVariables) {
          const resolveResult = resolvePromptVariables(
            {
              promptType: selectedPromptType,
              promptName: selectedPromptType,
              activeVersionContent: activePrompt,
              variables: activePromptVariables,
            },
            runtimeCtx,
          );

          if (resolveResult.validationErrors.length > 0) {
            for (const err of resolveResult.validationErrors) {
              toast({ variant: "destructive", title: "Missing Required Input", description: err });
            }
            pushGenerateDebugEvent("resolver_validation_failed", {
              errors: resolveResult.validationErrors,
              debug: resolveResult.debugResolved,
            });
            manualGenerateRef.current = false;
            setIsGenerating(false);
            return;
          }

          resolvedAdminPrompt = resolveResult.finalPrompt;
          resolverDebug = resolveResult.debugResolved;
          for (const file of resolveResult.files) {
            if (file.label) resolverRequestedLabels.add(file.label);
          }

          pushGenerateDebugEvent("resolver_complete", {
            variables_resolved: resolveResult.debugResolved,
            files_from_resolver: resolveResult.files.map((f) => ({ label: f.label, filename: f.filename })),
            prompt_chars_after_resolve: resolvedAdminPrompt.length,
          });
        }

        const resolvedTaskPrompt = resolvedAdminPrompt;
        const unresolvedPromptVariables = Array.from(new Set(resolvedTaskPrompt.match(/\{\{[^}]+\}\}/g) || []));
        if (unresolvedPromptVariables.length > 0) {
          const unresolvedMsg =
            "Unresolved prompt variables detected: " +
            unresolvedPromptVariables.join(", ") +
            ". Configure variable bindings in Admin for this prompt before running.";
          pushGenerateDebugEvent("resolver_validation_failed", {
            errors: [unresolvedMsg],
            debug: resolverDebug,
          });
          toast({
            variant: "destructive",
            title: "Prompt Variable Error",
            description: unresolvedMsg,
          });
          manualGenerateRef.current = false;
          setIsGenerating(false);
          return;
        }

        const generatePromptBuild = buildGenerateProductDataPrompt({
          resolvedAdminPrompt: resolvedTaskPrompt,
          includeAdditionalInstructions: routingConfig.includeAdditionalInstructions,
          additionalInstructions: additionalInstructionsData.trim(),
          includeFiltersProposalSection: false,
        });
        const finalPrompt = generatePromptBuild.prompt;
        setGenerateRawPromptOutputDebug({ prompt: finalPrompt, output: "" });
        const requiredSections = generatePromptBuild.requiredSections;
        const promptSanitization = generatePromptBuild.sanitization;
        const strictSectionValidation = routingConfig.strictResponseGuard && requiredSections.length > 0;
        const systemPrompt = "";
        if (promptSanitization.removedProductTitleSection || promptSanitization.removedTitleDirectiveLines > 0) {
          pushGenerateDebugEvent("prompt_conflict_detected", {
            conflict: "active_prompt_contains_title_inclusion_rule",
            prompt_type_selected: selectedPromptType,
          });
          pushGenerateDebugEvent("prompt_conflict_sanitized", {
            removed_title_directive_lines: promptSanitization.removedTitleDirectiveLines,
            removed_product_title_section: promptSanitization.removedProductTitleSection,
            prompt_type_selected: selectedPromptType,
          });
        }
        pushGenerateDebugEvent("final_prompt_built", {
          final_prompt_chars: finalPrompt.length,
          final_prompt_preview:
            finalPrompt.length > 1200
              ? `${finalPrompt.slice(0, 1200)}... [truncated ${finalPrompt.length - 1200} chars]`
              : finalPrompt,
          has_filter_context: hasHighValueFilterContext,
          has_variables: hasVariables,
          resolver_debug: resolverDebug,
          required_sections: requiredSections,
          system_prompt_chars: systemPrompt.length,
          prompt_sanitization: promptSanitization,
        });

        const shouldAttachInstructionForRun =
          (routingConfig.requireInstructionPdf || resolverRequestedLabels.has("instructions")) &&
          Boolean(instructionPdfFile);
        const shouldAttachDatasheet = resolverRequestedLabels.has("datasheet");
        const shouldAttachWebsite =
          resolverRequestedLabels.has("website") || resolverRequestedLabels.has("website_pdf");
        const selectedAiFiles = aiFiles.filter((fileRef) => {
          const label = (fileRef.label || "").toLowerCase();
          if (label === "datasheet") return shouldAttachDatasheet;
          if (label === "website" || label === "website_pdf") return shouldAttachWebsite;
          return false;
        });
        const allFiles = [
          ...(shouldAttachInstructionForRun && instructionPdfFile ? [instructionPdfFile] : []),
          ...selectedAiFiles,
        ];
        // === ASYNC JOB PIPELINE ===
        // 1. Allocate bucket and upload files (don't auto-clean — worker will clean)
        const bucket = await allocateProductBucket();
        if (!bucket) {
          throw new Error("All upload slots are currently in use. Please try again in a few minutes.");
        }

        let fileRefs: Array<{ bucket: string; path: string; filename: string; label: string }>;
        try {
          fileRefs = await uploadFilesToBucket(bucket, allFiles);
          pushGenerateDebugEvent("files_uploaded_to_bucket", {
            bucket,
            file_refs: fileRefs,
          });
        } catch (uploadErr) {
          // Clean up on upload failure
          await cleanBucket(bucket);
          await releaseBucketLock(bucket);
          throw uploadErr;
        }

        // 2. Start async job (returns immediately with jobId)
        const maxValidationRetries = 0;
        const startPayloadSummary = {
          type: "generate_data",
          mode: "text",
          has_system_prompt: Boolean(systemPrompt.trim()),
          requireFiles: true,
          responseGuard: {
            minTextLength: routingConfig.strictResponseGuard ? 40 : 20,
            requiredSections,
          },
          maxValidationRetries,
          retry_phase: options?.forceValidationRetry ? "strict_validation_retry" : "fast_path",
          retry_from_job_id: options?.retryFromJobId || null,
          configFlags: {
            singlePass: routingConfig.singlePass,
            directFiles: routingConfig.directFiles,
            allowMissingInstruction: !routingConfig.requireInstructionPdf,
            disableCache: true,
            strictSectionValidation,
          },
          file_ref_count: fileRefs.length,
        };
        pushGenerateDebugEvent("starting_ai_job", startPayloadSummary);
        const jobId = await aiJob.startJob({
          type: "generate_data",
          prompt: finalPrompt,
          systemPrompt: systemPrompt.trim() ? systemPrompt : undefined,
          files: fileRefs,
          bucket,
          mode: "text",
          debugActionKey: routingActionId,
          debugPromptType: selectedPromptType,
          requireFiles: true,
          responseGuard: {
            minTextLength: routingConfig.strictResponseGuard ? 40 : 20,
            requiredSections,
          },
          maxValidationRetries,
          configFlags: {
            singlePass: routingConfig.singlePass,
            directFiles: routingConfig.directFiles,
            allowMissingInstruction: !routingConfig.requireInstructionPdf,
            disableCache: true,
            strictSectionValidation,
          },
        });

        if (!jobId) {
          pushGenerateDebugEvent("job_start_failed", {
            bucket,
            start_payload: startPayloadSummary,
          });
          // startJob sets error internally; clean up bucket
          await cleanBucket(bucket);
          await releaseBucketLock(bucket);
          manualGenerateRef.current = false;
          setIsGenerating(false);
          return;
        }

        pushGenerateDebugEvent("job_started", {
          job_id: jobId,
          bucket,
          start_payload: startPayloadSummary,
        });

        // UI is now polling via useAiJob hook — isGenerating will be cleared by the effect
        manualGenerateRef.current = false;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        manualGenerateRef.current = false;
        console.error("❌ Gemini processing failed:", err);
        pushGenerateDebugEvent("exception", {
          error: message,
        });
        const startFailMsg = /api.?key|not set|not configured|unauthorized/i.test(message)
          ? "AI service is not properly configured. Contact Eran to resolve this."
          : /bucket|storage|slot/i.test(message)
            ? "File upload failed. Click Generate Data to retry. If repeated, contact Eran."
            : /network|fetch|ECONNREFUSED|ENOTFOUND/i.test(message)
              ? "Could not connect to the AI service. Check your internet and try again. If repeated, contact Eran."
              : `${message}. Click Generate Data to retry. If this keeps happening, contact Eran.`;
        toast({ title: "Failed to start AI processing", description: startFailMsg, variant: "destructive" });
        setIsGenerating(false);
        setGenerateCooldown(GENERATE_ERROR_COOLDOWN_SECONDS);
      }
    },
    [
      additionalInstructionsData,
      aiJob,
      brand,
      datasheetFile,
      fetchPromptInstructionPdf,
      getFirstActivePrompt,
      getAiFiles,
      getFilterContext,
      buildCompactFilterContextString,
      loadPromptVariables,
      mainCategory,
      pushGenerateDebugEvent,
      resetGenerateDebugOutput,
      selectedCategories,
      effectiveSku,
      toast,
      websitePdfFile,
    ],
  );

  useEffect(() => {
    if (generateDebugEventsRef.current.length === 0 && aiJob.status === "idle" && !isGeneratingActive) return;

    const statusPayloadObject =
      aiJob.statusPayload && typeof aiJob.statusPayload === "object" && !Array.isArray(aiJob.statusPayload)
        ? (aiJob.statusPayload as Record<string, unknown>)
        : null;
    const timingObject =
      statusPayloadObject?.timing &&
      typeof statusPayloadObject.timing === "object" &&
      !Array.isArray(statusPayloadObject.timing)
        ? (statusPayloadObject.timing as Record<string, unknown>)
        : null;
    const payloadMarker = [
      typeof statusPayloadObject?.status === "string" ? statusPayloadObject.status : "",
      String(typeof statusPayloadObject?.progress === "number" ? statusPayloadObject.progress : ""),
      String(typeof statusPayloadObject?.chunks_done === "number" ? statusPayloadObject.chunks_done : ""),
      String(typeof statusPayloadObject?.chunks_total === "number" ? statusPayloadObject.chunks_total : ""),
      typeof timingObject?.updated_at === "string" ? timingObject.updated_at : "",
      typeof timingObject?.finished_at === "string" ? timingObject.finished_at : "",
    ].join("|");

    const progressBucket =
      aiJob.status === "running" ? Math.floor(Math.max(0, aiJob.progress) / 10) * 10 : aiJob.progress;
    const eventSignature = [
      aiJob.jobId || "",
      aiJob.status,
      String(progressBucket),
      String(aiJob.chunksDone),
      String(aiJob.chunksTotal),
      String(aiJob.chunksError),
      aiJob.modelUsed || "",
      String(aiJob.latencyMs ?? ""),
      aiJob.error || "",
      payloadMarker,
    ].join("|");

    if (eventSignature === lastJobStatusDebugSignatureRef.current) return;
    lastJobStatusDebugSignatureRef.current = eventSignature;

    const isTerminalStatus = aiJob.status === "done" || aiJob.status === "error" || aiJob.status === "cancelled";
    const payloadChanged = payloadMarker !== lastJobStatusPayloadMarkerRef.current;
    if (payloadChanged) {
      lastJobStatusPayloadMarkerRef.current = payloadMarker;
    }

    pushGenerateDebugEvent("job_status", {
      job_id: aiJob.jobId,
      status: aiJob.status,
      progress: progressBucket,
      chunks_done: aiJob.chunksDone,
      chunks_total: aiJob.chunksTotal,
      chunks_error: aiJob.chunksError,
      model_used: aiJob.modelUsed,
      latency_ms: aiJob.latencyMs,
      error: aiJob.error,
      status_payload: payloadChanged || isTerminalStatus ? aiJob.statusPayload : null,
    });
  }, [
    aiJob.chunksDone,
    aiJob.chunksError,
    aiJob.chunksTotal,
    aiJob.error,
    aiJob.jobId,
    aiJob.latencyMs,
    aiJob.modelUsed,
    aiJob.progress,
    aiJob.status,
    aiJob.statusPayload,
    isGeneratingActive,
    pushGenerateDebugEvent,
  ]);

  // Track which job result we already processed to avoid re-toasting on tab switch
  // Using module-level variable since refs reset on remount
  const processedJobIdRef = useRef<string | null>(_lastProcessedJobId);

  // Effect: process AI job results when done or handle errors
  useEffect(() => {
    if (aiJob.status === "done" && aiJob.result) {
      // Guard: skip if we already processed this exact job
      const currentJobId = aiJob.jobId ?? "__no_id__";
      if (processedJobIdRef.current === currentJobId) return;
      processedJobIdRef.current = currentJobId;
      _lastProcessedJobId = currentJobId;
      try {
        sessionStorage.setItem(PROCESSED_JOB_KEY, currentJobId);
      } catch {
        // Ignore storage write errors (private mode / quota)
      }
      pushGenerateDebugEvent("job_done", {
        job_id: aiJob.jobId,
        latency_ms: aiJob.latencyMs,
        model_used: aiJob.modelUsed,
      });
      const response = aiJob.result;

      if (response.error && !response.success) {
        const raw = (response.error as string) || "Unknown error";
        const friendly = /api.?key|not set|not configured|unauthorized/i.test(raw)
          ? "AI service is not properly configured. Contact Eran to resolve this."
          : /timeout|timed out/i.test(raw)
            ? "The AI request timed out. Click Generate Data to retry. If repeated, try smaller PDFs."
            : /rate limit|429/i.test(raw)
              ? "AI rate limit reached. Wait 30–60 seconds and try again."
              : /network|fetch|502|503|500/i.test(raw)
                ? "Could not connect to the AI service. Check your internet and retry. If repeated, contact Eran."
                : `${raw}. Click Generate Data to retry. If this keeps happening, contact Eran.`;
        toast({ title: "AI Error", description: friendly, variant: "destructive" });
        setIsGenerating(false);
        setGenerateCooldown(GENERATE_ERROR_COOLDOWN_SECONDS);
        return;
      }

      const applied = applyGenerateDataResponse(response, {
        allowFilterAutofill: true,
        minimumAutofillConfidence: MINIMUM_AI_AUTOFILL_CONFIDENCE,
      });
      if (!applied) {
        toast({
          title: "Format Error",
          description: "AI output did not include usable product data. Please try again.",
          variant: "destructive",
        });
        setIsGenerating(false);
        setGenerateCooldown(GENERATE_ERROR_COOLDOWN_SECONDS);
        return;
      }

      const latencyMs = aiJob.latencyMs;
      toast({
        title: "AI Complete",
        description: latencyMs
          ? `Gemini processed your files in ${(latencyMs / 1000).toFixed(1)}s.`
          : "Gemini processed your files successfully.",
      });
      setIsGenerating(false);
      setGenerateComplete(true);
    }

    if (aiJob.status === "error") {
      const statusTiming =
        aiJob.statusPayload?.timing &&
        typeof aiJob.statusPayload.timing === "object" &&
        !Array.isArray(aiJob.statusPayload.timing)
          ? (aiJob.statusPayload.timing as Record<string, unknown>)
          : null;
      const resultMeta =
        aiJob.result?.meta && typeof aiJob.result.meta === "object" && !Array.isArray(aiJob.result.meta)
          ? (aiJob.result.meta as Record<string, unknown>)
          : null;
      const resultDebug =
        resultMeta?.debug && typeof resultMeta.debug === "object" && !Array.isArray(resultMeta.debug)
          ? (resultMeta.debug as Record<string, unknown>)
          : null;
      const debugTiming =
        resultDebug?.timing && typeof resultDebug.timing === "object" && !Array.isArray(resultDebug.timing)
          ? (resultDebug.timing as Record<string, unknown>)
          : null;
      const timing = statusTiming ?? debugTiming;
      const validationReason =
        typeof timing?.validation_failed_reason === "string" ? timing.validation_failed_reason : "";
      const backendValidationRetriesUsedRaw = Number(timing?.validation_retries_used || 0);
      const backendValidationRetriesUsed = Number.isFinite(backendValidationRetriesUsedRaw)
        ? Math.max(0, Math.floor(backendValidationRetriesUsedRaw))
        : 0;
      const strictRecoveryCandidate =
        validationReason === "product_data_no_valid_field_lines" ||
        validationReason === "critical_required_sections_missing_or_placeholder" ||
        /did not contain valid KEY:\s*VALUE lines/i.test(aiJob.error || "");

      if (strictRecoveryCandidate && aiJob.result && recoveredStrictErrorJobRef.current !== aiJob.jobId) {
        const applied = applyGenerateDataResponse(aiJob.result as GenerateLikeResponse, {
          allowFilterAutofill: true,
          minimumAutofillConfidence: MINIMUM_AI_AUTOFILL_CONFIDENCE,
        });
        if (applied) {
          recoveredStrictErrorJobRef.current = aiJob.jobId;
          pushGenerateDebugEvent("strict_error_recovered_from_result", {
            job_id: aiJob.jobId,
            error: aiJob.error,
            validation_reason: validationReason || null,
          });
          toast({
            title: "AI Complete",
            description: "Structured AI output was recovered despite strict validation warnings.",
          });
          setIsGenerating(false);
          setGenerateComplete(true);
          return;
        }
      }

      // Guarded retry is DISABLED — the user should re-run manually if strict validation fails.
      // The single-pass result is always accepted (fallback logic already recovers what it can).
      if (
        strictRecoveryCandidate &&
        !strictValidationRetryUsedRef.current &&
        aiJob.jobId &&
        backendValidationRetriesUsed === 0
      ) {
        strictValidationRetryUsedRef.current = true;
        pushGenerateDebugEvent("guarded_retry_skipped", {
          reason: "strict_validation_failure",
          failed_job_id: aiJob.jobId,
          validation_reason: validationReason || null,
          note: "automatic_retry_disabled",
        });
      }

      const heuristicConflictPlausibilityError = /conflict plausibility/i.test(aiJob.error || "");
      if (heuristicConflictPlausibilityError && aiJob.result && recoveredHeuristicErrorJobRef.current !== aiJob.jobId) {
        const applied = applyGenerateDataResponse(aiJob.result as GenerateLikeResponse, {
          recoveredFromHeuristicError: true,
          allowFilterAutofill: true,
          minimumAutofillConfidence: MINIMUM_AI_AUTOFILL_CONFIDENCE,
        });
        if (applied) {
          recoveredHeuristicErrorJobRef.current = aiJob.jobId;
          pushGenerateDebugEvent("heuristic_error_recovered_from_result", {
            job_id: aiJob.jobId,
            error: aiJob.error,
          });
          toast({
            title: "AI Complete",
            description: "Structured AI output was recovered despite a backend plausibility warning.",
          });
          return;
        }
      }
      // Don't crash or blank screen — show inline error with retry option
      console.warn("AI job error:", aiJob.error);
      const statusPayloadObject =
        aiJob.statusPayload && typeof aiJob.statusPayload === "object" && !Array.isArray(aiJob.statusPayload)
          ? (aiJob.statusPayload as Record<string, unknown>)
          : null;
      const timingObject =
        statusPayloadObject?.timing &&
        typeof statusPayloadObject.timing === "object" &&
        !Array.isArray(statusPayloadObject.timing)
          ? (statusPayloadObject.timing as Record<string, unknown>)
          : null;
      const payloadMarker = [
        typeof statusPayloadObject?.status === "string" ? statusPayloadObject.status : "",
        String(typeof statusPayloadObject?.progress === "number" ? statusPayloadObject.progress : ""),
        String(typeof statusPayloadObject?.chunks_done === "number" ? statusPayloadObject.chunks_done : ""),
        String(typeof statusPayloadObject?.chunks_total === "number" ? statusPayloadObject.chunks_total : ""),
        typeof timingObject?.updated_at === "string" ? timingObject.updated_at : "",
        typeof timingObject?.finished_at === "string" ? timingObject.finished_at : "",
      ].join("|");
      const errorSignature = [aiJob.jobId || "", aiJob.error || "", String(aiJob.latencyMs ?? ""), payloadMarker].join(
        "|",
      );

      if (errorSignature !== lastJobErrorDebugSignatureRef.current) {
        lastJobErrorDebugSignatureRef.current = errorSignature;
        pushGenerateDebugEvent("job_error", {
          job_id: aiJob.jobId,
          error: aiJob.error,
          latency_ms: aiJob.latencyMs,
          status_payload: aiJob.statusPayload,
        });
      }

      if (aiJob.jobId && surfacedGenerateErrorJobRef.current !== aiJob.jobId) {
        surfacedGenerateErrorJobRef.current = aiJob.jobId;

        if (friendlyGenerateError) {
          toast({
            variant: "destructive",
            title: friendlyGenerateError.title,
            description: friendlyGenerateError.suggestion,
          });
        } else if (aiJob.error) {
          toast({
            variant: "destructive",
            title: "Generate Data Failed",
            description:
              "Click Generate Data to retry. If this keeps happening, re-upload your PDFs. If it still fails, contact Eran.",
          });
        }
      }

      setIsGenerating(false);
      if (errorSignature !== generateCooldownErrorSignatureRef.current) {
        generateCooldownErrorSignatureRef.current = errorSignature;
        setGenerateCooldown(GENERATE_ERROR_COOLDOWN_SECONDS);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    aiJob.status,
    aiJob.result,
    aiJob.error,
    aiJob.jobId,
    aiJob.latencyMs,
    aiJob.modelUsed,
    applyGenerateDataResponse,
    friendlyGenerateError,
    datasheetFile,
    websitePdfFile,
    datasheetPdfData,
    websitePdfData,
    lastGenerateMode,
    toast,
    handleGenerateTitleAndData,
  ]);

  /** Build a plain-text form data snapshot for the resolver */
  const buildFormDataText = useCallback(() => {
    const lines: string[] = [];
    if (effectiveSku) lines.push(`SKU: ${effectiveSku}`);
    if (brand.trim()) lines.push(`Brand: ${brand.trim()}`);
    if (mainCategory.trim()) lines.push(`Main Category: ${mainCategory.trim()}`);
    if (selectedCategories.length > 0) {
      const uniqueCategories = Array.from(
        new Set(selectedCategories.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)),
      );
      const preview = uniqueCategories.slice(0, 8);
      const suffix =
        uniqueCategories.length > preview.length ? ` | +${uniqueCategories.length - preview.length} more` : "";
      lines.push(`Categories: ${preview.join(" | ")}${suffix}`);
    }
    if (title.trim()) lines.push(`Current Title: ${title.trim()}`);
    if (chatgptData.trim()) lines.push(`AI-Data:\n${chatgptData.trim()}`);
    // Add spec values
    const specEntries = Object.entries(specValues).filter(([, v]) => v?.trim());
    if (specEntries.length > 0) {
      lines.push("Specifications:");
      const renderedByLabel = new Map<string, string>();
      for (const [key, value] of specEntries) {
        const prop = properties.find((p) => p.key === key);
        const label =
          prop?.name
            ?.replace(/#\d+/g, "")
            .replace(/\([^)]*\)/g, "")
            .trim() || key;
        renderedByLabel.set(label, `  ${label}: ${value}`);
      }
      for (const rendered of renderedByLabel.values()) {
        lines.push(rendered);
      }
    }
    return lines.join("\n");
  }, [effectiveSku, brand, mainCategory, selectedCategories, title, chatgptData, specValues, properties]);

  const buildTitleDescFormDataText = useCallback(() => {
    const lines: string[] = [];
    if (effectiveSku) lines.push(`SKU: ${effectiveSku}`);
    if (brand.trim()) lines.push(`Brand: ${brand.trim()}`);
    if (mainCategory.trim()) lines.push(`Main Category: ${mainCategory.trim()}`);
    if (selectedCategories.length > 0) {
      const uniqueCategories = Array.from(
        new Set(selectedCategories.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)),
      );
      const preview = uniqueCategories.slice(0, 6);
      const suffix =
        uniqueCategories.length > preview.length ? ` | +${uniqueCategories.length - preview.length} more` : "";
      lines.push(`Related Categories: ${preview.join(" | ")}${suffix}`);
    }
    if (chatgptData.trim()) lines.push(`AI-Data:\n${chatgptData.trim()}`);

    const specs = buildSpecsSummary().trim();
    if (specs) lines.push(`Specifications:\n${specs}`);

    // Intentionally return full text so prompt variables are never silently truncated.
    // Server-side limits still protect against pathological payload sizes.
    return lines.join("\n").trim();
  }, [effectiveSku, brand, mainCategory, selectedCategories, chatgptData, buildSpecsSummary]);

  const normalizeCategoryPathForLookup = useCallback((raw: string): string => {
    return raw
      .trim()
      .replace(/\s*\/\s*/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  }, []);

  /** Lookup category name structure/example from masterLookup */
  const getCategoryNaming = useCallback(() => {
    if (!mainCategory.trim() || masterLookup.length === 0) return { structure: "", example: "" };
    const normalized = normalizeCategoryPathForLookup(mainCategory);
    let bestStructure = "";
    let bestExample = "";
    let bestStructurePathLength = -1;
    let bestExamplePathLength = -1;

    for (const entry of masterLookup) {
      const entryPath = normalizeCategoryPathForLookup(entry.categoryPath || "");
      if (!entryPath) continue;
      if (normalized === entryPath || normalized.startsWith(entryPath + "/")) {
        const structure = (entry.nameStructure || "").trim();
        const example = (entry.nameExample || "").trim();
        if (structure && entryPath.length > bestStructurePathLength) {
          bestStructure = structure;
          bestStructurePathLength = entryPath.length;
        }
        if (example && entryPath.length > bestExamplePathLength) {
          bestExample = example;
          bestExamplePathLength = entryPath.length;
        }
      }
    }
    return {
      structure: bestStructure,
      example: bestExample,
    };
  }, [mainCategory, masterLookup, normalizeCategoryPathForLookup]);
  const categoryNamingPreview = useMemo(() => getCategoryNaming(), [getCategoryNaming]);

  const handleGenerateDescription = useCallback(async () => {
    if (!getGeminiConfig().enabled) {
      toast({
        title: "Gemini AI is disabled",
        description: "Enable Gemini AI in the Admin panel first.",
        variant: "destructive",
      });
      return;
    }

    if (!chatgptData.trim()) {
      toast({
        title: "AI-Data is required",
        description: "Generate or enter AI-Data first, then run Title & Description generation.",
        variant: "destructive",
      });
      return;
    }

    if (hasAiDataBlockingIssue) {
      setErrors((prev) => ({
        ...prev,
        chatgptData: aiDataBlockingMessage,
      }));
      focusAiDataSection({ focus: true });
      toast({
        title: "Resolve AI-Data first",
        description: aiDataBlockingMessage,
        variant: "destructive",
      });
      return;
    }

    const modeForRun: "technical" | "marketing" = promptMode;
    const previousTitle = title;
    const previousDescription = chatgptDescription;
    titleDescPreRunValuesRef.current = {
      title: previousTitle,
      description: previousDescription,
    };
    let generationSucceeded = false;
    // Determine prompt type based on mode
    const routingActionId: AiActionId =
      modeForRun === "marketing" ? "product_generate_description_marketing" : "product_generate_description_technical";
    const routingConfig = getAiActionRouting(routingActionId);
    const defaultPromptCandidates = getDefaultAiRoutingConfig()[routingActionId].promptCandidates;

    if (!routingConfig.enabled) {
      toast({
        variant: "destructive",
        title: "Action Disabled",
        description: "Enable this action in Admin → AI Routing Options.",
      });
      return;
    }

    // Immediately clear fields
    setChatgptDescription("");
    setTitle("");
    setIsGeneratingDesc(true);
    setDescComplete(false);
    descCancelledRef.current = false;
    const initialDebugOutput = "⏳ Starting Title & Description generation...\nMode: " + modeForRun;
    setTitleDescDebugOutput(initialDebugOutput);
    writeTitleDescRuntimeState({
      status: "running",
      promptMode: modeForRun,
      debugOutput: initialDebugOutput,
      title: "",
      description: "",
    });

    try {
      const appendTitleDescDebug = (message: string, nextStatus: TitleDescRuntimeStatus = "running") => {
        setTitleDescDebugOutput((prev) => {
          const next = prev + message;
          const runtime = readTitleDescRuntimeState();
          const statusToWrite =
            nextStatus === "running" && (runtime.status === "done" || runtime.status === "error")
              ? runtime.status
              : nextStatus;
          writeTitleDescRuntimeState({
            status: statusToWrite,
            promptMode: modeForRun,
            debugOutput: next,
          });
          return next;
        });
      };
      const promptCandidates =
        routingConfig.promptCandidates.length > 0 ? routingConfig.promptCandidates : defaultPromptCandidates;

      const activePromptSelection = await getFirstActivePrompt(promptCandidates);

      if (!activePromptSelection?.prompt) {
        const missingPromptMsg = `Activate one of: ${promptCandidates.join(", ")}`;
        appendTitleDescDebug("\n\n❌ No active prompt found. " + missingPromptMsg);
        writeTitleDescRuntimeState({
          status: "error",
          promptMode: modeForRun,
        });
        setDescComplete(false);
        toast({
          variant: "destructive",
          title: "No Active Prompt",
          description: missingPromptMsg,
        });
        return;
      }

      const promptTemplate = activePromptSelection.prompt;
      const selectedPromptType = activePromptSelection.promptType;
      const promptHasTemplateVariables = promptTemplate.includes("{{");
      const promptVariables = promptHasTemplateVariables ? await loadPromptVariables(selectedPromptType) : [];
      const activePromptVariables = promptHasTemplateVariables
        ? getPromptVariablesInUse({
            promptType: selectedPromptType,
            activeVersionContent: promptTemplate,
            variables: promptVariables,
          })
        : [];
      const usesBinding = (bindingType: PromptVariable["bindingType"]) =>
        activePromptVariables.some(
          (variable) => normalizePromptVariableBindingType(String(variable.bindingType || "")) === bindingType,
        );
      const instructionVarNamesInPrompt = activePromptVariables
        .filter(
          (variable) => normalizePromptVariableBindingType(String(variable.bindingType || "")) === "instruction_pdf",
        )
        .map((variable) => variable.name)
        .filter(Boolean);
      const shouldAttachInstructionPdf = routingConfig.requireInstructionPdf || instructionVarNamesInPrompt.length > 0;
      const perPromptInstrPdf = shouldAttachInstructionPdf ? await fetchPromptInstructionPdf(selectedPromptType) : null;
      const filterContextString = usesBinding("form_filter_context")
        ? buildCompactFilterContextString(getFilterContext())
        : "";

      // Category naming lookup
      const categoryNaming =
        usesBinding("category_name_structure") || usesBinding("category_name_example")
          ? getCategoryNaming()
          : { structure: "", example: "" };

      // Build runtime context
      const runtimeCtx: RuntimeContext = {
        instructionPdf: perPromptInstrPdf
          ? {
              bucket: "document-uploads-constant",
              path: "",
              filename: perPromptInstrPdf.file.name,
              label: "instructions",
            }
          : null,
        datasheetUpload:
          usesBinding("supplier_datasheet_pdf") && datasheetFile
            ? { bucket: "", path: "", filename: datasheetFile.name, label: "datasheet" }
            : null,
        websiteUpload:
          usesBinding("supplier_website_pdf") && websitePdfFile
            ? { bucket: "", path: "", filename: websitePdfFile.name, label: "website_pdf" }
            : null,
        formSku: usesBinding("form_sku") ? effectiveSku || undefined : undefined,
        formBrand: usesBinding("form_brand") ? brand || undefined : undefined,
        formTitle: usesBinding("form_title") ? title || undefined : undefined,
        formDescription: usesBinding("form_description") ? chatgptDescription || undefined : undefined,
        formMainCategory: usesBinding("form_main_category") ? mainCategory || undefined : undefined,
        formSelectedCategories: usesBinding("form_selected_categories")
          ? selectedCategories.length > 0
            ? selectedCategories.join(", ")
            : undefined
          : undefined,
        editedAiDataText: usesBinding("form_ai_data_edited") ? chatgptData.trim() || undefined : undefined,
        formDataText: usesBinding("form_data_text") ? buildTitleDescFormDataText() || undefined : undefined,
        formSpecificationsSummary: usesBinding("form_specifications_summary")
          ? buildSpecsSummary() || undefined
          : undefined,
        formImageUrls: usesBinding("form_image_urls") ? imageUrls.filter(Boolean).join("\n") || undefined : undefined,
        formEmailNotes: usesBinding("form_email_notes") ? emailNotes || undefined : undefined,
        additionalInstructionsTitle: usesBinding("additional_instructions_title")
          ? additionalInstructions.trim() || undefined
          : undefined,
        categoryNameStructure: categoryNaming.structure || undefined,
        categoryNameExample: categoryNaming.example || undefined,
        formFilterContext: filterContextString || undefined,
      };

      // Resolve variables
      let resolvedPrompt = activePromptSelection.prompt;
      let resolverDebug: unknown = null;
      const resolverRequestedLabels = new Set<string>();

      if (promptHasTemplateVariables) {
        const resolveResult = resolvePromptVariables(
          {
            promptType: selectedPromptType,
            promptName: selectedPromptType,
            activeVersionContent: activePromptSelection.prompt,
            variables: activePromptVariables,
          },
          runtimeCtx,
        );

        if (resolveResult.validationErrors.length > 0) {
          appendTitleDescDebug("\n\n❌ Variable validation failed:\n- " + resolveResult.validationErrors.join("\n- "));
          writeTitleDescRuntimeState({
            status: "error",
            promptMode: modeForRun,
          });
          setDescComplete(false);
          for (const err of resolveResult.validationErrors) {
            toast({ variant: "destructive", title: "Missing Required Input", description: err });
          }
          return;
        }

        resolvedPrompt = resolveResult.finalPrompt;
        resolverDebug = resolveResult.debugResolved;
        for (const file of resolveResult.files) {
          if (file.label) resolverRequestedLabels.add(file.label);
        }

        const debugInfo = {
          mode: modeForRun,
          promptName: selectedPromptType,
          variables_resolved: resolveResult.debugResolved,
          files_attached: resolveResult.files.map((f) => f.label),
          validation_errors: resolveResult.validationErrors,
          categoryNameStructure: categoryNaming.structure || null,
          categoryNameExample: categoryNaming.example || null,
        };
        console.log("[Title/Desc Resolver Debug]", debugInfo);
        appendTitleDescDebug(
          "\n\n📋 Prompt: " +
            selectedPromptType +
            "\n📐 Variables resolved: " +
            JSON.stringify(resolveResult.debugResolved, null, 2) +
            "\n📎 Files: " +
            (resolveResult.files.map((f) => f.label).join(", ") || "none") +
            (resolveResult.validationErrors.length > 0
              ? "\n⚠️ Validation errors: " + resolveResult.validationErrors.join("; ")
              : "") +
            (categoryNaming.structure ? "\n🏷️ Name Structure: " + categoryNaming.structure : "") +
            (categoryNaming.example ? "\n🏷️ Name Example: " + categoryNaming.example : ""),
        );
      }

      const finalPrompt = buildTitleDescriptionPrompt({
        resolvedPrompt,
        includeAdditionalInstructions: routingConfig.includeAdditionalInstructions,
        additionalInstructions,
      });
      setTitleDescRawPromptOutputDebug({ prompt: finalPrompt, output: "" });
      const unresolvedPlaceholders = Array.from(new Set(finalPrompt.match(/\{\{[^}]+\}\}/g) || []));
      if (unresolvedPlaceholders.length > 0) {
        const unresolvedMsg =
          "Unresolved prompt variables detected: " +
          unresolvedPlaceholders.join(", ") +
          ". Fix variable bindings/placeholders in Admin prompt before running.";
        appendTitleDescDebug("\n\n❌ " + unresolvedMsg);
        toast({
          title: "Prompt Variable Error",
          description: unresolvedMsg,
          variant: "destructive",
        });
        writeTitleDescRuntimeState({
          status: "error",
          promptMode: modeForRun,
        });
        return;
      }
      const normalizedPromptChars = finalPrompt.replace(/\s+/g, "").length;
      if (normalizedPromptChars < 24) {
        const emptyPromptMsg =
          "Resolved prompt is empty or too short after variable substitution. Check the Admin prompt text and variable bindings.";
        appendTitleDescDebug("\n\n❌ " + emptyPromptMsg);
        writeTitleDescRuntimeState({
          status: "error",
          promptMode: modeForRun,
        });
        setDescComplete(false);
        toast({
          title: "Prompt Too Short",
          description: emptyPromptMsg,
          variant: "destructive",
        });
        return;
      }

      // Build files list from resolver-requested file variables only.
      const aiFiles = getAiFiles();
      const shouldAttachInstructionForRun =
        routingConfig.requireInstructionPdf || resolverRequestedLabels.has("instructions");
      const shouldAttachDatasheet = resolverRequestedLabels.has("datasheet");
      const shouldAttachWebsite = resolverRequestedLabels.has("website") || resolverRequestedLabels.has("website_pdf");

      const selectedAiFiles = aiFiles.filter((fileRef) => {
        const label = (fileRef.label || "").toLowerCase();
        if (label === "datasheet") return shouldAttachDatasheet;
        if (label === "website" || label === "website_pdf") return shouldAttachWebsite;
        return false;
      });

      const allFiles = [
        ...(shouldAttachInstructionForRun && perPromptInstrPdf ? [perPromptInstrPdf] : []),
        ...selectedAiFiles,
      ];

      if (routingConfig.requireInstructionPdf && !perPromptInstrPdf) {
        const missingInstructionMsg =
          "Upload the instruction PDF for this title/description action in Admin before generating.";
        appendTitleDescDebug("\n\n❌ " + missingInstructionMsg);
        writeTitleDescRuntimeState({
          status: "error",
          promptMode: modeForRun,
        });
        setDescComplete(false);
        toast({
          variant: "destructive",
          title: "Missing Instruction PDF",
          description: missingInstructionMsg,
        });
        return;
      }

      // ── Prompt snapshot for long-term debugging ──
      const promptSnapshot = {
        mode: modeForRun,
        promptType: selectedPromptType,
        temperature: typeof routingConfig.temperature === "number" ? routingConfig.temperature : null,
        categoryPath: mainCategory.trim() || null,
        categoryTemplateFound: !!(categoryNaming.structure || categoryNaming.example),
        categoryNameStructure: categoryNaming.structure || null,
        categoryNameExample: categoryNaming.example || null,
        variables_resolved: resolverDebug,
        files_attached: allFiles.map((f) =>
          typeof f === "object" && "label" in f ? (f as { label?: string }).label : "unknown",
        ),
        includeEditedAiData: !!runtimeCtx.editedAiDataText,
      };
      console.log("[Title/Desc Prompt Snapshot]", promptSnapshot);

      const actionKey: AiActionId =
        modeForRun === "marketing"
          ? "product_generate_description_marketing"
          : "product_generate_description_technical";
      const titleDescriptionSystemPrompt = "";
      const titleDescResponseGuard = {
        minTextLength: 40,
      };
      const finalPromptPreviewChars = 2500;
      const finalPromptPreview = finalPrompt.slice(0, finalPromptPreviewChars);
      appendTitleDescDebug(
        "\n\n🧾 Final Prompt (" +
          finalPrompt.length +
          " chars, debug preview):\n" +
          finalPromptPreview +
          (finalPrompt.length > finalPromptPreviewChars
            ? "\n... [debug preview truncated " +
              (finalPrompt.length - finalPromptPreviewChars) +
              " chars; full prompt was sent to AI]"
            : "") +
          "\n\n🚀 Dispatch Summary:" +
          "\n- actionKey: " +
          actionKey +
          "\n- requestType: admin_action" +
          "\n- mode: text (client JSON parse)" +
          "\n- selectedPromptType: " +
          selectedPromptType +
          "\n- authorityBlockInjected: false" +
          "\n- attachedFiles: " +
          (allFiles.map((f) => f.label).join(", ") || "none"),
      );

      // Parse model text into the expected { title, description } payload.
      const handleTitleDescResponse = (response: GeminiProcessResponse): boolean => {
        if (descCancelledRef.current) return false;
        if (response.error || !response.success) {
          appendTitleDescDebug("\n\n❌ Error: " + (response.error || "Unknown error"));
          throw new Error(response.error || "Gemini error");
        }

        const rawResult =
          typeof response.result === "string"
            ? response.result
            : response.result
              ? JSON.stringify(response.result)
              : "";
        setTitleDescRawPromptOutputDebug((prev) => ({ ...prev, output: rawResult }));

        // Debug: raw response
        appendTitleDescDebug(
          "\n\n📥 Raw AI Response (" +
            rawResult.length +
            " chars):" +
            "\n" +
            rawResult.slice(0, 2000) +
            (rawResult.length > 2000 ? "\n... (truncated)" : "") +
            (response.meta?.latencyMs ? "\n⏱️ Latency: " + (response.meta.latencyMs / 1000).toFixed(1) + "s" : "") +
            (response.meta?.model ? "\n🤖 Model: " + response.meta.model : ""),
        );

        const parsed = parseTitleDescriptionJson(rawResult);

        if (!parsed) {
          appendTitleDescDebug("\n\n❌ Failed to parse JSON from AI response");
          return false;
        }

        // ── Title sanitization ──
        let sanitizedTitle = parsed.title
          .trim()
          .replace(/[\r\n]+/g, " ") // remove line breaks
          .replace(/\s{2,}/g, " ") // collapse multiple spaces
          .replace(/\.+$/, ""); // remove trailing period(s)
        sanitizedTitle = normalizeGeneratedTitleCase(sanitizedTitle);
        if (sanitizedTitle.length > 255) {
          sanitizedTitle = sanitizedTitle.slice(0, 255).trim();
        }

        const sanitizedDescription = parsed.description
          .replace(/\r\n?/g, "\n")
          .replace(/\n\s*\n+/g, "\n")
          .trim();

        setTitle(sanitizedTitle);
        setChatgptDescription(sanitizedDescription);
        trackAiGenerated("aiDescription", sanitizedDescription);

        const successBlock =
          "\n\n✅ Parsed successfully" +
          "\n📝 Title (" +
          sanitizedTitle.length +
          " chars): " +
          sanitizedTitle +
          "\n📝 Description (" +
          sanitizedDescription.length +
          " chars): " +
          sanitizedDescription.slice(0, 300) +
          (sanitizedDescription.length > 300 ? "..." : "");
        appendTitleDescDebug(successBlock, "done");
        writeTitleDescRuntimeState({
          status: "done",
          promptMode: modeForRun,
          title: sanitizedTitle,
          description: sanitizedDescription,
        });

        toast({
          title: "Title & Description Generated",
          description: response.meta?.latencyMs
            ? `Completed in ${(response.meta.latencyMs / 1000).toFixed(1)}s.`
            : "Fields populated successfully.",
        });
        return true;
      };

      const titleDescProgressSnapshot = {
        status: "",
        progressBucket: -1,
        chunksDone: -1,
        chunksError: -1,
        payloadMarker: "",
      };

      const executeTitleDescRequest = async (
        fileRefs: Array<{ bucket: string; path: string; filename?: string; label?: string }>,
      ): Promise<GeminiProcessResponse> => {
        const { response } = await runAiAction({
          actionKey,
          userTaskPrompt: finalPrompt,
          prebuiltPrompt: true,
          type: "admin_action",
          mode: "text",
          files: fileRefs,
          debugPromptType: selectedPromptType,
          systemPrompt: titleDescriptionSystemPrompt,
          responseGuard: titleDescResponseGuard,
          maxValidationRetries: 0,
          onProgress: (progress) => {
            if (descCancelledRef.current) return;

            const statusPayload =
              progress.statusPayload &&
              typeof progress.statusPayload === "object" &&
              !Array.isArray(progress.statusPayload)
                ? (progress.statusPayload as Record<string, unknown>)
                : null;
            const timingObject =
              statusPayload?.timing && typeof statusPayload.timing === "object" && !Array.isArray(statusPayload.timing)
                ? (statusPayload.timing as Record<string, unknown>)
                : null;
            const payloadMarker = [
              typeof statusPayload?.status === "string" ? statusPayload.status : "",
              String(typeof statusPayload?.progress === "number" ? statusPayload.progress : ""),
              String(typeof statusPayload?.chunks_done === "number" ? statusPayload.chunks_done : ""),
              String(typeof statusPayload?.chunks_total === "number" ? statusPayload.chunks_total : ""),
              typeof timingObject?.updated_at === "string" ? timingObject.updated_at : "",
              typeof timingObject?.finished_at === "string" ? timingObject.finished_at : "",
            ].join("|");

            const progressValue = Number(progress.progress || 0);
            const progressBucket =
              progress.status === "running"
                ? Math.floor(Math.max(0, progressValue) / 10) * 10
                : Math.floor(Math.max(0, progressValue));
            const shouldLog =
              progress.status !== titleDescProgressSnapshot.status ||
              progressBucket !== titleDescProgressSnapshot.progressBucket ||
              progress.chunksDone !== titleDescProgressSnapshot.chunksDone ||
              progress.chunksError !== titleDescProgressSnapshot.chunksError ||
              payloadMarker !== titleDescProgressSnapshot.payloadMarker;
            if (!shouldLog) return;

            titleDescProgressSnapshot.status = progress.status;
            titleDescProgressSnapshot.progressBucket = progressBucket;
            titleDescProgressSnapshot.chunksDone = progress.chunksDone;
            titleDescProgressSnapshot.chunksError = progress.chunksError;
            titleDescProgressSnapshot.payloadMarker = payloadMarker;

            const clampedProgress = Math.max(0, Math.min(100, Math.round(progressValue)));
            setDescProgress((prev) => {
              if (progress.status === "done") return 100;
              if (progress.status === "error" || progress.status === "cancelled") return prev;
              const nextProgress = Math.min(90, clampedProgress);
              return nextProgress > prev ? nextProgress : prev;
            });

            appendTitleDescDebug(
              "\n\n📡 Job status update:" +
                "\n- status: " +
                progress.status +
                "\n- progress: " +
                Math.max(0, Math.min(100, Math.round(progressValue))) +
                "%" +
                "\n- chunks: " +
                progress.chunksDone +
                "/" +
                progress.chunksTotal +
                "\n- chunkErrors: " +
                progress.chunksError,
            );
          },
        });
        return response;
      };

      const processWithRetry = async (
        fileRefs: Array<{ bucket: string; path: string; filename?: string; label?: string }>,
      ) => {
        let attempts = 0;
        while (attempts < 2) {
          if (descCancelledRef.current) return;
          attempts += 1;
          try {
            const response = await executeTitleDescRequest(fileRefs);
            if (descCancelledRef.current) return;
            const handled = handleTitleDescResponse(response);
            generationSucceeded = Boolean(handled);
            if (handled) return;
            if (descCancelledRef.current) return;

            if (attempts < 2) {
              appendTitleDescDebug("\n\n♻️ Response format invalid, retrying once...");
              continue;
            }
            throw new Error("AI returned invalid JSON format after retry. Please regenerate.");
          } catch (err) {
            if (descCancelledRef.current) return;
            const message = err instanceof Error ? err.message : String(err);
            const timeoutLike = /timed?\s*out|timeout|deadline|abort/i.test(message);
            if (timeoutLike && attempts < 2) {
              appendTitleDescDebug("\n\n♻️ Timeout detected, retrying once with the same prompt...");
              continue;
            }
            throw err;
          }
        }
      };

      if (allFiles.length > 0) {
        await withBucket(allFiles, async (fileRefs) => {
          await processWithRetry(fileRefs);
        });
      } else {
        await processWithRetry([]);
      }

      setDescComplete(generationSucceeded);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("❌ Title/Description generation failed:", err);
      setTitleDescDebugOutput((prev) => {
        const next = prev + "\n\n❌ Generation failed: " + message;
        writeTitleDescRuntimeState({
          status: "error",
          promptMode: modeForRun,
          debugOutput: next,
        });
        return next;
      });
      toast({ title: "Failed", description: message, variant: "destructive" });
    } finally {
      setIsGeneratingDesc(false);
      if (!generationSucceeded && !descCancelledRef.current) {
        setTitle(previousTitle);
        setChatgptDescription(previousDescription);
        writeTitleDescRuntimeState({
          title: previousTitle,
          description: previousDescription,
        });
      }
      if (descCancelledRef.current) {
        writeTitleDescRuntimeState({
          status: "idle",
          promptMode: modeForRun,
        });
        setDescComplete(false);
      }
    }
  }, [
    aiDataBlockingMessage,
    additionalInstructions,
    brand,
    buildSpecsSummary,
    chatgptData,
    chatgptDescription,
    datasheetFile,
    emailNotes,
    fetchPromptInstructionPdf,
    getAiFiles,
    getCategoryNaming,
    getFilterContext,
    buildCompactFilterContextString,
    buildTitleDescFormDataText,
    getFirstActivePrompt,
    imageUrls,
    hasAiDataBlockingIssue,
    mainCategory,
    promptMode,
    selectedCategories,
    effectiveSku,
    title,
    toast,
    websitePdfFile,
  ]);

  const validateForm = (): {
    valid: boolean;
    missingFields: string[];
    missingFilterFields: string[];
    firstErrorSection: string | null;
    firstErrorTargetId: string | null;
  } => {
    const newErrors: FormErrors = {};
    const missingFields: string[] = [];
    const missingFilterFields: string[] = [];
    const seenMissingFields = new Set<string>();
    const seenMissingFilterFields = new Set<string>();
    // Ordered from top to bottom on the page
    const sectionOrder = ["basic-info", "categories", "ai-data", "filters", "title-description", "images"];
    let firstErrorIdx = sectionOrder.length;
    let firstErrorTargetId: string | null = null;
    const addMissingField = (label: string, kind: "field" | "filter" = "field") => {
      if (!seenMissingFields.has(label)) {
        seenMissingFields.add(label);
        missingFields.push(label);
      }
      if (kind === "filter" && !seenMissingFilterFields.has(label)) {
        seenMissingFilterFields.add(label);
        missingFilterFields.push(label);
      }
    };
    const setSection = (s: string, targetId?: string) => {
      const idx = sectionOrder.indexOf(s);
      if (idx < firstErrorIdx) {
        firstErrorIdx = idx;
        firstErrorTargetId = targetId ?? `section-${s}`;
      }
    };

    if (!effectiveSku) {
      newErrors.sku = "SKU is required";
      addMissingField("SKU");
      setSection("basic-info");
    }

    // Price validation: only after SKU is selected and sheet lookup finished
    if (effectiveSku && !skuSheetLookupLoading && !isValidPriceValue(price)) {
      newErrors.price = "Invalid price — contact Eran to update the Google Sheet";
      addMissingField("Price (invalid — contact Eran)");
      setSection("basic-info");
    }

    if (selectedCategories.length === 0) {
      newErrors.category = "At least one category must be selected";
      addMissingField("Category");
      setSection("categories");
    } else if (!mainCategory) {
      newErrors.category = "Select a MAIN category.";
      addMissingField("Main Category");
      setSection("categories");
    }

    // Image validations
    if (!imageUrls[0]?.trim()) {
      newErrors.images = "At least one image URL is required";
      addMissingField("Image URL 1");
      setSection("images", "image-0");
    } else if (!firstImageValid) {
      const w = firstImageDimsRef.current.width ?? 0;
      const h = firstImageDimsRef.current.height ?? 0;
      newErrors.images = `Image 1 is ${w}×${h}px — minimum 700×700px required`;
      addMissingField(`Image 1 too small (${w}×${h}px)`);
      setSection("images", "image-0");
    }

    // Check for invalid image URLs (wrong extension)
    const VALID_EXT = /\.(jpe?g|png|gif|webp)$/i;
    const URL_PATTERN = /^https?:\/\/.+/i;
    const invalidImages: number[] = [];
    imageUrls.forEach((u, i) => {
      const trimmed = u.trim();
      if (trimmed && URL_PATTERN.test(trimmed) && !VALID_EXT.test(trimmed)) {
        invalidImages.push(i + 1);
      }
    });
    if (invalidImages.length > 0) {
      newErrors.images = newErrors.images || `Invalid image format in URL ${invalidImages.join(", ")}`;
      addMissingField(`Invalid Image URL ${invalidImages.join(", ")}`);
      setSection("images", `image-${Math.max(invalidImages[0] - 1, 0)}`);
    }

    // Check for duplicate images
    const trimmedUrls = imageUrls.map((u) => u.trim().toLowerCase()).filter(Boolean);
    const uniqueUrls = new Set(trimmedUrls);
    if (uniqueUrls.size < trimmedUrls.length) {
      newErrors.images = newErrors.images || "Duplicate image URLs detected — remove duplicates before submitting.";
      addMissingField("Duplicate Images");
      setSection("images", "image-0");
    }

    // AI fields
    if (!title.trim()) {
      newErrors.title = "Title is required";
      addMissingField("Title");
      setSection("title-description", "title");
    }
    if (!chatgptData.trim()) {
      newErrors.chatgptData = "AI-Data is required";
      addMissingField("AI-DATA");
      setSection("ai-data", "ai-data");
    } else if (hasAiDataBlockingIssue) {
      newErrors.chatgptData = aiDataBlockingMessage;
      addMissingField("AI-DATA (MISSING***)");
      for (const label of aiDataMandatoryMissingInfo.labels) {
        addMissingField(label, "filter");
      }
      setSection("ai-data", "ai-data");
    }
    if (!chatgptDescription.trim()) {
      newErrors.chatgptDescription = "AI-Description is required";
      addMissingField("AI-Description");
      setSection("title-description", "ai-description");
    }

    // Check mandatory filter fields — deduplicate against AI-Data missing labels
    const missingMandatory = new Set<string>();
    const aiDataMissingLabelsSet = new Set(aiDataMandatoryMissingInfo.labels);

    for (const key of mandatoryFilterKeys) {
      const raw = specValues[key]?.trim() ?? "";
      const val = /^X$/i.test(raw) ? "" : raw;
      const isEmpty = !val;
      const isMissingMarkerVal = Boolean(val) && isMissingValue(val);
      if (isEmpty || isMissingMarkerVal) {
        missingMandatory.add(key);
        const prop = properties.find((p) => p.key === key);
        const label = normalizeFilterDisplayLabel(prop?.name?.trim() || key);
        // Only add to missingFields if not already reported by AI-Data missing
        if (!aiDataMissingLabelsSet.has(label)) {
          addMissingField(label, "filter");
        }
        setSection("filters");
      }
    }

    setMandatoryErrors(missingMandatory);
    if (missingMandatory.size > 0 || hasAiDataMandatoryMissingMarkers) {
      newErrors.filters = "Please resolve the highlighted mandatory filter fields before submitting.";
    }

    setErrors(newErrors);
    const firstErrorSection = firstErrorIdx < sectionOrder.length ? sectionOrder[firstErrorIdx] : null;
    return {
      valid: Object.keys(newErrors).length === 0,
      missingFields,
      missingFilterFields,
      firstErrorSection,
      firstErrorTargetId,
    };
  };

  const resetForm = () => {
    resetTransientAiUiState();
    setSku("");
    setMpnDraftId((current) => current || createMpnDraftId());
    setGpsMpn("");
    setMpnAttachmentState("none");
    setHeldDockSku("");
    setLoadedDockSourceSku("");
    setLoadedDockSourceTitle("");
    setLoadedDockSubmissionEpochMs(undefined);
    setLoadedDockSubmissionSku("");
    setBrand("");
    setPrice("");
    setVisibility("");
    setTitle("");
    setChatgptData("");
    setChatgptDescription("");
    setDatasheetFile(null);
    setWebsitePdfFile(null);
    setDatasheetUrl("");
    setWebpageUrl("");
    setSelectedCategories([]);
    setMainCategory("");
    setImageUrls([""]);
    setSpecValues({});
    setOtherValues({});
    setEmailNotes("");
    setAdditionalInstructions("");
    setAdditionalInstructionsData("");
    setErrors({});
    setMandatoryErrors(new Set());
    setConflicts([]);
    setExtractionConflicts([]);
    setFilterProposals([]);
    setFilterSources({});
    setManuallyEditedFilters(new Set());
    setIncludeEditedAiData(false);
    setLastGenerateMode("");
    clearAiTracking();
  };
  resetFormRef.current = resetForm;

  const hasMeaningfulFormContent = useCallback(() => {
    return Boolean(
      sku.trim() ||
      heldDockSku.trim() ||
      brand.trim() ||
      price.trim() ||
      title.trim() ||
      chatgptData.trim() ||
      chatgptDescription.trim() ||
      emailNotes.trim() ||
      selectedCategories.length > 0 ||
      mainCategory.trim() ||
      imageUrls.some((value) => String(value ?? "").trim()) ||
      Object.values(specValues).some((value) => String(value ?? "").trim()) ||
      Object.values(otherValues).some((value) => String(value ?? "").trim()) ||
      datasheetFile ||
      websitePdfFile ||
      datasheetUrl.trim() ||
      webpageUrl.trim() ||
      additionalInstructions.trim() ||
      additionalInstructionsData.trim(),
    );
  }, [
    additionalInstructions,
    additionalInstructionsData,
    brand,
    chatgptData,
    chatgptDescription,
    datasheetFile,
    datasheetUrl,
    emailNotes,
    heldDockSku,
    imageUrls,
    mainCategory,
    otherValues,
    price,
    visibility,
    selectedCategories,
    sku,
    specValues,
    title,
    webpageUrl,
    websitePdfFile,
  ]);

  const normalizeCsvImportSkuStatus = useCallback((status: string): "TO_DO" | "COMPLETE" | "NOT_FOR_SALE" | "" => {
    const normalized = String(status ?? "")
      .trim()
      .toUpperCase();
    if (normalized === config.STATUS_TO_DO || normalized === "TO DO") return "TO_DO";
    if (normalized === config.STATUS_COMPLETE) return "COMPLETE";
    if (normalized === config.STATUS_NOT_FOR_SALE || normalized === "NOT FOR SALE") return "NOT_FOR_SALE";
    return "";
  }, []);

  const applyImportedCsvFormData = useCallback(
    (formData: ImportedProductFormData, options?: { basicInfoMode?: CsvImportBasicInfoMode }) => {
      const importedSku = String(formData.sku ?? "").trim();
      const importedTitle = normalizeProductTitleWhitespace(String(formData.title ?? ""));
      const preserveBasicInfo = options?.basicInfoMode === "template";
      const preservedBasicInfo = preserveBasicInfo
        ? {
            sku,
            gpsMpn,
            mpnAttachmentState,
            brand,
            price,
            visibility,
            heldDockSku,
            loadedDockSourceSku,
            loadedDockSourceTitle,
            loadedDockSubmissionEpochMs,
            loadedDockSubmissionSku,
          }
        : null;

      resetTransientAiUiState();
      setHeldDockSku(preservedBasicInfo?.heldDockSku ?? "");
      setLoadedDockSourceSku(preservedBasicInfo?.loadedDockSourceSku ?? importedSku);
      setLoadedDockSourceTitle(preservedBasicInfo?.loadedDockSourceTitle ?? importedTitle);
      setLoadedDockSubmissionEpochMs(preservedBasicInfo?.loadedDockSubmissionEpochMs);
      setLoadedDockSubmissionSku(preservedBasicInfo?.loadedDockSubmissionSku ?? "");
      setSku(preservedBasicInfo?.sku ?? importedSku);
      const csvMpn = String(formData.gpsMpn ?? "").trim();
      setGpsMpn(preservedBasicInfo?.gpsMpn ?? csvMpn);
      setMpnAttachmentState(preservedBasicInfo?.mpnAttachmentState ?? (csvMpn ? "attached" : "none"));
      setBrand(preservedBasicInfo?.brand ?? String(formData.brand ?? "").trim());
      setPrice(preservedBasicInfo?.price ?? String(formData.price ?? "").trim());
      // Retail Price: use CSV-imported value if available, cache it per SKU
      const csvRetailPrice = String((formData as any).retailPrice ?? "").trim();
      if (csvRetailPrice) {
        setRetailPrice(csvRetailPrice);
        const skuForCache = preservedBasicInfo?.sku ?? String(formData.sku ?? "").trim();
        if (skuForCache) setCachedRetailPrice(skuForCache, csvRetailPrice);
      } else {
        setRetailPrice(getCachedRetailPrice(preservedBasicInfo?.sku ?? String(formData.sku ?? "").trim()));
      }
      setVisibility(preservedBasicInfo?.visibility ?? String(formData.visibility ?? "").trim());
      setTitle(String(formData.title ?? "").trim());
      setChatgptData(String(formData.chatgptData ?? ""));
      setChatgptDescription(String(formData.chatgptDescription ?? ""));
      // Preserve Supplier Datasheet / Website PDFs — they are not part of CSV data
      setSelectedCategories(
        Array.isArray(formData.selectedCategories) ? formData.selectedCategories.filter(Boolean) : [],
      );
      setMainCategory(String(formData.mainCategory ?? "").trim());
      setMainCategorySignal((value) => value + 1);
      setImageUrls(
        Array.isArray(formData.imageUrls) && formData.imageUrls.some((value) => String(value ?? "").trim())
          ? formData.imageUrls.map((value) => String(value ?? ""))
          : [""],
      );
      setSpecValues({ ...(formData.specValues ?? {}) });
      setOtherValues(
        formData.otherValues && Object.keys(formData.otherValues).length > 0 ? { ...formData.otherValues } : {},
      );
      // Preserve Email Notes, Additional Instructions — not part of CSV data
      setErrors({});
      setMandatoryErrors(new Set());
      setConflicts([]);
      setExtractionConflicts([]);
      setFilterProposals([]);
      setFilterSources({});
      setManuallyEditedFilters(new Set());
      setIncludeEditedAiData(false);
      setLastGenerateMode("");
      clearAiTracking();
    },
    [
      brand,
      clearAiTracking,
      gpsMpn,
      heldDockSku,
      loadedDockSourceSku,
      loadedDockSourceTitle,
      loadedDockSubmissionEpochMs,
      loadedDockSubmissionSku,
      mpnAttachmentState,
      price,
      visibility,
      resetTransientAiUiState,
      setMainCategorySignal,
      setWebsitePdfFile,
      setDatasheetFile,
      sku,
    ],
  );

  const buildCurrentFormViewData = useCallback(
    (overrides?: Partial<OutputWorkFormData>): OutputWorkFormData => ({
      sku: overrides?.sku ?? effectiveSku.trim(),
      gpsMpn: overrides?.gpsMpn ?? gpsMpn.trim(),
      brand: overrides?.brand ?? brand.trim(),
      title: overrides?.title ?? title.trim(),
      mainCategory: overrides?.mainCategory ?? mainCategory.trim(),
      selectedCategories: overrides?.selectedCategories ?? [...selectedCategories],
      imageUrls: overrides?.imageUrls ?? [...imageUrls],
      chatgptData: overrides?.chatgptData ?? chatgptData,
      chatgptDescription: overrides?.chatgptDescription ?? chatgptDescription,
      emailNotes: overrides?.emailNotes ?? emailNotes,
      specValues: overrides?.specValues ?? { ...specValues },
      price: overrides?.price ?? price.trim(),
      costPrice: overrides?.costPrice,
    }),
    [
      effectiveSku,
      gpsMpn,
      brand,
      title,
      mainCategory,
      selectedCategories,
      imageUrls,
      chatgptData,
      chatgptDescription,
      emailNotes,
      specValues,
      price,
    ],
  );

  // JSON upload system removed — single-user workflow, no need for bucket persistence

  const clearPendingCsvImportDecision = useCallback(() => {
    pendingCsvImportFileRef.current = null;
    pendingCsvImportResultRef.current = null;
    setPendingCsvImportStatus("");
    setCsvImportBasicInfoMode("fill_sku");
    setCsvImportConfirmOpen(false);
  }, []);

  const finalizeCsvImport = useCallback(
    async (result: ProductCsvImportResult, file: File, basicInfoMode: CsvImportBasicInfoMode) => {
      suppressCsvUploadAutoCollapseRef.current = true;
      csvImportJustAppliedRef.current = true;
      applyImportedCsvFormData(result.formData, { basicInfoMode });
      if (csvImportInputRef.current) csvImportInputRef.current.value = "";
      window.setTimeout(() => {
        const target = document.getElementById("section-basic-info");
        if (!target) return;
        const top = Math.max(target.getBoundingClientRect().top + window.scrollY - 92, 0);
        window.scrollTo({ top, behavior: "smooth" });
      }, 20);

      const nextCsvImportState: StoredCsvImportState = {
        sourceFilename: file.name,
        importedAt: new Date().toISOString(),
        sku: result.formData.sku || "",
        cachedFormData: {
          sku: result.formData.sku || "",
          gpsMpn: result.formData.gpsMpn || "",
          brand: result.formData.brand || "",
          title: result.formData.title || "",
          mainCategory: result.formData.mainCategory || "",
          selectedCategories: [...(result.formData.selectedCategories ?? [])],
          imageUrls: [...(result.formData.imageUrls ?? [])],
          chatgptData: result.formData.chatgptData || "",
          chatgptDescription: result.formData.chatgptDescription || "",
          emailNotes: result.formData.emailNotes || "",
          specValues: { ...(result.formData.specValues ?? {}) },
          price: result.formData.price || "",
          visibility: String(result.formData.visibility ?? "").trim(),
        } as OutputWorkFormData & { visibility?: string },
        cachedJsonPayload: result.jsonPayload,
      };
      setLastCsvImportState(nextCsvImportState);
      writeLocalObject(LAST_CSV_IMPORT_JSON_KEY, nextCsvImportState);
      setCsvUploadCloseSignal((value) => value + 1);
      toast({
        title: "CSV imported",
        description:
          basicInfoMode === "template"
            ? `CSV imported for ${result.formData.sku || "product"}. Current Basic Info was kept.`
            : `Form populated for ${result.formData.sku || "product"}.`,
      });
    },
    [applyImportedCsvFormData, toast],
  );

  const importCsvFile = useCallback(
    async (file: File) => {
      const csvValidationError = await validateCsvUploadFile(file);
      if (csvValidationError) {
        toast({
          variant: "destructive",
          title: "Bad CSV file",
          description: csvValidationError,
        });
        if (csvImportInputRef.current) csvImportInputRef.current.value = "";
        return;
      }

      setIsImportingCsv(true);
      try {
        const csvText = await file.text();
        let result: ProductCsvImportResult;
        try {
          result = parseProductCsvImport(csvText, {
            filename: file.name,
            properties: csvImportProperties,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isCsvImportMetadataLoadingError(message)) {
            throw error;
          }
          result = parseProductCsvImport(csvText, {
            filename: file.name,
            properties: defaultProperties,
          });
        }

        const validationIssues = getCsvImportValidationIssues(result);
        if (validationIssues.missingFields.length > 0) {
          throw new Error(`CSV required fields missing: ${validationIssues.missingFields.join(", ")}`);
        }
        if (validationIssues.invalidFields.length > 0) {
          throw new Error(`CSV contains invalid values: ${validationIssues.invalidFields.join("; ")}`);
        }

        const importedSku = String(result.formData.sku ?? "").trim();
        const { status } = importedSku
          ? await withProductStepTimeout(
              checkSkuStatusFresh(importedSku).catch(() => ({ status: "" })),
              CSV_IMPORT_SKU_STATUS_TIMEOUT_MS,
              "CSV SKU status check",
            ).catch(() => ({ status: "" }))
          : { status: "" };
        const normalizedStatus = normalizeCsvImportSkuStatus(status);
        const statusLabel =
          normalizedStatus === "NOT_FOR_SALE"
            ? "NOT FOR SALE"
            : normalizedStatus === "COMPLETE"
              ? "COMPLETE"
              : normalizedStatus === "TO_DO"
                ? "TO DO"
                : "";

        // Store parsed result for the dialog
        pendingCsvImportFileRef.current = file;
        pendingCsvImportResultRef.current = result;
        setPendingCsvImportStatus(statusLabel);

        const needsStatusChoice = normalizedStatus === "COMPLETE" || normalizedStatus === "NOT_FOR_SALE";
        const defaultImportMode: CsvImportBasicInfoMode = needsStatusChoice ? "template" : "fill_sku";

        if (hasMeaningfulFormContent() || needsStatusChoice) {
          setCsvImportBasicInfoMode(defaultImportMode);
          setCsvImportConfirmOpen(true);
          if (csvImportInputRef.current) csvImportInputRef.current.value = "";
          setIsImportingCsv(false);
          return;
        }

        if (normalizedStatus === "TO_DO") {
          toast({
            title: "CSV imported",
            description: `SKU ${importedSku} is marked as TO DO — imported successfully.`,
          });
        }

        await finalizeCsvImport(result, file, "fill_sku");
      } catch (error) {
        const details = mapCsvImportErrorMessage(error instanceof Error ? error.message : String(error));
        toast({ variant: "destructive", title: details.title, description: details.description });
      } finally {
        setIsImportingCsv(false);
      }
    },
    [
      checkSkuStatusFresh,
      csvImportProperties,
      finalizeCsvImport,
      hasMeaningfulFormContent,
      normalizeCsvImportSkuStatus,
      toast,
    ],
  );

  const handleCsvImport = useCallback(
    async (file: File) => {
      await importCsvFile(file);
    },
    [importCsvFile],
  );

  const handleCsvImportDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setCsvImportDragOver(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        void handleCsvImport(file);
      }
    },
    [handleCsvImport],
  );

  const buildCurrentProductPayload = useCallback(
    (options?: {
      timestamp?: string;
      isOverwrite?: boolean;
      duplicateTitleConfirmed?: boolean;
      loadedDockSubmissionEpochMs?: number;
      loadedDockSubmissionSku?: string;
      gpsMpnOverride?: string;
    }): ProductPayload => {
      const otherPaths = selectedCategories.filter((p) => p !== mainCategory);

      let customFields: string | undefined;
      if (hasActiveFilters) {
        const filterContext = getFilterContext();
        const visibleKeys = new Set<string>();
        if (filterContext) {
          for (const f of filterContext.filters) {
            const matched = properties.filter((p) => {
              const pName = p.name.replace(/\s*\([^)]*\)\s*$/, "").trim();
              return (
                pName === f.name || pName.replace(/\s*#\d+\s*$/, "").trim() === f.name.replace(/\s*#\d+\s*$/, "").trim()
              );
            });
            for (const m of matched) visibleKeys.add(m.key);
          }
        }

        const stripTrailingUnit = (val: string): string => {
          const units = [
            "mm",
            "cm",
            "m",
            "kg",
            "g",
            "lb",
            "lbs",
            "°",
            "deg",
            "V",
            "W",
            "A",
            "lm",
            "K",
            "hr",
            "hrs",
            "h",
          ];
          let cleaned = val.trim();
          for (const u of units) {
            if (cleaned.length > u.length && cleaned.toLowerCase().endsWith(u.toLowerCase())) {
              const before = cleaned.slice(0, -u.length);
              if (/\d$/.test(before.trim())) {
                cleaned = before.trim();
                break;
              }
            }
          }
          return cleaned;
        };

        const customFieldsParts: string[] = [];
        const includedKeys = new Set<string>();
        for (const prop of properties) {
          if (visibleKeys.size > 0 && !visibleKeys.has(prop.key)) continue;
          const value = specValues[prop.key]?.trim();
          if (!value) continue;
          const displayName = prop.name
            .replace(/\s*#\d+\s*$/, "")
            .replace(/\s*\([^)]*\)\s*$/, "")
            .trim();
          customFieldsParts.push(
            `${displayName}=${formatDimensionFilterValueForCsv(displayName, stripTrailingUnit(value))}`,
          );
          includedKeys.add(prop.key);
        }
        for (const [key, value] of Object.entries(specValues)) {
          if (!value?.trim() || includedKeys.has(key)) continue;
          if (properties.some((p) => p.key === key)) continue;
          customFieldsParts.push(`${key}=${formatDimensionFilterValueForCsv(key, stripTrailingUnit(value.trim()))}`);
        }
        customFields = customFieldsParts.length > 0 ? customFieldsParts.join(";") : undefined;
      }

      const isOverwrite = options?.isOverwrite === true;
      const submittedLoadedDockSubmissionEpochMs = Number(options?.loadedDockSubmissionEpochMs);
      const submittedLoadedDockSubmissionSku = String(options?.loadedDockSubmissionSku ?? "").trim();

      return {
        ...ensureSubmitRequestId({ requestId: undefined }),
        sku: effectiveSku,
        mpnDraftId,
        gpsMpn:
          String(options?.gpsMpnOverride ?? (mpnAttachmentState === "attached" ? gpsMpn : "")).trim() || undefined,
        brand,
        title: title.trim(),
        mainCategory,
        additionalCategories: otherPaths,
        imageUrls: imageUrls.map((u) => u.trim()).filter(Boolean),
        specifications: specValues,
        chatgptData: chatgptData.trim() || undefined,
        chatgptDescription: chatgptDescription.trim() || undefined,
        emailNotes: emailNotes.trim() || undefined,
        datasheetUrl: datasheetUrl.trim() || undefined,
        webpageUrl: webpageUrl.trim() || undefined,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        customFields,
        price: price.trim() || undefined,
        retailPrice: retailPrice.trim() || getCachedRetailPrice(effectiveSku) || undefined,
        isOverwrite,
        duplicateTitleConfirmed: options?.duplicateTitleConfirmed,
        loadedDockSubmissionEpochMs:
          isOverwrite &&
          Number.isFinite(submittedLoadedDockSubmissionEpochMs) &&
          submittedLoadedDockSubmissionEpochMs > 0 &&
          effectiveSku.trim().toUpperCase() === submittedLoadedDockSubmissionSku.toUpperCase()
            ? submittedLoadedDockSubmissionEpochMs
            : undefined,
      };
    },
    [
      selectedCategories,
      mainCategory,
      hasActiveFilters,
      getFilterContext,
      properties,
      specValues,
      effectiveSku,
      gpsMpn,
      mpnDraftId,
      mpnAttachmentState,
      brand,
      title,
      imageUrls,
      chatgptData,
      chatgptDescription,
      emailNotes,
      datasheetUrl,
      webpageUrl,
      price,
      retailPrice,
    ],
  );

  const handleViewCurrentForm = useCallback(async () => {
    // Ensure we have the latest MPN before showing the preview
    let currentMpn = gpsMpn;
    if (!currentMpn.trim() && effectiveSku.trim()) {
      try {
        const freshMpn = await peekNextMpnDirect();
        if (freshMpn) {
          currentMpn = freshMpn;
          setGpsMpn(freshMpn);
        }
      } catch {
        /* silent */
      }
    }
    const formData = buildCurrentFormViewData({ gpsMpn: currentMpn });
    setProductViewData(formData);
    setProductViewOpen(true);
  }, [buildCurrentFormViewData, gpsMpn, effectiveSku]);

  const markSkuCompleteWithVerification = useCallback(
    async (
      sku: string,
    ): Promise<{ success: boolean; alreadyState: boolean; verifiedAfterProcessing: boolean; error?: string }> => {
      const normalizedSku = String(sku ?? "").trim();
      if (!normalizedSku) {
        return { success: false, alreadyState: false, verifiedAfterProcessing: false, error: "SKU is required." };
      }

      const dockEntries = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? [];
      let baseError = "";

      try {
        const result = await markSkuComplete(normalizedSku, dockEntries.length);
        if (result.success) {
          return {
            success: true,
            alreadyState: Boolean(result.alreadyState),
            verifiedAfterProcessing: false,
          };
        }
        baseError = String(result.error ?? "").trim();
      } catch (error) {
        baseError = error instanceof Error ? error.message : String(error ?? "");
      }

      // The backend can report before Processed_At finalizes; poll fresh SKU status to avoid false negatives.
      const pollAttempts = 7;
      const pollDelayMs = 1200;
      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
        const fresh = await checkSkuStatusFresh(normalizedSku).catch(() => ({ status: "", recentSubmit: false }));
        if (normalizeCsvImportSkuStatus(fresh.status) === "COMPLETE") {
          return { success: true, alreadyState: false, verifiedAfterProcessing: true };
        }
      }

      return {
        success: false,
        alreadyState: false,
        verifiedAfterProcessing: false,
        error: baseError || `${normalizedSku} could not be marked COMPLETE.`,
      };
    },
    [checkSkuStatusFresh, markSkuComplete, normalizeCsvImportSkuStatus, queryClient],
  );

  const syncOtherLegalValues = useCallback(async (): Promise<number> => {
    const written = new Set<string>();
    for (const [propertyName, value] of Object.entries(otherValues)) {
      const trimmedValue = value.trim();
      if (!trimmedValue || written.has(`${propertyName}:${trimmedValue}`)) continue;

      await addLegalValue(propertyName, trimmedValue);
      written.add(`${propertyName}:${trimmedValue}`);

      const hashIdx = propertyName.lastIndexOf("#");
      if (hashIdx <= 0) continue;

      const base = propertyName.substring(0, hashIdx).trim();
      const allPropNames = properties.map((p) => p.name);
      for (const sibling of allPropNames) {
        if (
          sibling !== propertyName &&
          sibling.lastIndexOf("#") > 0 &&
          sibling.substring(0, sibling.lastIndexOf("#")).trim() === base &&
          !written.has(`${sibling}:${trimmedValue}`)
        ) {
          await addLegalValue(sibling, trimmedValue);
          written.add(`${sibling}:${trimmedValue}`);
        }
      }
    }

    if (written.size > 0) {
      void queryClient.invalidateQueries({ queryKey: ["properties"] });
    }

    return written.size;
  }, [addLegalValue, otherValues, properties, queryClient]);

  const listPendingCompleteRecoveryEntries = useCallback((): PendingCompleteRecoveryEntry[] => {
    const now = Date.now();
    const raw = readLocalObject<unknown[]>(pendingCompleteRecoveryStorageKey);
    if (!Array.isArray(raw)) return [];

    return raw
      .map((entry): PendingCompleteRecoveryEntry | null => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const candidate = entry as Record<string, unknown>;
        const sku = String(candidate.sku ?? "").trim();
        const source = candidate.source === "download" ? "download" : "send_by_email";
        const createdAt = Number(candidate.createdAt);
        const lastAttemptAt = Number(candidate.lastAttemptAt);
        const attemptCount = Number(candidate.attemptCount);
        const expiresAt = Number(candidate.expiresAt);
        if (!sku) return null;
        if (!Number.isFinite(createdAt) || !Number.isFinite(lastAttemptAt) || !Number.isFinite(expiresAt)) {
          return null;
        }
        if (expiresAt <= now) return null;
        return {
          sku,
          source,
          createdAt,
          lastAttemptAt,
          attemptCount: Number.isFinite(attemptCount) ? Math.max(1, Math.floor(attemptCount)) : 1,
          expiresAt,
        };
      })
      .filter((entry): entry is PendingCompleteRecoveryEntry => Boolean(entry));
  }, [pendingCompleteRecoveryStorageKey]);

  const writePendingCompleteRecoveryEntries = useCallback(
    (entries: PendingCompleteRecoveryEntry[]) => {
      if (entries.length === 0) {
        clearLocalObject(pendingCompleteRecoveryStorageKey);
        return;
      }
      writeLocalObject(pendingCompleteRecoveryStorageKey, entries);
    },
    [pendingCompleteRecoveryStorageKey],
  );

  const upsertPendingCompleteRecoveryEntry = useCallback(
    (sku: string, source: PendingCompleteRecoverySource) => {
      const trimmedSku = String(sku ?? "").trim();
      if (!trimmedSku) return;
      const now = Date.now();
      const entries = listPendingCompleteRecoveryEntries();
      const bySku = new Map(entries.map((entry) => [entry.sku.trim().toUpperCase(), entry]));
      bySku.set(trimmedSku.toUpperCase(), {
        sku: trimmedSku,
        source,
        createdAt: now,
        lastAttemptAt: 0,
        attemptCount: 1,
        expiresAt: now + PENDING_COMPLETE_RECOVERY_TTL_MS,
      });
      writePendingCompleteRecoveryEntries(Array.from(bySku.values()));
    },
    [listPendingCompleteRecoveryEntries, writePendingCompleteRecoveryEntries],
  );

  const removePendingCompleteRecoveryEntry = useCallback(
    (sku: string) => {
      const normalizedSku = String(sku ?? "").trim().toUpperCase();
      if (!normalizedSku) return;
      const entries = listPendingCompleteRecoveryEntries().filter(
        (entry) => entry.sku.trim().toUpperCase() !== normalizedSku,
      );
      writePendingCompleteRecoveryEntries(entries);
    },
    [listPendingCompleteRecoveryEntries, writePendingCompleteRecoveryEntries],
  );

  const runPendingCompleteRecoveries = useCallback(async () => {
    if (pendingCompleteRecoverySweepInFlightRef.current) return;
    pendingCompleteRecoverySweepInFlightRef.current = true;

    try {
      const now = Date.now();
      const entries = listPendingCompleteRecoveryEntries();
      if (entries.length === 0) return;

      const next: PendingCompleteRecoveryEntry[] = [];
      let didCompleteAny = false;

      for (const entry of entries) {
        const normalizedSku = entry.sku.trim().toUpperCase();
        const shouldRetry =
          now - entry.lastAttemptAt >= PENDING_COMPLETE_RECOVERY_RETRY_INTERVAL_MS &&
          entry.attemptCount <= PENDING_COMPLETE_RECOVERY_MAX_ATTEMPTS;

        if (!shouldRetry) {
          next.push(entry);
          continue;
        }

        const result = await markSkuCompleteWithVerification(entry.sku);
        if (result.success) {
          didCompleteAny = true;
          continue;
        }

        const nextAttemptCount = entry.attemptCount + 1;
        if (nextAttemptCount > PENDING_COMPLETE_RECOVERY_MAX_ATTEMPTS) {
          console.warn(
            `Mark COMPLETE recovery abandoned for ${entry.sku} after ${PENDING_COMPLETE_RECOVERY_MAX_ATTEMPTS} attempts.`,
          );
          continue;
        }

        next.push({
          ...entry,
          attemptCount: nextAttemptCount,
          lastAttemptAt: now,
        });
      }

      writePendingCompleteRecoveryEntries(next);
      if (didCompleteAny) {
        await syncGoogleSheetQueries(queryClient, { includeDock: true });
      }
    } catch (error) {
      console.warn("Pending COMPLETE recovery sweep failed:", error);
    } finally {
      pendingCompleteRecoverySweepInFlightRef.current = false;
    }
  }, [listPendingCompleteRecoveryEntries, markSkuCompleteWithVerification, queryClient, writePendingCompleteRecoveryEntries]);

  useEffect(() => {
    void runPendingCompleteRecoveries();
    const id = setInterval(() => {
      void runPendingCompleteRecoveries();
    }, PENDING_COMPLETE_RECOVERY_RETRY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runPendingCompleteRecoveries]);

  const persistAiLogBrowserState = useCallback(() => {
    const next: AiLogBrowserState = {};
    for (const [sku, signature] of aiLogLastSignatureBySkuRef.current.entries()) {
      const rowNumber = aiLogRowNumberBySkuRef.current.get(sku);
      next[sku] = {
        lastSignature: signature,
        rowNumber: Number.isFinite(Number(rowNumber)) && Number(rowNumber) > 1 ? Number(rowNumber) : undefined,
      };
    }
    writeLocalObject(AI_LOG_BROWSER_STATE_KEY, next);
  }, []);

  useEffect(() => {
    const stored = readLocalObject<AiLogBrowserState>(AI_LOG_BROWSER_STATE_KEY);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;

    for (const [sku, state] of Object.entries(stored)) {
      const normalizedSku = String(sku ?? "").trim().toUpperCase();
      if (!normalizedSku || !state || typeof state !== "object" || Array.isArray(state)) continue;

      const lastSignature = typeof state.lastSignature === "string" ? state.lastSignature : "";
      const rowNumber = Number(state.rowNumber);
      if (lastSignature) {
        aiLogLastSignatureBySkuRef.current.set(normalizedSku, lastSignature);
      }
      if (Number.isFinite(rowNumber) && rowNumber > 1) {
        aiLogRowNumberBySkuRef.current.set(normalizedSku, rowNumber);
      }
    }
  }, []);

  const handleSendByEmail = useCallback(async () => {
    if (sendByEmailInFlightRef.current || isSendingByEmail || sendByEmailCooldown > 0) {
      return;
    }

    const { valid, missingFields, missingFilterFields, firstErrorSection, firstErrorTargetId } = validateForm();
    if (!valid) {
      const hasMissingFilters = missingFilterFields.length > 0;
      const nonFilterMissingFields = missingFields.filter((field) => !missingFilterFields.includes(field));
      const imageIssues = nonFilterMissingFields.filter((f) => /image/i.test(f));
      const otherIssues = nonFilterMissingFields.filter((f) => !/image/i.test(f));
      const lines: React.ReactNode[] = [];
      if (hasMissingFilters) lines.push(<div key="filters">Filters: {missingFilterFields.join(", ")}</div>);
      if (otherIssues.length > 0) lines.push(<div key="required">Required: {otherIssues.join(", ")}</div>);
      if (imageIssues.length > 0) lines.push(<div key="images">Images: {imageIssues.join("; ")}</div>);

      toast({
        variant: "destructive",
        title: `Cannot send email — ${missingFields.length} issue${missingFields.length !== 1 ? "s" : ""} found`,
        duration: 12000,
        description: <div className="flex flex-col gap-1 mt-1">{lines}</div>,
      });

      if (hasAiDataBlockingIssue) {
        focusAiDataSection({ focus: true });
      }

      if (firstErrorTargetId) {
        window.setTimeout(() => {
          const el = document.getElementById(firstErrorTargetId);
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
            el.focus();
          }
        }, 80);
      } else if (firstErrorSection) {
        document
          .getElementById(`section-${firstErrorSection}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }

    if (hasAiDataBlockingIssue) {
      toast({
        variant: "destructive",
        title: "Email blocked",
        description: aiDataBlockingMessage,
      });
      focusAiDataSection({ focus: true });
      return;
    }

    sendByEmailInFlightRef.current = true;
    setIsSendingByEmail(true);
    try {
      const payload = buildCurrentProductPayload({
        timestamp: new Date().toISOString(),
      });
      const result = await withProductStepTimeout(
        sendProductByEmail(payload),
        FORM_SEND_ACTION_TIMEOUT_MS,
        "Send By Email",
      );
      if (!result.success) {
        throw new Error(result.error || "Could not send email.");
      }

      const resolvedMpn = String(result.mpn ?? "").trim();
      if (resolvedMpn) {
        setGpsMpn(resolvedMpn);
        setMpnAttachmentState("attached");
      }
      // Cache the resolved retail price for this SKU
      const resolvedRetailPrice = String(result.retailPrice ?? "").trim();
      if (resolvedRetailPrice && payload.sku) {
        setRetailPrice(resolvedRetailPrice);
        setCachedRetailPrice(payload.sku, resolvedRetailPrice);
      }

      const sendDescription = resolvedMpn
        ? result.warningMessage
          ? `Sent. The previous MPN was already claimed — MPN ${resolvedMpn}-L has been attached to ${payload.sku}.`
          : `Sent. MPN ${resolvedMpn}-L attached to ${payload.sku}.`
        : `Sent. Email queued for ${payload.sku}.`;

      upsertPendingCompleteRecoveryEntry(payload.sku, "send_by_email");
      void syncOtherLegalValues().catch((legalValueError) => {
        console.warn("Non-blocking legal-value sync error:", legalValueError);
      });
      writeCurrentAiLogForSku(payload.sku);

      toast({
        title: "Sent By Email",
        description: `${sendDescription} Marking COMPLETE in background...`,
      });

      void (async () => {
        try {
          const completeResult = await markSkuCompleteWithVerification(payload.sku);
          if (!completeResult.success) {
            toast({
              variant: "destructive",
              title: "Email sent, but not marked COMPLETE",
              description: completeResult.error
                ? `Could not mark ${payload.sku} as COMPLETE: ${completeResult.error}`
                : `Could not mark ${payload.sku} as COMPLETE.`,
            });
          } else {
            removePendingCompleteRecoveryEntry(payload.sku);
            await syncGoogleSheetQueries(queryClient, { includeDock: true });
          }
        } catch (error) {
          toast({
            variant: "destructive",
            title: "Email sent, but not marked COMPLETE",
            description: error instanceof Error ? error.message : "The status sync failed.",
          });
        }
      })();

      setSendByEmailCooldown(FORM_ACTION_COOLDOWN_SECONDS);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The email send failed.";
      toast({
        variant: "destructive",
        title: "Could not send email",
        description: message,
      });
    } finally {
      sendByEmailInFlightRef.current = false;
      setIsSendingByEmail(false);
    }
  }, [
    validateForm,
    toast,
    hasAiDataBlockingIssue,
    aiDataBlockingMessage,
    focusAiDataSection,
    buildCurrentProductPayload,
    markSkuCompleteWithVerification,
    markSkuComplete,
    queryClient,
    sendProductByEmail,
    syncOtherLegalValues,
    upsertPendingCompleteRecoveryEntry,
    removePendingCompleteRecoveryEntry,
    writeCurrentAiLogForSku,
    isSendingByEmail,
    sendByEmailCooldown,
  ]);

  const handleDownloadCurrentForm = useCallback(async () => {
    if (downloadCurrentFormInFlightRef.current || downloadActionCooldown > 0) {
      return;
    }

    const { valid, missingFields, missingFilterFields, firstErrorSection, firstErrorTargetId } = validateForm();
    if (!valid) {
      setDownloadConfirmOpen(false);
      const hasMissingFilters = missingFilterFields.length > 0;
      const nonFilterMissingFields = missingFields.filter((field) => !missingFilterFields.includes(field));
      const imageIssues = nonFilterMissingFields.filter((f) => /image/i.test(f));
      const otherIssues = nonFilterMissingFields.filter((f) => !/image/i.test(f));
      const lines: React.ReactNode[] = [];
      if (hasMissingFilters) lines.push(<div key="filters">Filters: {missingFilterFields.join(", ")}</div>);
      if (otherIssues.length > 0) lines.push(<div key="required">Required: {otherIssues.join(", ")}</div>);
      if (imageIssues.length > 0) lines.push(<div key="images">Images: {imageIssues.join("; ")}</div>);

      toast({
        variant: "destructive",
        title: `Cannot download CSV — ${missingFields.length} issue${missingFields.length !== 1 ? "s" : ""} found`,
        duration: 12000,
        description: <div className="flex flex-col gap-1 mt-1">{lines}</div>,
      });

      if (hasAiDataBlockingIssue) {
        focusAiDataSection({ focus: true });
      }

      if (firstErrorTargetId) {
        window.setTimeout(() => {
          const el = document.getElementById(firstErrorTargetId);
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
            el.focus();
          }
        }, 80);
      } else if (firstErrorSection) {
        document
          .getElementById(`section-${firstErrorSection}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }

    if (hasAiDataBlockingIssue) {
      setDownloadConfirmOpen(false);
      toast({
        variant: "destructive",
        title: "Download blocked",
        description: aiDataBlockingMessage,
      });
      focusAiDataSection({ focus: true });
      return;
    }

    downloadCurrentFormInFlightRef.current = true;
    setIsDownloadingFormCsv(true);

    try {
      const payload = buildCurrentProductPayload({
        timestamp: new Date().toISOString(),
      });
      const result = await withProductStepTimeout(
        downloadProductCsv(payload),
        FORM_DOWNLOAD_ACTION_TIMEOUT_MS,
        "Download CSV",
      );
      if (!result.success || !result.csvText) {
        throw new Error(result.error || "Could not build the CSV download.");
      }

      const resolvedMpn = String(result.mpn ?? "").trim();
      if (resolvedMpn) {
        setGpsMpn(resolvedMpn);
        setMpnAttachmentState("attached");
      }
      // Cache the resolved retail price for this SKU
      const resolvedRetailPrice = String(result.retailPrice ?? "").trim();
      if (resolvedRetailPrice && payload.sku) {
        setRetailPrice(resolvedRetailPrice);
        setCachedRetailPrice(payload.sku, resolvedRetailPrice);
      }
      const mpnChangedDuringReservation = Boolean(result.warningMessage);

      const blob = new Blob([result.csvText], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = String(result.filename || `${payload.sku}.csv`).trim() || `${payload.sku}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setDownloadConfirmOpen(false);
      setIsDownloadingFormCsv(false);

      const mpnNote = resolvedMpn
        ? mpnChangedDuringReservation
          ? `The previous MPN was already claimed — MPN ${resolvedMpn}-L has been attached to ${payload.sku}.`
          : `MPN ${resolvedMpn}-L attached to ${payload.sku}.`
        : `MPN attached to ${payload.sku}.`;

      upsertPendingCompleteRecoveryEntry(payload.sku, "download");
      void syncOtherLegalValues().catch((legalValueError) => {
        console.warn("Non-blocking legal-value sync error:", legalValueError);
      });
      writeCurrentAiLogForSku(payload.sku);

      toast({
        title: "Downloaded",
        description: `${mpnNote} Marking COMPLETE in background...`.trim(),
      });

      void (async () => {
        try {
          const completeResult = await markSkuCompleteWithVerification(payload.sku);
          if (!completeResult.success) {
            toast({
              variant: "destructive",
              title: "Could not mark COMPLETE",
              description: completeResult.error || `${payload.sku} could not be marked COMPLETE after download.`,
            });
          } else {
            removePendingCompleteRecoveryEntry(payload.sku);
            await syncGoogleSheetQueries(queryClient, { includeDock: true });
          }
        } catch (error) {
          toast({
            variant: "destructive",
            title: "Could not mark COMPLETE",
            description: error instanceof Error ? error.message : "The status sync failed.",
          });
        }
      })();

      setDownloadActionCooldown(FORM_ACTION_COOLDOWN_SECONDS);
    } catch (error) {
      setDownloadConfirmOpen(false);
      toast({
        variant: "destructive",
        title: "Could not download CSV",
        description: error instanceof Error ? error.message : "The CSV download failed.",
      });
    } finally {
      downloadCurrentFormInFlightRef.current = false;
      setIsDownloadingFormCsv(false);
    }
  }, [
    validateForm,
    toast,
    hasAiDataBlockingIssue,
    aiDataBlockingMessage,
    focusAiDataSection,
    buildCurrentProductPayload,
    markSkuCompleteWithVerification,
    queryClient,
    syncOtherLegalValues,
    upsertPendingCompleteRecoveryEntry,
    removePendingCompleteRecoveryEntry,
    writeCurrentAiLogForSku,
    downloadActionCooldown,
  ]);

  const clearCsvImportStateLocally = useCallback(() => {
    setLastCsvImportState(null);
    clearLocalObject(LAST_CSV_IMPORT_JSON_KEY);
    setCsvImportConfirmOpen(false);
    pendingCsvImportFileRef.current = null;
    if (csvImportInputRef.current) csvImportInputRef.current.value = "";
  }, []);

  // Auto-clear CSV indicator when any CSV-populated field is manually edited
  const csvFieldsSignature = useMemo(
    () =>
      JSON.stringify([title, chatgptData, chatgptDescription, mainCategory, selectedCategories, imageUrls, specValues]),
    [title, chatgptData, chatgptDescription, mainCategory, selectedCategories, imageUrls, specValues],
  );
  useEffect(() => {
    if (!lastCsvImportState) return;
    if (csvImportJustAppliedRef.current) {
      csvImportJustAppliedRef.current = false;
      return;
    }
    clearCsvImportStateLocally();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvFieldsSignature]);

  const handleClearCsvImport = useCallback(() => {
    clearCsvImportStateLocally();
    toast({
      title: "CSV cleared",
      description: "The uploaded CSV snapshot was cleared. Your form values were left unchanged.",
    });
  }, [clearCsvImportStateLocally, toast]);

  const handleCsvPreviewLoad = useCallback(
    async (file: File) => {
      const csvValidationError = await validateCsvUploadFile(file);
      if (csvValidationError) {
        toast({
          variant: "destructive",
          title: "Bad CSV file",
          description: csvValidationError,
        });
        if (csvPreviewInputRef.current) csvPreviewInputRef.current.value = "";
        return;
      }

      setCsvPreviewLoading(true);
      try {
        const csvText = await file.text();
        const result = parseProductCsvImport(csvText, { filename: file.name, properties: csvImportProperties });

        setCsvPreviewFile(file);
        setCsvPreviewSnapshot(result.jsonPayload);
      } catch (e) {
        const details = mapCsvImportErrorMessage(e instanceof Error ? e.message : String(e));
        toast({ variant: "destructive", title: details.title, description: details.description });
      } finally {
        setCsvPreviewLoading(false);
        if (csvPreviewInputRef.current) csvPreviewInputRef.current.value = "";
      }
    },
    [csvImportProperties, toast],
  );

  const handleDatasheetPdfSelect = useCallback(
    async (file: File) => {
      const pdfValidationError = await validatePdfUploadFile(file);
      if (pdfValidationError) {
        toast({
          variant: "destructive",
          title: "Bad PDF file",
          description: `Supplier Datasheet: ${pdfValidationError}`,
        });
        if (datasheetInputRef.current) datasheetInputRef.current.value = "";
        return;
      }

      setDatasheetFile(file);
      setDatasheetUrl(file.name);
    },
    [setDatasheetFile, toast],
  );

  const handleWebsitePdfSelect = useCallback(
    async (file: File) => {
      const pdfValidationError = await validatePdfUploadFile(file);
      if (pdfValidationError) {
        toast({
          variant: "destructive",
          title: "Bad PDF file",
          description: `Supplier Website: ${pdfValidationError}`,
        });
        if (websiteInputRef.current) websiteInputRef.current.value = "";
        return;
      }

      setWebsitePdfFile(file);
      setWebpageUrl(file.name);
    },
    [setWebsitePdfFile, toast],
  );

  const clearBasicInfo = () => {
    setHeldDockSku("");
    setLoadedDockSubmissionEpochMs(undefined);
    setLoadedDockSubmissionSku("");
    setLoadedDockSourceSku("");
    setLoadedDockSourceTitle("");
    setSku("");
    setGpsMpn("");
    setMpnAttachmentState("none");
    setBrand("");
    setPrice("");
    setVisibility("");
    setErrors((prev) => {
      if (!prev.sku && !prev.price) return prev;
      const next = { ...prev };
      delete next.sku;
      delete next.price;
      return next;
    });
  };

  const handleClearInput = useCallback(() => {
    if (!clearConfirm) {
      setClearConfirm(true);
      return;
    }
    const csvSnapshotToClear = lastCsvImportState;
    resetForm();
    setMpnDraftId(createMpnDraftId());
    clearCsvImportStateLocally();
    setClearConfirm(false);
    toast({ title: "Cleared", description: "All input fields have been cleared." });
  }, [clearConfirm, clearCsvImportStateLocally, lastCsvImportState, toast]);

  const OPTIMISTIC_MIN_VISIBLE_MS = 3_000;
  const optimisticSubmitContextRef = useRef<{
    sku: string;
    submittedAt: string;
    submittedAtEpochMs: number;
  } | null>(null);
  const optimisticSubmitStartedAtRef = useRef(0);

  const upsertOptimisticSubmit = useCallback(
    (
      rawSku: string,
      isOverwrite: boolean,
      submissionIdentity?: { submittedAt?: string; submittedAtEpochMs?: number },
    ) => {
      const sku = rawSku.trim();
      if (!sku) return null;
      const normalizedSku = sku.toUpperCase();

      const existing =
        optimisticSubmitContextRef.current &&
        optimisticSubmitContextRef.current.sku.trim().toUpperCase() === normalizedSku
          ? optimisticSubmitContextRef.current
          : null;

      const submittedAtEpochMs =
        Number.isFinite(Number(submissionIdentity?.submittedAtEpochMs)) &&
        Number(submissionIdentity?.submittedAtEpochMs) > 0
          ? Number(submissionIdentity?.submittedAtEpochMs)
          : (existing?.submittedAtEpochMs ?? Date.now());
      const submittedAt =
        submissionIdentity?.submittedAt?.trim() || existing?.submittedAt || new Date(submittedAtEpochMs).toISOString();

      if (!existing || existing.submittedAtEpochMs !== submittedAtEpochMs || existing.submittedAt !== submittedAt) {
        optimisticSubmitContextRef.current = { sku, submittedAt, submittedAtEpochMs };
        optimisticSubmitStartedAtRef.current = Date.now();
      }

      persistPendingDockSubmit({ sku, submittedAt, submittedAtEpochMs, isOverwrite });

      flushSync(() => {
        queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) => {
          const entry: RecentSubmission = {
            id: `pending-submit-${normalizedSku}-${submittedAtEpochMs}`,
            sku,
            submittedAt,
            processedAt: "",
          };
          const list = old ? [...old] : [];
          const withoutSku = list.filter((row) => row.sku.trim().toUpperCase() !== normalizedSku);
          withoutSku.unshift(entry);
          return withoutSku;
        });
      });

      window.dispatchEvent(
        new CustomEvent("optimistic-submit", {
          detail: { sku, submittedAt, submittedAtEpochMs, isOverwrite },
        }),
      );

      return { sku, submittedAt, submittedAtEpochMs };
    },
    [queryClient],
  );

  const rollbackOptimisticSubmit = useCallback(
    async (
      rawSku: string,
      options?: {
        toastTitle?: string;
        toastDescription?: React.ReactNode;
        minVisibleMs?: number;
      },
    ) => {
      const sku = rawSku.trim();
      if (!sku) return;
      const normalizedSku = sku.toUpperCase();

      const startedAt = optimisticSubmitStartedAtRef.current || Date.now();
      const minVisibleMs = options?.minVisibleMs ?? OPTIMISTIC_MIN_VISIBLE_MS;
      const waitMs = Math.max(0, minVisibleMs - (Date.now() - startedAt));
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

      removePendingDockSubmit(sku);

      flushSync(() => {
        queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) => {
          if (!old) return old;
          return old.filter(
            (row) =>
              !(
                row.sku.trim().toUpperCase() === normalizedSku &&
                String((row as any).id ?? "").startsWith("pending-submit-")
              ),
          );
        });
      });

      window.dispatchEvent(
        new CustomEvent("optimistic-submit-cancel", {
          detail: { sku },
        }),
      );

      if (optimisticSubmitContextRef.current?.sku.trim().toUpperCase() === normalizedSku) {
        optimisticSubmitContextRef.current = null;
        optimisticSubmitStartedAtRef.current = 0;
      }

      if (options?.toastTitle) {
        toast({
          variant: "destructive",
          title: options.toastTitle,
          description: options.toastDescription,
          duration: 12000,
        });
      }
    },
    [queryClient, toast],
  );

  const finalizeOptimisticSubmit = useCallback(
    (
      rawSku: string,
      processedAt?: string,
      options?: {
        submittedAt?: string;
        submittedAtEpochMs?: number;
      },
    ) => {
      const sku = rawSku.trim();
      if (!sku) return;
      const normalizedSku = sku.toUpperCase();
      const existing = optimisticSubmitContextRef.current;
      const resolvedSubmittedAtEpochMs =
        Number.isFinite(Number(options?.submittedAtEpochMs)) && Number(options?.submittedAtEpochMs) > 0
          ? Number(options?.submittedAtEpochMs)
          : undefined;
      const submittedAt =
        options?.submittedAt?.trim() ||
        (resolvedSubmittedAtEpochMs ? new Date(resolvedSubmittedAtEpochMs).toISOString() : "") ||
        (existing?.sku.trim().toUpperCase() === normalizedSku ? existing.submittedAt : "") ||
        new Date().toISOString();

      removePendingDockSubmit(sku);

      flushSync(() => {
        queryClient.setQueryData<RecentSubmission[]>(["recent-submissions"], (old) => {
          const list = old ? [...old] : [];
          const withoutSku = list.filter((row) => row.sku.trim().toUpperCase() !== normalizedSku);
          if (!processedAt?.trim()) return withoutSku;
          withoutSku.push({
            id: sku,
            sku,
            submittedAt,
            processedAt,
          });
          return withoutSku;
        });
      });

      window.dispatchEvent(
        new CustomEvent("optimistic-submit-complete", {
          detail: {
            sku,
            processedAt,
            submittedAt,
            submittedAtEpochMs: resolvedSubmittedAtEpochMs,
          },
        }),
      );

      if (existing?.sku.trim().toUpperCase() === normalizedSku) {
        optimisticSubmitContextRef.current = null;
        optimisticSubmitStartedAtRef.current = 0;
      }
    },
    [queryClient],
  );

  function writeCurrentAiLogForSku(rawSku: string, options?: { clearTracking?: boolean }) {
    const trimmedSku = rawSku.trim();
    if (!trimmedSku) return;
    const normalizedSku = trimmedSku.toUpperCase();

    const trackedFilters = getTrackedFilters();
    const trackedFilterKeys = trackedFilters ? extractFilterKeys(trackedFilters) : null;
    const currentFilterString = buildFilterLogString(
      specValues,
      properties,
      trackedFilterKeys ?? undefined,
      Boolean(trackedFilterKeys),
    );

    const logEntry = buildAiLogEntry(trimmedSku, {
      aiData: chatgptData.trim(),
      aiDescription: chatgptDescription.trim(),
      filters: currentFilterString,
      conflicts: aiLogConflictsText,
    });

    if (!logEntry) return;

    const signature = JSON.stringify({
      sku: normalizedSku,
      aiDataGenerated: logEntry.aiData?.generated || "",
      aiDataEdited: logEntry.aiData?.edited || "",
      aiDescriptionGenerated: logEntry.aiDescription?.generated || "",
      aiDescriptionEdited: logEntry.aiDescription?.edited || "",
      filtersGenerated: logEntry.filters?.generated || "",
      filtersEdited: logEntry.filters?.edited || "",
      conflicts: logEntry.conflicts || "",
    });

    if (aiLogInFlightBySkuRef.current.has(normalizedSku)) {
      return;
    }
    const lastSignature = aiLogLastSignatureBySkuRef.current.get(normalizedSku);
    if (lastSignature && lastSignature === signature) return;

    aiLogInFlightBySkuRef.current.add(normalizedSku);
    const previousRowNumber = aiLogRowNumberBySkuRef.current.get(normalizedSku);

    const diffs: Record<string, Array<{ t: string; d: "u" | "a" | "r" }>> = {};
    if (logEntry.aiData) {
      const tokens = computeWordDiff(logEntry.aiData.generated, logEntry.aiData.edited);
      diffs.aiData = serializeDiff(tokens);
    }
    if (logEntry.aiDescription) {
      const tokens = computeWordDiff(logEntry.aiDescription.generated, logEntry.aiDescription.edited);
      diffs.aiDescription = serializeDiff(tokens);
    }
    if (logEntry.filters) {
      const tokens = computeFilterDiff(logEntry.filters.generated, logEntry.filters.edited);
      diffs.filters = serializeDiff(tokens);
    }

    writeAiLogEntry({
      ...logEntry,
      diffs,
      replaceRowNumber:
        Number.isFinite(Number(previousRowNumber)) && Number(previousRowNumber) > 1 ? Number(previousRowNumber) : undefined,
    })
      .then((result) => {
        aiLogInFlightBySkuRef.current.delete(normalizedSku);
        if (!result.success) {
          console.warn("AI logging failed (non-blocking):", result.error || "Unknown error");
          return;
        }
        aiLogLastSignatureBySkuRef.current.set(normalizedSku, signature);
        if (Number.isFinite(Number(result.rowNumber)) && Number(result.rowNumber) > 1) {
          aiLogRowNumberBySkuRef.current.set(normalizedSku, Number(result.rowNumber));
        }
        persistAiLogBrowserState();
      })
      .catch((err) => {
        aiLogInFlightBySkuRef.current.delete(normalizedSku);
        console.warn("AI logging failed (non-blocking):", err);
      });

    if (options?.clearTracking) {
      clearAiTracking();
    }
  }

  const doSubmit = async (isOverwrite = false, duplicateTitleConfirmed = false) => {
    const submittedSku = effectiveSku;
    const submittedHeldDockSku = heldDockSku.trim();
    const submittedBrand = brand;
    const submittedPrice = price;
    const submittedLoadedDockSubmissionEpochMs = loadedDockSubmissionEpochMs;
    const submittedLoadedDockSubmissionSku = loadedDockSubmissionSku.trim();
    const previousDockSnapshot = submittedSku ? getDockFormSnapshot(submittedSku) : null;
    const previousDockSnapshotFiles = submittedSku
      ? (getDockFormSnapshotFiles(submittedSku) ?? { datasheetFile: null, websitePdfFile: null })
      : null;
    const clientSubmittedAtEpochMs = Date.now();
    const clientSubmittedAt = new Date(clientSubmittedAtEpochMs).toISOString();
    let shouldRestorePreviousDockSnapshot = false;
    const restorePreviousDockSnapshot = () => {
      if (!shouldRestorePreviousDockSnapshot || !submittedSku) return;
      shouldRestorePreviousDockSnapshot = false;

      if (!previousDockSnapshot) {
        removeDockFormSnapshot(submittedSku);
        return;
      }

      const {
        savedAtEpochMs: _savedAtEpochMs,
        fingerprint: _fingerprint,
        ...snapshotDraftToRestore
      } = previousDockSnapshot;
      upsertDockFormSnapshot(
        snapshotDraftToRestore,
        previousDockSnapshotFiles ?? { datasheetFile: null, websitePdfFile: null },
      );
    };
    setIsSubmitting(true);

    // Ensure the ghost row is present before any async work.
    upsertOptimisticSubmit(submittedSku, isOverwrite, {
      submittedAt: clientSubmittedAt,
      submittedAtEpochMs: clientSubmittedAtEpochMs,
    });

    toast({
      title: isOverwrite ? "Overriding in Loading Dock" : "Sent to Loading Dock",
      description: `${submittedSku} is being processed.`,
      duration: 4000,
    });

    try {
      if (hasAiDataBlockingIssue) {
        await rollbackOptimisticSubmit(submittedSku, {
          toastTitle: "Submit blocked",
          toastDescription: aiDataBlockingMessage,
        });
        return;
      }

      // Get dock count from query cache for dynamic cooldown
      const dockEntries = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? [];
      const dockCount = dockEntries.length;
      const payload: ProductPayload = {
        ...buildCurrentProductPayload({
          timestamp: clientSubmittedAt,
          isOverwrite,
          duplicateTitleConfirmed,
          loadedDockSubmissionEpochMs: submittedLoadedDockSubmissionEpochMs,
          loadedDockSubmissionSku: submittedLoadedDockSubmissionSku,
        }),
        sku: submittedSku,
        dockCount,
      };

      // Optimistic ghost row is injected at click-time (before pre-flight checks) via upsertOptimisticSubmit.
      upsertPendingSubmitRecovery({
        payload,
        submittedAt: payload.timestamp,
        submittedAtEpochMs: clientSubmittedAtEpochMs,
        isOverwrite,
      });
      void persistGlobalPendingDockSubmit({
        sku: submittedSku,
        submittedAt: payload.timestamp,
        submittedAtEpochMs: clientSubmittedAtEpochMs,
        isOverwrite,
      });
      const snapshotDraft = {
        sku: submittedSku,
        heldDockSku: submittedHeldDockSku,
        gpsMpn: gpsMpn.trim(),
        brand: submittedBrand,
        price: submittedPrice,
        title: title.trim(),
        mainCategory,
        selectedCategories,
        imageUrls: imageUrls.map((url) => url.trim()).filter(Boolean),
        chatgptData: chatgptData.trim(),
        chatgptDescription: chatgptDescription.trim(),
        emailNotes: emailNotes.trim(),
        datasheetUrl: datasheetUrl.trim(),
        webpageUrl: webpageUrl.trim(),
        specValues,
        otherValues,
        additionalInstructions: additionalInstructions.trim(),
        additionalInstructionsData: additionalInstructionsData.trim(),
        loadedDockSubmissionEpochMs:
          Number.isFinite(Number(submittedLoadedDockSubmissionEpochMs)) &&
          Number(submittedLoadedDockSubmissionEpochMs) > 0
            ? Number(submittedLoadedDockSubmissionEpochMs)
            : undefined,
        loadedDockSubmissionSku: submittedLoadedDockSubmissionSku,
        submittedAtEpochMs: clientSubmittedAtEpochMs,
        submittedAtSource: "client" as const,
      };
      upsertDockFormSnapshot(snapshotDraft, {
        datasheetFile,
        websitePdfFile,
      });
      shouldRestorePreviousDockSnapshot = true;

      const submitResult = await submitProduct(payload);
      clearBasicInfo();
      const resolvedSubmittedAtEpochMs =
        Number.isFinite(Number(submitResult.submittedAtEpochMs)) && Number(submitResult.submittedAtEpochMs) > 0
          ? Number(submitResult.submittedAtEpochMs)
          : clientSubmittedAtEpochMs;
      const snapshotRecord = upsertDockFormSnapshot(
        {
          ...snapshotDraft,
          submittedAtEpochMs: resolvedSubmittedAtEpochMs,
          submittedAtSource:
            Number.isFinite(Number(submitResult.submittedAtEpochMs)) && Number(submitResult.submittedAtEpochMs) > 0
              ? "backend"
              : "client",
        },
        {
          datasheetFile,
          websitePdfFile,
        },
      );
      shouldRestorePreviousDockSnapshot = false;
      if (snapshotRecord) {
        void saveSharedDockFormSnapshot(snapshotRecord).catch((error) => {
          const sharedSnapshotSyncError = error instanceof Error ? error.message : String(error);
          toast({
            title: "Shared snapshot sync issue",
            description: `Loading Dock was updated for ${submittedSku}, but cross-browser form restore data could not be synced. ${sharedSnapshotSyncError}`,
            variant: "destructive",
          });
        });
      }
      if (!submitResult.pending) {
        removePendingSubmitRecovery(submittedSku);
      }

      try {
        await syncOtherLegalValues();
      } catch (legalValueError) {
        console.warn("Non-blocking legal-value sync error:", legalValueError);
      }

      // ── AI Logging: log generated vs edited data (fire-and-forget) ──
      // Edited string is restricted to AI-tracked filter keys for stable diffs.
      const trackedFilters = getTrackedFilters();
      const trackedFilterKeys = trackedFilters ? extractFilterKeys(trackedFilters) : null;
      const currentFilterString = buildFilterLogString(
        specValues,
        properties,
        trackedFilterKeys ?? undefined,
        Boolean(trackedFilterKeys),
      );
      const logEntry = buildAiLogEntry(submittedSku, {
        aiData: chatgptData.trim(),
        aiDescription: chatgptDescription.trim(),
        filters: currentFilterString,
        conflicts: aiLogConflictsText,
      });

      if (logEntry) {
        // Compute word-level diffs for rich text formatting
        const diffs: Record<string, Array<{ t: string; d: "u" | "a" | "r" }>> = {};
        if (logEntry.aiData) {
          const tokens = computeWordDiff(logEntry.aiData.generated, logEntry.aiData.edited);
          diffs.aiData = serializeDiff(tokens);
        }
        if (logEntry.aiDescription) {
          const tokens = computeWordDiff(logEntry.aiDescription.generated, logEntry.aiDescription.edited);
          diffs.aiDescription = serializeDiff(tokens);
        }
        if (logEntry.filters) {
          const tokens = computeFilterDiff(logEntry.filters.generated, logEntry.filters.edited);
          diffs.filters = serializeDiff(tokens);
        }

        // Fire-and-forget: don't block submit on logging
        writeAiLogEntry({ ...logEntry, diffs }).catch((err) => {
          console.warn("AI logging failed (non-blocking):", err);
        });

        clearAiTracking();
      }

      if (submitResult.pending) {
        setCooldown(SUBMIT_COOLDOWN_SECONDS);
        void queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
        toast({
          title: "Still Processing",
          description: `Submission for ${submittedSku} is still running. Basic Info was cleared after the submit was acknowledged; the rest of the form stays as-is until Loading Dock catches up.`,
          duration: 10000,
        });
        return;
      }

      finalizeOptimisticSubmit(submittedSku, submitResult.processedAt, {
        submittedAt: new Date(resolvedSubmittedAtEpochMs).toISOString(),
        submittedAtEpochMs: resolvedSubmittedAtEpochMs,
      });

      setShowSuccess(true);
      toast({
        title: "Product Submitted!",
        description: `SKU ${submittedSku} has been successfully submitted and sent to the Loading Dock.`,
      });
      setTimeout(() => setShowSuccess(false), 1500);
      setCooldown(SUBMIT_COOLDOWN_SECONDS);
      void queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
    } catch (error) {
      console.error("Submission error:", error);
      restorePreviousDockSnapshot();
      removePendingSubmitRecovery(submittedSku);
      if (clientSubmittedAtEpochMs > 0) {
        await removeGlobalPendingDockSubmit({
          sku: submittedSku,
          submittedAtEpochMs: clientSubmittedAtEpochMs,
        });
      }
      if (isDuplicateTitleSubmitError(error)) {
        await rollbackOptimisticSubmit(submittedSku, { minVisibleMs: 0 });
        pendingSubmitIsOverwriteRef.current = isOverwrite;
        setDuplicateNameDialogInfo({
          title: error.duplicateTitle,
          sources: error.duplicateTitleSources,
        });
        setDuplicateNameDialogOpen(true);
        return;
      }
      const msg = error instanceof Error ? error.message : "Error submitting product.";
      const isGateBlocked =
        msg.toLowerCase().includes("another product is still being processed") ||
        msg.toLowerCase().includes("timed out waiting for output_work") ||
        (msg.toLowerCase().includes("item") && msg.toLowerCase().includes("in queue"));

      if (isGateBlocked) {
        const queueMatch = msg.match(/(\d+)\s*item/i);
        const queueInfo = queueMatch
          ? ` (${queueMatch[1]} item${queueMatch[1] === "1" ? "" : "s"} ahead in queue)`
          : "";
        await rollbackOptimisticSubmit(submittedSku, {
          toastTitle: "Processing queue busy",
          toastDescription: `Another product is currently being processed${queueInfo}. ${submittedSku} could not be submitted — please wait a few seconds and try again. If this keeps happening, contact Eran.`,
        });
        return;
      }

      await rollbackOptimisticSubmit(submittedSku, {
        toastTitle: "Submit Failed",
        toastDescription: `${submittedSku} was not moved into Loading Dock: ${msg}. If this keeps happening, contact Eran.`,
      });
      return;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedSku = effectiveSku;
    const { valid, missingFields, missingFilterFields, firstErrorSection, firstErrorTargetId } = validateForm();
    if (!valid) {
      const hasMissingFilters = missingFilterFields.length > 0;
      const nonFilterMissingFields = missingFields.filter((field) => !missingFilterFields.includes(field));

      const imageIssues = nonFilterMissingFields.filter((f) => /image/i.test(f));
      const otherIssues = nonFilterMissingFields.filter((f) => !/image/i.test(f));

      const lines: React.ReactNode[] = [];
      if (hasMissingFilters) {
        lines.push(<div key="filters">Filters: {missingFilterFields.join(", ")}</div>);
      }
      if (otherIssues.length > 0) {
        lines.push(<div key="required">Required: {otherIssues.join(", ")}</div>);
      }
      if (imageIssues.length > 0) {
        lines.push(<div key="images">Images: {imageIssues.join("; ")}</div>);
      }

      const totalMissing = missingFields.length;
      toast({
        variant: "destructive",
        title: `Cannot submit — ${totalMissing} issue${totalMissing !== 1 ? "s" : ""} found`,
        duration: 12000,
        description: <div className="flex flex-col gap-1 mt-1">{lines}</div>,
      });

      if (hasAiDataBlockingIssue) {
        focusAiDataSection({ focus: true });
      }

      // Scroll to the first invalid control or, as a fallback, the first invalid section.
      if (firstErrorTargetId || firstErrorSection) {
        setTimeout(() => {
          const target = firstErrorTargetId
            ? document.getElementById(firstErrorTargetId)
            : document.getElementById(`section-${firstErrorSection}`);
          if (target) {
            const top = Math.max(target.getBoundingClientRect().top + window.scrollY - 120, 0);
            window.scrollTo({ top, behavior: "smooth" });
            if (
              target instanceof HTMLInputElement ||
              target instanceof HTMLTextAreaElement ||
              target instanceof HTMLButtonElement
            ) {
              target.focus({ preventScroll: true });
            }
          }
        }, 100);
      }
      return;
    }

    const cachedDockEntries = queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? [];
    const normalizedSku = trimmedSku.toUpperCase();
    const duplicateInCachedDock = cachedDockEntries.some((entry) => entry.sku.trim().toUpperCase() === normalizedSku);
    pendingSubmitDuplicateNameInfoRef.current = null;

    // Ghost row is injected inside doSubmit() after all confirmations pass.

    // Pre-flight safety: run all duplicate checks before showing either dialog.
    setIsSubmitting(true);
    try {
      const [statusResult, existsResult, latestDuplicateTitleInfo] = await Promise.all([
        checkSkuStatusFresh(trimmedSku).catch(() => ({ status: "", recentSubmit: false })),
        checkSkuInLoadingDock(trimmedSku).catch(() => false),
        resolveDuplicateTitleInfoForSubmit(),
      ]);
      pendingSubmitDuplicateNameInfoRef.current = latestDuplicateTitleInfo;

      if (statusResult.status && statusResult.status !== "TO_DO") {
        toast({
          variant: "destructive",
          title: "SKU Marked COMPLETE",
          description: `SKU "${trimmedSku}" is marked as COMPLETE. Use Product Options to update or review.`,
        });
        setIsSubmitting(false);
        return;
      }

      if (duplicateInCachedDock || existsResult) {
        setOverwriteDialogOpen(true);
        setIsSubmitting(false);
        return;
      }

      if (latestDuplicateTitleInfo) {
        pendingSubmitIsOverwriteRef.current = false;
        setDuplicateNameDialogInfo(latestDuplicateTitleInfo);
        setDuplicateNameDialogOpen(true);
        setIsSubmitting(false);
        return;
      }
    } catch {
      // If checks fail, proceed anyway
    }

    setIsSubmitting(false);

    // Proceed directly into doSubmit
    void doSubmit(false);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
      }}
      className="space-y-4"
    >
      <div className="flex items-center justify-center">
        <Button
          type="button"
          variant="outline"
          onClick={handleClearInput}
          className="h-10 px-7 text-sm font-semibold rounded-full border-2 border-border bg-white shadow-sm hover:shadow-md hover:bg-muted/40 transition-all"
          onBlur={() => setClearConfirm(false)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {clearConfirm ? "Are you sure?" : "Clear Input"}
        </Button>
      </div>

      <FormSection title="CSV Upload" defaultOpen={false} closeSignal={csvUploadCloseSignal} keepMounted>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Product File (CSV)
            </Label>
            <div
              className="flex items-center gap-2"
              onDragOver={(e) => {
                e.preventDefault();
                if (!isImportingCsv) setCsvImportDragOver(true);
              }}
              onDragLeave={() => setCsvImportDragOver(false)}
              onDrop={handleCsvImportDrop}
            >
              <label className="flex-1">
                <input
                  ref={csvImportInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onClick={(e) => {
                    (e.currentTarget as HTMLInputElement).value = "";
                  }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      void handleCsvImport(file);
                    }
                  }}
                  disabled={isImportingCsv}
                />
                <div
                  className={cn(
                    "flex items-center gap-2 border border-border rounded-md px-3 h-9 text-sm cursor-pointer transition-colors",
                    csvImportDragOver ? "border-primary bg-primary/5" : "hover:bg-muted/30",
                  )}
                >
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className={activeCsvImportState ? "text-foreground" : "text-muted-foreground"}>
                    {isImportingCsv
                      ? "Importing CSV..."
                      : activeCsvImportState
                        ? activeCsvImportState.sourceFilename
                        : "Choose CSV file..."}
                  </span>
                </div>
              </label>
              {activeCsvImportState && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 text-xs"
                    onClick={() => openCsvPayloadInProductView(activeCsvSnapshotPayload)}
                    disabled={!activeCsvSnapshotPayload}
                  >
                    View
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 text-xs"
                    onClick={() => csvImportInputRef.current?.click()}
                    disabled={isImportingCsv}
                  >
                    Replace
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => {
                      handleClearCsvImport();
                    }}
                  >
                    Clear
                  </Button>
                </>
              )}
            </div>
            {!activeCsvImportState && (
              <p className="text-xs text-muted-foreground">
                Upload a CSV here to populate the Form fields automatically for this product.
              </p>
            )}
            {activeCsvImportState && (
              <p className="text-xs text-muted-foreground">
                {activeCsvImportState.sku ? `SKU ${activeCsvImportState.sku}` : "CSV ready"}
                {" · "}
                {new Date(activeCsvImportState.importedAt).toLocaleDateString()}
                {", "}
                {new Date(activeCsvImportState.importedAt).toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
      </FormSection>

      <FormSection title="CSV Preview" defaultOpen={false} keepMounted>
        <div className="space-y-2.5">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Product File (CSV)
            </Label>
            <div className="flex items-center gap-2">
              <label className="flex-1">
                <input
                  ref={csvPreviewInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onClick={(e) => {
                    (e.currentTarget as HTMLInputElement).value = "";
                  }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleCsvPreviewLoad(file);
                  }}
                  disabled={csvPreviewLoading}
                />
                <div className="flex items-center gap-2 border border-border rounded-md px-3 h-9 text-sm cursor-pointer hover:bg-muted/30 transition-colors">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className={csvPreviewFile ? "text-foreground" : "text-muted-foreground"}>
                    {csvPreviewLoading ? "Loading…" : csvPreviewFile ? csvPreviewFile.name : "Choose CSV file..."}
                  </span>
                </div>
              </label>
              {csvPreviewFile && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 text-xs"
                    onClick={() => openCsvPayloadInProductView(csvPreviewSnapshot)}
                    disabled={!csvPreviewSnapshot}
                  >
                    View
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 text-xs"
                    onClick={() => csvPreviewInputRef.current?.click()}
                    disabled={csvPreviewLoading}
                  >
                    Replace
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => {
                      setCsvPreviewFile(null);
                      setCsvPreviewSnapshot(null);
                      if (csvPreviewInputRef.current) csvPreviewInputRef.current.value = "";
                    }}
                  >
                    Clear
                  </Button>
                </>
              )}
            </div>
            {!csvPreviewFile && (
              <p className="text-xs text-muted-foreground">
                Upload a CSV here to inspect its parsed details below without filling the Form.
              </p>
            )}
            {csvPreviewFile && csvPreviewSnapshot && (
              <p className="text-xs text-muted-foreground">
                {csvPreviewSnapshot.basicFields.sku ? `SKU ${csvPreviewSnapshot.basicFields.sku}` : "CSV ready"}
                {" · "}
                {new Date(csvPreviewFile.lastModified).toLocaleDateString()}
                {", "}
                {new Date(csvPreviewFile.lastModified).toLocaleTimeString()}
              </p>
            )}
          </div>
          {csvPreviewSnapshot && (
            <CsvSnapshotViewer externalSnapshot={csvPreviewSnapshot} hideUpload properties={csvImportProperties} />
          )}
        </div>
      </FormSection>

      {/* Basic Info */}
      <div id="section-basic-info">
        <FormSection title="Basic Info" required defaultOpen collapsible={false}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                SKU <span className="text-destructive">*</span>
              </Label>
              <SkuSelector
                products={selectableSkus}
                value={effectiveSku}
                onSelect={handleSkuSelect}
                error={errors.sku}
                isRefreshing={isRefreshingFormReferenceData}
                isLoading={isLoadingSkus}
                onOpenRefresh={refreshFormReferenceData}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Brand</Label>
              <Input
                value={brand}
                readOnly
                placeholder="Auto-filled from SKU"
                className="h-9 text-sm bg-white border-border cursor-default"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Price</Label>
              {(() => {
                const isInvalid = !!effectiveSku && !skuSheetLookupLoading && !isValidPriceValue(price);
                return (
                  <>
                    <div className="relative">
                      <Input
                        value={price ? (price.startsWith("$") ? price : `$${price}`) : ""}
                        readOnly
                        placeholder="Auto-filled from SKU"
                        className={cn(
                          "h-9 text-sm border-border cursor-default bg-white",
                          isInvalid && "border-destructive text-destructive ring-1 ring-destructive",
                          errors.price && "border-destructive text-destructive ring-1 ring-destructive",
                        )}
                      />
                      {isInvalid && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-destructive text-xs font-medium">
                          ⚠
                        </span>
                      )}
                    </div>
                    {isInvalid && !errors.price && (
                      <p className="text-destructive text-xs">
                        Invalid price — contact Eran to update the Google Sheet
                      </p>
                    )}
                    {errors.price && <p className="text-destructive text-xs">{errors.price}</p>}
                  </>
                );
              })()}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Visibility</Label>
              <Input
                value={visibility}
                readOnly
                placeholder="Auto-filled from SKU"
                className="h-9 text-sm bg-white border-border cursor-default"
              />
            </div>
          </div>
        </FormSection>
      </div>

      {/* Categories */}
      <div id="section-categories">
        <FormSection title="Categories" required defaultOpen collapsible={false}>
          <CategoryTreeDropdown
            categories={categories}
            selectedPaths={selectedCategories}
            mainPath={mainCategory}
            onSelectedChange={setSelectedCategories}
            onMainChange={handleMainCategoryChange}
            error={errors.category}
            isRefreshing={isRefreshingFormReferenceData}
            onOpenRefresh={() => {
              void refreshFormReferenceData();
            }}
          />
        </FormSection>
      </div>

      {/* Data */}
      <div id="section-ai-data">
        <FormSection title="Data" required defaultOpen collapsible={false}>
          <div className="space-y-6">
            {/* ── Data Generation Section ── */}
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-foreground border-b border-border pb-1">Data Generation</h4>

              {/* Upload fields */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5" /> Supplier Datasheet (PDF)
                  </Label>
                  <div className="flex items-center gap-2">
                    <label className="flex-1">
                      <input
                        ref={datasheetInputRef}
                        type="file"
                        accept=".pdf"
                        className="hidden"
                        onClick={(e) => {
                          (e.currentTarget as HTMLInputElement).value = "";
                        }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            void handleDatasheetPdfSelect(file);
                          }
                        }}
                      />
                      <div className="flex items-center gap-2 border border-border rounded-md px-3 h-9 text-sm cursor-pointer hover:bg-muted/30 transition-colors">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className={datasheetFile || datasheetUrl ? "text-foreground" : "text-muted-foreground"}>
                          {datasheetFile ? datasheetFile.name : datasheetUrl || "Choose PDF file…"}
                        </span>
                      </div>
                    </label>
                    {(datasheetFile || datasheetUrl) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-9 text-xs"
                        onClick={() => {
                          setDatasheetFile(null);
                          setDatasheetUrl("");
                          if (datasheetInputRef.current) datasheetInputRef.current.value = "";
                        }}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5" /> Supplier Website (PDF)
                  </Label>
                  <div className="flex items-center gap-2">
                    <label className="flex-1">
                      <input
                        ref={websiteInputRef}
                        type="file"
                        accept=".pdf"
                        className="hidden"
                        onClick={(e) => {
                          (e.currentTarget as HTMLInputElement).value = "";
                        }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            void handleWebsitePdfSelect(file);
                          }
                        }}
                      />
                      <div className="flex items-center gap-2 border border-border rounded-md px-3 h-9 text-sm cursor-pointer hover:bg-muted/30 transition-colors">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className={websitePdfFile || webpageUrl ? "text-foreground" : "text-muted-foreground"}>
                          {websitePdfFile ? websitePdfFile.name : webpageUrl || "Choose PDF file…"}
                        </span>
                      </div>
                    </label>
                    {(websitePdfFile || webpageUrl) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-9 text-xs"
                        onClick={() => {
                          setWebsitePdfFile(null);
                          setWebpageUrl("");
                          if (websiteInputRef.current) websiteInputRef.current.value = "";
                        }}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Dynamic Generate Data Button — only ONE shows at a time based on uploaded files */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {(() => {
                    const hasBoth = !!datasheetFile && !!websitePdfFile;
                    const hasDatasheet = !!datasheetFile;
                    const hasWebsite = !!websitePdfFile;
                    const hasAny = hasDatasheet || hasWebsite;
                    const disabled = isGeneratingActive || generateCooldown > 0;
                    const cooldownLabel =
                      generateCooldown > 0 && !isGeneratingActive ? `Retry in ${generateCooldown}s` : null;

                    if (hasBoth) {
                      return (
                        <Button
                          type="button"
                          variant={disabled ? "outline" : "default"}
                          size="sm"
                          className={`h-9 ${!disabled ? "bg-blue-600 hover:bg-blue-700 text-white" : ""}`}
                          onClick={() => handleGenerateTitleAndData("TWO_PDFS")}
                          disabled={disabled}
                        >
                          {isGeneratingActive && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                          {cooldownLabel || "Generate Data (Datasheet + Website)"}
                        </Button>
                      );
                    }
                    if (hasDatasheet) {
                      return (
                        <Button
                          type="button"
                          variant={disabled ? "outline" : "default"}
                          size="sm"
                          className={`h-9 ${!disabled ? "bg-blue-600 hover:bg-blue-700 text-white" : ""}`}
                          onClick={() => handleGenerateTitleAndData("DATASHEET_ONLY")}
                          disabled={disabled}
                        >
                          {isGeneratingActive && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                          {cooldownLabel || "Generate Data (Supplier Datasheet)"}
                        </Button>
                      );
                    }
                    if (hasWebsite) {
                      return (
                        <Button
                          type="button"
                          variant={disabled ? "outline" : "default"}
                          size="sm"
                          className={`h-9 ${!disabled ? "bg-blue-600 hover:bg-blue-700 text-white" : ""}`}
                          onClick={() => handleGenerateTitleAndData("WEBPAGE_ONLY")}
                          disabled={disabled}
                        >
                          {isGeneratingActive && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                          {cooldownLabel || "Generate Data (Supplier Website)"}
                        </Button>
                      );
                    }
                    // No files uploaded — show disabled default
                    return (
                      <Button type="button" variant="outline" size="sm" className="h-9" disabled>
                        Generate Data
                      </Button>
                    );
                  })()}

                  {isGeneratingActive && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-9 text-xs text-muted-foreground"
                      onClick={cancelActiveGeneration}
                    >
                      Cancel
                    </Button>
                  )}
                  {!isGeneratingActive &&
                    !!datasheetFile &&
                    !!websitePdfFile &&
                    lastGenerateMode === "TWO_PDFS" &&
                    displayedTwoPdfConflicts.length === 0 &&
                    filterProposals.length > 0 && (
                      <span className="text-[10px] text-muted-foreground italic">
                        No conflicts detected between PDFs.
                      </span>
                    )}
                  {!isGeneratingActive &&
                    (!!datasheetFile || !!websitePdfFile) &&
                    !(!!datasheetFile && !!websitePdfFile) && (
                      <span className="text-[10px] text-muted-foreground italic">
                        No comparison — only one PDF provided.
                      </span>
                    )}
                </div>

                {/* Additional Instructions for Data Generation — placed after Generate button */}
                <div className="space-y-1.5">
                  <Label htmlFor="additional-instructions-data" className="text-xs font-medium">
                    Additional Instructions (for AI Data Generation){" "}
                    <span className="text-muted-foreground font-normal">(optional)</span>
                  </Label>
                  <Textarea
                    id="additional-instructions-data"
                    value={additionalInstructionsData}
                    onChange={(e) => setAdditionalInstructionsData(e.target.value)}
                    placeholder="e.g. Focus on electrical specifications, ignore packaging info"
                    className="text-sm min-h-[60px]"
                    disabled={isGeneratingActive}
                  />
                </div>

                {/* Progress */}
                {isGeneratingActive && (
                  <AiProgressBlock
                    title={generateProgressPhase}
                    progress={combinedGenerateProgress}
                    tags={generateProgressTags}
                  />
                )}
                {generateComplete && !isGeneratingActive && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
                    <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
                    <span className="text-xs font-medium text-green-700 dark:text-green-300">
                      Data Generation Complete
                    </span>
                  </div>
                )}
                {aiJob.status === "error" &&
                  !isGeneratingActive &&
                  aiJob.error &&
                  !(
                    /conflict plausibility/i.test(aiJob.error) && recoveredHeuristicErrorJobRef.current === aiJob.jobId
                  ) && (
                    <div className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 border border-destructive/20">
                      <div className="flex-1 space-y-1">
                        <p className="text-xs font-semibold text-destructive">
                          {friendlyGenerateError?.title || "Generate Data failed"}
                        </p>
                        <p className="text-xs text-destructive">{friendlyGenerateError?.message || aiJob.error}</p>
                        {friendlyGenerateError?.suggestion && (
                          <p className="text-[11px] text-destructive/90">
                            Next step: {friendlyGenerateError.suggestion}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
                          onClick={() => {
                            aiJob.reset();
                            handleGenerateTitleAndData();
                          }}
                          disabled={generateCooldown > 0}
                        >
                          {generateCooldown > 0 ? `Retry in ${generateCooldown}s` : "Retry"}
                        </Button>
                      </div>
                    </div>
                  )}

                {/* Debug output */}
                <div className="space-y-1.5">
                  <details className="rounded-md border border-border/70 bg-muted/10">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                      Generate Data Debug Output
                    </summary>
                    <div className="px-3 pb-3">
                      <Textarea
                        id="generate-debug-output"
                        value={generateDebugOutput}
                        readOnly
                        placeholder="Run Generate Data to see debug events."
                        className="text-xs font-mono min-h-[220px]"
                      />
                    </div>
                  </details>
                </div>
                <div className="space-y-1.5">
                  <details className="rounded-md border border-border/70 bg-muted/10">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                      Generate Data Raw Prompt & Output
                    </summary>
                    <div className="px-3 pb-3">
                      <Textarea
                        id="generate-raw-prompt-output-debug"
                        value={
                          generateRawPromptOutputDebug.prompt || generateRawPromptOutputDebug.output
                            ? `Raw Prompt Input:\n${generateRawPromptOutputDebug.prompt}\n\nRaw AI Output:\n${generateRawPromptOutputDebug.output}`
                            : ""
                        }
                        readOnly
                        placeholder="Run Generate Data to see raw prompt input and raw AI output."
                        className="text-xs font-mono min-h-[220px]"
                      />
                    </div>
                  </details>
                </div>
              </div>

              {/* Conflicts Panel */}
              {lastGenerateMode === "TWO_PDFS" && pdfComparisonWarning && (
                <div className="border border-amber-400 bg-amber-100/80 dark:bg-amber-950/30 dark:border-amber-700 rounded-lg px-3 py-2">
                  <span className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                    {pdfComparisonWarning}
                  </span>
                </div>
              )}
              {lastGenerateMode === "TWO_PDFS" && displayedTwoPdfConflicts.length > 0 && (
                <div className="border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 rounded-lg overflow-hidden">
                  <div className="px-3 py-1.5 bg-amber-100 dark:bg-amber-900/40 border-b border-amber-200 dark:border-amber-700">
                    <span className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                      ⚠ Conflicts Across/Within Datasheet & Webpage
                    </span>
                  </div>
                  <ul className="p-3 space-y-1">
                    {displayedTwoPdfConflicts.map((c, i) => (
                      <li key={i} className="text-xs text-amber-800 dark:text-amber-300 flex items-start gap-1.5">
                        <span className="shrink-0 mt-0.5">•</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {lastGenerateMode && lastGenerateMode !== "TWO_PDFS" && displayedSinglePdfConflicts.length > 0 && (
                <div className="border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 rounded-lg overflow-hidden">
                  <div className="px-3 py-1.5 bg-amber-100 dark:bg-amber-900/40 border-b border-amber-200 dark:border-amber-700">
                    <span className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                      ⚠ Discrepancies Within Uploaded PDF
                    </span>
                  </div>
                  <ul className="p-3 space-y-1">
                    {displayedSinglePdfConflicts.map((c, i) => {
                      const hasLocationHint =
                        /\b(page|p\.|section|sec\.|table|figure|fig\.|line|paragraph|quote|source)\b/i.test(c);
                      return (
                        <li key={i} className="text-xs text-amber-800 dark:text-amber-300 flex items-start gap-1.5">
                          <span className="shrink-0 mt-0.5">{hasLocationHint ? "📍" : "•"}</span>
                          <span>{c}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* AI-Data + PDF Viewer */}
              <ResizablePanelGroup direction="horizontal" className="rounded-lg border border-border min-h-[380px]">
                <ResizablePanel defaultSize={50} minSize={25}>
                  <div className={cn("space-y-1.5 p-2 h-full flex flex-col transition-all")}>
                    <Label htmlFor="ai-data" className="text-xs font-medium">
                      AI-Data <span className="text-destructive">*</span>
                    </Label>
                    <div className="relative flex-1 min-h-0">
                      <Textarea
                        id="ai-data"
                        ref={aiDataTextareaRef}
                        value={chatgptData}
                        onChange={(e) => setChatgptData(e.target.value)}
                        placeholder={
                          isGeneratingActive
                            ? "AI is generating product data..."
                            : "AI-generated product data (editable)"
                        }
                        readOnly={isGeneratingActive}
                        disabled={isGeneratingActive}
                        className="text-sm h-full min-h-0 resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                      />
                      {/* Hidden measurement div — matches textarea font/padding for accurate line position calculation */}
                      <div
                        ref={aiDataMeasureRef}
                        className="text-sm px-3 py-2"
                        style={{
                          position: "absolute",
                          visibility: "hidden",
                          top: 0,
                          left: 0,
                          pointerEvents: "none",
                          overflow: "hidden",
                          height: 0,
                        }}
                        aria-hidden="true"
                      />
                      <div
                        ref={aiDataMarkersLayerRef}
                        className="pointer-events-none absolute inset-0 overflow-hidden"
                        aria-hidden="true"
                      >
                        <div
                          ref={aiDataMarkersContentRef}
                          className="absolute left-0 top-0 w-6 will-change-transform"
                          style={{
                            height: aiDataMarkerRenderState.contentHeight || 0,
                          }}
                        >
                          {aiDataMarkerRenderState.positions.map((position, index) => (
                            <span
                              key={`${position}-${index}`}
                              className="absolute left-1 top-0 text-[18px] font-semibold leading-none text-rose-400/90"
                              style={{ transform: `translate3d(0, ${position}px, 0) translateY(-50%)` }}
                            >
                              ▸
                            </span>
                          ))}
                        </div>
                      </div>
                      {isGeneratingActive && !chatgptData && (
                        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </span>
                      )}
                    </div>
                    {hasAiDataBlockingIssue && (
                      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2">
                        <p className="text-destructive text-xs font-medium">{aiDataBlockingMessage}</p>
                      </div>
                    )}
                    {errors.chatgptData && !hasAiDataBlockingIssue && (
                      <p className="text-destructive text-xs">{errors.chatgptData}</p>
                    )}
                  </div>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={50} minSize={25}>
                  <div className="p-2 h-full">
                    <PdfViewer
                      datasheetData={datasheetPdfData}
                      websiteData={websitePdfData}
                      datasheetUrl={datasheetPreviewUrl}
                      websiteUrl={websitePreviewUrl}
                      datasheetSourceKey={datasheetPreviewSourceKey}
                      websiteSourceKey={websitePreviewSourceKey}
                      pdfView={pdfView}
                      onPdfViewChange={setPdfView}
                    />
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>

            {/* ── Filters Section (between AI-Data and Title/Description) ── */}
            <div id="section-filters" className="space-y-3 pt-3">
              <div className="flex items-center gap-3">
                <h4 className="text-sm font-semibold text-foreground leading-none">Filters</h4>
                <div className="h-px flex-1 bg-border/70" />
              </div>
              {!mainCategory ? (
                <div className="rounded-lg border border-border/70 bg-muted/10 px-4 py-5">
                  <p className="text-sm text-muted-foreground text-center">
                    Select a main category first to view available filters.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-border/70 bg-background px-3 py-3">
                  <DynamicSpecifications
                    properties={properties}
                    legalValues={legalValues}
                    values={specValues}
                    onChange={handleSpecChange}
                    onOtherValue={handleOtherValue}
                    selectedMainCategory={mainCategory}
                    masterLookup={masterLookup}
                    masterDefaults={masterDefaults}
                    onMandatoryKeysChange={setMandatoryFilterKeys}
                    mandatoryErrors={mandatoryErrors}
                    filterProposals={filterProposals}
                    filterSources={filterSources}
                    onFilterSourceChange={(key, source) => {
                      const prevSource = filterSources[key];
                      if ((prevSource === "ai" || prevSource === "override") && source === "manual") {
                        setManuallyEditedFilters((prev) => new Set(prev).add(key));
                      }
                      if (source === "ai" || source === "override") {
                        setManuallyEditedFilters((prev) => {
                          const next = new Set(prev);
                          next.delete(key);
                          return next;
                        });
                      }
                      setFilterSources((prev) => ({ ...prev, [key]: source }));
                    }}
                    manuallyEditedFilters={manuallyEditedFilters}
                    optionsRefreshing={isRefreshingFormReferenceData}
                    onClearAll={() => {
                      setSpecValues({});
                      setFilterSources({});
                      setFilterProposals([]);
                      setManuallyEditedFilters(new Set());
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </FormSection>
      </div>

      {/* Title & Description */}
      <div id="section-title-description">
        <FormSection title="Title & Description" required defaultOpen collapsible={false}>
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                type="button"
                variant={isGeneratingDesc || !canGenerateDescription ? "outline" : "default"}
                size="sm"
                className={`h-9 ${!(isGeneratingDesc || !canGenerateDescription) ? "bg-blue-600 hover:bg-blue-700 text-white" : ""}`}
                onClick={handleGenerateDescription}
                disabled={isGeneratingDesc || !canGenerateDescription}
              >
                {isGeneratingDesc ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> Generating...
                  </>
                ) : (
                  "Generate Title & Description"
                )}
              </Button>
              {isGeneratingDesc && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 text-xs text-muted-foreground"
                  onClick={() => {
                    descCancelledRef.current = true;
                    setTitle(titleDescPreRunValuesRef.current.title);
                    setChatgptDescription(titleDescPreRunValuesRef.current.description);
                    setIsGeneratingDesc(false);
                    setDescComplete(false);
                    writeTitleDescRuntimeState({
                      status: "idle",
                      promptMode,
                      title: titleDescPreRunValuesRef.current.title,
                      description: titleDescPreRunValuesRef.current.description,
                    });
                  }}
                >
                  Cancel
                </Button>
              )}
              <div className="flex items-center rounded-full border border-border overflow-hidden text-xs font-medium h-9">
                <button
                  type="button"
                  onClick={() => setPromptMode("technical")}
                  disabled={isGeneratingDesc}
                  className={`px-3 h-full transition-colors ${promptMode === "technical" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted/50"}`}
                >
                  Technical
                </button>
                <button
                  type="button"
                  onClick={() => setPromptMode("marketing")}
                  disabled={isGeneratingDesc}
                  className={`px-3 h-full transition-colors ${promptMode === "marketing" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted/50"}`}
                >
                  Marketing
                </button>
              </div>
            </div>
            <div className="relative">
              {titleDescLockInfo && (
                <span
                  className={cn(
                    "absolute -top-2.5 left-0 flex items-center gap-1 text-[11px] leading-none",
                    titleDescLockInfo.tone === "warning" ? "text-amber-700" : "text-muted-foreground",
                  )}
                >
                  <AlertTriangle
                    className={cn(
                      "h-2.5 w-2.5 shrink-0",
                      titleDescLockInfo.tone === "warning" ? "text-amber-600" : "text-muted-foreground",
                    )}
                  />
                  {titleDescLockInfo.message}
                </span>
              )}

              {/* Additional Instructions for Title/Description — placed right after Generate button */}
              <div className="space-y-1.5">
                <Label htmlFor="additional-instructions" className="text-xs font-medium">
                  Additional Instructions (for AI Title & Description){" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Textarea
                  id="additional-instructions"
                  value={additionalInstructions}
                  onChange={(e) => setAdditionalInstructions(e.target.value)}
                  placeholder="e.g. Make the description sound very marketing rather than scientific"
                  className="text-sm min-h-[60px]"
                  disabled={isGeneratingDesc}
                />
              </div>
            </div>

            {isGeneratingDesc && (
              <AiProgressBlock
                title={descProgress >= 90 ? "Finalizing title & description" : "Generating title & description"}
                progress={Math.max(descProgress, 2)}
                tags={["AI started", promptMode === "marketing" ? "Marketing" : "Technical"]}
              />
            )}

            {descComplete && !isGeneratingDesc && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
                <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
                <span className="text-xs font-medium text-green-700 dark:text-green-300">
                  Title & Description Generation Complete
                </span>
              </div>
            )}

            {/* Title */}
            <div className="space-y-1.5">
              <Label htmlFor="title" className="text-xs font-medium">
                Title <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={isGeneratingDesc ? "AI is generating..." : exampleTitle}
                  readOnly={isGeneratingDesc && !descComplete}
                  disabled={isGeneratingDesc && !descComplete}
                  className={`h-9 text-sm ${isGeneratingDesc && !descComplete && !title ? "pr-8" : ""} ${duplicateTitleInfo ? "border-destructive focus-visible:ring-destructive" : ""}`}
                />
                {isGeneratingDesc && !descComplete && !title && (
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center justify-center">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  </span>
                )}
              </div>
              {duplicateTitleInfo && (
                <div className="bg-amber-100 border border-amber-400 rounded-md px-3 py-2">
                  <p className="text-amber-900 text-sm font-semibold">
                    ⚠ This title already exists: "{duplicateTitleInfo.title}"
                  </p>
                </div>
              )}
              {errors.title && <p className="text-destructive text-xs">{errors.title}</p>}
              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 space-y-2">
                <div className="text-xs">
                  <p className="font-semibold">Name Structure:</p>
                  {categoryNamingPreview.structure ? (
                    <p className="mt-0.5 whitespace-pre-line break-words">{categoryNamingPreview.structure}</p>
                  ) : (
                    <p className="mt-0.5 text-muted-foreground whitespace-pre-line break-words">
                      {mainCategory.trim()
                        ? "No Name Structure found for selected Main Category."
                        : "Select Main Category to load Name Structure."}
                    </p>
                  )}
                </div>
                <div className="text-xs">
                  <p className="font-semibold">Name Example:</p>
                  {categoryNamingPreview.example ? (
                    <p className="mt-0.5 whitespace-pre-line break-words">{categoryNamingPreview.example}</p>
                  ) : (
                    <p className="mt-0.5 text-muted-foreground whitespace-pre-line break-words">
                      {mainCategory.trim()
                        ? "No Name Example found for selected Main Category."
                        : "Select Main Category to load Name Example."}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* AI Description */}
            <div className="space-y-1.5">
              <Label htmlFor="ai-description" className="text-xs font-medium">
                AI-Description <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Textarea
                  id="ai-description"
                  value={chatgptDescription}
                  onChange={(e) => setChatgptDescription(e.target.value)}
                  placeholder={
                    isGeneratingDesc ? "AI is generating description..." : "AI-generated product description (editable)"
                  }
                  readOnly={isGeneratingDesc && !descComplete}
                  disabled={isGeneratingDesc && !descComplete}
                  className="text-sm min-h-[320px]"
                />
                {isGeneratingDesc && !descComplete && !chatgptDescription && (
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </span>
                )}
              </div>
              {errors.chatgptDescription && <p className="text-destructive text-xs">{errors.chatgptDescription}</p>}
            </div>

            {/* Title & Description Debug Output */}
            <div className="space-y-1.5">
              <details className="rounded-md border border-border/70 bg-muted/10">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                  Generate Title & AI-Description Debug Output
                </summary>
                <div className="px-3 pb-3">
                  <Textarea
                    id="title-desc-debug-output"
                    value={titleDescDebugOutput}
                    readOnly
                    placeholder="Run Generate Title & Description to see debug events."
                    className="text-xs font-mono min-h-[220px]"
                  />
                </div>
              </details>
            </div>
            <div className="space-y-1.5">
              <details className="rounded-md border border-border/70 bg-muted/10">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                  Generate Title & AI-Description Raw Prompt & Output
                </summary>
                <div className="px-3 pb-3">
                  <Textarea
                    id="title-desc-raw-prompt-output-debug"
                    value={
                      titleDescRawPromptOutputDebug.prompt || titleDescRawPromptOutputDebug.output
                        ? `Raw Prompt Input:\n${titleDescRawPromptOutputDebug.prompt}\n\nRaw AI Output:\n${titleDescRawPromptOutputDebug.output}`
                        : ""
                    }
                    readOnly
                    placeholder="Run Generate Title & Description to see raw prompt input and raw AI output."
                    className="text-xs font-mono min-h-[220px]"
                  />
                </div>
              </details>
            </div>
          </div>
        </FormSection>
      </div>

      {/* Images */}
      <div id="section-images">
        <FormSection title="Images" required defaultOpen collapsible={false}>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              💡 Order: lifestyle/product images first, dimension image last. Min 700px wide.
            </p>
            <DynamicImageInputs
              imageUrls={imageUrls}
              onChange={setImageUrls}
              error={errors.images}
              onFirstImageValidation={handleFirstImageValidation}
            />
          </div>
        </FormSection>
      </div>

      {/* Email Notes */}
      <FormSection title="Email Notes" defaultOpen>
        <div className="space-y-2">
          <Label htmlFor="email-notes" className="text-sm font-medium">
            Notes for Email Body
          </Label>
          <Textarea
            id="email-notes"
            value={emailNotes}
            onChange={(e) => setEmailNotes(e.target.value)}
            placeholder="Add any notes or special instructions for the email communication..."
            className="min-h-[200px] text-sm"
          />
          <p className="text-xs text-muted-foreground">
            These notes will be included in email communications about this product.
          </p>
        </div>
      </FormSection>

      {/* Actions */}
      <div className="flex items-center justify-center gap-4 pt-4">
        <Button
          type="button"
          variant="outline"
          className="h-12 px-8 text-sm font-semibold rounded-full border-2 border-border bg-white shadow-md hover:shadow-lg hover:bg-muted/40 transition-all"
          onClick={() => {
            void handleViewCurrentForm();
          }}
          disabled={!effectiveSku.trim()}
        >
          <Eye className="mr-2 h-4 w-4" />
          View
        </Button>
        <Button
          type="button"
          className={cn(
            "h-12 px-8 text-sm font-semibold rounded-full shadow-md hover:shadow-lg transition-all",
            sendByEmailCooldown > 0 &&
              !isSendingByEmail &&
              "bg-muted text-muted-foreground shadow-none hover:bg-muted hover:shadow-none",
          )}
          onClick={() => {
            void handleSendByEmail();
          }}
          disabled={!effectiveSku.trim() || isSendingByEmail || sendByEmailCooldown > 0}
        >
          {isSendingByEmail ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
          {isSendingByEmail
            ? "Sending..."
            : sendByEmailCooldown > 0
              ? `Send By Email (${sendByEmailCooldown}s)`
              : "Send By Email"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-12 px-8 text-sm font-semibold rounded-full border-2 border-border bg-white shadow-md hover:shadow-lg hover:bg-muted/40 transition-all",
            downloadActionCooldown > 0 &&
              !isDownloadingFormCsv &&
              "border-muted bg-muted text-muted-foreground shadow-none hover:bg-muted hover:shadow-none",
          )}
          onClick={() => {
            setDownloadConfirmOpen(true);
          }}
          disabled={!effectiveSku.trim() || isDownloadingFormCsv || downloadActionCooldown > 0}
        >
          {isDownloadingFormCsv ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          {isDownloadingFormCsv
            ? "Downloading..."
            : downloadActionCooldown > 0
              ? `Download (${downloadActionCooldown}s)`
              : "Download"}
        </Button>
      </div>

      {/* Overwrite Warning Dialog */}
      <AlertDialog open={overwriteDialogOpen} onOpenChange={setOverwriteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>SKU Already in Loading Dock</AlertDialogTitle>
            <AlertDialogDescription>
              SKU "<strong>{effectiveSku}</strong>" is already in the Loading Dock. Submitting will overwrite the
              existing entry. Do you want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                pendingSubmitIsOverwriteRef.current = false;
                pendingSubmitDuplicateNameInfoRef.current = null;
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOverwriteDialogOpen(false);
                // After confirming overwrite, check for duplicate name
                if (pendingSubmitDuplicateNameInfoRef.current) {
                  pendingSubmitIsOverwriteRef.current = true;
                  setDuplicateNameDialogInfo(pendingSubmitDuplicateNameInfoRef.current);
                  setDuplicateNameDialogOpen(true);
                  return;
                }
                void doSubmit(true);
              }}
            >
              Overwrite
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={downloadConfirmOpen}
        onOpenChange={(open) => {
          if (!isDownloadingFormCsv) {
            setDownloadConfirmOpen(open);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Download CSV?</AlertDialogTitle>
            <AlertDialogDescription>
              This will download the current form using the same CSV format as Loading Dock and mark the SKU as COMPLETE
              in Products To Do.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDownloadingFormCsv}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDownloadingFormCsv || downloadActionCooldown > 0}
              onClick={(event) => {
                event.preventDefault();
                void handleDownloadCurrentForm();
              }}
            >
              {isDownloadingFormCsv ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Downloading...
                </>
              ) : downloadActionCooldown > 0 ? (
                `Wait ${downloadActionCooldown}s`
              ) : (
                "Download"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Duplicate Product Name Warning Dialog */}
      <AlertDialog open={duplicateNameDialogOpen} onOpenChange={setDuplicateNameDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Duplicate Product Name</AlertDialogTitle>
            <AlertDialogDescription>
              The name "<strong>{duplicateNameDialogInfo?.title || title.trim()}</strong>" already exists
              {duplicateNameDialogInfo?.sources ? ` in ${duplicateNameDialogInfo.sources.join(" & ")}` : ""}. Are you
              sure you want to submit?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                pendingSubmitIsOverwriteRef.current = false;
                pendingSubmitDuplicateNameInfoRef.current = null;
                setDuplicateNameDialogInfo(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDuplicateNameDialogOpen(false);
                void doSubmit(pendingSubmitIsOverwriteRef.current, true);
              }}
            >
              Submit Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={csvImportConfirmOpen}
        onOpenChange={(open) => {
          setCsvImportConfirmOpen(open);
          if (!open) {
            clearPendingCsvImportDecision();
          }
        }}
      >
        <AlertDialogContent className="max-w-md">
          {pendingCsvImportStatus === "COMPLETE" || pendingCsvImportStatus === "NOT FOR SALE" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="text-base">This SKU is {pendingCsvImportStatus}</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-3 text-sm text-muted-foreground">
                    <p>How would you like to load this CSV?</p>

                    {/* Toggle pill — same style as Technical/Marketing */}
                    <div className="flex justify-center">
                      <div className="flex items-center rounded-full border border-border overflow-hidden text-xs font-medium h-9">
                        <button
                          type="button"
                          onClick={() => setCsvImportBasicInfoMode("template")}
                          className={`px-4 h-full transition-colors ${csvImportBasicInfoMode === "template" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted/50"}`}
                        >
                          Use as template
                        </button>
                        <button
                          type="button"
                          onClick={() => setCsvImportBasicInfoMode("fill_sku")}
                          className={`px-4 h-full transition-colors ${csvImportBasicInfoMode === "fill_sku" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted/50"}`}
                        >
                          Import everything
                        </button>
                      </div>
                    </div>

                    {/* Explanation text based on selected mode */}
                    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground space-y-1.5">
                      {csvImportBasicInfoMode === "template" ? (
                        <>
                          <p className="font-medium text-foreground">Template mode</p>
                          <p>
                            Imports all data fields (categories, filters, images, AI data, title &amp; description) from
                            the CSV but{" "}
                            <strong className="text-foreground">keeps your current SKU, MPN, Brand, and Price</strong>{" "}
                            unchanged.
                          </p>
                          <p>Use this when you want to reuse the content structure for a different product.</p>
                          {hasMeaningfulFormContent() && (
                            <p className="text-destructive font-medium">
                              ⚠ This will overwrite your current form data.
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          <p className="font-medium text-foreground">Full import</p>
                          <p>
                            Replaces <strong className="text-foreground">all form fields</strong> with the CSV data,
                            including SKU, MPN, Brand, and Price.
                          </p>
                          {hasMeaningfulFormContent() && (
                            <p className="text-destructive font-medium">
                              ⚠ This will overwrite your current form data.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>

              <AlertDialogFooter className="pt-2">
                <AlertDialogCancel onClick={() => clearPendingCsvImportDecision()}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const pendingFile = pendingCsvImportFileRef.current;
                    const pendingResult = pendingCsvImportResultRef.current;
                    clearPendingCsvImportDecision();
                    if (!pendingFile || !pendingResult) return;
                    setIsImportingCsv(true);
                    void finalizeCsvImport(pendingResult, pendingFile, csvImportBasicInfoMode)
                      .catch((error) => {
                        const details = mapCsvImportErrorMessage(
                          error instanceof Error ? error.message : String(error),
                        );
                        toast({ variant: "destructive", title: details.title, description: details.description });
                      })
                      .finally(() => setIsImportingCsv(false));
                  }}
                >
                  Load CSV
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="text-base">Replace form data?</AlertDialogTitle>
                <AlertDialogDescription className="text-sm">
                  This will replace current form values with the CSV data. Nothing is submitted — you can review
                  everything after import.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="pt-2">
                <AlertDialogCancel onClick={() => clearPendingCsvImportDecision()}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const pendingFile = pendingCsvImportFileRef.current;
                    const pendingResult = pendingCsvImportResultRef.current;
                    clearPendingCsvImportDecision();
                    if (!pendingFile || !pendingResult) return;
                    setIsImportingCsv(true);
                    void finalizeCsvImport(pendingResult, pendingFile, "fill_sku")
                      .catch((error) => {
                        const details = mapCsvImportErrorMessage(
                          error instanceof Error ? error.message : String(error),
                        );
                        toast({ variant: "destructive", title: details.title, description: details.description });
                      })
                      .finally(() => setIsImportingCsv(false));
                  }}
                >
                  Load CSV
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <ProductViewDialog open={productViewOpen} onOpenChange={setProductViewOpen} data={productViewData} />
    </form>
  );
}

export function ProductEntryForm() {
  return <ProductEntryFormInner key={PRODUCT_ENTRY_FORM_RENDER_KEY} />;
}
