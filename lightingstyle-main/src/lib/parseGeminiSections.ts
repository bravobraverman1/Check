const GEMINI_SECTION_HEADER_RE = /===\s*([A-Za-z0-9_\-/ ]{2,80})\s*===/g;

const normalizeSectionHeader = (rawHeader: string): string => {
  const normalized = rawHeader
    .trim()
    .toUpperCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (normalized === "FILTER_PROPOSAL" || normalized === "FILTER_PROPOSALS") {
    return "FILTERS_PROPOSAL";
  }
  if (normalized === "CONFLICT") {
    return "CONFLICTS";
  }
  return normalized;
};

function getGeminiSectionHeaders(raw: string): Array<{ name: string; start: number; end: number }> {
  const headers: Array<{ name: string; start: number; end: number }> = [];
  const regex = new RegExp(GEMINI_SECTION_HEADER_RE);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(raw)) !== null) {
    const normalizedName = normalizeSectionHeader(match[1]);
    if (!normalizedName) continue;
    headers.push({
      name: normalizedName,
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return headers;
}

export function hasGeminiSectionHeaders(raw: string): boolean {
  return getGeminiSectionHeaders(raw).length > 0;
}

export function extractGeminiLeadingText(raw: string): string {
  const headers = getGeminiSectionHeaders(raw);
  if (headers.length === 0) return raw.trim();
  return raw.slice(0, headers[0].start).trim();
}

/**
 * Parse a Gemini response that uses ===SECTION_NAME=== delimiters.
 * Returns a map of section name → content string (trimmed).
 */
export function parseGeminiSections(raw: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const headers = getGeminiSectionHeaders(raw);

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].end;
    const end = i + 1 < headers.length ? headers[i + 1].start : raw.length;
    sections[headers[i].name] = raw.slice(start, end).trim();
  }

  return sections;
}

export interface FilterProposal {
  filterName: string;
  value: string;
  confidence: number;
}

/**
 * Normalize a confidence value that Gemini may return in various formats:
 * "92", "92%", "0.92", "92 / 100" → 92
 * Missing/invalid → 0
 */
function normalizeConfidence(raw: string): number {
  const clampConfidence = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
  };

  if (!raw) return 0;
  const s = raw.trim().replace(/%$/, "").trim();
  // Handle "92 / 100" format
  const fractionMatch = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*100$/);
  if (fractionMatch) return clampConfidence(parseFloat(fractionMatch[1]));
  const outOfMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:out of|of)\s*100/i);
  if (outOfMatch) return clampConfidence(parseFloat(outOfMatch[1]));
  const num = parseFloat(s);
  if (isNaN(num)) {
    const embeddedFraction = s.match(/(\d+(?:\.\d+)?)\s*\/\s*100/);
    if (embeddedFraction) return clampConfidence(parseFloat(embeddedFraction[1]));
    const embeddedNumber = s.match(/(\d+(?:\.\d+)?)/);
    if (!embeddedNumber) return 0;
    const embedded = parseFloat(embeddedNumber[1]);
    if (!isFinite(embedded)) return 0;
    if (embedded > 0 && embedded <= 1) return clampConfidence(embedded * 100);
    return clampConfidence(embedded);
  }
  // If 0-1 range (e.g. 0.92), convert to 0-100
  if (num > 0 && num <= 1) return clampConfidence(num * 100);
  return clampConfidence(num);
}

/**
 * Parse the FILTERS_PROPOSAL section into structured data.
 * Expected format per line: FILTER_NAME | VALUE | CONFIDENCE
 * Filter names are trimmed; confidence is normalized from various formats.
 */
