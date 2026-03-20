import {
  FIELD_LABEL_KEYS,
  LS_VALUE_KEYS,
  SUPPLIER_VALUE_KEYS,
} from "@/lib/aiCompareKeys";

export interface NormalizedComparisonRow {
  field: string;
  supplier: string;
  ls: string;
}

const normalizeAiKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const FIELD_LABEL_KEY_SET = new Set(FIELD_LABEL_KEYS.map((key) => normalizeAiKey(key)));
const SUPPLIER_VALUE_KEY_SET = new Set(SUPPLIER_VALUE_KEYS.map((key) => normalizeAiKey(key)));
const LS_VALUE_KEY_SET = new Set(LS_VALUE_KEYS.map((key) => normalizeAiKey(key)));

const FIELD_STATUS_SUFFIX_RE =
  /\s*(?:\((?:ADDED|DIFFERENT|DIFF|IDENTICAL|EQUIVALENT|MATCH|ONLY IN SUPPLIER|ONLY IN LS)\)|\[(?:ADDED|DIFFERENT|DIFF|IDENTICAL|EQUIVALENT|MATCH|ONLY IN SUPPLIER|ONLY IN LS)\])\s*$/i;
const PLACEHOLDER_VALUE_RE =
  /^(?:---|N\/A|NA|MISSING(?:\*{3})?(?:\s*\([^)]*\))?|NULL|NONE|UNKNOWN)$/i;

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function normalizeCompareFieldLabel(field: string): string {
  return field.replace(FIELD_STATUS_SUFFIX_RE, "").replace(/\s+/g, " ").trim();
}

export function isComparePlaceholderValue(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  return !normalized || PLACEHOLDER_VALUE_RE.test(normalized);
}

function scoreCompareValue(value: string): number {
  if (!value.trim()) return 0;
  return isComparePlaceholderValue(value) ? 1 : 2;
}

function normalizeComparableScalar(value: string): string {
  return value
    .trim()
    .replace(/[–—]/g, "-")
    .replace(/[×✕]/g, "x")
    .replace(/\s*([;,:|])\s*/g, "$1")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function splitCompositeValues(value: string): string[] {
  if (!/[;\n|]/.test(value)) return [];
  return value
    .split(/[;\n|]/)
    .map((part) => normalizeComparableScalar(part))
    .filter(Boolean);
}

export function areEquivalentCompareValues(a: string, b: string): boolean {
  const left = normalizeComparableScalar(a);
  const right = normalizeComparableScalar(b);
  if (left === right) return true;

  const leftParts = splitCompositeValues(left);
  const rightParts = splitCompositeValues(right);
  if (leftParts.length === 0 || rightParts.length === 0) return false;
  if (leftParts.length !== rightParts.length) return false;

  const sortedLeft = [...leftParts].sort();
  const sortedRight = [...rightParts].sort();
  for (let i = 0; i < sortedLeft.length; i++) {
    if (sortedLeft[i] !== sortedRight[i]) return false;
  }
  return true;
}

function chooseBetterCompareValue(current: string, next: string): string {
  const currentScore = scoreCompareValue(current);
  const nextScore = scoreCompareValue(next);
  if (nextScore !== currentScore) return nextScore > currentScore ? next : current;
  return next.trim().length > current.trim().length ? next : current;
}

function pickBestCompareCell(row: Record<string, unknown>, keySet: Set<string>): string {
  let best = "";
  for (const [rawKey, rawValue] of Object.entries(row)) {
    if (!keySet.has(normalizeAiKey(rawKey))) continue;
    const candidate = toText(rawValue).replace(/\s+/g, " ").trim();
    if (!candidate) continue;
    best = best ? chooseBetterCompareValue(best, candidate) : candidate;
  }
  return best;
}

function canMergeCompareRows(left: NormalizedComparisonRow, right: NormalizedComparisonRow): boolean {
  if (left.field !== right.field) return false;

  const sides: Array<keyof Omit<NormalizedComparisonRow, "field">> = ["supplier", "ls"];
  for (const side of sides) {
    const leftValue = left[side];
    const rightValue = right[side];
    if (isComparePlaceholderValue(leftValue) || isComparePlaceholderValue(rightValue)) continue;
    if (areEquivalentCompareValues(leftValue, rightValue)) continue;
    return false;
  }

  return true;
}

function mergeNormalizedComparisonRows(rows: NormalizedComparisonRow[]): NormalizedComparisonRow[] {
  const merged: NormalizedComparisonRow[] = [];

  for (const row of rows) {
    const existing = merged.find((candidate) => canMergeCompareRows(candidate, row));
    if (!existing) {
      merged.push(row);
      continue;
    }

    existing.supplier = chooseBetterCompareValue(existing.supplier, row.supplier);
    existing.ls = chooseBetterCompareValue(existing.ls, row.ls);
  }

  return merged.sort((a, b) => {
    const byField = a.field.localeCompare(b.field);
    if (byField !== 0) return byField;
    const bySupplier = normalizeComparableScalar(a.supplier).localeCompare(normalizeComparableScalar(b.supplier));
    if (bySupplier !== 0) return bySupplier;
    return normalizeComparableScalar(a.ls).localeCompare(normalizeComparableScalar(b.ls));
  });
}

export function normalizeComparisonRows(rowList: unknown[]): NormalizedComparisonRow[] {
  const normalizedRows = rowList
    .map((item) => {
      const row = item && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : {};

      const field = normalizeCompareFieldLabel(pickBestCompareCell(row, FIELD_LABEL_KEY_SET));
      const supplier = pickBestCompareCell(row, SUPPLIER_VALUE_KEY_SET) || "---";
      const ls = pickBestCompareCell(row, LS_VALUE_KEY_SET) || "---";

      return {
        field,
        supplier,
        ls,
      };
    })
    .filter((row) => Boolean(row.field || row.supplier.trim() || row.ls.trim()));

  return mergeNormalizedComparisonRows(normalizedRows);
}
