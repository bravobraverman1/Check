/*************************************************************
 * SendDock.gs — v1.0  Batch Send & Clear
 *
 * Processes SEND_DOCK events from the Events tab.
 * A single event carries a comma-separated list of SKUs in
 * Column D. This script:
 *  1. Reads the Loading Dock sheet ONCE (batch I/O).
 *  2. For each SKU — optionally sends an email (if mode=SEND),
 *     then deletes the 4-row block.
 *  3. Deletes blocks in REVERSE order so row indexes stay valid.
 *  4. Marks the event as processed with a summary in Column G.
 *
 * Event payload (Column D): comma-separated SKUs
 * Column E (MPN): mode — "SEND" (email + delete) or "CLEAR" (delete only)
 * Column F: Processed_At timestamp
 * Column G: Result summary / errors
 *
 * Block layout in Loading Dock: Header | Product | Email | Blank (4 rows)
 *************************************************************/

var SEND_DOCK = {
  LOADING_DOCK_SHEET: "Loading Dock",
  EVENTS_SHEET: "Events",
  BLOCK_HEIGHT: 4,
  PRODUCT_CODE_HEADER: "Product Code/SKU",
  EVENT_TYPE: "SEND_DOCK",
  PROP_KEY: "LAST_PROCESSED_SEND_DOCK_ROW",
  REPROCESS_LOOKBACK_ROWS: 300,
  MAX_EVENTS_PER_RUN: 1,
  MAX_SKUS_PER_RUN: 8,
};

