import { getActivePromptContentNoCache } from "@/lib/aiPromptCache";
import { loadPromptVariables } from "@/lib/promptVariablesCache";
import {
  getPromptVariablesInUse,
  resolvePromptVariables,
  type RuntimeContext,
} from "@/lib/resolvePromptVariables";

const SOURCE_FILE_ERROR_PREFIXES = [
  "Missing required: Supplier Datasheet PDF (Form)",
  "Missing required: Supplier Website PDF (Form)",
  "Missing required: Compare: Supplier Datasheet PDF",
  "Missing required: Compare: LS Datasheet PDF",
];

function isSourceFileValidationError(message: string): boolean {
  return SOURCE_FILE_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

export async function selectFirstCompatibleActivePrompt(
  promptCandidates: string[],
  runtimeContext?: RuntimeContext,
): Promise<{ prompt: string; promptType: string } | null> {
  for (const promptType of promptCandidates) {
    try {
      const prompt = await getActivePromptContentNoCache(promptType);
      if (!prompt) continue;

      if (!prompt.includes("{{") || !runtimeContext) {
        return { prompt, promptType };
      }

      const promptVariables = await loadPromptVariables(promptType);
      const variablesInUse = getPromptVariablesInUse({
        promptType,
        activeVersionContent: prompt,
        variables: promptVariables,
      });

      const resolveResult = resolvePromptVariables(
        {
          promptType,
          promptName: promptType,
          activeVersionContent: prompt,
          variables: variablesInUse,
        },
        runtimeContext,
      );

      if (resolveResult.validationErrors.length === 0) {
        return { prompt, promptType };
      }

      const hasOnlySourceFileErrors = resolveResult.validationErrors.every(isSourceFileValidationError);
      if (hasOnlySourceFileErrors) {
        continue;
      }

      return { prompt, promptType };
    } catch {
      // Continue to the next candidate
    }
  }

  return null;
}
