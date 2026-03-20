import { useState, useCallback, useRef, useEffect } from "react";
import React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Upload, Loader2, ZoomIn, ZoomOut, X, CheckCircle, Search, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { removeCompareUploadedFiles, uploadFilesToCompareBucket } from "@/lib/bucketAllocation";
import { runAiAction } from "@/lib/runAiAction";
import { buildCompareDatasheetsPrompt } from "@/lib/aiPromptBuilders";
import { getAiActionRouting, getDefaultAiRoutingConfig } from "@/lib/aiRoutingConfig";
import { useCompareAi, type ComparisonRow } from "@/context/CompareAiContext";
import { loadPromptVariables } from "@/lib/promptVariablesCache";
import { selectFirstCompatibleActivePrompt } from "@/lib/aiPromptCandidateSelection";
import {
  getPromptVariablesInUse,
  resolvePromptVariables,
  type RuntimeContext,
  normalizePromptVariableBindingType,
} from "@/lib/resolvePromptVariables";
import {
  COMPARISON_ROW_KEYS,
} from "@/lib/aiCompareKeys";
import {
  isComparePlaceholderValue,
  normalizeComparisonRows,
} from "@/lib/pdfCompareNormalization";
import { buildComparisonAuditSummary } from "@/lib/compareAuditSummary";

// ── IndexedDB helpers for PDF persistence across refreshes ──────
const IDB_NAME = "compare-datasheets-db";
const IDB_STORE = "pdfs";
const IDB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { AiProgressBlock } from "@/components/AiProgressBlock";

// pdfjsLib types declared in src/lib/pdfSourceValidation.ts

const BASE_SCALE = 1.5;
const INSTRUCTION_FILE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — instruction PDFs rarely change
const COMPARE_STORAGE_TIMEOUT_MS = 8_000;
let compareInstructionCache:
  | { promptType: string; name: string; file: File; loadedAt: number }
  | null = null;

let textMeasureContext: CanvasRenderingContext2D | null | undefined;

const getTextMeasureContext = (): CanvasRenderingContext2D | null => {
  if (textMeasureContext !== undefined) return textMeasureContext;
  if (typeof document === "undefined") {
    textMeasureContext = null;
    return textMeasureContext;
  }
  const canvas = document.createElement("canvas");
  textMeasureContext = canvas.getContext("2d");
  return textMeasureContext;
};

const normalizeAiKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");


// ComparisonRow type imported from CompareAiContext

function tryParseJsonCandidates(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return text;

  const candidates = new Set<string>([trimmed]);
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) candidates.add(fencedMatch[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.add(trimmed.slice(firstBrace, lastBrace + 1).trim());
  }

  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.add(trimmed.slice(firstBracket, lastBracket + 1).trim());
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate
    }
  }

  return text;
}

function isStrictValidationFailureResponse(response: {
  error?: string;
  details?: string;
  meta?: Record<string, unknown>;
}): boolean {
  const meta = response.meta && typeof response.meta === "object" ? response.meta : null;
  const debug = meta && typeof meta.debug === "object" && meta.debug && !Array.isArray(meta.debug)
    ? meta.debug as Record<string, unknown>
    : null;
  const timing = debug && typeof debug.timing === "object" && debug.timing && !Array.isArray(debug.timing)
    ? debug.timing as Record<string, unknown>
    : null;
  const validationReason = typeof timing?.validation_failed_reason === "string"
    ? timing.validation_failed_reason
    : "";

  if (validationReason.trim().length > 0) return true;

  const haystack = `${response.error || ""} ${response.details || ""}`.toLowerCase();
  return /validation|required sections?|response guard|min text length|strict section|no usable comparison rows|empty compare output/.test(haystack);
}

async function withStepTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.floor(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function withOptionalTimeout<T>(task: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function extractRowList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;

  if (typeof payload === "string") {
    const reparsed = tryParseJsonCandidates(payload);
    if (reparsed !== payload) {
      return extractRowList(reparsed);
    }
    return null;
  }

  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.comparison_rows)) return record.comparison_rows;
  if (Array.isArray(record.rows)) return record.rows;
  if (Array.isArray(record.extracted_data)) return record.extracted_data;
  if (Array.isArray(record.data)) return record.data;

  return null;
}

function extractRowsFromCompareResponsePayload(responsePayload: unknown): {
  rows: ComparisonRow[];
  payloadIsEmptyObject: boolean;
} {
  const parsed = typeof responsePayload === "string"
    ? tryParseJsonCandidates(responsePayload)
    : responsePayload;
  const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? ((parsed as Record<string, unknown>).result ??
      (parsed as Record<string, unknown>).data ??
      parsed)
    : parsed;
  const payloadIsEmptyObject =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload as Record<string, unknown>).length === 0;
  const rowList = extractRowList(payload);

  return {
    rows: normalizeComparisonRows(rowList ?? []),
    payloadIsEmptyObject: Boolean(payloadIsEmptyObject),
  };
}

function extractComparePayloadObject(responsePayload: unknown): Record<string, unknown> | null {
  const parsed = typeof responsePayload === "string"
    ? tryParseJsonCandidates(responsePayload)
    : responsePayload;
  const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? ((parsed as Record<string, unknown>).result ??
      (parsed as Record<string, unknown>).data ??
      parsed)
    : parsed;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  return payload as Record<string, unknown>;
}

function hasComparableValue(value: string): boolean {
  return !isComparePlaceholderValue(value);
}

function getCompareRowCoverage(rows: ComparisonRow[]): { supplierFilled: number; lsFilled: number } {
  let supplierFilled = 0;
  let lsFilled = 0;
  for (const row of rows) {
    if (hasComparableValue(row.supplier)) supplierFilled += 1;
    if (hasComparableValue(row.ls)) lsFilled += 1;
  }
  return { supplierFilled, lsFilled };
}