var SEND_DOCK_MIN_IMAGE_SLOTS = 8;
var SEND_DOCK_REQUIRED_POST_IMAGE_HEADER_KEYS = {
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

function sendDock_escapeHtml_(text) {
  return String(text || "")
    .replace(/°/g, "&deg;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/≤/g, "&le;")
    .replace(/≥/g, "&ge;");
}

function sendDock_unescapeHtml_(text) {
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

function sendDock_decodePossiblyEscapedHtml_(text) {
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

function sendDock_formatDescriptionHtml_(description, specData) {
  var transformedB7 = sendDock_transform_INPUT_B7_(description || "");
  var transformedB4 = sendDock_transform_INPUT_B4_(specData || "");
  if (!transformedB4) return transformedB7;
  if (!transformedB7) return transformedB4;
  return transformedB7 + transformedB4;
}

function sendDock_transform_INPUT_B4_(cellText) {
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

function sendDock_escapeDescriptionText_(text) {
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

function sendDock_transform_INPUT_B7_(cellText) {
  if (cellText === "" || cellText === null || cellText === undefined) return "";
  var normalized = String(cellText).replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  return normalized
    .split(/\n\s*\n/)
    .map(function(paragraph) { return paragraph.trim(); })
    .filter(Boolean)
    .map(function(paragraph) {
      return "<p>" + sendDock_escapeDescriptionText_(paragraph).replace(/\n/g, "<br/>") + "</p>";
    })
    .join("");
}

function sendDock_parseDescriptionHtml_(htmlDesc) {
  if (!htmlDesc || !String(htmlDesc).trim()) return { description: "", specData: "" };

  var raw = sendDock_decodePossiblyEscapedHtml_(htmlDesc);
  var specStartMatch = raw.match(/<(strong|b)>[^<]+?:\s*<\/\1>/i);
  if (!specStartMatch || specStartMatch.index === undefined) {
    var blocks = [];
    var pRegex = /<p>([\s\S]*?)<\/p>/gi;
    var m;
    while ((m = pRegex.exec(raw)) !== null) blocks.push(m[1]);
    if (blocks.length === 0) {
      return { description: sendDock_unescapeHtml_(raw.replace(/<[^>]*>/g, "").trim()), specData: "" };
    }
    return {
      description: blocks
        .map(function(block) { return sendDock_unescapeHtml_(block.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim()); })
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
        .map(function(block) { return sendDock_unescapeHtml_(block.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim()); })
        .filter(String)
        .join("\n\n")
    : sendDock_unescapeHtml_(descHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim());

  var specData = specHtml
    .split(/<br\s*\/?>/i)
    .map(function(line) {
      return sendDock_unescapeHtml_(
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

function sendDock_normalizeDescriptionCell_(value) {
  var parsed = sendDock_parseDescriptionHtml_(value);
  if (!parsed.description && !parsed.specData) return String(value || "");
  return sendDock_formatDescriptionHtml_(parsed.description, parsed.specData);
}

function sendDock_normalizeSemicolonCell_(value) {
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

      return key + "=" + sendDock_formatDimensionValueForCsv_(key, rawValue);
    })
    .filter(Boolean)
    .join(";");
}

function sendDock_isImageUrlHeader_(headerName) {
  var normalized = String(headerName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return /^product image file\s*-\s*\d+$/i.test(normalized) ||
    /^image file\s*-\s*\d+$/i.test(normalized) ||
    /^image url\s*-\s*\d+$/i.test(normalized);
}

function sendDock_normalizeImageFileCell_(value) {
  return String(value == null ? "" : value)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

function sendDock_isRealImageFileValue_(value) {
  var normalized = sendDock_normalizeImageFileCell_(value);
  if (!normalized) return false;
  var lowered = normalized.toLowerCase();
  return lowered !== "0" && lowered !== "false" && lowered !== "n"
    && lowered !== "none" && lowered !== "null" && lowered !== "undefined"
    && lowered !== "n/a" && lowered !== "na" && lowered !== "-" && lowered !== "--";
}

function sendDock_getImageSlotInfo_(headerRow, dataRow, maxCols) {
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
    if (match[1].toLowerCase() === "file" && sendDock_isRealImageFileValue_(dataRow[c])) {
      highestPopulatedSlot = Math.max(highestPopulatedSlot, slot);
    }
  }

  if (!hasImageHeaders) return { requiredSlotCount: 0, lastRequiredCol: -1 };

  var requiredSlots = Math.max(SEND_DOCK_MIN_IMAGE_SLOTS, highestPopulatedSlot);
  var lastRequiredCol = -1;
  for (var slot2 = 1; slot2 <= requiredSlots; slot2++) {
    if (typeof lastColBySlot[slot2] === "number") {
      lastRequiredCol = Math.max(lastRequiredCol, lastColBySlot[slot2]);
    }
  }
  return { requiredSlotCount: requiredSlots, lastRequiredCol: lastRequiredCol };
}

function sendDock_getRequiredImageSlotLastCol_(headerRow, dataRow, maxCols) {
  return sendDock_getImageSlotInfo_(headerRow, dataRow, maxCols).lastRequiredCol;
}

function sendDock_normalizeHeaderKey_(header) {
  return String(header || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sendDock_shouldSkipExcessImageSlotCol_(header, value, requiredSlotCount) {
  var match = String(header || "").trim().match(/^Product Image (ID|File|Description|Is Thumbnail|Sort)\s*-\s*(\d+)$/i);
  if (!match) return false;
  var slot = parseInt(match[2], 10);
  // Skip ALL columns of excess slots (even if they have default Sort/Thumbnail values)
  return !!slot && slot > requiredSlotCount;
}

function sendDock_getRequiredPostImageLastCol_(headerRow, maxCols) {
  var lastProtectedCol = -1;
  for (var c = 0; c < Math.min(headerRow.length, maxCols); c++) {
    var key = sendDock_normalizeHeaderKey_(headerRow[c]);
    if (SEND_DOCK_REQUIRED_POST_IMAGE_HEADER_KEYS[key]) lastProtectedCol = c;
  }
  return lastProtectedCol;
}

function sendDock_findColByAliases_(headers, aliases) {
  var normalizedAliases = (aliases || []).map(function(alias) {
    return String(alias || "").trim().toLowerCase();
  }).filter(Boolean);
  for (var i = 0; i < headers.length; i++) {
    var key = String(headers[i] || "").trim().toLowerCase();
    if (normalizedAliases.indexOf(key) !== -1) return i;
  }
  return -1;
}

function sendDock_isSemicolonListHeader_(headerName) {
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

function sendDock_normalizeDimensionHeader_(headerName) {
  return String(headerName || "")
    .replace(/\*/g, "")
    .replace(/\s*#\d+\s*$/i, "")
    .replace(/\s*\([^)]*\)\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function sendDock_isDimensionFilterHeader_(headerName) {
  var key = sendDock_normalizeDimensionHeader_(headerName);
  return key === "airmovement" || key === "fancutout";
}

function sendDock_formatDimensionValueForCsv_(headerName, value) {
  if (!sendDock_isDimensionFilterHeader_(headerName)) return String(value == null ? "" : value).trim();

  var normalizedHeader = sendDock_normalizeDimensionHeader_(headerName);
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

/**
 * Main entry point — called by Triggers.gs onSheetChange.
 * Scans Events tab for unprocessed SEND_DOCK events and
 * batch-deletes (and optionally emails) all listed SKUs.
 */
function processSendDockEvents() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(1500)) {
    console.log("processSendDockEvents: skipped (lock busy, will retry on next onChange).");
    return;
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var eventsSheet = ss.getSheetByName(SEND_DOCK.EVENTS_SHEET);
    if (!eventsSheet) return;

    var lastRow = eventsSheet.getLastRow();
    if (lastRow < 2) return;

    var lastProcRaw = mpnPanel_getScriptProp_(SEND_DOCK.PROP_KEY);
    var parsedLastProc = parseInt(String(lastProcRaw || ""), 10);
    var lastProc = isFinite(parsedLastProc) ? parsedLastProc : 1;

    var startRow = Math.max(1, lastProc - SEND_DOCK.REPROCESS_LOOKBACK_ROWS);
    if (startRow >= lastRow) {
      startRow = Math.max(1, lastRow - SEND_DOCK.REPROCESS_LOOKBACK_ROWS);
    }

    var scanCount = lastRow - startRow;
    if (scanCount <= 0) return;

    var data = eventsSheet.getRange(startRow + 1, 1, scanCount, 7).getValues();
    var maxEventsPerRun = Math.max(1, Number(SEND_DOCK.MAX_EVENTS_PER_RUN) || 1);
    var maxSkusPerRun = Math.max(1, Number(SEND_DOCK.MAX_SKUS_PER_RUN) || 1);
    var processedEvents = 0;

    for (var i = 0; i < data.length; i++) {
      var rowIndex = i + startRow + 1;
      var eventType = String(data[i][2] || "").trim();
      var skuList = String(data[i][3] || "").trim();   // comma-separated SKUs
      var mode = String(data[i][4] || "").trim();      // "SEND" or "CLEAR"
      var processedAt = String(data[i][5] || "").trim();

      if (eventType !== SEND_DOCK.EVENT_TYPE || processedAt !== "") {
        var canAdvanceCursor = (eventType !== "") || (processedAt !== "") || (skuList !== "");
        if (canAdvanceCursor) {
          mpnPanel_setScriptProp_(SEND_DOCK.PROP_KEY, rowIndex);
        }
        continue;
      }

      try {
        if (!skuList) throw new Error("SEND_DOCK event has no SKUs.");

        var skus = skuList.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
        if (skus.length === 0) throw new Error("SEND_DOCK event has empty SKU list.");

        var skusThisRun = skus.slice(0, maxSkusPerRun);
        var remainingSkus = skus.slice(skusThisRun.length);
        var shouldEmail = (mode === "SEND");
        var result = sendDock_processBatch_(ss, skusThisRun, shouldEmail);

        var summary = "OK: " + result.deleted + "/" + skusThisRun.length + " deleted";
        if (shouldEmail) summary += ", " + result.emailed + " emailed";
        if (result.errors.length > 0) {
          summary += " | ERRORS: " + result.errors.join(";").substring(0, 400);
        }

        if (remainingSkus.length > 0) {
          eventsSheet.getRange(rowIndex, 4).setValue(remainingSkus.join(","));
          eventsSheet.getRange(rowIndex, 7).setValue(
            "PARTIAL: " + skusThisRun.length + "/" + skus.length + " processed. " + summary
          );
          // Keep Processed_At blank so this event resumes next trigger tick.
          mpnPanel_setScriptProp_(SEND_DOCK.PROP_KEY, Math.max(1, rowIndex - 1));
          console.log(
            "processSendDockEvents: partial batch for row " + rowIndex +
            " (remaining " + remainingSkus.length + " SKU(s))."
          );
          break;
        }

        eventsSheet.getRange(rowIndex, 6, 1, 2).setValues([[mpnPanel_melbTimestamp_(), summary]]);
        mpnPanel_setScriptProp_(SEND_DOCK.PROP_KEY, rowIndex);
      } catch (err) {
        console.error("processSendDockEvents error for SKUs " + skuList + ":", err);
        eventsSheet.getRange(rowIndex, 6, 1, 2).setValues([[mpnPanel_melbTimestamp_(), "FATAL: " + String(err)]]);
        mpnPanel_setScriptProp_(SEND_DOCK.PROP_KEY, rowIndex);
      }

      processedEvents++;
      if (processedEvents >= maxEventsPerRun) {
        break;
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Core batch processor: reads Loading Dock once, locates all SKU blocks,
 * optionally emails each, then deletes blocks in REVERSE row order
 * so that earlier row indices remain valid during deletion.
 */
function sendDock_processBatch_(ss, skus, shouldEmail) {
  var dockSheet = ss.getSheetByName(SEND_DOCK.LOADING_DOCK_SHEET);
  if (!dockSheet) throw new Error("Loading Dock sheet not found.");

  var lastRow = dockSheet.getLastRow();
  var maxCols = dockSheet.getMaxColumns();
  if (lastRow < 2) throw new Error("Loading Dock is empty.");

  // Single batch read of the entire Loading Dock
  var allData = dockSheet.getRange(1, 1, lastRow, maxCols).getValues();

  // Row 1 is the master header (for CSV export). Blocks start at row index 1 (0-based).
  // Build a map: SKU -> { headerIdx (0-based), sheetRow (1-based) }
  var skuSet = {};
  for (var s = 0; s < skus.length; s++) skuSet[skus[s].toUpperCase()] = true;

  var blocks = []; // { sku, headerIdx, sheetRow, productIdx }
  for (var headerIdx = 1; headerIdx < allData.length; headerIdx += SEND_DOCK.BLOCK_HEIGHT) {
    var productIdx = headerIdx + 1;
    if (productIdx >= allData.length) break;

    var headers = allData[headerIdx];
    var skuCol = -1;
    for (var c = 0; c < headers.length; c++) {
      if (String(headers[c] || "").trim() === SEND_DOCK.PRODUCT_CODE_HEADER) {
        skuCol = c;
        break;
      }
    }
    if (skuCol === -1) continue;

    var cellSku = String(allData[productIdx][skuCol] || "").trim();
    if (skuSet[cellSku.toUpperCase()]) {
      blocks.push({
        sku: cellSku,
        headerIdx: headerIdx,
        productIdx: productIdx,
        sheetRow: headerIdx + 1, // 1-based
      });
    }
  }

  // Sort blocks by sheetRow DESCENDING so we delete bottom-first
  blocks.sort(function(a, b) { return b.sheetRow - a.sheetRow; });

  var result = { deleted: 0, emailed: 0, errors: [] };

  // Phase 1: Send emails (if mode=SEND) — do this BEFORE any deletions
  if (shouldEmail) {
    for (var i = 0; i < blocks.length; i++) {
      try {
        sendDock_emailSku_(dockSheet, allData, blocks[i], maxCols);
        result.emailed++;
      } catch (emailErr) {
        result.errors.push(blocks[i].sku + ":email:" + String(emailErr).substring(0, 80));
      }
    }
  }

  // Phase 2: Delete blocks in reverse order (bottom-first), grouped into contiguous ranges
  var deleteGroups = [];
  for (var j = 0; j < blocks.length; j++) {
    var block = blocks[j];
    if (deleteGroups.length === 0) {
      deleteGroups.push({ startRow: block.sheetRow, count: SEND_DOCK.BLOCK_HEIGHT });
      continue;
    }

    var lastGroup = deleteGroups[deleteGroups.length - 1];
    // Since we're descending, contiguous next block starts exactly BLOCK_HEIGHT rows above.
    if (block.sheetRow + SEND_DOCK.BLOCK_HEIGHT === lastGroup.startRow) {
      lastGroup.startRow = block.sheetRow;
      lastGroup.count += SEND_DOCK.BLOCK_HEIGHT;
    } else {
      deleteGroups.push({ startRow: block.sheetRow, count: SEND_DOCK.BLOCK_HEIGHT });
    }
  }

  for (var g = 0; g < deleteGroups.length; g++) {
    try {
      dockSheet.deleteRows(deleteGroups[g].startRow, deleteGroups[g].count);
      result.deleted += (deleteGroups[g].count / SEND_DOCK.BLOCK_HEIGHT);
    } catch (delErr) {
      result.errors.push("delete_group@" + deleteGroups[g].startRow + ":" + String(delErr).substring(0, 80));
    }
  }

  // Phase 3: Mark all SKUs as COMPLETE in PRODUCTS TO DO (batch)
  if (shouldEmail) {
    sendDock_batchMarkComplete_(ss, skus);
  }

  console.log("SEND_DOCK complete: " + result.deleted + " deleted, " +
    result.emailed + " emailed, " + result.errors.length + " errors");

  return result;
}

/**
 * Sends an email for a single SKU using pre-loaded allData (no extra sheet reads).
 * Reuses EMAIL_CONFIG from EmailSingle.gs.
 */
function sendDock_emailSku_(dockSheet, allData, block, maxCols) {
  if (!EMAIL_CONFIG || !EMAIL_CONFIG.SEND_TO || EMAIL_CONFIG.SEND_TO.length === 0) {
    throw new Error("No recipients in EMAIL_CONFIG.SEND_TO");
  }

  var sku = block.sku;
  var productIdx = block.productIdx;

  // Use row 1 (index 0) as master header if block headers aren't suitable for CSV
  // But for CSV we use the block's own header row
  var headerRow = allData[block.headerIdx];
  var dataRow = allData[productIdx];

  // Trim to last non-empty column
  var imageSlotInfo = sendDock_getImageSlotInfo_(headerRow, dataRow, EMAIL_CONFIG.MAX_EXPORT_COLS || 200);
  var requiredPostImageLastCol = sendDock_getRequiredPostImageLastCol_(headerRow, EMAIL_CONFIG.MAX_EXPORT_COLS || 200);
  var lastCol = 0;
  for (var c = 0; c < Math.min(headerRow.length, EMAIL_CONFIG.MAX_EXPORT_COLS || 200); c++) {
    if (sendDock_shouldSkipExcessImageSlotCol_(headerRow[c], dataRow[c], imageSlotInfo.requiredSlotCount)) continue;
    if (String(headerRow[c] || "").trim() || String(dataRow[c] || "").trim()) {
      lastCol = c;
    }
  }
  lastCol = Math.max(lastCol, imageSlotInfo.lastRequiredCol, requiredPostImageLastCol);

  var selectedCols = [];
  for (var c2 = 0; c2 <= lastCol; c2++) {
    if (sendDock_shouldSkipExcessImageSlotCol_(headerRow[c2], dataRow[c2], imageSlotInfo.requiredSlotCount)) continue;
    selectedCols.push(c2);
  }

  var csvHeader = selectedCols.map(function(idx) { return csvEscape_(headerRow[idx]); });
  var exportRow = selectedCols.map(function(idx) { return dataRow[idx]; });
  for (var c3 = 0; c3 < selectedCols.length; c3++) {
    var headerIndex = selectedCols[c3];
    var headerName = String(headerRow[headerIndex] || "").trim().toLowerCase();
    if (headerName === "product description" || headerName === "description") {
      exportRow[c3] = sendDock_normalizeDescriptionCell_(exportRow[c3]);
      continue;
    }
    if (sendDock_isSemicolonListHeader_(headerName)) {
      exportRow[c3] = sendDock_normalizeSemicolonCell_(exportRow[c3]);
      continue;
    }
    exportRow[c3] = sendDock_formatDimensionValueForCsv_(headerRow[headerIndex], exportRow[c3]);
  }
  var csvData = exportRow.map(csvEscape_);
  var csvText = csvHeader.join(",") + "\n" + csvData.join(",");

  // Count only actual image URL/file columns, excluding sort/id/thumbnail helpers.
  var imageCount = 0;
  for (var c2 = 0; c2 <= lastCol; c2++) {
    var h = String(headerRow[c2] || "").trim();
    if (sendDock_isImageUrlHeader_(h) && String(dataRow[c2] || "").trim()) imageCount++;
  }

  // Email notes: row after product (email row), using the Product Description header.
  var emailNotes = "";
  var emailRowIdx = productIdx + 1;
  if (emailRowIdx < allData.length) {
    var emailRow = allData[emailRowIdx] || [];
    var emailNotesCol = sendDock_findColByAliases_(headerRow, ["Product Description", "Description"]);
    var emailNotesIdx = emailNotesCol !== -1 ? emailNotesCol : 9;
    emailNotes = String(emailRow[emailNotesIdx] || "").trim();
  }

  var subject = (EMAIL_CONFIG.SUBJECT_TEMPLATE || "[SKU]").replace(/\[SKU\]/g, sku);
  var body = (EMAIL_CONFIG.BODY_TEMPLATE || "SKU: [SKU]")
    .replace(/\[SKU\]/g, sku)
    .replace(/\[IMAGE_COUNT\]/g, String(imageCount))
    .replace(/\[EMAIL_NOTES\]/g, emailNotes || "(No email notes)");
  var filename = (EMAIL_CONFIG.FILENAME_TEMPLATE || "[SKU].csv").replace(/\[SKU\]/g, sku);

  var mailOpts = {
    cc: (EMAIL_CONFIG.CC || []).join(","),
    bcc: (EMAIL_CONFIG.BCC || []).join(","),
    attachments: [Utilities.newBlob(csvText, "text/csv", filename)],
  };

  if (EMAIL_CONFIG.SEND_FROM_ALIAS) {
    mailOpts.from = EMAIL_CONFIG.SEND_FROM_ALIAS;
  }

  GmailApp.sendEmail(
    EMAIL_CONFIG.SEND_TO.join(","),
    subject,
    body,
    mailOpts
  );
}

/**
 * Batch-marks multiple SKUs as COMPLETE in PRODUCTS TO DO.
 * Reads the sheet once, updates matching rows, writes back in one call.
 */
function sendDock_batchMarkComplete_(ss, skus) {
  try {
    var ptdSheet = ss.getSheetByName("PRODUCTS TO DO");
    if (!ptdSheet) return;

    var lastRow = ptdSheet.getLastRow();
    if (lastRow < 2) return;
    var data = ptdSheet.getRange(1, 1, lastRow, 4).getValues();

    var skuSet = {};
    for (var i = 0; i < skus.length; i++) skuSet[skus[i].toUpperCase()] = true;

    var changed = false;
    for (var r = 1; r < data.length; r++) {
      var sku = String(data[r][0] || "").trim();
      if (skuSet[sku.toUpperCase()] && String(data[r][2] || "").trim() !== "COMPLETE") {
        data[r][2] = "COMPLETE";
        changed = true;
      }
    }

    if (changed) {
      ptdSheet.getRange(1, 1, lastRow, 4).setValues(data);
    }
  } catch (err) {
    console.error("sendDock_batchMarkComplete_ error:", err);
    // Non-fatal — don't block the rest of the process
  }
}
