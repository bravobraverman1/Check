import { extractGeminiLeadingText, parseGeminiSections } from "@/lib/parseGeminiSections";

export interface TwoPdfMergeNormalizationResult {
  refinedProductData: string;
  inferredConflicts: string[];
  dedupedLineCount: number;
}

export function reconcileTwoPdfProductDataAndConflicts(
  productDataSection: string,
  existingConflicts: string[] = [],
): TwoPdfMergeNormalizationResult {
  return {
    refinedProductData: productDataSection,
    inferredConflicts: [],
    dedupedLineCount: 0,
  };
}

export function getGenerateResponseRawText(response: { result?: unknown; data?: unknown }): string {
  if (typeof response.result === "string") return response.result;
  if (response.result) return JSON.stringify(response.result, null, 2);
  if (typeof response.data === "string") return response.data;
  if (response.data) return JSON.stringify(response.data, null, 2);
  return "";
}

export function extractProductDataSectionFromGenerateResponse(
  response: { result?: unknown; data?: unknown },
): string {
  const rawResult = getGenerateResponseRawText(response);
  if (!rawResult.trim()) return "";
  const sections = parseGeminiSections(rawResult);
  const structured = (sections.PRODUCT_DATA || "").trim();
  if (structured) return structured;
  return extractGeminiLeadingText(rawResult);
}
