import { afterEach, describe, expect, it, vi } from "vitest";

import { hasCompletedProcessedAt, parseDockTimestamp } from "@/lib/loadingDockTime";

describe("loadingDockTime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses canonical Melbourne timestamps with DST abbreviation", () => {
    const parsed = parseDockTimestamp("2026-03-09 22:27:50 AEDT");
    expect(new Date(parsed).toISOString()).toBe("2026-03-09T11:27:50.000Z");
  });

  it("parses canonical Melbourne timestamps after DST ends", () => {
    const parsed = parseDockTimestamp("2026-06-09 22:27:50 AEST");
    expect(new Date(parsed).toISOString()).toBe("2026-06-09T12:27:50.000Z");
  });

  it("parses legacy day-first timestamps without swapping month and day during AEDT", () => {
    const parsed = parseDockTimestamp("09/03/2026");
    // Melbourne midnight on March 9, 2026 is still AEDT, which is March 8 13:00:00 UTC.
    expect(new Date(parsed).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("parses legacy day-first timestamps using AEST after DST ends", () => {
    const parsed = parseDockTimestamp("09/06/2026");
    // Melbourne midnight on June 9, 2026 is AEST, which is June 8 14:00:00 UTC.
    expect(new Date(parsed).toISOString()).toBe("2026-06-08T14:00:00.000Z");
  });

  it("treats Google Sheets serial timestamps as completed processed values", () => {
    expect(hasCompletedProcessedAt("46090.936")).toBe(true);
  });

  it("treats Intl midnight hour 24 as same-day 00 for Melbourne date-only parsing", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;

    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(((...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
      const formatter = new RealDateTimeFormat(...args);
      return {
        ...formatter,
        format: formatter.format.bind(formatter),
        resolvedOptions: formatter.resolvedOptions.bind(formatter),
        formatRange: (formatter as any).formatRange?.bind(formatter),
        formatRangeToParts: (formatter as any).formatRangeToParts?.bind(formatter),
        formatToParts(date?: number | Date) {
          const parts = formatter.formatToParts(date);
          const utcIso =
            date instanceof Date
              ? date.toISOString()
              : typeof date === "number"
                ? new Date(date).toISOString()
                : "";
          if (
            args[1]?.timeZone === "Australia/Melbourne" &&
            utcIso === "2026-03-08T13:00:00.000Z"
          ) {
            return parts.map((part) => (part.type === "hour" ? { ...part, value: "24" } : part));
          }
          return parts;
        },
      } as Intl.DateTimeFormat;
    }) as typeof Intl.DateTimeFormat);

    const parsed = parseDockTimestamp("09/03/2026");
    expect(new Date(parsed).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });
});
