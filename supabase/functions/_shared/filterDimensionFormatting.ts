function normalizeSpecialFilterHeader(header: string): string {
  return String(header || "")
    .replace(/\*/g, "")
    .replace(/\s*#\d+\s*$/i, "")
    .replace(/\s*\([^)]*\)\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function getSpecialFilterType(header: string): "air_movement" | "fan_cutout" | null {
  const normalized = normalizeSpecialFilterHeader(header);
  if (normalized === "airmovement") return "air_movement";
  if (normalized === "fancutout") return "fan_cutout";
  return null;
}

type ParsedDimensionValue =
  | { kind: "diameter"; diameter: string }
  | { kind: "pair"; width: string; height: string };

function parseDimensionFilterValue(value: string): ParsedDimensionValue | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;

  const pairMatch = trimmed.match(
    /^\s*(\d+(?:\.\d+)?)\s*(?:cm)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:cm)?\s*$/i,
  );
  if (pairMatch) {
    return {
      kind: "pair",
      width: pairMatch[1],
      height: pairMatch[2],
    };
  }

  const diameterMatch = trimmed.match(
    /^\s*(?:diameter\s*:?\s*)?(\d+(?:\.\d+)?)\s*(?:cm)?(?:\s*\(\s*diameter\s*\))?\s*$/i,
  );
  if (diameterMatch) {
    return {
      kind: "diameter",
      diameter: diameterMatch[1],
    };
  }

  return null;
}

export function normalizeDimensionFilterValueForStorage(header: string, value: string): string {
  const filterType = getSpecialFilterType(header);
  if (!filterType) return value;

  if (filterType === "air_movement") {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    const scalarMatch = trimmed.match(/^\s*(\d+(?:\.\d+)?)\s*(?:m(?:\^?3|³)\/h)?\s*$/i);
    return scalarMatch ? scalarMatch[1] : trimmed;
  }

  const parsed = parseDimensionFilterValue(value);
  if (!parsed) return String(value || "").trim();

  if (parsed.kind === "pair") {
    return `${parsed.width}X${parsed.height}`;
  }

  return parsed.diameter;
}

export function formatDimensionFilterValueForCsv(header: string, value: string): string {
  const filterType = getSpecialFilterType(header);
  if (!filterType) return value;

  if (filterType === "air_movement") {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    const scalarMatch = trimmed.match(/^\s*(\d+(?:\.\d+)?)\s*(?:m(?:\^?3|³)\/h)?\s*$/i);
    return scalarMatch ? `${scalarMatch[1]}m³/h` : trimmed;
  }

  const parsed = parseDimensionFilterValue(value);
  if (!parsed) return String(value || "").trim();

  if (parsed.kind === "pair") {
    return `${parsed.width}cm x ${parsed.height}cm`;
  }

  return `${parsed.diameter}cm (DIAMETER)`;
}

export function formatDimensionEntriesInSemicolonListForCsv(value: string): string {
  return String(value || "")
    .split(";")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return "";

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) return trimmed;

      const key = trimmed.slice(0, eqIndex).trim();
      const rawValue = trimmed.slice(eqIndex + 1).trim();
      if (!key) return trimmed;

      return `${key}=${formatDimensionFilterValueForCsv(key, rawValue)}`;
    })
    .filter(Boolean)
    .join(";");
}
