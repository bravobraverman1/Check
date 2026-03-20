const UNIT_ALIASES: Record<string, string> = {
  mm: "mm",
  millimeter: "mm",
  millimeters: "mm",
  cm: "cm",
  m: "m",
  metre: "m",
  meter: "m",
  metres: "m",
  meters: "m",
  in: "in",
  inch: "in",
  inches: "in",
  ft: "ft",
  foot: "ft",
  feet: "ft",

  mg: "mg",
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  oz: "oz",

  w: "w",
  kw: "kw",
  mw: "mw",
  v: "v",
  kv: "kv",
  mv: "mv",
  a: "a",
  ma: "ma",

  lm: "lm",
  klm: "klm",

  k: "k",
  c: "c",
  degc: "c",
  celsius: "c",
  f: "f",
  degf: "f",
  fahrenheit: "f",

  hz: "hz",
  khz: "khz",
  mhz: "mhz",

  h: "h",
  hr: "h",
  hrs: "h",
  hour: "h",
  hours: "h",
  min: "min",
  mins: "min",
  minute: "min",
  minutes: "min",
  s: "s",
  sec: "s",
  secs: "s",
  second: "s",
  seconds: "s",

  deg: "deg",
  degree: "deg",
  degrees: "deg",
  rad: "rad",

  "m3h": "m3/h",
  "m^3h": "m3/h",
  "m³h": "m3/h",
  "m3/h": "m3/h",
  "m^3/h": "m3/h",
  "m³/h": "m3/h",
  "ls": "l/s",
  "l/s": "l/s",
};

const LINEAR_UNIT_FACTORS: Record<string, { dimension: string; toBase: number }> = {
  mm: { dimension: "length", toBase: 0.001 },
  cm: { dimension: "length", toBase: 0.01 },
  m: { dimension: "length", toBase: 1 },
  in: { dimension: "length", toBase: 0.0254 },
  ft: { dimension: "length", toBase: 0.3048 },

  mg: { dimension: "mass", toBase: 0.000001 },
  g: { dimension: "mass", toBase: 0.001 },
  kg: { dimension: "mass", toBase: 1 },
  lb: { dimension: "mass", toBase: 0.45359237 },
  oz: { dimension: "mass", toBase: 0.028349523125 },

  w: { dimension: "power", toBase: 1 },
  kw: { dimension: "power", toBase: 1000 },
  mw: { dimension: "power", toBase: 1000000 },

  v: { dimension: "voltage", toBase: 1 },
  kv: { dimension: "voltage", toBase: 1000 },
  mv: { dimension: "voltage", toBase: 0.001 },

  a: { dimension: "current", toBase: 1 },
  ma: { dimension: "current", toBase: 0.001 },

  lm: { dimension: "luminous_flux", toBase: 1 },
  klm: { dimension: "luminous_flux", toBase: 1000 },

  hz: { dimension: "frequency", toBase: 1 },
  khz: { dimension: "frequency", toBase: 1000 },
  mhz: { dimension: "frequency", toBase: 1000000 },

  h: { dimension: "time", toBase: 3600 },
  min: { dimension: "time", toBase: 60 },
  s: { dimension: "time", toBase: 1 },

  deg: { dimension: "angle", toBase: 1 },
  rad: { dimension: "angle", toBase: 57.29577951308232 },

  "m3/h": { dimension: "flow", toBase: 1 },
  "l/s": { dimension: "flow", toBase: 3.6 },
};

function normalizeUnitToken(rawUnit: string): string | null {
  if (!rawUnit) return null;
  const normalized = rawUnit
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/°/g, "deg")
    .replace(/µ/g, "u")
    .replace(/μ/g, "u");

  return UNIT_ALIASES[normalized] || null;
}

