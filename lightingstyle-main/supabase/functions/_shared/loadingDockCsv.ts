import {
  formatDimensionEntriesInSemicolonListForCsv,
  formatDimensionFilterValueForCsv,
} from "./filterDimensionFormatting.ts";

export const LOADING_DOCK_CSV_MAX_COLS = 200;
const MIN_LOADING_DOCK_IMAGE_SLOTS = 8;
const IMAGE_SLOT_HEADER_REGEX = /^product image (id|file|description|is thumbnail|sort)\s*-\s*(\d+)$/i;
const REQUIRED_POST_IMAGE_HEADER_KEYS = new Set([
  "searchkeywords",
  "pagetitle",
  "metakeywords",
  "metadescription",
  "myobassetacct",
  "myobincomeacct",
  "myobexpenseacct",
  "productcondition",
  "showproductcondition",
  "eventdaterequired",
  "eventdatename",
  "eventdateislimited",
  "eventdatestartdate",
  "eventdateenddate",
  "sortorder",
  "producttaxclass",
  "productupcean",
  "stopprocessingrules",
  "producturl",
  "redirectoldurl",
  "gpsmanufacturerpartnumber",
  "gpscategory",
  "gpsenabled",
  "avalaraproducttaxcode",
  "productcustomfields",
]);

