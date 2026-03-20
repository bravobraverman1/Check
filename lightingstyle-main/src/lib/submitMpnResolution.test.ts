import { describe, expect, it } from "vitest";

import { decideSubmitMpn, extractNumericMpnFromValue } from "@/lib/submitMpnResolution";

describe("submitMpnResolution", () => {
  it("reuses the existing dock MPN for overrides", () => {
    expect(
      decideSubmitMpn({
        isOverwrite: true,
        existingMpnRaw: "57371",
        sku: "10225--DOM",
      }),
    ).toEqual({ kind: "reuse-existing", mpn: 57371 });
  });

  it("fails an override instead of reserving a new MPN when the existing MPN is missing", () => {
    expect(
      decideSubmitMpn({
        isOverwrite: true,
        existingMpnRaw: "",
        sku: "10225--DOM",
      }),
    ).toEqual({
      kind: "error",
      error: 'Override could not read the existing MPN for SKU "10225--DOM" from the backend.',
    });
  });

  it("only reserves a new MPN for non-overwrite submits", () => {
    expect(
      decideSubmitMpn({
        isOverwrite: false,
        existingMpnRaw: "57371",
        sku: "ELHK2507AS",
      }),
    ).toEqual({ kind: "reserve-new" });
  });

  it("parses positive numeric MPNs and rejects invalid values", () => {
    expect(extractNumericMpnFromValue(" 57370 ")).toBe(57370);
    expect(extractNumericMpnFromValue("0")).toBeNull();
    expect(extractNumericMpnFromValue("ABC")).toBeNull();
  });
});
