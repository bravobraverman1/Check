/*************************************************************
 * COPY ENGINE_OLD — ARCHIVED LEGACY IMPLEMENTATION
 *
 * DO NOT DEPLOY THIS FILE'S submit entry point to the live Apps Script
 * project. Submit / override / upload are edge-owned now.
 *
 * The legacy implementation is intentionally kept only as an archive for
 * reference. Its public `processSubmitEvents()` symbol has been removed so
 * it cannot override the safe no-op shim in CopyEngine.gs.
 *
 * Original header preserved below.
 *
 * COPY ENGINE v6.0 — SPEED-OPTIMIZED (<20s target)
 *
 * Safety: DocumentLock — only 1 execution at a time
 *         ScriptLock in Triggers.gs — only 1 onChange at a time
 *         Processed_At gate in edge function — cross-system safety
 *
 * v6.0 changes from v5.2:
 *  - findMaxImageUsedForRow_ accepts pre-built hMap (was rebuilding
 *    a ~200-key Map per block — now zero-alloc per block)
 *  - Removed dead legacy functions (purgeErrorRows_, getExistingMpn_)
 *  - Removed standalone COPY_ENGINE_run() — menu "Force Run Submit
 *    Pipeline" calls processSubmitEvents() directly (faster, REST path)
 *  - Added execution budget guard before Loading Dock write phase
 *
 * v5.2 (retained):
 *  - SpreadsheetApp.flush() after Processed_At writes
 *
 * v5.1 (retained):
 *  - Products map keys normalised to uppercase
 *  - Removed unnecessary OUTPUT_Work writeback
 *
 * v5.0 speed wins (retained):
 *  1. No H1 cell lock (Processed_At gate + DocumentLock)     -> -3-5s
 *  2. OUTPUT_Work read once via REST API, inlined              -> -3-5s
 *  3. Loading Dock read once, shared across all phases         -> -2-3s
 *  4. Products read once, shared                               -> -1s
 *  5. purgeErrorRows_ removed from hot path                    -> -2-3s
 *  6. Retry reduced to 2x500ms                                 -> -2s
 *  7. Execution budget 25s (fail fast)
 *
 * Block layout in Loading Dock: Header | Product | Email | Blank (4 rows)
 *************************************************************/

var COPY_ENGINE = {
  TEMPLATE_SHEET: "OUTPUT_Template",
  WORK_SHEET:     "OUTPUT_Work",
  TEMP_SHEET:     "Loading Dock",
  HEADERS_ROW_IN_WORK: 1,
  FIRST_DATA_ROW:      2,
  BLOCK_HEIGHT: 4,
  MAX_IMAGE: 20,
  MIN_IMAGE:  8,
  PRODUCT_ID_HEADER:   "Product ID",
  PRODUCT_CODE_HEADER: "Product Code/SKU",
  EMAIL_LABEL_HEADER:  "Option Set Align",
  PRODUCT_DESC_HEADER: "Product Description",
  PRODUCTS_SHEET: "Products",
  REPROCESS_LOOKBACK_ROWS: 300,
  MISSING_IN_WORK_DEFER_MS: 15000,   // 15s — REST API reads bypass cache; error faster
  WORK_READ_RETRY_DELAY_MS: 500,     // 500ms between REST API retries
  WORK_READ_MAX_RETRIES: 2,          // 2 retries max
  EXECUTION_BUDGET_MS: 25000,        // 25s — fail fast
};

/* ----------------------------------------------------------
 *  HELPERS
 * ---------------------------------------------------------- */

function copyEngine_eventEpochMs_(timestampRaw, eventIdRaw) {
  var id = String(eventIdRaw || "").trim();
  var m = id.match(/^EVT-(\d{13,})$/);
  if (m) {
    var ep = Number(m[1]);
    if (isFinite(ep) && ep > 0) return ep;
  }
  var parsed = Date.parse(String(timestampRaw || "").trim());
  return isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function copyEngine_headerIndexMap_(headers) {
  var m = new Map();
  headers.forEach(function(h, i) {
    var key = String(h || "").trim();
    if (key) m.set(key, i);
  });
  return m;
}

function mustGetSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" not found.');
  return sh;
}

