import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  listPendingDockSubmits,
  persistPendingDockSubmit,
  removePendingDockSubmit,
  PENDING_DOCK_SUBMIT_TTL_MS,
} from "@/lib/loadingDockPending";
import { getTabScopedStorageKey } from "@/lib/browserTabScope";

const PENDING_DOCK_SUBMITS_STORAGE_KEY = getTabScopedStorageKey("lightingstyle.pendingDockSubmits");

function ensureStorageApis() {
  const store = new Map<string, string>();
  const storageMock = {
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
    value: storageMock,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: storageMock,
  });
}

describe("loadingDockPending", () => {
  beforeEach(() => {
    ensureStorageApis();
    window.localStorage.removeItem(PENDING_DOCK_SUBMITS_STORAGE_KEY);
    vi.useRealTimers();
  });

  it("persists and deduplicates by SKU", () => {
    persistPendingDockSubmit({
      sku: "LJ1003-WH",
      submittedAt: "2026-03-07T10:00:00.000Z",
      submittedAtEpochMs: Date.parse("2026-03-07T10:00:00.000Z"),
      isOverwrite: false,
    });

    persistPendingDockSubmit({
      sku: "lj1003-wh",
      submittedAt: "2026-03-07T10:01:00.000Z",
      submittedAtEpochMs: Date.parse("2026-03-07T10:01:00.000Z"),
      isOverwrite: true,
    });

    const pending = listPendingDockSubmits();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      sku: "lj1003-wh",
      submittedAt: "2026-03-07T10:01:00.000Z",
      isOverwrite: true,
    });
  });

  it("removes expired entries when listing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00.000Z"));

    persistPendingDockSubmit({
      sku: "EXPIRES-SOON",
      submittedAt: "2026-03-07T10:00:00.000Z",
      submittedAtEpochMs: Date.parse("2026-03-07T10:00:00.000Z"),
    });

    vi.advanceTimersByTime(PENDING_DOCK_SUBMIT_TTL_MS + 1);

    expect(listPendingDockSubmits()).toEqual([]);
    expect(window.localStorage.getItem(PENDING_DOCK_SUBMITS_STORAGE_KEY)).toBeNull();
  });

  it("removes a stored SKU explicitly", () => {
    persistPendingDockSubmit({
      sku: "KEEP-ME",
      submittedAt: "2026-03-07T10:00:00.000Z",
      submittedAtEpochMs: Date.parse("2026-03-07T10:00:00.000Z"),
    });
    persistPendingDockSubmit({
      sku: "REMOVE-ME",
      submittedAt: "2026-03-07T10:05:00.000Z",
      submittedAtEpochMs: Date.parse("2026-03-07T10:05:00.000Z"),
    });

    removePendingDockSubmit("remove-me");

    expect(listPendingDockSubmits()).toEqual([
      expect.objectContaining({
        sku: "KEEP-ME",
      }),
    ]);
  });
});
