import { beforeEach, describe, expect, it } from "vitest";

import { buildAiLogEntry, clearAiTracking, trackAiGenerated } from "@/lib/aiLogging";

describe("aiLogging", () => {
  beforeEach(() => {
    clearAiTracking();
  });

  it("includes conflicts text in the AI log entry", () => {
    trackAiGenerated("aiData", "Generated AI data");

    const entry = buildAiLogEntry("SKU-1", {
      aiData: "Edited AI data",
      aiDescription: "",
      filters: "",
      conflicts: "Mounting: datasheet says recessed, website says surface",
    });

    expect(entry?.conflicts).toBe("Mounting: datasheet says recessed, website says surface");
    expect(entry?.aiData).toEqual({
      generated: "Generated AI data",
      edited: "Edited AI data",
    });
  });
});
