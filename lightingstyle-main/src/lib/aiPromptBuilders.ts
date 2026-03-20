import { renderPromptTemplate } from "@/lib/geminiPrompting";

export const ADDITIONAL_INSTRUCTIONS_PLACEHOLDER_RE = /\{\{\s*ADDITIONAL_INSTRUCTIONS\s*\}\}|\{\{#?IF\s+ADDITIONAL_INSTRUCTIONS\s*\}\}/i;

const USER_PROMPT_AUTHORITY_PREAMBLE = `The user prompt is the authoritative source for the task, required output format, and what to look for.
Use attached files and resolved variables only to satisfy that prompt.
If helper/wrapper instructions conflict with the user prompt, follow the user prompt.
Treat explicit format instructions in the user prompt as non-negotiable (for example separators, line structure, ordering, and combined-value formatting such as semicolon-delimited lists).`;

function ensureUserPromptAuthority(prompt: string): string {
  if (/authoritative source for the task|required output format|what to look for/i.test(prompt)) {
    return prompt.trim();
  }
  return `${USER_PROMPT_AUTHORITY_PREAMBLE}\n\n${prompt.trim()}`.trim();
}

// ── Fallback prompts (used only when NO admin prompt is configured) ──

const FALLBACK_COMPARE_ACTIVE_PROMPT = USER_PROMPT_AUTHORITY_PREAMBLE;

const FALLBACK_PRODUCT_DATA_ACTIVE_PROMPT = `{{FILTER_CONTEXT}}

${USER_PROMPT_AUTHORITY_PREAMBLE}`;

const FALLBACK_TITLE_DESCRIPTION_ACTIVE_PROMPT = USER_PROMPT_AUTHORITY_PREAMBLE;

// ── Compare Datasheets ──

export interface BuildCompareDatasheetsPromptOptions {
  activePrompt: string;
  additionalInstructions?: string;
  includeAdditionalInstructions?: boolean;
}

export function buildCompareDatasheetsPrompt(
  options: BuildCompareDatasheetsPromptOptions,
): string {
  const {
    activePrompt,
    additionalInstructions = "",
    includeAdditionalInstructions = false,
  } = options;

  const trimmedAdditional = additionalInstructions.trim();
  const hasAdditionalInstructionsPlaceholder = ADDITIONAL_INSTRUCTIONS_PLACEHOLDER_RE.test(activePrompt);
  let finalPrompt = renderPromptTemplate(activePrompt, {
    ADDITIONAL_INSTRUCTIONS: trimmedAdditional,
  });
  if (includeAdditionalInstructions && trimmedAdditional && !hasAdditionalInstructionsPlaceholder) {
    finalPrompt += "\n\n--- ADDITIONAL INSTRUCTIONS ---\n" + trimmedAdditional;
  }

  // No hardcoded mandate — the admin prompt is authoritative for comparison output format

  finalPrompt = finalPrompt
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return ensureUserPromptAuthority(finalPrompt);
}

// ── Fallback prompt selector ──

export function getBuiltInFallbackPrompt(promptType: string): string | null {
  const normalized = promptType.trim().toLowerCase();

  if (normalized === "compare_sheets") return FALLBACK_COMPARE_ACTIVE_PROMPT;
  if (
    normalized === "product_data" ||
    normalized === "data_title_datasheet" ||
    normalized === "data_title_webpage"
  ) {
    return FALLBACK_PRODUCT_DATA_ACTIVE_PROMPT;
  }
  if (
    normalized === "technical" ||
    normalized === "marketing"
  ) {
    return FALLBACK_TITLE_DESCRIPTION_ACTIVE_PROMPT;
  }

  return null;
}

// ── Title / Description ──

export interface BuildTitleDescriptionPromptOptions {
  resolvedPrompt: string;
  includeAdditionalInstructions?: boolean;
  additionalInstructions?: string;
}

function pruneEmptyNumberedSections(prompt: string): string {
  let next = prompt;
  // Only prune numbered lines that end with ":" (empty template labels awaiting a value).
  // Lines ending with "." or other punctuation contain real content and must be preserved.
  next = next.replace(
    /^\s*\d+\.\s+[^\n]*:\s*\n(?:[ \t]*\n)+(?=\s*(?:\d+\.\s+|[A-Z][A-Z0-9 ()/_-]{4,}\n|$))/gm,
    "",
  );
  return next;
}

export function buildTitleDescriptionPrompt(
  options: BuildTitleDescriptionPromptOptions,
): string {
  const {
    resolvedPrompt,
    includeAdditionalInstructions = false,
    additionalInstructions = "",
  } = options;

  let finalPrompt = resolvedPrompt.trim();

  const trimmedAdditional = additionalInstructions.trim();
  if (includeAdditionalInstructions && trimmedAdditional && !resolvedPrompt.includes(trimmedAdditional)) {
    finalPrompt += `\n\n--- ADDITIONAL INSTRUCTIONS ---\n${trimmedAdditional}`;
  }

  finalPrompt = pruneEmptyNumberedSections(finalPrompt);
  finalPrompt = finalPrompt
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return ensureUserPromptAuthority(finalPrompt.trim());
}

export function buildDescriptionPrompt(
  options: BuildTitleDescriptionPromptOptions,
): string {
  return buildTitleDescriptionPrompt(options);
}

// ── Generate Product Data ──

export interface BuildGenerateProductDataPromptOptions {
  resolvedAdminPrompt: string;
  includeAdditionalInstructions?: boolean;
  additionalInstructions?: string;
  includeFiltersProposalSection?: boolean;
}

interface GenerateDataPromptSanitizationSummary {
  removedTitleDirectiveLines: number;
  removedProductTitleSection: boolean;
}

function extractRequestedSectionsFromPrompt(prompt: string): string[] {
  const sectionRegex = /^===\s*([A-Za-z0-9_/\- ]{2,80})\s*===\s*$/gm;
  const sections: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = sectionRegex.exec(prompt)) !== null) {
    const raw = (match[1] || "").trim();
    if (!raw) continue;
    const normalized = raw.toUpperCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    sections.push(normalized);
  }
  return sections;
}

