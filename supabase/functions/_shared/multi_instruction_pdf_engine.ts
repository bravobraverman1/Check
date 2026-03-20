export type TaskPurpose = "compare" | "extract" | "validate" | "transform" | "other";

export interface TaskOutputContract {
  format: "json" | "text" | "table";
  headings: string[];
  columns: number | null;
  forbidBullets: boolean;
  allowRows: Array<"DIFFERENT" | "ADDED" | "IDENTICAL" | "EQUIVALENT">;
}

export interface TaskFilters {
  variant?: string;
  sku?: string;
  section?: string;
  includeFields: string[];
  excludeFields: string[];
}

export interface TaskRules {
  ignore_rules: string[];
  equivalence_rules: string[];
  verification_rules: string[];
  synonyms: Record<string, string[]>;
  allow_context_match: boolean;
}

export interface Task {
  task_id: string;
  task_purpose: TaskPurpose;
  input_docs: string[];
  filters: TaskFilters;
  output_contract: TaskOutputContract;
  ignore_rules: string[];
  equivalence_rules: string[];
  verification_rules: string[];
  raw_instruction: string;
}

export interface PdfPageInput {
  page: number;
  text: string;
}

export interface PdfDocInput {
  source_doc_id: string;
  pages?: PdfPageInput[];
  text?: string;
}

export interface EvidenceEntry {
  field_raw: string;
  value_raw: string;
  page: number;
  region: [number, number, number, number];
  context_snippet: string;
  source_doc_id: string;
  extraction_method: "text-layout" | "table" | "spec-line" | "icon-ocr" | "diagram" | "footnote";
  confidence: number;
}

export interface TextBlock {
  text: string;
  page: number;
  bbox: [number, number, number, number];
}

export interface TableCell {
  row: number;
  col: number;
  value: string;
  bbox: [number, number, number, number];
}

export interface TableData {
  page: number;
  title: string;
  headers: string[];
  cells: TableCell[];
  confidence: number;
}

export interface IconOcrEntry {
  page: number;
  region: [number, number, number, number];
  text: string;
  confidence: number;
  icon_category: string;
}

export interface DiagramEntry {
  page: number;
  region: [number, number, number, number];
  value: string;
  unit: string;
  context: string;
  confidence: number;
}

export interface FootnoteEntry {
  page: number;
  marker: string;
  text: string;
}

export interface DocIR {
  source_doc_id: string;
  blocks: TextBlock[];
  tables: TableData[];
  kv_candidates: EvidenceEntry[];
  icon_ocr: IconOcrEntry[];
  diagrams: DiagramEntry[];
  footnotes: FootnoteEntry[];
  raw_page_map: Record<number, {
    blocks: TextBlock[];
    tables: TableData[];
    kv_candidates: EvidenceEntry[];
    icon_ocr: IconOcrEntry[];
    diagrams: DiagramEntry[];
    footnotes: FootnoteEntry[];
  }>;
}

export interface CanonicalOccurrence {
  canonical_field: string;
  value_normalized: string;
  value_struct: Record<string, unknown>;
  value_tokens: string[];
  qualifiers: string[];
  evidence: EvidenceEntry;
}

export interface CanonicalIR {
  source_doc_id: string;
  canonical_field_map: Record<string, CanonicalOccurrence[]>;
}

export interface TaskIR {
  source_doc_id: string;
  fields: Record<string, CanonicalOccurrence[]>;
  rules: TaskRules;
  variant_binding_confident: boolean;
}

export interface FieldMatch {
  field_a: string | null;
  field_b: string | null;
  occurrences_a: CanonicalOccurrence[];
  occurrences_b: CanonicalOccurrence[];
  match_pass: 1 | 2 | 3 | 4 | 0;
}

export interface Matches {
  matched: FieldMatch[];
  unmatched_a: string[];
  unmatched_b: string[];
}

export interface ComparisonRow {
  classification: "IDENTICAL" | "EQUIVALENT" | "DIFFERENT" | "ADDED";
  field_a: string;
  value_a: string;
  field_b: string;
  value_b: string;
  reason: string;
}

export interface CompareResults {
  rows: ComparisonRow[];
  coverage: {
    compared_a: string[];
    compared_b: string[];
    unmatched_a: string[];
    unmatched_b: string[];
  };
}