/** Batch-load ALL Products data once (returns object: sku -> {price, visible}) */
function copyEngine_loadProductsMap_(ss) {
  var sh = ss.getSheetByName(COPY_ENGINE.PRODUCTS_SHEET);
  var map = {};
  if (!sh) return map;
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return map;
  var data = sh.getRange(1, 1, lastRow, 4).getValues();
  for (var r = 1; r < data.length; r++) {
    var sku = String(data[r][0] || "").trim();
    if (!sku) continue;
    var p = Number(data[r][2]);
    map[sku.toUpperCase()] = {
      price: (isFinite(p) && p > 0) ? p : null,
      visible: (data[r][3] !== "" && data[r][3] != null) ? String(data[r][3]) : null
    };
  }
  return map;
}

/* ----------------------------------------------------------
 *  REST API READ — bypasses SpreadsheetApp cache (root cause fix)
 * ---------------------------------------------------------- */

function copyEngine_readWorkRest_(ss) {
  var data = null;
  // Primary: Sheets REST API via UrlFetchApp (instant consistency with edge function writes)
  try {
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + ss.getId()
      + '/values/' + encodeURIComponent(COPY_ENGINE.WORK_SHEET)
      + '?valueRenderOption=UNFORMATTED_VALUE';
    var resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() === 200) {
      data = JSON.parse(resp.getContentText()).values || null;
    }
  } catch (e) {
    console.warn('REST API read of OUTPUT_Work failed, falling back to SpreadsheetApp:', e);
  }
  // Fallback: SpreadsheetApp (slow, may be stale, but better than nothing)
  if (!data || data.length === 0) {
    SpreadsheetApp.flush();
    var sh = ss.getSheetByName(COPY_ENGINE.WORK_SHEET);
    if (sh) {
      var lr = sh.getLastRow(), lc = sh.getLastColumn();
      if (lr >= 1 && lc >= 1) data = sh.getRange(1, 1, lr, lc).getValues();
    }
  }
  if (!data || data.length === 0) return { data: null, hdrs: null, hMap: null, skuMap: {} };

  // Normalize row lengths — REST API omits trailing empty cells per row
  var maxLen = 0;
  for (var i = 0; i < data.length; i++) if (data[i].length > maxLen) maxLen = data[i].length;
  for (var i = 0; i < data.length; i++) while (data[i].length < maxLen) data[i].push("");

  var hdrs = data[0].map(function(h) { return String(h || "").trim(); });
  var hMap = copyEngine_headerIndexMap_(hdrs);
  var skuMap = {};
  var skuCol = hMap.get(COPY_ENGINE.PRODUCT_CODE_HEADER);
  if (skuCol == null) skuCol = hMap.get(COPY_ENGINE.PRODUCT_ID_HEADER);
  if (skuCol != null) {
    for (var r = COPY_ENGINE.FIRST_DATA_ROW - 1; r < data.length; r++) {
      var s = String(data[r][skuCol] || "").trim();
      if (s && !(s.toUpperCase() in skuMap)) skuMap[s.toUpperCase()] = r;
    }
  }
  return { data: data, hdrs: hdrs, hMap: hMap, skuMap: skuMap };
}

function copyEngine_anySkuInWork_(events, skuMap) {
  for (var i = 0; i < events.length; i++) {
    if (events[i].sku.toUpperCase() in skuMap) return true;
  }
  return false;
}

function copyEngine_pickActivePendingSkuKey_(events, skuMap) {
  var active = null;
  for (var i = events.length - 1; i >= 0; i--) {
    var skuKey = String(events[i].sku || "").toUpperCase();
    if (skuKey && (skuKey in skuMap)) {
      active = skuKey;
      break;
    }
  }
  return active;
}

/* ----------------------------------------------------------
 *  BLOCK SCANNING & COMPACTION
 * ---------------------------------------------------------- */

/** Scan product blocks from pre-loaded data array */
function copyEngine_scanProductBlocks_fast_(allData, headers, headerMap) {
  var idxSku    = headerMap.get(COPY_ENGINE.PRODUCT_CODE_HEADER);
  var idxProdId = headerMap.get(COPY_ENGINE.PRODUCT_ID_HEADER);
  var idxBody   = headerMap.get(COPY_ENGINE.PRODUCT_DESC_HEADER);
  if (idxSku == null && idxProdId == null) throw new Error('Could not find SKU column.');

  var blocks = [];
  for (var i = COPY_ENGINE.FIRST_DATA_ROW - 1; i < allData.length; i++) {
    var sku = "";
    if (idxSku != null) sku = String(allData[i][idxSku] || "").trim();
    if (!sku && idxProdId != null) sku = String(allData[i][idxProdId] || "").trim();
    if (sku) {
      var emailText = "";
      if (idxBody != null && (i + 1) < allData.length) {
        emailText = String(allData[i + 1][idxBody] || "").trim();
      }
      blocks.push({ sku: sku, productRow: allData[i].slice(), emailBody: emailText });
      i += 3;
    }
  }
  return blocks;
}

