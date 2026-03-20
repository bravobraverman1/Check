import type { PropertyDefinition } from "@/data/defaultProperties";

export interface ImportedProductFormData {
  sku: string;
  gpsMpn?: string;
  brand: string;
  title: string;
  visibility?: string;
  mainCategory: string;
  selectedCategories: string[];
  imageUrls: string[];
  chatgptData: string;
  chatgptDescription: string;
  emailNotes: string;
  specValues: Record<string, string>;
  otherValues: Record<string, string>;
  price?: string;
  retailPrice?: string;
}

export interface ParsedCustomFieldEntry {
  displayName: string;
  baseName: string;
  ordinal: number | null;
  value: string;
  matchedPropertyKey: string | null;
}

export interface ProductCsvImportResult {
  formData: ImportedProductFormData;
  jsonPayload: {
    source: "form_csv_import";
    filename: string;
    importedAt: string;
    basicFields: {
      sku: string;
      gpsMpn: string;
      brand: string;
      title: string;
      visibility: string;
      price: string;
      mainCategory: string;
      selectedCategories: string[];
      emailNotes: string;
      description: string;
    };
    images: Array<{ slot: number; value: string }>;
    customFields: ParsedCustomFieldEntry[];
    unmappedCsvFields: Record<string, string>;
    formData: ImportedProductFormData;
  };
}

const BASIC_FIELD_ALIASES: Record<string, string[]> = {
  sku: ["Product Code/SKU", "Product ID", "SKU"],
  gpsMpn: ["GPS Manufacturer Part Number", "Manufacturer Part Number", "MPN"],
  brand: ["Brand Name", "Brand"],
  title: ["Product Name", "Name", "Title"],
  visibility: ["Product Visible?", "Product Visibility", "Visibility", "Visible"],
  price: ["Price", "Sale Price"],
  retailPrice: ["Retail Price", "Cost Price", "RRP"],
  description: ["Product Description", "Description"],
  category: ["Category", "Categories"],
  gpsCategory: ["GPS Category"],
  emailNotes: ["Email Notes", "Notes for Email Body"],
  customFields: ["Product Custom Fields", "Custom Fields", "Specifications", "Filters", "Attributes"],
};

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
}

function splitCsvRows(text: string): string[] {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '"') {
      if (inQuotes && normalized[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
        current += char;
      }
      continue;
    }

    if (char === "\n" && !inQuotes) {
      if (current.trim()) rows.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) rows.push(current);
  return rows;
}

function normalizeHeaderName(value: string): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.,;:]+$/g, "");
}

