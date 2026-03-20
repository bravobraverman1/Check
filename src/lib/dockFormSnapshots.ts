import { getTabScopedStorageKey } from "@/lib/browserTabScope";

const STORAGE_KEY = "lightingstyle.dockFormSnapshots.v1";
const MAX_SNAPSHOTS = 40;

function getDockFormSnapshotsStorageKey(): string {
  return getTabScopedStorageKey(STORAGE_KEY);
}

export interface DockFormSnapshotComparable {
  sku: string;
  gpsMpn?: string;
  brand?: string;
  price?: string;
  title?: string;
  mainCategory?: string;
  selectedCategories?: string[];
  imageUrls?: string[];
  chatgptData?: string;
  chatgptDescription?: string;
  emailNotes?: string;
}

export interface DockFormSnapshot extends DockFormSnapshotComparable {
  heldDockSku?: string;
  datasheetUrl?: string;
  webpageUrl?: string;
  specValues?: Record<string, string>;
  otherValues?: Record<string, string>;
  additionalInstructions?: string;
  additionalInstructionsData?: string;
  loadedDockSubmissionEpochMs?: number;
  loadedDockSubmissionSku?: string;
  submittedAtEpochMs?: number;
  submittedAtSource?: "client" | "backend";
  savedAtEpochMs: number;
  fingerprint: string;
}

export interface DockFormSnapshotFiles {
  datasheetFile: File | null;
  websitePdfFile: File | null;
}

const fileSnapshotStore = new Map<string, DockFormSnapshotFiles>();

function normalizeSku(sku: string): string {
  return String(sku ?? "").trim().toUpperCase();
}

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeString(value))
    .filter(Boolean);
}

function normalizeRecord(values: unknown): Record<string, string> {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    const normalizedKey = normalizeString(key);
    const normalizedValue = normalizeString(value);
    if (!normalizedKey || !normalizedValue) continue;
    out[normalizedKey] = normalizedValue;
  }
  return out;
}

function readSnapshots(): DockFormSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(getDockFormSnapshotsStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => sanitizeDockFormSnapshot(entry))
      .filter((entry): entry is DockFormSnapshot => entry !== null);
  } catch {
    return [];
  }
}

function writeSnapshots(snapshots: DockFormSnapshot[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(getDockFormSnapshotsStorageKey(), JSON.stringify(snapshots));
  } catch {
    // Ignore storage failures.
  }
}

export function sanitizeDockFormSnapshot(value: unknown): DockFormSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sku = normalizeSku(record.sku as string);
  if (!sku) return null;
  const savedAtEpochMs = Number(record.savedAtEpochMs);
  const fingerprint = normalizeString(record.fingerprint);
  if (!Number.isFinite(savedAtEpochMs) || savedAtEpochMs <= 0 || !fingerprint) return null;

  return {
    sku,
    gpsMpn: normalizeString(record.gpsMpn),
    brand: normalizeString(record.brand),
    price: normalizeString(record.price),
    title: normalizeString(record.title),
    heldDockSku: normalizeString(record.heldDockSku),
    mainCategory: normalizeString(record.mainCategory),
    selectedCategories: normalizeStringArray(record.selectedCategories),
    imageUrls: normalizeStringArray(record.imageUrls),
    chatgptData: normalizeString(record.chatgptData),
    chatgptDescription: normalizeString(record.chatgptDescription),
    emailNotes: normalizeString(record.emailNotes),
    datasheetUrl: normalizeString(record.datasheetUrl),
    webpageUrl: normalizeString(record.webpageUrl),
    specValues: normalizeRecord(record.specValues),
    otherValues: normalizeRecord(record.otherValues),
    additionalInstructions: normalizeString(record.additionalInstructions),
    additionalInstructionsData: normalizeString(record.additionalInstructionsData),
    loadedDockSubmissionEpochMs:
      Number.isFinite(Number(record.loadedDockSubmissionEpochMs)) && Number(record.loadedDockSubmissionEpochMs) > 0
        ? Number(record.loadedDockSubmissionEpochMs)
        : undefined,
    loadedDockSubmissionSku: normalizeString(record.loadedDockSubmissionSku),
    submittedAtEpochMs: Number.isFinite(Number(record.submittedAtEpochMs)) ? Number(record.submittedAtEpochMs) : undefined,
    submittedAtSource:
      record.submittedAtSource === "backend" || record.submittedAtSource === "client"
        ? record.submittedAtSource
        : undefined,
    savedAtEpochMs,
    fingerprint,
  };
}

export function buildDockFormSnapshotFingerprint(value: DockFormSnapshotComparable): string {
  return JSON.stringify({
    sku: normalizeSku(value.sku),
    gpsMpn: normalizeString(value.gpsMpn),
    brand: normalizeString(value.brand),
    title: normalizeString(value.title),
    mainCategory: normalizeString(value.mainCategory),
    selectedCategories: normalizeStringArray(value.selectedCategories),
  });
}

