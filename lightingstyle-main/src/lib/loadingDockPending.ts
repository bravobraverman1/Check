import { getTabScopedStorageKey } from "@/lib/browserTabScope";

const PENDING_DOCK_SUBMITS_KEY = "lightingstyle.pendingDockSubmits";

function getPendingDockSubmitsStorageKey(): string {
  return getTabScopedStorageKey(PENDING_DOCK_SUBMITS_KEY);
}

export const PENDING_DOCK_SUBMIT_TTL_MS = 15 * 60_000;

export interface PendingDockSubmit {
  sku: string;
  submittedAt: string;
  submittedAtEpochMs: number;
  isOverwrite: boolean;
  expiresAt: number;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readStoredPendingDockSubmits(): PendingDockSubmit[] {
  if (!canUseStorage()) return [];

  try {
    const raw = window.localStorage.getItem(getPendingDockSubmitsStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((entry): entry is PendingDockSubmit => {
      if (!entry || typeof entry !== "object") return false;
      const sku = typeof entry.sku === "string" ? entry.sku.trim() : "";
      return (
        Boolean(sku) &&
        typeof entry.submittedAt === "string" &&
        Number.isFinite(entry.submittedAtEpochMs) &&
        typeof entry.isOverwrite === "boolean" &&
        Number.isFinite(entry.expiresAt)
      );
    });
  } catch {
    return [];
  }
}

function writeStoredPendingDockSubmits(entries: PendingDockSubmit[]): void {
  if (!canUseStorage()) return;

  try {
      if (entries.length === 0) {
      window.localStorage.removeItem(getPendingDockSubmitsStorageKey());
      return;
    }
    window.localStorage.setItem(getPendingDockSubmitsStorageKey(), JSON.stringify(entries));
  } catch {
    // Non-fatal: keep in-memory behavior even if storage is unavailable.
  }
}

export function listPendingDockSubmits(now = Date.now()): PendingDockSubmit[] {
  const freshEntries = readStoredPendingDockSubmits().filter(
    (entry) => entry.expiresAt > now && entry.sku.trim().length > 0,
  );
  writeStoredPendingDockSubmits(freshEntries);
  return freshEntries;
}

export function persistPendingDockSubmit(input: {
  sku: string;
  submittedAt?: string;
  submittedAtEpochMs?: number;
  isOverwrite?: boolean;
  expiresAt?: number;
}): PendingDockSubmit | null {
  const sku = input.sku.trim();
  if (!sku) return null;

  const submittedAtEpochMs = Number.isFinite(input.submittedAtEpochMs)
    ? Number(input.submittedAtEpochMs)
    : Date.now();
  const entry: PendingDockSubmit = {
    sku,
    submittedAt: input.submittedAt?.trim() || new Date(submittedAtEpochMs).toISOString(),
    submittedAtEpochMs,
    isOverwrite: input.isOverwrite === true,
    expiresAt: input.expiresAt ?? Date.now() + PENDING_DOCK_SUBMIT_TTL_MS,
  };

  const bySku = new Map<string, PendingDockSubmit>();
  for (const pending of listPendingDockSubmits()) {
    bySku.set(pending.sku.trim().toUpperCase(), pending);
  }
  bySku.set(sku.toUpperCase(), entry);
  writeStoredPendingDockSubmits(Array.from(bySku.values()));
  return entry;
}

export function removePendingDockSubmit(sku: string): void {
  const normalizedSku = sku.trim().toUpperCase();
  if (!normalizedSku) return;

  const nextEntries = listPendingDockSubmits().filter((entry) => entry.sku.trim().toUpperCase() !== normalizedSku);
  writeStoredPendingDockSubmits(nextEntries);
}
