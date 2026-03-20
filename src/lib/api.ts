// ============================================================
// API Layer – wraps all backend calls.
// Priority order:
// 1. Supabase Edge Function (if Google Sheets credentials configured)
// 2. Apps Script URL (if APPS_SCRIPT_BASE_URL is set)
// 3. Mock/fallback data
// ============================================================

import { config } from "@/config";
import { defaultProducts } from "@/data/defaultProducts";
import {
  defaultProperties,
  defaultLegalValues,
  type PropertyDefinition,
  type LegalValue,
} from "@/data/defaultProperties";
import { categoryTree, type CategoryLevel } from "@/data/categoryData";
import {
  isSupabaseGoogleSheetsConfigured,
  readGoogleSheets,
  writeCategoriesToGoogleSheets,
  writeBrandsToGoogleSheets,
  writeLegalValueToGoogleSheets,
  writeProductToOutputWork,
  updateSkuVisibility,
  updateSkuStatus,
  fetchDockEntries,
  logDockDelete,
  logSendDock,
  readSkuDetailsFromGoogleSheets,
  logFormMpnSkuChangeInGoogleSheets,
  peekNextMpnInGoogleSheets,
  resolveFormMpnStateInGoogleSheets,
  releaseFormGeneratedMpnInGoogleSheets,
  sendFormEmail,
  downloadFormCsv,
} from "@/lib/supabaseGoogleSheets";
import { createDuplicateTitleSubmitError, type DuplicateTitleSource } from "@/lib/duplicateTitleGuard";
import { ensureSubmitRequestId } from "@/lib/submitRequestId";

const BASE = () => config.APPS_SCRIPT_BASE_URL;
const APPS_SCRIPT_TIMEOUT_MS = 20_000;

function isConfigured(): boolean {
  return Boolean(BASE());
}

