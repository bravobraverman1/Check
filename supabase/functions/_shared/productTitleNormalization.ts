export function normalizeProductTitleWhitespace(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeProductTitleForCompare(raw: unknown): string {
  return normalizeProductTitleWhitespace(raw).toLowerCase();
}

export function hasNormalizedProductTitleMatch(
  existingTitles: Iterable<unknown>,
  title: unknown,
): boolean {
  const normalizedTitle = normalizeProductTitleForCompare(title);
  if (!normalizedTitle) return false;

  for (const candidate of existingTitles) {
    if (normalizeProductTitleForCompare(candidate) === normalizedTitle) {
      return true;
    }
  }

  return false;
}
