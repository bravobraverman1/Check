// ============================================================
// Supabase Google Sheets Integration
// Calls the Supabase Edge Function to interact with Google Sheets
// using server-side Supabase secrets (never stored in the browser).
// ============================================================

import { config } from "@/config";
import { SUPABASE_ANON_KEY, SUPABASE_FUNCTIONS_URL } from "@/config/publicEnv";
import type { CategoryLevel } from "@/data/categoryData";
import type { PropertyDefinition, LegalValue } from "@/data/defaultProperties";
import { enqueueEvent } from "@/lib/eventQueue";
import { buildEdgeRequestHeaders, getEdgeAuthTroubleshootingMessage } from "@/lib/edgeAuth";
import { normalizeGoogleSheetsAction, type GoogleSheetsAction } from "@/lib/googleSheetsActions";

interface GoogleSheetsReadResponse {
  useDefaults?: boolean;
  products?: Array<{
    sku: string;
    brand: string;
    exampleTitle: string;
    price?: number | string;
  }>;
  brands?: Array<{
    brand: string;
    brandName: string;
    website: string;
  }>;
  categories?: CategoryLevel[];
  properties?: PropertyDefinition[];
  legalValues?: LegalValue[];
  categoryPathCount?: number;
  masterLookup?: Array<{ defaultName: string; categoryPath: string; nameStructure?: string; nameExample?: string }>;
  masterDefaults?: Array<{ name: string; allowedProperties: string[] }>;
  existingTitles?: string[];
}

export interface MasterLookupEntry {
  defaultName: string;
  categoryPath: string;
  nameStructure?: string;
  nameExample?: string;
}

export interface MasterDefaultEntry {
  name: string;
  allowedProperties: string[];
}

interface SheetTabNamesPayload {
  PRODUCTS: string;
  PRODUCTS_TODO: string;
  CATEGORIES: string;
  PROPERTIES: string;
  LEGAL: string;
  RESPONSES: string;
  BRANDS: string;
  EVENTS: string;
  NEW_NAMES: string;
  EXISTING_PRODS: string;
  MASTER_DEFAULTS: string;
  OUTPUT_WORK?: string;
  OUTPUT_TEMPLATE?: string;
  LOADING_DOCK?: string;
  AI_LOGGING?: string;
}

const SUPABASE_KEY = SUPABASE_ANON_KEY;

const FUNCTIONS_BASE_URL = SUPABASE_FUNCTIONS_URL;
const EDGE_FUNCTION_TIMEOUT_MS = 35_000;
const EDGE_FUNCTION_SLOW_READ_TIMEOUT_MS = 20_000;
const EDGE_FUNCTION_READ_ONLY_TIMEOUT_MS = 20_000;
const EDGE_FUNCTION_MPN_TIMEOUT_MS = 35_000;
const EDGE_FUNCTION_FORM_SEND_TIMEOUT_MS = 35_000;
const EDGE_FUNCTION_FORM_DOWNLOAD_TIMEOUT_MS = 35_000;
const EDGE_FUNCTION_DOCK_FETCH_TIMEOUT_MS = 12_000; // dock polling should be fast — edge function serves stale after 8s
const EDGE_FUNCTION_WRITE_TIMEOUT_MS = 145_000; // Keep client timeout under Supabase free-tier 150s wall-clock edge limit
const EDGE_FUNCTION_DOCK_ACTION_TIMEOUT_MS = 90_000; // 90s — dock actions (delete/email/send) go through the gate but don't acquire OUTPUT_Work lock
const EDGE_FUNCTION_LOADING_DOCK_ACTION_TIMEOUT_MS = 15_000; // delete/email/send/clear should queue or complete quickly rather than spin
const EDGE_FUNCTION_PENDING_CLEANUP_TIMEOUT_MS = 4_000;
const GLOBAL_DOCK_PENDING_TTL_MS = 15 * 60_000;
const LAST_GOOD_READ_CACHE_KEY = "ls:last-good-read:v1";
// LAST_GOOD_DOCK_CACHE_KEY removed — dead dock cache system pruned

function canUseLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readCachedData<T>(key: string): T | null {
  if (!canUseLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: unknown };
    if (!parsed || typeof parsed !== "object" || !("data" in parsed)) return null;
    return parsed.data as T;
  } catch {
    return null;
  }
}

function writeCachedData<T>(key: string, data: T): void {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // Ignore storage write errors (quota/private mode)
  }
}

function getSheetTabNamesPayload(): SheetTabNamesPayload {
  return {
    PRODUCTS: config.SHEET_PRODUCTS,
    PRODUCTS_TODO: config.SHEET_PRODUCTS_TODO,
    CATEGORIES: config.SHEET_CATEGORIES,
    PROPERTIES: config.SHEET_LEGAL, // PROPERTIES tab removed; edge function still expects the key
    LEGAL: config.SHEET_LEGAL,
    RESPONSES: config.SHEET_OUTPUT_WORK, // OUTPUT tab removed; responses go to OUTPUT_Work
    BRANDS: config.SHEET_BRANDS,
    EVENTS: config.SHEET_EVENTS,
    NEW_NAMES: config.SHEET_NEW_NAMES,
    EXISTING_PRODS: config.SHEET_EXISTING_PRODS,
    MASTER_DEFAULTS: config.SHEET_MASTER_DEFAULTS,
    OUTPUT_WORK: config.SHEET_OUTPUT_WORK,
    OUTPUT_TEMPLATE: config.SHEET_OUTPUT_TEMPLATE,
    LOADING_DOCK: config.SHEET_LOADING_DOCK,
    AI_LOGGING: config.SHEET_AI_LOGGING,
  };
}

/**
 * Updates a SKU's visibility in PRODUCTS column D (source-of-truth).
 * PRODUCTS TO DO visibility is formula-driven and must never be written directly.
 */
export async function updateSkuVisibility(sku: string): Promise<{ success: boolean; error?: string; alreadyState?: boolean }> {
  const { data, error } = await invokeGoogleSheetsFunction<{ success?: boolean; error?: string; alreadyState?: boolean }>({
    action: "update-sku-visibility",
    sku,
    tabNames: getSheetTabNamesPayload(),
  });
  if (data && data.success === false) {
    return { success: false, error: data.error || `SKU "${sku}" was not found`, alreadyState: data.alreadyState };
  }
  if (error) {
    const parsed = extractNotFoundError(error.message);
    if (parsed) return { success: false, error: parsed };
    throw error;
  }
  invalidateReadCache();
  return { success: true };
}

/**
 * Updates a SKU's status in PRODUCTS TO DO column C
 */
export async function updateSkuStatus(sku: string, status: string, dockCount?: number): Promise<{ success: boolean; error?: string; alreadyState?: boolean }> {
  const timeoutMs = EDGE_FUNCTION_TIMEOUT_MS; // Decoupled from Loading Dock Processed_At gate
  const { data, error } = await invokeGoogleSheetsFunction<{ success?: boolean; error?: string; alreadyState?: boolean }>({
    action: "update-sku-status",
    sku,
    status,
    dockCount,
    tabNames: getSheetTabNamesPayload(),
  }, { timeoutMs });
  if (data && data.success === false) {
    return { success: false, error: data.error || `SKU "${sku}" was not found`, alreadyState: data.alreadyState };
  }
  if (error) {
    // If the write timed out client-side, verify the final SKU status before surfacing failure.
    if (isEdgeFunctionTimeoutErrorMessage(error.message)) {
      const confirmed = await confirmSkuStatusValue(sku, status);
      if (confirmed) {
        invalidateReadCache();
        return { success: true };
      }
    }
    const parsed = extractNotFoundError(error.message);
    if (parsed) return { success: false, error: parsed };
    throw error;
  }
  invalidateReadCache();
  return { success: true };
}

