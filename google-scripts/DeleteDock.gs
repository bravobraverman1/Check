/*************************************************************
 * DeleteDock.gs — v1.0
 *
 * Processes DOCK_DELETE events from the Events tab.
 * When a DOCK_DELETE event is found for a SKU, this script:
 *  1. Locates the 4-row block for that SKU in the Loading Dock sheet
 *  2. Deletes the block entirely (4 rows)
 *  3. Optionally marks the SKU COMPLETE in PRODUCTS TO DO
 *  4. Marks the event as processed in Column F
 *
 * Events columns (shared with MpnPanel):
 *  A Timestamp | B Event_ID | C Event_Type | D SKU |
 *  E MPN       | F Processed_At            | G Error
 *
 * Block layout in Loading Dock: Header | Product | Email | Blank (4 rows)
 * SKU lives in the Product row (row 2 of each block) in the
 * "Product Code/SKU" column.
 *************************************************************/

var DELETE_DOCK = {
  LOADING_DOCK_SHEET: "Loading Dock",
  BLOCK_HEIGHT: 4,
  PRODUCT_CODE_HEADER: "Product Code/SKU",
  EVENT_TYPE: "DOCK_DELETE",
  PROP_KEY: "LAST_PROCESSED_DELETE_ROW",
  REPROCESS_LOOKBACK_ROWS: 300,
  MAX_EVENTS_PER_RUN: 25,
};

/**
 * Main entry point — called by Triggers.gs onSheetChange.
 * Scans Events tab for unprocessed DOCK_DELETE events and deletes
 * the corresponding 4-row block from the Loading Dock.
 */
