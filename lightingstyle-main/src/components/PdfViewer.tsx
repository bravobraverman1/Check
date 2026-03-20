import React, { useEffect, useRef, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronUp, Search, ZoomIn, ZoomOut } from "lucide-react";

// pdfjsLib types declared in src/lib/pdfSourceValidation.ts

interface PdfJsRenderTask {
  promise: Promise<void>;
}

interface PdfJsViewport {
  width: number;
  height: number;
  transform?: number[];
}

interface PdfJsTextItem {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
  hasEOL?: boolean;
}

interface PdfJsTextContent {
  items?: PdfJsTextItem[];
  styles?: Record<string, { fontFamily?: string; ascent?: number; descent?: number }>;
}

interface PdfJsPage {
  getViewport: (options: { scale: number }) => PdfJsViewport;
  getTextContent: () => Promise<PdfJsTextContent>;
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: PdfJsViewport }) => PdfJsRenderTask;
}

interface PdfJsDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
}

interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
}

interface PdfJsLib {
  GlobalWorkerOptions?: {
    workerSrc: string;
  };
  Util?: {
    transform: (m1: number[], m2: number[]) => number[];
  };
  getDocument: (options: { data: Uint8Array }) => PdfJsLoadingTask;
}

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

interface RenderedPdfPageText {
  fullText: string;
  textRuns: PdfTextRun[];
  highlightLayer: HTMLDivElement;
}

interface PdfViewerProps {
  datasheetData: ArrayBuffer | null;
  websiteData: ArrayBuffer | null;
  datasheetUrl: string | null;
  websiteUrl: string | null;
  datasheetSourceKey?: string | null;
  websiteSourceKey?: string | null;
  pdfView: "datasheet" | "website";
  onPdfViewChange: (view: "datasheet" | "website") => void;
}

const BASE_SCALE = 1.5; // Render at 150% for crisp zooming
const PDFJS_SCRIPT_ID = "pdfjs-lib-script";
const PDFJS_SCRIPT_SRC = "/pdfjs/pdf.min.js";
const PDFJS_WORKER_SRC = "/pdfjs/pdf.worker.min.js";
const PDF_PREVIEW_PAGE_LIMIT = 3;

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

let pdfjsLoaderPromise: Promise<void> | null = null;

const configurePdfWorker = () => {
  if (window.pdfjsLib?.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
  }
};

