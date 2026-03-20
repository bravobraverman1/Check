const MELBOURNE_TIMEZONE = "Australia/Melbourne";

function getTimezoneOffsetMs(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const rawHour = get("hour");
  // Some Node 20 Intl builds can emit midnight as 24:00:00 for formatToParts().
  // Treat that as 00:00:00 on the same local date instead of rolling to the next day.
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = get("minute");
  const second = get("second");
  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtcMs - utcMs;
}

function melbourneLocalToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let utcMs = localAsUtcMs;
  for (let i = 0; i < 3; i++) {
    const offsetMs = getTimezoneOffsetMs(MELBOURNE_TIMEZONE, utcMs);
    const next = localAsUtcMs - offsetMs;
    if (Math.abs(next - utcMs) < 500) break;
    utcMs = next;
  }
  return utcMs;
}

function parseGoogleSheetsSerialTimestamp(raw: string | number): number {
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric > 1e11) return Math.round(numeric);
  if (numeric < 20_000 || numeric > 80_000) return 0;
  return Math.round((numeric - 25569) * 86_400_000);
}

export function parseDockTimestamp(raw: string | number | undefined | null): number {
  if (raw == null) return 0;

  const serialMs = parseGoogleSheetsSerialTimestamp(raw);
  if (serialMs > 0) return serialMs;

  const trimmed = String(raw).trim();
  if (!trimmed) return 0;

  const dayFirstDateTimeMatch = trimmed.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{2}):(\d{2})(?::(\d{2}))?(?:\s*(AEST|AEDT))?$/i,
  );
  if (dayFirstDateTimeMatch) {
    const day = Number(dayFirstDateTimeMatch[1]);
    const month = Number(dayFirstDateTimeMatch[2]);
    const year = Number(dayFirstDateTimeMatch[3]);
    const hour = Number(dayFirstDateTimeMatch[4]);
    const minute = Number(dayFirstDateTimeMatch[5]);
    const second = Number(dayFirstDateTimeMatch[6] ?? "0");
    const tzAbbr = (dayFirstDateTimeMatch[7] ?? "").toUpperCase();
    if (tzAbbr === "AEST" || tzAbbr === "AEDT") {
      const offset = tzAbbr === "AEST" ? "+10:00" : "+11:00";
      const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${offset}`;
      const parsed = Date.parse(iso);
      if (Number.isFinite(parsed)) return parsed;
    }
    const melbourneMs = melbourneLocalToUtcMs(year, month, day, hour, minute, second);
    if (Number.isFinite(melbourneMs) && melbourneMs > 0) return melbourneMs;
  }

  const dayFirstDateMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dayFirstDateMatch) {
    const day = Number(dayFirstDateMatch[1]);
    const month = Number(dayFirstDateMatch[2]);
    const year = Number(dayFirstDateMatch[3]);
    const melbourneMs = melbourneLocalToUtcMs(year, month, day, 0, 0, 0);
    if (Number.isFinite(melbourneMs) && melbourneMs > 0) return melbourneMs;
  }

  const isoLikeDateTimeMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*(AEST|AEDT))?$/i,
  );
  if (isoLikeDateTimeMatch) {
    const year = Number(isoLikeDateTimeMatch[1]);
    const month = Number(isoLikeDateTimeMatch[2]);
    const day = Number(isoLikeDateTimeMatch[3]);
    const hour = Number(isoLikeDateTimeMatch[4]);
    const minute = Number(isoLikeDateTimeMatch[5]);
    const second = Number(isoLikeDateTimeMatch[6] ?? "0");
    const tzAbbr = (isoLikeDateTimeMatch[7] ?? "").toUpperCase();
    if (tzAbbr === "AEST" || tzAbbr === "AEDT") {
      const offset = tzAbbr === "AEST" ? "+10:00" : "+11:00";
      const iso = `${isoLikeDateTimeMatch[1]}-${isoLikeDateTimeMatch[2]}-${isoLikeDateTimeMatch[3]}T${isoLikeDateTimeMatch[4]}:${isoLikeDateTimeMatch[5]}:${String(second).padStart(2, "0")}${offset}`;
      const parsed = Date.parse(iso);
      if (Number.isFinite(parsed)) return parsed;
    }
    const melbourneMs = melbourneLocalToUtcMs(year, month, day, hour, minute, second);
    if (Number.isFinite(melbourneMs) && melbourneMs > 0) return melbourneMs;
  }

  const isoLikeDateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoLikeDateMatch) {
    const year = Number(isoLikeDateMatch[1]);
    const month = Number(isoLikeDateMatch[2]);
    const day = Number(isoLikeDateMatch[3]);
    const melbourneMs = melbourneLocalToUtcMs(year, month, day, 0, 0, 0);
    if (Number.isFinite(melbourneMs) && melbourneMs > 0) return melbourneMs;
  }

  const fallback = Date.parse(trimmed);
  return Number.isFinite(fallback) ? fallback : 0;
}

export function hasCompletedProcessedAt(raw: string | number | undefined | null): boolean {
  if (raw == null) return false;
  const trimmed = String(raw).trim();
  if (!trimmed) return false;
  if (trimmed.toUpperCase() === "PROCESSING") return false;
  return parseDockTimestamp(trimmed) > 0;
}

export function formatDockTimestampLocal(raw: string | number | undefined | null): string {
  if (raw == null) return "Pending…";
  const trimmed = String(raw).trim();
  if (!trimmed) return "Pending…";
  const ts = parseDockTimestamp(trimmed);
  if (!ts) return trimmed;
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ts));

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${get("month")} ${get("day")} ${get("year")}, ${get("hour")}:${get("minute")}:${get("second")} ${get("dayPeriod")}`;
}