async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${BASE()}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), APPS_SCRIPT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`API ${path} timed out after ${APPS_SCRIPT_TIMEOUT_MS / 1000}s`);
    }
    throw error instanceof Error ? error : new Error(`API ${path} request failed`);
  }
  clearTimeout(timeoutId);
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`API ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── SKUs ────────────────────────────────────────────────────

export interface SkuEntry {
  sku: string;
  brand: string;
  status: string;
  visibility?: number;
  exampleTitle?: string;
  price?: number | string;
}

function normalizeLookupValue(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function resolveBrandName(
  brand: unknown,
  brands?: Array<{ brand: string; brandName: string }>,
): string {
  const trimmedBrand = String(brand ?? "").trim();
  if (!trimmedBrand) return "";
  const match = brands?.find((entry) => normalizeLookupValue(entry.brand) === normalizeLookupValue(trimmedBrand));
  return String(match?.brandName ?? "").trim() || trimmedBrand;
}

function resolveBrandNameForSku(
  sku: unknown,
  products?: Array<{ sku: string; brand: string }>,
  brands?: Array<{ brand: string; brandName: string }>,
): string {
  const normalizedSku = normalizeLookupValue(sku);
  const productBrand = products?.find((entry) => normalizeLookupValue(entry.sku) === normalizedSku)?.brand;
  return resolveBrandName(productBrand, brands);
}

export async function fetchSkus(
  status?: string
): Promise<SkuEntry[]> {
  // Try Supabase Google Sheets first
  if (isSupabaseGoogleSheetsConfigured()) {
    try {
      const data = await readGoogleSheets();
      if (data.products && !data.useDefaults) {
        return data.products
          .map((p) => ({
            sku: String(p.sku ?? "").trim(),
            brand: resolveBrandNameForSku(p.sku, data.products, data.brands),
            status: config.STATUS_TO_DO,
            visibility: 1,
            exampleTitle: String(p.exampleTitle ?? "").trim(),
            price: typeof p.price === "string" ? p.price.trim() : p.price,
          }))
          .filter((s) => !status || s.status === status)
          .filter((s) => (s.visibility ?? 0) === 1);
      }
    } catch (error) {
      console.error("Error fetching from Supabase Google Sheets:", error);
      // sheet sync failed
    }
  }

  // Fall back to Apps Script if configured
  if (!isConfigured()) {
    return defaultProducts
      .map((p) => ({
        sku: p.sku,
        brand: p.brand,
        status: config.STATUS_TO_DO,
        visibility: 1,
        exampleTitle: p.exampleTitle,
      }))
      .filter((s) => !status || s.status === status)
      .filter((s) => (s.visibility ?? 0) === 1);
  }
  return apiFetch<SkuEntry[]>(
    `/skus${status ? `?status=${encodeURIComponent(status)}` : ""}`
  );
}

// ── Brand Lookup ────────────────────────────────────────────

export async function fetchBrand(sku: string): Promise<string> {
  // Try Supabase Google Sheets first
  if (isSupabaseGoogleSheetsConfigured()) {
    try {
      const data = await readGoogleSheets();
      if (data.products && !data.useDefaults) {
        const resolvedBrand = resolveBrandNameForSku(sku, data.products, data.brands);
        if (resolvedBrand) return resolvedBrand;
      }
    } catch (error) {
      console.error("Error fetching brand from Supabase Google Sheets:", error);
      // sheet sync failed
    }
  }

  // Fall back to Apps Script or defaults
  if (!isConfigured()) {
    const found = defaultProducts.find((p) => p.sku === sku);
    return found?.brand ?? "";
  }
  const data = await apiFetch<{ brand: string }>(
    `/brand?sku=${encodeURIComponent(sku)}`
  );
  return data.brand;
}

export interface SkuSheetDetails {
  brand: string;
  price: string;
  visibility: string;
}

export async function fetchSkuSheetDetails(sku: string): Promise<SkuSheetDetails> {
  const trimmedSku = String(sku ?? "").trim();
  if (!trimmedSku) return { brand: "", price: "", visibility: "" };
  const isSkuNotFoundMessage = (message: string): boolean =>
    /SKU\s+"[^"]+"\s+(?:not found|was not found)/i.test(String(message ?? ""));

  if (isSupabaseGoogleSheetsConfigured()) {
    try {
      const result = await readSkuDetailsFromGoogleSheets(trimmedSku);
      if (result.success) {
        return {
          brand: String(result.brand ?? "").trim(),
          price: String(result.price ?? "").trim(),
          visibility: String(result.visibility ?? "").trim(),
        };
      }
      if (isSkuNotFoundMessage(result.error || "")) {
        return { brand: "", price: "", visibility: "" };
      }
    } catch (error) {
      console.error("Error fetching SKU details from Supabase Google Sheets:", error);
    }
  }

  try {
    const data = await readGoogleSheets();
    if (data.products && !data.useDefaults) {
      const normalizedSku = trimmedSku.toUpperCase();
      const found = data.products.find((p) => String(p.sku ?? "").trim().toUpperCase() === normalizedSku);
      if (found) {
        return {
          brand: resolveBrandNameForSku(found.sku, data.products, data.brands),
          price: String(found.price ?? "").trim(),
          visibility: "",
        };
      }
    }
  } catch (error) {
    console.error("Error falling back to readGoogleSheets() for SKU details:", error);
  }

  if (!isConfigured()) {
    const found = defaultProducts.find((p) => String(p.sku ?? "").trim().toUpperCase() === trimmedSku.toUpperCase());
    return {
      brand: String(found?.brand ?? "").trim(),
      price: "",
      visibility: "",
    };
  }

  const brand = await fetchBrand(trimmedSku).catch((error) => {
    if (error instanceof Error && isSkuNotFoundMessage(error.message)) {
      return "";
    }
    return "";
  });
  return { brand: String(brand ?? "").trim(), price: "", visibility: "" };
}

export async function logFormMpnSkuChangeDirect(
  draftId: string,
  fromSku: string,
  toSku: string,
): Promise<{ status?: string; attachmentState?: "generated" | "attached"; mpn?: string }> {
  const trimmedDraftId = String(draftId ?? "").trim();
  const trimmedFromSku = String(fromSku ?? "").trim();
  const trimmedToSku = String(toSku ?? "").trim();
  if (!trimmedDraftId) {
    throw new Error("draftId is required before logging the MPN SKU change.");
  }
  if (!trimmedFromSku) {
    throw new Error("fromSku is required before logging the MPN SKU change.");
  }
  if (!trimmedToSku) {
    throw new Error("toSku is required before logging the MPN SKU change.");
  }

  const result = await logFormMpnSkuChangeInGoogleSheets(trimmedDraftId, trimmedFromSku, trimmedToSku);
  if (!result.success) {
    throw new Error(result.error || "Could not update the MPN SKU change state.");
  }

  return {
    status: typeof result.status === "string" ? result.status : undefined,
    attachmentState: result.attachmentState,
    mpn: result.mpn,
  };
}

export async function peekNextMpnDirect(): Promise<string> {
  const result = await peekNextMpnInGoogleSheets();
  if (!result.success) {
    throw new Error(result.error || "Could not load the next MPN.");
  }
  const nextMpn = Number(result.nextMpn);
  if (!Number.isFinite(nextMpn) || nextMpn <= 0) {
    throw new Error("Edge function did not return a valid next MPN.");
  }
  return String(nextMpn);
}

export async function resolveFormMpnStateDirect(
  draftId: string,
  sku: string,
  source: "View" | "Send By Email" | "Download",
  options?: { requestedMpn?: string },
): Promise<{
  mpn: string;
  attachmentState: "generated" | "attached";
  transition: "generated_new" | "generated_reused" | "generated_and_attached" | "generated_now_attached" | "attached_reused";
  warningTitle?: string;
  warningMessage?: string;
  warningCode?: string;
}> {
  const trimmedDraftId = String(draftId ?? "").trim();
  const trimmedSku = String(sku ?? "").trim();
  if (!trimmedDraftId) {
    throw new Error("draftId is required before resolving the MPN state.");
  }
  if (!trimmedSku) {
    throw new Error("SKU is required before resolving the MPN state.");
  }

  const result = await resolveFormMpnStateInGoogleSheets(trimmedDraftId, trimmedSku, source, options);
  if (!result.success) {
    throw new Error(result.error || "Could not resolve MPN state.");
  }

  const mpn = String(result.mpn ?? "").trim();
  if (!mpn) {
    throw new Error("Edge function did not return an MPN.");
  }

  if (
    result.transition !== "generated_new" &&
    result.transition !== "generated_reused" &&
    result.transition !== "generated_and_attached" &&
    result.transition !== "generated_now_attached" &&
    result.transition !== "attached_reused"
  ) {
    throw new Error("Edge function did not return a valid MPN transition.");
  }

  return {
    mpn,
    attachmentState: result.attachmentState === "attached" ? "attached" : "generated",
    transition: result.transition,
    warningTitle: result.warningTitle,
    warningMessage: result.warningMessage,
    warningCode: result.warningCode,
  };
}

export async function releaseFormGeneratedMpnDirect(
  draftId: string,
): Promise<void> {
  const trimmedDraftId = String(draftId ?? "").trim();
  if (!trimmedDraftId) return;

  const result = await releaseFormGeneratedMpnInGoogleSheets(trimmedDraftId);
  if (!result.success) {
    throw new Error(result.error || "Could not release the generated MPN.");
  }
}

// ── Categories ──────────────────────────────────────────────

/** Result wrapper that tracks whether data came from live Google Sheet */
export interface CategoriesFetchResult {
  categories: CategoryLevel[];
  source: "google-sheets" | "apps-script" | "defaults";
}

export async function fetchCategoriesWithSource(): Promise<CategoriesFetchResult> {
  // Always try the edge function first - it uses server-side Supabase secrets
  try {
    const data = await readGoogleSheets();
    if (!data.useDefaults && data.categories && data.categories.length > 0) {
      console.log("✓ Categories loaded from Google Sheets");
      return { categories: data.categories, source: "google-sheets" };
    }
    if (!data.useDefaults && (!data.categories || data.categories.length === 0)) {
      throw new Error("CATEGORIES tab is empty. Add category paths to the CATEGORIES sheet, starting at row 2.");
    }
  } catch (error) {
    console.error("Error fetching from Google Sheets:", error);
    // Fall through to fallback
  }

  // Fallback to Apps Script or defaults
  if (!isConfigured()) {
    console.log("No Apps Script URL configured, using default category tree");
    return { categories: categoryTree, source: "defaults" };
  }
  
  try {
    const cats = await apiFetch<CategoryLevel[]>("/categories");
    return { categories: cats, source: "apps-script" };
  } catch (error) {
    console.warn("Apps Script also failed, using defaults:", error);
    return { categories: categoryTree, source: "defaults" };
  }
}

/** Legacy wrapper – still used by non-admin pages that just need categories */
export async function fetchCategories(): Promise<CategoryLevel[]> {
  const result = await fetchCategoriesWithSource();
  return result.categories;
}

export async function updateCategories(
  paths: string[]
): Promise<void> {
  // Always write via Supabase Edge Function (uses server-side secrets)
  try {
    const success = await writeCategoriesToGoogleSheets(paths);
    if (!success) {
      throw new Error("Failed to write categories to Google Sheets");
    }
    console.log("Categories successfully updated in Google Sheets");
  } catch (error) {
    console.error("FATAL: Error updating categories in Google Sheets:", error);
    throw new Error(
      `Failed to save categories to Google Sheet: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

