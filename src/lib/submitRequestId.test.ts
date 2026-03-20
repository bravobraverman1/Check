import { describe, expect, it, vi } from "vitest";

import { createSubmitRequestId, ensureSubmitRequestId, normalizeSubmitRequestId } from "@/lib/submitRequestId";

describe("submitRequestId", () => {
  it("normalizes only valid request ids", () => {
    expect(normalizeSubmitRequestId("submit_1234_abcdef")).toBe("submit_1234_abcdef");
    expect(normalizeSubmitRequestId("  submit:ok-123  ")).toBe("submit:ok-123");
    expect(normalizeSubmitRequestId("bad space")).toBe("");
    expect(normalizeSubmitRequestId("")).toBe("");
  });

  it("creates and preserves stable request ids", () => {
    vi.spyOn(globalThis.Math, "random").mockReturnValue(0.123456789);

    const created = createSubmitRequestId(12345);
    expect(created).toMatch(/^submit_12345_/);

    const payload = ensureSubmitRequestId({ requestId: undefined } as any);
    expect(payload.requestId).toMatch(/^submit_/);

    const preserved = ensureSubmitRequestId({ requestId: "submit_existing-123" } as any);
    expect(preserved.requestId).toBe("submit_existing-123");
  });
});