/** v6.0: accepts pre-built hMap instead of rebuilding per call */
function copyEngine_findMaxImageUsedForRow_(hMap, productRow) {
  var maxUsed = 0;
  for (var n = 1; n <= COPY_ENGINE.MAX_IMAGE; n++) {
    var fileIdx = hMap.get("Product Image File - " + n);
    var idIdx   = hMap.get("Product Image ID - " + n);
    if ((fileIdx != null && String(productRow[fileIdx]).trim() !== "") ||
        (idIdx   != null && String(productRow[idIdx]).trim()   !== "")) {
      maxUsed = n;
    }
  }
  return maxUsed;
}

function copyEngine_buildCompactionPlan_(headers, keepMax) {
  var keepIndexes = [];
  var compactHeaders = [];
  headers.forEach(function(h, i) {
    var hs = String(h || "");
    var m = hs.match(/Product Image (?:ID|File|Description|Is Thumbnail|Sort)\s*-\s*(\d+)/i);
    var imgIdx = m ? Number(m[1]) : null;
    if (imgIdx == null || imgIdx <= keepMax) {
      keepIndexes.push(i);
      compactHeaders.push(hs.trim());
    }
  });
  return { keepIndexes: keepIndexes, compactHeaders: compactHeaders };
}

function copyEngine_applyCompaction_(row, keepIndexes) {
  return keepIndexes.map(function(i) { return row[i]; });
}

/* ----------------------------------------------------------
 *  LOADING DOCK I/O
 * ---------------------------------------------------------- */

/** Find existing SKU product row in pre-loaded Loading Dock data */
function copyEngine_findExistingSkuInData_(allData, sku, maxCols) {
  for (var headerRowIdx = allData.length - 2; headerRowIdx >= 1; headerRowIdx--) {
    if ((headerRowIdx - 1) % COPY_ENGINE.BLOCK_HEIGHT !== 0) continue;
    var productRowIdx = headerRowIdx + 1;
    if (productRowIdx >= allData.length) break;
    var headers = allData[headerRowIdx];
    var skuCol = -1;
    for (var c = 0; c < headers.length; c++) {
      if (String(headers[c] || "").trim() === COPY_ENGINE.PRODUCT_CODE_HEADER) { skuCol = c; break; }
    }
    if (skuCol === -1) continue;
    if (String(allData[productRowIdx][skuCol] || "").trim().toUpperCase() === sku.toUpperCase()) return productRowIdx + 1;
  }
  return null;
}

/** Find next append header row from pre-loaded data */
function copyEngine_findNextAppendHeaderRow_fast_(allData, maxCols) {
  if (allData.length < 2) return 2;
  var lastHeaderRow = null;
  for (var headerRowIdx = 1; headerRowIdx < allData.length; headerRowIdx += COPY_ENGINE.BLOCK_HEIGHT) {
    var productRowIdx = headerRowIdx + 1;
    if (productRowIdx >= allData.length) break;
    var headers = allData[headerRowIdx];
    var skuCol = -1;
    for (var c = 0; c < headers.length; c++) {
      if (String(headers[c] || "").trim() === COPY_ENGINE.PRODUCT_CODE_HEADER) { skuCol = c; break; }
    }
    if (skuCol === -1) continue;
    if (String(allData[productRowIdx][skuCol] || "").trim() !== "") lastHeaderRow = headerRowIdx + 1;
  }
  return (lastHeaderRow == null) ? 2 : lastHeaderRow + COPY_ENGINE.BLOCK_HEIGHT;
}

function copyEngine_writeRows_(sh, startRow, width, rows) {
  var neededRows = startRow + rows.length - 1;
  if (neededRows > sh.getMaxRows()) {
    sh.insertRowsAfter(sh.getMaxRows(), neededRows - sh.getMaxRows());
  }
  sh.getRange(startRow, 1, rows.length, width).setValues(rows);
}

function copyEngine_ensureColumns_(sh, neededCols) {
  var cur = sh.getMaxColumns();
  if (cur < neededCols) sh.insertColumnsAfter(cur, neededCols - cur);
}