// ── Text run for search highlighting ────────────────────────────
interface PdfTextRun {
  start: number;
  end: number;
  text: string;
  charOffsets: number[];
  totalWeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

const charWidthWeight = (char: string): number => {
  if (char === " ") return 0.42;
  if (char === "\t") return 1.2;
  if (/\s/.test(char)) return 0.5;
  if (/[ilI1|!.,:;'`]/.test(char)) return 0.5;
  if (/[\[\](){}<>\\/]/.test(char)) return 0.58;
  if (/[\-_=+~^*]/.test(char)) return 0.7;
  if (/[0-9]/.test(char)) return 0.95;
  if (/[MW@#%&QO0]/.test(char)) return 1.25;
  return 1;
};

const buildCharOffsets = (
  text: string,
  fontHeightPx?: number,
  fontFamily?: string,
): { charOffsets: number[]; totalWeight: number } => {
  const ctx = getTextMeasureContext();
  if (ctx && text.length > 0) {
    const fontSize = Math.max(8, Math.round(fontHeightPx ?? 12));
    const family = (fontFamily && fontFamily.trim()) || "sans-serif";
    ctx.font = `${fontSize}px ${family}`;
    const charOffsets: number[] = [0];
    let totalWeight = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charAt(i);
      const sample = char === " " ? "\u00A0" : char;
      const measured = ctx.measureText(sample).width;
      totalWeight += Math.max(0.1, Number.isFinite(measured) ? measured : 0.1);
      charOffsets.push(totalWeight);
    }
    if (totalWeight > 0) {
      return { charOffsets, totalWeight };
    }
  }

  const charOffsets: number[] = [0];
  let totalWeight = 0;
  for (let i = 0; i < text.length; i++) {
    totalWeight += charWidthWeight(text.charAt(i));
    charOffsets.push(totalWeight);
  }
  if (totalWeight <= 0) {
    return {
      charOffsets: Array.from({ length: text.length + 1 }, (_, index) => index),
      totalWeight: Math.max(1, text.length),
    };
  }
  return { charOffsets, totalWeight };
};

interface RenderedPageText {
  fullText: string;
  textRuns: PdfTextRun[];
  highlightLayer: HTMLDivElement;
}

// ── Standalone PDF pane with independent pan & zoom + search ────
function PdfPane({
  label,
  data,
  pdfJsReady,
}: {
  label: string;
  data: ArrayBuffer | null;
  pdfJsReady: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(100);
  const [zoomInput, setZoomInput] = useState("100");
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const searchPagesRef = useRef<RenderedPageText[]>([]);

  // Toolbar width for responsive scaling
  const [toolbarWidth, setToolbarWidth] = useState(9999);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  const clamp = (v: number) => Math.max(25, Math.min(300, Math.round(v)));

  const applyZoom = useCallback(
    (next: number) => {
      const clamped = clamp(next);
      setZoom(clamped);
      setZoomInput(String(clamped));
    },
    []
  );

  // Measure toolbar width
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setToolbarWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Render PDF pages with text extraction
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !data || !pdfJsReady || !window.pdfjsLib) {
      if (el) el.innerHTML = "";
      searchPagesRef.current = [];
      return;
    }
    el.innerHTML = "";
    searchPagesRef.current = [];
    (async () => {
      try {
        const pdfjs = window.pdfjsLib as any;
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
        const pages: RenderedPageText[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: BASE_SCALE });
          
          // Page wrapper (relative for overlay)
          const pageWrapper = document.createElement("div");
          pageWrapper.style.position = "relative";
          pageWrapper.style.marginBottom = i < pdf.numPages ? "8px" : "0";

          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          canvas.width = vp.width;
          canvas.height = vp.height;
          canvas.style.display = "block";
          canvas.style.width = `${vp.width}px`;
          canvas.style.height = `${vp.height}px`;
          pageWrapper.appendChild(canvas);

          // Highlight overlay
          const highlightLayer = document.createElement("div");
          highlightLayer.style.position = "absolute";
          highlightLayer.style.inset = "0";
          highlightLayer.style.pointerEvents = "none";
          pageWrapper.appendChild(highlightLayer);

          el.appendChild(pageWrapper);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;

          // Extract text
          let fullText = "";
          const textRuns: PdfTextRun[] = [];
          let previousRun: PdfTextRun | null = null;
          try {
            const textContent = await page.getTextContent();
            const textStyles = (textContent as any).styles && typeof (textContent as any).styles === "object"
              ? (textContent as any).styles as Record<string, { fontFamily?: string; ascent?: number; descent?: number }>
              : {};
            for (const item of (textContent.items ?? [])) {
              const rawText = String((item as any).str ?? "");
              if (!rawText) continue;
              const itemTransform = Array.isArray((item as any).transform) ? (item as any).transform : null;
              if (!itemTransform) continue;

              const transformed = pdfjs.Util?.transform && Array.isArray(vp.transform)
                ? pdfjs.Util.transform(vp.transform, itemTransform)
                : itemTransform;
              const style = typeof (item as any).fontName === "string"
                ? textStyles[(item as any).fontName] ?? undefined
                : undefined;
              const left = Number(transformed?.[4] ?? 0);
              const baseline = Number(transformed?.[5] ?? 0);
              const measuredHeight = Math.abs(Number((item as any).height ?? 0)) * BASE_SCALE;
              const measuredWidth = Math.abs(Number((item as any).width ?? 0)) * BASE_SCALE;
              const matrixHeight = Math.hypot(Number(transformed?.[2] ?? 0), Number(transformed?.[3] ?? 0));
              const fontHeight = Math.max(6, measuredHeight, matrixHeight);
              const styleAscent = typeof style?.ascent === "number" ? style.ascent : 0.82;
              const styleDescent = typeof style?.descent === "number" ? style.descent : -0.2;
              const ascentRatio = Math.max(0.55, Math.min(1.2, styleAscent));
              const descentRatio = Math.max(-0.6, Math.min(0.25, styleDescent));
              const height = Math.max(6, fontHeight * (ascentRatio - descentRatio));
              const width = Math.max(1, measuredWidth);
              const top = Math.max(0, baseline - fontHeight * ascentRatio);

              if (fullText.length > 0 && !/\s$/.test(fullText) && !/^\s/.test(rawText) && previousRun) {
                const previousRight = previousRun.left + previousRun.width;
                const previousMidY = previousRun.top + previousRun.height * 0.5;
                const currentMidY = top + height * 0.5;
                const sameLine = Math.abs(previousMidY - currentMidY) <= Math.max(previousRun.height, height) * 0.6;
                const inferredGap = left - previousRight;
                const prevAvgCharWidth = previousRun.width / Math.max(1, previousRun.text.length);
                const gapThreshold = Math.max(0.75, prevAvgCharWidth * 0.22);

                if (sameLine && inferredGap > gapThreshold) {
                  const spaceStart = fullText.length;
                  fullText += " ";
                  const spaceEnd = fullText.length;

                  const spaceMetrics = buildCharOffsets(" ", Math.max(previousRun.height, height), style?.fontFamily);
                  const spaceRun: PdfTextRun = {
                    start: spaceStart,
                    end: spaceEnd,
                    text: " ",
                    charOffsets: spaceMetrics.charOffsets,
                    totalWeight: spaceMetrics.totalWeight,
                    left: previousRight,
                    top: Math.min(previousRun.top, top),
                    width: Math.max(1, inferredGap),
                    height: Math.max(previousRun.height, height),
                  };
                  textRuns.push(spaceRun);
                  previousRun = spaceRun;
                }
              }

              const start = fullText.length;
              fullText += rawText;
              const end = fullText.length;
              if ((item as any).hasEOL) fullText += "\n";

              const metrics = buildCharOffsets(rawText, fontHeight, style?.fontFamily);
              const textRun: PdfTextRun = {
                start,
                end,
                text: rawText,
                charOffsets: metrics.charOffsets,
                totalWeight: metrics.totalWeight,
                left,
                top,
                width,
                height,
              };
              textRuns.push(textRun);
              previousRun = textRun;
            }
          } catch {
            // text extraction failure is non-critical
          }
          pages.push({ fullText, textRuns, highlightLayer });
        }
        searchPagesRef.current = pages;
      } catch (e) {
        console.error("PDF render error:", e);
      }
    })();
  }, [data, pdfJsReady]);