// ── Properties & Legal Values ───────────────────────────────

export async function fetchProperties(): Promise<{
  properties: PropertyDefinition[];
  legalValues: LegalValue[];
  masterLookup?: Array<{ defaultName: string; categoryPath: string; nameStructure?: string; nameExample?: string }>;
  masterDefaults?: Array<{ name: string; allowedProperties: string[] }>;
  existingTitles?: string[];
}> {
  // Try Supabase Google Sheets first
  if (isSupabaseGoogleSheetsConfigured()) {
    try {
      const data = await readGoogleSheets();
      if (data.properties && data.legalValues && !data.useDefaults) {
        
        return {
          properties: data.properties,
          legalValues: data.legalValues,
          masterLookup: data.masterLookup,
          masterDefaults: data.masterDefaults,
          existingTitles: data.existingTitles,
        };
      }
      if (data.useDefaults) {
        return { properties: [], legalValues: [] };
      }
    } catch (error) {
      console.error("Error fetching properties from Supabase Google Sheets:", error);
    }
  }

  // Fall back to Apps Script or defaults
  if (!isConfigured()) {
    return { properties: [], legalValues: [] };
  }
  return apiFetch("/properties");
}

// ── Add Legal Value (for "Other…" option) ───────────────────

export async function addLegalValue(
  propertyName: string,
  value: string
): Promise<void> {
  if (isSupabaseGoogleSheetsConfigured()) {
    const success = await writeLegalValueToGoogleSheets(propertyName, value);
    if (!success) {
      throw new Error("Failed to write legal value to Google Sheets");
    }
    return;
  }

  if (!isConfigured()) {
    console.log("[mock] addLegalValue:", propertyName, value);
    return;
  }

  await apiFetch("/legal/add", {
    method: "POST",
    body: JSON.stringify({ propertyName, value }),
  });
}

