type PromptValue = string | number | boolean | null | undefined;

export interface PromptTemplateValues {
  [key: string]: PromptValue;
}

function normalizeTemplateKey(key: string): string {
  return key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

function normalizeTemplateValues(values: PromptTemplateValues): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(values)) {
    const key = normalizeTemplateKey(rawKey);
    if (!key) continue;
    if (rawValue === null || rawValue === undefined) {
      normalized[key] = "";
      continue;
    }
    normalized[key] = String(rawValue).trim();
  }

  return normalized;
}

const PROMPT_IF_BLOCK_RE = /\{\{#?IF\s+([A-Z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/IF\}\}/gi;

/**
 * Render conditional prompt blocks:
 * - {{#IF KEY}}...{{/IF}}
 * - {{IF KEY}}...{{/IF}}
 *
 * A block is kept only when KEY resolves to a non-blank value.
 */
export function renderPromptConditionals(template: string, values: PromptTemplateValues): string {
  const normalizedValues = normalizeTemplateValues(values);
  return template.replace(PROMPT_IF_BLOCK_RE, (_, rawKey, block) => {
    const key = normalizeTemplateKey(String(rawKey));
    return normalizedValues[key] ? block : "";
  });
}

/**
 * Render simple prompt templates:
 * - {{KEY}}
 * - {{#IF KEY}}...{{/IF}}
 * - {{IF KEY}}...{{/IF}}
 */
export function renderPromptTemplate(template: string, values: PromptTemplateValues): string {
  const normalizedValues = normalizeTemplateValues(values);
  let output = renderPromptConditionals(template, normalizedValues);

  output = output.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/gi, (_, rawKey) => {
    const key = normalizeTemplateKey(String(rawKey));
    return normalizedValues[key] ?? "";
  });

  return output.replace(/\n{3,}/g, "\n\n").trim();
}

export function compactPromptContext(context: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(context)) {
    if (value === null || value === undefined) continue;

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      compacted[key] = trimmed;
      continue;
    }

    if (Array.isArray(value)) {
      const trimmedValues = value
        .map((item) => (typeof item === "string" ? item.trim() : item))
        .filter((item) => item !== "" && item !== null && item !== undefined);
      if (trimmedValues.length === 0) continue;
      compacted[key] = trimmedValues;
      continue;
    }

    compacted[key] = value;
  }

  return compacted;
}

export function buildPromptContextSection(title: string, context: Record<string, unknown>): string {
  const compacted = compactPromptContext(context);
  if (Object.keys(compacted).length === 0) return "";
  return `\n\n--- ${title} ---\n${JSON.stringify(compacted)}`;
}
