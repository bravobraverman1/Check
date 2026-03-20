import { describe, expect, it } from "vitest";
import {
  extractGeminiLeadingText,
  hasGeminiSectionHeaders,
  parseFilterProposals,
  parseGeminiSections,
} from "@/lib/parseGeminiSections";

describe("parseGeminiSections", () => {
  it("normalizes section header variants", () => {
    const raw = `
=== PRODUCT DATA ===
A: B
=== FILTER PROPOSALS ===
Colour|White|92%
=== CONFLICT ===
NONE
`;

    const sections = parseGeminiSections(raw);

    expect(sections.PRODUCT_DATA).toContain("A: B");
    expect(sections.FILTERS_PROPOSAL).toContain("Colour|White|92%");
    expect(sections.CONFLICTS).toContain("NONE");
  });

  it("extracts plain leading field output before trailing sections", () => {
    const raw = `
COLOUR: White
MATERIAL: Aluminium

=== FILTERS_PROPOSAL ===
Colour | White | 100%
`;

    expect(hasGeminiSectionHeaders(raw)).toBe(true);
    expect(extractGeminiLeadingText(raw)).toContain("COLOUR: White");
    expect(extractGeminiLeadingText(raw)).toContain("MATERIAL: Aluminium");
    expect(parseGeminiSections(raw).FILTERS_PROPOSAL).toContain("Colour | White | 100%");
  });
});

describe("parseFilterProposals", () => {
  it("parses mixed confidence formats", () => {
    const raw = `
Colour Temp | 3000K | 92%
| Beam Angle | 36° | 0.74 |
Filter=Cutout; Value=69mm; Confidence=92 out of 100
`;

    const proposals = parseFilterProposals(raw);

    expect(proposals).toHaveLength(3);
    expect(proposals[0]).toEqual({ filterName: "Colour Temp", value: "3000K", confidence: 92 });
    expect(proposals[1]).toEqual({ filterName: "Beam Angle", value: "36°", confidence: 74 });
    expect(proposals[2]).toEqual({ filterName: "Cutout", value: "69mm", confidence: 92 });
  });

  it("parses labeled fields and ignores markdown header rows", () => {
    const raw = `
| Filter | Value | Confidence |
Filter: IP Rating | Value: IP65 | Confidence: High (90%)
`;

    const proposals = parseFilterProposals(raw);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toEqual({ filterName: "IP Rating", value: "IP65", confidence: 90 });
  });

  it("returns empty array for NONE", () => {
    expect(parseFilterProposals("NONE")).toEqual([]);
  });
});