// ── Submit Product ──────────────────────────────────────────

export interface ProductPayload {
  requestId?: string;
  sku: string;
  mpnDraftId?: string;
  gpsMpn?: string;
  brand: string;
  title: string;
  mainCategory: string;
  additionalCategories: string[];
  imageUrls: string[];
  specifications: Record<string, string>;
  chatgptData?: string;
  chatgptDescription?: string;
  emailNotes?: string;
  datasheetUrl?: string;
  webpageUrl?: string;
  timestamp: string;
  dockCount?: number;
  price?: string;
  retailPrice?: string;
  customFields?: string;
  productVisible?: boolean;
  isOverwrite?: boolean;
  duplicateTitleConfirmed?: boolean;
  loadedDockSubmissionEpochMs?: number;
}

export async function submitProduct(
  payload: ProductPayload
): Promise<{ success: boolean; pending?: boolean; processedAt?: string; submittedAtEpochMs?: number; reason?: string }> {
  const payloadWithRequestId = ensureSubmitRequestId(payload);
  // Try writing to OUTPUT_Work via edge function (preferred path)
  if (isSupabaseGoogleSheetsConfigured()) {
    const result = await writeProductToOutputWork({
      requestId: payloadWithRequestId.requestId,
      sku: payloadWithRequestId.sku,
      brand: payloadWithRequestId.brand,
      title: payloadWithRequestId.title,
      mainCategory: payloadWithRequestId.mainCategory,
      additionalCategories: payloadWithRequestId.additionalCategories,
      imageUrls: payloadWithRequestId.imageUrls,
      specifications: payloadWithRequestId.specifications,
      chatgptDescription: payloadWithRequestId.chatgptDescription,
      chatgptData: payloadWithRequestId.chatgptData,
      emailNotes: payloadWithRequestId.emailNotes,
      price: payloadWithRequestId.price,
      productVisible: payloadWithRequestId.productVisible != null ? String(payloadWithRequestId.productVisible) : undefined,
      customFields: payloadWithRequestId.customFields,
      dockCount: payloadWithRequestId.dockCount,
      isOverwrite: payloadWithRequestId.isOverwrite,
      duplicateTitleConfirmed: payloadWithRequestId.duplicateTitleConfirmed,
      loadedDockSubmissionEpochMs: payloadWithRequestId.loadedDockSubmissionEpochMs,
    });
    if (!result.success) {
      if (result.errorCode === "DUPLICATE_TITLE" && result.requiresConfirmation) {
        throw createDuplicateTitleSubmitError({
          title: result.duplicateTitle || payloadWithRequestId.title,
          sources: (result.duplicateTitleSources ?? []) as DuplicateTitleSource[],
        });
      }
      throw new Error(result.error || "Failed to write product to OUTPUT_Work");
    }
    return {
      success: true,
      pending: result.pending === true,
      processedAt: result.processedAt,
      submittedAtEpochMs: result.submittedAtEpochMs,
      reason: result.reason,
    };
  }

  if (!isConfigured()) {
    console.log("[mock] submitProduct payload:", payloadWithRequestId);
    return { success: true };
  }
  return apiFetch("/submitProduct", {
    method: "POST",
    body: JSON.stringify(payloadWithRequestId),
  });
}

