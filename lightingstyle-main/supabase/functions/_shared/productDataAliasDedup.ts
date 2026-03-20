export interface ProductDataAliasDedupResult {
  output: string;
  removedLineCount: number;
}

function normalizeProductDataFieldKey(raw: string): string {
  return raw.trim().replace(/[–—]/g, "-").replace(/\s+/g, " ").toUpperCase();
}

const PRODUCT_DATA_ALIAS_GROUPS: string[][] = [
  ["APPLICATIONS", "APPLICATION"],
  ["COLOUR TEMP", "CCT", "COLOUR TEMPERATURE", "COLOR TEMP", "COLOR TEMPERATURE"],
  ["GLOBE", "GLOBE TYPE"],
  ["LIFESPAN", "LIFE SPAN", "LIFESPAN (HRS)", "LIFE SPAN (HRS)"],
  ["VOLTAGE", "INPUT VOLTAGE"],
  ["WATTAGE", "LED WATTAGE", "POWER", "POWER (W)"],
];

const PRODUCT_DATA_ALIAS_LOOKUP = (() => {
  const out = new Map<string, string>();
  for (const group of PRODUCT_DATA_ALIAS_GROUPS) {
    const preferred = normalizeProductDataFieldKey(group[0]);
    for (const key of group) {
      out.set(normalizeProductDataFieldKey(key), preferred);
    }
  }
  return out;
})();

function getAliasFamilyKey(rawKey: string): string {
  const normalized = normalizeProductDataFieldKey(rawKey);
  return PRODUCT_DATA_ALIAS_LOOKUP.get(normalized) || normalized;
}

function normalizeComparableProductValue(value: string): string {
  return value
    .trim()
    .replace(/[–—]/g, "-")
    .replace(/[×✕]/g, "x")
    .replace(/\bWATTS?\b/gi, "W")
    .replace(/\bVOLTS?\b/gi, "V")
    .replace(/\bLUMENS?\b/gi, "LM")
    .replace(/\s*([;,:|()])\s*/g, "$1")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function splitCompositeValues(value: string): string[] {
  if (!/[;\n|]/.test(value)) return [];
  return value
    .split(/[;\n|]/)
    .map((part) => normalizeComparableProductValue(part))
    .filter(Boolean);
}

function areEquivalentProductValues(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableProductValue(left);
  const normalizedRight = normalizeComparableProductValue(right);
  if (normalizedLeft === normalizedRight) return true;

  const leftParts = splitCompositeValues(left);
  const rightParts = splitCompositeValues(right);
  if (leftParts.length === 0 || rightParts.length === 0) return false;
  if (leftParts.length !== rightParts.length) return false;

  const sortedLeft = [...leftParts].sort();
  const sortedRight = [...rightParts].sort();
  for (let i = 0; i < sortedLeft.length; i++) {
    if (sortedLeft[i] !== sortedRight[i]) return false;
  }
  return true;
}

export function dedupeEquivalentProductDataAliases(section: string): ProductDataAliasDedupResult {
  const lines = section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const outputLines: string[] = [];
  const keptValuesByAliasFamily = new Map<string, string[]>();
  let removedLineCount = 0;

  for (const line of lines) {
    if (/^VARIANT\s*:/i.test(line)) {
      outputLines.push(line);
      continue;
    }

    const kvMatch = line.match(/^([^:]{1,180})\s*:\s*(.+)$/);
    if (!kvMatch) {
      outputLines.push(line);
      continue;
    }

    const rawKey = kvMatch[1].trim();
    const rawValue = kvMatch[2].trim();
    if (!rawKey || !rawValue) {
      outputLines.push(line);
      continue;
    }

    const aliasFamilyKey = getAliasFamilyKey(rawKey);
    const keptValues = keptValuesByAliasFamily.get(aliasFamilyKey) || [];
    const isEquivalentToExisting = keptValues.some((existing) => areEquivalentProductValues(existing, rawValue));
    if (isEquivalentToExisting) {
      removedLineCount += 1;
      continue;
    }

    keptValues.push(rawValue);
    keptValuesByAliasFamily.set(aliasFamilyKey, keptValues);
    outputLines.push(line);
  }

  return {
    output: outputLines.join("\n").trim(),
    removedLineCount,
  };
}
