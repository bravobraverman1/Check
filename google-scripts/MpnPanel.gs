/*************************************************************
 * MPN PANEL (Events tab) — MELBOURNE TIME — v5.0
 *
 * Important:
 * - The edge function / DB allocator is the MPN source of truth.
 * - The Events panel in column I is a mirrored status block.
 * - Existing Google Sheets drawing buttons should stay assigned to:
 *   1. mpn_incrementForProducts
 *   2. mpn_getNewForEran
 *   Those functions now delegate to the edge function so the sheet stays
 *   in sync with the form and concurrent users.
 *
 * Events columns:
 * A Timestamp | B Event_ID | C Event_Type | D SKU | E MPN | F Processed_At | G Error
 *
 * Control panel in column I:
 * I3 = "NEXT_MPN" label | I4 = next MPN (mirrored value) | I5 = status
 * I6 = (blank) | I7 = Eran message | I8 = Eran reserved value
 *************************************************************/

const MPN_PANEL = {
  SHEET: "Events",
  CELL_LABEL: "I3",
  CELL_NEXT: "I4",
  CELL_STATUS: "I5",
  CELL_UNUSED: "I6",
  CELL_ERAN_MSG: "I7",
  CELL_ERAN_VALUE: "I8",
  TZ: "Australia/Melbourne",
  TS_FORMAT: "yyyy-MM-dd HH:mm:ss z",
  STATUS_FORMAT: "yyyy-MM-dd HH:mm:ss",
  DEFAULT_START: 57324,
  EDGE_URL_PROP: "SUPABASE_GOOGLE_SHEETS_EDGE_URL",
  EDGE_ANON_KEY_PROP: "SUPABASE_GOOGLE_SHEETS_EDGE_ANON_KEY",
};

function mpnPanel_melbTimestamp_() {
  return Utilities.formatDate(new Date(), MPN_PANEL.TZ, MPN_PANEL.TS_FORMAT);
}

function mpnPanel_melbStatusTime_() {
  return Utilities.formatDate(new Date(), MPN_PANEL.TZ, MPN_PANEL.STATUS_FORMAT);
}

function mpnPanel_initIfNeeded(defaultStart) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MPN_PANEL.SHEET);
  if (!sh) throw new Error('Sheet "' + MPN_PANEL.SHEET + '" not found.');

  // Batch read I3:I4

  var vals = sh.getRange("I3:I4").getValues();
  if (String(vals[0][0]).trim() !== "NEXT_MPN") {
    sh.getRange(MPN_PANEL.CELL_LABEL).setValue("NEXT_MPN");
  }
  sh.getRange(MPN_PANEL.CELL_UNUSED).clearContent();
  sh.getRange(MPN_PANEL.CELL_NEXT).setNumberFormat("0");

  var start = (defaultStart == null) ? MPN_PANEL.DEFAULT_START : Number(defaultStart);
  var v = Number(vals[1][0]);
  if (!Number.isFinite(v) || v <= 0) {
    sh.getRange(MPN_PANEL.CELL_NEXT).setValue(start);
    sh.getRange(MPN_PANEL.CELL_STATUS).setValue("Initialized NEXT_MPN to " + start);
  }
}

function mpnPanel_getNext_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MPN_PANEL.SHEET);
  var v = Number(sh.getRange(MPN_PANEL.CELL_NEXT).getValue());
  if (!Number.isFinite(v) || v <= 0) throw new Error("Events!I4 (NEXT_MPN) is not a valid number.");
  return v;
}

function mpnPanel_parseMpnNumber_(mpnValue) {
  if (mpnValue == null || mpnValue === "") return "";
  if (typeof mpnValue === "number") return Number.isFinite(mpnValue) ? mpnValue : "";
  var m = String(mpnValue).trim().match(/^(\d+)/);
  return m ? Number(m[1]) : "";
}

/** Find first blank row in column A starting from row 2 — batch read */
function mpnPanel_firstBlankRowFrom2_(sh) {
  var max = sh.getLastRow();
  if (max < 2) return 2;
  var colA = sh.getRange(2, 1, max - 1, 1).getValues();
  for (var i = 0; i < colA.length; i++) {
    if (colA[i][0] === "" || colA[i][0] === null) return i + 2;
  }
  sh.insertRowsAfter(max, 50);
  return max + 1;
}

/** Log event — single setValues call */
function mpnPanel_logEvent_(_ref) {
  var eventType = _ref.eventType, sku = _ref.sku, mpnValue = _ref.mpnValue, error = _ref.error;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MPN_PANEL.SHEET);
  if (!sh) return;

  var rowIndex = mpnPanel_firstBlankRowFrom2_(sh);
  var ts = mpnPanel_melbTimestamp_();
  var eventId = "EVT-" + Date.now();
  var mpnNum = mpnPanel_parseMpnNumber_(mpnValue);

  sh.getRange(rowIndex, 1, 1, 7).setValues([[
    ts, eventId, eventType || "", sku || "",
    mpnNum === "" ? "" : Number(mpnNum), ts, (error ? String(error) : "")
  ]]);
  sh.getRange(rowIndex, 5).setNumberFormat("0");
}

