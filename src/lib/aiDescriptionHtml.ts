function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/°/g, "&deg;");
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function buildSpecParagraphHtml(aiDataText: string): string {
  const normalized = normalizeNewlines(aiDataText).trim();
  if (!normalized) return "";

  const rows = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex <= 0) return null;

      const label = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (!label || !value) return null;

      return `<strong>${escapeHtml(label.toUpperCase())}:</strong> ${escapeHtml(value)} <br/>`;
    })
    .filter((row): row is string => Boolean(row));

  return rows.length > 0 ? `<p>${rows.join("")}</p>` : "";
}

export function buildCombinedDescriptionHtml(descriptionText: string, aiDataText: string): string {
  const normalizedDescription = normalizeNewlines(descriptionText).trim();
  const paragraphHtml = normalizedDescription
    ? normalizedDescription
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br/>")}</p>`)
      .join("")
    : "";

  return `${paragraphHtml}${buildSpecParagraphHtml(aiDataText)}`.trim();
}

export function stripGeneratedSpecParagraph(descriptionHtml: string, aiDataText: string): string {
  const specParagraph = buildSpecParagraphHtml(aiDataText);
  if (!descriptionHtml || !specParagraph) return descriptionHtml;

  const trimmedDescription = descriptionHtml.trim();
  const trimmedSpecParagraph = specParagraph.trim();

  if (trimmedDescription.endsWith(trimmedSpecParagraph)) {
    return trimmedDescription.slice(0, trimmedDescription.length - trimmedSpecParagraph.length).trim();
  }

  return descriptionHtml;
}
