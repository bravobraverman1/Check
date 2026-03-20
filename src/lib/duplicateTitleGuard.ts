import {
  normalizeProductTitleForCompare,
  normalizeProductTitleWhitespace,
} from "./productTitleNormalization.ts";

export type DuplicateTitleSource = "ExistingProds/NewNames" | "Loading Dock";

export interface DuplicateTitleInfo {
  title: string;
  sources: DuplicateTitleSource[];
}

export interface DuplicateTitleSubmitError extends Error {
  code: "DUPLICATE_TITLE";
  duplicateTitle: string;
  duplicateTitleSources: DuplicateTitleSource[];
  requiresConfirmation: true;
}

function normalizeSku(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

export function findDuplicateTitleInfo(args: {
  title: unknown;
  currentSku?: unknown;
  existingTitles?: Iterable<unknown>;
  loadingDockTitles?: Iterable<{ sku?: unknown; title?: unknown }>;
}): DuplicateTitleInfo | null {
  const normalizedTitle = normalizeProductTitleForCompare(args.title);
  if (!normalizedTitle) return null;

  const normalizedCurrentSku = normalizeSku(args.currentSku);
  const dockTitleEntries = Array.from(args.loadingDockTitles ?? []);
  for (const entry of dockTitleEntries) {
    const entrySku = normalizeSku(entry.sku);
    if (!normalizedCurrentSku || entrySku !== normalizedCurrentSku) continue;
    if (normalizeProductTitleForCompare(entry.title) === normalizedTitle) {
      return null;
    }
  }


  const sources = new Set<DuplicateTitleSource>();
  const trimmedTitle = normalizeProductTitleWhitespace(args.title);

  for (const candidate of args.existingTitles ?? []) {
    if (normalizeProductTitleForCompare(candidate) === normalizedTitle) {
      sources.add("ExistingProds/NewNames");
      break;
    }
  }

  for (const entry of args.loadingDockTitles ?? []) {
    const entrySku = normalizeSku(entry.sku);
    if (!entrySku) continue;
    if (normalizedCurrentSku && entrySku === normalizedCurrentSku) continue;
    if (normalizeProductTitleForCompare(entry.title) === normalizedTitle) {
      sources.add("Loading Dock");
      break;
    }
  }

  if (sources.size === 0) return null;

  return {
    title: trimmedTitle,
    sources: Array.from(sources),
  };
}

export function createDuplicateTitleSubmitError(info: DuplicateTitleInfo): DuplicateTitleSubmitError {
  const error = new Error(
    `Duplicate Product Name: "${info.title}" already exists in ${info.sources.join(" & ")}. Confirmation required before submit.`,
  ) as DuplicateTitleSubmitError;
  error.code = "DUPLICATE_TITLE";
  error.duplicateTitle = info.title;
  error.duplicateTitleSources = info.sources;
  error.requiresConfirmation = true;
  return error;
}

export function isDuplicateTitleSubmitError(error: unknown): error is DuplicateTitleSubmitError {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return (
    record.code === "DUPLICATE_TITLE"
    && typeof record.duplicateTitle === "string"
    && Array.isArray(record.duplicateTitleSources)
  );
}