/** Extract a user-friendly not-found message from edge function error responses */
function extractNotFoundError(message: string): string | null {
  // Match patterns like: SKU "X" not found...
  const match = message.match(/SKU\s+"([^"]+)"\s+(?:not found|was not found)/i);
  if (match) return `SKU "${match[1]}" was not found`;
  if (message.includes('"success":false')) return "SKU was not found";
  return null;
}

function extractErrorField(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const value = (payload as Record<string, unknown>).error;
  return typeof value === "string" ? value : "";
}

function payloadSignalsUseDefaults(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return (payload as Record<string, unknown>).useDefaults === true;
}

function extractErrorRef(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const value = (payload as Record<string, unknown>).error_ref;
  return typeof value === "string" ? value.trim() : "";
}

function isSkuNotFoundPayload(payload: unknown): boolean {
  const message = extractErrorField(payload);
  return /SKU\s+"[^"]+"\s+(?:not found|was not found)/i.test(message);
}

export function isEdgeFunctionTimeoutErrorMessage(message: string): boolean {
  return /\b(timed?\s*out|timeout|abort(?:ed)?)\b/i.test(message);
}

function normalizeSkuStatusValue(value: unknown): "TO_DO" | "COMPLETE" | "NOT_FOR_SALE" | "" {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "TO_DO" || normalized === "TO DO") return "TO_DO";
  if (normalized === "COMPLETE") return "COMPLETE";
  if (normalized === "NOT_FOR_SALE" || normalized === "NOT FOR SALE") return "NOT_FOR_SALE";
  return "";
}