export async function sendProductByEmail(
  payload: ProductPayload,
): Promise<{ success: boolean; error?: string; mpn?: string; pending?: boolean; reason?: string; eventId?: string; eventRowNumber?: number; warningTitle?: string; warningMessage?: string; retailPrice?: string }> {
  if (isSupabaseGoogleSheetsConfigured()) {
    return await sendFormEmail({
      sku: payload.sku,
      mpnDraftId: payload.mpnDraftId,
      gpsMpn: payload.gpsMpn,
      brand: payload.brand,
      title: payload.title,
      mainCategory: payload.mainCategory,
      additionalCategories: payload.additionalCategories,
      imageUrls: payload.imageUrls,
      specifications: payload.specifications,
      chatgptDescription: payload.chatgptDescription,
      chatgptData: payload.chatgptData,
      emailNotes: payload.emailNotes,
      price: payload.price,
      customFields: payload.customFields,
      retailPrice: payload.retailPrice,
    });
  }

  if (!isConfigured()) {
    return { success: false, error: "Google Sheets backend is not configured." };
  }

  return { success: false, error: "Apps Script fallback is not implemented for direct form email." };
}

export async function downloadProductCsv(
  payload: ProductPayload,
): Promise<{ success: boolean; error?: string; csvText?: string; filename?: string; mpn?: string; warningTitle?: string; warningMessage?: string; retailPrice?: string }> {
  if (isSupabaseGoogleSheetsConfigured()) {
    return await downloadFormCsv({
      sku: payload.sku,
      mpnDraftId: payload.mpnDraftId,
      gpsMpn: payload.gpsMpn,
      brand: payload.brand,
      title: payload.title,
      mainCategory: payload.mainCategory,
      additionalCategories: payload.additionalCategories,
      imageUrls: payload.imageUrls,
      specifications: payload.specifications,
      chatgptDescription: payload.chatgptDescription,
      chatgptData: payload.chatgptData,
      emailNotes: payload.emailNotes,
      price: payload.price,
      customFields: payload.customFields,
      retailPrice: payload.retailPrice,
    });
  }

  if (!isConfigured()) {
    return { success: false, error: "Google Sheets backend is not configured." };
  }

  return { success: false, error: "Apps Script fallback is not implemented for direct form download." };
}

