import { getConfigValue, setConfigValue } from "@/config";

export type AiActionId =
  | "product_generate_two_pdfs"
  | "product_generate_datasheet_only"
  | "product_generate_webpage_only"
  | "product_generate_description_technical"
  | "product_generate_description_marketing"
  | "compare_two_datasheets";

export interface AiPromptOption {
  value: string;
  label: string;
}

export interface AiInstructionSlotOption {
  value: string;
  label: string;
}

export interface AiActionDefinition {
  id: AiActionId;
  label: string;
  group: "Product Form" | "Admin Compare";
  description: string;
}

export interface AiActionRoutingConfig {
  enabled: boolean;
  promptCandidates: string[];
  instructionSlots: string[];
  includeAdditionalInstructions: boolean;
  requireInstructionPdf: boolean;
  strictResponseGuard: boolean;
  singlePass: boolean;
  directFiles: boolean;
  useCache: boolean;
  /** Temperature override for Gemini calls (0–2). Defaults to 0 if omitted. */
  temperature?: number;
}

export type AiRoutingConfig = Record<AiActionId, AiActionRoutingConfig>;

const STORAGE_KEY = "AI_ROUTING_CONFIG_V1";

export const AI_PROMPT_OPTIONS: AiPromptOption[] = [
  { value: "product_data", label: "Data - Two PDFs (product_data)" },
  { value: "data_title_datasheet", label: "Data - Datasheet Only (data_title_datasheet)" },
  { value: "data_title_webpage", label: "Data - Webpage Only (data_title_webpage)" },
  { value: "technical", label: "Technical Description (technical)" },
  { value: "marketing", label: "Marketing Description (marketing)" },
  { value: "compare_sheets", label: "Compare Datasheets (compare_sheets)" },
];

export const AI_INSTRUCTION_SLOT_OPTIONS: AiInstructionSlotOption[] = [
  { value: "prod-creation-two-pdf", label: "Product Data Instructions (2 PDF)" },
  { value: "prod-creation-datasheet-only", label: "Product Data Instructions (Datasheet Only)" },
  { value: "prod-creation-webpage-only", label: "Product Data Instructions (Webpage Only)" },
  { value: "prod-creation-single-pdf", label: "Product Data Instructions (Single PDF Fallback)" },
  { value: "technical-ai-prompt-instructions", label: "Technical Description Instructions" },
  { value: "marketing-ai-prompt-instructions", label: "Marketing Description Instructions" },
  { value: "verify-ai-entries-instructions", label: "Verify Entries Instructions" },
  { value: "ai-compare-datasheets", label: "Compare Datasheets Instructions" },
];

export const AI_ACTION_DEFINITIONS: AiActionDefinition[] = [
  {
    id: "product_generate_two_pdfs",
    group: "Product Form",
    label: "Generate Data (Two PDFs)",
    description: "Main product extraction when both Datasheet and Website PDFs are uploaded.",
  },
  {
    id: "product_generate_datasheet_only",
    group: "Product Form",
    label: "Generate Data (Datasheet Only)",
    description: "Product extraction when only Datasheet PDF is uploaded.",
  },
  {
    id: "product_generate_webpage_only",
    group: "Product Form",
    label: "Generate Data (Webpage Only)",
    description: "Product extraction when only Website PDF is uploaded.",
  },
  {
    id: "product_generate_description_technical",
    group: "Product Form",
    label: "Generate Description (Technical)",
    description: "Technical description generation mode.",
  },
  {
    id: "product_generate_description_marketing",
    group: "Product Form",
    label: "Generate Description (Marketing)",
    description: "Marketing description generation mode.",
  },
  {
    id: "compare_two_datasheets",
    group: "Admin Compare",
    label: "Compare Two Datasheets",
    description: "Admin compare pipeline for supplier vs LS datasheets.",
  },
];

const PROMPT_OPTION_SET = new Set(AI_PROMPT_OPTIONS.map((option) => option.value));
const SLOT_OPTION_SET = new Set(AI_INSTRUCTION_SLOT_OPTIONS.map((option) => option.value));

