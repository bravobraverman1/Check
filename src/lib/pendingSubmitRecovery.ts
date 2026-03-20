import type { ProductPayload } from "@/lib/api";
import { getTabScopedStorageKey } from "@/lib/browserTabScope";
import { ensureSubmitRequestId } from "@/lib/submitRequestId";

const PENDING_SUBMIT_RECOVERY_KEY = "lightingstyle.pendingSubmitRecoveries";

function getPendingSubmitRecoveryStorageKey(): string {
  return getTabScopedStorageKey(PENDING_SUBMIT_RECOVERY_KEY);
}

export const PENDING_SUBMIT_RECOVERY_RETRY_INTERVAL_MS = 15_000;
export const PENDING_SUBMIT_RECOVERY_FIRST_RETRY_DELAY_MS = 20_000;
export const PENDING_SUBMIT_RECOVERY_WARN_AFTER_MS = 2 * 60_000;
export const PENDING_SUBMIT_RECOVERY_TTL_MS = 30 * 60_000;
/** Hard cap on automatic retry attempts — after this many, the entry is abandoned. */
export const PENDING_SUBMIT_RECOVERY_MAX_ATTEMPTS = 5;

export interface PendingSubmitRecoveryEntry {
  sku: string;
  payload: ProductPayload;
  submittedAt: string;
  submittedAtEpochMs: number;
  isOverwrite: boolean;
  lastAttemptAt: number;
  attemptCount: number;
  warnedAt: number | null;
  expiresAt: number;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeEntry(raw: unknown, now = Date.now()): PendingSubmitRecoveryEntry | null {
  if (!isRecord(raw)) return null;

  const sku = typeof raw.sku === "string" ? raw.sku.trim() : "";
  const payload = isRecord(raw.payload)
    ? (ensureSubmitRequestId(raw.payload as unknown as ProductPayload) as ProductPayload)
    : null;
  const submittedAt = typeof raw.submittedAt === "string" ? raw.submittedAt.trim() : "";
  const submittedAtEpochMs = Number(raw.submittedAtEpochMs);
  const lastAttemptAt = Number(raw.lastAttemptAt);
  const attemptCount = Number(raw.attemptCount);
  const warnedAtRaw = raw.warnedAt;
  const warnedAt =
    warnedAtRaw == null ? null : Number.isFinite(Number(warnedAtRaw)) ? Number(warnedAtRaw) : null;
  const expiresAt = Number(raw.expiresAt);
  const isOverwrite = raw.isOverwrite === true;

  if (!sku || !payload || typeof payload.sku !== "string" || payload.sku.trim() === "") return null;
  if (!submittedAt || !Number.isFinite(submittedAtEpochMs) || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= now) return null;

  return {
    sku,
    payload,
    submittedAt,
    submittedAtEpochMs,
    isOverwrite,
    lastAttemptAt: Number.isFinite(lastAttemptAt) ? lastAttemptAt : 0,
    attemptCount: Number.isFinite(attemptCount) ? attemptCount : 0,
    warnedAt,
    expiresAt,
  };
}

function readStoredPendingSubmitRecoveries(now = Date.now()): PendingSubmitRecoveryEntry[] {
  if (!canUseStorage()) return [];

  try {
    const raw = window.localStorage.getItem(getPendingSubmitRecoveryStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => sanitizeEntry(entry, now))
      .filter((entry): entry is PendingSubmitRecoveryEntry => Boolean(entry));
  } catch {
    return [];
  }
}

function writeStoredPendingSubmitRecoveries(entries: PendingSubmitRecoveryEntry[]): void {
  if (!canUseStorage()) return;

  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(getPendingSubmitRecoveryStorageKey());
      return;
    }
    window.localStorage.setItem(getPendingSubmitRecoveryStorageKey(), JSON.stringify(entries));
  } catch {
    // Non-fatal.
  }
}

export function listPendingSubmitRecoveries(now = Date.now()): PendingSubmitRecoveryEntry[] {
  const entries = readStoredPendingSubmitRecoveries(now);
  writeStoredPendingSubmitRecoveries(entries);
  return entries;
}

export function upsertPendingSubmitRecovery(input: {
  payload: ProductPayload;
  submittedAt?: string;
  submittedAtEpochMs?: number;
  isOverwrite?: boolean;
  expiresAt?: number;
}): PendingSubmitRecoveryEntry | null {
  const sku = input.payload.sku.trim();
  if (!sku) return null;

  const submittedAtEpochMs = Number.isFinite(input.submittedAtEpochMs)
    ? Number(input.submittedAtEpochMs)
    : Date.now();
  const submittedAt = input.submittedAt?.trim() || new Date(submittedAtEpochMs).toISOString();
  const entry: PendingSubmitRecoveryEntry = {
    sku,
    payload: ensureSubmitRequestId({ ...input.payload, sku }) as ProductPayload,
    submittedAt,
    submittedAtEpochMs,
    isOverwrite: input.isOverwrite === true,
    lastAttemptAt: submittedAtEpochMs,
    attemptCount: 1,
    warnedAt: null,
    expiresAt: input.expiresAt ?? submittedAtEpochMs + PENDING_SUBMIT_RECOVERY_TTL_MS,
  };

  const bySku = new Map<string, PendingSubmitRecoveryEntry>();
  for (const existing of listPendingSubmitRecoveries()) {
    bySku.set(existing.sku.trim().toUpperCase(), existing);
  }
  bySku.set(sku.toUpperCase(), entry);
  writeStoredPendingSubmitRecoveries(Array.from(bySku.values()));
  return entry;
}

export function removePendingSubmitRecovery(sku: string): void {
  const normalizedSku = sku.trim().toUpperCase();
  if (!normalizedSku) return;

  const next = listPendingSubmitRecoveries().filter((entry) => entry.sku.trim().toUpperCase() !== normalizedSku);
  writeStoredPendingSubmitRecoveries(next);
}

export function markPendingSubmitRecoveryAttempt(sku: string, attemptedAt = Date.now()): void {
  const normalizedSku = sku.trim().toUpperCase();
  if (!normalizedSku) return;

  const next = listPendingSubmitRecoveries().map((entry) => {
    if (entry.sku.trim().toUpperCase() !== normalizedSku) return entry;
    return {
      ...entry,
      lastAttemptAt: attemptedAt,
      attemptCount: entry.attemptCount + 1,
    };
  });
  writeStoredPendingSubmitRecoveries(next);
}

export function markPendingSubmitRecoveryWarned(sku: string, warnedAt = Date.now()): void {
  const normalizedSku = sku.trim().toUpperCase();
  if (!normalizedSku) return;

  const next = listPendingSubmitRecoveries().map((entry) => {
    if (entry.sku.trim().toUpperCase() !== normalizedSku) return entry;
    return {
      ...entry,
      warnedAt,
    };
  });
  writeStoredPendingSubmitRecoveries(next);
}
