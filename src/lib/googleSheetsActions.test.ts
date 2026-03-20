import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgeAuth", () => ({
  buildEdgeRequestHeaders: vi.fn(async () => ({ "Content-Type": "application/json" })),
  getEdgeAuthTroubleshootingMessage: vi.fn(() => ""),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      })),
      startAutoRefresh: vi.fn(),
      stopAutoRefresh: vi.fn(),
    },
  },
}));

import { GOOGLE_SHEETS_ACTIONS, normalizeGoogleSheetsAction } from "./googleSheetsActions";
import { invokeGoogleSheetsFunction } from "./supabaseGoogleSheets";

describe("googleSheetsActions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes canonical and legacy action names to the supported action set", () => {
    expect(normalizeGoogleSheetsAction("fetch-dock-entries")).toBe("fetch-dock-entries");
    expect(normalizeGoogleSheetsAction(" fetch-dock ")).toBe("fetch-dock-entries");
    expect(normalizeGoogleSheetsAction("persist-dock-pending")).toBe("upsert-dock-pending");
    expect(normalizeGoogleSheetsAction("delete-dock-pending")).toBe("remove-dock-pending");
    expect(normalizeGoogleSheetsAction("unknown-action")).toBeNull();
    expect(GOOGLE_SHEETS_ACTIONS).toContain("remove-dock-pending");
  });

  it("rejects an invalid action before the edge request is sent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await invokeGoogleSheetsFunction({
      action: "definitely-not-real",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain("Invalid google-sheets action");
  });

  it("sends the canonical action when a supported legacy alias is used", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await invokeGoogleSheetsFunction({
      action: "fetch-dock",
      tabNames: {},
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init && typeof init === "object" ? String((init as RequestInit).body ?? "") : "").toContain(
      '"action":"fetch-dock-entries"',
    );
  });
});
