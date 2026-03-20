/*************************************************************
 * EventsCleanup.gs — v1.1
 *
 * Compacts ONLY the Events log block in columns A:G when the
 * timestamp in column A is older than 20 days.
 *
 * Safe guards:
 * - Never deletes sheet rows
 * - Never touches columns H:ZZ
 * - Never touches the header row
 * - Skips blank / unparsable timestamps
 *************************************************************/

var EVENTS_CLEANUP = {
  SHEET: "Events",
  HEADER_ROWS: 1,
  TIMESTAMP_COL: 1,
  LOG_COLS: 7,
  RETENTION_DAYS: 20,
  DAILY_TRIGGER_FN: "cleanupOldEvents",
};

function cleanupOldEvents() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(EVENTS_CLEANUP.SHEET);
  if (!sh) throw new Error('Sheet "' + EVENTS_CLEANUP.SHEET + '" not found.');

  var lastRow = sh.getLastRow();
  if (lastRow <= EVENTS_CLEANUP.HEADER_ROWS) return 0;

  var rowCount = lastRow - EVENTS_CLEANUP.HEADER_ROWS;
  var eventRows = sh.getRange(
    EVENTS_CLEANUP.HEADER_ROWS + 1,
    EVENTS_CLEANUP.TIMESTAMP_COL,
    rowCount,
    EVENTS_CLEANUP.LOG_COLS
  ).getValues();
  var cutoffMs = Date.now() - (EVENTS_CLEANUP.RETENTION_DAYS * 24 * 60 * 60 * 1000);
  var keptRows = [];
  var removedCount = 0;

  for (var i = 0; i < eventRows.length; i++) {
    var row = eventRows[i];
    var tsMs = eventsCleanup_parseTimestampMs_(row[0]);
    if (tsMs && tsMs < cutoffMs) {
      removedCount++;
      continue;
    }
    keptRows.push(row);
  }

  if (removedCount === 0) {
    ss.toast("No Events rows older than " + EVENTS_CLEANUP.RETENTION_DAYS + " days.", "Automation", 5);
    return 0;
  }

  if (keptRows.length > 0) {
    sh.getRange(
      EVENTS_CLEANUP.HEADER_ROWS + 1,
      EVENTS_CLEANUP.TIMESTAMP_COL,
      keptRows.length,
      EVENTS_CLEANUP.LOG_COLS
    ).setValues(keptRows);
  }

  var clearedRows = rowCount - keptRows.length;
  if (clearedRows > 0) {
    sh.getRange(
      EVENTS_CLEANUP.HEADER_ROWS + 1 + keptRows.length,
      EVENTS_CLEANUP.TIMESTAMP_COL,
      clearedRows,
      EVENTS_CLEANUP.LOG_COLS
    ).clearContent();
  }

  ss.toast(
    "Cleaned " + removedCount + " old Events row(s) from A:G. Columns H:ZZ were left untouched.",
    "Automation",
    5
  );
  return removedCount;
}

function setupDailyEventsCleanupTrigger() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === EVENTS_CLEANUP.DAILY_TRIGGER_FN) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger(EVENTS_CLEANUP.DAILY_TRIGGER_FN)
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();

  ss.toast("Daily Events cleanup trigger installed.", "Automation", 5);
}

function eventsCleanup_parseTimestampMs_(value) {
  if (value instanceof Date) {
    var dateMs = value.getTime();
    return isFinite(dateMs) ? dateMs : 0;
  }

  if (typeof value === "number" && isFinite(value) && value > 0) {
    return Math.round((value - 25569) * 86400000);
  }

  var raw = String(value || "").trim();
  if (!raw) return 0;

  var parsed = Date.parse(raw);
  if (isFinite(parsed)) return parsed;

  var melbMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: (AEST|AEDT))?$/);
  if (melbMatch) {
    var offset = melbMatch[7] === "AEST" ? "+10:00" : "+11:00";
    var iso = melbMatch[1] + "-" + melbMatch[2] + "-" + melbMatch[3] + "T" + melbMatch[4] + ":" + melbMatch[5] + ":" + melbMatch[6] + offset;
    var isoMs = Date.parse(iso);
    return isFinite(isoMs) ? isoMs : 0;
  }

  var auMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (auMatch) {
    var day = Number(auMatch[1]);
    var month = Number(auMatch[2]) - 1;
    var year = Number(auMatch[3]);
    var hour = Number(auMatch[4]);
    var minute = Number(auMatch[5]);
    var second = Number(auMatch[6] || "0");
    var localMs = new Date(year, month, day, hour, minute, second).getTime();
    return isFinite(localMs) ? localMs : 0;
  }

  return 0;
}
