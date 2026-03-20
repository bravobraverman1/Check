import { invokeEdgeFunction } from "@/lib/edgeAuth";

export interface CachedPromptVersionRow {
  id?: string;
  version?: number;
  description?: string;
  content?: string;
  created_at?: string;
  is_active?: boolean;
}

const ACTIVE_PROMPT_CACHE_TTL_MS = 10 * 60_000;
const PROMPT_VERSIONS_CACHE_TTL_MS = 5 * 60_000;
const PROMPT_FETCH_TIMEOUT_MS = 20_000;

const activePromptMemoryCache = new Map<string, { prompt: string; loadedAt: number }>();
const versionsMemoryCache = new Map<string, { rows: CachedPromptVersionRow[]; loadedAt: number }>();
const activePromptInflight = new Map<string, Promise<string | null>>();
const versionsInflight = new Map<string, Promise<CachedPromptVersionRow[]>>();

function getActivePromptStorageKey(promptType: string): string {
  return `ai_prompt_active_cache_v1:${promptType}`;
}

function getVersionsStorageKey(promptType: string): string {
  return `ai_prompt_versions_cache_v1:${promptType}`;
}

function readStorageJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeStorageJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures
  }
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(`Prompt lookup timed out after ${timeoutMs}ms`)), timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

export function extractPromptContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const direct = (payload as { data?: { content?: unknown } }).data?.content;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const rows = (payload as { data?: Array<{ is_active?: boolean; content?: unknown }> }).data;
  if (Array.isArray(rows)) {
    const active = rows.find((row) => row?.is_active && typeof row.content === "string" && row.content.trim());
    if (active && typeof active.content === "string") return active.content.trim();
  }
  return "";
}

export function getCachedActivePrompt(promptType: string): string | null {
  const now = Date.now();
  const memoryCached = activePromptMemoryCache.get(promptType);
  if (memoryCached && now - memoryCached.loadedAt < ACTIVE_PROMPT_CACHE_TTL_MS) {
    return memoryCached.prompt;
  }

  const stored = readStorageJson<{ prompt: string; loadedAt: number }>(getActivePromptStorageKey(promptType));
  if (stored && typeof stored.prompt === "string" && stored.prompt.trim()) {
    activePromptMemoryCache.set(promptType, stored);
    if (now - stored.loadedAt < ACTIVE_PROMPT_CACHE_TTL_MS) {
      return stored.prompt;
    }
  }

  return null;
}

export function getAnyCachedActivePrompt(promptType: string): string | null {
  const memoryCached = activePromptMemoryCache.get(promptType);
  if (memoryCached?.prompt) return memoryCached.prompt;
  const stored = readStorageJson<{ prompt: string; loadedAt: number }>(getActivePromptStorageKey(promptType));
  if (stored?.prompt) {
    activePromptMemoryCache.set(promptType, stored);
    return stored.prompt;
  }
  return null;
}

export function setCachedActivePrompt(promptType: string, prompt: string): void {
  const entry = { prompt, loadedAt: Date.now() };
  activePromptMemoryCache.set(promptType, entry);
  writeStorageJson(getActivePromptStorageKey(promptType), entry);
}

export function getCachedPromptVersions(promptType: string): CachedPromptVersionRow[] | null {
  const now = Date.now();
  const memoryCached = versionsMemoryCache.get(promptType);
  if (memoryCached && now - memoryCached.loadedAt < PROMPT_VERSIONS_CACHE_TTL_MS) {
    return memoryCached.rows;
  }
  const stored = readStorageJson<{ rows: CachedPromptVersionRow[]; loadedAt: number }>(getVersionsStorageKey(promptType));
  if (stored?.rows && Array.isArray(stored.rows)) {
    versionsMemoryCache.set(promptType, stored);
    if (now - stored.loadedAt < PROMPT_VERSIONS_CACHE_TTL_MS) {
      return stored.rows;
    }
  }
  return null;
}

export function setCachedPromptVersions(promptType: string, rows: CachedPromptVersionRow[]): void {
  const entry = { rows, loadedAt: Date.now() };
  versionsMemoryCache.set(promptType, entry);
  writeStorageJson(getVersionsStorageKey(promptType), entry);

  const active = rows.find((row) => row.is_active && typeof row.content === "string" && row.content.trim());
  if (active?.content) {
    setCachedActivePrompt(promptType, active.content.trim());
  }
}

async function fetchPromptVersions(promptType: string): Promise<CachedPromptVersionRow[]> {
  const inflight = versionsInflight.get(promptType);
  if (inflight) return inflight;

  const task = withTimeout(
    invokeEdgeFunction("manage-ai-prompt", {
      body: { action: "list", promptType },
    }),
    PROMPT_FETCH_TIMEOUT_MS,
  ).then(({ data, error }) => {
    if (error) throw error;
    const rows = Array.isArray((data as { data?: unknown }).data)
      ? ((data as { data?: CachedPromptVersionRow[] }).data ?? [])
      : [];
    setCachedPromptVersions(promptType, rows);
    return rows;
  }).finally(() => {
    versionsInflight.delete(promptType);
  });

  versionsInflight.set(promptType, task);
  return task;
}

export async function getActivePromptContent(promptType: string): Promise<string | null> {
  const fresh = getCachedActivePrompt(promptType);
  if (fresh) return fresh;

  const inflight = activePromptInflight.get(promptType);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const { data, error } = await withTimeout(
        invokeEdgeFunction("manage-ai-prompt", {
          body: { action: "get_active", promptType },
        }),
        PROMPT_FETCH_TIMEOUT_MS,
      );

      if (error) throw error;
      const prompt = extractPromptContent(data);
      if (prompt) {
        setCachedActivePrompt(promptType, prompt);
        return prompt;
      }

      const rows = await fetchPromptVersions(promptType);
      const active = rows.find((row) => row.is_active && typeof row.content === "string" && row.content.trim());
      if (active?.content) {
        setCachedActivePrompt(promptType, active.content.trim());
        return active.content.trim();
      }

      return getAnyCachedActivePrompt(promptType);
    } catch (error) {
      const cached = getAnyCachedActivePrompt(promptType);
      if (cached) return cached;
      throw error;
    } finally {
      activePromptInflight.delete(promptType);
    }
  })();

  activePromptInflight.set(promptType, task);
  return task;
}

export async function getFastActivePromptContent(promptType: string): Promise<string | null> {
  const cached = getAnyCachedActivePrompt(promptType);
  if (cached) return cached;
  return getActivePromptContent(promptType).catch(() => null);
}

export async function getActivePromptContentNoCache(promptType: string): Promise<string | null> {
  const { data, error } = await withTimeout(
    invokeEdgeFunction("manage-ai-prompt", {
      body: { action: "get_active", promptType },
    }),
    PROMPT_FETCH_TIMEOUT_MS,
  );

  if (error) throw error;
  const prompt = extractPromptContent(data);
  return prompt || null;
}

export async function getPromptVersions(promptType: string): Promise<CachedPromptVersionRow[]> {
  const cached = getCachedPromptVersions(promptType);
  if (cached) return cached;
  try {
    return await fetchPromptVersions(promptType);
  } catch {
    return getCachedPromptVersions(promptType) ?? [];
  }
}

export function invalidatePromptCaches(promptType: string): void {
  activePromptMemoryCache.delete(promptType);
  versionsMemoryCache.delete(promptType);
  activePromptInflight.delete(promptType);
  versionsInflight.delete(promptType);
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(getActivePromptStorageKey(promptType));
      localStorage.removeItem(getVersionsStorageKey(promptType));
    } catch {
      // Ignore storage failures
    }
  }
}
