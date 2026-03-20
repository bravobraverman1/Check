import { supabase } from "@/integrations/supabase/client";
import {
  sanitizeDockFormSnapshot,
  type DockFormSnapshot,
} from "@/lib/dockFormSnapshots";

const SHARED_DOCK_SNAPSHOT_BUCKET = "document-uploads-loading-dock";
const SHARED_DOCK_SNAPSHOT_PREFIX = "loading-dock-snapshots";
const SNAPSHOT_FILE_NAME = "snapshot.json";
const SHARED_STORAGE_LIST_PAGE_SIZE = 100;
const SHARED_STORAGE_REMOVE_BATCH_SIZE = 100;
const SHARED_SNAPSHOT_RETENTION_PER_SKU = 1;
const SHARED_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const LEGACY_SAFE_SKU_PATTERN = /^[A-Z0-9._-]+$/;

function normalizeSku(rawSku: string): string {
  return String(rawSku ?? "").trim().toUpperCase();
}

function encodePathSegment(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodePathSegment(value: string): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(trimmed)) return null;

  try {
    const bytes = new Uint8Array(
      trimmed.match(/../g)?.map((chunk) => Number.parseInt(chunk, 16)) ?? [],
    );
    const decoded = new TextDecoder().decode(bytes);
    const normalized = normalizeSku(decoded);
    return normalized || null;
  } catch {
    return null;
  }
}

function buildLegacySnapshotFolder(sku: string): string | null {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return null;
  const safeSku = normalizedSku.replace(/[^A-Z0-9._-]+/g, "_");
  return `${SHARED_DOCK_SNAPSHOT_PREFIX}/${safeSku}`;
}

function buildLegacySnapshotFolderName(sku: string): string | null {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return null;
  return normalizedSku.replace(/[^A-Z0-9._-]+/g, "_");
}

function buildVersionedSnapshotFolder(
  sku: string,
  submittedAtEpochMs: number | undefined,
): string | null {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return null;
  const normalizedSubmittedAtEpochMs = Number(submittedAtEpochMs);
  if (!Number.isFinite(normalizedSubmittedAtEpochMs) || normalizedSubmittedAtEpochMs <= 0) return null;
  return `${SHARED_DOCK_SNAPSHOT_PREFIX}/${encodePathSegment(normalizedSku)}/${Math.trunc(normalizedSubmittedAtEpochMs)}`;
}

function buildVersionedSnapshotRoot(sku: string): string | null {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return null;
  return `${SHARED_DOCK_SNAPSHOT_PREFIX}/${encodePathSegment(normalizedSku)}`;
}

function sanitizeSharedSnapshot(value: unknown): DockFormSnapshot | null {
  return sanitizeDockFormSnapshot(value);
}

async function uploadSharedFile(path: string, file: Blob): Promise<void> {
  const { error } = await supabase.storage
    .from(SHARED_DOCK_SNAPSHOT_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) throw error;
}

async function removeSharedFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(SHARED_DOCK_SNAPSHOT_BUCKET).remove(paths);
  if (error) throw error;
}

async function removeSharedFilesBatched(paths: string[]): Promise<void> {
  for (let index = 0; index < paths.length; index += SHARED_STORAGE_REMOVE_BATCH_SIZE) {
    const batch = paths.slice(index, index + SHARED_STORAGE_REMOVE_BATCH_SIZE);
    await removeSharedFiles(batch);
  }
}

type SharedStorageEntry = {
  name: string;
  id: string | null;
};