async function confirmSkuStatusValue(sku: string, expectedStatus: string): Promise<boolean> {
  const trimmedSku = String(sku ?? "").trim();
  const expected = normalizeSkuStatusValue(expectedStatus);
  if (!trimmedSku || !expected) return false;

  const attempts = 12;
  const delayMs = 1200;
  for (let i = 0; i < attempts; i += 1) {
    const { data, error } = await invokeGoogleSheetsFunction<{ status?: string }>(
      {
        action: "check-sku-status",
        sku: trimmedSku,
        tabNames: getSheetTabNamesPayload(),
      },
      { timeoutMs: EDGE_FUNCTION_READ_ONLY_TIMEOUT_MS },
    );

    if (!error && normalizeSkuStatusValue(data?.status) === expected) {
      return true;
    }

    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}

function parseSubmittedAtEpochMs(value: string | undefined): number | undefined {
  const parsed = Date.parse(String(value ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function confirmDockWriteQueued(sku: string): Promise<{
  queued: boolean;
  submittedAtEpochMs?: number;
}> {
  const normalizedSku = sku.trim();
  if (!normalizedSku) return { queued: false };
  try {
    const status = await checkDockRowStatus(normalizedSku);
    if (!status.success) return { queued: false };
    return {
      queued: status.pending || status.existsInDock || status.actionable,
      submittedAtEpochMs: parseSubmittedAtEpochMs(status.latestSubmittedAt),
    };
  } catch {
    return { queued: false };
  }
}

function parseCsvCellsForSku(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function extractSkuFromCsvText(csvText: string): string {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return "";

  const headers = parseCsvCellsForSku(lines[0]).map((h) => h.replace(/^\uFEFF/, "").trim().toLowerCase());
  const values = parseCsvCellsForSku(lines[1]);
  const skuIdx = headers.findIndex((h) => h === "product code/sku" || h === "product id" || h === "sku");
  if (skuIdx === -1) return "";
  return (values[skuIdx] ?? "").trim();
}

export async function persistGlobalPendingDockSubmit(input: {
  sku: string;
  submittedAt?: string;
  submittedAtEpochMs?: number;
  isOverwrite?: boolean;
  expiresAt?: number;
}): Promise<boolean> {
  const sku = input.sku.trim();
  if (!sku) return false;

  const submittedAtEpochMs = Number.isFinite(input.submittedAtEpochMs)
    ? Number(input.submittedAtEpochMs)
    : Date.now();
  const submittedAt = input.submittedAt?.trim() || new Date(submittedAtEpochMs).toISOString();
  const expiresAt = Number.isFinite(input.expiresAt)
    ? Number(input.expiresAt)
    : submittedAtEpochMs + GLOBAL_DOCK_PENDING_TTL_MS;

  try {
    const { data, error } = await invokeGoogleSheetsFunction<{ success?: boolean }>(
      {
        action: "upsert-dock-pending",
        pending: {
          sku,
          submittedAt,
          submittedAtEpochMs,
          isOverwrite: input.isOverwrite === true,
          expiresAt,
        },
      },
      { timeoutMs: EDGE_FUNCTION_TIMEOUT_MS },
    );
    if (error) {
      console.warn("Could not persist global pending dock submit:", error);
      return false;
    }
    return data?.success === true;
  } catch (error) {
    console.warn("Could not persist global pending dock submit:", error);
    return false;
  }
}

export async function removeGlobalPendingDockSubmit(input: {
  sku: string;
  submittedAtEpochMs?: number;
}): Promise<boolean> {
  const sku = input.sku.trim();
  if (!sku) return false;

  const submittedAtEpochMs = Number.isFinite(input.submittedAtEpochMs)
    ? Number(input.submittedAtEpochMs)
    : undefined;

  try {
    const { data, error } = await invokeGoogleSheetsFunction<{ success?: boolean; removed?: boolean }>(
      {
        action: "remove-dock-pending",
        pending: {
          sku,
          submittedAtEpochMs,
        },
      },
      { timeoutMs: EDGE_FUNCTION_PENDING_CLEANUP_TIMEOUT_MS },
    );
    if (error) {
      console.warn("Could not remove global pending dock submit:", error);
      return false;
    }
    return data?.success === true && data?.removed === true;
  } catch (error) {
    console.warn("Could not remove global pending dock submit:", error);
    return false;
  }
}

async function invokeGoogleSheetsFunctionRaw<T>(
  body: Record<string, unknown> & { action?: unknown },
  options?: { timeoutMs?: number },
) {
  if (!FUNCTIONS_BASE_URL || !SUPABASE_KEY) {
    return {
      data: null as T | null,
      error: new Error(
        "Supabase environment variables are not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY."
      ),
    };
  }

  const normalizedAction = normalizeGoogleSheetsAction(body.action);
  if (!normalizedAction) {
    return {
      data: null as T | null,
      error: new Error(
        `Invalid google-sheets action: ${typeof body.action === "string" ? body.action : String(body.action ?? "") || "<missing>"}`,
      ),
    };
  }

  const requestBody = {
    ...body,
    action: normalizedAction,
  };

  const timeoutMs = options?.timeoutMs ?? EDGE_FUNCTION_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    const headers = await buildEdgeRequestHeaders({ "Content-Type": "application/json" });
    res = await fetch(`${FUNCTIONS_BASE_URL}/google-sheets`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        data: null as T | null,
        error: new Error(`Edge function timed out after ${timeoutMs / 1000}s`),
      };
    }
    return {
      data: null as T | null,
      error: error instanceof Error ? error : new Error("Edge function request failed"),
    };
  }
  clearTimeout(timeoutId);

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    if (res.status === 404 && normalizedAction === "read-sku-details" && isSkuNotFoundPayload(parsed)) {
      return { data: parsed as T, error: null as Error | null };
    }
    const useDefaults = payloadSignalsUseDefaults(parsed);
    const errorRef = extractErrorRef(parsed);
    const rawError = useDefaults
      ? "Google Sheets credentials not configured in Supabase secrets"
      : String(extractErrorField(parsed) || text || `HTTP ${res.status}`);
    const edgeAuthHint = getEdgeAuthTroubleshootingMessage(rawError);
    const errorMessage = edgeAuthHint || rawError;
    const suffix = errorRef ? ` (ref ${errorRef})` : "";
    return {
      data: parsed as T | null,
      error: new Error(`Edge function returned ${res.status}: ${errorMessage}${suffix}`),
    };
  }

  return { data: parsed as T, error: null as Error | null };
}

const NON_SERIALIZED_ACTIONS = new Set<GoogleSheetsAction>([
  "read",
  "check-sku-temp-csv",
  "fetch-dock-entries",
  "read-dock-email",
  "read-output-work",
  "read-sku-details",
  "check-sku-status",
  "check-dock-row-status",
  "download-form-csv",
  "download-csv",
  // Product Options actions: simple cell updates with server-side idempotency.
  // Must never be blocked by unrelated queued tasks.
  "update-sku-visibility",
  "update-sku-status",
  // Keep form MPN + form action flows independent from the serialized write queue
  // so Download / Send By Email can never be blocked by an unrelated long-running task.
  "mpn-peek",
  "resolve-form-mpn-state",
  "release-form-generated-mpn",
  "log-form-mpn-sku-change",
  "send-form-email",
]);

function shouldSerializeGoogleSheetsAction(body: Record<string, unknown> & { action?: unknown }): boolean {
  const action = normalizeGoogleSheetsAction(body.action);
  if (!action) return false;
  return !NON_SERIALIZED_ACTIONS.has(action);
}

export async function invokeGoogleSheetsFunction<T>(
  body: Record<string, unknown> & { action?: unknown },
  options?: { timeoutMs?: number },
) {
  if (!shouldSerializeGoogleSheetsAction(body)) {
    return invokeGoogleSheetsFunctionRaw<T>(body, options);
  }
  return enqueueEvent(() => invokeGoogleSheetsFunctionRaw<T>(body, options));
}

// invokeGoogleSheetsFunctionSerialized alias removed — was identical to invokeGoogleSheetsFunction.
// All call sites now use invokeGoogleSheetsFunction directly.

/**
 * Checks if Supabase Google Sheets integration is configured
 * Returns true if we can call the edge function (credentials are checked server-side)
 */
export function isSupabaseGoogleSheetsConfigured(): boolean {
  // Always return true - the edge function will check if Deno.env secrets are configured
  return true;
}

/**
 * Calls the Supabase Edge Function to read data from Google Sheets.
 * Results are cached for 30 seconds so multiple React Query hooks
 * (categories, brands, properties, etc.) share ONE edge-function call
 * instead of each triggering a separate round-trip.
 */
let _readCache: { data: GoogleSheetsReadResponse; ts: number } | null = null;
let _readInflight: Promise<GoogleSheetsReadResponse> | null = null;
let _readLastGood: GoogleSheetsReadResponse | null = null;
let _readLastGoodLoaded = false;
const READ_CACHE_TTL = 5_000; // 5 seconds for Loading Dock sync

function loadLastGoodReadOnce(): void {
  if (_readLastGoodLoaded) return;
  _readLastGoodLoaded = true;
  const cached = readCachedData<GoogleSheetsReadResponse>(LAST_GOOD_READ_CACHE_KEY);
  if (cached && !cached.useDefaults) {
    _readLastGood = cached;
  }
}

function getLastGoodRead(): GoogleSheetsReadResponse | null {
  loadLastGoodReadOnce();
  return _readLastGood ? { ..._readLastGood } : null;
}

function setLastGoodRead(data: GoogleSheetsReadResponse): void {
  if (data.useDefaults) return;
  _readLastGood = { ...data };
  writeCachedData(LAST_GOOD_READ_CACHE_KEY, _readLastGood);
}

export async function readGoogleSheets(): Promise<GoogleSheetsReadResponse> {
  // Return cached result if still fresh
  if (_readCache && Date.now() - _readCache.ts < READ_CACHE_TTL) {
    return _readCache.data;
  }

  // Deduplicate concurrent in-flight requests
  if (_readInflight) return _readInflight;

  // Stale-while-revalidate: on cold start with localStorage cache available,
  // serve cached data instantly while refreshing in the background.
  // This eliminates the 30+ second wait on initial page load.
  const lastGood = getLastGoodRead();
  if (lastGood && !_readCache) {
    // Set in-memory cache so concurrent callers also get instant data
    _readCache = { data: lastGood, ts: Date.now() };
    // Kick off background refresh — don't block the caller
    _readInflight = _readGoogleSheetsImpl();
    _readInflight.then((result) => {
      _readCache = { data: result, ts: Date.now() };
    }).catch(() => {
      // Background refresh failed; stale cache remains valid
    }).finally(() => {
      _readInflight = null;
    });
    return lastGood;
  }

  _readInflight = _readGoogleSheetsImpl();
  try {
    const result = await _readInflight;
    _readCache = { data: result, ts: Date.now() };
    return result;
  } finally {
    _readInflight = null;
  }
}

/** Force-clear the read cache (call after writes so the next read is fresh) */
export function invalidateReadCache(): void {
  _readCache = null;
  // Also force invalidate recent-submissions query for Loading Dock
  if (typeof window !== "undefined") {
    const event = new CustomEvent("force-sync-recent-submissions");
    window.dispatchEvent(event);
  }
}

async function _readGoogleSheetsImpl(): Promise<GoogleSheetsReadResponse> {
  const fallback = getLastGoodRead();
  try {
    const requestBody = {
      action: "read",
      tabNames: getSheetTabNamesPayload(),
    };

    const { data, error } = await invokeGoogleSheetsFunction<GoogleSheetsReadResponse>(requestBody);

    if (error) {
      console.error("Error calling google-sheets function:", error);
      if (fallback) {
        console.warn("Using last known good sheet data due to sync error.");
        return fallback;
      }
      return { useDefaults: true };
    }

    if (data?.useDefaults) {
      console.log("Edge function returned useDefaults - credentials not in Supabase secrets");
      if (fallback) {
        console.warn("Using last known good sheet data while edge function is in defaults mode.");
        return fallback;
      }
      return { useDefaults: true };
    }

    const fresh = data as GoogleSheetsReadResponse;
    setLastGoodRead(fresh);
    return fresh;
  } catch (error) {
    console.error("Exception calling google-sheets function:", error);
    if (fallback) {
      console.warn("Using last known good sheet data after read exception.");
      return fallback;
    }
    return { useDefaults: true };
  }
}

/**
 * Writes a row to the Google Sheet via Supabase Edge Function
 * Uses ONLY server-side Supabase secrets. No credentials are sent from the browser
 */
export async function writeToGoogleSheets(rowData: string[]): Promise<boolean> {
  try {
    const requestBody = {
      action: "write",
      rowData,
      tabNames: getSheetTabNamesPayload(),
    };

    const { data, error } = await invokeGoogleSheetsFunction<{ success?: boolean }>(requestBody);

    if (error) {
      console.error("Error writing to google-sheets function:", error);
      return false;
    }

    return data?.success ?? false;
  } catch (error) {
    console.error("Exception writing to google-sheets function:", error);
    return false;
  } finally {
    invalidateReadCache();
  }
}
/**
 * Writes category paths to the Google Sheet via Supabase Edge Function
 * Uses ONLY server-side Supabase secrets. No credentials are sent from the browser
 */
export async function writeCategoriesToGoogleSheets(
  categoryPaths: string[]
): Promise<boolean> {
  try {
    const requestBody = {
      action: "write-categories",
      categoryPaths,
      tabNames: getSheetTabNamesPayload(),
    };

    const { data, error } = await invokeGoogleSheetsFunction<{ success?: boolean; error?: string; useDefaults?: boolean }>(requestBody);

    if (error) {
      console.error("Error writing categories to google-sheets function:", error);
      throw new Error(error.message || "Failed to write categories to Google Sheets");
    }

    if (data?.useDefaults) {
      throw new Error(
        "Google Sheets credentials not configured in Supabase secrets. Add GOOGLE_SERVICE_ACCOUNT_KEY and GOOGLE_SHEET_ID to your Supabase project, then redeploy the edge function."
      );
    }

    if (!data?.success) {
      throw new Error(data?.error || "Failed to write categories to Google Sheets");
    }

    return true;
  } catch (error) {
    console.error("Exception writing categories to google-sheets function:", error);
    throw error instanceof Error
      ? error
      : new Error("Failed to write categories to Google Sheets");
  } finally {
    invalidateReadCache();
  }
}

/**
 * Writes brands to the Google Sheet via Supabase Edge Function
 * Uses ONLY server-side Supabase secrets. No credentials are sent from the browser
 */
export async function writeBrandsToGoogleSheets(
  brands: Array<{ brand: string; brandName: string; website: string }>
): Promise<boolean> {
  try {
    const requestBody = {
      action: "write-brands",
      brands,
      tabNames: getSheetTabNamesPayload(),
    };

    const { data, error } = await invokeGoogleSheetsFunction<{ success?: boolean; error?: string; useDefaults?: boolean }>(requestBody);

    if (error) {
      console.error("Error writing brands to google-sheets function:", error);
      throw new Error(error.message || "Failed to write brands to Google Sheets");
    }

    if (data?.useDefaults) {
      throw new Error(
        "Edge function cannot read Supabase secrets. Redeploy the edge function after setting GOOGLE_SERVICE_ACCOUNT_KEY and GOOGLE_SHEET_ID."
      );
    }

    if (!data?.success) {
      throw new Error(data?.error || "Failed to write brands to Google Sheets");
    }

    return true;
  } catch (error) {
    console.error("Exception writing brands to google-sheets function:", error);
    throw error instanceof Error
      ? error
      : new Error("Failed to write brands to Google Sheets");
  } finally {
    invalidateReadCache();
  }
}

/**
 * Writes a legal value to the LEGAL tab (row-based layout) via Supabase Edge Function
 */
export async function writeLegalValueToGoogleSheets(
  propertyName: string,
  value: string
): Promise<boolean> {
  try {
    const requestBody = {
      action: "write-legal",
      propertyName,
      value,
      tabNames: getSheetTabNamesPayload(),
    };

    const { data, error } = await invokeGoogleSheetsFunction<{ success?: boolean; error?: string; useDefaults?: boolean }>(requestBody);

    if (error) {
      console.error("Error writing legal value to google-sheets function:", error);
      return false;
    }

    if (data?.useDefaults) {
      console.error("Edge function cannot read Supabase secrets. Redeploy after setting secrets.");
      return false;
    }

    return data?.success ?? false;
  } catch (error) {
    console.error("Exception writing legal value to google-sheets function:", error);
    return false;
  } finally {
    invalidateReadCache();
  }
}

/**
 * Stages product data through OUTPUT_Work and completes the Loading Dock write in the edge function.
 * The edge function reads headers dynamically from the template and maps fields accordingly.
 */
export async function writeProductToOutputWork(productData: {
  requestId?: string;
  sku: string;
  brand: string;
  title: string;
  mainCategory: string;
  additionalCategories: string[];
  imageUrls: string[];
  specifications: Record<string, string>;
  chatgptDescription?: string;
  chatgptData?: string;
  emailNotes?: string;
  price?: string;
  productVisible?: string;
  customFields?: string;
  dockCount?: number;
  isOverwrite?: boolean;
  duplicateTitleConfirmed?: boolean;
  loadedDockSubmissionEpochMs?: number;
}): Promise<{
  success: boolean;
  error?: string;
  pending?: boolean;
  processedAt?: string;
  submittedAtEpochMs?: number;
  reason?: string;
  errorCode?: string;
  duplicateTitle?: string;
  duplicateTitleSources?: string[];
  requiresConfirmation?: boolean;
}> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      error?: string;
      useDefaults?: boolean;
      pending?: boolean;
      processedAt?: string;
      submittedAtEpochMs?: number;
      reason?: string;
      errorCode?: string;
      duplicateTitle?: string;
      duplicateTitleSources?: string[];
      requiresConfirmation?: boolean;
    }>(
      {
        action: "write-output",
        productData,
        dockCount: productData.dockCount,
        tabNames: getSheetTabNamesPayload(),
      },
      { timeoutMs: EDGE_FUNCTION_WRITE_TIMEOUT_MS },
    );

    if (error) {
      console.error("Error writing to OUTPUT_Work:", error);
      if (isEdgeFunctionTimeoutErrorMessage(error.message)) {
        const queued = await confirmDockWriteQueued(productData.sku);
        if (queued.queued) {
          return {
            success: true,
            pending: true,
            reason: "queued-after-timeout-confirmation",
            submittedAtEpochMs: queued.submittedAtEpochMs,
          };
        }
        return { success: false, error: `Request timed out before queue confirmation for SKU "${productData.sku}". Please retry.` };
      }
      return { success: false, error: error.message };
    }

    if (data?.useDefaults) {
      return { success: false, error: "Google Sheets credentials not configured." };
    }

    if (!data?.success) {
      return {
        success: false,
        error: data?.error || "Failed to write to OUTPUT_Work",
        errorCode: data?.errorCode,
        duplicateTitle: data?.duplicateTitle,
        duplicateTitleSources: data?.duplicateTitleSources,
        requiresConfirmation: data?.requiresConfirmation,
      };
    }

    return {
      success: true,
      pending: data?.pending === true,
      processedAt: data?.processedAt,
      submittedAtEpochMs: Number.isFinite(Number(data?.submittedAtEpochMs))
        ? Number(data?.submittedAtEpochMs)
        : undefined,
      reason: data?.reason,
    };
  } catch (error) {
    console.error("Exception writing to OUTPUT_Work:", error);
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  } finally {
    invalidateReadCache();
  }
}

