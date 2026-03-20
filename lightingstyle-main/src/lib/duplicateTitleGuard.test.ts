import { describe, expect, it } from "vitest";

import {
  createDuplicateTitleSubmitError,
  findDuplicateTitleInfo,
  isDuplicateTitleSubmitError,
} from "@/lib/duplicateTitleGuard";

describe("duplicateTitleGuard", () => {
  it("detects ExistingProds/NewNames duplicates", () => {
    expect(
      findDuplicateTitleInfo({
        title: "Marine Grade Aluminium Spike Light",
        currentSku: "SKU-1",
        existingTitles: ["Marine Grade Aluminium Spike Light"],
        loadingDockTitles: [],
      }),
    ).toEqual({
      title: "Marine Grade Aluminium Spike Light",
      sources: ["ExistingProds/NewNames"],
    });
  });

  it("builds a duplicate-title submit error that can be recognized later", () => {
    const error = createDuplicateTitleSubmitError({
      title: "Marine Grade Aluminium Spike Light",
      sources: ["ExistingProds/NewNames"],
    });

    expect(isDuplicateTitleSubmitError(error)).toBe(true);
    expect(error.code).toBe("DUPLICATE_TITLE");
    expect(error.duplicateTitleSources).toEqual(["ExistingProds/NewNames"]);
  });
});
