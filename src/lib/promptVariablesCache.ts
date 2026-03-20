import { invokeEdgeFunction } from "@/lib/edgeAuth";
import type { PromptVariable } from "@/lib/resolvePromptVariables";

const VARIABLE_CACHE_TTL_MS = 5 * 60_000;
const variableCache = new Map<string, { variables: PromptVariable[]; loadedAt: number }>();

function normalizeCompareSheetsBindingByName(name: string, bindingType: string): string {
  const key = name.trim().toUpperCase();
  const current = bindingType.trim();
  if (current && current !== "custom_text") {
    if (current === "form_sku") return "compare_optional_sku";
    return current;
  }

  if (key === "SKU") return "compare_optional_sku";
  if (key === "INSTRUCTION_PDF") return "instruction_pdf";
  if (key === "DATASHEET_PDF" || key === "SUPPLIER_PDF" || key === "SUPPLIER_DATASHEET_PDF") {
    return "supplier_datasheet_pdf";
  }
  if (key === "WEBPAGE_PDF" || key === "LS_PDF" || key === "WEBSITE_PDF") {
    return "supplier_website_pdf";
  }

  return "custom_text";
}

function normalizeVariables(raw: unknown, promptType: string): PromptVariable[] {
  const isCompareSheets = promptType.trim().toLowerCase() === "compare_sheets";
  if (!Array.isArray(raw)) return [];
  if (raw.length > 0 && typeof raw[0] === "string") {
    return (raw as string[]).map((name) => ({
      name,
      bindingType: (isCompareSheets ? normalizeCompareSheetsBindingByName(name, "") : "custom_text") as PromptVariable["bindingType"],
      required: true as const,
    }));
  }

  return (raw as PromptVariable[]).map((variable) => ({
    ...variable,
    bindingType: (isCompareSheets
      ? normalizeCompareSheetsBindingByName(variable.name, String(variable.bindingType || ""))
      : variable.bindingType) as PromptVariable["bindingType"],
    required: variable.required !== false,
  }));
}

export function getCachedPromptVariables(promptType: string): PromptVariable[] {
  const cached = variableCache.get(promptType);
  if (cached && Date.now() - cached.loadedAt < VARIABLE_CACHE_TTL_MS) {
    // Heal stale in-memory cache for prompt-specific migrations (notably compare_sheets SKU binding).
    const normalizedCached = normalizeVariables(cached.variables, promptType);
    if (JSON.stringify(normalizedCached) !== JSON.stringify(cached.variables)) {
      variableCache.set(promptType, { variables: normalizedCached, loadedAt: Date.now() });
      try {
        localStorage.setItem(`ai-prompt-vars-${promptType}`, JSON.stringify(normalizedCached));
      } catch {
        // ignore localStorage write failures
      }
    }
    return normalizedCached;
  }

  try {
    const raw = localStorage.getItem(`ai-prompt-vars-${promptType}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const normalized = normalizeVariables(parsed, promptType);
    if (normalized.length > 0) {
      variableCache.set(promptType, { variables: normalized, loadedAt: Date.now() });
      try {
        localStorage.setItem(`ai-prompt-vars-${promptType}`, JSON.stringify(normalized));
      } catch {
        // ignore localStorage write failures
      }
    }
    return normalized;
  } catch {
    return [];
  }
}

export async function loadPromptVariables(promptType: string): Promise<PromptVariable[]> {
  try {
    const { data, error } = await invokeEdgeFunction("manage-ai-prompt", {
      body: { action: "load_vars", promptType },
    });

    const d = data as Record<string, unknown> | null;
    if (!error && d && Array.isArray(d.variables)) {
      const normalized = normalizeVariables(d.variables as PromptVariable[], promptType);
      variableCache.set(promptType, { variables: normalized, loadedAt: Date.now() });
      if (normalized.length > 0) {
        localStorage.setItem(`ai-prompt-vars-${promptType}`, JSON.stringify(normalized));
      } else {
        localStorage.removeItem(`ai-prompt-vars-${promptType}`);
      }
      return normalized;
    }
  } catch {
    // Fall back to cached/localStorage state below.
  }

  return getCachedPromptVariables(promptType);
}
