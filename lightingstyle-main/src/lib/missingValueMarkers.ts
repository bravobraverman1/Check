/**
 * Shared set of "no data" / "unavailable" marker values.
 *
 * Used by:
 *  - twoPdfPostProcess.ts  (two-PDF merge deduplication)
 *  - ProductEntryForm.tsx   (filter autofill pipeline)
 *  - ai-worker/index.ts     (backend — has its OWN superset; cannot import from frontend)
 *
 * If you need to add a new marker, add it here so every consumer stays in sync.
 */
export const MISSING_VALUE_MARKERS = new Set([
  "",
  "-",
  "---",
  "MISSING",
  "MISSING***",
  "N/A",
  "NA",
  "NONE",
  "NULL",
  "UNKNOWN",
  "VARIABLE",
  "VARIES",
  "VARIOUS",
  "NOT PROVIDED",
  "NOT AVAILABLE",
  "NOT SPECIFIED",
  "NOT LISTED",
  "NOT STATED",
  "NO DATA",
]);

/** Check whether a raw string looks like a "missing" / "unavailable" placeholder */
export function isMissingValue(raw: string): boolean {
  const normalized = raw.trim().replace(/\s+/g, " ").toUpperCase();
  if (!normalized) return true;
  if (MISSING_VALUE_MARKERS.has(normalized)) return true;
  // Also match legacy/current explicit MISSING markers: MISSING, MISSING***, MISSING (reason), MISSING*** (reason)
  if (/^MISSING(?:\*{3})?\s*(?:\([^)]*\))?$/.test(normalized)) return true;
  return false;
}

/**
 * Strict check: only matches the explicit MISSING*** marker pattern (3 stars required).
 * Use this for mandatory-field validation in the AI-Data textarea (chevron + warning).
 * Values like "Variable", "N/A", "Unknown", or bare "MISSING" should NOT trigger this.
 */
export function isMissingMarker(raw: string): boolean {
  const normalized = raw.trim().replace(/\s+/g, " ").toUpperCase();
  if (!normalized) return false;
  // Match: MISSING***, MISSING*** (reason) — 3 stars required
  return /^MISSING\*{3}\s*(?:\([^)]*\))?$/.test(normalized);
}

/** Check whether a larger block of text contains the explicit MISSING*** marker anywhere. */
export function hasMissingMarkerSubstring(raw: string): boolean {
  return /MISSING\*{3}/i.test(raw);
}
