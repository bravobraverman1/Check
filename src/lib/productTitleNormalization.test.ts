import { describe, expect, it } from "vitest";

import {
  hasNormalizedProductTitleMatch,
  normalizeProductTitleForCompare,
  normalizeProductTitleWhitespace,
} from "@/lib/productTitleNormalization";

describe("productTitleNormalization", () => {
  it("collapses repeated whitespace for storage", () => {
    expect(
      normalizeProductTitleWhitespace("  Lexi 25W   TRIO  Tri-colour  "),
    ).toBe("Lexi 25W TRIO Tri-colour");
  });

  it("normalizes case and whitespace for comparisons", () => {
    expect(
      normalizeProductTitleForCompare("  Lexi 25W   TRIO  Tri-colour  "),
    ).toBe("lexi 25w trio tri-colour");
  });

  it("matches existing titles despite spacing and casing differences", () => {
    expect(
      hasNormalizedProductTitleMatch(
        [
          "Lexi 25W TRIO Tri-colour IP65 Dimmable LED Downlight in White - LL-14-0252",
        ],
        "  lexi 25w   trio tri-colour ip65 dimmable led downlight in white - ll-14-0252  ",
      ),
    ).toBe(true);
  });
});
