const TITLE_CASE_ACRONYMS = new Set([
  "AC",
  "COB",
  "CRI",
  "CCT",
  "DALI",
  "DC",
  "IP",
  "IR",
  "LED",
  "RGB",
  "SMD",
  "TRI",
  "UV",
]);

function normalizeTokenCase(token: string): string {
  const match = token.match(/^([^A-Za-z0-9]*)([A-Za-z0-9]+)([^A-Za-z0-9]*)$/);
  if (!match) return token;

  const [, leading, core, trailing] = match;
  const upperCore = core.toUpperCase();
  if (TITLE_CASE_ACRONYMS.has(upperCore)) return `${leading}${upperCore}${trailing}`;
  if (/\d/.test(core)) return `${leading}${upperCore}${trailing}`;
  if (/^[IVXLCDM]+$/.test(upperCore) && upperCore.length <= 6) return `${leading}${upperCore}${trailing}`;

  const normalizedCore = upperCore.charAt(0) + upperCore.slice(1).toLowerCase();
  return `${leading}${normalizedCore}${trailing}`;
}

function normalizeWordCase(word: string): string {
  return word
    .split("-")
    .map((part) => normalizeTokenCase(part))
    .join("-");
}

export function normalizeGeneratedTitleCase(rawTitle: string): string {
  const title = rawTitle.trim().replace(/\s+/g, " ");
  if (!title) return "";

  const alphaChars = title.replace(/[^A-Za-z]/g, "");
  const looksAllCaps = alphaChars.length >= 4 && title === title.toUpperCase();
  if (!looksAllCaps) return title;

  return title
    .split(" ")
    .map((word) => normalizeWordCase(word))
    .join(" ");
}