// ── Recent Submissions / Dock Entries ────────────────────────

export interface RecentSubmission {
  id: string;
  sku: string;
  submittedAt: string;
  processedAt?: string;
  pendingActionType?: "delete" | "email" | "clear" | "send";
}

export async function fetchRecentSubmissions(options?: { includeFormDataMap?: boolean; includeTitleMap?: boolean }): Promise<
  RecentSubmission[]
> {
  // Try fetching from Google Sheets (Loading Dock + Events)
  if (isSupabaseGoogleSheetsConfigured()) {
    try {
      const entries = await fetchDockEntries(options);
      return entries.map((e) => ({
        id: e.id,
        sku: e.sku,
        submittedAt: e.submittedAt,
        processedAt: e.processedAt,
        pendingActionType: e.pendingActionType,
      }));
    } catch (error) {
      console.error("Error fetching dock entries:", error);
    }
  }

  if (!isConfigured()) {
    return [];
  }
  return apiFetch("/recentSubmissions");
}

// ── Delete Submission ───────────────────────────────────────

/**
 * Logs a DOCK_DELETE event to the Events tab for the given SKU.
 * The Apps Script onChange trigger (DeleteDock.gs) picks this up
 * and physically removes the 4-row block from the Loading Dock sheet.
 */
export async function deleteSubmission(
  id: string,
  sku?: string,
  options?: { submittedAt?: string; markComplete?: boolean },
): Promise<{ success: boolean; pending?: boolean; reason?: string; warning?: string }> {
  // If we have a SKU, log a DOCK_DELETE event via the edge function.
  // The Apps Script will then delete the 4-row block from the Loading Dock sheet.
  if (sku && isSupabaseGoogleSheetsConfigured()) {
    const result = await logDockDelete(sku, options);
    if (!result.success) {
      throw new Error(result.error || "Failed to log DOCK_DELETE event");
    }
    return { success: true, pending: result.pending === true, reason: result.reason, warning: result.warning };
  }

  // Fallback: Apps Script direct call (legacy)
  if (!isConfigured()) {
    console.log("[mock] deleteSubmission:", id, sku);
    return { success: true };
  }
  await apiFetch("/submissions/delete", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return { success: true };
}

// ── Send All & Clear Dock ───────────────────────────────────

/**
 * Logs a single SEND_DOCK event with mode=SEND for all SKUs.
 * The Apps Script (SendDock.gs) handles emailing, deletion,
 * and marking COMPLETE in one batch operation.
 */
export async function sendAllAndClearDock(
  skus: string[],
): Promise<{ sent: number; failed: string[]; pending?: boolean; reason?: string }> {
  const result = await logSendDock(skus, "SEND");

  if (!result.success) {
    return { sent: result.emailed ?? 0, failed: [result.error || "Failed to process SEND_DOCK event"] };
  }

  // Pending means the event is queued but not yet verified as complete.
  if (result.pending) {
    return {
      sent: result.emailed ?? 0,
      failed: [],
      pending: true,
      reason: result.reason || "Send All is queued and will complete shortly.",
    };
  }

  return { sent: result.emailed ?? skus.length, failed: [] };
}

// ── Clear Dock (no emails) ──────────────────────────────────

/**
 * Logs a single SEND_DOCK event with mode=CLEAR for all SKUs.
 * The Apps Script deletes all blocks without sending emails.
 */
export async function clearDock(
  skus: string[],
): Promise<{ cleared: number; failed: string[]; pending?: boolean; reason?: string }> {
  const result = await logSendDock(skus, "CLEAR");

  if (!result.success) {
    return { cleared: result.deleted ?? 0, failed: [result.error || "Failed to process SEND_DOCK event"] };
  }

  // Pending means the event is queued but not yet verified as complete.
  if (result.pending) {
    return {
      cleared: result.deleted ?? 0,
      failed: [],
      pending: true,
      reason: result.reason || "Clear Dock is queued and will complete shortly.",
    };
  }

  return { cleared: result.deleted ?? skus.length, failed: [] };
}

// ── Reopen SKU ──────────────────────────────────────────────

export interface ReopenedProduct {
  sku: string;
  brand: string;
  title: string;
  mainCategory: string;
  additionalCategories: string[];
  imageUrls: string[];
  specifications: Record<string, string>;
  chatgptData?: string;
  chatgptDescription?: string;
}

export async function reopenSku(
  sku: string
): Promise<ReopenedProduct> {
  if (!isConfigured()) {
    const found = defaultProducts.find((p) => p.sku === sku);
    if (!found) throw new Error(`SKU "${sku}" not found`);
    return {
      sku: found.sku,
      brand: found.brand,
      title: found.exampleTitle,
      mainCategory: "Indoor Lights/Ceiling Lights/Downlights",
      additionalCategories: [],
      imageUrls: ["https://via.placeholder.com/800x800.jpg"],
      specifications: {},
    };
  }
  return apiFetch("/reopenSku", {
    method: "POST",
    body: JSON.stringify({ sku }),
  });
}

// ── Temp Make Visible ───────────────────────────────────────

export async function tempMakeVisible(
  sku: string
): Promise<{ success: boolean; error?: string; alreadyState?: boolean }> {
  // Use Supabase edge function to update visibility in PRODUCTS TO DO
  if (isSupabaseGoogleSheetsConfigured()) {
    return updateSkuVisibility(sku);
  }
  if (!isConfigured()) {
    console.log("[mock] tempMakeVisible:", sku);
    return { success: true };
  }
  return apiFetch("/tempMakeVisible", {
    method: "POST",
    body: JSON.stringify({ sku }),
  });
}

// ── Mark SKU Complete ───────────────────────────────────────

export async function markSkuComplete(
  sku: string,
  dockCount?: number
): Promise<{ success: boolean; error?: string; alreadyState?: boolean }> {
  if (isSupabaseGoogleSheetsConfigured()) {
    return updateSkuStatus(sku, "COMPLETE", dockCount);
  }
  if (!isConfigured()) {
    console.log("[mock] markSkuComplete:", sku);
    return { success: true };
  }
  return apiFetch("/markSkuComplete", {
    method: "POST",
    body: JSON.stringify({ sku }),
  });
}

// ── Mark SKU Incomplete ─────────────────────────────────────

export async function markSkuIncomplete(
  sku: string,
  dockCount?: number
): Promise<{ success: boolean; error?: string; alreadyState?: boolean }> {
  if (isSupabaseGoogleSheetsConfigured()) {
    return updateSkuStatus(sku, "TO_DO", dockCount);
  }
  if (!isConfigured()) {
    console.log("[mock] markSkuIncomplete:", sku);
    return { success: true };
  }
  return apiFetch("/markSkuIncomplete", {
    method: "POST",
    body: JSON.stringify({ sku }),
  });
}

// ── Mark Not For Sale ───────────────────────────────────────

export async function markNotForSale(
  sku: string,
  dockCount?: number
): Promise<{ success: boolean; error?: string; alreadyState?: boolean }> {
  if (isSupabaseGoogleSheetsConfigured()) {
    return updateSkuStatus(sku, "NOT_FOR_SALE", dockCount);
  }
  if (!isConfigured()) {
    console.log("[mock] markNotForSale:", sku);
    return { success: true };
  }
  return apiFetch("/markNotForSale", {
    method: "POST",
    body: JSON.stringify({ sku }),
  });
}

// ── Brands ──────────────────────────────────────────────────

export interface BrandEntry {
  brand: string;
  brandName: string;
  website: string;
}

export interface BrandFetchResult {
  brands: BrandEntry[];
  source: "google-sheets" | "apps-script" | "defaults";
}

export async function fetchBrandsWithSource(): Promise<BrandFetchResult> {
  // Try Supabase Google Sheets first
  if (isSupabaseGoogleSheetsConfigured()) {
    try {
      const data = await readGoogleSheets();
      if (data.brands && !data.useDefaults) {
        return { brands: data.brands, source: "google-sheets" };
      }
    } catch (error) {
      console.error("Error fetching brands from Supabase Google Sheets:", error);
    }
  }

  // Fall back to Apps Script if configured
  if (!isConfigured()) {
    return {
      brands: [
        { brand: "Havit", brandName: "Havit Lighting", website: "https://www.havit.com.au" },
        { brand: "Domus", brandName: "Domus Lighting", website: "https://www.domuslighting.com.au" },
        { brand: "Telbix", brandName: "Telbix Australia", website: "https://www.telbix.com.au" },
        { brand: "Eglo", brandName: "Eglo Lighting", website: "https://www.eglo.com.au" },
        { brand: "CLA", brandName: "CLA Lighting", website: "https://www.clalighting.com.au" },
      ],
      source: "defaults",
    };
  }
  const brands = await apiFetch<BrandEntry[]>("/brands");
  return { brands, source: "apps-script" };
}

/** Legacy wrapper for non-admin pages */
export async function fetchBrands(): Promise<BrandEntry[]> {
  const result = await fetchBrandsWithSource();
  return result.brands;
}

export async function saveBrands(brands: BrandEntry[]): Promise<void> {
  // Use Supabase Google Sheets integration
  if (isSupabaseGoogleSheetsConfigured()) {
    try {
      await writeBrandsToGoogleSheets(brands);
      return;
    } catch (error) {
      console.error("Error saving brands to Google Sheets:", error);
      throw error;
    }
  }

  // Fall back to Apps Script if configured
  if (!isConfigured()) {
    console.log("[mock] saveBrands:", brands);
    return;
  }
  await apiFetch("/brands/update", {
    method: "POST",
    body: JSON.stringify({ brands }),
  });
}

// ── Filter Rules ────────────────────────────────────────────

export interface FilterRule {
  categoryPath: string;
  visibleFields: string[];
  requiredFields: string[];
}

export async function fetchFilterRules(): Promise<FilterRule[]> {
  if (!isConfigured()) {
    return [];
  }
  return apiFetch("/filters");
}

export async function saveFilterRules(rules: FilterRule[]): Promise<void> {
  if (!isConfigured()) {
    console.log("[mock] saveFilterRules:", rules);
    return;
  }
  await apiFetch("/filters/update", {
    method: "POST",
    body: JSON.stringify({ rules }),
  });
}