/** Peek at NEXT_MPN without incrementing (used before commit) */
function mpn_peekNextForWeb_() {
  return mpnPanel_getNext_();
}

/**
 * Legacy no-op compatibility wrapper.
 * Do not mutate NEXT_MPN in Apps Script anymore.
 * MPN allocation/commit lives in the edge function + DB allocator.
 * If this is called by stale code, log the event only.
 */
function mpn_commitReservedForWeb_(sku, reservedMpn) {
  mpnPanel_logEvent_({
    eventType: "MPN_RESERVE_WEB",
    sku: sku || "",
    mpnValue: reservedMpn,
    error: "[legacy apps-script commit ignored; DB allocator is source of truth]"
  });
  return {
    success: true,
    ignored: true,
    mpn: reservedMpn == null ? "" : Number(reservedMpn),
  };
}

/**
 * Legacy no-op compatibility wrapper.
 * Do not reserve/increment MPNs inside Apps Script anymore.
 * The edge function resolves MPN state and writes any mirrored status itself.
 */
function mpn_reserveForFormAction_(sku, source) {
  var safeSource = String(source || "Form").trim() || "Form";
  mpnPanel_logEvent_({
    eventType: "MPN_LEGACY_FORM_CALL",
    sku: sku || "",
    mpnValue: "",
    error: "[" + safeSource + " legacy apps-script reserve ignored; DB allocator is source of truth]"
  });
  return {
    success: true,
    ignored: true,
    mpn: "",
    mpnL: "",
    nextMpn: mpn_peekNextForWeb_(),
    status: "Ignored legacy Apps Script reserve call"
  };
}

/** BUTTON #1: Manual increment via edge allocator */
function mpn_incrementForProducts() {
  mpnPanel_initIfNeeded();
  var result = mpnPanel_callEdgeAction_("mpn-increment");
  SpreadsheetApp.flush();
  return result;
}

/** BUTTON #2: Eran reserve via edge allocator */
function mpn_getNewForEran() {
  mpnPanel_initIfNeeded();
  var result = mpnPanel_callEdgeAction_("mpn-eran");
  SpreadsheetApp.flush();
  return {
    mpn: Number(result.reservedMpn),
    mpnL: String(result.reservedMpn) + "-L"
  };
}

/** ERROR LOGGING — writes to Column G of the Events tab via logEvent */
function mpnPanel_logError_(context, err, sku) {
  try {
    var msg = (err && err.message) ? String(err.message) : String(err);
    var detail = context ? "[" + context + "] " + msg : msg;
    mpnPanel_logEvent_({
      eventType: "ERROR",
      sku: sku || "",
      mpnValue: "",
      error: detail
    });
  } catch (e) {
    console.error("Critical: Could not log error to Events sheet", e);
  }
}

/** PROPERTIES SERVICE HELPERS */
function mpnPanel_getScriptProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function mpnPanel_setScriptProp_(key, val) {
  PropertiesService.getScriptProperties().setProperty(key, String(val));
}

function mpnPanel_getEdgeUrl_() {
  return String(
    mpnPanel_getScriptProp_(MPN_PANEL.EDGE_URL_PROP) ||
    mpnPanel_getScriptProp_("GOOGLE_SHEETS_EDGE_URL") ||
    ""
  ).trim();
}

function mpnPanel_getEdgeAnonKey_() {
  return String(
    mpnPanel_getScriptProp_(MPN_PANEL.EDGE_ANON_KEY_PROP) ||
    mpnPanel_getScriptProp_("GOOGLE_SHEETS_EDGE_ANON_KEY") ||
    ""
  ).trim();
}

function mpnPanel_callEdgeAction_(actionName, extraPayload) {
  var edgeUrl = mpnPanel_getEdgeUrl_();
  if (!edgeUrl) {
    throw new Error("Set script property SUPABASE_GOOGLE_SHEETS_EDGE_URL before using MPN panel buttons.");
  }

  var payload = {
    action: String(actionName || "").trim(),
    tabNames: { EVENTS: MPN_PANEL.SHEET }
  };

  if (extraPayload && typeof extraPayload === "object") {
    for (var key in extraPayload) {
      if (Object.prototype.hasOwnProperty.call(extraPayload, key)) {
        payload[key] = extraPayload[key];
      }
    }
  }

  var headers = { "Content-Type": "application/json" };
  var anonKey = mpnPanel_getEdgeAnonKey_();
  if (anonKey) {
    headers.apikey = anonKey;
    headers.Authorization = "Bearer " + anonKey;
  }

  var response = UrlFetchApp.fetch(edgeUrl, {
    method: "post",
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var responseText = response.getContentText() || "";
  var body = {};
  if (responseText) {
    try {
      body = JSON.parse(responseText);
    } catch (err) {
      throw new Error("Edge function returned non-JSON: " + responseText);
    }
  }

  var code = response.getResponseCode();
  if (code < 200 || code >= 300 || body.success === false) {
    throw new Error(body.error || ("Edge action failed (" + code + ")"));
  }

  return body;
}
