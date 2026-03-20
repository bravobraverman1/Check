declare global {
  interface Window {
    pdfjsLib?: PdfJsLibLike;
  }
}

interface PdfJsLibLike {
  GlobalWorkerOptions?: {
    workerSrc: string;
  };
  Util?: {
    transform: (m1: number[], m2: number[]) => number[];
  };
  getDocument: (source: { data: Uint8Array }) => {
    promise: Promise<PdfDocumentLike>;
  };
}

interface PdfDocumentLike {
  numPages: number;
  getPage: (pageIndex: number) => Promise<PdfPageLike>;
}

interface PdfPageLike {
  getTextContent: () => Promise<PdfTextContentLike>;
  getViewport: (options: { scale: number }) => { width: number; height: number; transform?: number[] };
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<unknown> };
}

interface PdfTextContentLike {
  items?: Array<{ str?: string }>;
}

const PDFJS_SCRIPT_ID = "pdfjs-lib-script";
const PDFJS_SCRIPT_SRC = "/pdfjs/pdf.min.js";
const PDFJS_WORKER_SRC = "/pdfjs/pdf.worker.min.js";
const PDF_TEXT_EXTRACTION_TIMEOUT_MS = 12000;
const PDF_TEXT_PAGE_LIMIT = 8;

let pdfjsLoaderPromise: Promise<void> | null = null;

const withTimeout = <T,>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });

const ensurePdfJsLoaded = async (): Promise<void> => {
  if (window.pdfjsLib) {
    if (window.pdfjsLib?.GlobalWorkerOptions) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
    }
    return;
  }

  if (!pdfjsLoaderPromise) {
    pdfjsLoaderPromise = new Promise((resolve, reject) => {
      const onLoad = () => {
        if (!window.pdfjsLib) {
          pdfjsLoaderPromise = null;
          reject(new Error("PDF library unavailable after load"));
          return;
        }
        if (window.pdfjsLib?.GlobalWorkerOptions) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
        }
        resolve();
      };

      const existing = document.getElementById(PDFJS_SCRIPT_ID) as HTMLScriptElement | null;
      if (existing) {
        existing.addEventListener("load", onLoad, { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load PDF library")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.id = PDFJS_SCRIPT_ID;
      script.src = PDFJS_SCRIPT_SRC;
      script.async = true;
      script.onload = onLoad;
      script.onerror = () => {
        pdfjsLoaderPromise = null;
        reject(new Error("Failed to load PDF library"));
      };
      document.body.appendChild(script);
    });
  }

  await pdfjsLoaderPromise;
};

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9.%+\-°/\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const PRODUCT_STOPWORDS = new Set([
  "with", "from", "this", "that", "your", "have", "will", "also", "into", "than", "each",
  "page", "pages", "model", "product", "products", "document", "documents", "datasheet",
  "website", "supplier", "standard", "name", "code", "item", "items", "unit", "units",
  "made", "using", "used", "only", "same", "visible", "includes", "including", "available",
  "white", "black", "warm", "cool", "daylight", "multi", "led",
]);

const tokenizeIdentity = (text: string): Set<string> => {
  const tokens = normalizeText(text).split(" ");
  return new Set(
    tokens.filter((token) =>
      token.length >= 4 &&
      !PRODUCT_STOPWORDS.has(token) &&
      !/^\d+$/.test(token),
    ),
  );
};

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
};

const extractHints = (text: string): Set<string> => {
  const normalized = normalizeText(text);
  const patterns = [
    /\bip\d{2,3}\b/g,
    /\b\d{1,4}(?:\.\d+)?\s?w\b/g,
    /\b\d{1,5}(?:\.\d+)?\s?lm\b/g,
    /\b\d{2,4}(?:\.\d+)?\s?mm\b/g,
    /\b\d{4}\s?k\b/g,
    /\bcri\s*:?\s*>?\s*\d+\b/g,
    /\b\d{1,3}\s?°\b/g,
    /\b\d{2,4}\s?-\s?\d{2,4}\s?mm\b/g,
  ];
  const hints = new Set<string>();
  for (const pattern of patterns) {
    const matches = normalized.match(pattern) || [];
    for (const match of matches) {
      hints.add(match.replace(/\s+/g, ""));
    }
  }
  return hints;
};

const numericTokens = (value: string): string[] =>
  Array.from(value.matchAll(/\d+(?:\.\d+)?/g)).map((match) => match[0]);

const valueSupportedByText = (value: string, text: string): boolean => {
  const normalizedValue = normalizeText(value);
  const normalizedText = normalizeText(text);
  if (!normalizedValue || normalizedValue === "missing") return false;

  if (normalizedValue.length >= 4 && normalizedText.includes(normalizedValue)) {
    return true;
  }

  const nums = numericTokens(normalizedValue);
  if (nums.length > 0 && nums.every((token) => normalizedText.includes(token))) {
    const alphaTokens = normalizedValue.split(" ").filter((token) => /[a-z]/.test(token) && token.length >= 3);
    if (alphaTokens.length === 0) return true;
    return alphaTokens.some((token) => normalizedText.includes(token));
  }

  return false;
};