  // Apply search highlights
  const applySearchHighlights = useCallback(() => {
    const pages = searchPagesRef.current;
    const trimmedQuery = searchQuery.trim().toLowerCase();
    for (const page of pages) {
      page.highlightLayer.innerHTML = "";
    }
    if (!trimmedQuery) {
      if (matchCount !== 0) setMatchCount(0);
      if (activeMatchIndex !== 0) setActiveMatchIndex(0);
      return;
    }
    const pageMatches: Array<{
      page: RenderedPageText;
      matchIndex: number;
      matchStart: number;
      matchEnd: number;
    }> = [];
    for (const page of pages) {
      const text = page.fullText.toLowerCase();
      if (!text) continue;
      let fromIndex = 0;
      while (fromIndex < text.length) {
        const matchStart = text.indexOf(trimmedQuery, fromIndex);
        if (matchStart === -1) break;
        const matchEnd = matchStart + trimmedQuery.length;
        pageMatches.push({
          page,
          matchIndex: pageMatches.length,
          matchStart,
          matchEnd,
        });
        fromIndex = matchStart + Math.max(1, trimmedQuery.length);
      }
    }
    if (matchCount !== pageMatches.length) setMatchCount(pageMatches.length);
    if (pageMatches.length === 0) {
      if (activeMatchIndex !== 0) setActiveMatchIndex(0);
      return;
    }
    const normalizedActiveIndex = activeMatchIndex >= pageMatches.length ? 0 : activeMatchIndex;
    if (normalizedActiveIndex !== activeMatchIndex) {
      setActiveMatchIndex(normalizedActiveIndex);
      return;
    }
    let activeElement: HTMLDivElement | null = null;
    for (const match of pageMatches) {
      const fragment = document.createDocumentFragment();
      const isActive = match.matchIndex === normalizedActiveIndex;
      const runs = match.page.textRuns.filter(
        (run) => run.end > match.matchStart && run.start < match.matchEnd,
      );
      for (const run of runs) {
        const runLength = run.end - run.start;
        if (runLength <= 0 || run.width <= 0 || run.height <= 0) continue;

        const overlapStart = Math.max(run.start, match.matchStart);
        const overlapEnd = Math.min(run.end, match.matchEnd);
        if (overlapEnd <= overlapStart) continue;

        const localStart = Math.max(0, Math.min(runLength, overlapStart - run.start));
        const localEnd = Math.max(localStart, Math.min(runLength, overlapEnd - run.start));
        const hasUsableOffsets = Array.isArray(run.charOffsets) && run.charOffsets.length >= runLength + 1;
        const runOffsets = hasUsableOffsets
          ? run.charOffsets
          : buildCharOffsets(typeof run.text === "string" ? run.text : "", run.height).charOffsets;
        const weightDenominator = run.totalWeight > 0
          ? run.totalWeight
          : Math.max(1, runOffsets[runOffsets.length - 1] ?? runLength);
        const startWeight = runOffsets[localStart] ?? localStart;
        const endWeight = runOffsets[localEnd] ?? localEnd;
        const startRatio = startWeight / weightDenominator;
        const endRatio = endWeight / weightDenominator;
        const segmentLeft = run.left + run.width * startRatio;
        const segmentWidth = Math.max(1, run.width * Math.max(0, endRatio - startRatio));

        const highlight = document.createElement("div");
        highlight.style.position = "absolute";
        highlight.style.left = `${segmentLeft}px`;
        highlight.style.top = `${run.top}px`;
        highlight.style.width = `${segmentWidth}px`;
        highlight.style.height = `${run.height}px`;
        highlight.style.borderRadius = "2px";
        highlight.style.background = isActive ? "rgba(245, 158, 11, 0.45)" : "rgba(250, 204, 21, 0.35)";
        highlight.style.boxShadow = isActive ? "0 0 0 1px rgba(217, 119, 6, 0.45) inset" : "none";
        fragment.appendChild(highlight);
        if (isActive && !activeElement) activeElement = highlight;
      }
      match.page.highlightLayer.appendChild(fragment);
    }
    if (activeElement) {
      requestAnimationFrame(() => {
        const sc = scrollRef.current;
        if (!sc) return;

        const containerRect = sc.getBoundingClientRect();
        const targetRect = activeElement.getBoundingClientRect();

        const targetCenterTop = sc.scrollTop + (targetRect.top - containerRect.top) - (sc.clientHeight - targetRect.height) / 2;
        const targetCenterLeft = sc.scrollLeft + (targetRect.left - containerRect.left) - (sc.clientWidth - targetRect.width) / 2;

        const maxTop = Math.max(0, sc.scrollHeight - sc.clientHeight);
        const maxLeft = Math.max(0, sc.scrollWidth - sc.clientWidth);

        sc.scrollTo({
          top: Math.max(0, Math.min(targetCenterTop, maxTop)),
          left: Math.max(0, Math.min(targetCenterLeft, maxLeft)),
          behavior: "smooth",
        });
      });
    }
  }, [activeMatchIndex, matchCount, searchQuery]);

  useEffect(() => {
    applySearchHighlights();
  }, [applySearchHighlights]);

  const stepSearchMatch = useCallback((direction: 1 | -1) => {
    if (matchCount <= 0) return;
    setActiveMatchIndex((current) => {
      const next = current + direction;
      if (next < 0) return matchCount - 1;
      if (next >= matchCount) return 0;
      return next;
    });
  }, [matchCount]);