export function parseFilterProposals(raw: string): FilterProposal[] {
  if (!raw || raw.trim() === "NONE") return [];
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const proposals: FilterProposal[] = [];

  const cleanFieldValue = (value: string): string => {
    const cleaned = value
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/^'|'$/g, "")
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .trim();
    return cleaned;
  };

  const stripFieldLabel = (value: string): string =>
    cleanFieldValue(value)
      .replace(/^\s*(?:filter(?:\s*name)?|field|key)\s*[:=-]\s*/i, "")
      .replace(/^\s*value\s*[:=-]\s*/i, "")
      .trim();

  const parseFromPipeParts = (parts: string[]): FilterProposal | null => {
    if (parts.length < 2) return null;

    let filterName = "";
    let value = "";
    let confidenceRaw = "";

    for (const rawPart of parts) {
      const part = cleanFieldValue(rawPart);
      if (!part) continue;

      if (!confidenceRaw && /confidence/i.test(part)) {
        const stripped = part.replace(/^\s*confidence\s*[:=-]?\s*/i, "").trim();
        confidenceRaw = stripped || part;
        continue;
      }

      if (!filterName && /^\s*(?:filter(?:\s*name)?|field|key)\s*[:=-]/i.test(part)) {
        filterName = stripFieldLabel(part);
        continue;
      }

      if (!value && /^\s*value\s*[:=-]/i.test(part)) {
        value = stripFieldLabel(part);
        continue;
      }
    }

    const unlabeled = parts
      .map((p) => cleanFieldValue(p))
      .filter((p) => p.length > 0)
      .filter((p) => !/^\s*confidence\s*[:=-]?/i.test(p));

    if (!filterName && unlabeled.length > 0) filterName = stripFieldLabel(unlabeled[0]);
    if (!value && unlabeled.length > 1) value = stripFieldLabel(unlabeled[1]);

    if (!confidenceRaw && parts.length >= 3) confidenceRaw = cleanFieldValue(parts[2]);

    if (!filterName || !value) return null;

    return {
      filterName,
      value,
      confidence: normalizeConfidence(confidenceRaw),
    };
  };

  const parseConfidenceLine = (line: string): FilterProposal | null => {
    const normalizedLine = line.replace(/^[-*]\s*/, "").trim();
    if (!normalizedLine || normalizedLine.toUpperCase() === "NONE") return null;
    if (/^\|?\s*filter(?:\s*name)?\s*\|\s*value\s*\|\s*confidence\s*\|?$/i.test(normalizedLine)) {
      return null;
    }

    const pipeFriendly = normalizedLine.replace(/^\|\s*/, "").replace(/\s*\|$/, "");
    const parts = pipeFriendly.split("|").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      const fromParts = parseFromPipeParts(parts);
      if (fromParts) return fromParts;
    }

    const kv = normalizedLine.match(
      /filter(?:\s*name)?\s*[:=-]\s*(.+?)(?:\s*[;|,]\s*)value\s*[:=-]\s*(.+?)(?:\s*[;|,]\s*)confidence\s*[:=-]\s*(.+)$/i,
    );
    if (kv) {
      return {
        filterName: stripFieldLabel(kv[1]),
        value: stripFieldLabel(kv[2]),
        confidence: normalizeConfidence(kv[3]),
      };
    }

    const withNamedConfidence = normalizedLine.match(
      /^(.+?)\s*[:=-]\s*(.+?)\s*\(?\s*confidence\s*[:=]\s*([^)]+)\)?\s*$/i,
    );
    if (withNamedConfidence) {
      return {
        filterName: withNamedConfidence[1].trim(),
        value: withNamedConfidence[2].trim(),
        confidence: normalizeConfidence(withNamedConfidence[3].trim()),
      };
    }

    const bracketConfidence = normalizedLine.match(/^(.+?)\s*[:=-]\s*(.+?)\s*\(\s*([^)]+)\s*\)\s*$/i);
    if (bracketConfidence && /confidence|\d/.test(bracketConfidence[3])) {
      return {
        filterName: stripFieldLabel(bracketConfidence[1]),
        value: stripFieldLabel(bracketConfidence[2]),
        confidence: normalizeConfidence(bracketConfidence[3]),
      };
    }

    const compactNamedConfidence = normalizedLine.match(
      /^(.+?)\s*\|\s*(.+?)\s*\(?\s*confidence\s*[:=]?\s*(\d+(?:\.\d+)?(?:\s*\/\s*100|%)?)\)?\s*$/i,
    );
    if (compactNamedConfidence) {
      return {
        filterName: compactNamedConfidence[1].trim(),
        value: compactNamedConfidence[2].trim(),
        confidence: normalizeConfidence(compactNamedConfidence[3].trim()),
      };
    }

    return null;
  };

  for (const line of lines) {
    const parsed = parseConfidenceLine(line);
    if (!parsed) continue;
    proposals.push(parsed);
  }

  return proposals;
}
