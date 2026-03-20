import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listPendingSubmitRecoveries,
  markPendingSubmitRecoveryAttempt,
  markPendingSubmitRecoveryWarned,
  removePendingSubmitRecovery,
  upsertPendingSubmitRecovery,
} from "@/lib/pendingSubmitRecovery";

function installStorageMock() {
  if (typeof window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: globalThis,
    });
  }

  const store = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    get length() {
      return store.size;
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
}

describe("pendingSubmitRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T10:10:00.000Z"));
    installStorageMock();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and updates a recovery entry by SKU", () => {
    const firstSubmittedAtEpochMs = Date.parse("2026-03-11T10:00:00.000Z");
    const first = upsertPendingSubmitRecovery({
      payload: {
        sku: "SKU-1",
        brand: "Brand A",
        title: "Title A",
        mainCategory: "Lights/Downlights",
        additionalCategories: [],
        imageUrls: ["https://example.com/a.jpg"],
        specifications: { Colour: "WHITE" },
        timestamp: "2026-03-11T10:00:00.000Z",
      },
      submittedAt: "2026-03-11T10:00:00.000Z",
      submittedAtEpochMs: firstSubmittedAtEpochMs,
      isOverwrite: false,
    });
    expect(first?.sku).toBe("SKU-1");

    const secondSubmittedAtEpochMs = Date.parse("2026-03-11T10:05:00.000Z");
    const second = upsertPendingSubmitRecovery({
      payload: {
        sku: "SKU-1",
        brand: "Brand B",
        title: "Title B",
        mainCategory: "Lights/Pendants",
        additionalCategories: [],
        imageUrls: ["https://example.com/b.jpg"],
        specifications: { Colour: "BLACK" },
        timestamp: "2026-03-11T10:05:00.000Z",
      },
      submittedAt: "2026-03-11T10:05:00.000Z",
      submittedAtEpochMs: secondSubmittedAtEpochMs,
      isOverwrite: true,
    });
    expect(second?.isOverwrite).toBe(true);

    const entries = listPendingSubmitRecoveries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sku: "SKU-1",
      isOverwrite: true,
      payload: expect.objectContaining({
        requestId: expect.stringMatching(/^submit_/),
      }),
    });
    expect(entries[0]).toMatchObject({
      payload: expect.objectContaining({
        brand: "Brand B",
        title: "Title B",
      }),
    });
  });

  it("tracks retry attempts and warnings, then removes entries", () => {
    const submittedAtEpochMs = Date.parse("2026-03-11T10:00:00.000Z");
    upsertPendingSubmitRecovery({
      payload: {
        sku: "SKU-2",
        brand: "Brand A",
        title: "Title A",
        mainCategory: "Lights/Downlights",
        additionalCategories: [],
        imageUrls: ["https://example.com/a.jpg"],
        specifications: { Colour: "WHITE" },
        timestamp: "2026-03-11T10:00:00.000Z",
      },
      submittedAt: "2026-03-11T10:00:00.000Z",
      submittedAtEpochMs,
      isOverwrite: false,
    });

    const attemptedAt = submittedAtEpochMs + 90_000;
    const warnedAt = submittedAtEpochMs + 120_000;
    markPendingSubmitRecoveryAttempt("SKU-2", attemptedAt);
    markPendingSubmitRecoveryWarned("SKU-2", warnedAt);

    const entries = listPendingSubmitRecoveries();
    expect(entries).toHaveLength(1);
    expect(entries[0].attemptCount).toBe(2);
    expect(entries[0].lastAttemptAt).toBe(attemptedAt);
    expect(entries[0].warnedAt).toBe(warnedAt);
    expect(entries[0].payload.requestId).toMatch(/^submit_/);

    removePendingSubmitRecovery("SKU-2");
    expect(listPendingSubmitRecoveries()).toEqual([]);
  });
});
