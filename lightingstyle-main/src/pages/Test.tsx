import { useEffect, useMemo, useState } from "react";
import { Upload, ChevronDown, ChevronRight, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  getTestCsvCompareIgnoredColumns,
  getTestCsvCompareUnorderedRules,
  type TestCsvUnorderedRule,
} from "@/lib/testCsvCompareConfig";

type ParsedCsv = {
  rows: string[][];
  headers: string[];
};

const CSV_PERSIST_KEY = "test-tab-csv-state-v1";
// 
type FieldDiff = {
  id: string;
  columnLetter: string;
  title: string;
  legacy: string;
  baseNew: string;
  delta: string;
  kind: "missing_in_legacy" | "legacy_only" | "changed";
};

type DataFieldEntry = {
  key: string;
  field: string;
  value: string;
};

type DataDiff = {
  id: string;
  field: string;
  csv1: string;
  csv2: string;
  delta: string;
  kind: "missing_in_legacy" | "legacy_only" | "changed" | "same";
};

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
      if (inQuotes && normalized[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "\n" && !inQuotes) {
      if (current.length > 0) rows.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.length > 0) rows.push(current);
  return rows;
}

function parseCsv(text: string): ParsedCsv {
  const rowStrings = splitCsvRows(text);
  const rows = rowStrings.map(parseCsvLine);
  const headers = rows[0] || [];
  return { rows, headers };
}

function toColumnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function normalizeHeaderForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeListToken(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeFieldLabelForRuleMatch(fieldLabel: string): string {
  const withoutRowHint = fieldLabel.replace(/\s*\(row\s+\d+\)\s*$/i, "");
  return normalizeHeaderForMatch(withoutRowHint);
}

function getRuleSymbolForField(fieldLabel: string, rules: TestCsvUnorderedRule[]): string | null {
  const normalizedField = normalizeFieldLabelForRuleMatch(fieldLabel);
  for (const rule of rules) {
    const normalizedRuleTitle = normalizeHeaderForMatch(rule.title);
    const normalizedRuleSymbol = rule.symbol.trim();
    if (!normalizedRuleTitle || !normalizedRuleSymbol) continue;
    if (normalizedRuleTitle === normalizedField) return normalizedRuleSymbol;
  }
  return null;
}

function areSymbolListsEquivalent(leftRaw: string, rightRaw: string, symbol: string): boolean {
  const leftParts = leftRaw.split(symbol).map(normalizeListToken).filter(Boolean);
  const rightParts = rightRaw.split(symbol).map(normalizeListToken).filter(Boolean);
  if (leftParts.length !== rightParts.length) return false;

  const counts = new Map<string, number>();
  for (const part of leftParts) {
    counts.set(part, (counts.get(part) ?? 0) + 1);
  }

  for (const part of rightParts) {
    const current = counts.get(part) ?? 0;
    if (current <= 0) return false;
    if (current === 1) counts.delete(part);
    else counts.set(part, current - 1);
  }

  return counts.size === 0;
}

function areValuesEquivalentForField(
  fieldLabel: string,
  legacyRaw: string,
  baseNewRaw: string,
  rules: TestCsvUnorderedRule[],
): boolean {
  if (legacyRaw === baseNewRaw) return true;
  const symbol = getRuleSymbolForField(fieldLabel, rules);
  if (!symbol) return false;
  return areSymbolListsEquivalent(legacyRaw, baseNewRaw, symbol);
}

function formatCell(value: string): string {
  const trimmed = value.trim();
  return trimmed === "" ? "—" : trimmed;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&deg;/gi, "°")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/");
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function extractDataPairsFromProductDescription(raw: string): Array<{ field: string; value: string }> {
  if (!raw.trim()) return [];

  const pairs: Array<{ field: string; value: string }> = [];
  const strongRegex = /<strong>\s*([^<:]{1,120}?)\s*:\s*<\/strong>\s*([\s\S]*?)(?=<br\s*\/?>|<\/p>|<strong>|$)/gi;
  let strongMatch: RegExpExecArray | null;

  while ((strongMatch = strongRegex.exec(raw)) !== null) {
    const field = htmlToText(strongMatch[1]).trim();
    const value = htmlToText(strongMatch[2]).trim();
    if (!field || !value) continue;
    pairs.push({ field, value });
  }

  if (pairs.length > 0) return pairs;

  const plain = htmlToText(raw);
  const segments = plain
    .split(/\n|;/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const kv = segment.match(/^([^:=]{1,120}?)\s*[:=]\s*(.+)$/);
    if (!kv) continue;
    const field = kv[1].trim();
    const value = kv[2].trim();
    if (!field || !value) continue;
    pairs.push({ field, value });
  }

  return pairs;
}

function findProductDescriptionColumnIndex(parsed: ParsedCsv): number {
  return parsed.headers.findIndex((header) => normalizeHeaderForMatch(header) === "productdescription");
}

function extractDataEntriesFromCsv(parsed: ParsedCsv, includeRowHint: boolean): DataFieldEntry[] {
  const productDescriptionCol = findProductDescriptionColumnIndex(parsed);
  if (productDescriptionCol < 0) return [];

  const entries: DataFieldEntry[] = [];

  for (let rowIndex = 1; rowIndex < parsed.rows.length; rowIndex++) {
    const cell = parsed.rows[rowIndex]?.[productDescriptionCol] ?? "";
    const pairs = extractDataPairsFromProductDescription(cell);
    if (pairs.length === 0) continue;

    const seenCounts = new Map<string, number>();
    for (const pair of pairs) {
      const normalizedField = normalizeHeaderForMatch(pair.field);
      const currentCount = (seenCounts.get(normalizedField) ?? 0) + 1;
      seenCounts.set(normalizedField, currentCount);

      const rowField = includeRowHint ? `${pair.field} (Row ${rowIndex + 1})` : pair.field;
      entries.push({
        key: `${rowIndex}|${normalizedField}|${currentCount}`,
        field: rowField,
        value: pair.value,
      });
    }
  }

  return entries;
}

function classifyDiff(baseNewRaw: string, legacyRaw: string): FieldDiff["kind"] {
  if (baseNewRaw && !legacyRaw) return "missing_in_legacy";
  if (!baseNewRaw && legacyRaw) return "legacy_only";
  return "changed";
}

function kindLabel(kind: FieldDiff["kind"]): string {
  if (kind === "missing_in_legacy") return "Present in CSV2 (New) only";
  if (kind === "legacy_only") return "Present in CSV1 (Legacy) only";
  return "Different";
}

function kindBadgeClass(kind: FieldDiff["kind"]): string {
  if (kind === "missing_in_legacy") return "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (kind === "legacy_only") return "bg-rose-100 text-rose-900 dark:bg-rose-900/30 dark:text-rose-300";
  return "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300";
}

function deltaPrefix(kind: FieldDiff["kind"]): string {
  if (kind === "missing_in_legacy") return "+";
  if (kind === "legacy_only") return "−";
  return "~";
}

function classifyDataKind(csv2Base: string | undefined, csv1Legacy: string | undefined): DataDiff["kind"] {
  if (csv2Base !== undefined && csv1Legacy !== undefined && csv2Base === csv1Legacy) return "same";
  if (csv2Base !== undefined && csv1Legacy === undefined) return "missing_in_legacy";
  if (csv2Base === undefined && csv1Legacy !== undefined) return "legacy_only";
  if ((csv2Base ?? "") === (csv1Legacy ?? "")) return "same";
  return "changed";
}

function classifyDataKindForField(
  fieldLabel: string,
  csv2Base: string | undefined,
  csv1Legacy: string | undefined,
  rules: TestCsvUnorderedRule[],
): DataDiff["kind"] {
  if (csv2Base !== undefined && csv1Legacy !== undefined) {
    if (areValuesEquivalentForField(fieldLabel, csv1Legacy, csv2Base, rules)) {
      return "same";
    }
  }
  return classifyDataKind(csv2Base, csv1Legacy);
}

function formatDataCell(value: string | undefined): string {
  return value && value.trim() ? value.trim() : "—";
}

function dataDeltaBadgeLabel(kind: Exclude<DataDiff["kind"], "same">): string {
  if (kind === "missing_in_legacy") return "Present in CSV2 (New) only";
  if (kind === "legacy_only") return "Present in CSV1 (Legacy) only";
  return "Different";
}

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "--" || trimmed === "—";
}