/**
 * Checks if a SKU already exists in the Loading Dock tab (column E)
 */
export async function checkSkuInLoadingDock(sku: string): Promise<boolean> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{ exists: boolean }>({
      action: "check-sku-temp-csv",
      sku,
      tabNames: getSheetTabNamesPayload(),
    });
    if (error) {
      console.warn("Could not check Loading Dock for SKU:", error);
      return false;
    }
    return data?.exists ?? false;
  } catch {
    return false;
  }
}

export type DockPendingActionType = "delete" | "email" | "clear" | "send";

export interface DockEntry {
  id: string;
  sku: string;
  processedAt: string;
  submittedAt: string;
  pendingActionType?: DockPendingActionType;
}

// Dead dock-entry cache system removed — getLastGoodDockEntries was never called.
// fetchDockEntries returns [] on error (Google Sheet is single source of truth).

function sanitizeDockEntries(raw: unknown): DockEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DockEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const sku = (row as { sku?: unknown }).sku;
    if (typeof sku !== "string" || !sku.trim()) continue;
    const id = (row as { id?: unknown }).id;
    const processedAt = (row as { processedAt?: unknown }).processedAt;
    const submittedAt = (row as { submittedAt?: unknown }).submittedAt;
    const pendingActionType = (row as { pendingActionType?: unknown }).pendingActionType;
    out.push({
      id: typeof id === "string" && id.trim() ? id : sku,
      sku: sku.trim(),
      processedAt: typeof processedAt === "string" ? processedAt : "",
      submittedAt: typeof submittedAt === "string" ? submittedAt : "",
      pendingActionType:
        pendingActionType === "delete" ||
        pendingActionType === "email" ||
        pendingActionType === "clear" ||
        pendingActionType === "send"
          ? pendingActionType
          : undefined,
    });
  }
  return out;
}