function convertTemperature(value: number, from: string, to: string): number | null {
  if (from === to) return value;

  let kelvin: number;
  if (from === "k") {
    kelvin = value;
  } else if (from === "c") {
    kelvin = value + 273.15;
  } else if (from === "f") {
    kelvin = (value - 32) * (5 / 9) + 273.15;
  } else {
    return null;
  }

  if (to === "k") return kelvin;
  if (to === "c") return kelvin - 273.15;
  if (to === "f") return (kelvin - 273.15) * (9 / 5) + 32;
  return null;
}

function convertUnitValue(value: number, fromUnit: string, toUnit: string): number | null {
  if (fromUnit === toUnit) return value;

  if (["c", "f", "k"].includes(fromUnit) || ["c", "f", "k"].includes(toUnit)) {
    return convertTemperature(value, fromUnit, toUnit);
  }

  const from = LINEAR_UNIT_FACTORS[fromUnit];
  const to = LINEAR_UNIT_FACTORS[toUnit];
  if (!from || !to) return null;
  if (from.dimension !== to.dimension) return null;

  const baseValue = value * from.toBase;
  return baseValue / to.toBase;
}

function extractTrailingUnitToken(rawValue: string): string | null {
  const trailing = rawValue.match(/([a-zA-Z°µμ³^/]+)\s*$/);
  if (!trailing) return null;
  return normalizeUnitToken(trailing[1]);
}

function extractLeadingNumberAndUnit(rawValue: string): { value: number; unit: string | null } | null {
  const compact = rawValue
    .replace(/,/g, "")
    .replace(/[–—]/g, "-")
    .trim();
  if (!compact) return null;

  const numberMatch = compact.match(/-?\d+(?:\.\d+)?/);
  if (!numberMatch) return null;

  const value = Number.parseFloat(numberMatch[0]);
  if (!Number.isFinite(value)) return null;

  const after = compact.slice((numberMatch.index || 0) + numberMatch[0].length).trim();
  let parsedUnit: string | null = null;

  if (after) {
    const leadingUnit = after.match(/^([a-zA-Z°µμ³^/]+)/);
    if (leadingUnit) {
      parsedUnit = normalizeUnitToken(leadingUnit[1]);
    }
  }

  if (!parsedUnit) {
    parsedUnit = extractTrailingUnitToken(compact);
  }

  return { value, unit: parsedUnit };
}

export function extractUnitFromPropertyName(propertyName: string): string | undefined {
  const unitMatch = propertyName
    .replace(/\*/g, "")
    .replace(/\s*#\d+\s*$/, "")
    .trim()
    .match(/\(([^)]+)\)\s*$/);

  if (!unitMatch) return undefined;
  return unitMatch[1].trim();
}

export function parseNumericValueForExpectedUnit(rawValue: string, expectedUnit?: string): number | null {
  const parsed = extractLeadingNumberAndUnit(rawValue);
  if (!parsed) return null;

  const expected = expectedUnit ? normalizeUnitToken(expectedUnit) : null;
  if (!expected) {
    return parsed.value;
  }

  if (!parsed.unit) {
    return parsed.value;
  }

  const converted = convertUnitValue(parsed.value, parsed.unit, expected);
  return converted;
}

export function formatNumericForInput(value: number): string {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/\.0+$/, "");
}

/**
 * Strip a trailing unit suffix from a string value.
 *
 * Uses the same UNIT_ALIASES table as the rest of the normalization system
 * so there is a single source of truth for recognised units.
 */
export function stripTrailingUnitSuffix(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // Build display-form aliases once (lazy singleton)
  const aliases = Object.keys(UNIT_ALIASES);
  // Also include common display symbols not in the alias table
  const extra = ["°", "m³/h", "°C", "°F"];
  const candidates = [...new Set([...aliases, ...extra])].sort(
    (a, b) => b.length - a.length,
  );

  const lower = trimmed.toLowerCase();
  for (const u of candidates) {
    if (lower.length > u.length && lower.endsWith(u) && /\d/.test(trimmed.charAt(trimmed.length - u.length - 1))) {
      return trimmed.slice(0, -u.length).trim();
    }
  }
  return trimmed;
}
