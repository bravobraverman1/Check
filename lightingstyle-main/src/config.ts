// ============================================================
// Application Configuration
// All backend URLs, sheet names, and column mappings live here.
// When connecting to a Google Apps Script Web App, set
// APPS_SCRIPT_BASE_URL to your deployed web app URL.
// ============================================================

export interface SheetTabConfig {
  key: string;
  label: string;
  value: string;
}

// Default sheet tab names — all configurable in Admin
// label = displayed in Admin UI, value = actual Google Sheet tab name default
export const DEFAULT_SHEET_TABS: SheetTabConfig[] = [
  { key: "SHEET_CATEGORIES",     label: "Categories",     value: "Categories" },
  { key: "SHEET_MASTER_DEFAULTS",label: "MASTER_Filters", value: "MASTER_Filters" },
  { key: "SHEET_LEGAL",          label: "Filters",        value: "Filters" },
  { key: "SHEET_BRANDS",         label: "Brands",         value: "Brands" },
  { key: "SHEET_NEW_NAMES",      label: "NewNames",       value: "NewNames" },
  { key: "SHEET_EXISTING_PRODS", label: "ExistingProds",  value: "ExistingProds" },
  { key: "SHEET_PRODUCTS",       label: "Products",       value: "Products" },
  { key: "SHEET_PRODUCTS_TODO",  label: "PRODUCTS TO DO", value: "PRODUCTS TO DO" },
  { key: "SHEET_EVENTS",         label: "Events",         value: "Events" },
  { key: "SHEET_OUTPUT_TEMPLATE",label: "OUTPUT_Template",value: "OUTPUT_Template" },
  { key: "SHEET_OUTPUT_WORK",    label: "OUTPUT_Work",    value: "OUTPUT_Work" },
  { key: "SHEET_AI_LOGGING",     label: "AI_Logging",     value: "AI_Logging" },
];

// Stored config — localStorage is the synchronous cache, Supabase is the global source.
// On boot, `initGlobalSettings()` pulls all remote settings into localStorage.
// Every `setConfigValue` writes to both localStorage (instant) and Supabase (async).
import { persistConfigValue } from "@/lib/globalSettings";

function loadStoredConfig(): Record<string, string> {
  try {
    const stored = localStorage.getItem("app_config");
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function saveStoredConfig(cfg: Record<string, string>) {
  localStorage.setItem("app_config", JSON.stringify(cfg));
}

export function getConfigValue(key: string, defaultValue: string): string {
  const stored = loadStoredConfig();
  return stored[key] ?? defaultValue;
}

export function setConfigValue(key: string, value: string) {
  const stored = loadStoredConfig();
  stored[key] = value;
  saveStoredConfig(stored);
  // Persist to Supabase so all browsers/users see the same value
  persistConfigValue(key, value);
}

export function getSheetTabName(key: string): string {
  const tab = DEFAULT_SHEET_TABS.find((t) => t.key === key);
  return getConfigValue(key, tab?.value ?? key);
}

export function setSheetTabName(key: string, value: string) {
  setConfigValue(key, value);
}

export const config = {
  // ── Backend URL ──────────────────────────────────────────
  get APPS_SCRIPT_BASE_URL() {
    return getConfigValue("APPS_SCRIPT_BASE_URL", "");
  },

  // ── Sheet / Tab Names (all configurable) ─────────────────
  get SHEET_CATEGORIES() { return getSheetTabName("SHEET_CATEGORIES"); },
  get SHEET_MASTER_DEFAULTS() { return getSheetTabName("SHEET_MASTER_DEFAULTS"); },
  get SHEET_LEGAL() { return getSheetTabName("SHEET_LEGAL"); },
  get SHEET_BRANDS() { return getSheetTabName("SHEET_BRANDS"); },
  get SHEET_NEW_NAMES() { return getSheetTabName("SHEET_NEW_NAMES"); },
  get SHEET_EXISTING_PRODS() { return getSheetTabName("SHEET_EXISTING_PRODS"); },
  get SHEET_PRODUCTS() { return getSheetTabName("SHEET_PRODUCTS"); },
  get SHEET_PRODUCTS_TODO() { return getSheetTabName("SHEET_PRODUCTS_TODO"); },
  get SHEET_EVENTS() { return getSheetTabName("SHEET_EVENTS"); },
  get SHEET_OUTPUT_TEMPLATE() { return getSheetTabName("SHEET_OUTPUT_TEMPLATE"); },
  get SHEET_OUTPUT_WORK() { return getSheetTabName("SHEET_OUTPUT_WORK"); },
  get SHEET_LOADING_DOCK() { return getConfigValue("SHEET_LOADING_DOCK", "Loading Dock"); },
  get SHEET_AI_LOGGING() { return getSheetTabName("SHEET_AI_LOGGING"); },

  // ── Column Mappings (0-indexed) ──────────────────────────
  PRODUCTS_COL_SKU: 0,        // Column A
  PRODUCTS_COL_BRAND: 1,      // Column B
  PRODUCTS_COL_STATUS: 2,     // Column C
  PRODUCTS_COL_VISIBILITY: 3, // Column D

  // Categories
  CATEGORIES_COL_PATH: 6,     // Column G

  // ── Visibility Config ────────────────────────────────────
  get VISIBILITY_SHEET_NAME() { return getSheetTabName("SHEET_PRODUCTS_TODO"); },
  VISIBILITY_COLUMN: "visibility",
  VISIBLE_VALUE: "1",
  HIDDEN_VALUE: "0",

  // ── Status Values ────────────────────────────────────────
  STATUS_TO_DO: "TO_DO",
  STATUS_COMPLETE: "COMPLETE",
  STATUS_NOT_FOR_SALE: "NOT_FOR_SALE",

  // ── PDF Instructions ─────────────────────────────────────
  get INSTRUCTIONS_PDF_URL() {
    return getConfigValue("INSTRUCTIONS_PDF_URL", "/chatgpt-product-instructions.pdf");
  },

  // ── Google Drive CSV Folder ──────────────────────────────
  get DRIVE_CSV_FOLDER_ID() {
    return getConfigValue("DRIVE_CSV_FOLDER_ID", "");
  },

  // ── Supabase Google Sheets Configuration ─────────────────
  // NOTE: GOOGLE_SERVICE_ACCOUNT_KEY and GOOGLE_SHEET_ID are stored ONLY as Supabase secrets
  // They are NOT stored in browser localStorage for security reasons
  // The edge function uses Deno.env to access these secrets server-side
} as const;

export type AppConfig = typeof config;