let _lastErrorsMap: Record<string, string> | null = null;
let _lastDockPendingActionsMap: Record<string, DockPendingActionType> | null = null;
let _lastDockEntriesMeta: { stale: boolean; degraded: boolean; error?: string } = {
  stale: false,
  degraded: false,
};

export function getLastErrorsMap(): Record<string, string> | null {
  return _lastErrorsMap;
}

export function getLastDockPendingActionsMap(): Record<string, DockPendingActionType> | null {
  return _lastDockPendingActionsMap ? { ..._lastDockPendingActionsMap } : null;
}

export function getLastDockEntriesMeta(): { stale: boolean; degraded: boolean; error?: string } {
  return { ..._lastDockEntriesMeta };
}

/**
 * Fetches Loading Dock entries from Loading Dock (SKUs) + Events (dates)
 * Also returns formDataMap with pre-parsed form data for each SKU.
 */
export async function fetchDockEntries(options?: { includeFormDataMap?: boolean; includeTitleMap?: boolean }): Promise<DockEntry[]> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{
      entries?: DockEntry[];
      formDataMap?: Record<string, OutputWorkFormData>;
      titleMap?: Record<string, string>;
      errors?: Record<string, string>;
      stale?: boolean;
      degraded?: boolean;
      error?: string;
    }>({
      action: "fetch-dock-entries",
      includeFormDataMap: options?.includeFormDataMap === true,
      includeTitleMap: options?.includeTitleMap === true,
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: EDGE_FUNCTION_DOCK_FETCH_TIMEOUT_MS });
    if (error) {
      console.error("Error fetching dock entries:", error);
      _lastFormDataMap = null;
      _lastFormDataMapMeta = {
        syncedAtMs: 0,
        stale: true,
        degraded: true,
      };
      _lastDockTitleMap = null;
      _lastDockPendingActionsMap = null;
      _lastDockEntriesMeta = {
        stale: true,
        degraded: true,
        error: error.message,
      };
      // On error, return empty — do NOT return stale cached data.
      // The Google Sheet is the single source of truth.
      return [];
    }
    const entries = sanitizeDockEntries(data?.entries);
    const hasFreshDockSnapshot = data?.stale !== true && data?.degraded !== true;
    if (entries.length === 0 && Boolean(data?.stale || data?.degraded || data?.error)) {
      _lastDockEntriesMeta = {
        stale: true,
        degraded: true,
        error: data?.error,
      };
      // Even when stale/degraded, return whatever the sheet reported.
      // Never hallucinate entries from a local cache.
    }
    if (hasFreshDockSnapshot && data?.formDataMap) {
      _lastFormDataMap = data.formDataMap;
      _lastFormDataMapMeta = {
        syncedAtMs: Date.now(),
        stale: false,
        degraded: false,
      };
    } else {
      _lastFormDataMap = null;
      _lastFormDataMapMeta = {
        syncedAtMs: 0,
        stale: data?.stale === true,
        degraded: data?.degraded === true,
      };
    }
    if (hasFreshDockSnapshot && data?.titleMap) {
      _lastDockTitleMap = data.titleMap;
    } else {
      _lastDockTitleMap = null;
    }
    _lastErrorsMap = data?.errors ?? null;
    _lastDockPendingActionsMap = entries.reduce<Record<string, DockPendingActionType>>((acc, entry) => {
      const normalizedSku = entry.sku.trim().toUpperCase();
      if (normalizedSku && entry.pendingActionType) acc[normalizedSku] = entry.pendingActionType;
      return acc;
    }, {});
    _lastDockEntriesMeta = {
      stale: data?.stale === true,
      degraded: data?.degraded === true,
      error: data?.error,
    };
    // Dead dock entry cache removed — Google Sheet is single source of truth.
    return entries;
  } catch (err) {
    console.error("Exception fetching dock entries:", err);
    _lastFormDataMap = null;
    _lastFormDataMapMeta = {
      syncedAtMs: 0,
      stale: true,
      degraded: true,
    };
    _lastDockTitleMap = null;
    _lastDockEntriesMeta = {
      stale: true,
      degraded: true,
      error: err instanceof Error ? err.message : "Unknown error",
    };
    _lastDockPendingActionsMap = null;
    // On exception, return empty — never serve stale cached data.
    return [];
  }
}

/** Last formDataMap from fetchDockEntries — pre-parsed form data for each SKU */
let _lastFormDataMap: Record<string, OutputWorkFormData> | null = null;
let _lastFormDataMapMeta: { syncedAtMs: number; stale: boolean; degraded: boolean } = {
  syncedAtMs: 0,
  stale: true,
  degraded: false,
};
let _lastDockTitleMap: Record<string, string> | null = null;

/** Returns the pre-fetched form data map from the last fetchDockEntries call */
export function getLastFormDataMap(): Record<string, OutputWorkFormData> | null {
  return _lastFormDataMap;
}

export function getLastFormDataMapMeta(): { syncedAtMs: number; stale: boolean; degraded: boolean } {
  return { ..._lastFormDataMapMeta };
}

export function getLastDockTitleMap(): Record<string, string> | null {
  return _lastDockTitleMap;
}

