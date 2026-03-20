function randomEntropy(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function normalizeSubmitRequestId(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/.test(value) ? value : "";
}

export function createSubmitRequestId(now = Date.now()): string {
  return `submit_${now}_${randomEntropy()}`;
}

export function ensureSubmitRequestId<T extends { requestId?: string }>(payload: T): T & { requestId: string } {
  const existing = normalizeSubmitRequestId(payload.requestId);
  if (existing) {
    return payload as T & { requestId: string };
  }
  return {
    ...payload,
    requestId: createSubmitRequestId(),
  };
}