function normalizeCategoryCell(value: string): string {
  return String(value || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(";");
}

function normalizeHeaderKey(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSemicolonListHeader(header: string): boolean {
  const key = normalizeHeaderKey(header);
  return key === "category"
    || key === "categories"
    || key === "gpscategory"
    || key === "productcustomfields"
    || key === "customfields"
    || key === "filters"
    || key === "attributes"
    || key === "specifications";
}

function escapeCsvField(value: string): string {
  return value.includes(",") || value.includes('"') || value.includes("\n")
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

const IMAGE_FILE_HEADER_REGEX = /^product image file\s*-\s*(\d+)$/i;

/** Strip zero-width and non-breaking space chars so invisible residue reads as empty. */
function normalizeImageFileCell(value: string): string {
  return String(value ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

/** Return true only when the cell looks like a real image reference (URL / filename). */
function isRealImageFileValue(value: string): boolean {
  const normalized = normalizeImageFileCell(value);
  if (!normalized) return false;
  const lowered = normalized.toLowerCase();
  return lowered !== "0"
    && lowered !== "false"
    && lowered !== "n"
    && lowered !== "none"
    && lowered !== "null"
    && lowered !== "undefined"
    && lowered !== "n/a"
    && lowered !== "na"
    && lowered !== "-"
    && lowered !== "--";
}

function getImageSlotInfo(
  headers: string[],
  productRow: string[],
  maxCols: number,
): { requiredSlotCount: number; lastRequiredColumn: number } {
  const lastColumnBySlot = new Map<number, number>();
  let highestPopulatedSlot = 0;

  for (let c = 0; c < Math.min(headers.length, maxCols); c++) {
    const match = String(headers[c] || "").trim().match(IMAGE_SLOT_HEADER_REGEX);
    if (!match) continue;
    const slot = Number.parseInt(match[2] || "", 10);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    lastColumnBySlot.set(slot, Math.max(lastColumnBySlot.get(slot) ?? -1, c));
    const fileMatch = String(headers[c] || "").trim().match(IMAGE_FILE_HEADER_REGEX);
    if (fileMatch && isRealImageFileValue(productRow[c] || "")) {
      highestPopulatedSlot = Math.max(highestPopulatedSlot, slot);
    }
  }

  if (lastColumnBySlot.size === 0) return { requiredSlotCount: 0, lastRequiredColumn: -1 };

  const requiredSlotCount = Math.max(MIN_LOADING_DOCK_IMAGE_SLOTS, highestPopulatedSlot);
  let lastRequiredColumn = -1;
  for (let slot = 1; slot <= requiredSlotCount; slot++) {
    lastRequiredColumn = Math.max(lastRequiredColumn, lastColumnBySlot.get(slot) ?? -1);
  }
  return { requiredSlotCount, lastRequiredColumn };
}

function shouldSkipExcessImageSlotColumn(
  header: string,
  _value: string,
  requiredSlotCount: number,
): boolean {
  const match = String(header || "").trim().match(IMAGE_SLOT_HEADER_REGEX);
  if (!match) return false;
  const slot = Number.parseInt(match[2] || "", 10);
  // Skip ALL columns of excess slots (even if they have default Sort/Thumbnail values)
  return Number.isFinite(slot) && slot > requiredSlotCount;
}

function getRequiredPostImageLastColumn(headers: string[], maxCols: number): number {
  let lastProtectedColumn = -1;
  for (let c = 0; c < Math.min(headers.length, maxCols); c++) {
    if (REQUIRED_POST_IMAGE_HEADER_KEYS.has(normalizeHeaderKey(headers[c] || ""))) {
      lastProtectedColumn = c;
    }
  }
  return lastProtectedColumn;
}

function transformInputB4(cellText: string): string {
  let text = String(cellText || "").trim();
  if (!text) return "";

  text = text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00B0/g, "&deg;")
    .replace(/\u1D52/g, "&deg;")
    .replace(/\n/g, " <br/><strong>")
    .replace(/: /g, ":</strong> ")
    .replace(/\u2014/g, "-")
    .replace(/['\u2018\u2019]/g, "&#39;")
    .replace(/\u00E9/g, "&eacute;")
    .replace(/\u2265/g, "&ge;")
    .replace(/\u2013/g, "-");

  return `<p><strong>${text} <br/></p>`;
}

function escapeDescriptionText(text: string): string {
  return text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00B0/g, "&deg;")
    .replace(/\u1D52/g, "&deg;")
    .replace(/\u2014/g, "-")
    .replace(/['\u2018\u2019]/g, "&#39;")
    .replace(/\u00E9/g, "&eacute;")
    .replace(/\u2265/g, "&ge;")
    .replace(/\u2013/g, "-");
}

function transformInputB7(cellText: string): string {
  if (cellText === "" || cellText === null || cellText === undefined) return "";
  const normalized = String(cellText).replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  return normalized
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeDescriptionText(paragraph).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

export function formatProductDescriptionHtml(description: string, specData: string): string {
  const transformedDescription = transformInputB7(description || "");
  const transformedSpecData = transformInputB4(specData || "");
  if (!transformedSpecData) return transformedDescription;
  if (!transformedDescription) return transformedSpecData;
  return `${transformedDescription}${transformedSpecData}`;
}

function decodePossiblyEscapedHtml(text: string): string {
  return String(text || "")
    .replace(/&amp;lt;/gi, "&lt;")
    .replace(/&amp;gt;/gi, "&gt;")
    .replace(/&amp;deg;/gi, "&deg;")
    .replace(/&amp;#39;/gi, "&#39;")
    .replace(/&amp;eacute;/gi, "&eacute;")
    .replace(/&amp;ge;/gi, "&ge;")
    .replace(/&amp;le;/gi, "&le;")
    .replace(/&amp;amp;/gi, "&amp;");
}

function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&deg;/g, "°")
    .replace(/&#39;/g, "'")
    .replace(/&eacute;/g, "é")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&le;/g, "≤")
    .replace(/&ge;/g, "≥")
    .replace(/&amp;/g, "&");
}

function parseHtmlDescriptionBack(htmlDesc: string): { description: string; specData: string } {
  if (!htmlDesc || !htmlDesc.trim()) return { description: "", specData: "" };
  const normalizedHtmlDesc = decodePossiblyEscapedHtml(htmlDesc);

  const normalizeHtmlBlockToText = (value: string): string =>
    unescapeHtmlEntities(
      String(value || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/\u00A0/g, " ")
        .trim(),
    );

  const normalizeSpecLine = (value: string): string =>
    value
      .replace(/\s+/g, " ")
      .replace(/\s*:\s*/g, ": ")
      .trim();

  const isSpecLine = (value: string): boolean => {
    const line = value.trim();
    if (!line || !line.includes(":") || line.length > 220) return false;
    return /^[A-Za-z0-9][A-Za-z0-9\s/#&()+.%,-]{1,120}:\s*\S.+$/.test(line);
  };

  const classifyParagraphBlocks = (rawBlocks: string[]) => {
    const blocks = rawBlocks
      .map((block) => normalizeHtmlBlockToText(block))
      .filter(Boolean);
    if (blocks.length === 0) return { description: "", specData: "" };

    const descriptionParts: string[] = [];
    const specLines: string[] = [];
    let specMode = false;

    for (const block of blocks) {
      const lines = block
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) continue;

      const specLikeCount = lines.filter(isSpecLine).length;
      const looksLikeSpecBlock = specLikeCount > 0 && specLikeCount >= Math.ceil(lines.length / 2);

      if (!specMode && !looksLikeSpecBlock) {
        descriptionParts.push(lines.join(" "));
        continue;
      }

      specMode = true;
      for (const line of lines) {
        specLines.push(normalizeSpecLine(line));
      }
    }

    if (specLines.length === 0) {
      return { description: descriptionParts.join("\n\n").trim() || blocks.join("\n\n").trim(), specData: "" };
    }

    return {
      description: descriptionParts.join("\n\n").trim(),
      specData: specLines.join("\n"),
    };
  };

  const specStartMatch = normalizedHtmlDesc.match(/<(strong|b)>[^<]+?:\s*<\/\1>/i);

  if (!specStartMatch || specStartMatch.index === undefined) {
    const paragraphBlocks: string[] = [];
    const paragraphRegex = /<p>([\s\S]*?)<\/p>/gi;
    let match: RegExpExecArray | null;
    while ((match = paragraphRegex.exec(normalizedHtmlDesc)) !== null) {
      paragraphBlocks.push(match[1]);
    }

    if (paragraphBlocks.length === 0) {
      const plain = normalizeHtmlBlockToText(normalizedHtmlDesc);
      const plainLines = plain
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const specLike = plainLines.filter(isSpecLine).map(normalizeSpecLine);
      return specLike.length > 0
        ? { description: "", specData: specLike.join("\n") }
        : { description: plain, specData: "" };
    }

    const classified = classifyParagraphBlocks(paragraphBlocks);
    return classified.description || classified.specData ? classified : { description: "", specData: "" };
  }

  const descHtml = normalizedHtmlDesc.slice(0, specStartMatch.index);
  const specHtml = normalizedHtmlDesc.slice(specStartMatch.index);

  const descParagraphBlocks: string[] = [];
  const paragraphRegex = /<p>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  while ((match = paragraphRegex.exec(descHtml)) !== null) {
    descParagraphBlocks.push(match[1]);
  }

  const description = descParagraphBlocks.length > 0
    ? descParagraphBlocks
      .map((block) => unescapeHtmlEntities(
        block.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim(),
      ))
      .filter(Boolean)
      .join("\n\n")
    : unescapeHtmlEntities(
      descHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim(),
    );

  const specContent = specHtml
    .replace(/^<p>/i, "")
    .replace(/<\/p>\s*$/i, "")
    .replace(/<\/p>\s*<p>/gi, "<br/>");

  const parsedSpecLines = specContent
    .split(/<br\s*\/?>/i)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeHtmlBlockToText(line.replace(/<\/?(strong|b)>/gi, "").trim()))
    .filter(Boolean);

  return {
    description,
    specData: parsedSpecLines.join("\n"),
  };
}

function normalizeProductDescriptionCell(htmlDesc: string): string {
  if (!htmlDesc || !htmlDesc.trim()) return "";
  const parsed = parseHtmlDescriptionBack(htmlDesc);
  if (!parsed.description && !parsed.specData) return htmlDesc;
  return formatProductDescriptionHtml(parsed.description, parsed.specData);
}

export function buildLoadingDockCsvText(
  headersInput: Array<string | null | undefined>,
  productRowInput: Array<string | null | undefined>,
  maxCols = LOADING_DOCK_CSV_MAX_COLS,
): string {
  const headers = headersInput.map((value) => (value ?? "").toString());
  const productRow = productRowInput.map((value) => (value ?? "").toString());

  const descriptionColIndex = headers.findIndex((header) => {
    const normalized = header.trim().toLowerCase();
    return normalized === "product description" || normalized === "description";
  });
  if (descriptionColIndex !== -1) {
    productRow[descriptionColIndex] = normalizeProductDescriptionCell(productRow[descriptionColIndex] || "");
  }

  for (let c = 0; c < headers.length; c++) {
    if (!isSemicolonListHeader(headers[c] || "")) continue;
    productRow[c] = formatDimensionEntriesInSemicolonListForCsv(normalizeCategoryCell(productRow[c] || ""));
  }
  for (let c = 0; c < headers.length; c++) {
    productRow[c] = formatDimensionFilterValueForCsv(headers[c] || "", productRow[c] || "");
  }

  const imageSlotInfo = getImageSlotInfo(headers, productRow, maxCols);
  const requiredPostImageLastColumn = getRequiredPostImageLastColumn(headers, maxCols);
  let lastNonEmpty = 0;
  for (let c = 0; c < Math.min(headers.length, maxCols); c++) {
    if (shouldSkipExcessImageSlotColumn(headers[c] || "", productRow[c] || "", imageSlotInfo.requiredSlotCount)) continue;
    if ((headers[c] ?? "").trim() || (productRow[c] ?? "").trim()) {
      lastNonEmpty = c;
    }
  }
  lastNonEmpty = Math.max(lastNonEmpty, imageSlotInfo.lastRequiredColumn, requiredPostImageLastColumn);
  const selectedIndexes: number[] = [];
  for (let c = 0; c <= lastNonEmpty; c++) {
    if (shouldSkipExcessImageSlotColumn(headers[c] || "", productRow[c] || "", imageSlotInfo.requiredSlotCount)) continue;
    selectedIndexes.push(c);
  }

  return selectedIndexes.map((index) => escapeCsvField(headers[index] || "")).join(",")
    + "\n"
    + selectedIndexes.map((index) => escapeCsvField(productRow[index] || "")).join(",");
}