function normalizeSectionHeader(rawHeader: string): string {
  return rawHeader
    .trim()
    .toUpperCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stripGenerateDataTitleInstructions(
  prompt: string,
): { prompt: string; summary: GenerateDataPromptSanitizationSummary } {
  const lines = prompt.split("\n");
  const kept: string[] = [];
  let removedTitleDirectiveLines = 0;
  let removedProductTitleSection = false;
  let skippingProductTitleSection = false;

  const isNegativeTitleRule = (line: string): boolean =>
    /\b(omit|exclude|excluding|ignore|ignored|do not|don't|must not|without|remove|removed|forbidden|forbid)\b/i.test(
      line,
    );

  const isTitleOutputDirective = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (isNegativeTitleRule(trimmed)) return false;

    const mentionsTitle =
      /\b(product title|product name|title structure|name structure|title example|name example)\b/i.test(trimmed) ||
      (/\btitle\b/i.test(trimmed) && /\b(product|generate|output|return|include|create|provide|write|produce)\b/i.test(trimmed));

    if (!mentionsTitle) return false;

    return (
      /\b(generate|create|include|return|output|provide|write|produce|supply|fill)\b/i.test(trimmed) ||
      /\b(product title critical rules|title structure|name structure|title example|name example)\b/i.test(trimmed)
    );
  };

  for (const line of lines) {
    const sectionMatch = line.match(/^===\s*([A-Za-z0-9_\-/ ]{2,80})\s*===\s*$/);
    if (sectionMatch) {
      const normalizedSection = normalizeSectionHeader(sectionMatch[1] || "");
      if (normalizedSection === "PRODUCT_TITLE") {
        skippingProductTitleSection = true;
        removedProductTitleSection = true;
        continue;
      }
      skippingProductTitleSection = false;
    }

    if (skippingProductTitleSection) continue;

    if (isTitleOutputDirective(line)) {
      removedTitleDirectiveLines += 1;
      continue;
    }

    kept.push(line);
  }

  return {
    prompt: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    summary: {
      removedTitleDirectiveLines,
      removedProductTitleSection,
    },
  };
}

export function buildGenerateProductDataPrompt(
  options: BuildGenerateProductDataPromptOptions,
): { prompt: string; requiredSections: string[]; sanitization: GenerateDataPromptSanitizationSummary } {
  const {
    resolvedAdminPrompt,
    includeAdditionalInstructions = false,
    additionalInstructions = "",
    includeFiltersProposalSection: _includeFiltersProposalSection = false,
  } = options;

  const hasAdditionalInstructionsPlaceholder = ADDITIONAL_INSTRUCTIONS_PLACEHOLDER_RE.test(resolvedAdminPrompt);
  const trimmedAdditional = additionalInstructions.trim();
  let prompt = renderPromptTemplate(resolvedAdminPrompt, {
    ADDITIONAL_INSTRUCTIONS: trimmedAdditional,
  });

  if (includeAdditionalInstructions && trimmedAdditional && !hasAdditionalInstructionsPlaceholder) {
    prompt += "\n\n--- ADDITIONAL INSTRUCTIONS ---\n" + trimmedAdditional;
  }

  prompt = prompt
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const sanitized = stripGenerateDataTitleInstructions(prompt);
  prompt = sanitized.prompt;

  const requiredSections = extractRequestedSectionsFromPrompt(prompt);

  return { prompt: ensureUserPromptAuthority(prompt), requiredSections, sanitization: sanitized.summary };
}
