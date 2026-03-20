export const GOOGLE_SHEETS_ACTIONS = [
  "read",
  "write",
  "write-categories",
  "write-brands",
  "write-legal",
  "update-sku-visibility",
  "update-sku-status",
  "write-output",
  "check-sku-temp-csv",
  "fetch-dock-entries",
  "clear-dock-failures",
  "check-sku-status",
  "check-dock-row-status",
  "log-dock-delete",
  "log-email-single",
  "log-send-dock",
  "read-dock-email",
  "save-dock-email",
  "read-output-work",
  "read-sku-details",
  "send-form-email",
  "download-form-csv",
  "upload-csv",
  "download-csv",
  "mpn-peek",
  "log-form-mpn-sku-change",
  "resolve-form-mpn-state",
  "release-form-generated-mpn",
  "mpn-commit",
  "mpn-increment",
  "mpn-eran",
  "mpn-set-next",
  "write-ai-log",
  "upsert-dock-pending",
  "remove-dock-pending",
] as const;

export type GoogleSheetsAction = typeof GOOGLE_SHEETS_ACTIONS[number];

const GOOGLE_SHEETS_ACTION_SET = new Set<string>(GOOGLE_SHEETS_ACTIONS);

const GOOGLE_SHEETS_ACTION_ALIASES: Readonly<Record<string, GoogleSheetsAction>> = {
  "fetch-dock": "fetch-dock-entries",
  "read-output": "read-output-work",
  "upload-output-csv": "upload-csv",
  "download-output-csv": "download-csv",
  "persist-dock-pending": "upsert-dock-pending",
  "save-dock-pending": "upsert-dock-pending",
  "clear-dock-pending": "remove-dock-pending",
  "delete-dock-pending": "remove-dock-pending",
  "persist-global-pending-dock-submit": "upsert-dock-pending",
  "remove-global-pending-dock-submit": "remove-dock-pending",
} as const;

export function normalizeGoogleSheetsAction(action: unknown): GoogleSheetsAction | null {
  if (typeof action !== "string") return null;
  const normalized = action.trim().toLowerCase();
  if (!normalized) return null;
  if (GOOGLE_SHEETS_ACTION_SET.has(normalized)) {
    return normalized as GoogleSheetsAction;
  }
  return GOOGLE_SHEETS_ACTION_ALIASES[normalized] ?? null;
}

export function isGoogleSheetsAction(action: unknown): action is GoogleSheetsAction {
  return normalizeGoogleSheetsAction(action) !== null;
}

export function listGoogleSheetsActions(): GoogleSheetsAction[] {
  return [...GOOGLE_SHEETS_ACTIONS];
}
