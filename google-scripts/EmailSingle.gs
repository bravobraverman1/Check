// ============================================================
// EmailSingle.gs — Apps Script triggered by EMAIL_SINGLE events
// Sends an email with the SKU's 2-row CSV (header + data) as
// an attachment, removes the dock block, and marks the SKU as
// COMPLETE. Triggered by onChange via the Events sheet.
// ============================================================

// ═══════════════════════════════════════════════════════════════
//  CONFIG — Edit these values to customise email behaviour
// ═══════════════════════════════════════════════════════════════

const EMAIL_CONFIG = {
  // Alias email address to send FROM (must be configured in Gmail > Settings > Accounts > Send mail as)
  // Leave empty "" to use the default account email.
  SEND_FROM_ALIAS: "bravobraverman@gmail.com",

  // Recipients — comma-separated or array of email addresses
  SEND_TO: [
    "bravobraverman@gmail.com",
    "eran.braverman@lightingstyle.com.au"
    // "recipient2@example.com",
  ],

  // CC recipients (optional)
  CC: [],

  // BCC recipients (optional)
  BCC: [],

  // Subject template — [SKU] is replaced with the actual SKU
  SUBJECT_TEMPLATE: "TEST ONLY - [SKU] - Product Created",

  // Body template — supports these placeholders:
  //   [SKU]           → the product SKU
  //   [IMAGE_COUNT]   → number of non-empty image URLs
  //   [EMAIL_NOTES]   → email notes from the Loading Dock (row after SKU, column J)
  BODY_TEMPLATE:
    "SKU: [SKU]\n" +
    "NUMBER OF IMAGES: [IMAGE_COUNT]\n" +
    "---\n" +
    "[EMAIL_NOTES]",

  // CSV attachment filename template — [SKU] is replaced
  FILENAME_TEMPLATE: "[SKU].csv",

  // Sheet names (must match your workbook)
  LOADING_DOCK_SHEET: "Loading Dock",
  OUTPUT_WORK_SHEET: "OUTPUT_Work",
  OUTPUT_TEMPLATE_SHEET: "OUTPUT_Template",
  EVENTS_SHEET: "Events",

  // How many columns in the Loading Dock to export (header row 2 + data row)
  MAX_EXPORT_COLS: 200,

  // Re-scan this many rows behind the last cursor to self-heal missed trigger races
  REPROCESS_LOOKBACK_ROWS: 300,
  MAX_EVENTS_PER_RUN: 3,

  // Future-proof: add any additional config keys here
};

const EMAIL_SINGLE_MIN_IMAGE_SLOTS = 8;
const EMAIL_SINGLE_REQUIRED_POST_IMAGE_HEADER_KEYS = {
  searchkeywords: true,
  pagetitle: true,
  metakeywords: true,
  metadescription: true,
  myobassetacct: true,
  myobincomeacct: true,
  myobexpenseacct: true,
  productcondition: true,
  showproductcondition: true,
  eventdaterequired: true,
  eventdatename: true,
  eventdateislimited: true,
  eventdatestartdate: true,
  eventdateenddate: true,
  sortorder: true,
  producttaxclass: true,
  productupcean: true,
  stopprocessingrules: true,
  producturl: true,
  redirectoldurl: true,
  gpsmanufacturerpartnumber: true,
  gpscategory: true,
  gpsenabled: true,
  avalaraproducttaxcode: true,
  productcustomfields: true,
};

// ═══════════════════════════════════════════════════════════════
//  MAIN — Called from Triggers.gs onChange or directly
// ═══════════════════════════════════════════════════════════════

/**
 * Processes unhandled EMAIL_SINGLE / FORM_EMAIL events from the Events sheet.
 * EMAIL_SINGLE reads Loading Dock, emails the CSV, deletes the dock block,
 * and marks the SKU COMPLETE. FORM_EMAIL reads OUTPUT_Work, emails the CSV,
 * then resets OUTPUT_Work from OUTPUT_Template.
 */
