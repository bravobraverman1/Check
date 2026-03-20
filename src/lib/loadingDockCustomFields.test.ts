import { describe, expect, it } from "vitest";

import { parseOrderedCustomFieldSpecValues } from "@/lib/loadingDockCustomFields";

describe("parseOrderedCustomFieldSpecValues", () => {
  it("preserves duplicate filter labels in CSV order using #N suffixes", () => {
    expect(
      parseOrderedCustomFieldSpecValues("Colour=BLACK;Colour=WHITE;Material=ALUMINIUM;Material=BRASS"),
    ).toEqual({
      "Colour #1": "BLACK",
      "Colour #2": "WHITE",
      "Material #1": "ALUMINIUM",
      "Material #2": "BRASS",
    });
  });

  it("keeps unique field names unchanged", () => {
    expect(
      parseOrderedCustomFieldSpecValues("Finish=Brass;Mount Type=Ceiling"),
    ).toEqual({
      Finish: "Brass",
      "Mount Type": "Ceiling",
    });
  });
});
