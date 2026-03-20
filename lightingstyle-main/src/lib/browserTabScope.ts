const TAB_ID_SESSION_KEY = "lightingstyle.browserTabId";
const WINDOW_NAME_PREFIX = "lightingstyle-tab:";
const VITEST_TAB_ID = "vitest-tab";

let cachedTabId: string | null = null;

function isTestRuntime(): boolean {
  try {
    return typeof process !== "undefined" && process.env?.VITEST === "true";
  } catch {
    return false;
  }
}

function canUseSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

function createTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

export function getBrowserTabId(): string {
  if (typeof window === "undefined") return "server";

  if (isTestRuntime()) {
    if (canUseSessionStorage()) {
      const stored = window.sessionStorage.getItem(TAB_ID_SESSION_KEY);
      if (stored) return stored;
      window.sessionStorage.setItem(TAB_ID_SESSION_KEY, VITEST_TAB_ID);
    }
    return VITEST_TAB_ID;
  }

  if (cachedTabId) return cachedTabId;

  if (canUseSessionStorage()) {
    try {
      const stored = window.sessionStorage.getItem(TAB_ID_SESSION_KEY);
      if (stored) {
        cachedTabId = stored;
        return cachedTabId;
      }
    } catch {
      // Fall through to window.name fallback.
    }
  }

  if (typeof window.name === "string" && window.name.startsWith(WINDOW_NAME_PREFIX)) {
    const fromWindowName = window.name.slice(WINDOW_NAME_PREFIX.length).trim();
    if (fromWindowName) {
      cachedTabId = fromWindowName;
    }
  }

  if (!cachedTabId) {
    cachedTabId = createTabId();
  }

  if (canUseSessionStorage()) {
    try {
      window.sessionStorage.setItem(TAB_ID_SESSION_KEY, cachedTabId);
    } catch {
      // Ignore sessionStorage failures.
    }
  }

  try {
    window.name = `${WINDOW_NAME_PREFIX}${cachedTabId}`;
  } catch {
    // Ignore window.name assignment failures.
  }

  return cachedTabId;
}

export function getTabScopedStorageKey(baseKey: string): string {
  return `${baseKey}:${getBrowserTabId()}`;
}
