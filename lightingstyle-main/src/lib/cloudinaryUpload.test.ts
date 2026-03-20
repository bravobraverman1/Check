import { describe, it, expect } from "vitest";

/**
 * Test the format acceptance logic from cloudinaryUpload.ts
 * We replicate the classification logic since ensureAcceptedBlob is not exported.
 */

const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type AcceptResult = "accepted" | "heic-convert" | "canvas-fallback";

function classifyFile(name: string, type: string): AcceptResult {
  if (ACCEPTED_TYPES.has(type)) return "accepted";
  if (/\.(heic|heif)$/i.test(name) || type === "image/heic" || type === "image/heif") {
    return "heic-convert";
  }
  return "canvas-fallback";
}

describe("cloudinaryUpload format detection", () => {
  // Standard web formats — accepted directly (no conversion needed)
  it.each([
    ["photo.jpg", "image/jpeg"],
    ["photo.png", "image/png"],
    ["photo.gif", "image/gif"],
    ["photo.webp", "image/webp"],
  ])("accepts %s (%s) directly", (name, type) => {
    expect(classifyFile(name, type)).toBe("accepted");
  });

  // HEIC/HEIF — converted client-side via heic-to library
  it.each([
    ["IMG_4198.HEIC", "image/heic"],
    ["IMG_4198.HEIC", ""],
    ["IMG_4198.heif", "image/heif"],
    ["IMG_4198.heif", ""],
    ["photo.HEIC", "application/octet-stream"],
  ])("converts %s (%s) via heic-to", (name, type) => {
    expect(classifyFile(name, type)).toBe("heic-convert");
  });

  // Other formats — converted via canvas fallback (TIFF, BMP, AVIF, SVG)
  it.each([
    ["scan.tif", "image/tiff"],
    ["scan.tiff", "image/tiff"],
    ["icon.bmp", "image/bmp"],
    ["photo.avif", "image/avif"],
    ["logo.svg", "image/svg+xml"],
  ])("converts %s via canvas fallback", (name, type) => {
    expect(classifyFile(name, type)).toBe("canvas-fallback");
  });

  // Truly unknown formats also go to canvas (which will throw if unsupported)
  it("unknown formats fall to canvas fallback", () => {
    expect(classifyFile("file.xyz", "application/octet-stream")).toBe("canvas-fallback");
    expect(classifyFile("file.psd", "image/vnd.adobe.photoshop")).toBe("canvas-fallback");
  });
});