export async function clearDockFailures(skus: string[]): Promise<{ success: boolean; cleared: string[]; skipped: string[]; error?: string }> {
  const normalized = Array.from(new Set(skus.map((s) => (s ?? "").toString().trim()).filter(Boolean)));
  if (normalized.length === 0) return { success: true, cleared: [], skipped: [] };

  try {
    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      cleared?: string[];
      skipped?: string[];
      error?: string;
    }>({
      action: "clear-dock-failures",
      skus: normalized,
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: EDGE_FUNCTION_LOADING_DOCK_ACTION_TIMEOUT_MS });

    if (error) {
      return { success: false, cleared: [], skipped: [], error: error.message };
    }

    if (data?.success === false) {
      return { success: false, cleared: [], skipped: [], error: data.error || "Failed to clear failures" };
    }

    // Force next fetch to recompute errors.
    _lastErrorsMap = null;
    return {
      success: true,
      cleared: (data?.cleared ?? []).map((s) => String(s ?? "").trim()).filter(Boolean),
      skipped: (data?.skipped ?? []).map((s) => String(s ?? "").trim()).filter(Boolean),
    };
  } catch (err) {
    return { success: false, cleared: [], skipped: [], error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Logs a DOCK_DELETE event to the Events tab for the given SKU.
 * The Apps Script onChange trigger (DeleteDock.gs) picks this up
 * and physically removes the 4-row block from the Loading Dock sheet.
 */
export async function logDockDelete(
  sku: string,
  options?: { submittedAt?: string; markComplete?: boolean },
): Promise<{ success: boolean; error?: string; processedAt?: string; pending?: boolean; reason?: string; warning?: string }> {
  try {
    const requestBody: {
      action: "log-dock-delete";
      sku: string;
      submittedAt?: string;
      markComplete?: boolean;
      tabNames: SheetTabNamesPayload;
    } = {
      action: "log-dock-delete",
      sku,
      tabNames: getSheetTabNamesPayload(),
    };
    if (typeof options?.submittedAt === "string" && options.submittedAt.trim()) {
      requestBody.submittedAt = options.submittedAt.trim();
    }
    if (options?.markComplete === true) {
      requestBody.markComplete = true;
    }

    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      error?: string;
      processedAt?: string;
      pending?: boolean;
      reason?: string;
      warning?: string;
    }>(requestBody, { timeoutMs: EDGE_FUNCTION_LOADING_DOCK_ACTION_TIMEOUT_MS });
    if (error) {
      console.error("Error logging DOCK_DELETE event:", error);
      return { success: false, error: error.message };
    }
    return {
      success: data?.success ?? false,
      error: data?.error,
      processedAt: data?.processedAt,
      pending: data?.pending,
      reason: data?.reason,
      warning: data?.warning,
    };
  } catch (err) {
    console.error("Exception logging DOCK_DELETE event:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Reads the email content (column J of the Email row) for a given SKU in Loading Dock.
 */
export async function readDockEmail(
  sku: string,
  options?: { submittedAt?: string },
): Promise<{ success: boolean; email?: string; row?: number; submittedAt?: string; error?: string }> {
  try {
    const requestBody: {
      action: "read-dock-email";
      sku: string;
      submittedAt?: string;
      tabNames: SheetTabNamesPayload;
    } = {
      action: "read-dock-email",
      sku,
      tabNames: getSheetTabNamesPayload(),
    };
    if (typeof options?.submittedAt === "string" && options.submittedAt.trim()) {
      requestBody.submittedAt = options.submittedAt.trim();
    }

    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      email?: string;
      row?: number;
      submittedAt?: string;
      error?: string;
    }>(requestBody, { timeoutMs: EDGE_FUNCTION_READ_ONLY_TIMEOUT_MS });
    if (error) {
      const parsed = extractNotFoundError(error.message);
      return { success: false, error: parsed || error.message };
    }
    return {
      success: data?.success ?? false,
      email: data?.email ?? "",
      row: data?.row,
      submittedAt: typeof data?.submittedAt === "string" ? data.submittedAt : undefined,
      error: data?.error,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Saves (overwrites) the email content (column J of the Email row) for a given SKU in Loading Dock.
 */
export async function saveDockEmail(
  sku: string,
  emailContent: string,
  options?: { submittedAt?: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    const requestBody: {
      action: "save-dock-email";
      sku: string;
      emailContent: string;
      submittedAt?: string;
      tabNames: SheetTabNamesPayload;
    } = {
      action: "save-dock-email",
      sku,
      emailContent,
      tabNames: getSheetTabNamesPayload(),
    };
    if (typeof options?.submittedAt === "string" && options.submittedAt.trim()) {
      requestBody.submittedAt = options.submittedAt.trim();
    }

    const { data, error } = await invokeGoogleSheetsFunction<{ success?: boolean; error?: string }>(
      requestBody,
      { timeoutMs: EDGE_FUNCTION_READ_ONLY_TIMEOUT_MS },
    );
    if (error) {
      const parsed = extractNotFoundError(error.message);
      return { success: false, error: parsed || error.message };
    }
    return { success: data?.success ?? false, error: data?.error };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Reads the Loading Dock block for a given SKU and returns parsed form data.
 * Used by the View / Load into Form actions on the Loading Dock.
 */
export interface OutputWorkFormData {
  sku: string;
  brand: string;
  title: string;
  mainCategory: string;
  selectedCategories: string[];
  imageUrls: string[];
  chatgptData: string;
  chatgptDescription: string;
  emailNotes: string;
  specValues: Record<string, string>;
  price?: string;
  costPrice?: string;
  gpsMpn?: string;
}

export async function readOutputWorkForSku(
  sku: string,
  options?: { timeoutMs?: number; submittedAt?: string },
): Promise<{ success: boolean; formData?: OutputWorkFormData; submittedAt?: string; error?: string }> {
  try {
    const requestBody: {
      action: "read-output-work";
      sku: string;
      submittedAt?: string;
      tabNames: SheetTabNamesPayload;
    } = {
      action: "read-output-work",
      sku,
      tabNames: getSheetTabNamesPayload(),
    };
    if (typeof options?.submittedAt === "string" && options.submittedAt.trim()) {
      requestBody.submittedAt = options.submittedAt.trim();
    }

    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      formData?: OutputWorkFormData;
      submittedAt?: string;
      error?: string;
    }>(
      requestBody,
      { timeoutMs: options?.timeoutMs ?? EDGE_FUNCTION_SLOW_READ_TIMEOUT_MS },
    );
    if (error) {
      const parsed = extractNotFoundError(error.message);
      return { success: false, error: parsed || error.message };
    }
    return {
      success: data?.success ?? false,
      formData: data?.formData,
      submittedAt: typeof data?.submittedAt === "string" ? data.submittedAt : undefined,
      error: data?.error,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function readSkuDetailsFromGoogleSheets(
  sku: string,
): Promise<{ success: boolean; brand?: string; price?: string; visibility?: string; error?: string }> {
  try {
    const trimmedSku = String(sku ?? "").trim();
    if (!trimmedSku) {
      return { success: false, error: "SKU is required" };
    }

    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      brand?: string;
      price?: string;
      visibility?: string;
      error?: string;
    }>({
      action: "read-sku-details",
      sku: trimmedSku,
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: EDGE_FUNCTION_READ_ONLY_TIMEOUT_MS });

    if (error) {
      const parsed = extractNotFoundError(error.message);
      return { success: false, error: parsed || error.message };
    }

    return {
      success: data?.success === true,
      brand: typeof data?.brand === "string" ? data.brand : undefined,
      price: typeof data?.price === "string" ? data.price : undefined,
      visibility: typeof data?.visibility === "string" ? data.visibility : undefined,
      error: data?.error,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function logFormMpnSkuChangeInGoogleSheets(
  draftId: string,
  fromSku: string,
  toSku: string,
): Promise<{ success: boolean; status?: string; attachmentState?: "generated" | "attached"; mpn?: string; error?: string }> {
  try {
    const trimmedDraftId = String(draftId ?? "").trim();
    const trimmedFromSku = String(fromSku ?? "").trim();
    const trimmedToSku = String(toSku ?? "").trim();
    if (!trimmedDraftId) return { success: false, error: "draftId is required" };
    if (!trimmedFromSku) return { success: false, error: "fromSku is required" };
    if (!trimmedToSku) return { success: false, error: "toSku is required" };

    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      status?: string;
      attachmentState?: "generated" | "attached";
      mpn?: string | number;
      error?: string;
    }>({
      action: "log-form-mpn-sku-change",
      draftId: trimmedDraftId,
      fromSku: trimmedFromSku,
      toSku: trimmedToSku,
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: EDGE_FUNCTION_MPN_TIMEOUT_MS });

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: data?.success === true,
      status: typeof data?.status === "string" ? data.status : undefined,
      attachmentState:
        data?.attachmentState === "attached"
          ? "attached"
          : data?.attachmentState === "generated"
            ? "generated"
            : undefined,
      mpn: data?.mpn !== undefined ? String(data.mpn).trim() : undefined,
      error: data?.error,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function peekNextMpnInGoogleSheets(): Promise<{
  success: boolean;
  nextMpn?: number;
  status?: string;
  error?: string;
}> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      nextMpn?: number;
      status?: string;
      error?: string;
    }>({
      action: "mpn-peek",
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: EDGE_FUNCTION_READ_ONLY_TIMEOUT_MS });

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: data?.success === true,
      nextMpn: typeof data?.nextMpn === "number" ? data.nextMpn : undefined,
      status: typeof data?.status === "string" ? data.status : undefined,
      error: data?.error,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function resolveFormMpnStateInGoogleSheets(
  draftId: string,
  sku: string,
  source: "View" | "Send By Email" | "Download",
  options?: { requestedMpn?: string },
): Promise<{
  success: boolean;
  mpn?: string;
  attachmentState?: "generated" | "attached";
  transition?: "generated_new" | "generated_reused" | "generated_and_attached" | "generated_now_attached" | "attached_reused";
  nextMpn?: number;
  status?: string;
  warningTitle?: string;
  warningMessage?: string;
  warningCode?: string;
  error?: string;
}> {
  try {
    const trimmedDraftId = String(draftId ?? "").trim();
    const trimmedSku = String(sku ?? "").trim();
    const trimmedRequestedMpn = String(options?.requestedMpn ?? "").trim();
    if (!trimmedDraftId) return { success: false, error: "draftId is required" };
    if (!trimmedSku) return { success: false, error: "SKU is required" };

    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      mpn?: string | number;
      attachmentState?: "generated" | "attached";
      transition?: "generated_new" | "generated_reused" | "generated_and_attached" | "generated_now_attached" | "attached_reused";
      nextMpn?: number;
      status?: string;
      warningTitle?: string;
      warningMessage?: string;
      warningCode?: string;
      error?: string;
    }>({
      action: "resolve-form-mpn-state",
      draftId: trimmedDraftId,
      sku: trimmedSku,
      source,
      requestedMpn: trimmedRequestedMpn || null,
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: EDGE_FUNCTION_MPN_TIMEOUT_MS });

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: data?.success === true,
      mpn: data?.mpn !== undefined ? String(data.mpn).trim() : undefined,
      attachmentState: data?.attachmentState === "attached" ? "attached" : data?.attachmentState === "generated" ? "generated" : undefined,
      transition:
        data?.transition === "generated_new" ||
        data?.transition === "generated_reused" ||
        data?.transition === "generated_and_attached" ||
        data?.transition === "generated_now_attached" ||
        data?.transition === "attached_reused"
          ? data.transition
          : undefined,
      nextMpn: typeof data?.nextMpn === "number" ? data.nextMpn : undefined,
      status: typeof data?.status === "string" ? data.status : undefined,
      warningTitle: typeof data?.warningTitle === "string" ? data.warningTitle : undefined,
      warningMessage: typeof data?.warningMessage === "string" ? data.warningMessage : undefined,
      warningCode: typeof data?.warningCode === "string" ? data.warningCode : undefined,
      error: data?.error,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function releaseFormGeneratedMpnInGoogleSheets(
  draftId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const trimmedDraftId = String(draftId ?? "").trim();
    if (!trimmedDraftId) return { success: false, error: "draftId is required" };

    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      error?: string;
    }>({
      action: "release-form-generated-mpn",
      draftId: trimmedDraftId,
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: EDGE_FUNCTION_MPN_TIMEOUT_MS });

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: data?.success === true,
      error: data?.error,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Parses a product CSV into the same form-data shape used by the Product Entry form,
 * without writing through OUTPUT_Work or Loading Dock.
 */
/**
 * Checks the current status of a SKU in PRODUCTS TO DO and whether a recent SUBMIT exists.
 * Used as a pre-flight safety check before submit or NOT_FOR_SALE actions.
 */
export async function checkSkuStatusFresh(sku: string): Promise<{ status: string; recentSubmit: boolean }> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{ status: string; recentSubmit: boolean }>({
      action: "check-sku-status",
      sku,
      tabNames: getSheetTabNamesPayload(),
    });
    if (error) {
      console.warn("Could not check SKU status:", error);
      return { status: "", recentSubmit: false };
    }
    return { status: data?.status ?? "", recentSubmit: false }; // Decoupled from Loading Dock SUBMIT queue
  } catch {
    return { status: "", recentSubmit: false };
  }
}

export async function checkDockRowStatus(sku: string): Promise<{
  success: boolean;
  existsInDock: boolean;
  pending: boolean;
  dockActionPending: boolean;
  actionable: boolean;
  pendingActionType?: DockPendingActionType;
  latestSubmittedAt?: string;
  error?: string;
}> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      existsInDock?: boolean;
      pending?: boolean;
      dockActionPending?: boolean;
      actionable?: boolean;
      pendingActionType?: DockPendingActionType;
      latestSubmittedAt?: string;
      error?: string;
    }>({
      action: "check-dock-row-status",
      sku,
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: 8_000 });
    if (error) {
      return {
        success: false,
        existsInDock: false,
        pending: false,
        dockActionPending: false,
        actionable: false,
        latestSubmittedAt: undefined,
        error: error.message,
      };
    }
    return {
      success: data?.success === true,
      existsInDock: data?.existsInDock === true,
      pending: data?.pending === true,
      dockActionPending: data?.dockActionPending === true,
      actionable: data?.actionable === true,
      pendingActionType:
        data?.pendingActionType === "delete" ||
        data?.pendingActionType === "email" ||
        data?.pendingActionType === "clear" ||
        data?.pendingActionType === "send"
          ? data.pendingActionType
          : undefined,
      latestSubmittedAt: typeof data?.latestSubmittedAt === "string" ? data.latestSubmittedAt : undefined,
      error: data?.error,
    };
  } catch (err) {
    return {
      success: false,
      existsInDock: false,
      pending: false,
      dockActionPending: false,
      actionable: false,
      latestSubmittedAt: undefined,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Uploads a 2-row CSV, stages it through OUTPUT_Work, and completes the Loading Dock write in the edge function.
 */
export async function uploadCsvToOutputWork(
  csvText: string,
): Promise<{ success: boolean; sku?: string; error?: string; pending?: boolean; processedAt?: string; submittedAtEpochMs?: number }> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      sku?: string;
      error?: string;
      pending?: boolean;
      processedAt?: string;
      submittedAtEpochMs?: number;
    }>(
      {
        action: "upload-csv",
        csvText,
        tabNames: getSheetTabNamesPayload(),
      },
      { timeoutMs: EDGE_FUNCTION_WRITE_TIMEOUT_MS },
    );
      if (error) {
        if (isEdgeFunctionTimeoutErrorMessage(error.message)) {
          const parsedSku = extractSkuFromCsvText(csvText);
          const queued = parsedSku ? await confirmDockWriteQueued(parsedSku) : { queued: false };
          if (queued.queued) return { success: true, pending: true, sku: parsedSku, submittedAtEpochMs: queued.submittedAtEpochMs };
          return { success: false, error: parsedSku
            ? `CSV upload timed out before queue confirmation for SKU "${parsedSku}". Please retry.`
            : "CSV upload timed out before queue confirmation. Please retry." };
        }
        return { success: false, error: error.message };
    }
    if (!data?.success) {
      return { success: false, error: data?.error || "Upload failed" };
    }
    return {
      success: true,
      sku: data?.sku,
      pending: data?.pending === true,
      processedAt: data?.processedAt,
      submittedAtEpochMs:
        Number.isFinite(Number(data?.submittedAtEpochMs)) && Number(data?.submittedAtEpochMs) > 0
          ? Number(data?.submittedAtEpochMs)
          : undefined,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  } finally {
    invalidateReadCache();
  }
}

/**
 * Downloads the header+product rows for a given SKU from the Loading Dock as CSV text.
 */
export async function downloadCsvForSku(
  sku: string,
  options?: { submittedAt?: string },
): Promise<{ success: boolean; csvText?: string; submittedAt?: string; error?: string }> {
  try {
    const requestBody: {
      action: "download-csv";
      sku: string;
      submittedAt?: string;
      tabNames: SheetTabNamesPayload;
    } = {
      action: "download-csv",
      sku,
      tabNames: getSheetTabNamesPayload(),
    };
    if (typeof options?.submittedAt === "string" && options.submittedAt.trim()) {
      requestBody.submittedAt = options.submittedAt.trim();
    }

    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      csvText?: string;
      submittedAt?: string;
      error?: string;
    }>(
      requestBody,
      { timeoutMs: EDGE_FUNCTION_SLOW_READ_TIMEOUT_MS },
    );
    if (error) {
      const parsed = extractNotFoundError(error.message);
      return { success: false, error: parsed || error.message };
    }
    return {
      success: data?.success ?? false,
      csvText: data?.csvText,
      submittedAt: typeof data?.submittedAt === "string" ? data.submittedAt : undefined,
      error: data?.error,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Logs an EMAIL_SINGLE event to the Events tab for the given SKU.
 * The Apps Script onChange trigger picks this up and sends an email
 * with a 2-row CSV attachment for the SKU.
 */
export async function logEmailSingle(
  sku: string,
  options?: { submittedAt?: string },
): Promise<{
  success: boolean;
  error?: string;
  processedAt?: string;
  pending?: boolean;
  reason?: string;
  warning?: string;
  eventId?: string;
  eventRowNumber?: number;
}> {
  try {
    const requestBody: {
      action: "log-email-single";
      sku: string;
      submittedAt?: string;
      tabNames: SheetTabNamesPayload;
    } = {
      action: "log-email-single",
      sku,
      tabNames: getSheetTabNamesPayload(),
    };
    if (typeof options?.submittedAt === "string" && options.submittedAt.trim()) {
      requestBody.submittedAt = options.submittedAt.trim();
    }

    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      error?: string;
      processedAt?: string;
      pending?: boolean;
      reason?: string;
      warning?: string;
      eventId?: string;
      eventRowNumber?: number;
    }>(requestBody, { timeoutMs: EDGE_FUNCTION_LOADING_DOCK_ACTION_TIMEOUT_MS });

    if (error) {
      console.error("Error logging EMAIL_SINGLE event:", error);
      return { success: false, error: error.message };
    }

    return {
      success: data?.success ?? false,
      error: data?.error,
      processedAt: data?.processedAt,
      pending: data?.pending,
      reason: data?.reason,
      warning: data?.warning,
      eventId: data?.eventId,
      eventRowNumber: data?.eventRowNumber,
    };
  } catch (err) {
    console.error("Exception logging EMAIL_SINGLE event:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function sendFormEmail(productData: {
  sku: string;
  mpnDraftId?: string;
  brand: string;
  title: string;
  mainCategory: string;
  additionalCategories: string[];
  imageUrls: string[];
  specifications: Record<string, string>;
  chatgptDescription?: string;
  chatgptData?: string;
  emailNotes?: string;
  price?: string;
  customFields?: string;
  gpsMpn?: string;
  retailPrice?: string;
}): Promise<{ success: boolean; error?: string; mpn?: string; pending?: boolean; reason?: string; eventId?: string; eventRowNumber?: number; warningTitle?: string; warningMessage?: string; retailPrice?: string }> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      error?: string;
      mpn?: string;
      pending?: boolean;
      reason?: string;
      eventId?: string;
      eventRowNumber?: number;
      warningTitle?: string;
      warningMessage?: string;
      retailPrice?: string;
    }>({
      action: "send-form-email",
      productData,
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: EDGE_FUNCTION_FORM_SEND_TIMEOUT_MS });

    if (error) {
      console.error("Error sending form email:", error);
      return { success: false, error: error.message };
    }

    return {
      success: data?.success ?? false,
      error: data?.error,
      mpn: typeof data?.mpn === "string" ? data.mpn : undefined,
      pending: data?.pending === true,
      reason: typeof data?.reason === "string" ? data.reason : undefined,
      eventId: typeof data?.eventId === "string" ? data.eventId : undefined,
      eventRowNumber: typeof data?.eventRowNumber === "number" ? data.eventRowNumber : undefined,
      warningTitle: typeof data?.warningTitle === "string" ? data.warningTitle : undefined,
      warningMessage: typeof data?.warningMessage === "string" ? data.warningMessage : undefined,
      retailPrice: typeof data?.retailPrice === "string" ? data.retailPrice : undefined,
    };
  } catch (err) {
    console.error("Exception sending form email:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function downloadFormCsv(productData: {
  sku: string;
  mpnDraftId?: string;
  brand: string;
  title: string;
  mainCategory: string;
  additionalCategories: string[];
  imageUrls: string[];
  specifications: Record<string, string>;
  chatgptDescription?: string;
  chatgptData?: string;
  emailNotes?: string;
  price?: string;
  customFields?: string;
  gpsMpn?: string;
  retailPrice?: string;
}): Promise<{ success: boolean; error?: string; csvText?: string; filename?: string; mpn?: string; warningTitle?: string; warningMessage?: string; retailPrice?: string }> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      error?: string;
      csvText?: string;
      filename?: string;
      mpn?: string;
      warningTitle?: string;
      warningMessage?: string;
      retailPrice?: string;
    }>({
      action: "download-form-csv",
      productData,
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: EDGE_FUNCTION_FORM_DOWNLOAD_TIMEOUT_MS });

    if (error) {
      console.error("Error downloading form CSV:", error);
      return { success: false, error: error.message };
    }

    return {
      success: data?.success ?? false,
      error: data?.error,
      csvText: typeof data?.csvText === "string" ? data.csvText : undefined,
      filename: typeof data?.filename === "string" ? data.filename : undefined,
      mpn: typeof data?.mpn === "string" ? data.mpn : undefined,
      warningTitle: typeof data?.warningTitle === "string" ? data.warningTitle : undefined,
      warningMessage: typeof data?.warningMessage === "string" ? data.warningMessage : undefined,
      retailPrice: typeof data?.retailPrice === "string" ? data.retailPrice : undefined,
    };
  } catch (err) {
    console.error("Exception downloading form CSV:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Logs a SEND_DOCK event with ALL SKUs in a single event row.
 * Mode: "SEND" = email + delete + mark COMPLETE, "CLEAR" = delete only.
 * The Apps Script (SendDock.gs) processes everything in one batch.
 */
export async function logSendDock(
  skus: string[],
  mode: "SEND" | "CLEAR",
): Promise<{
  success: boolean;
  error?: string;
  deleted?: number;
  emailed?: number;
  summary?: string;
  processedAt?: string;
  pending?: boolean;
  reason?: string;
  warning?: string;
}> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{
      success?: boolean;
      error?: string;
      deleted?: number;
      emailed?: number;
      summary?: string;
      processedAt?: string;
      pending?: boolean;
      reason?: string;
      warning?: string;
    }>({
      action: "log-send-dock",
      skus: skus.join(","),
      mode,
      tabNames: getSheetTabNamesPayload(),
    }, { timeoutMs: EDGE_FUNCTION_LOADING_DOCK_ACTION_TIMEOUT_MS });

    if (error) {
      console.error("Error logging SEND_DOCK event:", error);
      return { success: false, error: error.message };
    }

    return {
      success: data?.success ?? false,
      error: data?.error,
      deleted: data?.deleted,
      emailed: data?.emailed,
      summary: data?.summary,
      processedAt: data?.processedAt,
      pending: data?.pending,
      reason: data?.reason,
      warning: data?.warning,
    };
  } catch (err) {
    console.error("Exception logging SEND_DOCK event:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Writes an AI logging entry to the AI_Logging tab.
 * Includes word-level diff data for rich text formatting.
 * Non-blocking — failures are logged but don't break the submit flow.
 */
export async function writeAiLogEntry(
  logEntry: {
    sku: string;
    timestamp: string;
    aiData?: { generated: string; edited: string };
    aiDescription?: { generated: string; edited: string };
    filters?: { generated: string; edited: string };
    conflicts?: string;
    diffs?: Record<string, Array<{ t: string; d: "u" | "a" | "r" }>>;
    replaceRowNumber?: number;
  },
) : Promise<{ success: boolean; error?: string; rowNumber?: number }> {
  try {
    const { data, error } = await invokeGoogleSheetsFunction<{ success?: boolean; error?: string; rowNumber?: number }>({
      action: "write-ai-log",
      logEntry,
      tabNames: getSheetTabNamesPayload(),
    });
    if (error) {
      console.error("Error writing AI log:", error);
      return { success: false, error: error.message };
    }
    return {
      success: data?.success ?? false,
      rowNumber: Number.isFinite(Number(data?.rowNumber)) ? Number(data?.rowNumber) : undefined,
    };
  } catch (err) {
    console.error("Exception writing AI log:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
