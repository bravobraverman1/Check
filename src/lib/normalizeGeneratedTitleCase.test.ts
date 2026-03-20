import { describe, expect, it } from "vitest";
import { normalizeGeneratedTitleCase } from "@/lib/normalizeGeneratedTitleCase";

describe("normalizeGeneratedTitleCase", () => {
  it("converts all-caps generated titles to readable casing", () => {
    const value = normalizeGeneratedTitleCase("LED DOWNLIGHT WHITE 25W TRI-CCT 2400LM IP65 RECESSED");
    expect(value).toBe("LED Downlight White 25W TRI-CCT 2400LM IP65 Recessed");
  });

  it("keeps mixed-case titles unchanged", () => {
    const value = normalizeGeneratedTitleCase("LED Downlight White 25W Tri-CCT 2400lm IP65 Recessed");
    expect(value).toBe("LED Downlight White 25W Tri-CCT 2400lm IP65 Recessed");
  });

  it("preserves punctuation and acronyms", () => {
    const value = normalizeGeneratedTitleCase("IP65 LED DOWNLIGHT, DALI DIMMABLE");
    expect(value).toBe("IP65 LED Downlight, DALI Dimmable");
  });
});

