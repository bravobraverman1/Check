/*************************************************************
 * Triggers.gs — onChange Event Router v7.1
 *
 * Single onChange installable trigger replaces the 1-minute
 * time-driven polling for Apps Script-owned pipelines.
 *
 * Architecture:
 * - onChange fires → acquires script lock (prevents double-trigger)
 * - Runs only Apps Script-owned pipelines sequentially
 * - Each pipeline has its own document lock (prevents kick conflicts)
 * - Fail-fast throughout: if busy, skip (next onChange catches up)
 *
 * Collision safety:
 * - Script lock prevents two onChange from running simultaneously
 * - Document locks in each pipeline prevent kick + onChange conflicts
 * - Submit / override / upload are edge-owned and are NOT routed here
 *
 * v7.1 changes from v7.0:
 *  - Removed processSubmitEvents from onChange routing
 *  - Removed manual submit pipeline menu entry
 *  - Force Run ALL now excludes submit pipeline
 *
 * v7.0 changes from v6.0:
 *  - Added execution timing to onSheetChange (logs total pipeline time)
 *  - Simplified resolvePipelineFn_ — direct refs only, no globalThis
 *************************************************************/

var TRIGGER_ROUTER = {
  EVENTS_SHEET: "Events",
  LOOKBACK_ROWS: 80,
  MIN_REENTRY_MS: 3000,
  LAST_RUN_PROP: "ONCHANGE_LAST_RUN_AT_MS",
};

/**
 * THE ONLY TRIGGER: Set this to trigger on "Change" (From Spreadsheet).
 * Handles Apps Script-owned pipelines only.
 */
function onSheetChange(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) {
    // Keep trigger fail-fast to avoid long overlapping executions.
    console.log("onSheetChange: lock busy, skipping this trigger.");
    return;
  }

  var t0 = Date.now();
  try {
    var props = PropertiesService.getScriptProperties();
    var lastRunRaw = Number(props.getProperty(TRIGGER_ROUTER.LAST_RUN_PROP) || 0);
    if (Number.isFinite(lastRunRaw) && (t0 - lastRunRaw) < TRIGGER_ROUTER.MIN_REENTRY_MS) {
      console.log("onSheetChange: debounced (" + (t0 - lastRunRaw) + "ms since last run).");
      return;
    }
    props.setProperty(TRIGGER_ROUTER.LAST_RUN_PROP, String(t0));

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var eventsSheet = ss.getSheetByName(TRIGGER_ROUTER.EVENTS_SHEET);
    if (!eventsSheet) {
      console.warn("onSheetChange: Events sheet not found — skipping.");
      return;
    }

    var pending = getPendingPipelines_(eventsSheet, TRIGGER_ROUTER.LOOKBACK_ROWS);
    if (pending.length === 0) {
      console.log("onSheetChange: no pending app-owned events.");
      return;
    }

    for (var i = 0; i < pending.length; i++) {
      runPipelineSafe_("onChange", pending[i]);
    }
  } finally {
    lock.releaseLock();
    console.log("onSheetChange: total " + (Date.now() - t0) + "ms");
  }
}

/**
 * Resolve pipeline function references safely across Apps Script files.
 * Direct references — works in both V8 and Rhino runtimes.
 */
function resolvePipelineFn_(fnName) {
  if (fnName === "processDeleteDockEvents"   && typeof processDeleteDockEvents   === "function") return processDeleteDockEvents;
  if (fnName === "processEmailSingleEvents"  && typeof processEmailSingleEvents  === "function") return processEmailSingleEvents;
  if (fnName === "processSendDockEvents"     && typeof processSendDockEvents     === "function") return processSendDockEvents;
  // globalThis fallback for edge cases (V8 runtime)
  if (typeof globalThis !== "undefined" && typeof globalThis[fnName] === "function") return globalThis[fnName];
  return null;
}

/**
 * Run a single pipeline function by name.
 * Swallows errors so other pipelines still run.
 */
function runPipelineSafe_(caller, fnName) {
  var fn = resolvePipelineFn_(fnName);
  if (!fn) {
    console.warn("[" + caller + "] Pipeline function " + fnName + " not loaded — skipping.");
    return;
  }
  try {
    fn();
  } catch (err) {
    console.error("[" + caller + "] " + fnName + " error:", err);
  }
}

function getPendingPipelines_(eventsSheet, lookbackRows) {
  var lastRow = eventsSheet.getLastRow();
  if (lastRow < 2) return [];

  var rows = Math.min(Math.max(1, Number(lookbackRows) || 1), lastRow - 1);
  var startRow = lastRow - rows + 1;
  var data = eventsSheet.getRange(startRow, 3, rows, 4).getValues();

  var hasDelete = false;
  var hasEmailSingle = false;
  var hasSendDock = false;
  var hasMarkNotForSale = false;

  for (var i = data.length - 1; i >= 0; i--) {
    var eventType = String(data[i][0] || "").trim(); // col C
    var processedAt = String(data[i][3] || "").trim(); // col F
    if (!eventType || processedAt) continue;

    if (eventType.indexOf("MPN_") === 0) {
      // MPN rows are log-only for Apps Script. Allocation/attachment is edge/DB-owned.
      continue;
    }

    if (eventType === "DOCK_DELETE") hasDelete = true;
    else if (eventType === "EMAIL_SINGLE" || eventType === "FORM_EMAIL") hasEmailSingle = true;
    else if (eventType === "SEND_DOCK") hasSendDock = true;
    else if (eventType === "MARK_NOT_FOR_SALE") hasMarkNotForSale = true;

    if (hasDelete && hasEmailSingle && hasSendDock && hasMarkNotForSale) break;
  }

  var pipelines = [];
  // Delete first to clear stale rows quickly, then email and send batch jobs.
  if (hasDelete) pipelines.push("processDeleteDockEvents");
  if (hasEmailSingle) pipelines.push("processEmailSingleEvents");
  if (hasSendDock) pipelines.push("processSendDockEvents");
  if (hasMarkNotForSale) pipelines.push("processMarkNotForSaleEvents");
  return pipelines;
}

