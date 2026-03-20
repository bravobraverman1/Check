/**
 * Parser for Title + Description JSON from Gemini.
 *
 * Expected shape (must include these keys):
 * { "title": "string", "description": "string" }
 *
 * Recovery: strips markdown fences, extracts first { … } substring.
 * Rejects non-string values and empty strings.
 */

export interface TitleDescriptionResult {
  title: string;
  description: string;
}

const jsonWrapperKeys = ["result", "data", "output", "response", "payload"] as const;
const nestedJsonStringKeys = [...jsonWrapperKeys, "text", "content", "message"] as const;

function normalizeLookupKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickStringFromObject(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  const normalizedTargets = new Set(keys.map((key) => normalizeLookupKey(key)));
  for (const [rawKey, value] of Object.entries(obj)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (normalizedTargets.has(normalizeLookupKey(rawKey))) {
      return value.trim();
    }
  }
  return null;
}

function unescapeLooseJsonString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .trim();
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

function extractLikelyJsonSlice(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;

  let inString = false;
  let escaped = false;
  let depthObject = 0;
  let depthArray = 0;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depthObject += 1;
    if (ch === "}") depthObject = Math.max(0, depthObject - 1);
    if (ch === "[") depthArray += 1;
    if (ch === "]") depthArray = Math.max(0, depthArray - 1);

    if (depthObject === 0 && depthArray === 0 && (ch === "}" || ch === "]")) {
      return text.slice(start, i + 1);
    }
  }

  // Truncated JSON payload: return from first opening token to end.
  return text.slice(start);
}

function closeTruncatedJson(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  const stack: Array<"{" | "["> = [];

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "{") {
      stack.push("{");
      out += ch;
      continue;
    }
    if (ch === "[") {
      stack.push("[");
      out += ch;
      continue;
    }
    if (ch === "}") {
      const top = stack[stack.length - 1];
      if (top === "{") {
        stack.pop();
        out += ch;
      }
      continue;
    }
    if (ch === "]") {
      const top = stack[stack.length - 1];
      if (top === "[") {
        stack.pop();
        out += ch;
      }
      continue;
    }

    out += ch;
  }

  if (escaped) {
    // Prevent dangling escape at end of unterminated string.
    out += "\\";
  }
  if (inString) {
    out += "\"";
  }

  out = out.trimEnd();
  while (/[,:]\s*$/.test(out)) {
    out = out.replace(/[,:]\s*$/, "").trimEnd();
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    out += stack[i] === "{" ? "}" : "]";
  }
  return out;
}

function trimToLastCommaAndRepair(input: string): string | null {
  let inString = false;
  let escaped = false;
  let lastComma = -1;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === ",") lastComma = i;
  }

  if (lastComma <= 0) return null;
  return closeTruncatedJson(input.slice(0, lastComma));
}

function extractLooseField(text: string, keys: string[]): string | null {
  const normalizedTargets = new Set(keys.map((key) => normalizeLookupKey(key)));
  const keyPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*"/g;
  let match: RegExpExecArray | null = null;

  while ((match = keyPattern.exec(text)) !== null) {
    const rawKey = unescapeLooseJsonString(match[1]);
    if (!normalizedTargets.has(normalizeLookupKey(rawKey))) continue;

    let value = "";
    let escaped = false;
    for (let i = keyPattern.lastIndex; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        value += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        value += ch;
        continue;
      }
      if (ch === "\"") {
        return unescapeLooseJsonString(value);
      }
      value += ch;
    }

    // Unterminated value: return whatever remains.
    return unescapeLooseJsonString(value);
  }

  return null;
}

/**
 * Collapse blank lines between paragraphs into single newlines
 * so the description textarea doesn't show extra vertical gaps.
 */
export function collapseBlankLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function parseCandidateObjects(
  parsed: unknown,
  titleKeys: string[],
  descriptionKeys: string[],
): TitleDescriptionResult | null {
  const candidates: Record<string, unknown>[] = [];
  const parsedObject = asRecord(parsed);
  if (parsedObject) {
    candidates.push(parsedObject);
    for (const wrapperKey of jsonWrapperKeys) {
      const wrappedValue = parsedObject[wrapperKey];
      const wrapped = asRecord(wrappedValue);
      if (wrapped) candidates.push(wrapped);
    }
  } else if (Array.isArray(parsed) && parsed.length > 0) {
    const first = asRecord(parsed[0]);
    if (first) candidates.push(first);
  } else {
    return null;
  }

  for (const obj of candidates) {
    const title = pickStringFromObject(obj, titleKeys);
    const description = pickStringFromObject(obj, descriptionKeys);
    if (title && description) {
      return { title, description: collapseBlankLines(description) };
    }

    for (const wrapperKey of nestedJsonStringKeys) {
      const wrappedValue = obj[wrapperKey];
      if (typeof wrappedValue === "string" && wrappedValue.trim()) {
        const nested = parseTitleDescriptionJson(wrappedValue);
        if (nested) return nested;
        continue;
      }

      const wrappedObject = asRecord(wrappedValue);
      if (wrappedObject) {
        const nested = parseCandidateObjects(wrappedObject, titleKeys, descriptionKeys);
        if (nested) return nested;
        continue;
      }

      if (!Array.isArray(wrappedValue)) continue;
      for (const entry of wrappedValue) {
        const nested = parseCandidateObjects(entry, titleKeys, descriptionKeys);
        if (nested) return nested;
        if (typeof entry !== "string" || !entry.trim()) continue;
        const nestedFromString = parseTitleDescriptionJson(entry);
        if (nestedFromString) return nestedFromString;
      }
    }
  }

  return null;
}

/**
 * Parse raw Gemini output into a { title, description } object.
 * Returns null if the output is invalid — callers must NOT overwrite UI fields on null.
 */
export function parseTitleDescriptionJson(
  rawText: string,
): TitleDescriptionResult | null {
  if (!rawText || !rawText.trim()) return null;

  const text = stripCodeFences(rawText.trim());

  const titleKeys = [
    "title",
    "product_title",
    "product-title",
    "product name",
    "name",
    "ai_title",
    "ai-title",
  ];
  const descriptionKeys = [
    "description",
    "product_description",
    "product-description",
    "ai_description",
    "ai-description",
    "chatgpt_description",
    "chatgpt-description",
    "body",
    "copy",
  ];

  const parseCandidates: string[] = [];
  parseCandidates.push(text);
  const jsonSlice = extractLikelyJsonSlice(text);
  if (jsonSlice && !parseCandidates.includes(jsonSlice)) {
    parseCandidates.push(jsonSlice);
    const repaired = closeTruncatedJson(jsonSlice);
    if (!parseCandidates.includes(repaired)) {
      parseCandidates.push(repaired);
    }
    const trimmedRepaired = trimToLastCommaAndRepair(repaired);
    if (trimmedRepaired && !parseCandidates.includes(trimmedRepaired)) {
      parseCandidates.push(trimmedRepaired);
    }
  }

  for (const candidateText of parseCandidates) {
    const parsed = tryParseJson(candidateText);
    if (parsed === null) continue;
    const parsedResult = parseCandidateObjects(parsed, titleKeys, descriptionKeys);
    if (parsedResult) {
      return parsedResult;
    }
  }

  // Last-resort loose extraction for truncated JSON string values.
  const looseTitle = extractLooseField(text, titleKeys);
  const looseDescription = extractLooseField(text, descriptionKeys);
  if (looseTitle && looseDescription) {
    return {
      title: looseTitle,
      description: collapseBlankLines(looseDescription),
    };
  }

  return null;
}
