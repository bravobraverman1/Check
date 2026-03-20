# Google Apps Scripts

## Files
- **MpnPanel.gs** — MPN control panel, event logging, Melbourne timestamps
- **CopyEngine.gs** — disabled no-op shim; submit / override / upload are edge-owned
- **Triggers.gs** — onChange trigger setup for Apps Script-owned dock actions only
- **CopyEngine_OLD.gs** — archived legacy submit pipeline; do not deploy its live entry point

## Current Architecture
1. Submit / override / upload are handled directly by the Supabase edge function.
2. Apps Script only owns dock actions such as delete, email single, and send/clear.
3. `MpnPanel.gs` still owns manual MPN panel utilities, but submit-time MPN behavior for form submits is edge-controlled.
4. `CopyEngine_OLD.gs` is archival only and should not be used as an active submit pipeline.

## Setup
1. Copy all `.gs` files into your Apps Script project
2. Add Apps Script project properties:
   - `SUPABASE_GOOGLE_SHEETS_EDGE_URL` = your deployed `google-sheets` edge URL
   - `SUPABASE_GOOGLE_SHEETS_EDGE_ANON_KEY` = your Supabase anon key
3. Run `setupSystem` once
4. The onChange trigger will automatically process Apps Script-owned dock events only

## Important
- Do not wire any trigger or Execution API call to the legacy archived submit pipeline.
- If your live Apps Script project still contains an old active `processSubmitEvents()` implementation, remove it or replace it with the no-op `CopyEngine.gs` version.
- Keep the Google Sheets drawing buttons assigned to `mpn_incrementForProducts` and `mpn_getNewForEran`. Those functions now delegate to the edge allocator and remain globally safe.