/* ----------------------------------------------------------
 *  SETUP & UTILITIES
 * ---------------------------------------------------------- */

/**
 * Run this ONCE after pasting code:
 *   Extensions → Apps Script → Run → setupSystem
 *
 * Creates the onChange installable trigger (if not already present)
 * and builds the custom menu.
 */
function setupSystem() {
  // ── 1. Ensure exactly ONE onChange trigger (remove duplicates/stale) ──
  var triggers = ScriptApp.getProjectTriggers();
  var matching = [];

  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "onSheetChange"
        && triggers[i].getEventType() === ScriptApp.EventType.ON_CHANGE) {
      matching.push(triggers[i]);
    }
  }

  // Keep one trigger, delete extras.
  if (matching.length > 1) {
    for (var d = 1; d < matching.length; d++) {
      ScriptApp.deleteTrigger(matching[d]);
    }
    console.log("setupSystem: removed " + (matching.length - 1) + " duplicate onChange trigger(s).");
  }

  if (matching.length === 0) {
    ScriptApp.newTrigger("onSheetChange")
      .forSpreadsheet(SpreadsheetApp.getActive())
      .onChange()
      .create();
    console.log("setupSystem: installed onChange trigger → onSheetChange");
  } else {
    console.log("setupSystem: single onChange trigger already installed.");
  }

  // ── 2. Build custom menu ──
  onOpen();

  // ── 3. Verify MPN state ──
  mpnPanel_initIfNeeded();
  console.log("setupSystem: done. NEXT_MPN = " + mpn_peekNextForWeb_());
}

/**
 * Reset error cursors WITHOUT destroying MPN state.
 * Only deletes LAST_PROCESSED_*_ROW keys — never deleteAllProperties().
 */
function purgeErrorsAndReset() {
  var props = PropertiesService.getScriptProperties();
  var keys = props.getKeys();
  var deleted = 0;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf("LAST_PROCESSED_") === 0 && keys[i].indexOf("_ROW") !== -1) {
      props.deleteProperty(keys[i]);
      deleted++;
    }
  }
  console.log("purgeErrorsAndReset: deleted " + deleted + " cursor keys. MPN state preserved.");

  // Remove bad/stuck event rows from the Events log block (A:G) only.
  // This compacts A:G upward without touching H:ZZ where the MPN panel lives.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var eventsSheet = ss.getSheetByName("Events");
  var removedRows = 0;
  if (eventsSheet) {
    var lastRow = eventsSheet.getLastRow();
    if (lastRow >= 2) {
      var rowCount = lastRow - 1;
      var eventRows = eventsSheet.getRange(2, 1, rowCount, 7).getValues();
      var keptRows = [];

      for (var r = 0; r < eventRows.length; r++) {
        var row = eventRows[r];
        var timestamp = String(row[0] || "").trim();
        var eventId = String(row[1] || "").trim();
        var eventType = String(row[2] || "").trim();
        var sku = String(row[3] || "").trim();
        var processedAt = String(row[5] || "").trim();
        var errorMsg = String(row[6] || "").trim();

        var hasAnyEventData = timestamp !== "" || eventId !== "" || eventType !== "" || sku !== "";
        var shouldPurge = false;

        if (hasAnyEventData) {
          if (errorMsg !== "") {
            shouldPurge = true;
          } else if (eventType !== "" && processedAt === "") {
            shouldPurge = true;
          }
        }

        if (shouldPurge) {
          removedRows++;
          continue;
        }

        keptRows.push(row);
      }

      if (keptRows.length > 0) {
        eventsSheet.getRange(2, 1, keptRows.length, 7).setValues(keptRows);
      }

      var clearedRows = rowCount - keptRows.length;
      if (clearedRows > 0) {
        eventsSheet.getRange(2 + keptRows.length, 1, clearedRows, 7).clearContent();
      }
    }
  }
  SpreadsheetApp.flush();
  SpreadsheetApp.getActive().toast(
    "Cursors reset. Purged " + removedRows + " bad/stuck Events row(s) from A:G. MPN safe.",
    "Reset Complete",
    5
  );
}

/**
 * Custom menu — built on open and by setupSystem.
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("⚡ Pipeline")
    .addItem("1. Setup System (run once)", "setupSystem")
    .addItem("2. Force Run Delete Dock", "processDeleteDockEvents")
    .addItem("3. Force Run Email Single", "processEmailSingleEvents")
    .addItem("4. Force Run Send Dock", "processSendDockEvents")
    .addSeparator()
    .addItem("5. Force Run ALL Pipelines", "forceRunAllPipelines")
    .addItem("6. Purge Errors & Reset Cursors", "purgeErrorsAndReset")
    .addToUi();
}

/**
 * Manual trigger: run all Apps Script-owned pipelines in sequence.
 */
function forceRunAllPipelines() {
  var t0 = Date.now();
  runPipelineSafe_("manual", "processDeleteDockEvents");
  runPipelineSafe_("manual", "processEmailSingleEvents");
  runPipelineSafe_("manual", "processSendDockEvents");
  console.log("forceRunAllPipelines: DONE " + (Date.now() - t0) + "ms");
  SpreadsheetApp.getActive().toast("All pipelines executed.", "Done", 3);
}