export function upsertDockFormSnapshot(
  snapshot: Omit<DockFormSnapshot, "savedAtEpochMs" | "fingerprint">,
  files?: Partial<DockFormSnapshotFiles>,
): DockFormSnapshot | null {
  const normalizedSku = normalizeSku(snapshot.sku);
  if (!normalizedSku) return null;

  const nextEntry: DockFormSnapshot = {
    ...snapshot,
    sku: normalizedSku,
    gpsMpn: normalizeString(snapshot.gpsMpn),
    brand: normalizeString(snapshot.brand),
    price: normalizeString(snapshot.price),
    title: normalizeString(snapshot.title),
    heldDockSku: normalizeString(snapshot.heldDockSku),
    mainCategory: normalizeString(snapshot.mainCategory),
    selectedCategories: normalizeStringArray(snapshot.selectedCategories),
    imageUrls: normalizeStringArray(snapshot.imageUrls),
    chatgptData: normalizeString(snapshot.chatgptData),
    chatgptDescription: normalizeString(snapshot.chatgptDescription),
    emailNotes: normalizeString(snapshot.emailNotes),
    datasheetUrl: normalizeString(snapshot.datasheetUrl),
    webpageUrl: normalizeString(snapshot.webpageUrl),
    specValues: normalizeRecord(snapshot.specValues),
    otherValues: normalizeRecord(snapshot.otherValues),
    additionalInstructions: normalizeString(snapshot.additionalInstructions),
    additionalInstructionsData: normalizeString(snapshot.additionalInstructionsData),
    loadedDockSubmissionEpochMs:
      Number.isFinite(Number(snapshot.loadedDockSubmissionEpochMs)) && Number(snapshot.loadedDockSubmissionEpochMs) > 0
        ? Number(snapshot.loadedDockSubmissionEpochMs)
        : undefined,
    loadedDockSubmissionSku: normalizeString(snapshot.loadedDockSubmissionSku),
    submittedAtEpochMs:
      Number.isFinite(Number(snapshot.submittedAtEpochMs)) && Number(snapshot.submittedAtEpochMs) > 0
        ? Number(snapshot.submittedAtEpochMs)
        : undefined,
    submittedAtSource:
      snapshot.submittedAtSource === "backend" || snapshot.submittedAtSource === "client"
        ? snapshot.submittedAtSource
        : undefined,
    savedAtEpochMs: Date.now(),
    fingerprint: buildDockFormSnapshotFingerprint(snapshot),
  };

  const existing = readSnapshots().filter((entry) => entry.sku !== normalizedSku);
  const nextSnapshots = [nextEntry, ...existing]
    .sort((a, b) => b.savedAtEpochMs - a.savedAtEpochMs)
    .slice(0, MAX_SNAPSHOTS);
  writeSnapshots(nextSnapshots);

  if (!nextSnapshots.some((entry) => entry.sku === normalizedSku)) {
    fileSnapshotStore.delete(normalizedSku);
    return nextEntry;
  }

  if (files) {
    fileSnapshotStore.set(normalizedSku, {
      datasheetFile: files.datasheetFile ?? null,
      websitePdfFile: files.websitePdfFile ?? null,
    });
  }

  const activeSkus = new Set(nextSnapshots.map((entry) => entry.sku));
  for (const sku of Array.from(fileSnapshotStore.keys())) {
    if (!activeSkus.has(sku)) fileSnapshotStore.delete(sku);
  }

  return nextEntry;
}

export function getDockFormSnapshot(sku: string): DockFormSnapshot | null {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return null;
  return readSnapshots().find((entry) => entry.sku === normalizedSku) ?? null;
}

export function getDockFormSnapshotFiles(sku: string): DockFormSnapshotFiles | null {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return null;
  return fileSnapshotStore.get(normalizedSku) ?? null;
}

export function removeDockFormSnapshot(sku: string): void {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return;

  const nextSnapshots = readSnapshots().filter((entry) => entry.sku !== normalizedSku);
  writeSnapshots(nextSnapshots);
  fileSnapshotStore.delete(normalizedSku);
}

export function isDockFormSnapshotCompatible(
  snapshot: Pick<DockFormSnapshot, "fingerprint"> | null | undefined,
  comparable: DockFormSnapshotComparable,
): boolean {
  if (!snapshot?.fingerprint) return false;
  return snapshot.fingerprint === buildDockFormSnapshotFingerprint(comparable);
}

export function isDockFormSnapshotSubmissionMatch(
  snapshot: Pick<DockFormSnapshot, "submittedAtEpochMs" | "submittedAtSource"> | null | undefined,
  dockSubmittedAtEpochMs: number | null | undefined,
  toleranceMs?: number,
): boolean {
  if (!snapshot?.submittedAtEpochMs || !Number.isFinite(snapshot.submittedAtEpochMs) || snapshot.submittedAtEpochMs <= 0) {
    return false;
  }
  if (!dockSubmittedAtEpochMs || !Number.isFinite(dockSubmittedAtEpochMs) || dockSubmittedAtEpochMs <= 0) {
    return false;
  }
  const resolvedToleranceMs =
    Number.isFinite(Number(toleranceMs)) && Number(toleranceMs) >= 0
      ? Number(toleranceMs)
      : snapshot.submittedAtSource === "backend"
        ? 5_000
        : 30_000;
  return Math.abs(snapshot.submittedAtEpochMs - dockSubmittedAtEpochMs) <= resolvedToleranceMs;
}

export function clearDockFormSnapshotsForTest() {
  if (typeof window !== "undefined") {
      try {
      window.localStorage.removeItem(getDockFormSnapshotsStorageKey());
      } catch {
      // Ignore storage failures.
    }
  }
  fileSnapshotStore.clear();
}