export interface VerificationResult {
  pass: boolean;
  diagnostics: string[];
}

export interface NormalizationProfile {
  useCaseSensitiveUnits?: boolean;
  equivalenceDictionary?: Record<string, string[]>;
}

export interface TaskContext {
  task: Task;
  task_ir_a?: TaskIR;
  task_ir_b?: TaskIR;
}

const RANGE_PATTERN = /(-?\d+(?:\.\d+)?)\s*(?:to|-)\s*(-?\d+(?:\.\d+)?)/i;
const DIMENSION_PATTERN = /(-?\d+(?:\.\d+)?)\s*[xX]\s*(-?\d+(?:\.\d+)?)(?:\s*[xX]\s*(-?\d+(?:\.\d+)?))?\s*(mm|cm|m|in|")?/i;
const SCALAR_PATTERN = /(-?\d+(?:\.\d+)?)(?:\s*(mm|cm|m|in|"|w|kw|v|a|k|kg|g|lm|kwh|hz|ip\d+))?/i;

function normalizeSpace(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function canonicalizeFieldName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUnit(unit: string, useCaseSensitiveUnits: boolean): string {
  if (!unit) return "";
  const trimmed = unit.trim();
  if (trimmed === "\"") return "in";
  return useCaseSensitiveUnits ? trimmed : trimmed.toLowerCase();
}

function parseValueStruct(value: string): { normalized: string; struct: Record<string, unknown>; tokens: string[] } {
  const cleaned = normalizeSpace(value)
    .replace(/[–—]/g, "-")
    .replace(/[×]/g, "x")
    .replace(/°/g, " deg ")
    .replace(/ø/gi, " dia ");

  const tokens = cleaned
    .toLowerCase()
    .split(/[^a-z0-9.]+/g)
    .filter(Boolean);

  const range = cleaned.match(RANGE_PATTERN);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    return {
      normalized: `${Math.min(min, max)}-${Math.max(min, max)}`,
      struct: { type: "range", min: Math.min(min, max), max: Math.max(min, max) },
      tokens,
    };
  }

  const dimensions = cleaned.match(DIMENSION_PATTERN);
  if (dimensions) {
    const values = [dimensions[1], dimensions[2], dimensions[3]]
      .filter(Boolean)
      .map((v) => Number(v));
    const unit = normalizeUnit(dimensions[4] || "", false);
    return {
      normalized: `${values.join("x")}${unit ? ` ${unit}` : ""}`,
      struct: { type: "dimensions", values, unit },
      tokens,
    };
  }

  const scalar = cleaned.match(SCALAR_PATTERN);
  if (scalar) {
    const num = Number(scalar[1]);
    const unit = normalizeUnit(scalar[2] || "", false);
    return {
      normalized: Number.isFinite(num) ? `${num}${unit ? ` ${unit}` : ""}` : cleaned.toLowerCase(),
      struct: { type: "scalar", value: Number.isFinite(num) ? num : cleaned, unit },
      tokens,
    };
  }

  return { normalized: cleaned.toLowerCase(), struct: { type: "text", value: cleaned }, tokens };
}

function inferTaskPurpose(block: string): TaskPurpose {
  const lowered = block.toLowerCase();
  if (/\bcompare|difference|diff\b/.test(lowered)) return "compare";
  if (/\bextract|pull|capture\b/.test(lowered)) return "extract";
  if (/\bvalidate|verify|check\b/.test(lowered)) return "validate";
  if (/\btransform|convert|map\b/.test(lowered)) return "transform";
  return "other";
}

function parseOutputContract(block: string): TaskOutputContract {
  const lowered = block.toLowerCase();
  const format = /\bjson\b/.test(lowered) ? "json" : /\btable\b/.test(lowered) ? "table" : "text";
  const headings = (block.match(/^[A-Z][A-Z _/-]{2,}$/gm) || []).map((h) => h.trim());
  const columnMatch = lowered.match(/(\d+)\s+columns?/);
  const columns = columnMatch ? Number(columnMatch[1]) : null;
  const forbidBullets = /no\s+(?:bullet|numbered)\s+lists?/.test(lowered);
  const allowRows: Array<"DIFFERENT" | "ADDED" | "IDENTICAL" | "EQUIVALENT"> = [];
  if (/different/.test(lowered)) allowRows.push("DIFFERENT");
  if (/\badded\b/.test(lowered)) allowRows.push("ADDED");
  if (/\bidentical\b/.test(lowered)) allowRows.push("IDENTICAL");
  if (/\bequivalent\b/.test(lowered)) allowRows.push("EQUIVALENT");
  if (allowRows.length === 0) {
    allowRows.push("DIFFERENT", "ADDED", "IDENTICAL", "EQUIVALENT");
  }
  return { format, headings, columns, forbidBullets, allowRows };
}

function parseTaskFilters(block: string): TaskFilters {
  const variant = block.match(/\bvariant\s*[:=]\s*([^\n;]+)/i)?.[1]?.trim();
  const sku = block.match(/\bsku\s*[:=]\s*([^\n;]+)/i)?.[1]?.trim();
  const section = block.match(/\bsection\s*[:=]\s*([^\n;]+)/i)?.[1]?.trim();
  const includeFields = Array.from(
    new Set((block.match(/\binclude\s+field[s]?\s*[:=]\s*([^\n]+)/gi) || [])
      .flatMap((line) => line.split(/[:=]/).slice(1))
      .flatMap((chunk) => chunk.split(/[;,]/g))
      .map((v) => canonicalizeFieldName(v))
      .filter(Boolean)),
  );
  const excludeFields = Array.from(
    new Set((block.match(/\b(?:ignore|exclude)\s+field[s]?\s*[:=]\s*([^\n]+)/gi) || [])
      .flatMap((line) => line.split(/[:=]/).slice(1))
      .flatMap((chunk) => chunk.split(/[;,]/g))
      .map((v) => canonicalizeFieldName(v))
      .filter(Boolean)),
  );
  return { variant, sku, section, includeFields, excludeFields };
}

function parseRuleLines(block: string, kind: "ignore" | "equivalence" | "verification"): string[] {
  const lines = normalizeSpace(block).split("\n");
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const lowered = line.toLowerCase();
      if (kind === "ignore") return /\b(ignore|exclude|omit)\b/.test(lowered);
      if (kind === "equivalence") return /\b(equivalent|synonym|same as|normalize)\b/.test(lowered);
      return /\b(verify|coverage|completeness|must|strict|contract)\b/.test(lowered);
    });
}

function parseDocRefs(block: string): string[] {
  const refs = new Set<string>();
  for (const match of block.matchAll(/\b([a-z0-9._/-]+\.pdf)\b/gi)) {
    refs.add(match[1]);
  }
  for (const match of block.matchAll(/["']([^"'\n]+\.pdf)["']/gi)) {
    refs.add(match[1].trim());
  }
  return Array.from(refs);
}

function splitInstructionBlocks(promptText: string): string[] {
  const text = normalizeSpace(promptText);
  if (!text) return [];

  const explicitSplit = text.split(/\n\s*(?:-{3,}|={3,})\s*\n/g).map((b) => b.trim()).filter(Boolean);
  if (explicitSplit.length > 1) return explicitSplit;

  const headingSplit = text.split(/\n(?=#{1,6}\s)/g).map((b) => b.trim()).filter(Boolean);
  if (headingSplit.length > 1) return headingSplit;

  return [text];
}

function parseSynonyms(equivalenceRules: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const rule of equivalenceRules) {
    const match = rule.match(/([a-z0-9 _/-]+)\s*(?:=|->|<->|same as)\s*([a-z0-9 _,/-]+)/i);
    if (!match) continue;
    const left = canonicalizeFieldName(match[1]);
    const rightValues = match[2].split(/[;,]/g).map((v) => canonicalizeFieldName(v)).filter(Boolean);
    if (!left || rightValues.length === 0) continue;
    out[left] = Array.from(new Set([...(out[left] || []), ...rightValues]));
  }
  return out;
}

function toTaskRules(task: Task, profile?: NormalizationProfile): TaskRules {
  const profileSynonyms = profile?.equivalenceDictionary || {};
  return {
    ignore_rules: task.ignore_rules,
    equivalence_rules: task.equivalence_rules,
    verification_rules: task.verification_rules,
    synonyms: {
      ...profileSynonyms,
      ...parseSynonyms(task.equivalence_rules),
    },
    allow_context_match: task.verification_rules.some((line) => /\bcontext\b/i.test(line)),
  };
}

export function parse_instructions(prompt_text: string): Task[] {
  const blocks = splitInstructionBlocks(prompt_text);
  if (blocks.length === 0) return [];

  return blocks.map((block, index) => {
    const output_contract = parseOutputContract(block);
    const filters = parseTaskFilters(block);
    const ignore_rules = parseRuleLines(block, "ignore");
    const equivalence_rules = parseRuleLines(block, "equivalence");
    const verification_rules = parseRuleLines(block, "verification");
    return {
      task_id: `task_${index + 1}`,
      task_purpose: inferTaskPurpose(block),
      input_docs: parseDocRefs(block),
      filters,
      output_contract,
      ignore_rules,
      equivalence_rules,
      verification_rules,
      raw_instruction: block,
    };
  });
}

function sliceContext(lines: string[], i: number): string {
  const start = Math.max(0, i - 1);
  const end = Math.min(lines.length, i + 2);
  return lines.slice(start, end).join(" ").trim();
}

function extractKvFromLine(line: string): { field: string; value: string; method: EvidenceEntry["extraction_method"]; confidence: number } | null {
  const colon = line.match(/^([^:]{2,80}):\s*(.+)$/);
  if (colon) {
    return { field: colon[1].trim(), value: colon[2].trim(), method: "spec-line", confidence: 0.95 };
  }
  const dash = line.match(/^([a-z0-9 _/().%-]{2,80})\s+-\s+(.+)$/i);
  if (dash) {
    return { field: dash[1].trim(), value: dash[2].trim(), method: "spec-line", confidence: 0.88 };
  }
  const dotLead = line.match(/^([a-z0-9 _/().%-]{2,80})\s+\.\.\.\s+(.+)$/i);
  if (dotLead) {
    return { field: dotLead[1].trim(), value: dotLead[2].trim(), method: "spec-line", confidence: 0.84 };
  }
  return null;
}

function buildRawPageMap(pageNumbers: number[]): DocIR["raw_page_map"] {
  const out: DocIR["raw_page_map"] = {};
  for (const page of pageNumbers) {
    out[page] = {
      blocks: [],
      tables: [],
      kv_candidates: [],
      icon_ocr: [],
      diagrams: [],
      footnotes: [],
    };
  }
  return out;
}

export function build_doc_ir(pdf: PdfDocInput): DocIR {
  const pages = (pdf.pages && pdf.pages.length > 0)
    ? pdf.pages
    : [{ page: 1, text: pdf.text || "" }];
  const raw_page_map = buildRawPageMap(pages.map((p) => p.page));
  const blocks: TextBlock[] = [];
  const tables: TableData[] = [];
  const kv_candidates: EvidenceEntry[] = [];
  const icon_ocr: IconOcrEntry[] = [];
  const diagrams: DiagramEntry[] = [];
  const footnotes: FootnoteEntry[] = [];

  for (const pageEntry of pages) {
    const page = Number.isFinite(pageEntry.page) ? pageEntry.page : 1;
    const text = normalizeSpace(pageEntry.text || "");
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

    lines.forEach((line, i) => {
      const block: TextBlock = {
        text: line,
        page,
        bbox: [0, i * 10, 100, i * 10 + 8],
      };
      blocks.push(block);
      raw_page_map[page].blocks.push(block);

      if (/^\*/.test(line) || /\b(front only|note|disclaimer|caveat)\b/i.test(line)) {
        const marker = line.startsWith("*") ? "*" : "note";
        const footnote: FootnoteEntry = { page, marker, text: line };
        footnotes.push(footnote);
        raw_page_map[page].footnotes.push(footnote);
      }

      if ((line.includes("|") || /\t/.test(line)) && line.split(/[|\t]/g).length >= 3) {
        const cells = line.split(/[|\t]/g)
          .map((value, col) => ({
            row: 0,
            col,
            value: value.trim(),
            bbox: [col * 20, i * 10, col * 20 + 18, i * 10 + 8] as [number, number, number, number],
          }))
          .filter((cell) => cell.value.length > 0);
        const table: TableData = {
          page,
          title: lines[i - 1] || "",
          headers: cells.map((cell) => cell.value),
          cells,
          confidence: 0.8,
        };
        tables.push(table);
        raw_page_map[page].tables.push(table);
      }

      const kv = extractKvFromLine(line);
      if (kv) {
        const evidence: EvidenceEntry = {
          field_raw: kv.field,
          value_raw: kv.value,
          page,
          region: [0, i * 10, 100, i * 10 + 8],
          context_snippet: sliceContext(lines, i),
          source_doc_id: pdf.source_doc_id,
          extraction_method: kv.method,
          confidence: kv.confidence,
        };
        kv_candidates.push(evidence);
        raw_page_map[page].kv_candidates.push(evidence);
      }

      const diagramMatch = line.match(/(?:dia|diameter|radius|r|ø|⌀)?\s*(-?\d+(?:\.\d+)?)\s*(mm|cm|m|in|")\b/i);
      if (diagramMatch && /(?:dia|diameter|radius|r|ø|⌀|x)/i.test(line)) {
        const diagram: DiagramEntry = {
          page,
          region: [0, i * 10, 100, i * 10 + 8],
          value: diagramMatch[1],
          unit: normalizeUnit(diagramMatch[2], false),
          context: sliceContext(lines, i),
          confidence: 0.75,
        };
        diagrams.push(diagram);
        raw_page_map[page].diagrams.push(diagram);
      }

      const iconLike = line.match(/\b(ul|etl|ce|fcc|rohs|warranty|ip\d{2}|energy star)\b/gi);
      if (iconLike) {
        const entry: IconOcrEntry = {
          page,
          region: [0, i * 10, 100, i * 10 + 8],
          text: iconLike.join(" "),
          confidence: 0.72,
          icon_category: /\bwarranty\b/i.test(line)
            ? "warranty"
            : /\b(ul|etl|ce|fcc|rohs|energy star)\b/i.test(line)
              ? "certification"
              : /\bip\d{2}\b/i.test(line)
                ? "rating"
                : "",
        };
        icon_ocr.push(entry);
        raw_page_map[page].icon_ocr.push(entry);
      }
    });
  }

  return {
    source_doc_id: pdf.source_doc_id,
    blocks,
    tables,
    kv_candidates,
    icon_ocr,
    diagrams,
    footnotes,
    raw_page_map,
  };
}

function buildQualifiers(entry: EvidenceEntry, footnotes: FootnoteEntry[]): string[] {
  const out = new Set<string>();
  if (/\*/.test(entry.value_raw) || /\*/.test(entry.field_raw)) {
    for (const note of footnotes) {
      if (note.marker === "*" || /\*/.test(note.text)) out.add(note.text);
    }
  }
  if (/\b(front only|from front|measured from)\b/i.test(entry.context_snippet)) {
    out.add(entry.context_snippet);
  }
  return Array.from(out);
}

export function canonicalize(doc_ir: DocIR, normalization_profile: NormalizationProfile = {}): CanonicalIR {
  const canonical_field_map: Record<string, CanonicalOccurrence[]> = {};

  for (const candidate of doc_ir.kv_candidates) {
    const canonical_field = canonicalizeFieldName(candidate.field_raw);
    if (!canonical_field) continue;

    const parsed = parseValueStruct(candidate.value_raw);
    const occurrence: CanonicalOccurrence = {
      canonical_field,
      value_normalized: parsed.normalized,
      value_struct: parsed.struct,
      value_tokens: parsed.tokens,
      qualifiers: buildQualifiers(candidate, doc_ir.footnotes),
      evidence: {
        ...candidate,
        value_raw: normalization_profile.useCaseSensitiveUnits
          ? candidate.value_raw.trim()
          : candidate.value_raw.trim(),
      },
    };

    if (!canonical_field_map[canonical_field]) canonical_field_map[canonical_field] = [];
    canonical_field_map[canonical_field].push(occurrence);
  }

  const keys = Object.keys(canonical_field_map).sort((a, b) => a.localeCompare(b));
  const ordered: Record<string, CanonicalOccurrence[]> = {};
  for (const key of keys) {
    ordered[key] = canonical_field_map[key];
  }

  return {
    source_doc_id: doc_ir.source_doc_id,
    canonical_field_map: ordered,
  };
}

function isFieldIgnored(field: string, rules: TaskRules): boolean {
  const lowered = field.toLowerCase();
  return rules.ignore_rules.some((line) => {
    const parts = line.toLowerCase().split(/[:,]/g).map((v) => v.trim()).filter(Boolean);
    return parts.some((part) => part.length > 1 && lowered.includes(part));
  });
}

export function apply_filters(canonical_ir: CanonicalIR, task: Task): TaskIR {
  const rules = toTaskRules(task);
  const fields: Record<string, CanonicalOccurrence[]> = {};
  const includeSet = new Set(task.filters.includeFields.map((f) => canonicalizeFieldName(f)).filter(Boolean));
  const excludeSet = new Set(task.filters.excludeFields.map((f) => canonicalizeFieldName(f)).filter(Boolean));
  let variant_binding_confident = !task.filters.variant && !task.filters.sku;

  for (const [field, occurrences] of Object.entries(canonical_ir.canonical_field_map)) {
    if (isFieldIgnored(field, rules)) continue;
    if (excludeSet.has(field)) continue;
    if (includeSet.size > 0 && !includeSet.has(field)) continue;

    let scopedOccurrences = occurrences;
    if (task.filters.variant || task.filters.sku) {
      const token = canonicalizeFieldName(task.filters.variant || task.filters.sku || "");
      scopedOccurrences = occurrences.filter((occ) =>
        canonicalizeFieldName(occ.evidence.context_snippet).includes(token) ||
        canonicalizeFieldName(occ.value_normalized).includes(token)
      );
      if (scopedOccurrences.length > 0) {
        variant_binding_confident = true;
      }
    }

    if (scopedOccurrences.length > 0) {
      fields[field] = scopedOccurrences;
    }
  }

  if ((task.filters.variant || task.filters.sku) && !variant_binding_confident) {
    return {
      source_doc_id: canonical_ir.source_doc_id,
      fields: {},
      rules,
      variant_binding_confident: false,
    };
  }

  return {
    source_doc_id: canonical_ir.source_doc_id,
    fields,
    rules,
    variant_binding_confident,
  };
}

function dimensionSignature(occurrence: CanonicalOccurrence): string {
  const structType = occurrence.value_struct.type;
  if (structType !== "dimensions") return "";
  const values = Array.isArray(occurrence.value_struct.values)
    ? [...(occurrence.value_struct.values as number[])].sort((a, b) => a - b)
    : [];
  const unit = typeof occurrence.value_struct.unit === "string" ? occurrence.value_struct.unit : "";
  return `${values.join("x")}|${unit}`;
}

function valuesEquivalent(a: CanonicalOccurrence[], b: CanonicalOccurrence[], rules: TaskRules): boolean {
  const left = new Set(a.map((x) => x.value_normalized));
  const right = new Set(b.map((x) => x.value_normalized));
  for (const value of left) {
    if (right.has(value)) return true;
  }

  for (const rule of rules.equivalence_rules) {
    const normalizedRule = normalizeSpace(rule).toLowerCase();
    for (const lv of left) {
      for (const rv of right) {
        if (normalizedRule.includes(lv.toLowerCase()) && normalizedRule.includes(rv.toLowerCase())) return true;
      }
    }
  }

  return false;
}

function pickBestValue(values: CanonicalOccurrence[]): string {
  if (values.length === 0) return "";
  const sorted = [...values].sort((a, b) => b.evidence.confidence - a.evidence.confidence);
  return sorted[0].value_normalized || sorted[0].evidence.value_raw;
}

export function match_fields(task_ir_A: TaskIR, task_ir_B: TaskIR, task_rules: TaskRules): Matches {
  const fieldsA = Object.keys(task_ir_A.fields).sort((a, b) => a.localeCompare(b));
  const fieldsB = new Set(Object.keys(task_ir_B.fields));
  const matched: FieldMatch[] = [];
  const consumedB = new Set<string>();

  for (const fieldA of fieldsA) {
    if (fieldsB.has(fieldA)) {
      matched.push({
        field_a: fieldA,
        field_b: fieldA,
        occurrences_a: task_ir_A.fields[fieldA],
        occurrences_b: task_ir_B.fields[fieldA],
        match_pass: 1,
      });
      consumedB.add(fieldA);
    }
  }

  for (const fieldA of fieldsA) {
    if (matched.some((m) => m.field_a === fieldA)) continue;
    const synonyms = task_rules.synonyms[fieldA] || [];
    const target = synonyms.find((candidate) => fieldsB.has(candidate) && !consumedB.has(candidate));
    if (!target) continue;
    matched.push({
      field_a: fieldA,
      field_b: target,
      occurrences_a: task_ir_A.fields[fieldA],
      occurrences_b: task_ir_B.fields[target],
      match_pass: 2,
    });
    consumedB.add(target);
  }

  for (const fieldA of fieldsA) {
    if (matched.some((m) => m.field_a === fieldA)) continue;
    const signatureA = dimensionSignature(task_ir_A.fields[fieldA][0]);
    if (!signatureA) continue;
    let target: string | null = null;
    for (const candidate of fieldsB) {
      if (consumedB.has(candidate)) continue;
      const signatureB = dimensionSignature(task_ir_B.fields[candidate][0]);
      if (signatureA && signatureB && signatureA === signatureB) {
        target = candidate;
        break;
      }
    }
    if (!target) continue;
    matched.push({
      field_a: fieldA,
      field_b: target,
      occurrences_a: task_ir_A.fields[fieldA],
      occurrences_b: task_ir_B.fields[target],
      match_pass: 3,
    });
    consumedB.add(target);
  }

  if (task_rules.allow_context_match) {
    for (const fieldA of fieldsA) {
      if (matched.some((m) => m.field_a === fieldA)) continue;
      const contextA = canonicalizeFieldName(task_ir_A.fields[fieldA][0]?.evidence.context_snippet || "");
      if (!contextA) continue;
      let target: string | null = null;
      for (const candidate of fieldsB) {
        if (consumedB.has(candidate)) continue;
        const contextB = canonicalizeFieldName(task_ir_B.fields[candidate][0]?.evidence.context_snippet || "");
        if (!contextB) continue;
        if (contextA.includes(contextB) || contextB.includes(contextA)) {
          target = candidate;
          break;
        }
      }
      if (!target) continue;
      matched.push({
        field_a: fieldA,
        field_b: target,
        occurrences_a: task_ir_A.fields[fieldA],
        occurrences_b: task_ir_B.fields[target],
        match_pass: 4,
      });
      consumedB.add(target);
    }
  }

  const unmatched_a = fieldsA.filter((field) => !matched.some((item) => item.field_a === field));
  const unmatched_b = Array.from(fieldsB).sort((a, b) => a.localeCompare(b)).filter((field) => !consumedB.has(field));

  return {
    matched,
    unmatched_a,
    unmatched_b,
  };
}

export function compare_matches(matches: Matches, task_rules: TaskRules): CompareResults {
  const rows: ComparisonRow[] = [];
  const compared_a: string[] = [];
  const compared_b: string[] = [];

  for (const match of matches.matched) {
    if (!match.field_a || !match.field_b) continue;
    compared_a.push(match.field_a);
    compared_b.push(match.field_b);

    const leftValue = pickBestValue(match.occurrences_a);
    const rightValue = pickBestValue(match.occurrences_b);
    if (leftValue === rightValue) {
      rows.push({
        classification: "IDENTICAL",
        field_a: match.field_a,
        value_a: leftValue,
        field_b: match.field_b,
        value_b: rightValue,
        reason: "exact_normalized_match",
      });
      continue;
    }

    if (valuesEquivalent(match.occurrences_a, match.occurrences_b, task_rules)) {
      rows.push({
        classification: "EQUIVALENT",
        field_a: match.field_a,
        value_a: leftValue,
        field_b: match.field_b,
        value_b: rightValue,
        reason: "equivalence_rule_applied",
      });
      continue;
    }

    rows.push({
      classification: "DIFFERENT",
      field_a: match.field_a,
      value_a: leftValue,
      field_b: match.field_b,
      value_b: rightValue,
      reason: `semantic_mismatch_pass_${match.match_pass}`,
    });
  }

  for (const field of matches.unmatched_a) {
    rows.push({
      classification: "ADDED",
      field_a: field,
      value_a: "",
      field_b: "",
      value_b: "",
      reason: "present_only_in_A",
    });
  }

  for (const field of matches.unmatched_b) {
    rows.push({
      classification: "ADDED",
      field_a: "",
      value_a: "",
      field_b: field,
      value_b: "",
      reason: "present_only_in_B",
    });
  }

  return {
    rows,
    coverage: {
      compared_a,
      compared_b,
      unmatched_a: [...matches.unmatched_a],
      unmatched_b: [...matches.unmatched_b],
    },
  };
}

export function verify(task_context: TaskContext, results: CompareResults): VerificationResult {
  const diagnostics: string[] = [];
  const rules = toTaskRules(task_context.task);
  const reportableRows = results.rows.filter((row) => row.classification === "DIFFERENT" || row.classification === "ADDED");

  if (task_context.task.task_purpose === "compare") {
    const sourceA = Object.keys(task_context.task_ir_a?.fields || {});
    const sourceB = Object.keys(task_context.task_ir_b?.fields || {});
    const accountedA = new Set([...results.coverage.compared_a, ...results.coverage.unmatched_a]);
    const accountedB = new Set([...results.coverage.compared_b, ...results.coverage.unmatched_b]);
    if (sourceA.some((key) => !accountedA.has(key))) {
      diagnostics.push("coverage_failed_A");
    }
    if (sourceB.some((key) => !accountedB.has(key))) {
      diagnostics.push("coverage_failed_B");
    }
  }

  for (const ignored of rules.ignore_rules) {
    const lowered = ignored.toLowerCase();
    const leaked = reportableRows.some((row) =>
      row.field_a.toLowerCase().includes(lowered) || row.field_b.toLowerCase().includes(lowered)
    );
    if (leaked) diagnostics.push(`ignored_field_leaked:${ignored}`);
  }

  if (task_context.task.output_contract.forbidBullets) {
    // output formatting is enforced in format_output; this verifies the contract was read.
    diagnostics.push("forbid_bullets_contract_present");
  }

  const hardFailures = diagnostics.filter((item) => item.startsWith("coverage_failed") || item.startsWith("ignored_field_leaked"));
  return {
    pass: hardFailures.length === 0,
    diagnostics,
  };
}

export function format_output(results: CompareResults, task_output_contract: TaskOutputContract): string {
  const allowSet = new Set(task_output_contract.allowRows);
  const rows = results.rows.filter((row) => allowSet.has(row.classification));
  const reportable = rows.filter((row) => row.classification === "DIFFERENT" || row.classification === "ADDED");

  if (task_output_contract.format === "json") {
    return JSON.stringify({ rows: reportable }, null, 2);
  }

  if (task_output_contract.format === "table") {
    const header = ["classification", "field_a", "value_a", "field_b", "value_b", "reason"];
    const body = reportable
      .map((row) => [row.classification, row.field_a, row.value_a, row.field_b, row.value_b, row.reason].join("\t"))
      .join("\n");
    return `${header.join("\t")}\n${body}`.trim();
  }

  return reportable
    .map((row) => `${row.classification}|${row.field_a}|${row.value_a}|${row.field_b}|${row.value_b}|${row.reason}`)
    .join("\n")
    .trim();
}

export const MULTI_INSTRUCTION_PDF_ENGINE_SYSTEM_SPEC = `SYSTEM: Document Processing Engine
You are a precise document data extraction engine.
Authority:
- The user prompt is the SOLE authority for what to extract, what to omit, and the output format.
- Instruction PDFs attached by the user are secondary authority and clarify the user prompt.
- Input documents (datasheets, webpages) are the only factual sources. No guessing, no external knowledge.
Data rules:
- Extract ONLY what the user prompt asks for. If the prompt says to omit a field, do NOT include it.
- If a value is genuinely absent from all sources, output KEY: MISSING***
- Use KEY: VALUE format (uppercase keys, colon separator) unless the user prompt specifies otherwise.
Output format — STRICTLY ENFORCED:
- Output ONLY clean KEY: VALUE lines. One field per line. No bullet points, no asterisks, no markdown.
- ABSOLUTELY NO reasoning, thinking, commentary, self-talk, "let me check", "one last check", "okay", or meta-text.
- ABSOLUTELY NO chain-of-thought. Do NOT narrate your process. Output data ONLY.
- Every line must match the pattern: FIELD_NAME: value
- If your output contains ANY text that is not a KEY: VALUE line, you have failed.`;

export function buildMultiInstructionSystemPrompt(
  jsonMode: boolean,
  customSystemPrompt?: string,
): string {
  const custom = (customSystemPrompt || "").trim();
  if (!custom) {
    return MULTI_INSTRUCTION_PDF_ENGINE_SYSTEM_SPEC;
  }
  // Admin/caller system prompt is primary; engine spec provides process discipline only.
  return `${MULTI_INSTRUCTION_PDF_ENGINE_SYSTEM_SPEC}\n\n${custom}`;
}
