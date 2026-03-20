import { describe, expect, it } from "vitest";

import {
  isComparePlaceholderValue,
  normalizeComparisonRows,
} from "@/lib/pdfCompareNormalization";

describe("pdfCompareNormalization", () => {
  it("prefers real compare values over placeholder aliases", () => {
    const rows = normalizeComparisonRows([
      {
        field: "MATERIAL (ADDED)",
        supplier: "MISSING***",
        supplier_value: "ALUMINIUM",
        ls: "ALUMINIUM",
      },
    ]);

    expect(rows).toEqual([
      {
        field: "MATERIAL",
        supplier: "ALUMINIUM",
        ls: "ALUMINIUM",
      },
    ]);
  });

  it("merges complementary duplicate rows for the same field", () => {
    const rows = normalizeComparisonRows([
      {
        field: "COLOUR (ADDED)",
        supplier: "MISSING***",
        ls: "WHITE",
      },
      {
        field: "COLOUR",
        supplier_value: "WHITE",
        ls: "WHITE",
      },
    ]);

    expect(rows).toEqual([
      {
        field: "COLOUR",
        supplier: "WHITE",
        ls: "WHITE",
      },
    ]);
  });

  it("treats MISSING*** markers as placeholders", () => {
    expect(isComparePlaceholderValue("MISSING***")).toBe(true);
    expect(isComparePlaceholderValue("MISSING*** (not found)")).toBe(true);
    expect(isComparePlaceholderValue("ALUMINIUM")).toBe(false);
  });
});
