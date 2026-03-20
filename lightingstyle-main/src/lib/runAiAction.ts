/**
 * Shared AI Action Runner
 *
 * Centralises prompt composition, routing lookup, instruction PDF fetching,
 * and variable resolution so product data-generation buttons and
 * title/description generation use the same request pipeline.
 *
 * The pipeline remains: UI → callGeminiProcessor → ai-jobs → ai-worker → polling.
 * This module only builds the *request* that enters that pipeline.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  callGeminiProcessor,
  type GeminiProcessRequest,
  type GeminiProcessResponse,
  type GeminiResponseGuard,
} from "@/lib/geminiAI";
import {
  getAiActionRouting,
  type AiActionId,
  type AiActionRoutingConfig,
} from "@/lib/aiRoutingConfig";
import { loadPromptVariables } from "@/lib/promptVariablesCache";
import {
  resolvePromptVariables,
  getPromptVariablesInUse,
  type RuntimeContext,
} from "@/lib/resolvePromptVariables";
import { selectFirstCompatibleActivePrompt } from "@/lib/aiPromptCandidateSelection";

// ── Constants ──────────────────────────────────────────────────

const CONSTANTS_BUCKET = "document-uploads-constant";
const INSTRUCTION_CACHE_TTL_MS = 30 * 60_000; // 30 min
// Module-level instruction PDF cache (survives across calls)
const instructionCache: Record<string, { file: File; loadedAt: number }> = {};

// ── Types ──────────────────────────────────────────────────────

export interface RunAiActionOptions {
  /** Routing action key (e.g. "compare_two_datasheets", "product_generate_two_pdfs") */
  actionKey: AiActionId;

  /** Task-specific prompt that describes what the AI should do */
  userTaskPrompt: string;

  /**
   * Files already uploaded to a bucket (bucket/path refs).
   * These are the *source* files (datasheets, images, etc.).
   * Instruction PDFs are fetched automatically from routing config.
   */
  files?: GeminiProcessRequest["files"];

  /** Optional document text (for text-based comparisons) */
  documentText?: string;

  /** Response mode */
  mode: "json" | "text";

  /** Job type passed through to ai-jobs */
  type: GeminiProcessRequest["type"];

  /** Optional response guard override. Falls back to routing config defaults. */
  responseGuard?: GeminiResponseGuard;

  /** Optional system prompt (sent as Gemini systemInstruction) */
  systemPrompt?: string;

  /** Optional progress callback */
  onProgress?: GeminiProcessRequest["onProgress"];

  /** Optional validation retry override. Defaults are chosen per action type. */
  maxValidationRetries?: number;

  /**
   * Optional prompt type identifier used for AI Debug labeling when this call
   * uses a prebuilt prompt and skips internal prompt selection.
   */
  debugPromptType?: string;

  /**
   * If true, `userTaskPrompt` is treated as the final pre-composed prompt and
   * no active Admin prompt lookup/wrapping is applied.
   */
  prebuiltPrompt?: boolean;

  /** Optional runtime context for Admin prompt variable resolution. */
  runtimeContext?: RuntimeContext;

}