function buildInlineDiffParts(newValue: string, legacyValue: string): {
  prefix: string;
  newChanged: string;
  legacyChanged: string;
  suffix: string;
} {
  const maxPrefix = Math.min(newValue.length, legacyValue.length);
  let prefixLen = 0;
  while (prefixLen < maxPrefix && newValue[prefixLen] === legacyValue[prefixLen]) {
    prefixLen++;
  }

  const newRemainder = newValue.length - prefixLen;
  const legacyRemainder = legacyValue.length - prefixLen;
  const maxSuffix = Math.min(newRemainder, legacyRemainder);
  let suffixLen = 0;
  while (
    suffixLen < maxSuffix &&
    newValue[newValue.length - 1 - suffixLen] === legacyValue[legacyValue.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  return {
    prefix: newValue.slice(0, prefixLen),
    newChanged: newValue.slice(prefixLen, newValue.length - suffixLen),
    legacyChanged: legacyValue.slice(prefixLen, legacyValue.length - suffixLen),
    suffix: suffixLen > 0 ? newValue.slice(newValue.length - suffixLen) : "",
  };
}

function renderDeltaWithExactHighlight(kind: FieldDiff["kind"] | DataDiff["kind"], newValue: string, legacyValue: string): JSX.Element {
  if (kind === "same") {
    return <span className="text-foreground">Same in CSV1 and CSV2</span>;
  }

  if (kind === "missing_in_legacy") {
    return (
      <span>
        <span className="bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300 rounded px-1">{newValue}</span>
        <span className="mx-1 text-foreground">→</span>
        <span className="text-foreground">—</span>
      </span>
    );
  }

  if (kind === "legacy_only") {
    return (
      <span>
        <span className="text-foreground">—</span>
        <span className="mx-1 text-foreground">→</span>
        <span className="bg-rose-100 text-rose-900 dark:bg-rose-900/30 dark:text-rose-300 rounded px-1">{legacyValue}</span>
      </span>
    );
  }

  const parts = buildInlineDiffParts(newValue, legacyValue);

  return (
    <span>
      <span>{parts.prefix}</span>
      {parts.newChanged && (
        <span className="bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300 rounded-[2px]">{parts.newChanged}</span>
      )}
      <span>{parts.suffix}</span>
      <span className="mx-1 text-foreground">→</span>
      <span>{parts.prefix}</span>
      {parts.legacyChanged && (
        <span className="bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300 rounded-[2px]">{parts.legacyChanged}</span>
      )}
      <span>{parts.suffix}</span>
    </span>
  );
}

function fieldDeltaMessage(kind: FieldDiff["kind"], csv1LegacyValue: string, csv2NewValue: string): string {
  if (kind === "missing_in_legacy") return `${csv2NewValue} → —`;
  if (kind === "legacy_only") return `— → ${csv1LegacyValue}`;
  return `${csv2NewValue} → ${csv1LegacyValue}`;
}

export default function Test() {
  const { toast } = useToast();
  const [legacyFileName, setLegacyFileName] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState<string | null>(null);
  const [legacyParsed, setLegacyParsed] = useState<ParsedCsv | null>(null);
  const [newParsed, setNewParsed] = useState<ParsedCsv | null>(null);
  const [fieldDiffs, setFieldDiffs] = useState<FieldDiff[]>([]);
  const [dataDiffs, setDataDiffs] = useState<DataDiff[]>([]);
  const [hasCompared, setHasCompared] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [section2Open, setSection2Open] = useState(false);

  const canCompare = !!legacyParsed && !!newParsed;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CSV_PERSIST_KEY);
      if (!raw) return;

      const persisted = JSON.parse(raw) as {
        legacyParsed?: ParsedCsv | null;
        newParsed?: ParsedCsv | null;
        legacyFileName?: string | null;
        newFileName?: string | null;
      };

      if (persisted.legacyParsed) setLegacyParsed(persisted.legacyParsed);
      if (persisted.newParsed) setNewParsed(persisted.newParsed);
      if (persisted.legacyFileName) setLegacyFileName(persisted.legacyFileName);
      if (persisted.newFileName) setNewFileName(persisted.newFileName);
    } catch {
      localStorage.removeItem(CSV_PERSIST_KEY);
    }
  }, []);

  useEffect(() => {
    try {
      if (!legacyParsed && !newParsed && !legacyFileName && !newFileName) {
        localStorage.removeItem(CSV_PERSIST_KEY);
        return;
      }

      localStorage.setItem(
        CSV_PERSIST_KEY,
        JSON.stringify({ legacyParsed, newParsed, legacyFileName, newFileName }),
      );
    } catch {
      // ignore storage write failures
    }
  }, [legacyParsed, newParsed, legacyFileName, newFileName]);

  const dataRowCount = useMemo(() => {
    const rows1 = legacyParsed?.rows.length ?? 0;
    const rows2 = newParsed?.rows.length ?? 0;
    return Math.max(0, Math.max(rows1, rows2) - 1);
  }, [legacyParsed, newParsed]);

  const diffSummary = useMemo(() => {
    const missingInLegacy = fieldDiffs.filter((d) => d.kind === "missing_in_legacy").length;
    const legacyOnly = fieldDiffs.filter((d) => d.kind === "legacy_only").length;
    const changed = fieldDiffs.filter((d) => d.kind === "changed").length;
    return { missingInLegacy, legacyOnly, changed, total: fieldDiffs.length };
  }, [fieldDiffs]);

  const dataSummary = useMemo(() => {
    const missingInLegacy = dataDiffs.filter((d) => d.kind === "missing_in_legacy").length;
    const legacyOnly = dataDiffs.filter((d) => d.kind === "legacy_only").length;
    const changed = dataDiffs.filter((d) => d.kind === "changed").length;
    const same = dataDiffs.filter((d) => d.kind === "same").length;
    return { missingInLegacy, legacyOnly, changed, same, total: dataDiffs.length };
  }, [dataDiffs]);

  const handleUpload = async (file: File, side: "legacy" | "new") => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast({
        variant: "destructive",
        title: "Invalid file",
        description: "Please upload a CSV file.",
      });
      return;
    }

    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.rows.length === 0 || parsed.headers.length === 0) {
        throw new Error("CSV appears to be empty.");
      }

      if (side === "legacy") {
        setLegacyFileName(file.name);
        setLegacyParsed(parsed);
      } else {
        setNewFileName(file.name);
        setNewParsed(parsed);
      }

      setHasCompared(false);
      setFieldDiffs([]);
      setDataDiffs([]);
      setFieldsOpen(false);
      setSection2Open(false);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "CSV parse failed",
        description: error instanceof Error ? error.message : "Could not parse CSV.",
      });
    }
  };

  const handleCompare = () => {
    if (!legacyParsed || !newParsed) return;

    const ignoredColumns = getTestCsvCompareIgnoredColumns();
    const unorderedRules = getTestCsvCompareUnorderedRules();
    const ignoredHeaderKeys = new Set(ignoredColumns.map(normalizeHeaderForMatch));

    const headers = legacyParsed.headers.length >= newParsed.headers.length
      ? legacyParsed.headers
      : newParsed.headers;

    const maxRows = Math.max(legacyParsed.rows.length, newParsed.rows.length);
    const maxCols = Math.max(legacyParsed.headers.length, newParsed.headers.length);

    const diffs: FieldDiff[] = [];

    for (let rowIndex = 1; rowIndex < maxRows; rowIndex++) {
      for (let colIndex = 0; colIndex < maxCols; colIndex++) {
        const header = headers[colIndex] ?? `Column ${toColumnLetter(colIndex)}`;
        const normalizedHeader = normalizeHeaderForMatch(header);
        if (ignoredHeaderKeys.has(normalizedHeader)) {
          continue;
        }

        const legacyRaw = legacyParsed.rows[rowIndex]?.[colIndex] ?? "";
        const baseNewRaw = newParsed.rows[rowIndex]?.[colIndex] ?? "";

        if (areValuesEquivalentForField(header, legacyRaw, baseNewRaw, unorderedRules)) continue;

        const withRowHint = dataRowCount > 1
          ? `${header} (Row ${rowIndex + 1})`
          : header;

        diffs.push({
          id: `${rowIndex}-${colIndex}`,
          columnLetter: toColumnLetter(colIndex),
          title: withRowHint,
          legacy: formatCell(legacyRaw),
          baseNew: formatCell(baseNewRaw),
          delta: fieldDeltaMessage(
            classifyDiff(baseNewRaw, legacyRaw),
            formatCell(legacyRaw),
            formatCell(baseNewRaw),
          ),
          kind: classifyDiff(baseNewRaw, legacyRaw),
        });
      }
    }

    const includeRowHintForData = dataRowCount > 1;
    const legacyDataEntries = extractDataEntriesFromCsv(legacyParsed, includeRowHintForData);
    const newDataEntries = extractDataEntriesFromCsv(newParsed, includeRowHintForData);

    const legacyDataMap = new Map(legacyDataEntries.map((entry) => [entry.key, entry]));
    const newDataMap = new Map(newDataEntries.map((entry) => [entry.key, entry]));

    const orderedKeys: string[] = newDataEntries.map((entry) => entry.key);
    const inOrder = new Set(orderedKeys);
    const legacyOrder = legacyDataEntries.map((entry) => entry.key);

    const legacyOnlyKeys = legacyOrder.filter((key) => !inOrder.has(key));
    for (const legacyOnlyKey of legacyOnlyKeys) {
      const legacyPos = legacyOrder.indexOf(legacyOnlyKey);

      let insertAt = orderedKeys.length;

      for (let i = legacyPos - 1; i >= 0; i--) {
        const previousKey = legacyOrder[i];
        const existingIdx = orderedKeys.indexOf(previousKey);
        if (existingIdx >= 0) {
          insertAt = existingIdx + 1;
          break;
        }
      }

      if (insertAt === orderedKeys.length) {
        for (let i = legacyPos + 1; i < legacyOrder.length; i++) {
          const nextKey = legacyOrder[i];
          const existingIdx = orderedKeys.indexOf(nextKey);
          if (existingIdx >= 0) {
            insertAt = existingIdx;
            break;
          }
        }
      }

      orderedKeys.splice(insertAt, 0, legacyOnlyKey);
      inOrder.add(legacyOnlyKey);
    }

    const computedDataDiffs: DataDiff[] = orderedKeys.map((key, idx) => {
      const fromNew = newDataMap.get(key);
      const fromLegacy = legacyDataMap.get(key);
      const resolvedField = fromNew?.field ?? fromLegacy?.field ?? "Unknown Field";
      const kind = classifyDataKindForField(resolvedField, fromNew?.value, fromLegacy?.value, unorderedRules);
      const csv1 = formatDataCell(fromLegacy?.value);
      const csv2 = formatDataCell(fromNew?.value);

      let delta = "Same in CSV1 and CSV2";
      if (kind === "missing_in_legacy") {
        delta = `${csv2} → —`;
      } else if (kind === "legacy_only") {
        delta = `— → ${csv1}`;
      } else if (kind === "changed") {
        delta = `${csv2} → ${csv1}`;
      }

      return {
        id: `data-${idx}-${key}`,
        field: resolvedField,
        csv1,
        csv2,
        delta,
        kind,
      };
    });

    setFieldDiffs(diffs);
    setDataDiffs(computedDataDiffs);
    setHasCompared(true);
    setFieldsOpen(true);
    setSection2Open(true);
  };

  const handleRemoveUpload = (side: "legacy" | "new") => {
    if (side === "legacy") {
      setLegacyFileName(null);
      setLegacyParsed(null);
    } else {
      setNewFileName(null);
      setNewParsed(null);
    }

    setHasCompared(false);
    setFieldDiffs([]);
    setDataDiffs([]);
    setFieldsOpen(false);
    setSection2Open(false);
  };

  const handleClearAll = () => {
    setLegacyFileName(null);
    setNewFileName(null);
    setLegacyParsed(null);
    setNewParsed(null);
    setHasCompared(false);
    setFieldDiffs([]);
    setDataDiffs([]);
    setFieldsOpen(false);
    setSection2Open(false);
    localStorage.removeItem(CSV_PERSIST_KEY);
  };

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      <div className="bg-card border border-border rounded-lg p-4 space-y-4 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-2 relative">
            <Button
              type="button"
              variant="outline"
              className={cn(
                "w-full justify-start h-auto min-h-12 py-2",
                legacyParsed && "border-emerald-500 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200"
              )}
              onClick={() => document.getElementById("legacy-csv-input")?.click()}
            >
              {legacyParsed ? <CheckCircle2 className="h-4 w-4 mr-2 shrink-0" /> : <Upload className="h-4 w-4 mr-2 shrink-0" />}
              <span className="flex flex-col items-start text-left leading-tight">
                <span>Upload Legacy CSV *</span>
                {legacyParsed && legacyFileName && <span className="text-[11px] font-medium opacity-90">Uploaded: {legacyFileName}</span>}
              </span>
            </Button>
            {legacyParsed && (
              <button
                type="button"
                aria-label="Remove Legacy CSV"
                className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground z-10"
                onClick={() => handleRemoveUpload("legacy")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <input
              id="legacy-csv-input"
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUpload(file, "legacy");
                e.currentTarget.value = "";
              }}
            />
            {!legacyParsed && (
              <p className="text-xs text-muted-foreground">No file selected</p>
            )}
          </div>

          <div className="space-y-2 relative">
            <Button
              type="button"
              variant="outline"
              className={cn(
                "w-full justify-start h-auto min-h-12 py-2",
                newParsed && "border-emerald-500 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200"
              )}
              onClick={() => document.getElementById("new-csv-input")?.click()}
            >
              {newParsed ? <CheckCircle2 className="h-4 w-4 mr-2 shrink-0" /> : <Upload className="h-4 w-4 mr-2 shrink-0" />}
              <span className="flex flex-col items-start text-left leading-tight">
                <span>Upload New CSV *</span>
                {newParsed && newFileName && <span className="text-[11px] font-medium opacity-90">Uploaded: {newFileName}</span>}
              </span>
            </Button>
            {newParsed && (
              <button
                type="button"
                aria-label="Remove New CSV"
                className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground z-10"
                onClick={() => handleRemoveUpload("new")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <input
              id="new-csv-input"
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUpload(file, "new");
                e.currentTarget.value = "";
              }}
            />
            {!newParsed && (
              <p className="text-xs text-muted-foreground">No file selected</p>
            )}
          </div>
        </div>

        <div className="border-t border-border pt-4 flex justify-center items-center gap-3">
          {canCompare && (
            <Button
              type="button"
              variant="outline"
              onClick={handleClearAll}
              className="h-11 px-8 text-sm font-semibold rounded-full"
            >
              Clear
            </Button>
          )}
          <Button
            type="button"
            onClick={handleCompare}
            disabled={!canCompare || hasCompared}
            className="h-11 px-12 text-sm font-semibold rounded-full min-w-[220px]"
          >
            Compare
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <Collapsible open={fieldsOpen} onOpenChange={setFieldsOpen}>
          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
              >
                {fieldsOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <span className="text-sm font-semibold">Fields</span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t border-border">
                {/* Scrollable content: Key and Easy Read scroll away, column headers sticky */}
                <div className="max-h-[54vh] overflow-y-auto overflow-x-hidden">
                  {hasCompared && (
                    <div className="px-3 py-2 border-b border-border bg-card flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="text-muted-foreground font-medium mr-1">Key:</span>
                      <span className="inline-flex items-center rounded px-2 py-0.5 bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300">
                        Present in CSV2 (New) only: {diffSummary.missingInLegacy}
                      </span>
                      <span className="inline-flex items-center rounded px-2 py-0.5 bg-rose-100 text-rose-900 dark:bg-rose-900/30 dark:text-rose-300">
                        Present in CSV1 (Legacy) only: {diffSummary.legacyOnly}
                      </span>
                      <span className="inline-flex items-center rounded px-2 py-0.5 bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300">
                        Different: {diffSummary.changed}
                      </span>
                      <span className="text-muted-foreground ml-auto">Total: {diffSummary.total}</span>
                    </div>
                  )}
                  <div className="px-3 py-2 border-b border-border bg-card text-[11px] text-muted-foreground">
                    Easy read: compare CSV1 (Legacy) and CSV2 (New) directly. Delta shows the exact value change.
                  </div>
                  {/* Sticky column header */}
                  <div className="sticky top-0 z-10 grid grid-cols-[6%_14%_24%_24%_32%] bg-muted border-b border-border py-2 [&>div]:px-4">
                    <div className="text-xs font-semibold">COLUMN</div>
                    <div className="text-xs font-semibold">TITLE</div>
                    <div className="text-xs font-semibold">CSV1 (Legacy)</div>
                    <div className="text-xs font-semibold">CSV2 (New)</div>
                    <div className="text-xs font-semibold">Delta</div>
                  </div>
                  <Table className="w-full table-fixed">
                    <colgroup>
                      <col style={{ width: '6%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '24%' }} />
                      <col style={{ width: '24%' }} />
                      <col style={{ width: '32%' }} />
                    </colgroup>
                    <TableBody>
                      {!hasCompared && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-xs text-muted-foreground py-6 text-center">
                            Upload both CSV files and press Compare.
                          </TableCell>
                        </TableRow>
                      )}
                      {hasCompared && fieldDiffs.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-xs text-muted-foreground py-6 text-center">
                            No differences found (excluding configured ignored columns).
                          </TableCell>
                        </TableRow>
                      )}
                      {fieldDiffs.map((diff) => (
                        <TableRow key={diff.id} className="align-top hover:bg-muted/20">
                          <TableCell className="text-xs font-mono">{diff.columnLetter}</TableCell>
                          <TableCell className="text-xs font-medium">{diff.title}</TableCell>
                          <TableCell className="text-xs whitespace-pre-wrap break-words">
                            {diff.legacy}
                          </TableCell>
                          <TableCell className="text-xs whitespace-pre-wrap break-words">
                            {diff.baseNew}
                          </TableCell>
                          <TableCell className="text-xs whitespace-pre-wrap break-words">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${kindBadgeClass(diff.kind)}`}>
                                {kindLabel(diff.kind)}
                              </span>
                              <div className={cn(
                                "font-medium leading-snug text-foreground"
                              )}>
                                {renderDeltaWithExactHighlight(diff.kind, diff.baseNew, diff.legacy)}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        <Collapsible open={section2Open} onOpenChange={setSection2Open}>
          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
              >
                {section2Open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <span className="text-sm font-semibold">Data</span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t border-border">
                {/* Scrollable content: Summary and Easy Read scroll away, column headers sticky */}
                <div className="max-h-[54vh] overflow-y-auto overflow-x-hidden">
                  {hasCompared && (
                    <div className="px-3 py-2 border-b border-border bg-card flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="text-muted-foreground font-medium mr-1">Summary:</span>
                      <span className="inline-flex items-center rounded px-2 py-0.5 bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300">
                        Present in CSV2 (New) only: {dataSummary.missingInLegacy}
                      </span>
                      <span className="inline-flex items-center rounded px-2 py-0.5 bg-rose-100 text-rose-900 dark:bg-rose-900/30 dark:text-rose-300">
                        Present in CSV1 (Legacy) only: {dataSummary.legacyOnly}
                      </span>
                      <span className="inline-flex items-center rounded px-2 py-0.5 bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300">
                        Different: {dataSummary.changed}
                      </span>
                      <span className="inline-flex items-center rounded px-2 py-0.5 bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                        Same: {dataSummary.same}
                      </span>
                      <span className="text-muted-foreground ml-auto">Total: {dataSummary.total}</span>
                    </div>
                  )}
                  <div className="px-3 py-2 border-b border-border bg-card text-[11px] text-muted-foreground">
                    Easy read: CSV1 = Legacy, CSV2 = New. Delta shows the exact value change.
                  </div>
                  {/* Sticky column header */}
                  <div className="sticky top-0 z-10 grid grid-cols-[18%_22%_22%_38%] bg-muted border-b border-border py-2 [&>div]:px-4">
                    <div className="text-xs font-semibold">FIELD</div>
                    <div className="text-xs font-semibold">CSV1 (Legacy)</div>
                    <div className="text-xs font-semibold">CSV2 (New)</div>
                    <div className="text-xs font-semibold">Delta</div>
                  </div>
                  <Table className="w-full table-fixed">
                    <colgroup>
                      <col style={{ width: '18%' }} />
                      <col style={{ width: '22%' }} />
                      <col style={{ width: '22%' }} />
                      <col style={{ width: '38%' }} />
                    </colgroup>
                    <TableBody>
                      {!hasCompared && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-xs text-muted-foreground py-6 text-center">
                            Upload both CSV files and press Compare.
                          </TableCell>
                        </TableRow>
                      )}
                      {hasCompared && dataDiffs.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-xs text-muted-foreground py-6 text-center">
                            No data fields found under Product Description.
                          </TableCell>
                        </TableRow>
                      )}
                      {dataDiffs.map((diff) => (
                        <TableRow key={diff.id} className="align-top hover:bg-muted/20">
                          <TableCell className="text-xs font-medium whitespace-pre-wrap break-words">{diff.field}</TableCell>
                          <TableCell className="text-xs whitespace-pre-wrap break-words">{diff.csv1}</TableCell>
                          <TableCell className="text-xs whitespace-pre-wrap break-words">{diff.csv2}</TableCell>
                          <TableCell className="text-xs whitespace-pre-wrap break-words">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {diff.kind !== "same" && (
                                <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${kindBadgeClass(diff.kind === "changed" ? "changed" : diff.kind === "missing_in_legacy" ? "missing_in_legacy" : "legacy_only")}`}>
                                  {dataDeltaBadgeLabel(diff.kind)}
                                </span>
                              )}
                              <div className={cn(
                                "font-medium leading-snug text-foreground"
                              )}>
                                {renderDeltaWithExactHighlight(diff.kind, diff.csv2, diff.csv1)}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      </div>
    </div>
  );
}