const ACTION_ALLOWED_PROMPT_CANDIDATES: Record<AiActionId, string[]> = {
  product_generate_two_pdfs: ["product_data"],
  product_generate_datasheet_only: ["data_title_datasheet", "product_data"],
  product_generate_webpage_only: ["data_title_webpage", "product_data"],
  product_generate_description_technical: ["technical"],
  product_generate_description_marketing: ["marketing"],
  compare_two_datasheets: ["compare_sheets"],
};

const ACTION_ALLOWED_INSTRUCTION_SLOTS: Record<AiActionId, string[]> = {
  product_generate_two_pdfs: ["prod-creation-two-pdf"],
  product_generate_datasheet_only: ["prod-creation-datasheet-only", "prod-creation-single-pdf"],
  product_generate_webpage_only: ["prod-creation-webpage-only", "prod-creation-single-pdf"],
  product_generate_description_technical: ["technical-ai-prompt-instructions"],
  product_generate_description_marketing: ["marketing-ai-prompt-instructions"],
  compare_two_datasheets: ["ai-compare-datasheets"],
};

const DEFAULT_ROUTING: AiRoutingConfig = {
  product_generate_two_pdfs: {
    enabled: true,
    promptCandidates: ["product_data"],
    instructionSlots: ["prod-creation-two-pdf"],
    includeAdditionalInstructions: true,
    requireInstructionPdf: false,
    strictResponseGuard: true,
    singlePass: true,
    directFiles: true,
    useCache: false,
  },
  product_generate_datasheet_only: {
    enabled: true,
    promptCandidates: ["data_title_datasheet", "product_data"],
    instructionSlots: ["prod-creation-datasheet-only", "prod-creation-single-pdf"],
    includeAdditionalInstructions: true,
    requireInstructionPdf: false,
    strictResponseGuard: true,
    singlePass: true,
    directFiles: true,
    useCache: false,
  },
  product_generate_webpage_only: {
    enabled: true,
    promptCandidates: ["data_title_webpage", "product_data"],
    instructionSlots: ["prod-creation-webpage-only", "prod-creation-single-pdf"],
    includeAdditionalInstructions: true,
    requireInstructionPdf: false,
    strictResponseGuard: true,
    singlePass: true,
    directFiles: true,
    useCache: false,
  },
  product_generate_description_technical: {
    enabled: true,
    promptCandidates: ["technical"],
    instructionSlots: ["technical-ai-prompt-instructions"],
    includeAdditionalInstructions: true,
    requireInstructionPdf: false,
    strictResponseGuard: false,
    singlePass: true,
    directFiles: true,
    useCache: false,
    temperature: 0.15,
  },
  product_generate_description_marketing: {
    enabled: true,
    promptCandidates: ["marketing"],
    instructionSlots: ["marketing-ai-prompt-instructions"],
    includeAdditionalInstructions: true,
    requireInstructionPdf: false,
    strictResponseGuard: false,
    singlePass: true,
    directFiles: true,
    useCache: false,
    temperature: 0.4,
  },
  compare_two_datasheets: {
    enabled: true,
    promptCandidates: ["compare_sheets"],
    instructionSlots: ["ai-compare-datasheets"],
    includeAdditionalInstructions: true,
    requireInstructionPdf: false,
    strictResponseGuard: true,
    singlePass: true,
    directFiles: true,
    useCache: false,
  },
};

function sanitizeCandidates(
  values: unknown,
  allowedSet: Set<string>,
  fallback: string[],
): string[] {
  if (!Array.isArray(values)) {
    return [...fallback];
  }

  const unique: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized || !allowedSet.has(normalized)) continue;
    if (unique.includes(normalized)) continue;
    unique.push(normalized);
  }

  return unique.length > 0 ? unique : [...fallback];
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function normalizeActionPromptCandidates(
  actionId: AiActionId,
  candidates: string[],
): string[] {
  const allowed = ACTION_ALLOWED_PROMPT_CANDIDATES[actionId];
  const allowedSet = new Set(allowed);
  const filtered = candidates.filter((candidate) => allowedSet.has(candidate));
  if (filtered.length === 0) return [...allowed];
  return filtered;
}

function normalizeActionInstructionSlots(
  actionId: AiActionId,
  slots: string[],
): string[] {
  const allowed = ACTION_ALLOWED_INSTRUCTION_SLOTS[actionId];
  const allowedSet = new Set(allowed);
  const filtered = slots.filter((slot) => allowedSet.has(slot));
  return allowed.filter((slot) => filtered.includes(slot) || slot === allowed[0]);
}