export async function extractPdfPlainText(data: ArrayBuffer | null): Promise<string> {
  if (!data) return "";
  await ensurePdfJsLoaded();
  if (!window.pdfjsLib) {
    throw new Error("PDF library unavailable");
  }
  const pdf = await withTimeout(
    window.pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise,
    PDF_TEXT_EXTRACTION_TIMEOUT_MS,
    "PDF text extraction timed out",
  );

  const parts: string[] = [];
  const pageLimit = Math.min(pdf.numPages, PDF_TEXT_PAGE_LIMIT);
  for (let pageIndex = 1; pageIndex <= pageLimit; pageIndex += 1) {
    const page = await withTimeout(pdf.getPage(pageIndex), PDF_TEXT_EXTRACTION_TIMEOUT_MS, `PDF page ${pageIndex} text load timed out`);
    const content = await withTimeout(page.getTextContent(), PDF_TEXT_EXTRACTION_TIMEOUT_MS, `PDF page ${pageIndex} text extraction timed out`);
    const pageText = (content.items || [])
      .map((item) => (typeof item?.str === "string" ? item.str : ""))
      .join(" ");
    parts.push(pageText);
  }
  return parts.join(" ");
}

export interface PdfRelationshipAssessment {
  sameProductLikely: boolean;
  confidence: number;
  overlapScore: number;
  sharedHintCount: number;
  reason: string;
}

export function assessPdfRelationship(datasheetText: string, websiteText: string): PdfRelationshipAssessment {
  const datasheetTokens = tokenizeIdentity(datasheetText);
  const websiteTokens = tokenizeIdentity(websiteText);
  const overlapScore = jaccard(datasheetTokens, websiteTokens);
  const datasheetHints = extractHints(datasheetText);
  const websiteHints = extractHints(websiteText);
  let sharedHintCount = 0;
  for (const hint of datasheetHints) {
    if (websiteHints.has(hint)) sharedHintCount += 1;
  }

  if (overlapScore < 0.04 && sharedHintCount === 0) {
    return {
      sameProductLikely: false,
      confidence: 95,
      overlapScore,
      sharedHintCount,
      reason: "Very low text overlap and no shared technical spec hints between the two uploaded PDFs.",
    };
  }

  if (overlapScore < 0.08 && sharedHintCount <= 1) {
    return {
      sameProductLikely: false,
      confidence: 85,
      overlapScore,
      sharedHintCount,
      reason: "Weak text overlap and almost no shared technical spec hints between the two uploaded PDFs.",
    };
  }

  return {
    sameProductLikely: true,
    confidence: Math.min(95, Math.round((overlapScore * 400) + (sharedHintCount * 10))),
    overlapScore,
    sharedHintCount,
    reason: "The uploaded PDFs share enough text/spec identity to be treated as the same product candidate.",
  };
}

export interface ProductDataSupportAudit {
  totalFields: number;
  supportedByDatasheet: number;
  supportedByWebsite: number;
  supportedByBoth: number;
  datasheetCoverage: number;
  websiteCoverage: number;
  dualCoverage: number;
  unsupportedRatio: number;
  unsupportedLines: string[];
}

export function assessProductDataSupport(
  productDataSection: string,
  datasheetText: string,
  websiteText: string,
): ProductDataSupportAudit {
  const lines = productDataSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z0-9 #()/-]+:\s+.+$/.test(line));

  let auditableFields = 0;
  let supportedByDatasheet = 0;
  let supportedByWebsite = 0;
  let supportedByBoth = 0;
  const unsupportedLines: string[] = [];

  for (const line of lines) {
    const [, field = "", rawValue = ""] = line.match(/^([^:]+):\s*(.+)$/) || [];
    const fragments = rawValue
      .split(";")
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment.length >= 3 && !/^(yes|no|variable|optional)$/i.test(fragment));

    if (fragments.length === 0) continue;
    auditableFields += 1;

    const datasheetSupported = fragments.some((fragment) => valueSupportedByText(fragment, datasheetText));
    const websiteSupported = fragments.some((fragment) => valueSupportedByText(fragment, websiteText));

    if (datasheetSupported) supportedByDatasheet += 1;
    if (websiteSupported) supportedByWebsite += 1;
    if (datasheetSupported && websiteSupported) supportedByBoth += 1;

    if (!datasheetSupported || !websiteSupported) {
      unsupportedLines.push(
        `${field}: value support missing from ${!datasheetSupported && !websiteSupported ? "both PDFs" : !datasheetSupported ? "datasheet PDF" : "website PDF"}`,
      );
    }
  }

  const totalFields = auditableFields;
  const datasheetCoverage = totalFields > 0 ? supportedByDatasheet / totalFields : 1;
  const websiteCoverage = totalFields > 0 ? supportedByWebsite / totalFields : 1;
  const dualCoverage = totalFields > 0 ? supportedByBoth / totalFields : 1;
  const unsupportedRatio = totalFields > 0 ? unsupportedLines.length / totalFields : 0;

  return {
    totalFields,
    supportedByDatasheet,
    supportedByWebsite,
    supportedByBoth,
    datasheetCoverage,
    websiteCoverage,
    dualCoverage,
    unsupportedRatio,
    unsupportedLines,
  };
}
