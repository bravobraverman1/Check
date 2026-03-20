const DEFAULT_ENFORCED_MODEL = "gemini-3-flash-preview";

function normalizeModelName(value: string): string {
  return (value || "").trim().toLowerCase();
}

function toModelFamily(value: string): string {
  const normalized = normalizeModelName(value);
  if (!normalized) return "";
  if (normalized.startsWith("gemini-3-flash-preview")) return "gemini-3-flash";
  if (normalized.startsWith("gemini-3-flash")) return "gemini-3-flash";
  if (normalized.startsWith("gemini-1.5-flash")) return "gemini-1.5-flash";
  return normalized;
}

export function getEnforcedModel(): string {
  const configured = (Deno.env.get("AI_ENFORCED_MODEL") || "").trim();
  return configured || DEFAULT_ENFORCED_MODEL;
}

export function isAllowedModel(requestedModel: string, enforcedModel: string): boolean {
  const requested = normalizeModelName(requestedModel);
  const enforced = normalizeModelName(enforcedModel);
  if (!requested || !enforced) return false;
  if (requested === enforced) return true;
  return toModelFamily(requested) === toModelFamily(enforced);
}