function sanitizeActionConfig(
  actionId: AiActionId,
  value: unknown,
): AiActionRoutingConfig {
  const defaults = DEFAULT_ROUTING[actionId];
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<AiActionRoutingConfig>)
    : {};

  const rawTemp = source.temperature;
  const temperature = typeof rawTemp === "number" && Number.isFinite(rawTemp) && rawTemp >= 0 && rawTemp <= 2
    ? rawTemp
    : defaults.temperature;
  const promptCandidates = normalizeActionPromptCandidates(
    actionId,
    sanitizeCandidates(source.promptCandidates, PROMPT_OPTION_SET, defaults.promptCandidates),
  );

  return {
    enabled: asBoolean(source.enabled, defaults.enabled),
    promptCandidates,
    instructionSlots: normalizeActionInstructionSlots(
      actionId,
      sanitizeCandidates(source.instructionSlots, SLOT_OPTION_SET, defaults.instructionSlots),
    ),
    includeAdditionalInstructions: asBoolean(source.includeAdditionalInstructions, defaults.includeAdditionalInstructions),
    requireInstructionPdf: asBoolean(source.requireInstructionPdf, defaults.requireInstructionPdf),
    strictResponseGuard: asBoolean(source.strictResponseGuard, defaults.strictResponseGuard),
    singlePass: asBoolean(source.singlePass, defaults.singlePass),
    directFiles: asBoolean(source.directFiles, defaults.directFiles),
    useCache: false,
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

function sanitizeRoutingConfig(value: unknown): AiRoutingConfig {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<Record<AiActionId, unknown>>)
    : {};

  return {
    product_generate_two_pdfs: sanitizeActionConfig("product_generate_two_pdfs", source.product_generate_two_pdfs),
    product_generate_datasheet_only: sanitizeActionConfig("product_generate_datasheet_only", source.product_generate_datasheet_only),
    product_generate_webpage_only: sanitizeActionConfig("product_generate_webpage_only", source.product_generate_webpage_only),
    product_generate_description_technical: sanitizeActionConfig("product_generate_description_technical", source.product_generate_description_technical),
    product_generate_description_marketing: sanitizeActionConfig("product_generate_description_marketing", source.product_generate_description_marketing),
    compare_two_datasheets: sanitizeActionConfig("compare_two_datasheets", source.compare_two_datasheets),
  };
}

export function getDefaultAiRoutingConfig(): AiRoutingConfig {
  return sanitizeRoutingConfig(DEFAULT_ROUTING);
}

export function getAiRoutingConfig(): AiRoutingConfig {
  const raw = getConfigValue(STORAGE_KEY, "");
  if (!raw) {
    return getDefaultAiRoutingConfig();
  }

  try {
    return sanitizeRoutingConfig(JSON.parse(raw));
  } catch {
    return getDefaultAiRoutingConfig();
  }
}

export function setAiRoutingConfig(config: AiRoutingConfig): void {
  setConfigValue(STORAGE_KEY, JSON.stringify(sanitizeRoutingConfig(config)));
}

export function getAiActionRouting(actionId: AiActionId): AiActionRoutingConfig {
  const config = getAiRoutingConfig();
  return config[actionId];
}

export function updateAiActionRouting(
  actionId: AiActionId,
  updates: Partial<AiActionRoutingConfig>,
): AiRoutingConfig {
  const current = getAiRoutingConfig();
  const next = sanitizeRoutingConfig({
    ...current,
    [actionId]: {
      ...current[actionId],
      ...updates,
    },
  });
  setAiRoutingConfig(next);
  return next;
}

export function resetAiActionRouting(actionId: AiActionId): AiRoutingConfig {
  const current = getAiRoutingConfig();
  const next = sanitizeRoutingConfig({
    ...current,
    [actionId]: DEFAULT_ROUTING[actionId],
  });
  setAiRoutingConfig(next);
  return next;
}

export function resetAllAiRouting(): AiRoutingConfig {
  const next = getDefaultAiRoutingConfig();
  setAiRoutingConfig(next);
  return next;
}