async function listSharedEntries(path: string): Promise<SharedStorageEntry[]> {
  const entries: SharedStorageEntry[] = [];
  for (let offset = 0; ; offset += SHARED_STORAGE_LIST_PAGE_SIZE) {
    const { data, error } = await supabase.storage.from(SHARED_DOCK_SNAPSHOT_BUCKET).list(path, {
      limit: SHARED_STORAGE_LIST_PAGE_SIZE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    const page = (data || []) as SharedStorageEntry[];
    if (page.length === 0) break;
    entries.push(...page);
    if (page.length < SHARED_STORAGE_LIST_PAGE_SIZE) break;
  }
  return entries;
}

async function collectSharedFilePaths(path: string): Promise<string[]> {
  const entries = await listSharedEntries(path);
  const nestedPaths = await Promise.all(entries.map(async (entry) => {
    const childPath = `${path}/${entry.name}`;
    if (entry.id === null) return collectSharedFilePaths(childPath);
    return [childPath];
  }));
  return nestedPaths.flat();
}

async function removeSharedFolderContents(path: string): Promise<void> {
  const paths = await collectSharedFilePaths(path);
  await removeSharedFilesBatched(paths);
}

async function downloadSharedFile(path: string): Promise<Blob | null> {
  const { data, error } = await supabase.storage.from(SHARED_DOCK_SNAPSHOT_BUCKET).download(path);
  if (error || !data) return null;
  return data;
}

function extractSnapshotRetentionEpochMs(snapshot: DockFormSnapshot | null | undefined): number | null {
  const submittedAtEpochMs = Number(snapshot?.submittedAtEpochMs);
  if (Number.isFinite(submittedAtEpochMs) && submittedAtEpochMs > 0) return submittedAtEpochMs;
  const savedAtEpochMs = Number(snapshot?.savedAtEpochMs);
  return Number.isFinite(savedAtEpochMs) && savedAtEpochMs > 0 ? savedAtEpochMs : null;
}

function isExpiredSnapshotEpochMs(epochMs: number, nowMs = Date.now()): boolean {
  return Number.isFinite(epochMs) && epochMs > 0 && (nowMs - epochMs) >= SHARED_SNAPSHOT_MAX_AGE_MS;
}

async function readSharedSnapshotAtPath(path: string): Promise<DockFormSnapshot | null> {
  const snapshotBlob = await downloadSharedFile(path);
  if (!snapshotBlob) return null;

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(await snapshotBlob.text());
  } catch {
    return null;
  }

  return sanitizeSharedSnapshot(parsedJson);
}

async function pruneVersionedSharedSnapshotsForSku(
  sku: string,
  keepLatest = SHARED_SNAPSHOT_RETENTION_PER_SKU,
  nowMs = Date.now(),
): Promise<void> {
  const versionedRoot = buildVersionedSnapshotRoot(sku);
  if (!versionedRoot || keepLatest < 1) return;

  const versionEntries = (await listSharedEntries(versionedRoot))
    .filter((entry) => entry.id === null && /^\d+$/.test(entry.name))
    .map((entry) => ({
      folderName: entry.name,
      submittedAtEpochMs: Number(entry.name),
    }))
    .filter((entry) => Number.isFinite(entry.submittedAtEpochMs) && entry.submittedAtEpochMs > 0)
    .sort((left, right) => right.submittedAtEpochMs - left.submittedAtEpochMs);

  const pathsToRemove = new Set<string>();
  for (const [index, entry] of versionEntries.entries()) {
    const shouldRemove = index >= keepLatest || isExpiredSnapshotEpochMs(entry.submittedAtEpochMs, nowMs);
    if (!shouldRemove) continue;
    for (const path of await collectSharedFilePaths(`${versionedRoot}/${entry.folderName}`)) {
      pathsToRemove.add(path);
    }
  }

  await removeSharedFilesBatched(Array.from(pathsToRemove));
}

async function pruneLegacySharedSnapshotForSku(
  sku: string,
  nowMs = Date.now(),
): Promise<void> {
  const legacyFolder = buildLegacySnapshotFolder(sku);
  if (!legacyFolder) return;

  const snapshot = await readSharedSnapshotAtPath(`${legacyFolder}/${SNAPSHOT_FILE_NAME}`);
  const snapshotEpochMs = extractSnapshotRetentionEpochMs(snapshot);
  if (snapshot && snapshotEpochMs !== null && !isExpiredSnapshotEpochMs(snapshotEpochMs, nowMs)) return;

  await removeSharedFolderContents(legacyFolder).catch(() => undefined);
}

export async function saveSharedDockFormSnapshot(
  snapshot: DockFormSnapshot,
): Promise<void> {
  const folder = buildVersionedSnapshotFolder(snapshot.sku, snapshot.submittedAtEpochMs);
  if (!folder) {
    console.warn("[sharedDockFormSnapshots] saveSharedDockFormSnapshot skipped: no folder. sku=", snapshot.sku, "submittedAtEpochMs=", snapshot.submittedAtEpochMs);
    return;
  }

  const payload = new Blob([JSON.stringify(snapshot)], { type: "application/json" });
  await uploadSharedFile(`${folder}/${SNAPSHOT_FILE_NAME}`, payload);

  // Clean up any legacy snapshot files for this SKU
  const legacyFolder = buildLegacySnapshotFolder(snapshot.sku);
  if (legacyFolder) {
    await removeSharedFolderContents(legacyFolder).catch(() => undefined);
  }

  await Promise.allSettled([
    pruneVersionedSharedSnapshotsForSku(snapshot.sku),
    pruneLegacySharedSnapshotForSku(snapshot.sku),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[sharedDockFormSnapshots] snapshot prune failed:", result.reason);
      }
    }
  });
}

