import { describe, it, expect } from "vitest";
import {
  formatDimensionEntriesInSemicolonListForCsv,
  formatDimensionFilterValueForCsv,
  normalizeDimensionFilterValueForStorage,
} from "./filterDimensionFormatting";

describe("filterDimensionFormatting", () => {
  it("normalizes diameter values for storage", () => {
    expect(normalizeDimensionFilterValueForStorage("Fan Cutout", "29")).toBe("29");
    expect(normalizeDimensionFilterValueForStorage("Fan Cutout", "29cm (DIAMETER)")).toBe("29");
    expect(normalizeDimensionFilterValueForStorage("Fan Cutout (cm)", "29 cm")).toBe("29");
  });

  it("normalizes WxH values for storage", () => {
    expect(normalizeDimensionFilterValueForStorage("Fan Cutout", "12X34")).toBe("12X34");
    expect(normalizeDimensionFilterValueForStorage("Fan Cutout", "12x34")).toBe("12X34");
    expect(normalizeDimensionFilterValueForStorage("Fan Cutout", "12cm x 34cm")).toBe("12X34");
    expect(normalizeDimensionFilterValueForStorage("Fan Cutout", "12 cm × 34 cm")).toBe("12X34");
  });

  it("formats diameter values for CSV", () => {
    expect(formatDimensionFilterValueForCsv("Fan Cutout", "29")).toBe("29cm (DIAMETER)");
  });

  it("formats WxH values for CSV", () => {
    expect(formatDimensionFilterValueForCsv("Fan Cutout", "12X34")).toBe("12cm x 34cm");
    expect(formatDimensionFilterValueForCsv("Fan Cutout", "12cm x 34cm")).toBe("12cm x 34cm");
  });

  it("normalizes air movement values for storage", () => {
    expect(normalizeDimensionFilterValueForStorage("Air Movement", "22")).toBe("22");
    expect(normalizeDimensionFilterValueForStorage("Air Movement", "22m³/h")).toBe("22");
    expect(normalizeDimensionFilterValueForStorage("Air Movement (m³/h)", "22 m3/h")).toBe("22");
  });

  it("formats air movement values for CSV", () => {
    expect(formatDimensionFilterValueForCsv("Air Movement", "22")).toBe("22m³/h");
    expect(formatDimensionFilterValueForCsv("Air Movement", "22m3/h")).toBe("22m³/h");
    expect(formatDimensionFilterValueForCsv("Air Movement (m³/h)", "22 m³/h")).toBe("22m³/h");
  });

  it("leaves non-dimension filters unchanged", () => {
    expect(normalizeDimensionFilterValueForStorage("Colour", "12X34")).toBe("12X34");
    expect(formatDimensionFilterValueForCsv("Colour", "29")).toBe("29");
  });

  it("formats special filter entries inside semicolon lists for CSV", () => {
    expect(formatDimensionEntriesInSemicolonListForCsv("Fan Cutout=29;Colour=White")).toBe(
      "Fan Cutout=29cm (DIAMETER);Colour=White",
    );
    expect(formatDimensionEntriesInSemicolonListForCsv("Fan Cutout=12X34;Air Movement=22")).toBe(
      "Fan Cutout=12cm x 34cm;Air Movement=22m³/h",
    );
  });
});
