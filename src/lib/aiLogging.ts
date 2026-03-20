import { stripTrailingUnitSuffix } from "@/lib/unitNormalization";

/**
 * AI Logging — Tracks AI-generated outputs and computes diffs for logging.
 *
 * Architecture (Option C — Single Write on Dock):
 * - AI outputs are captured in memory (refs) when generation completes
 * - On "Move to Loading Dock", both generated and edited versions are sent to
 *   the AI_Logging sheet tab in one write
 * - Only fields where AI was actually called are logged (manual edits only = no log)
 * - Word-level diff is computed and sent to the edge function for rich text formatting
 *
 * Columns: SKU | Timestamp | AI-Data (Generated) | AI-Data (Edited) |
 *          AI-Description (Generated) | AI-Description (Edited) |
 *          Filters (Generated) | Filters (Edited) | Conflicts
 */

// ── Types ──────────────────────────────────────────────────────

export interface AiLogEntry {
  sku: string;
  timestamp: string;
  aiData?: { generated: string; edited: string };
  aiDescription?: { generated: string; edited: string };
  filters?: { generated: string; edited: string };
  conflicts?: string;
}

/** Word-level diff token */
export interface DiffToken {
  text: string;
  type: "unchanged" | "added" | "removed";
}

// ── Tracking state (module-level refs) ──────────────────────────

/** Stores the last AI-generated raw outputs, keyed per field */
const _tracked: {
  aiData: string | null;
  aiDescription: string | null;
  filters: string | null;
} = {
  aiData: null,
  aiDescription: null,
  filters: null,
};

/** Record that AI was called for a field (to distinguish from manual typing) */
export function trackAiGenerated(
  field: "aiData" | "aiDescription" | "filters",
  rawOutput: string,
): void {
  _tracked[field] = rawOutput;
}

/** Clear all tracked outputs (call on form reset / SKU change) */
export function clearAiTracking(): void {
  _tracked.aiData = null;
  _tracked.aiDescription = null;
  _tracked.filters = null;
}

/** Check if any AI generation was tracked for the current session */
export function hasAnyAiTracking(): boolean {
  return _tracked.aiData !== null || _tracked.aiDescription !== null || _tracked.filters !== null;
}

/** Get the raw tracked filter string (for restricting edited filter keys) */
export function getTrackedFilters(): string | null {
  return _tracked.filters;
}

/**
 * Build the log entry by comparing tracked generated outputs with current edited values.
 * Returns null if no AI was called for any field.
 */
export function buildAiLogEntry(
  sku: string,
  currentValues: {
    aiData: string;
    aiDescription: string;
    filters: string; // semicolon-separated format: "Colour=WHITE;IP Rating=IP65"
    conflicts?: string;
  },
): AiLogEntry | null {
  if (!hasAnyAiTracking()) return null;

  const entry: AiLogEntry = {
    sku,
    timestamp: new Date().toISOString(),
  };

  let hasAtLeastOneField = false;

  if (_tracked.aiData !== null) {
    entry.aiData = {
      generated: _tracked.aiData,
      edited: currentValues.aiData,
    };
    hasAtLeastOneField = true;
  }

  if (_tracked.aiDescription !== null) {
    entry.aiDescription = {
      generated: _tracked.aiDescription,
      edited: currentValues.aiDescription,
    };
    hasAtLeastOneField = true;
  }

  if (_tracked.filters !== null) {
    entry.filters = {
      generated: _tracked.filters,
      edited: currentValues.filters,
    };
    hasAtLeastOneField = true;
  }

  if (currentValues.conflicts?.trim()) {
    entry.conflicts = currentValues.conflicts.trim();
  }

  return hasAtLeastOneField ? entry : null;
}

// ── Word-level diff ──────────────────────────────────────────────

/**
 * Compute word-level diff between two strings.
 * Returns tokens for the EDITED text with markers for added/unchanged words.
 * Removed words are returned as separate tokens at the position they were removed.
 */