export async function getSharedDockFormSnapshot(sku: string): Promise<{
  snapshot: DockFormSnapshot | null;
}> {
  return getSharedDockFormSnapshotForSubmission(sku);
}

export async function getSharedDockFormSnapshotForSubmission(
  sku: string,
  submittedAtEpochMs?: number | null,
): Promise<{
  snapshot: DockFormSnapshot | null;
}> {
  const normalizedSubmittedAtEpochMs =
    Number.isFinite(Number(submittedAtEpochMs)) && Number(submittedAtEpochMs) > 0
      ? Number(submittedAtEpochMs)
      : null;
  const versionedFolder = buildVersionedSnapshotFolder(
    sku,
    normalizedSubmittedAtEpochMs ?? undefined,
  );
  const legacyFolder = buildLegacySnapshotFolder(sku);
  const candidateFolders = [versionedFolder, legacyFolder].filter((value, index, list): value is string => {
    return Boolean(value) && list.indexOf(value) === index;
  });
  if (candidateFolders.length === 0) return { snapshot: null };

  for (const candidateFolder of candidateFolders) {
    const snapshot = await readSharedSnapshotAtPath(`${candidateFolder}/${SNAPSHOT_FILE_NAME}`);
    if (!snapshot) continue;

    const snapshotEpochMs = extractSnapshotRetentionEpochMs(snapshot);
    if (snapshotEpochMs !== null && isExpiredSnapshotEpochMs(snapshotEpochMs)) {
      void removeSharedFolderContents(candidateFolder).catch(() => undefined);
      continue;
    }

    if (
      normalizedSubmittedAtEpochMs &&
      Number(snapshot.submittedAtEpochMs) > 0 &&
      Number(snapshot.submittedAtEpochMs) !== normalizedSubmittedAtEpochMs
    ) {
      continue;
    }

    return { snapshot };
  }

  return { snapshot: null };
}

export async function deleteSharedDockFormSnapshotsForSku(sku: string): Promise<void> {
  const pathsToRemove = new Set<string>();
  const versionedRoot = buildVersionedSnapshotRoot(sku);
  const legacyFolder = buildLegacySnapshotFolder(sku);

  if (versionedRoot) {
    for (const path of await collectSharedFilePaths(versionedRoot)) {
      pathsToRemove.add(path);
    }
  }

  if (legacyFolder) {
    for (const path of await collectSharedFilePaths(legacyFolder)) {
      pathsToRemove.add(path);
    }
  }

  await removeSharedFilesBatched(Array.from(pathsToRemove));
}

export async function cleanupOrphanedSharedDockFormSnapshots(activeSkus: string[]): Promise<{
  removedRoots: string[];
}> {
  const normalizedActiveSkus = Array.from(new Set(
    activeSkus
      .map((sku) => normalizeSku(sku))
      .filter(Boolean),
  ));
  await Promise.allSettled(
    normalizedActiveSkus.flatMap((sku) => [
      pruneVersionedSharedSnapshotsForSku(sku),
      pruneLegacySharedSnapshotForSku(sku),
    ]),
  );
  const activeVersionedRoots = new Set(normalizedActiveSkus.map((sku) => encodePathSegment(sku)));
  const activeLegacyRoots = new Set(
    normalizedActiveSkus
      .map((sku) => buildLegacySnapshotFolderName(sku))
      .filter((value): value is string => Boolean(value)),
  );
  const rootEntries = await listSharedEntries(SHARED_DOCK_SNAPSHOT_PREFIX);
  const removedRoots: string[] = [];
  const pathsToRemove = new Set<string>();

  for (const entry of rootEntries) {
    if (entry.id !== null) continue;
    const folderName = String(entry.name ?? "").trim();
    if (!folderName) continue;
    if (activeVersionedRoots.has(folderName) || activeLegacyRoots.has(folderName)) continue;

    const decodedVersionedSku = decodePathSegment(folderName);
    const isLegacyFolder = LEGACY_SAFE_SKU_PATTERN.test(folderName);
    if (!decodedVersionedSku && !isLegacyFolder) continue;

    const rootPath = `${SHARED_DOCK_SNAPSHOT_PREFIX}/${folderName}`;
    for (const path of await collectSharedFilePaths(rootPath)) pathsToRemove.add(path);
    removedRoots.push(rootPath);
  }

  await removeSharedFilesBatched(Array.from(pathsToRemove));
  return { removedRoots };
}
