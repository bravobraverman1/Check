import { describe, expect, it } from "vitest";

import { dedupeEquivalentProductDataAliases } from "../../supabase/functions/_shared/productDataAliasDedup";

describe("dedupeEquivalentProductDataAliases", () => {
  it("removes equivalent alias lines while preserving the first grounded line", () => {
    const result = dedupeEquivalentProductDataAliases([
      "WATTAGE: 25W",
      "LED WATTAGE: 25W",
      "VOLTAGE: 240V",
      "INPUT VOLTAGE: 240V",
      "COLOUR TEMP: 3000K; 4000K; 5700K",
      "CCT: 3000K;4000K;5700K",
    ].join("\n"));

    expect(result.output).toBe([
      "WATTAGE: 25W",
      "VOLTAGE: 240V",
      "COLOUR TEMP: 3000K; 4000K; 5700K",
    ].join("\n"));
    expect(result.removedLineCount).toBe(3);
  });

  it("keeps alias lines when the values are materially different", () => {
    const result = dedupeEquivalentProductDataAliases([
      "WATTAGE: 25W",
      "POWER (W): 30W",
      "VOLTAGE: 240V",
      "INPUT VOLTAGE: 277V",
    ].join("\n"));

    expect(result.output).toBe([
      "WATTAGE: 25W",
      "POWER (W): 30W",
      "VOLTAGE: 240V",
      "INPUT VOLTAGE: 277V",
    ].join("\n"));
    expect(result.removedLineCount).toBe(0);
  });

  it("dedupes APPLICATION against APPLICATIONS when the text is the same", () => {
    const result = dedupeEquivalentProductDataAliases([
      "APPLICATIONS: Suitable for wet areas",
      "APPLICATION: Suitable for wet areas",
    ].join("\n"));

    expect(result.output).toBe("APPLICATIONS: Suitable for wet areas");
    expect(result.removedLineCount).toBe(1);
  });
});