function processDeleteDockEvents() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(1500)) {
    console.log("processDeleteDockEvents: skipped (lock busy, will retry on next onChange).");
    return;
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var eventsSheet = ss.getSheetByName(MPN_PANEL.SHEET);
    if (!eventsSheet) return;

    var lastRow = eventsSheet.getLastRow();
    if (lastRow < 2) return;

    var lastProcRaw = mpnPanel_getScriptProp_(DELETE_DOCK.PROP_KEY);
    var parsedLastProc = parseInt(String(lastProcRaw || ""), 10);
    var lastProc = isFinite(parsedLastProc) ? parsedLastProc : 1;

    var startRow = Math.max(1, lastProc - DELETE_DOCK.REPROCESS_LOOKBACK_ROWS);
    if (startRow >= lastRow) {
      startRow = Math.max(1, lastRow - DELETE_DOCK.REPROCESS_LOOKBACK_ROWS);
    }

    var scanCount = lastRow - startRow;
    if (scanCount <= 0) return;

    var data = eventsSheet.getRange(startRow + 1, 1, scanCount, 7).getValues();
    var pending = [];

    for (var i = 0; i < data.length; i++) {
      var rowIndex = i + startRow + 1;
      var eventType = String(data[i][2] || "").trim();
      var sku = String(data[i][3] || "").trim();
      var markComplete = String(data[i][4] || "").trim().toUpperCase() === "COMPLETE";
      var processedAt = String(data[i][5] || "").trim();

      if (eventType === DELETE_DOCK.EVENT_TYPE && processedAt === "") {
        pending.push({ rowIndex: rowIndex, sku: sku, markComplete: markComplete });
        continue;
      }

      var canAdvanceCursor = (eventType !== "") || (processedAt !== "") || (sku !== "");
      if (canAdvanceCursor) {
        mpnPanel_setScriptProp_(DELETE_DOCK.PROP_KEY, rowIndex);
      }
    }

    if (pending.length === 0) return;

    var maxEvents = Math.max(1, Number(DELETE_DOCK.MAX_EVENTS_PER_RUN) || 1);
    var toProcess = pending.slice(0, maxEvents);
    var skus = toProcess
      .map(function(item) { return item.sku; })
      .filter(function(sku) { return String(sku || "").trim() !== ""; });

    var batchResult = deleteDock_deleteSkuBlocksBatch_(ss, skus);
    var foundSkus = batchResult.foundSkus || {};
    var skusToMarkComplete = [];
    for (var c = 0; c < toProcess.length; c++) {
      var completionEvent = toProcess[c];
      var completionSku = String(completionEvent.sku || "").trim().toUpperCase();
      if (completionEvent.markComplete && completionSku && foundSkus[completionSku]) {
        skusToMarkComplete.push(completionEvent.sku);
      }
    }
    var completeWarningsBySku = deleteDock_syncCompleteStatuses_(ss, skusToMarkComplete);

    for (var p = 0; p < toProcess.length; p++) {
      var eventRow = toProcess[p];
      var normalizedSku = String(eventRow.sku || "").trim().toUpperCase();
      var notFound = !normalizedSku || !foundSkus[normalizedSku];
      var errorText = notFound
        ? "SKU block not found in Loading Dock"
        : (eventRow.markComplete ? (completeWarningsBySku[normalizedSku] || "") : "");
      eventsSheet.getRange(eventRow.rowIndex, 6, 1, 2).setValues([[mpnPanel_melbTimestamp_(), errorText]]);
      mpnPanel_setScriptProp_(DELETE_DOCK.PROP_KEY, eventRow.rowIndex);
    }

    if (batchResult.errors && batchResult.errors.length > 0) {
      console.error("processDeleteDockEvents batch errors:", batchResult.errors.join("; "));
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Finds and deletes the 4-row block for a given SKU in the Loading Dock.
 * Uses batch I/O (reads entire sheet once) to locate the block.
 * Returns true if a block was found and deleted, false otherwise.
 */
function deleteDock_deleteSkuBlocksBatch_(ss, skus) {
  var result = { foundSkus: {}, errors: [] };
  if (!skus || skus.length === 0) return result;

  var dockSheet = ss.getSheetByName(DELETE_DOCK.LOADING_DOCK_SHEET);
  if (!dockSheet) return result;

  var lastRow = dockSheet.getLastRow();
  if (lastRow < 2) return result;

  var maxCols = dockSheet.getMaxColumns();
  var allData = dockSheet.getRange(1, 1, lastRow, maxCols).getValues();

  var wanted = {};
  for (var i = 0; i < skus.length; i++) {
    var normalized = String(skus[i] || "").trim().toUpperCase();
    if (normalized) wanted[normalized] = true;
  }

  var blocks = [];
  for (var headerIdx = allData.length - 2; headerIdx >= 1; headerIdx--) {
    if ((headerIdx - 1) % DELETE_DOCK.BLOCK_HEIGHT !== 0) continue;

    var productIdx = headerIdx + 1;
    if (productIdx >= allData.length) continue;

    var headers = allData[headerIdx];
    var skuCol = -1;
    for (var c = 0; c < headers.length; c++) {
      if (String(headers[c] || "").trim() === DELETE_DOCK.PRODUCT_CODE_HEADER) {
        skuCol = c;
        break;
      }
    }
    if (skuCol === -1) continue;

    var cellSkuRaw = String(allData[productIdx][skuCol] || "").trim();
    var cellSku = cellSkuRaw.toUpperCase();
    if (!wanted[cellSku]) continue;

    var sheetHeaderRow = headerIdx + 1; // convert to 1-based
    var rowsAvailable = Math.max(0, lastRow - sheetHeaderRow + 1);
    var rowsToDelete = Math.min(DELETE_DOCK.BLOCK_HEIGHT, rowsAvailable);
    if (rowsToDelete <= 0) continue;

    blocks.push({
      sku: cellSku,
      sheetRow: sheetHeaderRow,
      rowsToDelete: rowsToDelete,
    });
    result.foundSkus[cellSku] = true;
  }

  // Already discovered from bottom-to-top; group contiguous ranges to minimize delete calls.
  var groups = [];
  for (var b = 0; b < blocks.length; b++) {
    var block = blocks[b];
    if (groups.length === 0) {
      groups.push({ startRow: block.sheetRow, count: block.rowsToDelete });
      continue;
    }

    var lastGroup = groups[groups.length - 1];
    if (block.sheetRow + block.rowsToDelete === lastGroup.startRow) {
      lastGroup.startRow = block.sheetRow;
      lastGroup.count += block.rowsToDelete;
    } else {
      groups.push({ startRow: block.sheetRow, count: block.rowsToDelete });
    }
  }

  for (var g = 0; g < groups.length; g++) {
    try {
      dockSheet.deleteRows(groups[g].startRow, groups[g].count);
    } catch (err) {
      result.errors.push("delete_group@" + groups[g].startRow + ":" + String(err).substring(0, 120));
    }
  }

  return result;
}

/**
 * Backward-compatible single delete wrapper.
 */
function deleteDock_deleteSkuBlock_(ss, sku) {
  var out = deleteDock_deleteSkuBlocksBatch_(ss, [sku]);
  return !!out.foundSkus[String(sku || "").trim().toUpperCase()];
}

function deleteDock_syncCompleteStatuses_(ss, skus) {
  var warningsBySku = {};
  if (!skus || skus.length === 0) return warningsBySku;

  var ptdSheet = ss.getSheetByName("PRODUCTS TO DO");
  if (!ptdSheet) {
    for (var missingSheetIdx = 0; missingSheetIdx < skus.length; missingSheetIdx++) {
      warningsBySku[String(skus[missingSheetIdx] || "").trim().toUpperCase()] =
        "WARN: Entry removed, but PRODUCTS TO DO was not available for COMPLETE sync.";
    }
    return warningsBySku;
  }

  var lastRow = ptdSheet.getLastRow();
  if (lastRow < 2) {
    for (var emptySheetIdx = 0; emptySheetIdx < skus.length; emptySheetIdx++) {
      warningsBySku[String(skus[emptySheetIdx] || "").trim().toUpperCase()] =
        "WARN: Entry removed, but COMPLETE status could not be updated.";
    }
    return warningsBySku;
  }

  var data = ptdSheet.getRange(1, 1, lastRow, 4).getValues();
  var skuSet = {};
  var orderedSkus = [];
  for (var i = 0; i < skus.length; i++) {
    var normalized = String(skus[i] || "").trim().toUpperCase();
    if (!normalized || skuSet[normalized]) continue;
    skuSet[normalized] = true;
    orderedSkus.push(normalized);
  }

  var foundSet = {};
  var changed = false;
  for (var rowIdx = 1; rowIdx < data.length; rowIdx++) {
    var rowSku = String(data[rowIdx][0] || "").trim().toUpperCase();
    if (!rowSku || !skuSet[rowSku]) continue;
    foundSet[rowSku] = true;
    if (String(data[rowIdx][2] || "").trim() !== "COMPLETE") {
      data[rowIdx][2] = "COMPLETE";
      changed = true;
    }
  }

  for (var orderedIdx = 0; orderedIdx < orderedSkus.length; orderedIdx++) {
    var orderedSku = orderedSkus[orderedIdx];
    if (!foundSet[orderedSku]) {
      warningsBySku[orderedSku] =
        "WARN: Entry removed, but SKU was not found in PRODUCTS TO DO for COMPLETE sync.";
    }
  }

  if (!changed) return warningsBySku;

  try {
    ptdSheet.getRange(1, 1, lastRow, 4).setValues(data);
  } catch (err) {
    for (var writeFailIdx = 0; writeFailIdx < orderedSkus.length; writeFailIdx++) {
      warningsBySku[orderedSkus[writeFailIdx]] =
        "WARN: Entry removed, but COMPLETE status could not be updated.";
    }
    console.error("deleteDock_syncCompleteStatuses_ error:", err);
  }

  return warningsBySku;
}