function copyEngine_resetWorkFromTemplate_(templateSh, workSh) {
  workSh.clear();
  var tRange = templateSh.getDataRange();
  tRange.copyTo(workSh.getRange(1, 1, tRange.getNumRows(), tRange.getNumColumns()));
}

/* ----------------------------------------------------------
 *  processSubmitEvents() — MAIN ENTRY POINT
 *
 *  Called by Triggers.gs onSheetChange AND by edge function kick.
 *  All I/O is single-pass: each sheet is read ONCE.
 *  No H1 cell lock — DocumentLock provides full safety.
 * ---------------------------------------------------------- */

function processSubmitEvents_LEGACY_DISABLED_ARCHIVE() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(500)) {
    console.log("processSubmitEvents: lock busy, will retry on next onChange.");
    return;
  }

  try {
    var t0 = Date.now();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var eventsSheet = ss.getSheetByName(MPN_PANEL.SHEET);
    if (!eventsSheet) return;

    var lastRow = eventsSheet.getLastRow();
    if (lastRow < 2) return;

    /* ── 1. SCAN EVENTS for pending SUBMIT / SUBMIT_OVERRIDE / UPLOAD ── */
    var lastProcRaw = mpnPanel_getScriptProp_("LAST_PROCESSED_SUBMIT_ROW");
    var parsedLP = parseInt(String(lastProcRaw || ""), 10);
    var lastProc = isFinite(parsedLP) ? parsedLP : 1;
    var startRow = Math.max(1, lastProc - COPY_ENGINE.REPROCESS_LOOKBACK_ROWS);
    if (startRow >= lastRow) startRow = Math.max(1, lastRow - COPY_ENGINE.REPROCESS_LOOKBACK_ROWS);
    var scanCount = lastRow - startRow;
    if (scanCount <= 0) return;

    var evData = eventsSheet.getRange(startRow + 1, 1, scanCount, 7).getValues();
    var pendingEvents = [];

    for (var i = 0; i < evData.length; i++) {
      var rowIndex = i + startRow + 1;
      var eventTimestamp = String(evData[i][0] || "").trim();
      var eventId    = String(evData[i][1] || "").trim();
      var eventType  = String(evData[i][2] || "").trim();
      var sku        = String(evData[i][3] || "").trim();
      var mpnOrOvr   = String(evData[i][4] || "").trim();
      var processedAt = String(evData[i][5] || "").trim();
      var errorText   = String(evData[i][6] || "").trim();
      var isSubmitLike = (eventType === "SUBMIT" || eventType === "SUBMIT_OVERRIDE" || eventType === "UPLOAD");

      if (isSubmitLike && processedAt === "" && errorText === "") {
        var preReservedMpn = Number(mpnOrOvr);
        pendingEvents.push({
          rowIndex: rowIndex,
          eventType: eventType,
          sku: sku,
          isOverride: (eventType === "SUBMIT_OVERRIDE" || mpnOrOvr.toUpperCase() === "OVERRIDE"),
          eventEpochMs: copyEngine_eventEpochMs_(eventTimestamp, eventId),
          reservedMpn: (isFinite(preReservedMpn) && preReservedMpn > 0) ? preReservedMpn : null,
          isNewMpn: false,
          error: null,
          readyInWork: false,
          alreadyInDock: false,
          deferMissingInWork: false
        });
      } else {
        var canAdvance = (eventType !== "") || (processedAt !== "") || (eventId.indexOf("EVT-") === 0 && !isSubmitLike);
        if (canAdvance) mpnPanel_setScriptProp_("LAST_PROCESSED_SUBMIT_ROW", rowIndex);
      }
    }

    if (pendingEvents.length === 0) return;
    console.log("processSubmitEvents: " + pendingEvents.length + " pending — scan " + (Date.now() - t0) + "ms");

    var executionStartMs = Date.now();

    /* ── 2. READ OUTPUT_Work via REST API (SINGLE read) ── */
    var work = copyEngine_readWorkRest_(ss);
    console.log("processSubmitEvents: REST read " + (Date.now() - executionStartMs) + "ms");

    // Retry if no pending SKU found in work data
    if (!copyEngine_anySkuInWork_(pendingEvents, work.skuMap)) {
      for (var retryN = 1; retryN <= COPY_ENGINE.WORK_READ_MAX_RETRIES; retryN++) {
        if (Date.now() - t0 > COPY_ENGINE.EXECUTION_BUDGET_MS) break;
        console.log("processSubmitEvents: SKU not in OUTPUT_Work — retry " + retryN);
        Utilities.sleep(COPY_ENGINE.WORK_READ_RETRY_DELAY_MS);
        work = copyEngine_readWorkRest_(ss);
        if (copyEngine_anySkuInWork_(pendingEvents, work.skuMap)) break;
      }
    }
    var activeWorkSkuKey = copyEngine_pickActivePendingSkuKey_(pendingEvents, work.skuMap);

    /* ── 3. READ Loading Dock ONCE ── */
    var tempSh = ss.getSheetByName(COPY_ENGINE.TEMP_SHEET);
    var tempMaxRows = tempSh ? tempSh.getLastRow() : 0;
    var tempMaxCols = tempSh ? tempSh.getMaxColumns() : 0;
    var tempAllData = (tempSh && tempMaxRows >= 1)
      ? tempSh.getRange(1, 1, tempMaxRows, tempMaxCols).getValues() : [];

    /* ── 4. MPN ALLOCATION ── */
    var nextMpn = mpn_peekNextForWeb_();
    var mpnIncrements = 0;
    var mpnColIdx      = work.hMap ? work.hMap.get("GPS Manufacturer Part Number") : null;
    var searchKwColIdx = work.hMap ? work.hMap.get("Search Keywords") : null;
    var readyCount = 0;

    for (var p = 0; p < pendingEvents.length; p++) {
      var evt = pendingEvents[p];
      var skuKey = evt.sku.toUpperCase();

      // OUTPUT_Work is a single live staging slot. If some older pending row is
      // still hanging around while another SKU is staged, defer it instead of
      // producing a false "No SKU in OUTPUT_Work" failure.
      if (activeWorkSkuKey && skuKey !== activeWorkSkuKey) {
        evt.deferMissingInWork = true;
        continue;
      }

      if (!(skuKey in work.skuMap)) {
        // Override: NEVER auto-complete — new data MUST be in OUTPUT_Work
        if (!evt.isOverride) {
          var existDockRow = copyEngine_findExistingSkuInData_(tempAllData, evt.sku, tempMaxCols);
          if (existDockRow != null) {
            evt.alreadyInDock = true;
            continue;
          }
        }
        var eventAgeMs = evt.eventEpochMs > 0 ? (Date.now() - evt.eventEpochMs) : 0;
        var elapsed = Date.now() - executionStartMs;
        if (COPY_ENGINE.MISSING_IN_WORK_DEFER_MS > 0
            && eventAgeMs <= COPY_ENGINE.MISSING_IN_WORK_DEFER_MS
            && elapsed < COPY_ENGINE.EXECUTION_BUDGET_MS) {
          evt.deferMissingInWork = true;
          continue;
        }
        evt.error = "No SKU in OUTPUT_Work for \"" + evt.sku + "\" after "
          + Math.round(elapsed / 1000) + "s (age " + Math.round(eventAgeMs / 1000) + "s).";
        continue;
      }

      evt.readyInWork = true;
      var workR = work.skuMap[skuKey];

      // MPN from OUTPUT_Work / pre-reserved event payload
      if (!evt.reservedMpn && mpnColIdx != null) {
        var csvMpn = Number(work.data[workR][mpnColIdx]);
        if (isFinite(csvMpn) && csvMpn > 0) evt.reservedMpn = csvMpn;
      }

      // MPN from existing Loading Dock block
      if (!evt.reservedMpn) {
        var existRow = copyEngine_findExistingSkuInData_(tempAllData, evt.sku, tempMaxCols);
        if (existRow != null) {
          var dockHdrs = tempAllData[existRow - 2];
          var tMpnCol = -1;
          if (dockHdrs) {
            for (var c = 0; c < dockHdrs.length; c++) {
              if (String(dockHdrs[c]).trim() === "GPS Manufacturer Part Number") { tMpnCol = c; break; }
            }
          }
          if (tMpnCol !== -1) {
            var v = tempAllData[existRow - 1][tMpnCol];
            var n = Number(v);
            if (isFinite(n) && n > 0) evt.reservedMpn = n;
          }
        }
      }

      // Allocate new MPN if needed
      if (!evt.reservedMpn) {
        evt.reservedMpn = nextMpn + mpnIncrements;
        evt.isNewMpn = true;
        mpnIncrements++;
      }

      // Set MPN + Search Keywords in in-memory work data
      if (mpnColIdx != null) work.data[workR][mpnColIdx] = evt.reservedMpn;
      if (searchKwColIdx != null) work.data[workR][searchKwColIdx] = evt.reservedMpn + "," + evt.reservedMpn + "-L";

      readyCount++;
    }

    console.log("processSubmitEvents: " + readyCount + " ready — MPN @" + (Date.now() - t0) + "ms");

    /* ── 5. WRITE BLOCKS TO LOADING DOCK ── */
    if (readyCount > 0) {
      // v6.0: Budget guard — abort cleanly before partial writes
      if (Date.now() - t0 > COPY_ENGINE.EXECUTION_BUDGET_MS) {
        throw new Error("Budget exceeded before dock write (" + (Date.now() - t0) + "ms). Will retry.");
      }

      var workSh = ss.getSheetByName(COPY_ENGINE.WORK_SHEET);

      // Scan product blocks from IN-MEMORY work data (no re-read)
      var blocks = copyEngine_scanProductBlocks_fast_(work.data, work.hdrs, work.hMap);
      if (activeWorkSkuKey) {
        blocks = blocks.filter(function(block) {
          return String(block.sku || "").trim().toUpperCase() === activeWorkSkuKey;
        });
      }
      if (blocks.length === 0) throw new Error("No product blocks found in OUTPUT_Work.");

      // Load Products map ONCE
      var productsMap = copyEngine_loadProductsMap_(ss);

      // Prepare blocks with image compaction
      var prepared = [];
      var maxColsThisRun = 0;
      for (var bi = 0; bi < blocks.length; bi++) {
        var blk = blocks[bi];
        // v6.0: pass work.hMap directly instead of rebuilding per block
        var usedMax = copyEngine_findMaxImageUsedForRow_(work.hMap, blk.productRow);
        var keepMax = Math.min(COPY_ENGINE.MAX_IMAGE, Math.max(COPY_ENGINE.MIN_IMAGE, usedMax));
        var plan = copyEngine_buildCompactionPlan_(work.hdrs, keepMax);
        maxColsThisRun = Math.max(maxColsThisRun, plan.compactHeaders.length);
        prepared.push({ sku: blk.sku, emailBody: blk.emailBody, plan: plan, productRow: blk.productRow });
      }

      // Write blocks to Loading Dock
      var outputWidth = Math.max(tempMaxCols, maxColsThisRun);
      copyEngine_ensureColumns_(tempSh, outputWidth);
      var nextHdrRow = copyEngine_findNextAppendHeaderRow_fast_(tempAllData, tempMaxCols);

      for (var j = 0; j < prepared.length; j++) {
        var item = prepared[j];
        var compactProduct = copyEngine_applyCompaction_(item.productRow, item.plan.keepIndexes);

        var hdrRow   = new Array(outputWidth).fill("");
        var prodRow  = new Array(outputWidth).fill("");
        var emailRow = new Array(outputWidth).fill("");
        var blankRow = new Array(outputWidth).fill("");

        for (var c = 0; c < item.plan.compactHeaders.length; c++) hdrRow[c] = item.plan.compactHeaders[c];
        for (var c2 = 0; c2 < compactProduct.length; c2++) prodRow[c2] = compactProduct[c2];

        var localHMap = copyEngine_headerIndexMap_(item.plan.compactHeaders);
        var idxEL = localHMap.get(COPY_ENGINE.EMAIL_LABEL_HEADER);
        var idxEB = localHMap.get(COPY_ENGINE.PRODUCT_DESC_HEADER);
        if (idxEL != null) emailRow[idxEL] = "Email:";
        if (idxEB != null) emailRow[idxEB] = item.emailBody;

        // Products enrichment (price, retail, visibility)
        var pd = productsMap[item.sku.toUpperCase()] || { price: null, visible: null };
        var idxPrice   = localHMap.get("Price");
        var idxRetail  = localHMap.get("Retail Price");
        var idxVisible = localHMap.get("Product Visible?");
        if (idxPrice != null && pd.price != null) prodRow[idxPrice] = pd.price;
        if (idxRetail != null && pd.price != null) {
          var lo = Math.ceil(1.3 * pd.price);
          var hi = Math.floor(1.4 * pd.price);
          if (hi < lo) hi = lo;
          prodRow[idxRetail] = Math.round(lo + Math.random() * (hi - lo));
        }
        if (idxVisible != null) {
          prodRow[idxVisible] = (String(pd.visible || "").trim() === "1") ? "Y" : "N";
        }

        // Write to existing block position or append new
        var existProd = copyEngine_findExistingSkuInData_(tempAllData, item.sku, tempMaxCols);
        var writeRow;
        if (existProd != null) {
          writeRow = Math.max(1, existProd - 1);
        } else {
          writeRow = nextHdrRow;
          nextHdrRow += COPY_ENGINE.BLOCK_HEIGHT;
        }

        copyEngine_writeRows_(tempSh, writeRow, outputWidth, [hdrRow, prodRow, emailRow, blankRow]);
      }

      // Reset OUTPUT_Work from template (safe — all blocks written)
      copyEngine_resetWorkFromTemplate_(mustGetSheet_(ss, COPY_ENGINE.TEMPLATE_SHEET), workSh);

      // MPN bookkeeping
      if (mpnIncrements > 0) {
        mpnPanel_initIfNeeded();
        mpnPanel_setNext_(nextMpn + mpnIncrements);
        var lastEvt = null;
        for (var lp = 0; lp < pendingEvents.length; lp++) {
          if (pendingEvents[lp].isNewMpn) lastEvt = pendingEvents[lp];
        }
        ss.getSheetByName(MPN_PANEL.SHEET).getRange(MPN_PANEL.CELL_STATUS)
          .setValue("Web reserved block, NEXT_MPN -> " + (nextMpn + mpnIncrements));
        if (lastEvt) mpnPanel_logEvent_({ eventType: "MPN_RESERVE_WEB_BATCH", sku: lastEvt.sku, mpnValue: lastEvt.reservedMpn, error: "" });
      }

      console.log("processSubmitEvents: dock write + reset @" + (Date.now() - t0) + "ms");
    }

    /* ── 6. WRITE EVENT RESULTS ── */
    var ts = mpnPanel_melbTimestamp_();
    var hasDeferredEvents = false;
    var completedSkusForLog = [];

    for (var ep = 0; ep < pendingEvents.length; ep++) {
      var evt = pendingEvents[ep];
      if (evt.deferMissingInWork) {
        hasDeferredEvents = true;
        continue;
      }
      if (evt.error) {
        eventsSheet.getRange(evt.rowIndex, 6, 1, 2).setValues([[ts, "[processSubmitEvents] " + String(evt.error)]]);
        console.log("processSubmitEvents: ERROR " + evt.sku + ": " + evt.error);
      } else if (evt.alreadyInDock) {
        eventsSheet.getRange(evt.rowIndex, 6, 1, 2).setValues([[ts, ""]]);
        completedSkusForLog.push({ sku: evt.sku, mpnValue: evt.reservedMpn || "" });
      } else {
        eventsSheet.getRange(evt.rowIndex, 5, 1, 3).setValues([[evt.reservedMpn, ts, ""]]);
        eventsSheet.getRange(evt.rowIndex, 5).setNumberFormat("0");
        completedSkusForLog.push({ sku: evt.sku, mpnValue: evt.reservedMpn || "" });
      }
      mpnPanel_setScriptProp_("LAST_PROCESSED_SUBMIT_ROW", evt.rowIndex);
    }

    // v5.2: flush so edge function REST-API poll sees Processed_At immediately
    SpreadsheetApp.flush();

    // Log completion per SKU so downstream status checks can attribute the batch result.
    for (var cs = 0; cs < completedSkusForLog.length; cs++) {
      var completedEvt = completedSkusForLog[cs];
      mpnPanel_logEvent_({
        eventType: "COPY_ENGINE_RUN_COMPLETE",
        sku: completedEvt.sku,
        mpnValue: completedEvt.mpnValue,
        error: ""
      });
    }

    /* ── 7. CASCADE TRIGGER for deferred events ── */
    if (hasDeferredEvents) {
      try {
        eventsSheet.getRange("I2").setValue("DEFER_CASCADE|" + Date.now());
        SpreadsheetApp.flush();
        console.log("processSubmitEvents: cascade trigger for deferred event(s)");
      } catch (e) {
        console.warn("processSubmitEvents: cascade write failed (non-fatal):", e);
      }
    }

    console.log("processSubmitEvents: DONE " + (Date.now() - t0) + "ms");

  } catch (err) {
    console.error("processSubmitEvents error:", err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}
