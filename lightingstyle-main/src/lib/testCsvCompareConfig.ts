import { persistConfigValue } from "@/lib/globalSettings";

const TEST_CSV_COMPARE_IGNORED_COLUMNS_KEY = "TEST_CSV_COMPARE_IGNORED_COLUMNS";
const TEST_CSV_COMPARE_UNORDERED_RULES_KEY = "TEST_CSV_COMPARE_UNORDERED_RULES";
const APP_CONFIG_STORAGE_KEY = "app_config";

const DEFAULT_IGNORED_COLUMNS = ["Product Description", "Retail Price"];

export type TestCsvUnorderedRule = {
  title: string;
  symbol: string;
};

const DEFAULT_UNORDERED_RULES: TestCsvUnorderedRule[] = [
  { title: "Category", symbol: ";" },
  { title: "GPS Category", symbol: ";" },
  { title: "Product Custom Fields", symbol: ";" },
];

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function dedupeTitles(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = normalizeTitle(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }

  return output;
}

function normalizeSymbol(value: string): string {
  return value.trim();
}

function dedupeRules(values: TestCsvUnorderedRule[]): TestCsvUnorderedRule[] {
  const seen = new Set<string>();
  const output: TestCsvUnorderedRule[] = [];

  for (const entry of values) {
    const title = normalizeTitle(String(entry?.title ?? ""));
    const symbol = normalizeSymbol(String(entry?.symbol ?? ""));
    if (!title || !symbol) continue;

    const key = `${title.toLowerCase()}::${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ title, symbol });
  }

  return output;
}

function parseStoredTitles(raw: string): string[] {
  if (!raw.trim()) return [...DEFAULT_IGNORED_COLUMNS];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return dedupeTitles(parsed.map((entry) => String(entry ?? "")));
    }
  } catch {
    // Backward-compatible fallback: comma/newline separated plain text
  }

  return dedupeTitles(raw.split(/[\n,]/g));
}

function parseStoredUnorderedRules(raw: string): TestCsvUnorderedRule[] {
  if (!raw.trim()) return [...DEFAULT_UNORDERED_RULES];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const normalized = dedupeRules(
        parsed.map((entry) => ({
          title: String((entry as { title?: unknown })?.title ?? ""),
          symbol: String((entry as { symbol?: unknown })?.symbol ?? ""),
        })),
      );
      if (normalized.length > 0) return normalized;
    }
  } catch {
    // No backward-compat plain-text mode for structured rules.
  }

  return [...DEFAULT_UNORDERED_RULES];
}

function readSetting(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(APP_CONFIG_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed?.[key];
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(APP_CONFIG_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    parsed[key] = value;
    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // no-op in restricted environments
  }
  void persistConfigValue(key, value);
}

export function getTestCsvCompareIgnoredColumns(): string[] {
  const raw = readSetting(TEST_CSV_COMPARE_IGNORED_COLUMNS_KEY, "");
  const parsed = parseStoredTitles(raw);
  return parsed.length > 0 ? parsed : [...DEFAULT_IGNORED_COLUMNS];
}

export function setTestCsvCompareIgnoredColumns(columns: string[]): string[] {
  const sanitized = dedupeTitles(columns);
  const next = sanitized.length > 0 ? sanitized : [...DEFAULT_IGNORED_COLUMNS];
  writeSetting(TEST_CSV_COMPARE_IGNORED_COLUMNS_KEY, JSON.stringify(next));
  return next;
}

export function getDefaultTestCsvCompareIgnoredColumns(): string[] {
  return [...DEFAULT_IGNORED_COLUMNS];
}

export function getTestCsvCompareUnorderedRules(): TestCsvUnorderedRule[] {
  const raw = readSetting(TEST_CSV_COMPARE_UNORDERED_RULES_KEY, "");
  const parsed = parseStoredUnorderedRules(raw);
  return parsed.length > 0 ? parsed : [...DEFAULT_UNORDERED_RULES];
}

export function setTestCsvCompareUnorderedRules(rules: TestCsvUnorderedRule[]): TestCsvUnorderedRule[] {
  const sanitized = dedupeRules(rules);
  const next = sanitized.length > 0 ? sanitized : [...DEFAULT_UNORDERED_RULES];
  writeSetting(TEST_CSV_COMPARE_UNORDERED_RULES_KEY, JSON.stringify(next));
  return next;
}

export function getDefaultTestCsvCompareUnorderedRules(): TestCsvUnorderedRule[] {
  return [...DEFAULT_UNORDERED_RULES];
}