export interface RunAiActionResult {
  response: GeminiProcessResponse;
  routingConfig: AiActionRoutingConfig;
  activePromptType: string | null;
  instructionPdfUsed: string | null;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Check if files array contains a file labeled "instructions".
 */
function hasInstructionsInFiles(
  files?: GeminiProcessRequest["files"],
): boolean {
  if (!files || files.length === 0) return false;
  return files.some(
    (f) => (f.label || "").toLowerCase() === "instructions",
  );
}

function buildRuntimeContextFromFiles(
  files: GeminiProcessRequest["files"] | undefined,
  runtimeContext?: RuntimeContext,
): RuntimeContext {
  const ctx: RuntimeContext = { ...(runtimeContext ?? {}) };
  for (const file of files ?? []) {
    const label = (file.label || "").toLowerCase();
    if (!ctx.instructionPdf && label === "instructions") {
      ctx.instructionPdf = {
        bucket: file.bucket,
        path: file.path,
        filename: file.filename || "instructions.pdf",
        label: file.label || "instructions",
      };
    } else if (
      !ctx.datasheetUpload &&
      (label === "datasheet" || label === "supplier" || label === "document")
    ) {
      ctx.datasheetUpload = {
        bucket: file.bucket,
        path: file.path,
        filename: file.filename || "datasheet.pdf",
        label: file.label || "datasheet",
      };
    } else if (
      !ctx.websiteUpload &&
      (label === "website" || label === "website_pdf" || label === "ls")
    ) {
      ctx.websiteUpload = {
        bucket: file.bucket,
        path: file.path,
        filename: file.filename || "website.pdf",
        label: file.label || "website_pdf",
      };
    }
  }
  return ctx;
}

function mergeResolvedFiles(
  primaryFiles: GeminiProcessRequest["files"] | undefined,
  resolvedFiles: Array<{ bucket: string; path: string; filename: string; label: string }>,
): GeminiProcessRequest["files"] {
  const merged = [...(primaryFiles ?? [])];
  const seen = new Set(
    merged.map((file) => `${file.label || ""}|${file.bucket}|${file.path}`),
  );

  for (const file of resolvedFiles) {
    const key = `${file.label || ""}|${file.bucket}|${file.path}`;
    if (seen.has(key)) continue;
    merged.push(file);
    seen.add(key);
  }

  return merged;
}

// ── Main entry point ───────────────────────────────────────────

/**
 * Run an AI action through the unified async pipeline.
 *
 * Handles:
 * 1. Routing config lookup
 * 2. Active prompt fetching
 * 3. Instruction PDF fetching (with caching)
 * 4. Prompt variable resolution
 * 5. Delegation to callGeminiProcessor (ai-jobs pipeline)
 *
 * All prompt composition is dynamic: missing sources are never mentioned.
 */
export async function runAiAction(
  options: RunAiActionOptions,
): Promise<RunAiActionResult> {
  const {
    actionKey,
    userTaskPrompt,
    files,
    documentText,
    mode,
    type,
    responseGuard: responseGuardOverride,
    systemPrompt,
    onProgress,
    prebuiltPrompt = false,
    maxValidationRetries,
    runtimeContext,
    debugPromptType,
  } = options;

  // 1. Routing config
  const routingConfig = getAiActionRouting(actionKey);

  if (!routingConfig.enabled) {
    return {
      response: {
        success: false,
        error: `This AI action ("${actionKey}") is disabled in Admin → AI Routing Options.`,
      },
      routingConfig,
      activePromptType: null,
      instructionPdfUsed: null,
    };
  }

  // 2. Instruction PDF is optional — if present in files, it will be used
  const instructionInFiles = hasInstructionsInFiles(files);

  let activePromptType: string | null = null;
  let finalPrompt = userTaskPrompt;
  let resolvedPromptFiles: Array<{ bucket: string; path: string; filename: string; label: string }> = [];

  if (!prebuiltPrompt) {
    // 3. Fetch active prompt
    const activePromptSelection = await selectFirstCompatibleActivePrompt(
      routingConfig.promptCandidates,
      buildRuntimeContextFromFiles(files, runtimeContext),
    );

    if (!activePromptSelection) {
      return {
        response: {
          success: false,
          error: `No active AI prompt found. Activate one of: ${routingConfig.promptCandidates.join(", ")}`,
        },
        routingConfig,
        activePromptType: null,
        instructionPdfUsed: null,
      };
    }
    activePromptType = activePromptSelection.promptType;

    const promptHasTemplateVariables = activePromptSelection.prompt.includes("{{");
    const promptVariables = promptHasTemplateVariables ? await loadPromptVariables(activePromptType) : [];
    let resolvedActivePrompt = activePromptSelection.prompt;

    if (promptHasTemplateVariables) {
      const variablesInUse = getPromptVariablesInUse({
        promptType: activePromptType,
        activeVersionContent: activePromptSelection.prompt,
        variables: promptVariables,
      });
      const resolveResult = resolvePromptVariables(
        {
          promptType: activePromptType,
          promptName: activePromptType,
          activeVersionContent: activePromptSelection.prompt,
          variables: variablesInUse,
        },
        buildRuntimeContextFromFiles(files, runtimeContext),
      );

      if (resolveResult.validationErrors.length > 0) {
        return {
          response: {
            success: false,
            error: resolveResult.validationErrors[0],
          },
          routingConfig,
          activePromptType,
          instructionPdfUsed: null,
        };
      }

      resolvedActivePrompt = resolveResult.finalPrompt;
      resolvedPromptFiles = resolveResult.files;
    }

    finalPrompt = resolvedActivePrompt;
  }

  // 5. Build response guard
  const responseGuard = responseGuardOverride ?? null;

  // 6. Build config flags from routing (including temperature, strictGrounding)
  // Cache is server-disabled for all AI actions. Keep it hard-disabled client-side too.
  const disableCache = true;

  const configFlags: Record<string, unknown> = {
    singlePass: routingConfig.singlePass,
    directFiles: routingConfig.directFiles,
    allowMissingInstruction: !routingConfig.requireInstructionPdf,
    disableCache,
    strictGrounding: true,
    ...(routingConfig.temperature !== undefined
      ? { temperature: routingConfig.temperature }
      : {}),
  };

  const effectiveValidationRetries = (() => {
    if (typeof maxValidationRetries === "number" && Number.isFinite(maxValidationRetries) && maxValidationRetries >= 0) {
      return Math.min(1, Math.floor(maxValidationRetries));
    }
    return 1;
  })();

  const normalizedDebugPromptType = (() => {
    const explicit = typeof debugPromptType === "string" ? debugPromptType.trim() : "";
    if (explicit) return explicit;
    if (activePromptType && activePromptType.trim()) return activePromptType.trim();
    if (routingConfig.promptCandidates.length === 1) return routingConfig.promptCandidates[0];
    return "";
  })();

  const finalFiles = mergeResolvedFiles(files, resolvedPromptFiles);

  // 7. Call the pipeline
  const response = await callGeminiProcessor({
    type,
    prompt: finalPrompt,
    mode,
    documentText,
    requireFiles: Boolean(finalFiles.length > 0),
    files: finalFiles,
    responseGuard: responseGuard ?? undefined,
    maxValidationRetries: effectiveValidationRetries,
    configFlags,
    debugActionKey: actionKey,
    ...(normalizedDebugPromptType ? { debugPromptType: normalizedDebugPromptType } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    onProgress,
  });

  return {
    response,
    routingConfig,
    activePromptType,
    instructionPdfUsed: instructionInFiles || finalFiles.some((file) => (file.label || "").toLowerCase() === "instructions")
      ? "from_files"
      : null,
  };
}

/**
 * Get instruction PDF by prompt type from document-uploads-constant/prompt-{promptType}/
 */
export async function getInstructionFileForPrompt(
  promptType: string,
): Promise<{ file: File; label: string; promptType: string } | null> {
  const normalizedPromptType = promptType.trim();
  if (!normalizedPromptType) return null;
  const folder = `prompt-${normalizedPromptType}`;
  const cacheKey = `prompt:${normalizedPromptType}`;

  try {
    const { data: files, error: listError } = await supabase.storage
      .from(CONSTANTS_BUCKET)
      .list(folder, {
        limit: 1,
        sortBy: { column: "created_at", order: "desc" },
      });
    if (listError || !files || files.length === 0) {
      delete instructionCache[cacheKey];
      return null;
    }

    const latest = files[0];
    const cached = instructionCache[cacheKey];
    if (
      cached &&
      cached.file.name === latest.name &&
      Date.now() - cached.loadedAt < INSTRUCTION_CACHE_TTL_MS
    ) {
      return { file: cached.file, label: "instructions", promptType: normalizedPromptType };
    }

    const storagePath = `${folder}/${latest.name}`;
    const { data: blob, error: downloadError } = await supabase.storage
      .from(CONSTANTS_BUCKET)
      .download(storagePath);
    if (downloadError || !blob) return null;

    const file = new File([blob], latest.name, { type: "application/pdf" });
    instructionCache[cacheKey] = { file, loadedAt: Date.now() };

    return { file, label: "instructions", promptType: normalizedPromptType };
  } catch {
    return null;
  }
}

/**
 * Backward-compatible helper: resolves action -> first candidate prompt -> prompt instruction.
 */
export async function getInstructionFileForAction(
  actionKey: AiActionId,
): Promise<{ file: File; label: string; promptType: string } | null> {
  const routingConfig = getAiActionRouting(actionKey);
  const promptCandidates = routingConfig.promptCandidates;
  for (const promptType of promptCandidates) {
    const file = await getInstructionFileForPrompt(promptType);
    if (file) return file;
  }
  return null;
}