function processEmailSingleEvents() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const eventsSheet = ss.getSheetByName(EMAIL_CONFIG.EVENTS_SHEET);
  const dockSheet = ss.getSheetByName(EMAIL_CONFIG.LOADING_DOCK_SHEET);
  const outputWorkSheet = ss.getSheetByName(EMAIL_CONFIG.OUTPUT_WORK_SHEET);
  const outputTemplateSheet = ss.getSheetByName(EMAIL_CONFIG.OUTPUT_TEMPLATE_SHEET);

  if (!eventsSheet) {
    Logger.log("EmailSingle: Events sheet not found.");
    return;
  }

  // Keep lock acquisition short so onChange executions don't run for minutes.
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1500)) {
    Logger.log("EmailSingle: skipped (lock busy, will retry on next onChange).");
    return;
  }

  try {
    const lastRow = eventsSheet.getLastRow();
    if (lastRow < 2) return;

    const lastProcessedKey = "LAST_PROCESSED_EMAIL_SINGLE_ROW";
    const props = PropertiesService.getScriptProperties();
    const lastProcessedRaw = parseInt(String(props.getProperty(lastProcessedKey) || ""), 10);
    const lastProcessed = Number.isFinite(lastProcessedRaw) ? lastProcessedRaw : 1;

    let startRow = Math.max(1, lastProcessed - EMAIL_CONFIG.REPROCESS_LOOKBACK_ROWS);
    if (startRow >= lastRow) {
      startRow = Math.max(1, lastRow - EMAIL_CONFIG.REPROCESS_LOOKBACK_ROWS);
    }

    const scanCount = lastRow - startRow;
    if (scanCount <= 0) return;

    const eventsData = eventsSheet.getRange(startRow + 1, 1, scanCount, 7).getValues();

    // Preload Loading Dock once for this invocation. The in-memory array is
    // kept aligned with sheet deletions so later events in the same run do not
    // use stale row numbers.
    const preloadedDockData = dockSheet ? dockSheet.getDataRange().getValues() : [];
    const completeSyncContext = emailSingle_createCompleteSyncContext_(ss);

    let foundUnprocessed = false;
    let processedThisRun = 0;
    const maxPerRun = Math.max(1, Number(EMAIL_CONFIG.MAX_EVENTS_PER_RUN) || 1);
    let lastCursorRow = startRow;
    const successfulEntries = [];

    for (let i = 0; i < eventsData.length; i++) {
      const row = eventsData[i];
      const rowIndex = i + startRow + 1;
      const eventType = String(row[2] || "").trim();   // Column C
      const sku = String(row[3] || "").trim();         // Column D
      const processedAt = String(row[5] || "").trim(); // Column F

      if ((eventType !== "EMAIL_SINGLE" && eventType !== "FORM_EMAIL") || processedAt) {
        if (eventType || processedAt || sku) lastCursorRow = rowIndex;
        continue;
      }

      foundUnprocessed = true;
      Logger.log("EmailSingle: Processing " + eventType + " for SKU " + sku + " at row " + rowIndex);

      try {
        var warning = "";
        if (eventType === "EMAIL_SINGLE") {
          if (!dockSheet) throw new Error("Loading Dock sheet not found.");
          sendEmailForSku_(ss, dockSheet, sku, preloadedDockData);
          emailSingle_queueSkuForCompleteSync_(completeSyncContext, sku);
        } else {
          warning = emailSingle_sendFormEmailFromOutputWork_(outputWorkSheet, outputTemplateSheet, sku);
        }
        successfulEntries.push({ rowIndex: rowIndex, sku: sku, warning: warning });
        Logger.log("EmailSingle: Successfully processed SKU " + sku);
      } catch (err) {
        eventsSheet.getRange(rowIndex, 6, 1, 2).setValues([[mpnPanel_melbTimestamp_(), "ERROR: " + String(err).substring(0, 200)]]);
        Logger.log("EmailSingle error for SKU " + sku + ": " + err);
      }

      lastCursorRow = rowIndex;
      processedThisRun++;
      if (processedThisRun >= maxPerRun) {
        Logger.log("EmailSingle: processed max events for this run (" + maxPerRun + ").");
        break;
      }
    }

    const completeWarningsBySku = emailSingle_flushQueuedCompleteSync_(completeSyncContext);
    for (var j = 0; j < successfulEntries.length; j++) {
      var processedEntry = successfulEntries[j];
      var warning = processedEntry.warning || completeWarningsBySku[String(processedEntry.sku || "").trim().toUpperCase()] || "";
      eventsSheet.getRange(processedEntry.rowIndex, 6, 1, 2).setValues([[mpnPanel_melbTimestamp_(), warning]]);
    }

    if (lastCursorRow > 1) {
      props.setProperty(lastProcessedKey, String(lastCursorRow));
    }

    if (!foundUnprocessed) {
      Logger.log("EmailSingle: No unprocessed EMAIL_SINGLE events found.");
    }
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function emailSingle_escapeHtml_(text) {
  return String(text || "")
    .replace(/°/g, "&deg;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/≤/g, "&le;")
    .replace(/≥/g, "&ge;");
}

function emailSingle_unescapeHtml_(text) {
  return String(text || "")
    .replace(/&deg;/g, "°")
    .replace(/&#39;/g, "'")
    .replace(/&eacute;/g, "é")
    .replace(/&le;/g, "≤")
    .replace(/&ge;/g, "≥")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function emailSingle_decodePossiblyEscapedHtml_(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;|#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function emailSingle_formatDescriptionHtml_(description, specData) {
  var transformedB7 = emailSingle_transform_INPUT_B7_(description || "");
  var transformedB4 = emailSingle_transform_INPUT_B4_(specData || "");
  if (!transformedB4) return transformedB7;
  if (!transformedB7) return transformedB4;
  return transformedB7 + transformedB4;
}

function emailSingle_transform_INPUT_B4_(cellText) {
  var text = String(cellText || "").trim();
  if (!text) return "";

  // Exact replacement order matching BigCommerce format
  text = text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00B0/g, "&deg;")
    .replace(/\u1D52/g, "&deg;")
    .replace(/\n/g, " <br/><strong>")
    .replace(/: /g, ":</strong> ")
    .replace(/\u2014/g, "-")
    .replace(/['\u2018\u2019]/g, "&#39;")
    .replace(/\u00E9/g, "&eacute;")
    .replace(/\u2265/g, "&ge;")
    .replace(/\u2013/g, "-");

  return "<p><strong>" + text + " <br/></p>";
}

function emailSingle_escapeDescriptionText_(text) {
  return String(text || "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00B0/g, "&deg;")
    .replace(/\u1D52/g, "&deg;")
    .replace(/\u2014/g, "-")
    .replace(/['\u2018\u2019]/g, "&#39;")
    .replace(/\u00E9/g, "&eacute;")
    .replace(/\u2265/g, "&ge;")
    .replace(/\u2013/g, "-");
}

function emailSingle_transform_INPUT_B7_(cellText) {
  if (cellText === "" || cellText === null || cellText === undefined) return "";
  var normalized = String(cellText).replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  return normalized
    .split(/\n\s*\n/)
    .map(function(paragraph) { return paragraph.trim(); })
    .filter(Boolean)
    .map(function(paragraph) {
      return "<p>" + emailSingle_escapeDescriptionText_(paragraph).replace(/\n/g, "<br/>") + "</p>";
    })
    .join("");
}

function emailSingle_parseDescriptionHtml_(htmlDesc) {
  if (!htmlDesc || !String(htmlDesc).trim()) return { description: "", specData: "" };

  var raw = emailSingle_decodePossiblyEscapedHtml_(htmlDesc);
  var specStartMatch = raw.match(/<(strong|b)>[^<]+?:\s*<\/\1>/i);
  if (!specStartMatch || specStartMatch.index === undefined) {
    var blocks = [];
    var pRegex = /<p>([\s\S]*?)<\/p>/gi;
    var m;
    while ((m = pRegex.exec(raw)) !== null) blocks.push(m[1]);
    if (blocks.length === 0) {
      return { description: emailSingle_unescapeHtml_(raw.replace(/<[^>]*>/g, "").trim()), specData: "" };
    }
    return {
      description: blocks
        .map(function(block) { return emailSingle_unescapeHtml_(block.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim()); })
        .filter(String)
        .join("\n\n"),
      specData: "",
    };
  }

  var descHtml = raw.slice(0, specStartMatch.index);
  var specHtml = raw.slice(specStartMatch.index).replace(/^<p>/i, "").replace(/<\/p>\s*$/i, "");

  var descBlocks = [];
  var descRegex = /<p>([\s\S]*?)<\/p>/gi;
  var descMatch;
  while ((descMatch = descRegex.exec(descHtml)) !== null) descBlocks.push(descMatch[1]);
  var description = descBlocks.length > 0
    ? descBlocks
        .map(function(block) { return emailSingle_unescapeHtml_(block.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim()); })
        .filter(String)
        .join("\n\n")
    : emailSingle_unescapeHtml_(descHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim());

  var specData = specHtml
    .split(/<br\s*\/?>/i)
    .map(function(line) {
      return emailSingle_unescapeHtml_(
        line
          .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "$2")
          .replace(/<[^>]*>/g, "")
          .trim()
      );
    })
    .filter(String)
    .join("\n");

  return { description: description, specData: specData };
}

function emailSingle_normalizeDescriptionCell_(value) {
  var parsed = emailSingle_parseDescriptionHtml_(value);
  if (!parsed.description && !parsed.specData) return String(value || "");
  return emailSingle_formatDescriptionHtml_(parsed.description, parsed.specData);
}

function emailSingle_normalizeSemicolonCell_(value) {
  return String(value || "")
    .split(";")
    .map(function(part) {
      var trimmed = part.trim();
      if (!trimmed) return "";

      var eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) return trimmed;

      var key = trimmed.slice(0, eqIndex).trim();
      var rawValue = trimmed.slice(eqIndex + 1).trim();
      if (!key) return trimmed;

      return key + "=" + emailSingle_formatDimensionValueForCsv_(key, rawValue);
    })
    .filter(Boolean)
    .join(";");
}

function emailSingle_isImageUrlHeader_(headerName) {
  var normalized = String(headerName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return /^product image file\s*-\s*\d+$/i.test(normalized) ||
    /^image file\s*-\s*\d+$/i.test(normalized) ||
    /^image url\s*-\s*\d+$/i.test(normalized);
}

function emailSingle_normalizeImageFileCell_(value) {
  return String(value == null ? "" : value)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

function emailSingle_isRealImageFileValue_(value) {
  var normalized = emailSingle_normalizeImageFileCell_(value);
  if (!normalized) return false;
  var lowered = normalized.toLowerCase();
  return lowered !== "0" && lowered !== "false" && lowered !== "n"
    && lowered !== "none" && lowered !== "null" && lowered !== "undefined"
    && lowered !== "n/a" && lowered !== "na" && lowered !== "-" && lowered !== "--";
}

function emailSingle_getImageSlotInfo_(headerRow, dataRow, maxCols) {
  var lastColBySlot = {};
  var highestPopulatedSlot = 0;
  var hasImageHeaders = false;
  var limit = Math.min(headerRow.length, maxCols);

  for (var c = 0; c < limit; c++) {
    var header = String(headerRow[c] || "").trim();
    var match = header.match(/^Product Image (ID|File|Description|Is Thumbnail|Sort)\s*-\s*(\d+)$/i);
    if (!match) continue;
    var slot = parseInt(match[2], 10);
    if (!slot || slot < 1) continue;
    hasImageHeaders = true;
    lastColBySlot[slot] = Math.max(lastColBySlot[slot] || -1, c);
    if (match[1].toLowerCase() === "file" && emailSingle_isRealImageFileValue_(dataRow[c])) {
      highestPopulatedSlot = Math.max(highestPopulatedSlot, slot);
    }
  }

  if (!hasImageHeaders) return { requiredSlotCount: 0, lastRequiredCol: -1 };

  var requiredSlots = Math.max(EMAIL_SINGLE_MIN_IMAGE_SLOTS, highestPopulatedSlot);
  var lastRequiredCol = -1;
  for (var slot2 = 1; slot2 <= requiredSlots; slot2++) {
    if (typeof lastColBySlot[slot2] === "number") {
      lastRequiredCol = Math.max(lastRequiredCol, lastColBySlot[slot2]);
    }
  }
  return { requiredSlotCount: requiredSlots, lastRequiredCol: lastRequiredCol };
}

function emailSingle_getRequiredImageSlotLastCol_(headerRow, dataRow, maxCols) {
  return emailSingle_getImageSlotInfo_(headerRow, dataRow, maxCols).lastRequiredCol;
}

function emailSingle_normalizeHeaderKey_(header) {
  return String(header || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function emailSingle_shouldSkipExcessImageSlotCol_(header, value, requiredSlotCount) {
  var match = String(header || "").trim().match(/^Product Image (ID|File|Description|Is Thumbnail|Sort)\s*-\s*(\d+)$/i);
  if (!match) return false;
  var slot = parseInt(match[2], 10);
  // Skip ALL columns of excess slots (even if they have default Sort/Thumbnail values)
  return !!slot && slot > requiredSlotCount;
}

function emailSingle_getRequiredPostImageLastCol_(headerRow, maxCols) {
  var lastProtectedCol = -1;
  for (var c = 0; c < Math.min(headerRow.length, maxCols); c++) {
    var key = emailSingle_normalizeHeaderKey_(headerRow[c]);
    if (EMAIL_SINGLE_REQUIRED_POST_IMAGE_HEADER_KEYS[key]) lastProtectedCol = c;
  }
  return lastProtectedCol;
}

function emailSingle_findColByAliases_(headers, aliases) {
  var normalizedAliases = (aliases || []).map(function(alias) {
    return String(alias || "").trim().toLowerCase();
  }).filter(Boolean);
  for (var i = 0; i < headers.length; i++) {
    var key = String(headers[i] || "").trim().toLowerCase();
    if (normalizedAliases.indexOf(key) !== -1) return i;
  }
  return -1;
}

function emailSingle_isSemicolonListHeader_(headerName) {
  var key = String(headerName || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "category"
    || key === "categories"
    || key === "gpscategory"
    || key === "productcustomfields"
    || key === "customfields"
    || key === "filters"
    || key === "attributes"
    || key === "specifications";
}

function emailSingle_normalizeDimensionHeader_(headerName) {
  return String(headerName || "")
    .replace(/\*/g, "")
    .replace(/\s*#\d+\s*$/i, "")
    .replace(/\s*\([^)]*\)\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function emailSingle_isDimensionFilterHeader_(headerName) {
  var key = emailSingle_normalizeDimensionHeader_(headerName);
  return key === "airmovement" || key === "fancutout";
}

function emailSingle_formatDimensionValueForCsv_(headerName, value) {
  if (!emailSingle_isDimensionFilterHeader_(headerName)) return String(value == null ? "" : value).trim();

  var normalizedHeader = emailSingle_normalizeDimensionHeader_(headerName);
  var trimmed = String(value == null ? "" : value).trim();
  if (!trimmed) return "";

  if (normalizedHeader === "airmovement") {
    var airMovementMatch = trimmed.match(/^\s*(\d+(?:\.\d+)?)\s*(?:m(?:\^?3|³)\/h)?\s*$/i);
    return airMovementMatch ? airMovementMatch[1] + "m³/h" : trimmed;
  }

  var pairMatch = trimmed.match(/^\s*(\d+(?:\.\d+)?)\s*(?:cm)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:cm)?\s*$/i);
  if (pairMatch) return pairMatch[1] + "cm x " + pairMatch[2] + "cm";

  var diameterMatch = trimmed.match(/^\s*(?:diameter\s*:?\s*)?(\d+(?:\.\d+)?)\s*(?:cm)?(?:\s*\(\s*diameter\s*\))?\s*$/i);
  if (diameterMatch) return diameterMatch[1] + "cm (DIAMETER)";

  return trimmed;
}

function emailSingle_buildMailPayloadFromRows_(headerRow, dataRow, emailRow, fallbackSku) {
  const resolvedSku = String(
    fallbackSku
    || dataRow[emailSingle_findColByAliases_(headerRow, ["Product Code/SKU", "Product ID", "SKU"])]
    || ""
  ).trim();
  if (!resolvedSku) throw new Error("SKU is missing from the staged row.");

  var imageSlotInfo = emailSingle_getImageSlotInfo_(headerRow, dataRow, EMAIL_CONFIG.MAX_EXPORT_COLS);
  var requiredPostImageLastCol = emailSingle_getRequiredPostImageLastCol_(headerRow, EMAIL_CONFIG.MAX_EXPORT_COLS);
  let lastCol = 0;
  for (let c = 0; c < Math.min(headerRow.length, EMAIL_CONFIG.MAX_EXPORT_COLS); c++) {
    if (emailSingle_shouldSkipExcessImageSlotCol_(headerRow[c], dataRow[c], imageSlotInfo.requiredSlotCount)) continue;
    if (String(headerRow[c] || "").trim() || String(dataRow[c] || "").trim()) {
      lastCol = c;
    }
  }
  lastCol = Math.max(lastCol, imageSlotInfo.lastRequiredCol, requiredPostImageLastCol);

  const selectedCols = [];
  for (let c2 = 0; c2 <= lastCol; c2++) {
    if (emailSingle_shouldSkipExcessImageSlotCol_(headerRow[c2], dataRow[c2], imageSlotInfo.requiredSlotCount)) continue;
    selectedCols.push(c2);
  }

  const csvHeader = selectedCols.map(function(idx) { return csvEscape_(headerRow[idx]); });
  const exportRow = selectedCols.map(function(idx) { return dataRow[idx]; });
  for (let i = 0; i < selectedCols.length; i++) {
    const headerIndex = selectedCols[i];
    const headerName = String(headerRow[headerIndex] || "").trim().toLowerCase();
    if (headerName === "product description" || headerName === "description") {
      exportRow[i] = emailSingle_normalizeDescriptionCell_(exportRow[i]);
      continue;
    }
    if (emailSingle_isSemicolonListHeader_(headerName)) {
      exportRow[i] = emailSingle_normalizeSemicolonCell_(exportRow[i]);
      continue;
    }
    exportRow[i] = emailSingle_formatDimensionValueForCsv_(headerRow[headerIndex], exportRow[i]);
  }
  const csvData = exportRow.map(csvEscape_);

  let imageCount = 0;
  for (let c3 = 0; c3 <= lastCol; c3++) {
    const h = String(headerRow[c3] || "").trim();
    if (emailSingle_isImageUrlHeader_(h) && String(dataRow[c3] || "").trim()) {
      imageCount++;
    }
  }

  const emailNotesCol = emailSingle_findColByAliases_(headerRow, ["Product Description", "Description"]);
  const emailNotesIdx = emailNotesCol !== -1 ? emailNotesCol : 9;
  const emailNotes = String((emailRow || [])[emailNotesIdx] || "").trim();

  return {
    sku: resolvedSku,
    csvText: csvHeader.join(",") + "\n" + csvData.join(","),
    imageCount: imageCount,
    emailNotes: emailNotes,
  };
}

function emailSingle_resetOutputWorkFromTemplate_(templateSheet, workSheet) {
  if (!templateSheet || !workSheet) {
    throw new Error("OUTPUT_Template or OUTPUT_Work sheet not found.");
  }
  workSheet.clear();
  var templateRange = templateSheet.getDataRange();
  templateRange.copyTo(workSheet.getRange(1, 1, templateRange.getNumRows(), templateRange.getNumColumns()));
}

function emailSingle_sendFormEmailFromOutputWork_(outputWorkSheet, outputTemplateSheet, expectedSku) {
  if (!outputWorkSheet) throw new Error("OUTPUT_Work sheet not found.");
  if (!outputTemplateSheet) throw new Error("OUTPUT_Template sheet not found.");

  var workData = outputWorkSheet.getDataRange().getValues();
  if (!Array.isArray(workData) || workData.length < 3) {
    throw new Error("OUTPUT_Work does not contain the staged form email rows.");
  }

  var headerRow = workData[0] || [];
  var dataRow = workData[1] || [];
  var emailRow = workData[2] || [];
  var payload = emailSingle_buildMailPayloadFromRows_(headerRow, dataRow, emailRow, expectedSku);
  if (expectedSku && payload.sku.toUpperCase() !== String(expectedSku || "").trim().toUpperCase()) {
    throw new Error("OUTPUT_Work SKU does not match the queued form email SKU.");
  }

  var resetWarning = "";
  var sendError = null;
  try {
    emailSingle_sendMail_(payload.sku, payload.csvText, payload.imageCount, payload.emailNotes);
  } catch (err) {
    sendError = err;
  } finally {
    try {
      emailSingle_resetOutputWorkFromTemplate_(outputTemplateSheet, outputWorkSheet);
    } catch (resetErr) {
      if (sendError) {
        Logger.log("EmailSingle: OUTPUT_Work reset failed after form email error: " + resetErr);
      } else {
        resetWarning = "WARN: Email sent, but OUTPUT_Work could not be reset.";
      }
    }
  }

  if (sendError) throw sendError;
  return resetWarning;
}

/**
 * Finds the SKU in Loading Dock (column E), builds a 2-row CSV,
 * counts images, reads email notes, and sends the email.
 * Returns true on success.
 */
function sendEmailForSku_(ss, dockSheet, sku, preloadedDockData) {
  if (!EMAIL_CONFIG.SEND_TO || EMAIL_CONFIG.SEND_TO.length === 0) {
    throw new Error("No recipients configured in EMAIL_CONFIG.SEND_TO");
  }

  // Read Loading Dock once per invocation when available (batch I/O)
  const dockData = Array.isArray(preloadedDockData) && preloadedDockData.length > 0
    ? preloadedDockData
    : dockSheet.getDataRange().getValues();

  // Find SKU in the Loading Dock using block structure (4-row blocks starting at row 2)
  // Block layout: Header | Product | Email | Blank
  let skuRowIdx = -1;
  let blockHeaderIdx = -1;
  for (var headerIdx = 1; headerIdx < dockData.length; headerIdx += 4) {
    var productIdx = headerIdx + 1;
    if (productIdx >= dockData.length) break;
    var headers = dockData[headerIdx];
    var skuCol = -1;
    for (var c = 0; c < headers.length; c++) {
      if (String(headers[c] || "").trim() === "Product Code/SKU") { skuCol = c; break; }
    }
    if (skuCol === -1) continue;
    if (String(dockData[productIdx][skuCol] || "").trim().toUpperCase() === sku.toUpperCase()) {
      skuRowIdx = productIdx;
      blockHeaderIdx = headerIdx;
      break;
    }
  }

  if (skuRowIdx === -1) {
    throw new Error('SKU "' + sku + '" not found in Loading Dock');
  }

  // Use the block's OWN header row (not a fixed row)
  const headerRow = dockData[blockHeaderIdx] || [];
  const dataRow = dockData[skuRowIdx] || [];

  const emailRow = skuRowIdx + 1 < dockData.length ? (dockData[skuRowIdx + 1] || []) : [];
  const payload = emailSingle_buildMailPayloadFromRows_(headerRow, dataRow, emailRow, sku);
  emailSingle_sendMail_(payload.sku, payload.csvText, payload.imageCount, payload.emailNotes);

  // ── Delete 4-row block from Loading Dock AFTER successful send ──
  // blockHeaderIdx is 0-based array index; sheet rows are 1-based.
  var blockStartSheetRow = blockHeaderIdx + 1;
  dockSheet.deleteRows(blockStartSheetRow, 4);
  if (Array.isArray(dockData) && blockHeaderIdx >= 0) {
    dockData.splice(blockHeaderIdx, 4);
  }
  Logger.log("Deleted 4-row block for SKU " + sku + " starting at sheet row " + blockStartSheetRow);

  return true;
}

function emailSingle_createCompleteSyncContext_(ss) {
  var sheet = ss.getSheetByName("PRODUCTS TO DO");
  if (!sheet) {
    return {
      sheet: null,
      data: null,
      lastRow: 0,
      queuedSkus: [],
    };
  }

  var lastRow = sheet.getLastRow();
  var data = lastRow >= 2 ? sheet.getRange(1, 1, lastRow, 4).getValues() : [];
  return {
    sheet: sheet,
    data: data,
    lastRow: lastRow,
    queuedSkus: [],
  };
}

function emailSingle_queueSkuForCompleteSync_(context, sku) {
  if (!context || !sku) return;
  context.queuedSkus.push(String(sku || "").trim());
}

function emailSingle_flushQueuedCompleteSync_(context) {
  var warningsBySku = {};
  if (!context || !Array.isArray(context.queuedSkus) || context.queuedSkus.length === 0) {
    return warningsBySku;
  }

  var queuedSkus = [];
  var queuedSet = {};
  for (var i = 0; i < context.queuedSkus.length; i++) {
    var queuedSku = String(context.queuedSkus[i] || "").trim();
    var normalizedQueuedSku = queuedSku.toUpperCase();
    if (!normalizedQueuedSku || queuedSet[normalizedQueuedSku]) continue;
    queuedSet[normalizedQueuedSku] = true;
    queuedSkus.push(queuedSku);
  }

  if (!context.sheet) {
    for (var missingSheetIdx = 0; missingSheetIdx < queuedSkus.length; missingSheetIdx++) {
      warningsBySku[queuedSkus[missingSheetIdx].toUpperCase()] =
        "WARN: Email sent and dock removed, but PRODUCTS TO DO was not available for COMPLETE sync.";
    }
    return warningsBySku;
  }

  if (!Array.isArray(context.data) || context.lastRow < 2) {
    for (var emptySheetIdx = 0; emptySheetIdx < queuedSkus.length; emptySheetIdx++) {
      warningsBySku[queuedSkus[emptySheetIdx].toUpperCase()] =
        "WARN: Email sent and dock removed, but COMPLETE status could not be updated.";
    }
    return warningsBySku;
  }

  var foundSkuSet = {};
  var changed = false;
  for (var rowIdx = 1; rowIdx < context.data.length; rowIdx++) {
    var rowSku = String(context.data[rowIdx][0] || "").trim();
    var normalizedRowSku = rowSku.toUpperCase();
    if (!normalizedRowSku || !queuedSet[normalizedRowSku]) continue;
    foundSkuSet[normalizedRowSku] = true;
    if (String(context.data[rowIdx][2] || "").trim() !== "COMPLETE") {
      context.data[rowIdx][2] = "COMPLETE";
      changed = true;
    }
  }

  for (var queuedIdx = 0; queuedIdx < queuedSkus.length; queuedIdx++) {
    var normalizedQueued = queuedSkus[queuedIdx].toUpperCase();
    if (!foundSkuSet[normalizedQueued]) {
      warningsBySku[normalizedQueued] =
        "WARN: Email sent and dock removed, but SKU was not found in PRODUCTS TO DO for COMPLETE sync.";
    }
  }

  if (!changed) {
    return warningsBySku;
  }

  try {
    context.sheet.getRange(1, 1, context.lastRow, 4).setValues(context.data);
  } catch (err) {
    for (var writeFailIdx = 0; writeFailIdx < queuedSkus.length; writeFailIdx++) {
      warningsBySku[queuedSkus[writeFailIdx].toUpperCase()] =
        "WARN: Email sent and dock removed, but COMPLETE status could not be updated.";
    }
    Logger.log("EmailSingle COMPLETE sync error: " + err);
  }

  return warningsBySku;
}

function emailSingle_sendMail_(sku, csvText, imageCount, emailNotes) {
  if (!EMAIL_CONFIG.SEND_TO || EMAIL_CONFIG.SEND_TO.length === 0) {
    throw new Error("No recipients configured in EMAIL_CONFIG.SEND_TO");
  }

  const subject = EMAIL_CONFIG.SUBJECT_TEMPLATE.replace(/\[SKU\]/g, sku);
  const body = EMAIL_CONFIG.BODY_TEMPLATE
    .replace(/\[SKU\]/g, sku)
    .replace(/\[IMAGE_COUNT\]/g, String(imageCount))
    .replace(/\[EMAIL_NOTES\]/g, emailNotes || "(No email notes)");
  const filename = EMAIL_CONFIG.FILENAME_TEMPLATE.replace(/\[SKU\]/g, sku);

  const mailOptions = {
    to: EMAIL_CONFIG.SEND_TO.join(","),
    subject: subject,
    body: body,
    attachments: [
      Utilities.newBlob(csvText, "text/csv", filename),
    ],
  };

  if (EMAIL_CONFIG.CC && EMAIL_CONFIG.CC.length > 0) {
    mailOptions.cc = EMAIL_CONFIG.CC.join(",");
  }
  if (EMAIL_CONFIG.BCC && EMAIL_CONFIG.BCC.length > 0) {
    mailOptions.bcc = EMAIL_CONFIG.BCC.join(",");
  }

  var usedAlias = false;
  if (EMAIL_CONFIG.SEND_FROM_ALIAS) {
    try {
      GmailApp.sendEmail(
        mailOptions.to,
        mailOptions.subject,
        mailOptions.body,
        {
          from: EMAIL_CONFIG.SEND_FROM_ALIAS,
          cc: mailOptions.cc || "",
          bcc: mailOptions.bcc || "",
          attachments: mailOptions.attachments,
        }
      );
      usedAlias = true;
    } catch (aliasErr) {
      Logger.log("EmailSingle: send via alias failed, retrying with default sender. Error: " + aliasErr);
    }
  }

  if (!usedAlias) {
    GmailApp.sendEmail(
      mailOptions.to,
      mailOptions.subject,
      mailOptions.body,
      {
        cc: mailOptions.cc || "",
        bcc: mailOptions.bcc || "",
        attachments: mailOptions.attachments,
      }
    );
  }

  Logger.log("Email sent for SKU: " + sku + " to " + mailOptions.to);
}

/** Escapes a cell value for CSV (handles commas, quotes, newlines) */
function csvEscape_(val) {
  const s = String(val == null ? "" : val);
  if (s.indexOf(",") >= 0 || s.indexOf('"') >= 0 || s.indexOf("\n") >= 0) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