const ensurePdfJsLoaded = (): Promise<void> => {
  if (window.pdfjsLib) {
    configurePdfWorker();
    return Promise.resolve();
  }

  if (!pdfjsLoaderPromise) {
    pdfjsLoaderPromise = new Promise((resolve, reject) => {
      const onLoad = () => {
        if (window.pdfjsLib) {
          configurePdfWorker();
          resolve();
          return;
        }
        pdfjsLoaderPromise = null;
        reject(new Error("PDF library unavailable after load"));
      };
      const onError = () => {
        pdfjsLoaderPromise = null;
        reject(new Error("Failed to load PDF viewer"));
      };

      const existing = document.getElementById(PDFJS_SCRIPT_ID) as HTMLScriptElement | null;
      if (existing) {
        existing.addEventListener("load", onLoad, { once: true });
        existing.addEventListener("error", onError, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.id = PDFJS_SCRIPT_ID;
      script.src = PDFJS_SCRIPT_SRC;
      script.async = true;
      script.onload = onLoad;
      script.onerror = onError;
      document.body.appendChild(script);
    });
  }

  return pdfjsLoaderPromise;
};


function PdfViewerInner({
  datasheetData,
  websiteData,
  datasheetUrl,
  websiteUrl,
  datasheetSourceKey,
  websiteSourceKey,
  pdfView,
  onPdfViewChange,
}: PdfViewerProps) {
  const [pdfjsReady, setPdfjsReady] = useState(!!window.pdfjsLib);
  const [pdfLoadTimedOut, setPdfLoadTimedOut] = useState(false);
  const [datasheetRenderError, setDatasheetRenderError] = useState<string | null>(null);
  const [websiteRenderError, setWebsiteRenderError] = useState<string | null>(null);
  const [datasheetRendering, setDatasheetRendering] = useState(false);
  const [websiteRendering, setWebsiteRendering] = useState(false);
  const [datasheetHasPreview, setDatasheetHasPreview] = useState(false);
  const [websiteHasPreview, setWebsiteHasPreview] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [zoomInput, setZoomInput] = useState("100");
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [toolbarWidth, setToolbarWidth] = useState(9999);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  // Per-PDF cached canvases & scroll positions
  const datasheetCanvasRef = useRef<HTMLDivElement | null>(null);
  const websiteCanvasRef = useRef<HTMLDivElement | null>(null);
  const datasheetSearchPagesRef = useRef<RenderedPdfPageText[]>([]);
  const websiteSearchPagesRef = useRef<RenderedPdfPageText[]>([]);
  const datasheetRendered = useRef(false);
  const websiteRendered = useRef(false);
  const datasheetSourceKeyRef = useRef<string | null>(null);
  const websiteSourceKeyRef = useRef<string | null>(null);
  const datasheetRenderTokenRef = useRef(0);
  const websiteRenderTokenRef = useRef(0);
  const datasheetScroll = useRef({ top: 0, left: 0 });
  const websiteScroll = useRef({ top: 0, left: 0 });

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Pan/drag state
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  // Load pdf.js
  useEffect(() => {
    let cancelled = false;
    ensurePdfJsLoaded()
      .then(() => {
        if (!cancelled) setPdfjsReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setDatasheetRenderError("Failed to load PDF viewer");
          setWebsiteRenderError("Failed to load PDF viewer");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (pdfjsReady) return;
    setPdfLoadTimedOut(false);
    const timer = setTimeout(() => setPdfLoadTimedOut(true), 3000);
    return () => clearTimeout(timer);
  }, [pdfjsReady]);

  // Render a PDF into a container, aborting stale jobs when inputs change.
  const renderPdf = useCallback(async (
    data: ArrayBuffer,
    container: HTMLDivElement,
    textPagesRef: React.MutableRefObject<RenderedPdfPageText[]>,
    isStale: () => boolean,
    onFirstPageRendered: () => void,
    setRenderError: (message: string | null) => void,
  ): Promise<boolean> => {
    const pdfjs = window.pdfjsLib as unknown as PdfJsLib | undefined;
    if (!pdfjs || !data || isStale()) return false;
    setRenderError(null);
    container.innerHTML = "";
    textPagesRef.current = [];
    let renderedPageCount = 0;
    try {
      const buffer = data.slice(0);
      const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
      const pdf = await loadingTask.promise;
      if (isStale()) return false;
      const pageLimit = Math.min(pdf.numPages, PDF_PREVIEW_PAGE_LIMIT);
      for (let i = 1; i <= pageLimit; i++) {
        if (isStale()) return false;
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: BASE_SCALE });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        const pageWrapper = document.createElement("div");
        pageWrapper.style.position = "relative";
        pageWrapper.style.width = `${viewport.width}px`;
        pageWrapper.style.height = `${viewport.height}px`;
        pageWrapper.style.marginBottom = i < pdf.numPages ? "12px" : "0";
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.display = "block";
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const highlightLayer = document.createElement("div");
        highlightLayer.style.position = "absolute";
        highlightLayer.style.inset = "0";
        highlightLayer.style.pointerEvents = "none";
        pageWrapper.appendChild(canvas);
        pageWrapper.appendChild(highlightLayer);
        container.appendChild(pageWrapper);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const textContent = await page.getTextContent().catch(() => ({ items: [] } as PdfJsTextContent));
        const textStyles = textContent.styles ?? {};
        const textRuns: PdfTextRun[] = [];
        let fullText = "";
        let previousRun: PdfTextRun | null = null;
        for (const item of textContent.items ?? []) {
          const rawText = String(item?.str ?? "");
          const itemTransform = Array.isArray(item?.transform) ? item.transform : null;
          if (!rawText || !itemTransform) continue;

          const transformed = pdfjs.Util?.transform && Array.isArray(viewport.transform)
            ? pdfjs.Util.transform(viewport.transform, itemTransform)
            : itemTransform;
          const style = typeof (item as { fontName?: string }).fontName === "string"
            ? textStyles[(item as { fontName?: string }).fontName ?? ""]
            : undefined;
          const left = Number(transformed?.[4] ?? 0);
          const baseline = Number(transformed?.[5] ?? 0);
          const measuredHeight = Math.abs(Number(item.height ?? 0)) * BASE_SCALE;
          const measuredWidth = Math.abs(Number(item.width ?? 0)) * BASE_SCALE;
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
          if (item.hasEOL) {
            fullText += "\n";
          }

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
        textPagesRef.current.push({ fullText, textRuns, highlightLayer });
        renderedPageCount += 1;
        if (renderedPageCount === 1) {
          onFirstPageRendered();
        }
      }
      return !isStale();
    } catch (err: unknown) {
      if (!isStale()) {
        if (renderedPageCount > 0) {
          return true;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        console.error("PDF render error:", error, error.message, error.stack);
        setRenderError("PDF preview unavailable");
      }
      return false;
    }
  }, []);

  // Render datasheet lazily (active view first); keep cache across view switches.
  useEffect(() => {
    const sourceKey = datasheetData
      ? (datasheetSourceKey || `datasheet|${datasheetData.byteLength}`)
      : null;
    if (datasheetSourceKeyRef.current !== sourceKey) {
      datasheetSourceKeyRef.current = sourceKey;
      datasheetRendered.current = false;
      datasheetRenderTokenRef.current += 1;
      datasheetScroll.current = { top: 0, left: 0 };
      setDatasheetHasPreview(false);
      setDatasheetRenderError(null);
      datasheetSearchPagesRef.current = [];
      if (datasheetCanvasRef.current) datasheetCanvasRef.current.innerHTML = "";
    }

    if (!pdfjsReady || !datasheetData || !datasheetCanvasRef.current) {
      datasheetRendered.current = false;
      setDatasheetRendering(false);
      setDatasheetHasPreview(false);
      setDatasheetRenderError(null);
      datasheetScroll.current = { top: 0, left: 0 };
      datasheetSearchPagesRef.current = [];
      if (datasheetCanvasRef.current) datasheetCanvasRef.current.innerHTML = "";
      return;
    }

    if (datasheetRendered.current) return;

    setDatasheetRendering(true);
    setDatasheetHasPreview(false);
    const token = ++datasheetRenderTokenRef.current;
    renderPdf(
      datasheetData,
      datasheetCanvasRef.current,
      datasheetSearchPagesRef,
      () => datasheetRenderTokenRef.current !== token,
      () => {
        if (datasheetRenderTokenRef.current === token) {
          setDatasheetHasPreview(true);
        }
      },
      setDatasheetRenderError,
    )
      .then((ok) => {
        if (datasheetRenderTokenRef.current !== token) return;
        datasheetRendered.current = ok;
        setDatasheetRendering(false);
      })
      .catch(() => {
        if (datasheetRenderTokenRef.current !== token) return;
        datasheetRendered.current = false;
        setDatasheetRendering(false);
      });
  }, [datasheetData, datasheetSourceKey, pdfjsReady, renderPdf]);

  // Render website lazily (active view first); keep cache across view switches.
  useEffect(() => {
    const sourceKey = websiteData
      ? (websiteSourceKey || `website|${websiteData.byteLength}`)
      : null;
    if (websiteSourceKeyRef.current !== sourceKey) {
      websiteSourceKeyRef.current = sourceKey;
      websiteRendered.current = false;
      websiteRenderTokenRef.current += 1;
      websiteScroll.current = { top: 0, left: 0 };
      setWebsiteHasPreview(false);
      setWebsiteRenderError(null);
      websiteSearchPagesRef.current = [];
      if (websiteCanvasRef.current) websiteCanvasRef.current.innerHTML = "";
    }

    if (!pdfjsReady || !websiteData || !websiteCanvasRef.current) {
      websiteRendered.current = false;
      setWebsiteRendering(false);
      setWebsiteHasPreview(false);
      setWebsiteRenderError(null);
      websiteScroll.current = { top: 0, left: 0 };
      websiteSearchPagesRef.current = [];
      if (websiteCanvasRef.current) websiteCanvasRef.current.innerHTML = "";
      return;
    }

    if (websiteRendered.current) return;

    setWebsiteRendering(true);
    setWebsiteHasPreview(false);
    const token = ++websiteRenderTokenRef.current;
    renderPdf(
      websiteData,
      websiteCanvasRef.current,
      websiteSearchPagesRef,
      () => websiteRenderTokenRef.current !== token,
      () => {
        if (websiteRenderTokenRef.current === token) {
          setWebsiteHasPreview(true);
        }
      },
      setWebsiteRenderError,
    )
      .then((ok) => {
        if (websiteRenderTokenRef.current !== token) return;
        websiteRendered.current = ok;
        setWebsiteRendering(false);
      })
      .catch(() => {
        if (websiteRenderTokenRef.current !== token) return;
        websiteRendered.current = false;
        setWebsiteRendering(false);
      });
  }, [websiteData, websiteSourceKey, pdfjsReady, renderPdf]);

  // Save scroll position before switching, restore after
  const handleViewSwitch = useCallback((newView: "datasheet" | "website") => {
    const sc = scrollContainerRef.current;
    if (sc) {
      // Save current
      if (pdfView === "datasheet") {
        datasheetScroll.current = { top: sc.scrollTop, left: sc.scrollLeft };
      } else {
        websiteScroll.current = { top: sc.scrollTop, left: sc.scrollLeft };
      }
    }
    onPdfViewChange(newView);
    // Restore after DOM update
    requestAnimationFrame(() => {
      const sc2 = scrollContainerRef.current;
      if (!sc2) return;
      const saved = newView === "datasheet" ? datasheetScroll.current : websiteScroll.current;
      sc2.scrollTop = saved.top;
      sc2.scrollLeft = saved.left;
    });
  }, [pdfView, onPdfViewChange]);

  // Drag to pan — attach move/up to window so dragging continues outside the viewer
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const sc = scrollContainerRef.current;
    if (!sc) return;
    isDraggingRef.current = true;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !dragStart.current || !scrollContainerRef.current) return;
      scrollContainerRef.current.scrollLeft = dragStart.current.left - (e.clientX - dragStart.current.x);
      scrollContainerRef.current.scrollTop = dragStart.current.top - (e.clientY - dragStart.current.y);
    };
    const onMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setIsDragging(false);
      dragStart.current = null;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const clampZoom = useCallback((value: number) => Math.max(50, Math.min(300, Math.round(value))), []);

  // Zoom with center-point preservation
  const applyZoom = useCallback((nextZoom: number) => {
    const sc = scrollContainerRef.current;
    if (!sc) {
      const clamped = clampZoom(nextZoom);
      setZoom(clamped);
      setZoomInput(clamped.toString());
      return;
    }

    setZoom((prev) => {
      const next = clampZoom(nextZoom);
      if (prev === next) return prev;

      const prevScale = prev / 100;
      const nextScale = next / 100;
      
      // Get the center point of the visible viewport
      const viewportCenterX = sc.scrollLeft + sc.clientWidth / 2;
      const viewportCenterY = sc.scrollTop + sc.clientHeight / 2;
      
      // Convert to unscaled content coordinates
      const contentCenterX = viewportCenterX / prevScale;
      const contentCenterY = viewportCenterY / prevScale;
      
      // Apply zoom change after a microtask to let transform update
      requestAnimationFrame(() => {
        // Calculate where the content center should be in the new scale
        const newViewportCenterX = contentCenterX * nextScale;
        const newViewportCenterY = contentCenterY * nextScale;
        
        // Calculate scroll position to keep content center in viewport center
        const targetScrollLeft = newViewportCenterX - sc.clientWidth / 2;
        const targetScrollTop = newViewportCenterY - sc.clientHeight / 2;
        
        // Clamp to valid scroll range
        const maxScrollLeft = Math.max(0, sc.scrollWidth - sc.clientWidth);
        const maxScrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight);
        
        sc.scrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScrollLeft));
        sc.scrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));
      });
      
      setZoomInput(next.toString());
      return next;
    });
  }, [clampZoom]);

  const handleZoom = useCallback((delta: number) => {
    applyZoom(zoom + delta);
  }, [applyZoom, zoom]);

  const handleZoomInputChange = useCallback((value: string) => {
    // Strip all non-digits (including %)
    const cleaned = value.replace(/[^\d]/g, "");
    setZoomInput(cleaned || "");
  }, []);

  const handleZoomInputCommit = useCallback(() => {
    if (zoomInput === "") {
      setZoomInput(zoom.toString());
      return;
    }
    const num = parseInt(zoomInput, 10);
    if (!isNaN(num) && num > 0) {
      applyZoom(num);
    } else {
      setZoomInput(zoom.toString());
    }
  }, [zoomInput, zoom, applyZoom]);

  const applySearchHighlights = useCallback(() => {
    const pages = pdfView === "website" ? websiteSearchPagesRef.current : datasheetSearchPagesRef.current;
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
      page: RenderedPdfPageText;
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

    if (matchCount !== pageMatches.length) {
      setMatchCount(pageMatches.length);
    }

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
        if (isActive && !activeElement) {
          activeElement = highlight;
        }
      }
      match.page.highlightLayer.appendChild(fragment);
    }

    if (activeElement) {
      requestAnimationFrame(() => {
        const sc = scrollContainerRef.current;
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
  }, [activeMatchIndex, matchCount, pdfView, searchQuery]);

  useEffect(() => {
    applySearchHighlights();
  }, [applySearchHighlights, datasheetHasPreview, websiteHasPreview]);

  const stepSearchMatch = useCallback((direction: 1 | -1) => {
    if (matchCount <= 0) return;
    setActiveMatchIndex((current) => {
      const next = current + direction;
      if (next < 0) return matchCount - 1;
      if (next >= matchCount) return 0;
      return next;
    });
  }, [matchCount]);

  // Trap arrow keys inside the PDF scroll container so they don't scroll the page
  useEffect(() => {
    const sc = scrollContainerRef.current;
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

  // Measure toolbar width for responsive hiding
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

  // Pinch-to-zoom via wheel
  useEffect(() => {
    const sc = scrollContainerRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        handleZoom(e.deltaY > 0 ? -10 : 10);
      }
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, [handleZoom]);

  const cssScale = zoom / 100;
  const hasDatasheet = !!datasheetData && !!datasheetUrl;
  const hasWebsite = !!websiteData && !!websiteUrl;
  const activeUrl = pdfView === "website" ? websiteUrl : datasheetUrl;
  const hasContent = pdfView === "website" ? hasWebsite : hasDatasheet;
  const activeRendering = pdfView === "website" ? websiteRendering : datasheetRendering;
  const activeHasPreview = pdfView === "website" ? websiteHasPreview : datasheetHasPreview;
  const activeRenderError = pdfView === "website" ? websiteRenderError : datasheetRenderError;

  return (
    <div className="space-y-1.5">
      {/* Header - always show zoom, conditionally show PDF switcher */}
      <div ref={toolbarRef} className="flex items-center gap-1.5 overflow-hidden">
        {/* Toggle or label */}
        {hasDatasheet && hasWebsite ? (
          <div className="inline-flex items-center gap-0.5 rounded-full border border-border bg-background/70 p-0.5 shadow-sm shrink-0">
            <button
              type="button"
              onClick={() => handleViewSwitch("datasheet")}
              className={cn(
                "px-2.5 py-1 text-[11px] rounded-full transition-colors",
                pdfView === "datasheet"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Datasheet
            </button>
            <button
              type="button"
              onClick={() => handleViewSwitch("website")}
              className={cn(
                "px-2.5 py-1 text-[11px] rounded-full transition-colors",
                pdfView === "website"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Website
            </button>
          </div>
        ) : (
          <span className="text-xs font-medium shrink-0">
            {hasDatasheet || hasWebsite
              ? `PDF: ${pdfView === "website" ? "Website" : "Datasheet"}`
              : "PDF"}
          </span>
        )}

        {/* Search - hidden when very narrow */}
        {toolbarWidth >= 280 && (
          <div className="relative flex-1 min-w-[80px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
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
              placeholder="Find in PDF"
              disabled={!hasContent || activeRendering}
              className="h-7 pl-7 pr-2 text-xs"
            />
          </div>
        )}

        {/* Match nav - only when search visible and query active */}
        {toolbarWidth >= 280 && searchQuery.trim() && (
          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            {matchCount === 0 ? 0 : activeMatchIndex + 1}/{matchCount}
          </span>
        )}
        {toolbarWidth >= 280 && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0 shrink-0"
              onClick={() => stepSearchMatch(-1)}
              disabled={!searchQuery.trim() || matchCount <= 0}
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0 shrink-0"
              onClick={() => stepSearchMatch(1)}
              disabled={!searchQuery.trim() || matchCount <= 0}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </>
        )}

        {/* Zoom - always show +/- buttons, hide input when narrow */}
        <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => handleZoom(-10)}>
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        {toolbarWidth >= 380 && (
          <div className="relative shrink-0">
            <Input
              type="text"
              inputMode="numeric"
              value={zoomInput}
              onChange={(e) => handleZoomInputChange(e.target.value)}
              onBlur={handleZoomInputCommit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
              className="h-7 w-14 pl-1.5 pr-4 text-center text-xs tabular-nums"
            />
            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
              %
            </span>
          </div>
        )}
        <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => handleZoom(10)}>
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Viewer */}
      <div className="border border-border rounded-lg bg-muted/20 h-[360px] overflow-hidden">
        {!hasContent ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            Upload a PDF to preview
          </div>
        ) : !pdfjsReady ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>{pdfLoadTimedOut ? "PDF viewer blocked by browser" : "Loading PDF viewer…"}</span>
            {activeUrl && (
              <Button type="button" variant="outline" size="sm" asChild>
                <a href={activeUrl} target="_blank" rel="noreferrer">Open PDF</a>
              </Button>
            )}
          </div>
        ) : activeRenderError ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>{activeRenderError}</span>
            {activeUrl && (
              <Button type="button" variant="outline" size="sm" asChild>
                <a href={activeUrl} target="_blank" rel="noreferrer">Open PDF</a>
              </Button>
            )}
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            tabIndex={0}
            className={cn(
              "relative h-full w-full overflow-auto bg-white select-none outline-none",
              isDragging ? "cursor-grabbing" : "cursor-grab"
            )}
            onMouseDown={handleMouseDown}
          >
            <div
              style={{
                transform: `scale(${cssScale})`,
                transformOrigin: "top left",
              }}
            >
              <div
                ref={datasheetCanvasRef}
                className="p-3"
                style={{ display: pdfView === "datasheet" ? "block" : "none" }}
              />
              <div
                ref={websiteCanvasRef}
                className="p-3"
                style={{ display: pdfView === "website" ? "block" : "none" }}
              />
            </div>

            {activeRendering && !activeHasPreview && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-xs text-muted-foreground pointer-events-none">
                Rendering PDF…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const PdfViewer = React.memo(PdfViewerInner, (prevProps, nextProps) => (
  prevProps.datasheetData === nextProps.datasheetData
  && prevProps.websiteData === nextProps.websiteData
  && prevProps.datasheetUrl === nextProps.datasheetUrl
  && prevProps.websiteUrl === nextProps.websiteUrl
  && prevProps.datasheetSourceKey === nextProps.datasheetSourceKey
  && prevProps.websiteSourceKey === nextProps.websiteSourceKey
  && prevProps.pdfView === nextProps.pdfView
));