export function computeWordDiff(generated: string, edited: string): DiffToken[] {
  const genWords = tokenize(generated);
  const editWords = tokenize(edited);

  // LCS (Longest Common Subsequence) to find matching words
  const lcs = longestCommonSubsequence(genWords, editWords);
  const lcsSet = new Set(lcs.map((m) => `${m.genIdx}:${m.editIdx}`));

  const tokens: DiffToken[] = [];
  let lcsPtr = 0;
  let genPtr = 0;
  let editPtr = 0;

  while (editPtr < editWords.length || genPtr < genWords.length) {
    // Check if current positions are in LCS
    const currentLcs = lcsPtr < lcs.length ? lcs[lcsPtr] : null;

    if (currentLcs && genPtr === currentLcs.genIdx && editPtr === currentLcs.editIdx) {
      // Matched word
      tokens.push({ text: editWords[editPtr], type: "unchanged" });
      genPtr++;
      editPtr++;
      lcsPtr++;
    } else if (currentLcs && genPtr < currentLcs.genIdx && editPtr < currentLcs.editIdx) {
      // Both have extra words before next match — removed from gen, added in edit
      // Add removed words first
      while (genPtr < currentLcs.genIdx) {
        tokens.push({ text: genWords[genPtr], type: "removed" });
        genPtr++;
      }
      // Then added words
      while (editPtr < currentLcs.editIdx) {
        tokens.push({ text: editWords[editPtr], type: "added" });
        editPtr++;
      }
    } else if (currentLcs && genPtr < currentLcs.genIdx) {
      // Removed word from generated
      tokens.push({ text: genWords[genPtr], type: "removed" });
      genPtr++;
    } else if (currentLcs && editPtr < currentLcs.editIdx) {
      // Added word in edited
      tokens.push({ text: editWords[editPtr], type: "added" });
      editPtr++;
    } else if (!currentLcs && editPtr < editWords.length) {
      // Past all LCS matches — remaining edited words are added
      tokens.push({ text: editWords[editPtr], type: "added" });
      editPtr++;
    } else if (!currentLcs && genPtr < genWords.length) {
      // Past all LCS matches — remaining generated words are removed
      tokens.push({ text: genWords[genPtr], type: "removed" });
      genPtr++;
    } else {
      break;
    }
  }

  return tokens;
}

/**
 * Compute pair-level diff for semicolon-delimited filters (Key=Value;Key=Value).
 * This avoids whole-string diffs and highlights only changed filter pairs.
 */
export function computeFilterDiff(generated: string, edited: string): DiffToken[] {
  /** Strip trailing unit suffixes so "69mm" and "69" compare equal.
   *  Uses the shared unit alias table from unitNormalization.ts — single source of truth. */
  const stripUnit = (val: string): string => stripTrailingUnitSuffix(val);

  const parsePairs = (input: string): Array<{ key: string; value: string }> =>
    input
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eqIdx = part.indexOf("=");
        if (eqIdx <= 0) return { key: part, value: "" };
        return {
          key: part.slice(0, eqIdx).trim(),
          value: part.slice(eqIdx + 1).trim(),
        };
      });

  const genPairs = parsePairs(generated);
  const editPairs = parsePairs(edited);

  const genMap = new Map(genPairs.map((p) => [p.key, p.value]));
  const editMap = new Map(editPairs.map((p) => [p.key, p.value]));

  const orderedKeys: string[] = [];
  for (const p of genPairs) if (!orderedKeys.includes(p.key)) orderedKeys.push(p.key);
  for (const p of editPairs) if (!orderedKeys.includes(p.key)) orderedKeys.push(p.key);

  const tokens: DiffToken[] = [];
  let first = true;
  const pushToken = (text: string, type: DiffToken["type"]) => {
    const withSep = first ? text : `;${text}`;
    tokens.push({ text: withSep, type });
    first = false;
  };

  for (const key of orderedKeys) {
    const genVal = genMap.get(key);
    const editVal = editMap.get(key);

    if (genVal !== undefined && editVal !== undefined) {
      const normalizedGen = stripUnit(genVal);
      const normalizedEdit = stripUnit(editVal);
      const genBlank = normalizedGen === "";
      const editBlank = normalizedEdit === "";

      if (genBlank && editBlank) {
        pushToken(`${key}=`, "unchanged");
      } else if (genBlank && !editBlank) {
        // AI left it blank; user/manual value should be shown as added (green)
        pushToken(`${key}=${editVal}`, "added");
      } else if (!genBlank && editBlank) {
        pushToken(`${key}=${genVal}`, "removed");
      } else if (normalizedGen === normalizedEdit) {
        // Compare stripped values so unit-only diffs are ignored
        pushToken(`${key}=${editVal}`, "unchanged");
      } else {
        pushToken(`${key}=${genVal}`, "removed");
        pushToken(`${key}=${editVal}`, "added");
      }
    } else if (genVal !== undefined) {
      pushToken(`${key}=${genVal}`, "removed");
    } else if (editVal !== undefined) {
      pushToken(`${key}=${editVal}`, "added");
    }
  }

  return tokens;
}

