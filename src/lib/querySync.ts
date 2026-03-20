import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { invalidateReadCache } from "@/lib/supabaseGoogleSheets";

const CORE_QUERY_KEYS: QueryKey[] = [
  ["skus"],
  ["categories"],
  ["categories-with-source"],
  ["brands"],
  ["brands-with-source"],
  ["properties"],
];
let _syncInFlight: Promise<void> | null = null;

/**
 * Refreshes Google Sheets-backed query data without blasting every cache entry.
 */
export async function syncGoogleSheetQueries(queryClient: QueryClient, _options?: { includeDock?: boolean }): Promise<void> {
  if (_syncInFlight) {
    await _syncInFlight;
    return;
  }

  invalidateReadCache();

  _syncInFlight = (async () => {
    const jobs = CORE_QUERY_KEYS.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey, refetchType: "active" })
    );
    await Promise.all(jobs);
  })();

  try {
    await _syncInFlight;
  } finally {
    _syncInFlight = null;
  }
}
