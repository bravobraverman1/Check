function normalizeCustomFieldName(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function parseOrderedCustomFieldSpecValues(raw: string): Record<string, string> {
  const entries = raw
    .split(";")
    .map((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx <= 0) return null;
      const key = normalizeCustomFieldName(part.slice(0, eqIdx));
      const value = String(part.slice(eqIdx + 1) ?? "").trim();
      if (!key) return null;
      return { key, value };
    })
    .filter((entry): entry is { key: string; value: string } => entry !== null);

  const totals = new Map<string, number>();
  for (const entry of entries) {
    const normalizedKey = entry.key.toLowerCase();
    totals.set(normalizedKey, (totals.get(normalizedKey) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const parsed: Record<string, string> = {};
  for (const entry of entries) {
    const normalizedKey = entry.key.toLowerCase();
    const nextSeen = (seen.get(normalizedKey) ?? 0) + 1;
    seen.set(normalizedKey, nextSeen);
    const key = (totals.get(normalizedKey) ?? 0) > 1
      ? `${entry.key} #${nextSeen}`
      : entry.key;
    parsed[key] = entry.value;
  }

  return parsed;
}