/** Tokenize text into words preserving whitespace info */
function tokenize(text: string): string[] {
  if (!text.trim()) return [];
  // Split on whitespace but keep newlines as separate tokens
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

/** LCS match entry */
interface LcsMatch {
  genIdx: number;
  editIdx: number;
}

/** Standard LCS algorithm returning matched index pairs */
function longestCommonSubsequence(a: string[], b: string[]): LcsMatch[] {
  const m = a.length;
  const n = b.length;

  // Build DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matches
  const matches: LcsMatch[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      matches.unshift({ genIdx: i - 1, editIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matches;
}

/**
 * Build a serialized diff representation for the edge function.
 * Format: array of { text, type } where type is "u" (unchanged), "a" (added), "r" (removed)
 */
export function serializeDiff(tokens: DiffToken[]): Array<{ t: string; d: "u" | "a" | "r" }> {
  return tokens.map((tok) => ({
    t: tok.text,
    d: tok.type === "unchanged" ? "u" as const : tok.type === "added" ? "a" as const : "r" as const,
  }));
}

/**
 * Build filter string from spec values in the logging format.
 * Format: "Colour=WHITE;IP Rating=IP65;Lumens=1-199"
 * If restrictToKeys is provided, only include those filter names (for consistent diffing).
 */
export function buildFilterLogString(
  specValues: Record<string, string>,
  properties: Array<{ key: string; name: string }>,
  restrictToKeys?: Set<string>,
  includeBlankRestrictedKeys = false,
): string {
  const toDisplayName = (rawName: string): string =>
    rawName
      .replace(/\*/g, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();

  const shouldIncludeName = (displayName: string): boolean => {
    if (!restrictToKeys) return true;
    const baseName = displayName.replace(/\s*#\d+\s*$/, "").trim();
    return restrictToKeys.has(displayName) || restrictToKeys.has(baseName);
  };

  const parts: string[] = [];

  // For AI logging diffs, optionally keep all restricted keys visible as Key=
  if (restrictToKeys && includeBlankRestrictedKeys) {
    for (const prop of properties) {
      const displayName = toDisplayName(prop.name);
      if (!shouldIncludeName(displayName)) continue;
      const value = specValues[prop.key]?.trim() ?? "";
      parts.push(`${displayName}=${value}`);
    }
    return parts.join(";");
  }

  for (const [key, value] of Object.entries(specValues)) {
    if (!value?.trim()) continue;
    const prop = properties.find((p) => p.key === key);
    if (!prop) continue;
    const displayName = toDisplayName(prop.name);
    if (!shouldIncludeName(displayName)) continue;
    parts.push(`${displayName}=${value.trim()}`);
  }
  return parts.join(";");
}

/**
 * Extract filter display names from a tracked filter string.
 * Input: "Colour=WHITE;IP Rating=IP65" → Set(["Colour", "IP Rating"])
 */
export function extractFilterKeys(filterString: string): Set<string> {
  const keys = new Set<string>();
  if (!filterString) return keys;
  for (const part of filterString.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) keys.add(part.slice(0, eqIdx).trim());
  }
  return keys;
}
