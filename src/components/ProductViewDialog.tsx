import { useState, useCallback, useEffect, useRef } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Star, Download, X } from "lucide-react";
import type { OutputWorkFormData } from "@/lib/supabaseGoogleSheets";
import { SUPABASE_FUNCTIONS_URL } from "@/config/publicEnv";
import { buildEdgeRequestHeaders } from "@/lib/edgeAuth";
import { formatDimensionFilterValueForCsv } from "@/lib/filterDimensionFormatting";

const LENS_SIZE = 128;
const ZOOM_SCALE = 2.9;
const ZOOM_REOPEN_DELAY_MS = 500;
const ZOOM_HINT_HIDE_DELAY_MS = 500;

/** Try loading an image through the server-side proxy when direct load fails */
async function tryProxyFallback(
  img: HTMLImageElement,
  originalSrc: string,
  onProxied?: (originalSrc: string, blobUrl: string) => void
) {
  if (img.dataset.proxied) {
    img.src = "/placeholder.svg";
    return;
  }

  img.dataset.proxied = "1";

  try {
    const headers = await buildEdgeRequestHeaders({ "Content-Type": "application/json" });
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/image-proxy`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: originalSrc }),
    });
    if (!res.ok) throw new Error("proxy failed");
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    img.src = blobUrl;
    onProxied?.(originalSrc, blobUrl);
  } catch {
    img.src = "/placeholder.svg";
  }
}

interface ProductViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: OutputWorkFormData | null;
}

function decodeCommonEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&deg;/g, "°")
    .replace(/&eacute;/g, "é")
    .replace(/&le;/g, "≤")
    .replace(/&ge;/g, "≥");
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&deg;/g, "°")
    .replace(/&eacute;/g, "é")
    .replace(/&le;/g, "≤")
    .replace(/&ge;/g, "≥")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Render HTML description as React elements preserving paragraph breaks and bold text */
function renderDescription(html: string): React.ReactNode[] {
  if (!html.trim()) return [];

  const hasParagraphHtml = /<p[\s>]/i.test(html);
  const paragraphs = hasParagraphHtml
    ? html
      .replace(/<\/p>\s*<p>/gi, "|||PARA|||")
      .replace(/^<p>/i, "")
      .replace(/<\/p>$/i, "")
      .split("|||PARA|||")
    : html
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n/);

  return paragraphs.map((p, idx) => {
    const cleaned = decodeCommonEntities(p.replace(/<br\s*\/?>/gi, "\n").replace(/\u00A0/g, " "));

    const parts: React.ReactNode[] = [];
    const strongRegex = /<strong>([\s\S]*?)<\/strong>/gi;
    let lastIdx = 0;
    let partKey = 0;
    let match: RegExpExecArray | null;

    while ((match = strongRegex.exec(cleaned)) !== null) {
      if (match.index > lastIdx) {
        const before = cleaned.substring(lastIdx, match.index).replace(/<[^>]+>/g, "");
        parts.push(<span key={partKey++}>{before}</span>);
      }

      const boldText = match[1].replace(/<[^>]+>/g, "");
      parts.push(<strong key={partKey++}>{boldText}</strong>);
      lastIdx = match.index + match[0].length;
    }

    if (lastIdx < cleaned.length) {
      const remaining = cleaned.substring(lastIdx).replace(/<[^>]+>/g, "");
      parts.push(<span key={partKey++}>{remaining}</span>);
    }

    return (
      <p key={idx} style={{ fontSize: 14, color: "#2f2f2f", lineHeight: 1.5, margin: "0 0 12px 0" }}>
        {parts}
      </p>
    );
  });
}

/** Convert internal prop key (e.g. "colour1", "ipRating1") to a clean display label ("Colour", "IP Rating") */
function formatFilterKeyForDisplay(key: string): string {
  const base = key.replace(/\s*#?\d*$/, "").trim();
  const spaced = base.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced
    .split(/[\s_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Parse spec lines from chatgptData */
function splitDescriptionAndSpecs(chatgptDesc: string, chatgptData: string): {
  descriptionHtml: string;
  specs: { label: string; value: string }[];
} {
  const stripped = stripHtml(chatgptData);
  const specs: { label: string; value: string }[] = [];

  for (const line of stripped.split("\n")) {
    const t = line.trim();
    if (!t) continue;

    const i = t.indexOf(":");
    if (i > 0 && i < 60) {
      specs.push({
        label: t.substring(0, i).trim().toUpperCase(),
        value: t.substring(i + 1).trim(),
      });
    }
  }

  return { descriptionHtml: chatgptDesc, specs };
}

export function ProductViewDialog({ open, onOpenChange, data }: ProductViewDialogProps) {
  const [activeImg, setActiveImg] = useState(0);
  const [zooming, setZooming] = useState(false);
  const [zoomSuppressed, setZoomSuppressed] = useState(false);
  const [zoomPos, setZoomPos] = useState({ x: 50, y: 50 });
  const [lensPos, setLensPos] = useState({ x: LENS_SIZE / 2, y: LENS_SIZE / 2 });
  const [showZoomHint, setShowZoomHint] = useState(false);
  const [zoomHintText, setZoomHintText] = useState<"hover" | "expand">("hover");
  const [proxiedUrls, setProxiedUrls] = useState<Record<string, string>>({});
  const proxiedUrlsRef = useRef<Record<string, string>>({});
  const zoomPauseTimerRef = useRef<number | null>(null);
  const zoomHintTimerRef = useRef<number | null>(null);
  const zoomRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);

  const images = data?.imageUrls?.filter((u) => u.trim()) ?? [];
  const hasMultiple = images.length > 1;

  const handleProxied = useCallback((originalSrc: string, blobUrl: string) => {
    setProxiedUrls((prev) => {
      const existing = prev[originalSrc];
      if (existing && existing !== blobUrl) {
        URL.revokeObjectURL(existing);
      }
      return { ...prev, [originalSrc]: blobUrl };
    });
  }, []);

  useEffect(() => {
    proxiedUrlsRef.current = proxiedUrls;
  }, [proxiedUrls]);

  const pauseZoomAfterNav = useCallback(() => {
    setZooming(false);
    setZoomSuppressed(true);
    if (zoomPauseTimerRef.current !== null) {
      clearTimeout(zoomPauseTimerRef.current);
    }
    zoomPauseTimerRef.current = window.setTimeout(() => {
      setZoomSuppressed(false);
      zoomPauseTimerRef.current = null;
    }, ZOOM_REOPEN_DELAY_MS);
  }, []);

  const prev = useCallback(() => {
    setActiveImg((i) => (i - 1 + images.length) % images.length);
  }, [images.length]);

  const next = useCallback(() => {
    setActiveImg((i) => (i + 1) % images.length);
  }, [images.length]);

  const handleOpenChange = (v: boolean) => {
    if (v) {
      setActiveImg(0);
      setZooming(false);
      setZoomSuppressed(false);
      zoomRectRef.current = null;
      setShowZoomHint(images.length > 0);
      setZoomHintText("hover");
      if (zoomHintTimerRef.current !== null) {
        clearTimeout(zoomHintTimerRef.current);
        zoomHintTimerRef.current = null;
      }
    } else {
      setShowZoomHint(false);
      zoomRectRef.current = null;
      if (zoomHintTimerRef.current !== null) {
        clearTimeout(zoomHintTimerRef.current);
        zoomHintTimerRef.current = null;
      }
      setProxiedUrls((prev) => {
        for (const blobUrl of Object.values(prev)) {
          URL.revokeObjectURL(blobUrl);
        }
        proxiedUrlsRef.current = {};
        return {};
      });
    }
    onOpenChange(v);
  };

  useEffect(() => {
    return () => {
      for (const blobUrl of Object.values(proxiedUrlsRef.current)) {
        URL.revokeObjectURL(blobUrl);
      }
      if (zoomPauseTimerRef.current !== null) {
        clearTimeout(zoomPauseTimerRef.current);
      }
      if (zoomHintTimerRef.current !== null) {
        clearTimeout(zoomHintTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setShowZoomHint(images.length > 0);
    setZoomHintText("hover");
    if (zoomHintTimerRef.current !== null) {
      clearTimeout(zoomHintTimerRef.current);
      zoomHintTimerRef.current = null;
    }
  }, [open, images.length]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const cachedRect = zoomRectRef.current;
    const rect =
      cachedRect && cachedRect.width > 0 && cachedRect.height > 0
        ? cachedRect
        : (() => {
            const currentRect = e.currentTarget.getBoundingClientRect();
            const nextRect = {
              left: currentRect.left,
              top: currentRect.top,
              width: currentRect.width,
              height: currentRect.height,
            };
            zoomRectRef.current = nextRect;
            return nextRect;
          })();
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;

    const x = Math.max(0, Math.min(rawX, rect.width));
    const y = Math.max(0, Math.min(rawY, rect.height));

    const halfLens = LENS_SIZE / 2;
    const lensX = Math.max(halfLens, Math.min(x, rect.width - halfLens));
    const lensY = Math.max(halfLens, Math.min(y, rect.height - halfLens));

    setZoomPos({
      x: (x / rect.width) * 100,
      y: (y / rect.height) * 100,
    });

    setLensPos({ x: lensX, y: lensY });

    if (!zoomSuppressed && images.length > 0) {
      setZooming(true);
    }
  }, [zoomSuppressed, images.length]);

  if (!data) return null;

  const parsedPrice = data.price ? parseFloat(data.price) : null;
  const parsedCostPrice = data.costPrice ? parseFloat(data.costPrice) : null;
  const numericPrices = [parsedPrice, parsedCostPrice].filter((n): n is number => n !== null && Number.isFinite(n));

  const currentPrice = numericPrices.length > 0 ? Math.min(...numericPrices) : null;
  const highestPrice = numericPrices.length > 0 ? Math.max(...numericPrices) : null;
  const originalPrice = highestPrice !== null && currentPrice !== null && highestPrice > currentPrice ? highestPrice : null;
  const savings = currentPrice !== null && originalPrice !== null ? Math.round(originalPrice - currentPrice) : null;

  const { descriptionHtml, specs: specLines } = splitDescriptionAndSpecs(data.chatgptDescription || "", data.chatgptData || "");
  const customSpecs = Object.entries(data.specValues || {}).map(([k, v]) => ({
    label: formatFilterKeyForDisplay(k).toUpperCase(),
    value: formatDimensionFilterValueForCsv(k, v),
  }));
  const allSpecs = specLines.length > 0 ? specLines : customSpecs;

  const descElements = renderDescription(descriptionHtml);

  // Build the "-L" search keyword from MPN or SKU
  const mptFromSpecs = allSpecs.find((s) =>
    /gps\s*manufacturer\s*part/i.test(s.label) || /manufacturer\s*part\s*number/i.test(s.label) || /\bmpn\b/i.test(s.label) || /\bmpt\b/i.test(s.label)
  );
  const mptFromCustom = customSpecs.find((s) =>
    /gps\s*manufacturer\s*part/i.test(s.label) || /manufacturer\s*part\s*number/i.test(s.label) || /\bmpn\b/i.test(s.label) || /\bmpt\b/i.test(s.label)
  );
  const rawCode = data.gpsMpn || mptFromSpecs?.value || mptFromCustom?.value || "";
  const productCodeDisplay = rawCode ? (rawCode.endsWith("-L") ? rawCode : `${rawCode}-L`) : "";

  const specRows = allSpecs.filter((s) => s.value);

  const fontFamily = '"Univers LT Std", "Helvetica Neue", Helvetica, Arial, sans-serif';
  const activeImageSrc = images.length > 0 ? (proxiedUrls[images[activeImg]] || images[activeImg]) : "";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="h-[94vh] w-[min(96vw,1320px)] max-w-[1320px] overflow-hidden p-0 gap-0 rounded-none sm:rounded-md border-0 shadow-2xl [&>button:last-child]:hidden"
        style={{
          fontFamily,
          fontWeight: 400,
          backgroundColor: "#f3f3f3",
          color: "#333",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <button
          onClick={() => handleOpenChange(false)}
          className="absolute right-3 top-3 z-50 flex h-8 w-8 items-center justify-center rounded-full bg-red-500 text-white shadow-md transition-colors hover:bg-red-600"
          style={{ position: "sticky", top: 0, alignSelf: "flex-end", flexShrink: 0, margin: "10px 10px -40px 0", zIndex: 60 }}
          aria-label="Close"
        >
          <X style={{ width: 16, height: 16 }} />
        </button>

        <div className="overflow-y-auto overflow-x-hidden flex-1">
          <div style={{ width: "min(100%, 1240px)", margin: "0 auto" }}>
            <div style={{ padding: "30px 34px 0 34px" }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "center" }}>
                <div style={{ width: "min(100%, 620px)", flex: "1 1 560px", paddingRight: 28, paddingBottom: 12 }}>
                <div
                  onMouseEnter={(e) => {
                    if (!zoomSuppressed && images.length > 0) setZooming(true);
                    const rect = e.currentTarget.getBoundingClientRect();
                    zoomRectRef.current = rect
                      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
                      : null;
                    if (showZoomHint) {
                      setZoomHintText("expand");
                      if (zoomHintTimerRef.current !== null) {
                        clearTimeout(zoomHintTimerRef.current);
                      }
                      zoomHintTimerRef.current = window.setTimeout(() => {
                        setShowZoomHint(false);
                        zoomHintTimerRef.current = null;
                      }, ZOOM_HINT_HIDE_DELAY_MS);
                    }
                  }}
                  onMouseLeave={() => {
                    setZooming(false);
                    zoomRectRef.current = null;
                  }}
                  onMouseMove={handleMouseMove}
                  style={{
                    position: "relative",
                    width: "100%",
                    aspectRatio: "1/1",
                    cursor: zooming ? "crosshair" : "default",
                    overflow: "visible",
                    zIndex: zooming ? 20 : 1,
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      backgroundColor: "#f3f3f3",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                    }}
                  >
                    {images.length > 0 ? (
                      <>
                        <img
                          src={activeImageSrc}
                          alt={data.title || "Product"}
                          style={{
                            width: "97%",
                            height: "97%",
                            objectFit: "contain",
                            display: "block",
                            pointerEvents: "none",
                          }}
                          onError={(e) => tryProxyFallback(e.target as HTMLImageElement, images[activeImg], handleProxied)}
                        />

                        {zooming && (
                          <div
                            style={{
                              position: "absolute",
                              width: LENS_SIZE,
                              height: LENS_SIZE,
                              left: lensPos.x - LENS_SIZE / 2,
                              top: lensPos.y - LENS_SIZE / 2,
                              border: "1px solid rgba(0,0,0,0.25)",
                              backgroundColor: "rgba(255,255,255,0.25)",
                              boxShadow: "0 0 0 9999px rgba(255,255,255,0.38)",
                              pointerEvents: "none",
                              zIndex: 12,
                            }}
                          />
                        )}
                      </>
                    ) : (
                      <span style={{ color: "#999", fontSize: 14 }}>No images</span>
                    )}

                    {hasMultiple && (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            pauseZoomAfterNav();
                            prev();
                          }}
                          style={{
                            position: "absolute",
                            left: 6,
                            top: "50%",
                            transform: "translateY(-50%)",
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            padding: 0,
                            zIndex: 20,
                          }}
                          aria-label="Previous image"
                        >
                          <ChevronLeft style={{ width: 34, height: 34, color: "#1a1a1a", strokeWidth: 1.25 }} />
                        </button>

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            pauseZoomAfterNav();
                            next();
                          }}
                          style={{
                            position: "absolute",
                            right: 6,
                            top: "50%",
                            transform: "translateY(-50%)",
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            padding: 0,
                            zIndex: 20,
                          }}
                          aria-label="Next image"
                        >
                          <ChevronRight style={{ width: 34, height: 34, color: "#1a1a1a", strokeWidth: 1.25 }} />
                        </button>
                      </>
                    )}
                  </div>

                  {showZoomHint && !zooming && images.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        left: "50%",
                        bottom: 14,
                        transform: "translateX(-50%)",
                        zIndex: 28,
                        pointerEvents: "none",
                        borderRadius: 999,
                        backgroundColor: "#6f727a",
                        color: "#f2f2f2",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10.5,
                        padding: "11px 30px",
                        fontSize: 16,
                        fontWeight: 400,
                        lineHeight: 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span>Hover to zoom</span>
                    </div>
                  )}

                  {zooming && images.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        left: "calc(100% + 14px)",
                        top: 0,
                        width: "min(58vw, 640px)",
                        height: "100%",
                        background: "#f8f8f8",
                        border: "1px solid #d8d8d8",
                        boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
                        zIndex: 15,
                        overflow: "hidden",
                        pointerEvents: "none",
                      }}
                    >
                      <div
                        style={{
                          width: "100%",
                          height: "100%",
                          backgroundImage: `url(${activeImageSrc})`,
                          backgroundSize: `${ZOOM_SCALE * 100}%`,
                          backgroundPosition: `${zoomPos.x}% ${zoomPos.y}%`,
                          backgroundRepeat: "no-repeat",
                        }}
                      />
                    </div>
                  )}
                </div>

                {hasMultiple && (
                  <div style={{ display: "flex", gap: 6, marginTop: 16, flexWrap: "wrap", justifyContent: "center", maxWidth: "100%" }}>
                    {images.map((url, idx) => {
                      // Shrink thumbnails when there are many images so they all fit
                      const thumbSize = images.length > 10 ? 56 : images.length > 7 ? 68 : 86;
                      return (
                        <button
                          key={idx}
                          onClick={() => setActiveImg(idx)}
                          style={{
                            flexShrink: 0,
                            width: thumbSize,
                            height: thumbSize,
                            border: idx === activeImg ? "1px solid #2f2f2f" : "1px solid #d8d8d8",
                            background: "#fff",
                            cursor: "pointer",
                            padding: 1,
                            overflow: "hidden",
                            boxShadow: idx === activeImg ? "0 0 0 1px #2f2f2f inset" : "none",
                          }}
                          aria-label={`Thumbnail ${idx + 1}`}
                        >
                          <img
                            src={proxiedUrls[url] || url}
                            alt={`Thumb ${idx + 1}`}
                            style={{ width: "62%", height: "62%", objectFit: "contain", margin: "auto", display: "block" }}
                            onError={(e) => tryProxyFallback(e.target as HTMLImageElement, url, handleProxied)}
                          />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

                <div style={{ flex: "1 1 470px", maxWidth: 620, minWidth: 0, paddingTop: 1, paddingBottom: 8 }}>
                <h1 style={{ fontSize: 21, fontWeight: 700, lineHeight: 1.28, letterSpacing: -0.1, color: "#404040", margin: "0 0 12px 0" }}>
                  {data.title || data.sku || "Untitled Product"}
                </h1>

                <div style={{ fontSize: 17, color: "#2f2f2f", marginBottom: 8, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                  {productCodeDisplay && <span>Product Code: {productCodeDisplay}</span>}
                  <span style={{ color: "#2a9616", fontWeight: 400, fontSize: 17 }}>In Stock</span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 12, fontSize: 17, color: "#2d2d2d" }}>
                  <span style={{ color: "#ea8b41" }}>4.8</span>
                  <div style={{ display: "flex", gap: 1, color: "#ea8b41", position: "relative", top: 1 }}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star key={n} style={{ width: 17, height: 17, fill: "#ea8b41", color: "#ea8b41", strokeWidth: 1 }} />
                    ))}
                  </div>
                  <span style={{ marginLeft: 1, fontSize: 16, fontWeight: 400, position: "relative", top: 1, lineHeight: 1 }}>
                    493 buyer store reviews
                  </span>
                </div>

                <hr style={{ border: 0, borderTop: "1px solid #7f7f7f", margin: "0 0 12px 0" }} />

                <div style={{ fontSize: 17, color: "#333", marginBottom: 4 }}>Couriered from Australian warehouse</div>
                <div style={{ fontSize: 17, color: "#333", marginBottom: 4 }}>Dispatches within 1-2 days</div>
                <div style={{ fontSize: 17, color: "#333", marginBottom: 10 }}>Australian Standards compliant</div>

                <hr style={{ border: 0, borderTop: "1px solid #7f7f7f", margin: "0 0 12px 0" }} />

                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                  {currentPrice !== null && (
                    <span style={{ fontSize: 26, fontWeight: 700, color: "#2f3137", lineHeight: 1 }}>
                      ${currentPrice.toFixed(0)}
                    </span>
                  )}

                  {originalPrice !== null && (
                    <span
                      style={{
                        fontSize: 26,
                        fontWeight: 700,
                        color: "#ff0f0f",
                        textDecoration: "line-through",
                        textDecorationColor: "#ff8a8a",
                        textDecorationThickness: 1,
                        lineHeight: 1,
                      }}
                    >
                      ${originalPrice.toFixed(0)}
                    </span>
                  )}

                  {savings !== null && savings > 0 && (
                    <span
                      style={{
                        fontSize: 20,
                        fontWeight: 600,
                        color: "#fff",
                        backgroundColor: "#ff0f0f",
                        padding: "6px 14px",
                        lineHeight: 1,
                        display: "inline-block",
                      }}
                    >
                      SALE <span style={{ fontWeight: 500 }}>save</span> ${savings}
                    </span>
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 16 }}>
                  <span style={{ color: "#095bfa", fontSize: 15, lineHeight: 1.4 }}>
                    Ask a question about this product
                  </span>
                  <span style={{ color: "#095bfa", fontSize: 15, lineHeight: 1.4 }}>
                    Inquire about wholesale and trade pricing
                  </span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 16, fontWeight: 400, color: "#222" }}>Quantity:</span>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: "999px",
                      border: "1px solid #acacac",
                      background: "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <ChevronDown style={{ width: 11.5, height: 11.5, color: "#787878", strokeWidth: 1.2 }} />
                  </div>

                  <span
                    style={{
                      width: 44,
                      height: 34,
                      border: "1px solid #c7c7c7",
                      background: "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 15,
                      color: "#444",
                    }}
                  >
                    1
                  </span>

                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: "999px",
                      border: "1px solid #acacac",
                      background: "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <ChevronUp style={{ width: 11.5, height: 11.5, color: "#787878", strokeWidth: 1.2 }} />
                  </div>
                </div>

                <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                  <div
                    style={{
                      flex: "1 1 230px",
                      maxWidth: 350,
                      height: 44,
                      backgroundColor: "#4f5054",
                      border: "1px solid #4f5054",
                      color: "#fff",
                      fontSize: 14,
                      fontWeight: 400,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 1,
                      lineHeight: 1,
                    }}
                  >
                    Add to Cart
                  </div>

                  <div
                    style={{
                      flex: "1 1 215px",
                      height: 44,
                      border: "1px solid #b8b8b8",
                      color: "#666",
                      fontSize: 14,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      borderRadius: 1,
                      backgroundColor: "transparent",
                      lineHeight: 1,
                    }}
                  >
                    Add to Wish List <ChevronDown style={{ width: 16, height: 16, color: "#888", strokeWidth: 1.35 }} />
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 36, marginBottom: 12, flexWrap: "wrap" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, color: "#095bfa", fontSize: 15, fontWeight: 400 }}>
                    <Download style={{ width: 18, height: 18 }} />
                    <span>Download datasheet</span>
                  </span>
                </div>
                </div>
              </div>

              <div style={{ marginTop: 6, paddingBottom: 26 }}>
                <div style={{ borderBottom: "1px solid #dadada", display: "flex", alignItems: "flex-end" }}>
                  <div
                    style={{
                      border: "1px solid #dadada",
                      borderBottom: "none",
                      background: "#f3f3f3",
                      padding: "10px 20px",
                      borderRadius: "2px 2px 0 0",
                      position: "relative",
                      top: 1,
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 16, color: "#2f2f2f" }}>Description</span>
                  </div>
                </div>

                <div style={{ padding: "16px 0 8px 0" }}>
                  {descElements.length > 0 && <div style={{ marginBottom: 10 }}>{descElements}</div>}

                  <div style={{ marginTop: 4 }}>
                    {specRows.map((row, idx) => (
                      <div key={`${row.label}-${idx}`} style={{ marginBottom: 7, fontSize: 15, color: "#2f2f2f", lineHeight: 1.55 }}>
                        <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.2 }}>{row.label}:</span> {row.value || "-"}
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── FILTERS section ── */}
                {(() => {
                  const filterEntries = Object.entries(data.specValues || {})
                    .filter(([, v]) => v && v.trim())
                    .map(([k, v]) => ({ label: formatFilterKeyForDisplay(k), value: formatDimensionFilterValueForCsv(k, v) }));
                  return (
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #dadada" }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: "#2f2f2f", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>
                        Filters:
                      </div>
                      {filterEntries.length === 0 ? (
                        <div style={{ fontSize: 14, color: "#888", fontStyle: "italic" }}>NO FILTERS</div>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
                          {filterEntries.map((f, idx) => (
                            <div key={`filter-${idx}`} style={{ fontSize: 14, color: "#2f2f2f", lineHeight: 1.55 }}>
                              <span style={{ fontWeight: 600 }}>{f.label}:</span>{" "}
                              <span>{f.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