function normalizeDisplayName(value: string): string {
  return String(value ?? "")
    .replace(/\*/g, "")
    .replace(/\s*\(([^)]*)\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBaseName(value: string): string {
  return normalizeDisplayName(value)
    .replace(/\s*#\s*\d+\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseOrdinal(value: string): { baseName: string; ordinal: number | null } {
  const normalized = normalizeDisplayName(value);
  const match = normalized.match(/^(.*?)\s*#\s*(\d+)\s*$/i);
  if (!match) {
    return {
      baseName: normalized,
      ordinal: null,
    };
  }

  return {
    baseName: match[1].trim(),
    ordinal: Number(match[2]),
  };
}

function getFirstDataRow(rows: string[]): string[] {
  if (rows.length < 2) {
    throw new Error("CSV must have at least 2 rows (header + data)");
  }

  for (let index = 1; index < rows.length; index += 1) {
    const row = parseCsvLine(rows[index]).map((value) => String(value ?? "").trim());
    if (row.some(Boolean)) return row;
  }

  throw new Error("CSV does not contain a populated product row");
}

function buildCsvMaps(csvText: string): {
  headers: string[];
  values: string[];
  exactMap: Map<string, string>;
  normalizedMap: Map<string, string>;
} {
  const rows = splitCsvRows(csvText);
  const headers = parseCsvLine(rows[0]).map((value) => String(value ?? "").replace(/^\uFEFF/, "").trim());
  const values = getFirstDataRow(rows);

  const exactMap = new Map<string, string>();
  const normalizedMap = new Map<string, string>();
  headers.forEach((header, index) => {
    const value = String(values[index] ?? "").trim();
    if (!header) return;
    if (!exactMap.has(header)) exactMap.set(header, value);
    const normalized = normalizeHeaderName(header);
    if (normalized && !normalizedMap.has(normalized)) normalizedMap.set(normalized, value);
  });

  return { headers, values, exactMap, normalizedMap };
}

function getValueByAliases(exactMap: Map<string, string>, normalizedMap: Map<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const exact = exactMap.get(alias);
    if (exact && exact.trim()) return exact.trim();
    const normalized = normalizedMap.get(normalizeHeaderName(alias));
    if (normalized && normalized.trim()) return normalized.trim();
  }
  return "";
}

function splitSemicolonValues(value: string): string[] {
  return String(value ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeVisibilityValue(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";

  if (/^\d+$/.test(trimmed)) {
    return String(Number(trimmed));
  }

  const normalized = trimmed.toLowerCase();
  if (["y", "yes", "true", "t", "on", "visible"].includes(normalized)) return "1";
  if (["n", "no", "false", "f", "off", "hidden"].includes(normalized)) return "0";

  return trimmed;
}

function stripHtml(value: string): string {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseProductDescriptionParts(htmlDesc: string): { description: string; aiData: string } {
  if (!htmlDesc || !htmlDesc.trim()) return { description: "", aiData: "" };
  const normalizedHtml = String(htmlDesc ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;|#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/#39;/gi, "'")
    .replace(/&quot;/gi, '"');

  const normalizeHtmlBlockToText = (value: string): string =>
    String(value ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\u00a0/g, " ")
      .trim();

  const normalizeAiDataLine = (value: string): string =>
    value
      .replace(/\s+/g, " ")
      .replace(/\s*:\s*/g, ": ")
      .trim();

  const looksLikeAiDataLine = (value: string): boolean => {
    const line = value.trim();
    if (!line) return false;
    if (!line.includes(":")) return false;
    if (line.length > 220) return false;
    return /^[A-Za-z0-9][A-Za-z0-9\s/#&()+.%,-]{1,120}:\s*\S.+$/.test(line);
  };

  const classifyParagraphBlocks = (rawBlocks: string[]): { description: string; aiData: string } => {
    const blocks = rawBlocks
      .map((block) => normalizeHtmlBlockToText(block))
      .filter(Boolean);
    if (blocks.length === 0) return { description: "", aiData: "" };

    const descriptionParts: string[] = [];
    const aiDataLines: string[] = [];
    let aiDataMode = false;

    for (const block of blocks) {
      const lines = block
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) continue;

      const aiDataLikeCount = lines.filter(looksLikeAiDataLine).length;
      const looksLikeAiDataBlock = aiDataLikeCount > 0 && aiDataLikeCount >= Math.ceil(lines.length / 2);

      if (!aiDataMode && !looksLikeAiDataBlock) {
        descriptionParts.push(lines.join(" "));
        continue;
      }

      aiDataMode = true;
      for (const line of lines) {
        if (looksLikeAiDataLine(line)) {
          aiDataLines.push(normalizeAiDataLine(line));
        }
      }
    }

    return {
      description: descriptionParts.join("\n\n").trim(),
      aiData: aiDataLines.join("\n"),
    };
  };

  const specStartMatch = normalizedHtml.match(/<(strong|b)>[^<]+?:\s*<\/\1>/i);
  if (!specStartMatch || specStartMatch.index === undefined) {
    const paragraphBlocks = Array.from(normalizedHtml.matchAll(/<p>([\s\S]*?)<\/p>/gi)).map((match) => match[1]);
    if (paragraphBlocks.length > 0) {
      const classified = classifyParagraphBlocks(paragraphBlocks);
      if (classified.description || classified.aiData) return classified;
    }

    const plainText = stripHtml(normalizedHtml);
    const plainLines = plainText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const aiData = plainLines.filter(looksLikeAiDataLine).map(normalizeAiDataLine).join("\n");
    if (aiData) {
      return {
        description: plainLines.filter((line) => !looksLikeAiDataLine(line)).join("\n\n"),
        aiData,
      };
    }

    return { description: plainText, aiData: "" };
  }

  const descriptionHtml = normalizedHtml.slice(0, specStartMatch.index);
  const aiDataHtml = normalizedHtml.slice(specStartMatch.index);

  const descriptionParagraphs = Array.from(descriptionHtml.matchAll(/<p>([\s\S]*?)<\/p>/gi))
    .map((match) => normalizeHtmlBlockToText(match[1]))
    .filter(Boolean);
  const description =
    descriptionParagraphs.length > 0
      ? descriptionParagraphs.join("\n\n")
      : normalizeHtmlBlockToText(descriptionHtml);

  const specContent = aiDataHtml
    .replace(/^<p>/i, "")
    .replace(/<\/p>\s*$/i, "")
    .replace(/<\/p>\s*<p>/gi, "<br/>");
  const aiData = specContent
    .split(/<br\s*\/?>/i)
    .map((line) => normalizeHtmlBlockToText(line.replace(/<\/?(strong|b)>/gi, "").trim()))
    .filter(Boolean)
    .filter(looksLikeAiDataLine)
    .map(normalizeAiDataLine)
    .join("\n");

  return {
    description,
    aiData,
  };
}

function parseOrderedCustomFieldEntries(raw: string): Array<{ displayName: string; baseName: string; ordinal: number | null; value: string }> {
  const rawEntries = String(raw ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) return null;
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (!key) return null;
      const parsedOrdinal = parseOrdinal(key);
      return {
        originalKey: normalizeDisplayName(key),
        baseName: parsedOrdinal.baseName,
        explicitOrdinal: parsedOrdinal.ordinal,
        value,
      };
    })
    .filter((entry): entry is { originalKey: string; baseName: string; explicitOrdinal: number | null; value: string } => entry !== null);

  const seenOrdinals = new Map<string, number>();
  return rawEntries.map((entry) => {
    const baseKey = normalizeBaseName(entry.baseName);
    const nextOrdinal =
      entry.explicitOrdinal ?? ((seenOrdinals.get(baseKey) ?? 0) + 1);
    seenOrdinals.set(baseKey, Math.max(seenOrdinals.get(baseKey) ?? 0, nextOrdinal));

    const baseName = normalizeDisplayName(entry.baseName);
    return {
      displayName: `${baseName} #${nextOrdinal}`,
      baseName,
      ordinal: nextOrdinal,
      value: entry.value,
    };
  });
}

function buildPropertyMatchers(properties: PropertyDefinition[]) {
  return properties.map((property, index) => {
    const parsedOrdinal = parseOrdinal(property.name);
    return {
      key: property.key,
      name: property.name,
      exactName: normalizeDisplayName(property.name).toLowerCase(),
      baseName: normalizeBaseName(property.name),
      ordinal: parsedOrdinal.ordinal,
      index,
    };
  });
}

function extractImageSlots(headers: string[], exactMap: Map<string, string>): Array<{ slot: number; value: string }> {
  const slotMap = new Map<number, string>();
  const slots: Array<{ slot: number; value: string }> = [];
  for (const header of headers) {
    const match = header.match(/^(?:Product\s+)?Image\s+(?:File|URL)\s*-\s*(\d+)$/i);
    if (!match) continue;
    const slot = Number(match[1]);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    const value = String(exactMap.get(header) ?? "").trim();
    if (!value) continue;
    if (!slotMap.has(slot)) slotMap.set(slot, value);
  }

  slotMap.forEach((value, slot) => {
    slots.push({ slot, value });
  });
  return slots.sort((left, right) => left.slot - right.slot);
}

export function parseProductCsvImport(
  csvText: string,
  options: {
    filename: string;
    properties: PropertyDefinition[];
  },
): ProductCsvImportResult {
  const { headers, exactMap, normalizedMap } = buildCsvMaps(csvText);
  const sku = getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.sku);
  if (!sku) {
    throw new Error("Use a 2-row product CSV with a valid Product Code/SKU (or Product ID/SKU) column.");
  }

  const gpsMpn = getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.gpsMpn);
  const brand = getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.brand);
  const title = getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.title);
  const visibilityRaw = getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.visibility);
  const visibility = normalizeVisibilityValue(visibilityRaw);
  const price = getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.price);
  const retailPrice = getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.retailPrice);
  const descriptionRaw = getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.description);
  const emailNotes = getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.emailNotes);
  const categoryRaw =
    getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.category) ||
    getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.gpsCategory);
  const selectedCategories = splitSemicolonValues(categoryRaw);
  const mainCategory = selectedCategories[0] ?? "";
  const imageSlots = extractImageSlots(headers, exactMap);
  const customFieldsRaw = getValueByAliases(exactMap, normalizedMap, BASIC_FIELD_ALIASES.customFields);
  const parsedCustomFields = parseOrderedCustomFieldEntries(customFieldsRaw);
  const propertyMatchers = buildPropertyMatchers(options.properties);
  const assignedPropertyKeys = new Set<string>();
  const specValues: Record<string, string> = {};
  const otherValues: Record<string, string> = {};

  const mappedCustomFields: ParsedCustomFieldEntry[] = parsedCustomFields.map((entry) => {
    const exactMatch = propertyMatchers.find((property) =>
      !assignedPropertyKeys.has(property.key) && property.exactName === entry.displayName.toLowerCase(),
    );
    const ordinalMatch =
      exactMatch ??
      propertyMatchers.find((property) =>
        !assignedPropertyKeys.has(property.key) &&
        property.baseName === normalizeBaseName(entry.baseName) &&
        property.ordinal === entry.ordinal,
      );
    const fallbackBaseMatch =
      ordinalMatch ??
      propertyMatchers.find((property) =>
        !assignedPropertyKeys.has(property.key) && property.baseName === normalizeBaseName(entry.baseName),
      );

    const matched = fallbackBaseMatch ?? null;
    if (matched) {
      assignedPropertyKeys.add(matched.key);
      specValues[matched.key] = entry.value;
    } else {
      otherValues[entry.displayName] = entry.value;
    }

    return {
      displayName: entry.displayName,
      baseName: entry.baseName,
      ordinal: entry.ordinal,
      value: entry.value,
      matchedPropertyKey: matched?.key ?? null,
    };
  });

  const reservedHeaders = new Set(
    Object.values(BASIC_FIELD_ALIASES)
      .flat()
      .map((header) => normalizeHeaderName(header))
      .concat(["product custom fields"]),
  );
  const imageHeaderPattern = /^(?:product\s+)?image\s+(?:file|url|is thumbnail|sort|id)\s*-\s*\d+$/i;
  const unmappedCsvFields: Record<string, string> = {};
  headers.forEach((header) => {
    const normalized = normalizeHeaderName(header);
    if (!normalized) return;
    if (reservedHeaders.has(normalized)) return;
    if (imageHeaderPattern.test(normalized)) return;
    const value = String(exactMap.get(header) ?? "").trim();
    if (!value) return;
    unmappedCsvFields[header] = value;
  });

  const parsedProductDescription = parseProductDescriptionParts(descriptionRaw);
  const chatgptData = parsedProductDescription.aiData;
  const chatgptDescription = parsedProductDescription.description;
  const formData: ImportedProductFormData = {
    sku,
    gpsMpn,
    brand,
    title,
    visibility,
    mainCategory,
    selectedCategories,
    imageUrls: imageSlots.map((entry) => entry.value),
    chatgptData,
    chatgptDescription,
    emailNotes,
    specValues,
    otherValues,
    price,
    retailPrice,
  };

  return {
    formData,
    jsonPayload: {
      source: "form_csv_import",
      filename: options.filename,
      importedAt: new Date().toISOString(),
      basicFields: {
        sku,
        gpsMpn,
        brand,
        title,
        visibility,
        price,
        mainCategory,
        selectedCategories,
        emailNotes,
        description: chatgptDescription,
      },
      images: imageSlots,
      customFields: mappedCustomFields,
      unmappedCsvFields,
      formData,
    },
  };
}
