import { describe, expect, it } from "vitest";
import {
  extractProductDataSectionFromGenerateResponse,
} from "./twoPdfPostProcess";

describe("twoPdfPostProcess", () => {
  it("extracts the product-data section from a generate-style response", () => {
    const extracted = extractProductDataSectionFromGenerateResponse({
      result: [
        "===PRODUCT_DATA===",
        "IP RATING: IP65",
        "",
        "===CONFLICTS===",
        "- NONE",
      ].join("\n"),
    });

    expect(extracted).toBe("IP RATING: IP65");
  });
});
