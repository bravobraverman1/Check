import { getConfigValue } from "@/config";
import { AI_ENFORCED_MODEL } from "@/lib/aiPipelineConstants";

export function getSelectedAiModel(): string {
  const configured = getConfigValue("GEMINI_MODEL", AI_ENFORCED_MODEL);
  const model = typeof configured === "string" ? configured.trim() : "";
  // Keep outbound model deterministic and backend-compatible.
  // If local storage drifts to an unknown value, fall back to the enforced model.
  return model === AI_ENFORCED_MODEL ? model : AI_ENFORCED_MODEL;
}
