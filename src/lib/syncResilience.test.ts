import { beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("sync resilience", () => {
  beforeEach(() => {
    const storageData = new Map<string, string>();
    const storageMock: Storage = {
      get length() {
        return storageData.size;
      },
      clear: () => storageData.clear(),
      getItem: (key: string) => storageData.get(key) ?? null,
      key: (index: number) => Array.from(storageData.keys())[index] ?? null,
      removeItem: (key: string) => {
        storageData.delete(key);
      },
      setItem: (key: string, value: string) => {
        storageData.set(key, String(value));
      },
    };

    vi.resetModules();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("localStorage", storageMock);
    Object.defineProperty(window, "localStorage", {
      value: storageMock,
      configurable: true,
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("keeps last good sheet payload in memory on read failures", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const { readGoogleSheets, invalidateReadCache } = await import("@/lib/supabaseGoogleSheets");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        products: [{ sku: "SKU-1", brand: "Brand A", exampleTitle: "Title A" }],
        categories: [{ name: "Lighting", subcategories: [] }],
        properties: [{ name: "IP Rating", values: [] }],
        legalValues: [{ propertyName: "IP Rating", value: "IP65" }],
      })
    );

    const first = await readGoogleSheets();
    expect(first.products?.[0]?.sku).toBe("SKU-1");

    invalidateReadCache();
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const second = await readGoogleSheets();
    expect(second).toEqual(first);
  });

  it("loads last good sheet payload from localStorage on cold start", async () => {
    localStorage.setItem(
      "ls:last-good-read:v1",
      JSON.stringify({
        ts: Date.now(),
        data: {
          products: [{ sku: "SKU-CACHED", brand: "Cached Brand", exampleTitle: "Cached" }],
          categories: [{ name: "Cached Category", subcategories: [] }],
          properties: [],
          legalValues: [],
        },
      })
    );

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error("timeout"));

    const { readGoogleSheets } = await import("@/lib/supabaseGoogleSheets");
    const result = await readGoogleSheets();

    expect(result.products?.[0]?.sku).toBe("SKU-CACHED");
    expect(result.useDefaults).toBeUndefined();
  });

  it("keeps categories usable through api layer after sync dropout", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const sheets = await import("@/lib/supabaseGoogleSheets");
    const api = await import("@/lib/api");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        categories: [{ name: "Live Categories", subcategories: [] }],
      })
    );
    const first = await api.fetchCategoriesWithSource();
    expect(first.source).toBe("google-sheets");
    expect(first.categories[0]?.name).toBe("Live Categories");

    sheets.invalidateReadCache();
    fetchMock.mockRejectedValueOnce(new Error("sync timeout"));

    const second = await api.fetchCategoriesWithSource();
    expect(second.source).toBe("google-sheets");
    expect(second.categories).toEqual(first.categories);
  });

  it("resolves full brand names for SKU lists from products and brands sheet data", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const api = await import("@/lib/api");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        products: [{ sku: "ASTR1PLEDBLK", brand: "Cougar", exampleTitle: "ASTR1PLEDBLK" }],
        brands: [{ brand: "Cougar", brandName: "Cougar Lighting", website: "https://example.com" }],
        categories: [{ name: "Lighting", subcategories: [] }],
        properties: [],
        legalValues: [],
      }),
    );

    const skus = await api.fetchSkus();
    expect(skus[0]?.brand).toBe("Cougar Lighting");
  });

  it("falls back to sheet data and resolves the full brand name for SKU autofill", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const api = await import("@/lib/api");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: false,
        error: "temporary sheet read issue",
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        products: [{ sku: "ASTR1PLEDBLK", brand: "Cougar", exampleTitle: "ASTR1PLEDBLK", price: "722.00" }],
        brands: [{ brand: "Cougar", brandName: "Cougar Lighting", website: "https://example.com" }],
        categories: [{ name: "Lighting", subcategories: [] }],
        properties: [],
        legalValues: [],
      }),
    );

    const details = await api.fetchSkuSheetDetails("ASTR1PLEDBLK");
    expect(details).toEqual({
      brand: "Cougar Lighting",
      price: "722.00",
      visibility: "",
    });
  });

  it("survives repeated intermittent read dropouts without losing usable sheet data", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const { readGoogleSheets, invalidateReadCache } = await import("@/lib/supabaseGoogleSheets");

    const goodPayload = {
      products: [{ sku: "SKU-STRESS", brand: "Stress Brand", exampleTitle: "Stress Title" }],
      categories: [{ name: "Stress Category", subcategories: [] }],
      properties: [],
      legalValues: [],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(goodPayload));
    const first = await readGoogleSheets();
    expect(first.products?.[0]?.sku).toBe("SKU-STRESS");

    for (let i = 0; i < 15; i++) {
      invalidateReadCache();
      if (i % 4 === 0) {
        fetchMock.mockResolvedValueOnce(jsonResponse(goodPayload));
      } else {
        fetchMock.mockRejectedValueOnce(new Error(`dropout-${i}`));
      }

      const next = await readGoogleSheets();
      expect(next.products?.[0]?.sku).toBe("SKU-STRESS");
      expect(next.useDefaults).toBeUndefined();
    }
  });

  it("preserves the backend submission timestamp when a submit times out but queue confirmation succeeds", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const queuedSubmittedAt = "2026-03-11T12:34:56.789Z";
    const { writeProductToOutputWork } = await import("@/lib/supabaseGoogleSheets");

    fetchMock.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      existsInDock: false,
      pending: true,
      actionable: false,
      latestSubmittedAt: queuedSubmittedAt,
    }));

    const result = await writeProductToOutputWork({
      sku: "SKU-TIMEOUT",
      brand: "Brand A",
      title: "Timeout Recovery Title",
      mainCategory: "Lights/Downlights",
      additionalCategories: [],
      imageUrls: [],
      specifications: {},
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      pending: true,
      reason: "queued-after-timeout-confirmation",
      submittedAtEpochMs: Date.parse(queuedSubmittedAt),
    }));
  });
});
