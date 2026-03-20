export interface AiCollisionTuningConfig {
  twoPdfConflictMaxRows: number;
  twoPdfConflictValueLimit: number;
  forceCoverageCompare: boolean;
  penaltyGlobalHigh: number;
  penaltyGlobalMedium: number;
  penaltyGlobalLow: number;
  penaltyFieldRequired: number;
  penaltyFieldOptional: number;
}

const KEYS = {
  twoPdfConflictMaxRows: "AI_COLLISION_TWO_PDF_MAX_ROWS",
  twoPdfConflictValueLimit: "AI_COLLISION_TWO_PDF_VALUE_LIMIT",
  forceCoverageCompare: "AI_COLLISION_FORCE_COVERAGE_COMPARE",
  penaltyGlobalHigh: "AI_COLLISION_PENALTY_GLOBAL_HIGH",
  penaltyGlobalMedium: "AI_COLLISION_PENALTY_GLOBAL_MEDIUM",
  penaltyGlobalLow: "AI_COLLISION_PENALTY_GLOBAL_LOW",
  penaltyFieldRequired: "AI_COLLISION_PENALTY_FIELD_REQUIRED",
  penaltyFieldOptional: "AI_COLLISION_PENALTY_FIELD_OPTIONAL",
} as const;

const APP_CONFIG_STORAGE_KEY = "app_config";

const DEFAULTS: AiCollisionTuningConfig = {
  twoPdfConflictMaxRows: 40,
  twoPdfConflictValueLimit: 40,
  forceCoverageCompare: false,
  penaltyGlobalHigh: 14,
  penaltyGlobalMedium: 10,
  penaltyGlobalLow: 6,
  penaltyFieldRequired: 30,
  penaltyFieldOptional: 24,
};

const clampInt = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
};

const parseIntSetting = (raw: string, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clampInt(parsed, min, max);
};

const parseBoolSetting = (raw: string, fallback: boolean): boolean => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
};

function loadStoredConfig(): Record<string, string> {
  try {
    const raw = localStorage.getItem(APP_CONFIG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStoredConfig(config: Record<string, string>): void {
  try {
    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage write failures
  }
}

function readSetting(key: string, fallback: string): string {
  return loadStoredConfig()[key] ?? fallback;
}

function writeSetting(key: string, value: string): void {
  const next = loadStoredConfig();
  next[key] = value;
  saveStoredConfig(next);
}

function sanitizeConfig(input: Partial<AiCollisionTuningConfig>): AiCollisionTuningConfig {
  return {
    twoPdfConflictMaxRows: clampInt(
      input.twoPdfConflictMaxRows ?? DEFAULTS.twoPdfConflictMaxRows,
      8,
      200,
    ),
    twoPdfConflictValueLimit: clampInt(
      input.twoPdfConflictValueLimit ?? DEFAULTS.twoPdfConflictValueLimit,
      2,
      200,
    ),
    forceCoverageCompare: typeof input.forceCoverageCompare === "boolean"
      ? input.forceCoverageCompare
      : DEFAULTS.forceCoverageCompare,
    penaltyGlobalHigh: clampInt(input.penaltyGlobalHigh ?? DEFAULTS.penaltyGlobalHigh, 0, 60),
    penaltyGlobalMedium: clampInt(input.penaltyGlobalMedium ?? DEFAULTS.penaltyGlobalMedium, 0, 60),
    penaltyGlobalLow: clampInt(input.penaltyGlobalLow ?? DEFAULTS.penaltyGlobalLow, 0, 60),
    penaltyFieldRequired: clampInt(input.penaltyFieldRequired ?? DEFAULTS.penaltyFieldRequired, 0, 80),
    penaltyFieldOptional: clampInt(input.penaltyFieldOptional ?? DEFAULTS.penaltyFieldOptional, 0, 80),
  };
}

export function getDefaultAiCollisionTuningConfig(): AiCollisionTuningConfig {
  return { ...DEFAULTS };
}

export function getAiCollisionTuningConfig(): AiCollisionTuningConfig {
  return sanitizeConfig({
    twoPdfConflictMaxRows: parseIntSetting(
      readSetting(KEYS.twoPdfConflictMaxRows, String(DEFAULTS.twoPdfConflictMaxRows)),
      DEFAULTS.twoPdfConflictMaxRows,
      8,
      200,
    ),
    twoPdfConflictValueLimit: parseIntSetting(
      readSetting(KEYS.twoPdfConflictValueLimit, String(DEFAULTS.twoPdfConflictValueLimit)),
      DEFAULTS.twoPdfConflictValueLimit,
      2,
      200,
    ),
    forceCoverageCompare: parseBoolSetting(
      readSetting(KEYS.forceCoverageCompare, String(DEFAULTS.forceCoverageCompare)),
      DEFAULTS.forceCoverageCompare,
    ),
    penaltyGlobalHigh: parseIntSetting(
      readSetting(KEYS.penaltyGlobalHigh, String(DEFAULTS.penaltyGlobalHigh)),
      DEFAULTS.penaltyGlobalHigh,
      0,
      60,
    ),
    penaltyGlobalMedium: parseIntSetting(
      readSetting(KEYS.penaltyGlobalMedium, String(DEFAULTS.penaltyGlobalMedium)),
      DEFAULTS.penaltyGlobalMedium,
      0,
      60,
    ),
    penaltyGlobalLow: parseIntSetting(
      readSetting(KEYS.penaltyGlobalLow, String(DEFAULTS.penaltyGlobalLow)),
      DEFAULTS.penaltyGlobalLow,
      0,
      60,
    ),
    penaltyFieldRequired: parseIntSetting(
      readSetting(KEYS.penaltyFieldRequired, String(DEFAULTS.penaltyFieldRequired)),
      DEFAULTS.penaltyFieldRequired,
      0,
      80,
    ),
    penaltyFieldOptional: parseIntSetting(
      readSetting(KEYS.penaltyFieldOptional, String(DEFAULTS.penaltyFieldOptional)),
      DEFAULTS.penaltyFieldOptional,
      0,
      80,
    ),
  });
}

export function setAiCollisionTuningConfig(config: Partial<AiCollisionTuningConfig>): AiCollisionTuningConfig {
  const next = sanitizeConfig({
    ...getAiCollisionTuningConfig(),
    ...config,
  });

  writeSetting(KEYS.twoPdfConflictMaxRows, String(next.twoPdfConflictMaxRows));
  writeSetting(KEYS.twoPdfConflictValueLimit, String(next.twoPdfConflictValueLimit));
  writeSetting(KEYS.forceCoverageCompare, String(next.forceCoverageCompare));
  writeSetting(KEYS.penaltyGlobalHigh, String(next.penaltyGlobalHigh));
  writeSetting(KEYS.penaltyGlobalMedium, String(next.penaltyGlobalMedium));
  writeSetting(KEYS.penaltyGlobalLow, String(next.penaltyGlobalLow));
  writeSetting(KEYS.penaltyFieldRequired, String(next.penaltyFieldRequired));
  writeSetting(KEYS.penaltyFieldOptional, String(next.penaltyFieldOptional));

  return next;
}