  // Wheel zoom
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        applyZoom(zoom + (e.deltaY > 0 ? -10 : 10));
      }
    };
    sc.addEventListener("wheel", handler, { passive: false });
    return () => sc.removeEventListener("wheel", handler);
  }, [zoom, applyZoom]);

  // Arrow key trapping
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        const step = 60;
        if (e.key === "ArrowUp") sc.scrollTop -= step;
        if (e.key === "ArrowDown") sc.scrollTop += step;
        if (e.key === "ArrowLeft") sc.scrollLeft -= step;
        if (e.key === "ArrowRight") sc.scrollLeft += step;
      }
    };
    sc.addEventListener("keydown", onKeyDown);
    return () => sc.removeEventListener("keydown", onKeyDown);
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const sc = scrollRef.current;
    if (!sc) return;
    isDraggingRef.current = true;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !dragStart.current || !scrollRef.current) return;
      scrollRef.current.scrollLeft = dragStart.current.left - (e.clientX - dragStart.current.x);
      scrollRef.current.scrollTop = dragStart.current.top - (e.clientY - dragStart.current.y);
    };
    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setIsDragging(false);
      dragStart.current = null;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const cssScale = zoom / 100;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div ref={toolbarRef} className="flex items-center gap-1.5 px-2 py-1 border-b border-border bg-muted/30 shrink-0">
        <span className="text-xs font-medium truncate shrink-0">{label}</span>

        {/* Search */}
        {toolbarWidth >= 250 && (
          <div className="relative flex-1 min-w-[60px]">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setActiveMatchIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  stepSearchMatch(e.shiftKey ? -1 : 1);
                }
                if (e.key === "Escape") {
                  setSearchQuery("");
                  setActiveMatchIndex(0);
                }
              }}
              placeholder="Find"
              disabled={!data}
              className="h-6 pl-6 pr-1 text-xs"
            />
          </div>
        )}

        {toolbarWidth >= 250 && searchQuery.trim() && (
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
            {matchCount === 0 ? 0 : activeMatchIndex + 1}/{matchCount}
          </span>
        )}
        {toolbarWidth >= 250 && (
          <>
            <Button type="button" variant="outline" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => stepSearchMatch(-1)} disabled={!searchQuery.trim() || matchCount <= 0}>
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => stepSearchMatch(1)} disabled={!searchQuery.trim() || matchCount <= 0}>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </>
        )}

        {/* Zoom */}
        <Button type="button" variant="outline" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => applyZoom(zoom - 10)}>
          <ZoomOut className="h-3 w-3" />
        </Button>
        {toolbarWidth >= 320 && (
          <div className="relative shrink-0">
            <Input
              type="text"
              inputMode="numeric"
              value={zoomInput}
              onChange={(e) => setZoomInput(e.target.value.replace(/[^\d]/g, ""))}
              onBlur={() => {
                const n = parseInt(zoomInput, 10);
                if (!isNaN(n) && n > 0) applyZoom(n);
                else setZoomInput(String(zoom));
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="h-6 w-12 pl-1 pr-3.5 text-center text-xs"
            />
            <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
          </div>
        )}
        <Button type="button" variant="outline" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => applyZoom(zoom + 10)}>
          <ZoomIn className="h-3 w-3" />
        </Button>
      </div>

      {/* PDF content */}
      {!data ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          No PDF uploaded
        </div>
      ) : (
        <div
          ref={scrollRef}
          tabIndex={0}
          className={cn(
            "flex-1 overflow-auto bg-white select-none outline-none",
            isDragging ? "cursor-grabbing" : "cursor-grab"
          )}
          onMouseDown={onMouseDown}
        >
          <div style={{ transform: `scale(${cssScale})`, transformOrigin: "top left" }}>
            <div ref={containerRef} className="p-2" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────
export function CompareDatasheets() {
  const { toast } = useToast();
  const {
    supplierFileName,
    setSupplierFileName,
    lsFileName,
    setLsFileName,
    supplierData,
    setSupplierData,
    lsData,
    setLsData,
    comparing,
    setComparing,
    rows,
    setRows,
    debugPrompt,
    setDebugPrompt,
    debugOutput,
    setDebugOutput,
    sku,
    setSku,
    compareComplete,
    setCompareComplete,
    cancelledRef,
    additionalInstructions,
    setAdditionalInstructions,
    compareAttempted,
    setCompareAttempted,
    noReportableDifferences,
    setNoReportableDifferences,
    compareProgress,
    setCompareProgress,
    comparePhase,
    setComparePhase,
    compareStageTags,
    setCompareStageTags,
    leftPaneWidthPct,
    setLeftPaneWidthPct,
  } = useCompareAi();
  const viewerSplitRef = useRef<HTMLDivElement | null>(null);
  const isResizingRef = useRef(false);
  const splitRectRef = useRef<{ left: number; width: number } | null>(null);
  const instructionFileCacheRef = useRef<{ promptType: string; name: string; file: File; loadedAt: number } | null>(null);
  const displayedCompareProgress = Math.max(
    compareProgress.progress,
    compareProgress.chunksTotal > 0
      ? Math.floor((compareProgress.chunksDone / Math.max(1, compareProgress.chunksTotal)) * 100)
      : 2,
    2,
  );

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizingRef.current) return;
      const rect = splitRectRef.current;
      if (!rect || rect.width <= 0) return;
      const rawPct = ((event.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(25, Math.min(75, rawPct));
      setLeftPaneWidthPct(clamped);
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      splitRectRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [setLeftPaneWidthPct]);

  // ── Restore PDFs from IndexedDB on mount ──
  useEffect(() => {
    if ((supplierFileName && supplierData) || (lsFileName && lsData)) {
      return;
    }
    (async () => {
      try {
        const supplierMeta = await idbGet<{ name: string }>("supplier-meta");
        const supplierBuf = await idbGet<ArrayBuffer>("supplier-buf");
        if (supplierMeta && supplierBuf && !supplierData) {
          setSupplierFileName(supplierMeta.name);
          setSupplierData(supplierBuf);
        }
        const lsMeta = await idbGet<{ name: string }>("ls-meta");
        const lsBuf = await idbGet<ArrayBuffer>("ls-buf");
        if (lsMeta && lsBuf && !lsData) {
          setLsFileName(lsMeta.name);
          setLsData(lsBuf);
        }
      } catch (e) {
        console.warn("Failed to restore PDFs from IndexedDB:", e);
      }
    })();
  }, [lsData, lsFileName, setLsData, setLsFileName, setSupplierData, setSupplierFileName, supplierData, supplierFileName]);

  const [pdfJsReady, setPdfJsReady] = useState(!!window.pdfjsLib);

  // Load pdf.js
  useEffect(() => {
    if (window.pdfjsLib) { setPdfJsReady(true); return; }
    const script = document.createElement("script");
    script.src = "/pdfjs/pdf.min.js";
    script.async = true;
    script.onload = () => {
      if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = "";
      setPdfJsReady(true);
    };
    document.body.appendChild(script);
    return () => { if (script.parentNode) script.parentNode.removeChild(script); };
  }, []);

  // Keep table state aligned with visible debug output after remounts/state restores.
  useEffect(() => {
    if (!compareAttempted && (rows.length > 0 || debugOutput.trim().length > 0)) {
      setCompareAttempted(true);
    }
  }, [compareAttempted, debugOutput, rows.length, setCompareAttempted]);

  useEffect(() => {
    if (!compareAttempted || rows.length > 0) return;
    const text = debugOutput.trim();
    if (!text || text.startsWith("Comparing") || text.startsWith("ERROR:")) return;

    try {
      const parsed = tryParseJsonCandidates(text);
      const payload =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? ((parsed as Record<string, unknown>).result ??
            (parsed as Record<string, unknown>).data ??
            parsed)
          : parsed;
      const extracted = extractRowList(payload);
      if (Array.isArray(extracted) && extracted.length === 0) {
        setNoReportableDifferences(true);
      }
    } catch {
      // Ignore parse errors for non-JSON debug text
    }
  }, [compareAttempted, debugOutput, rows.length, setNoReportableDifferences]);

  const handleFileSelect = useCallback(
    async (which: "supplier" | "ls", file: File) => {
      const buf = await file.arrayBuffer();
      cancelledRef.current = true;
      setComparing(false);
      setCompareComplete(false);
      if (which === "supplier") {
        setSupplierFileName(file.name);
        setSupplierData(buf);
        await idbSet("supplier-meta", { name: file.name });
        await idbSet("supplier-buf", buf);
      } else {
        setLsFileName(file.name);
        setLsData(buf);
        await idbSet("ls-meta", { name: file.name });
        await idbSet("ls-buf", buf);
      }
      setCompareAttempted(false);
      setNoReportableDifferences(false);
      setRows([]);
      setDebugPrompt("");
      setDebugOutput("");
      setCompareProgress({ progress: 0, chunksDone: 0, chunksTotal: 0, chunksError: 0 });
      setComparePhase("Idle");
      setCompareStageTags([]);
    },
    [
      cancelledRef,
      setCompareAttempted,
      setCompareComplete,
      setComparePhase,
      setCompareProgress,
      setCompareStageTags,
      setComparing,
      setDebugOutput,
      setDebugPrompt,
      setLsData,
      setLsFileName,
      setNoReportableDifferences,
      setRows,
      setSupplierData,
      setSupplierFileName,
    ]
  );

  const handleRemoveFile = useCallback(async (which: "supplier" | "ls") => {
    cancelledRef.current = true;
    setComparing(false);
    setCompareComplete(false);
    if (which === "supplier") {
      setSupplierFileName(null);
      setSupplierData(null);
      await idbDelete("supplier-meta");
      await idbDelete("supplier-buf");
    } else {
      setLsFileName(null);
      setLsData(null);
      await idbDelete("ls-meta");
      await idbDelete("ls-buf");
    }
    setCompareAttempted(false);
    setNoReportableDifferences(false);
    setRows([]);
    setDebugPrompt("");
    setDebugOutput("");
    setCompareProgress({ progress: 0, chunksDone: 0, chunksTotal: 0, chunksError: 0 });
    setComparePhase("Idle");
    setCompareStageTags([]);
  }, [
    cancelledRef,
    setCompareAttempted,
    setCompareComplete,
    setComparePhase,
    setCompareProgress,
    setCompareStageTags,
    setComparing,
    setDebugOutput,
    setDebugPrompt,
    setLsData,
    setLsFileName,
    setNoReportableDifferences,
    setRows,
    setSupplierData,
    setSupplierFileName,
  ]);

  const handleCompare = useCallback(async () => {
    if (!supplierData || !lsData || !supplierFileName || !lsFileName) return;

    // Duplicate PDF detection
    if (supplierData.byteLength === lsData.byteLength && supplierFileName === lsFileName) {
      const viewA = new Uint8Array(supplierData);
      const viewB = new Uint8Array(lsData);
      let identical = true;
      for (let i = 0; i < viewA.length; i++) {
        if (viewA[i] !== viewB[i]) { identical = false; break; }
      }
      if (identical) {
        toast({
          variant: "destructive",
          title: "Duplicate PDFs detected",
          description: "Both uploaded files are identical. Please upload two different datasheets to compare.",
        });
        return;
      }
    }

    const routingConfig = getAiActionRouting("compare_two_datasheets");
    const defaultPromptCandidates = getDefaultAiRoutingConfig().compare_two_datasheets.promptCandidates;
    const promptCandidates = routingConfig.promptCandidates.length > 0
      ? routingConfig.promptCandidates
      : defaultPromptCandidates;

    if (!routingConfig.enabled) {
      toast({
        variant: "destructive",
        title: "Action Disabled in Admin",
        description: "Enable Compare Two Datasheets in Admin → AI Routing Options.",
      });
      return;
    }

    const liveDebugEvents: Array<Record<string, unknown>> = [];
    const pushDebugEvent = (stage: string, payload: Record<string, unknown> = {}) => {
      const event = {
        timestamp: new Date().toISOString(),
        stage,
        ...payload,
      };
      liveDebugEvents.push(event);
      if (liveDebugEvents.length > 200) {
        liveDebugEvents.splice(0, liveDebugEvents.length - 200);
      }
      setDebugOutput(JSON.stringify({
        stage,
        timestamp: event.timestamp,
        event_count: liveDebugEvents.length,
        latest: event,
        events: liveDebugEvents,
      }, null, 2));
    };

    cancelledRef.current = false;
    setComparing(true);
    setCompareComplete(false);
    setCompareAttempted(true);
    setNoReportableDifferences(false);
    setRows([]);
    setCompareProgress({ progress: 0, chunksDone: 0, chunksTotal: 0, chunksError: 0 });
    setComparePhase("Loading prompt and instructions");
    setCompareStageTags(["Prompt", "Instructions"]);
    pushDebugEvent("init", {
      message: "Starting compare pipeline",
      prompt_candidates: promptCandidates,
      require_instruction_pdf: routingConfig.requireInstructionPdf,
      strict_response_guard: routingConfig.strictResponseGuard,
      supplier_file: supplierFileName,
      ls_file: lsFileName,
      supplier_bytes: supplierData.byteLength,
      ls_bytes: lsData.byteLength,
      additional_instructions_chars: additionalInstructions.trim().length,
      sku: sku.trim() || null,
    });

    let compareFileRefs: Array<{ bucket: string; path: string; filename: string; label: string }> = [];
    const cleanupCompareFiles = () => {
      if (compareFileRefs.length === 0) return;
      const refsToRemove = compareFileRefs;
      compareFileRefs = [];
      void removeCompareUploadedFiles(refsToRemove).catch(() => undefined);
    };

    try {
      pushDebugEvent("loading_prompt_and_instruction_files", {
        prompt_candidates: promptCandidates,
      });
      setComparePhase("Loading prompt and instructions");
      setCompareStageTags(["Prompt", "Instructions"]);

      const promptSelection = await selectFirstCompatibleActivePrompt(promptCandidates, {
        compareSupplierPdf: {
          bucket: "",
          path: "",
          filename: supplierFileName || "supplier.pdf",
          label: "supplier",
        },
        compareLsPdf: {
          bucket: "",
          path: "",
          filename: lsFileName || "ls.pdf",
          label: "ls",
        },
        compareOptionalSku: sku.trim() || undefined,
        additionalInstructionsData: additionalInstructions.trim() || undefined,
      });

      const activePrompt = promptSelection?.prompt;
      if (!activePrompt) {
        toast({
          variant: "destructive",
          title: "No Active Prompt",
          description: `Create and activate one of: ${promptCandidates.join(", ")}.`,
        });
        return;
      }

      const hasTemplateVariables = /\{\{\s*[^}]+\s*\}\}/.test(activePrompt);
      const promptVariables = hasTemplateVariables
        ? await loadPromptVariables(promptSelection?.promptType || "compare_sheets")
        : [];
      const activePromptVariables = hasTemplateVariables
        ? getPromptVariablesInUse({
            promptType: promptSelection?.promptType || "compare_sheets",
            activeVersionContent: activePrompt,
            variables: promptVariables,
          })
        : [];
      const usesBinding = (bindingType: "instruction_pdf" | "supplier_datasheet_pdf" | "supplier_website_pdf" | "compare_supplier_pdf" | "compare_ls_pdf" | "form_sku" | "compare_optional_sku" | "additional_instructions_data") =>
        activePromptVariables.some(
          (variable) => normalizePromptVariableBindingType(String(variable.bindingType || "")) === bindingType,
        );
      const instructionVarNamesInPrompt = activePromptVariables
        .filter(
          (variable) => normalizePromptVariableBindingType(String(variable.bindingType || "")) === "instruction_pdf",
        )
        .map((variable) => variable.name)
        .filter(Boolean);
      const shouldLoadInstructionFile =
        routingConfig.requireInstructionPdf || instructionVarNamesInPrompt.length > 0;

      let instructionFile: { file: File; label: string } | null = null;
      let instructionFileName = "instructions.pdf";
      const promptTypeForInstruction = promptSelection?.promptType || "compare_sheets";
      const promptFolder = `prompt-${promptTypeForInstruction}`;
      if (shouldLoadInstructionFile) {
        if (
          compareInstructionCache &&
          compareInstructionCache.promptType === promptTypeForInstruction &&
          Date.now() - compareInstructionCache.loadedAt < INSTRUCTION_FILE_CACHE_TTL_MS
        ) {
          instructionFile = { file: new File([compareInstructionCache.file], "instructions.pdf", { type: compareInstructionCache.file.type }), label: "instructions" };
          instructionFileName = "instructions.pdf";
          instructionFileCacheRef.current = compareInstructionCache;
          pushDebugEvent("instruction_file_cache_hit", {
            prompt_type: promptTypeForInstruction,
            filename: compareInstructionCache.name,
            age_ms: Date.now() - compareInstructionCache.loadedAt,
            scope: "module",
          });
        } else {
          try {
            const { data: constList } = await withStepTimeout(
              supabase.storage
                .from("document-uploads-constant")
                .list(promptFolder, { limit: 1, sortBy: { column: "created_at", order: "desc" } }),
              COMPARE_STORAGE_TIMEOUT_MS,
              `Instruction list (${promptFolder})`,
            );
            if (constList && constList.length > 0) {
              const constPath = `${promptFolder}/${constList[0].name}`;
              instructionFileName = constList[0].name;
              const cached = instructionFileCacheRef.current;
              if (
                cached &&
                cached.promptType === promptTypeForInstruction &&
                cached.name === constList[0].name &&
                Date.now() - cached.loadedAt < INSTRUCTION_FILE_CACHE_TTL_MS
              ) {
                instructionFile = { file: new File([cached.file], "instructions.pdf", { type: cached.file.type }), label: "instructions" };
                pushDebugEvent("instruction_file_cache_hit", {
                  prompt_type: promptTypeForInstruction,
                  filename: cached.name,
                  age_ms: Date.now() - cached.loadedAt,
                });
              } else {
                const { data: constBlob } = await withStepTimeout(
                  supabase.storage
                    .from("document-uploads-constant")
                    .download(constPath),
                  COMPARE_STORAGE_TIMEOUT_MS,
                  `Instruction download (${promptFolder})`,
                );
                if (constBlob) {
                  const originalFile = new File([constBlob], constList[0].name, { type: "application/pdf" });
                  const file = new File([constBlob], "instructions.pdf", { type: "application/pdf" });
                  instructionFile = { file, label: "instructions" };
                  instructionFileCacheRef.current = {
                    promptType: promptTypeForInstruction,
                    name: constList[0].name,
                    file: originalFile,
                    loadedAt: Date.now(),
                  };
                  compareInstructionCache = instructionFileCacheRef.current;
                  pushDebugEvent("instruction_file_downloaded", {
                    prompt_type: promptTypeForInstruction,
                    filename: constList[0].name,
                    size_bytes: constBlob.size,
                  });
                }
              }
            }
          } catch (instructionError) {
            pushDebugEvent("instruction_file_load_error", {
              prompt_type: promptTypeForInstruction,
              error: instructionError instanceof Error ? instructionError.message : "Failed to list/download instruction file",
            });
          }
        }
      }

      setComparePhase("Preparing AI request");
      setCompareStageTags(["Prompt ready", "Instructions ready"]);
      pushDebugEvent("prompt_and_instruction_files_loaded", {
        prompt_type_selected: promptSelection?.promptType || "compare_sheets",
        prompt_chars: activePrompt.length,
        instruction_prompt_folder: promptFolder,
        instruction_file: instructionFile?.file?.name || null,
      });

      if (routingConfig.requireInstructionPdf && !instructionFile) {
        toast({
          variant: "destructive",
          title: "Missing Instruction PDF",
          description: "Upload Compare_Two_Data_Sheets_Instructions in Admin -> AI Prompt PDFs before running AI Compare.",
        });
        pushDebugEvent("blocked_missing_instruction_file", {
          prompt_type_selected: promptSelection?.promptType || "compare_sheets",
          required_prompt_folder: promptFolder,
        });
        return;
      }

      const shouldAttachInstructionFile = Boolean(
        instructionFile && (routingConfig.requireInstructionPdf || instructionVarNamesInPrompt.length > 0)
      );

      const supplierFile = new File([supplierData], "supplier.pdf", { type: "application/pdf" });
      const lsFile = new File([lsData], "ls.pdf", { type: "application/pdf" });

      pushDebugEvent("instruction_attach_decision", {
        has_instruction_file: Boolean(instructionFile),
        should_attach_instruction_file: shouldAttachInstructionFile,
        required_by_routing: routingConfig.requireInstructionPdf,
        instruction_vars_in_prompt: instructionVarNamesInPrompt,
      });

      const compareRuntimeCtx: RuntimeContext = {
        instructionPdf: shouldAttachInstructionFile && instructionFile
          ? {
              bucket: "document-uploads-constant",
              path: "",
              filename: "instructions.pdf",
              label: "instructions",
            }
          : null,
        datasheetUpload: usesBinding("supplier_datasheet_pdf")
          ? {
              bucket: "",
              path: "",
              filename: "supplier.pdf",
              label: "supplier",
            }
          : null,
        websiteUpload: usesBinding("supplier_website_pdf")
          ? {
              bucket: "",
              path: "",
              filename: "ls.pdf",
              label: "ls",
            }
          : null,
        compareSupplierPdf: usesBinding("compare_supplier_pdf")
          ? {
              bucket: "",
              path: "",
              filename: "supplier.pdf",
              label: "compare_supplier",
            }
          : null,
        compareLsPdf: usesBinding("compare_ls_pdf")
          ? {
              bucket: "",
              path: "",
              filename: "ls.pdf",
              label: "compare_ls",
            }
          : null,
        formSku: usesBinding("form_sku") ? (sku.trim() || undefined) : undefined,
        compareOptionalSku: (usesBinding("compare_optional_sku") || usesBinding("form_sku"))
          ? (sku.trim() || undefined)
          : undefined,
        additionalInstructionsData: usesBinding("additional_instructions_data")
          ? (additionalInstructions.trim() || undefined)
          : undefined,
      };

      const resolverRequestedLabels = new Set<string>();
      const resolvedActivePrompt = hasTemplateVariables
        ? (() => {
            const resolveResult = resolvePromptVariables(
              {
                promptType: promptSelection?.promptType || "compare_sheets",
                promptName: promptSelection?.promptType || "compare_sheets",
                activeVersionContent: activePrompt,
                variables: activePromptVariables,
              },
              compareRuntimeCtx,
            );

            const filteredValidationErrors = resolveResult.validationErrors.filter((err) => {
              if ((promptSelection?.promptType || "compare_sheets") !== "compare_sheets") return true;
              return !/^Missing required: SKU\b/i.test(err);
            });

            if (filteredValidationErrors.length > 0) {
              throw new Error(filteredValidationErrors[0]);
            }
            for (const file of resolveResult.files) {
              if (file.label) resolverRequestedLabels.add(file.label);
            }

            return resolveResult.finalPrompt;
          })()
        : activePrompt;

      const filesToUpload = [
        ...(shouldAttachInstructionFile && instructionFile && (routingConfig.requireInstructionPdf || resolverRequestedLabels.has("instructions"))
          ? [instructionFile]
          : []),
        // Compare action always needs both source documents.
        // Attach with legacy labels for backward compat, plus new labels if resolver requested them.
        { file: supplierFile, label: "supplier" as const },
        { file: lsFile, label: "ls" as const },
        ...(resolverRequestedLabels.has("compare_supplier")
          ? [{ file: supplierFile, label: "compare_supplier" as const }]
          : []),
        ...(resolverRequestedLabels.has("compare_ls")
          ? [{ file: lsFile, label: "compare_ls" as const }]
          : []),
      ];

      const finalPrompt = buildCompareDatasheetsPrompt({
        activePrompt: resolvedActivePrompt,
        additionalInstructions,
        includeAdditionalInstructions: routingConfig.includeAdditionalInstructions,
      });

      setDebugPrompt(`[USER PROMPT]\n${finalPrompt}`);
      pushDebugEvent("final_prompt_ready", {
        prompt_chars: finalPrompt.length,
        has_instruction_file: Boolean(instructionFile),
        file_count_to_upload: filesToUpload.length,
        labels: filesToUpload.map((f) => f.label),
      });

      const runCompareAttempt = async (
        attempt:
          | "fast_path"
          | "stalled_retry"
          | "watchdog_retry"
          | "strict_validation_retry"
          | "one_sided_recovery",
        maxValidationRetries: number,
        promptText: string,
        attemptFileRefs: Array<{ bucket: string; path: string; filename: string; label: string }>,
      ) => {
          pushDebugEvent("starting_ai_job", {
            attempt,
            type: "pdf_compare",
            mode: "json",
            file_ref_count: attemptFileRefs.length,
            max_validation_retries: maxValidationRetries,
            response_guard: {
              minJsonProperties: 3,
            },
          });

          const lastProgressSnapshot = {
            status: "",
            progressBucket: -1,
            chunksDone: -1,
            chunksError: -1,
          };

          const { response } = await runAiAction({
            actionKey: "compare_two_datasheets",
            userTaskPrompt: promptText,
            prebuiltPrompt: true,
            files: attemptFileRefs,
            mode: "json",
            type: "pdf_compare",
            debugPromptType: promptSelection.promptType,
            maxValidationRetries,
            responseGuard: {
              minJsonProperties: 3,
            },
            onProgress: (p) => {
              setCompareProgress((prev) => ({
                progress: Math.max(prev.progress, p.progress),
                chunksDone: Math.max(prev.chunksDone, p.chunksDone),
                chunksTotal: p.chunksTotal,
                chunksError: p.chunksError,
              }));

              if (p.status === "queued") {
                setComparePhase("Queued for AI processing");
                setCompareStageTags(["Files uploaded", "Queued"]);
              } else if (p.status === "running" && p.chunksTotal === 0) {
                setComparePhase("Preparing document chunks");
                setCompareStageTags(["AI started", "Chunking"]);
              } else if (p.status === "running" && p.chunksTotal > 0 && p.chunksDone === 0) {
                setComparePhase("Deep searching both PDFs");
                setCompareStageTags(["AI started", "Deep search"]);
              } else if (p.status === "running") {
                setComparePhase("Finalizing full comparison");
                setCompareStageTags(["Deep search", "Building results"]);
              } else if (p.status === "done") {
                setComparePhase("Comparison complete");
                setCompareStageTags(["Analyzed", "Results ready"]);
              }

              const progressBucket = Math.floor((p.progress || 0) / 5) * 5;
              const shouldLog =
                p.status !== lastProgressSnapshot.status ||
                progressBucket !== lastProgressSnapshot.progressBucket ||
                p.chunksDone !== lastProgressSnapshot.chunksDone ||
                p.chunksError !== lastProgressSnapshot.chunksError;
              if (!shouldLog) return;

              lastProgressSnapshot.status = p.status;
              lastProgressSnapshot.progressBucket = progressBucket;
              lastProgressSnapshot.chunksDone = p.chunksDone;
              lastProgressSnapshot.chunksError = p.chunksError;
              pushDebugEvent("poll", {
                attempt,
                jobId: p.jobId,
                status: p.status,
                pollCount: p.pollCount ?? null,
                progress: p.progress,
                chunks: {
                  total: p.chunksTotal,
                  done: p.chunksDone,
                  error: p.chunksError,
                },
              });
            },
          });

          if (response.error || !response.success) {
            pushDebugEvent("failed_response", { attempt, response });
            return { success: false as const, response };
          }

          pushDebugEvent("response_received", {
            attempt,
            success: true,
            model: response.meta?.model || null,
            latency_ms: response.meta?.latencyMs ?? null,
          });
          return { success: true as const, response };
      };

      const result = await (async () => {
        setComparePhase("Uploading documents");
        setCompareStageTags(["Uploading files"]);
        compareFileRefs = await uploadFilesToCompareBucket(filesToUpload);
        pushDebugEvent("files_uploaded", { bucket_refs: compareFileRefs });

        setComparePhase("Starting deep AI compare");
        setCompareStageTags(["Files uploaded", "Deep search"]);

        const fastAttempt = await runCompareAttempt("fast_path", 1, finalPrompt, compareFileRefs);
        if (fastAttempt.success) {
          return fastAttempt.response;
        }

        const rawError = fastAttempt.response.details || fastAttempt.response.error || "";
        const isStallFailure = /job stalled|stalled for \d+s with no progress/i.test(rawError);
        const isWatchdogFailure = /watchdog detected .*stale running chunk/i.test(rawError);
        if (isStallFailure || isWatchdogFailure) {
          pushDebugEvent("compare_retry_after_stall", {
            reason: rawError,
          });
          setComparePhase(isWatchdogFailure ? "Retrying after stale AI chunk" : "Retrying after stalled AI job");
          setCompareStageTags(["Retrying", "Deep search"]);
          setCompareProgress({ progress: 0, chunksDone: 0, chunksTotal: 0, chunksError: 0 });

          pushDebugEvent("retry_files_uploaded", {
            attempt: isWatchdogFailure ? "watchdog_retry" : "stalled_retry",
            bucket_refs: compareFileRefs,
          });
          const retryAttempt = await runCompareAttempt(
            isWatchdogFailure ? "watchdog_retry" : "stalled_retry",
            1,
            finalPrompt,
            compareFileRefs,
          );
          if (retryAttempt.success) return retryAttempt.response;

          const retryError = retryAttempt.response.details || retryAttempt.response.error || "";
          pushDebugEvent("compare_retry_failed_after_stall", {
            reason: retryError || rawError,
          });
          throw new Error(retryError || rawError || "AI comparison failed");
        }

        pushDebugEvent("compare_failed_no_retry", {
          reason: rawError,
          strict_validation_failure: isStrictValidationFailureResponse(fastAttempt.response),
        });
        throw new Error(rawError || "AI comparison failed");
      })();

      setComparePhase("Formatting results");
      setCompareStageTags(["AI complete", "Formatting rows"]);

      const responsePayload = result?.result ?? result?.data;
      if (!result?.success || !responsePayload) {
        throw new Error(result?.error || "AI returned no data");
      }

      const parsedRows = extractRowsFromCompareResponsePayload(responsePayload);
      let finalRows = parsedRows.rows;
      let finalMeta = result?.meta;

      if (finalRows.length === 0) {
        throw new Error(
          parsedRows.payloadIsEmptyObject
            ? "AI returned empty compare output."
            : "AI returned no usable comparison rows.",
        );
      }

      let finalCoverage = getCompareRowCoverage(finalRows);

      if (cancelledRef.current) {
        cleanupCompareFiles();
        return;
      }

      const completedPayload = extractComparePayloadObject(responsePayload);
      const sameProductAssessment =
        completedPayload?.same_product_assessment &&
        typeof completedPayload.same_product_assessment === "object" &&
        !Array.isArray(completedPayload.same_product_assessment)
          ? completedPayload.same_product_assessment
          : null;
      const comparisonAudit = buildComparisonAuditSummary(finalRows);

      pushDebugEvent("completed", {
        row_count: finalRows.length,
        supplier_fields: finalCoverage.supplierFilled,
        ls_fields: finalCoverage.lsFilled,
        comparison_audit: comparisonAudit,
        same_product_assessment: sameProductAssessment,
        one_sided_extraction: false,
        one_sided_recovery_applied: false,
      });

      setRows(finalRows);
      setNoReportableDifferences(finalRows.length === 0);
      setCompareProgress((prev) => ({ ...prev, progress: 100 }));
      setComparePhase("Comparison complete");
      setCompareStageTags(["Done", `${finalRows.length} rows`]);
      setCompareComplete(true);

      const latencyMs = finalMeta?.latencyMs;
      if (finalRows.length === 0) {
        toast({
          title: "No comparable rows",
          description: latencyMs
            ? `Completed in ${(latencyMs / 1000).toFixed(1)}s with no comparable extracted rows.`
            : "No comparable extracted rows were found.",
        });
      } else {
        toast({
          title: "AI Compare Complete",
          description: latencyMs
            ? `${finalRows.length} comparable row(s) in ${(latencyMs / 1000).toFixed(1)}s.`
            : `${finalRows.length} comparable row(s) found.`,
        });
      }

      cleanupCompareFiles();
    } catch (error) {
      cleanupCompareFiles();
      console.error("Compare failed:", error);
      const rawMsg = error instanceof Error ? error.message : String(error);
      pushDebugEvent("exception", { error: rawMsg });

      setComparePhase("Comparison failed");
      setCompareStageTags(["Error"]);
      setNoReportableDifferences(false);
      // Map technical messages to user-friendly text with actionable guidance
      let userTitle = "Comparison Failed";
      let userMsg: string;

      if (/api.?key|not set|not configured|unauthorized|403|401/i.test(rawMsg)) {
        userTitle = "AI Service Configuration Error";
        userMsg = "The AI service is not properly configured. Contact Eran to resolve this.";
      } else if (/network|fetch|ECONNREFUSED|ENOTFOUND|502|503|500|internal server/i.test(rawMsg)) {
        userTitle = "Connection Error";
        userMsg = "Could not connect to the AI service. Check your internet connection and click AI Compare to retry. If repeated, contact Eran.";
      } else if (/rate limit|429/i.test(rawMsg)) {
        userTitle = "AI Rate Limit";
        userMsg = "Too many requests. Wait 30–60 seconds, then click AI Compare again.";
      } else if (/job stalled|stalled for \d+s with no progress/i.test(rawMsg)) {
        userTitle = "AI Job Stalled";
        userMsg = "The compare job stalled during deep search. Click AI Compare to retry. If it repeats, try a smaller supplier PDF.";
      } else if (/timeout|abort|timed out/i.test(rawMsg)) {
        userTitle = "AI Request Timed Out";
        userMsg = "The comparison took too long. Click AI Compare to retry. If repeated, try smaller or simpler PDFs.";
      } else if (/bucket|storage|upload.*fail|slot/i.test(rawMsg)) {
        userTitle = "File Upload Error";
        userMsg = "There was a problem uploading your files. Click AI Compare to retry. If repeated, contact Eran.";
      } else if (/all chunks failed/i.test(rawMsg)) {
        userTitle = "AI Processing Failed";
        userMsg = "The AI could not process your PDFs. They may be image-only or corrupted. Re-upload cleaner PDFs and try again. If the problem persists, contact Eran.";
      } else if (/invalid compare schema|no comparable row list|empty structured comparison output|empty compare output|no usable comparison rows|extracted_data/i.test(rawMsg)) {
        userTitle = "No Usable Compare Data";
        userMsg = "The AI did not return a usable comparison. Re-upload both PDFs (ensure they are for the same product with selectable text) and click AI Compare. If repeated, contact Eran.";
      } else if (/one-sided extraction|quality gate failed/i.test(rawMsg)) {
        userTitle = "Compare Extraction Incomplete";
        userMsg = "The AI returned one-sided comparison data (one PDF was not fully extracted). Click AI Compare to retry. If repeated, tighten the compare prompt to force full extraction from both PDFs before diffing.";
      } else if (/product_data|PRODUCT_DATA|valid KEY.*VALUE|field lines/i.test(rawMsg)) {
        userTitle = "PDF Content Unreadable";
        userMsg = "The AI could not extract data from your PDFs. They may be image-only scans. Re-upload PDFs with selectable text and try again.";
      } else if (/validation|required sections?|response guard|strict section/i.test(rawMsg)) {
        userTitle = "AI Output Validation Failed";
        userMsg = "The AI response did not meet quality requirements. Click AI Compare to retry. If repeated, re-upload your PDFs. If it still fails, contact Eran.";
      } else if (/^Missing required:/i.test(rawMsg)) {
        userTitle = "Prompt Variable Missing";
        userMsg = `${rawMsg}. Update the Compare prompt variables in Admin or provide the missing input.`;
      } else {
        userMsg = "An unexpected error occurred. Click AI Compare to retry. If this keeps happening, re-upload your PDFs. If it still fails, contact Eran.";
      }

      toast({
        variant: "destructive",
        title: userTitle,
        description: userMsg,
      });
    } finally {
      setComparing(false);
    }
  }, [
    additionalInstructions,
    cancelledRef,
    lsData,
    lsFileName,
    setCompareAttempted,
    setCompareComplete,
    setComparePhase,
    setCompareProgress,
    setCompareStageTags,
    setComparing,
    setDebugOutput,
    setDebugPrompt,
    setNoReportableDifferences,
    setRows,
    sku,
    supplierData,
    supplierFileName,
    toast,
  ]);

  const bothUploaded = !!supplierData && !!lsData;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Uploads and compare two datasheets using AI prompt
      </p>

      {/* Upload row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Supplier PDF */}
        <div className="flex items-center gap-1">
          <label className="cursor-pointer">
            <input
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileSelect("supplier", f);
                e.target.value = "";
              }}
            />
            <Button type="button" variant="outline" size="sm" asChild>
              <span>
                <Upload className="h-3.5 w-3.5 mr-1" />
                {supplierFileName ? supplierFileName : "Upload Supplier Datasheet"}
              </span>
            </Button>
          </label>
          {supplierFileName && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => handleRemoveFile("supplier")}
              title="Remove Supplier Datasheet"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {/* LS PDF */}
        <div className="flex items-center gap-1">
          <label className="cursor-pointer">
            <input
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileSelect("ls", f);
                e.target.value = "";
              }}
            />
            <Button type="button" variant="outline" size="sm" asChild>
              <span>
                <Upload className="h-3.5 w-3.5 mr-1" />
                {lsFileName ? lsFileName : "Upload LS Datasheet"}
              </span>
            </Button>
          </label>
          {lsFileName && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => handleRemoveFile("ls")}
              title="Remove LS Datasheet"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-xs text-muted-foreground whitespace-nowrap">SKU (optional):</label>
          <Input
            type="text"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="e.g. ABC-123"
            className="h-8 w-40 text-xs"
          />
        </div>


        <Button
          type="button"
          disabled={!bothUploaded || comparing}
          onClick={handleCompare}
        >
          {comparing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              {compareProgress.chunksTotal > 1
                ? `Comparing ${compareProgress.chunksDone}/${compareProgress.chunksTotal}…`
                : "Comparing…"}
            </>
          ) : (
            "AI Compare"
          )}
        </Button>
        {comparing && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 text-xs text-muted-foreground"
            onClick={() => {
              cancelledRef.current = true;
              setComparePhase("Cancelled");
              setCompareStageTags(["Cancelled"]);
              setComparing(false);
              toast({ title: "Cancelled", description: "AI comparison was cancelled." });
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      <p className="text-xs text-destructive">
        Only add the optional SKU if the Supplier Datasheet contains a family of SKUs (eg variants of the same ceiling fans)
      </p>

      {/* Completion banner */}
      {compareComplete && !comparing && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
          <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
          <span className="text-xs font-medium text-green-700 dark:text-green-300">AI Compare Complete</span>
        </div>
      )}

      {comparing && (
        <AiProgressBlock
          title={comparePhase}
          progress={displayedCompareProgress}
          tags={compareStageTags}
        />
      )}

      {/* Comparison table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-muted/40 border-b border-border">
          <span className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">Comparison Results</span>
        </div>
        <div className="max-h-[400px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/20">
                <TableHead className="text-xs font-semibold text-center w-1/4 border-r border-border py-3 px-4">Field</TableHead>
                <TableHead className="text-xs font-semibold text-center w-[37.5%] border-r border-border py-3 px-4">Supplier Data Sheet</TableHead>
                <TableHead className="text-xs font-semibold text-center w-[37.5%] py-3 px-4">LS Data Sheet</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-xs text-muted-foreground text-center py-8">
                    {comparing
                      ? `${comparePhase} (${displayedCompareProgress}%)`
                      : compareAttempted
                        ? noReportableDifferences
                          ? "No comparable rows found."
                          : "No comparable rows were returned. Try again or review the AI output pane."
                        : "No data yet — upload two PDFs and click AI Compare"}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r, i) => (
                  <TableRow key={i} className={i % 2 === 0 ? "bg-background" : "bg-muted/10"}>
                    <TableCell className="text-xs font-semibold text-center border-r border-border py-3 px-4 align-middle">{r.field}</TableCell>
                    <TableCell className="text-xs text-center border-r border-border py-3 px-4 align-middle">{r.supplier}</TableCell>
                    <TableCell className="text-xs text-center py-3 px-4 align-middle">{r.ls}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Dual PDF viewers */}
      <div ref={viewerSplitRef} className="h-[450px] flex items-stretch">
        <div className="h-full border border-border rounded-lg overflow-hidden" style={{ width: `${leftPaneWidthPct}%` }}>
            <PdfPane label="Supplier Datasheet" data={supplierData} pdfJsReady={pdfJsReady} />
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          className="mx-2 w-2 shrink-0 cursor-col-resize rounded-sm bg-border/70 hover:bg-border"
          onMouseDown={(event) => {
            event.preventDefault();
            const rect = viewerSplitRef.current?.getBoundingClientRect();
            splitRectRef.current = rect ? { left: rect.left, width: rect.width } : null;
            isResizingRef.current = true;
          }}
        />

        <div className="h-full border border-border rounded-lg overflow-hidden" style={{ width: `${100 - leftPaneWidthPct}%` }}>
            <PdfPane label="LS Datasheet" data={lsData} pdfJsReady={pdfJsReady} />
        </div>
      </div>

      {/* Debug panes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Pane 1: Actual AI prompt */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-1.5 bg-muted/30 border-b border-border">
            <span className="text-xs font-medium">Actual AI prompt</span>
          </div>
          <pre className="p-3 text-xs whitespace-pre-wrap break-words max-h-[250px] overflow-auto font-mono text-foreground">
            {debugPrompt || "Run an AI Compare to see the full prompt sent to Gemini."}
          </pre>
          {/* Additional Prompt Instructions under debug prompt */}
          <div className="border-t border-border px-3 py-2 space-y-1">
            <Label htmlFor="compare-additional-instructions-debug" className="text-xs font-medium">
              Additional Prompt Instructions <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id="compare-additional-instructions-debug"
              value={additionalInstructions}
              onChange={(e) => setAdditionalInstructions(e.target.value)}
              placeholder="e.g. Focus on electrical specifications and ignore cosmetic differences"
              className="text-sm min-h-[60px]"
            />
          </div>
        </div>

        {/* Pane 2: AI output */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-1.5 bg-muted/30 border-b border-border">
            <span className="text-xs font-medium">AI output</span>
          </div>
          <pre className="p-3 text-xs whitespace-pre-wrap break-words max-h-[350px] overflow-auto font-mono text-foreground">
            {debugOutput || "Run an AI Compare to see the Gemini response."}
          </pre>
        </div>
      </div>
    </div>
  );
}
