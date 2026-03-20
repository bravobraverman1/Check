import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { buildLoadingDockCsvText, LOADING_DOCK_CSV_MAX_COLS } from "./loadingDockCsv";

type AppsScriptCsvExports = {
  csvEscape_: (value: string) => string;
  normalizeDescriptionCell: (value: string) => string;
  normalizeSemicolonCell: (value: string) => string;
  formatDimensionValueForCsv: (headerName: string, value: string) => string;
  isSemicolonListHeader: (headerName: string) => boolean;
  getRequiredImageSlotLastCol: (
    headers: Array<string | null | undefined>,
    row: Array<string | null | undefined>,
    maxCols: number,
  ) => number;
};

function loadAppsScriptCsvExports(
  relativeFilePaths: string[],
  exportedFunctionMap: Record<string, string>,
): AppsScriptCsvExports {
  const context = vm.createContext({
    console,
    Logger: { log: () => undefined },
    Utilities: { newBlob: (...args: unknown[]) => ({ args }) },
    GmailApp: { sendEmail: () => undefined },
    SpreadsheetApp: {},
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) },
  });

  for (const relativeFilePath of relativeFilePaths) {
    const absolutePath = path.resolve(process.cwd(), relativeFilePath);
    const source = fs.readFileSync(absolutePath, "utf8");
    vm.runInContext(source, context);
  }

  const exportAssignments = Object.entries(exportedFunctionMap)
    .map(([alias, functionName]) => `${JSON.stringify(alias)}: typeof ${functionName} !== "undefined" ? ${functionName} : undefined`)
    .join(", ");

  vm.runInContext(`this.__csvExports = { ${exportAssignments} };`, context);

  for (const alias of Object.keys(exportedFunctionMap)) {
    if (typeof (context.__csvExports as Record<string, unknown>)[alias] !== "function") {
      throw new Error(`Apps Script export "${alias}" could not be loaded for ${relativeFilePaths.join(", ")}`);
    }
  }

  return context.__csvExports as AppsScriptCsvExports;
}

function buildCsvViaAppsScript(
  scriptExports: AppsScriptCsvExports,
  headersInput: Array<string | null | undefined>,
  rowInput: Array<string | null | undefined>,
  maxCols = LOADING_DOCK_CSV_MAX_COLS,
): string {
  const headers = headersInput.map((value) => (value ?? "").toString());
  const exportRow = rowInput.map((value) => (value ?? "").toString());
  const requiredImageSlotLastCol = scriptExports.getRequiredImageSlotLastCol(headers, exportRow, maxCols);
  let requiredImageSlotCount = 0;
  if (requiredImageSlotLastCol >= 0) {
    for (let i = 0; i < Math.min(headers.length, maxCols); i++) {
      const match = String(headers[i] || "").trim().match(/^Product Image (ID|File|Description|Is Thumbnail|Sort)\s*-\s*(\d+)$/i);
      if (!match || i > requiredImageSlotLastCol) continue;
      const slotNumber = Number.parseInt(match[2] || "", 10);
      if (Number.isFinite(slotNumber)) requiredImageSlotCount = Math.max(requiredImageSlotCount, slotNumber);
    }
  }

  let lastCol = 0;
  for (let c = 0; c < Math.min(headers.length, maxCols); c++) {
    const imageMatch = String(headers[c] || "").trim().match(/^Product Image (ID|File|Description|Is Thumbnail|Sort)\s*-\s*(\d+)$/i);
    if (imageMatch) {
      const slot = Number.parseInt(imageMatch[2] || "", 10);
      // Skip ALL columns of excess slots (matching updated Apps Script logic)
      if (slot > requiredImageSlotCount) continue;
    }
    if ((headers[c] ?? "").trim() || (exportRow[c] ?? "").trim()) {
      lastCol = c;
    }
  }
  lastCol = Math.max(lastCol, requiredImageSlotLastCol);
  const selectedCols: number[] = [];
  for (let c = 0; c <= lastCol; c++) {
    const imageMatch = String(headers[c] || "").trim().match(/^Product Image (ID|File|Description|Is Thumbnail|Sort)\s*-\s*(\d+)$/i);
    if (imageMatch) {
      const slot = Number.parseInt(imageMatch[2] || "", 10);
      // Skip ALL columns of excess slots (matching updated Apps Script logic)
      if (slot > requiredImageSlotCount) continue;
    }
    selectedCols.push(c);
  }

  const selectedHeaderRow = selectedCols.map((index) => headers[index] ?? "");
  const selectedExportRow = selectedCols.map((index) => exportRow[index] ?? "");
  for (let c = 0; c < selectedCols.length; c++) {
    const headerName = String(selectedHeaderRow[c] || "").trim().toLowerCase();
    if (headerName === "product description" || headerName === "description") {
      selectedExportRow[c] = scriptExports.normalizeDescriptionCell(selectedExportRow[c]);
      continue;
    }
    if (scriptExports.isSemicolonListHeader(headerName)) {
      selectedExportRow[c] = scriptExports.normalizeSemicolonCell(selectedExportRow[c]);
      continue;
    }
    selectedExportRow[c] = scriptExports.formatDimensionValueForCsv(selectedHeaderRow[c], selectedExportRow[c]);
  }

  const csvHeader = selectedHeaderRow.map(scriptExports.csvEscape_);
  const csvData = selectedExportRow.map(scriptExports.csvEscape_);
  return `${csvHeader.join(",")}\n${csvData.join(",")}`;
}

describe("loading dock csv parity", () => {
  const emailSingleExports = loadAppsScriptCsvExports(["google-scripts/EmailSingle.gs"], {
    csvEscape_: "csvEscape_",
    normalizeDescriptionCell: "emailSingle_normalizeDescriptionCell_",
    normalizeSemicolonCell: "emailSingle_normalizeSemicolonCell_",
    formatDimensionValueForCsv: "emailSingle_formatDimensionValueForCsv_",
    isSemicolonListHeader: "emailSingle_isSemicolonListHeader_",
    getRequiredImageSlotLastCol: "emailSingle_getRequiredImageSlotLastCol_",
  });

  const sendDockExports = loadAppsScriptCsvExports([
    "google-scripts/EmailSingle.gs",
    "google-scripts/SendDock.gs",
  ], {
    csvEscape_: "csvEscape_",
    normalizeDescriptionCell: "sendDock_normalizeDescriptionCell_",
    normalizeSemicolonCell: "sendDock_normalizeSemicolonCell_",
    formatDimensionValueForCsv: "sendDock_formatDimensionValueForCsv_",
    isSemicolonListHeader: "sendDock_isSemicolonListHeader_",
    getRequiredImageSlotLastCol: "sendDock_getRequiredImageSlotLastCol_",
  });

  it("matches EmailSingle and SendDock attachment formatting", () => {
    const headers = new Array<string>(205).fill("");
    headers[0] = "Product Name";
    headers[1] = "Product Code/SKU";
    headers[2] = "Product Description";
    headers[3] = "Category";
    headers[4] = "Filters";
    headers[5] = "Air Movement";
    headers[6] = "Fan Cutout";
    headers[7] = "Product Image File - 1";
    headers[8] = "Quoted Field";
    headers[201] = "Overflow";

    const productRow = new Array<string>(205).fill("");
    productRow[0] = 'Cabinet "Light", White';
    productRow[1] = "10081--DOM";
    productRow[2] =
      "<p>Primary description line.</p><p>Secondary description line.</p><p><strong>COLOUR:</strong> White <br/><strong>IP RATING:</strong> IP65 <br/></p>";
    productRow[3] = "Lighting ; Indoor";
    productRow[4] = "Fan Cutout=150X165; Air Movement=1234; Type=Recessed";
    productRow[5] = "1234";
    productRow[6] = "150X165";
    productRow[7] = "https://example.com/image1.jpg";
    productRow[8] = 'Text with "quotes", comma, and\nnewline';
    productRow[201] = "SHOULD_NOT_EXPORT";

    const edgeCsv = buildLoadingDockCsvText(headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
    const emailSingleCsv = buildCsvViaAppsScript(emailSingleExports, headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
    const sendDockCsv = buildCsvViaAppsScript(sendDockExports, headers, productRow, LOADING_DOCK_CSV_MAX_COLS);

    expect(emailSingleCsv).toBe(edgeCsv);
    expect(sendDockCsv).toBe(edgeCsv);
    expect(edgeCsv).not.toContain("SHOULD_NOT_EXPORT");
  });

  it("keeps columns after image slots while still trimming blank image tails", () => {
    const headers = new Array<string>(120).fill("");
    const productRow = new Array<string>(120).fill("");

    headers[0] = "Product Name";
    productRow[0] = "Example";

    for (let i = 1; i <= 12; i++) {
      const base = 1 + (i - 1) * 5;
      headers[base] = `Product Image ID - ${i}`;
      headers[base + 1] = `Product Image File - ${i}`;
      headers[base + 2] = `Product Image Description - ${i}`;
      headers[base + 3] = `Product Image Is Thumbnail - ${i}`;
      headers[base + 4] = `Product Image Sort - ${i}`;
      if (i <= 10) productRow[base + 1] = `https://example.com/image-${i}.jpg`;
      if (i <= 10) productRow[base + 3] = i === 1 ? "Y" : "N";
      if (i <= 10) productRow[base + 4] = String(i - 1);
    }

    headers[80] = "Page Title";
    productRow[80] = "Example Page Title";
    headers[81] = "Meta Description";
    productRow[81] = "Example meta description";
    headers[82] = "GPS Category";
    productRow[82] = "Lighting ; Indoor";
    headers[83] = "Product Custom Fields";
    productRow[83] = "Fan Cutout=150X165; Air Movement=1234; Type=Recessed";

    const edgeCsv = buildLoadingDockCsvText(headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
    const emailSingleCsv = buildCsvViaAppsScript(emailSingleExports, headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
    const sendDockCsv = buildCsvViaAppsScript(sendDockExports, headers, productRow, LOADING_DOCK_CSV_MAX_COLS);

    expect(edgeCsv).toContain("Product Image Sort - 10");
    expect(edgeCsv).not.toContain("Product Image ID - 11");
    expect(edgeCsv).toContain("Page Title");
    expect(edgeCsv).toContain("Example Page Title");
    expect(edgeCsv).toContain("Meta Description");
    expect(edgeCsv).toContain("Example meta description");
    expect(edgeCsv).toContain("GPS Category");
    expect(edgeCsv).toContain("Lighting;Indoor");
    expect(edgeCsv).toContain("Product Custom Fields");
    expect(edgeCsv).toContain("Fan Cutout=150cm x 165cm;Air Movement=1234m³/h;Type=Recessed");
    expect(emailSingleCsv).toBe(edgeCsv);
    expect(sendDockCsv).toBe(edgeCsv);
  });

  it("keeps the known post-image schema headers even when those trailing fields are blank", () => {
    const headers = new Array<string>(140).fill("");
    const productRow = new Array<string>(140).fill("");

    headers[0] = "Product Name";
    productRow[0] = "Example";

    for (let i = 1; i <= 12; i++) {
      const base = 1 + (i - 1) * 5;
      headers[base] = `Product Image ID - ${i}`;
      headers[base + 1] = `Product Image File - ${i}`;
      headers[base + 2] = `Product Image Description - ${i}`;
      headers[base + 3] = `Product Image Is Thumbnail - ${i}`;
      headers[base + 4] = `Product Image Sort - ${i}`;
      if (i <= 3) productRow[base + 1] = `https://example.com/image-${i}.jpg`;
      if (i <= 3) productRow[base + 3] = i === 1 ? "Y" : "N";
      if (i <= 3) productRow[base + 4] = String(i - 1);
    }

    const trailingHeaders = [
      "Search Keywords",
      "Page Title",
      "Meta Keywords",
      "Meta Description",
      "MYOB Asset Acct",
      "MYOB Income Acct",
      "MYOB Expense Acct",
      "Product Condition",
      "Show Product Condition?",
      "Event Date Required?",
      "Event Date Name",
      "Event Date Is Limited?",
      "Event Date Start Date",
      "Event Date End Date",
      "Sort Order",
      "Product Tax Class",
      "Product UPC/EAN",
      "Stop Processing Rules",
      "Product URL",
      "Redirect Old URL?",
      "GPS Manufacturer Part Number",
      "GPS Category",
      "GPS Enabled",
      "Avalara Product Tax Code",
      "Product Custom Fields",
    ];
    trailingHeaders.forEach((header, index) => {
      headers[90 + index] = header;
    });

    const edgeCsv = buildLoadingDockCsvText(headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
    const emailSingleCsv = buildCsvViaAppsScript(emailSingleExports, headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
    const sendDockCsv = buildCsvViaAppsScript(sendDockExports, headers, productRow, LOADING_DOCK_CSV_MAX_COLS);

    expect(edgeCsv).toContain("Product Image Sort - 8");
    expect(edgeCsv).not.toContain("Product Image ID - 9");
    expect(edgeCsv).toContain("Search Keywords");
    expect(edgeCsv).toContain("Product Custom Fields");
    expect(emailSingleCsv).toBe(edgeCsv);
    expect(sendDockCsv).toBe(edgeCsv);
  });

  it("excludes excess image slots that only have Sort/Thumbnail defaults but no File URL", () => {
    const headers = new Array<string>(120).fill("");
    const productRow = new Array<string>(120).fill("");

    headers[0] = "Product Name";
    productRow[0] = "Example";

    // 12 image slots, but only slots 1-2 have actual File URLs
    for (let i = 1; i <= 12; i++) {
      const base = 1 + (i - 1) * 5;
      headers[base] = `Product Image ID - ${i}`;
      headers[base + 1] = `Product Image File - ${i}`;
      headers[base + 2] = `Product Image Description - ${i}`;
      headers[base + 3] = `Product Image Is Thumbnail - ${i}`;
      headers[base + 4] = `Product Image Sort - ${i}`;
      // All slots get Sort and Thumbnail defaults (like Google Sheets formulas do)
      productRow[base + 3] = i <= 2 ? (i === 1 ? "Y" : "N") : "N";
      productRow[base + 4] = String(i - 1);
      // But only slots 1-2 have actual image URLs
      if (i <= 2) productRow[base + 1] = `https://example.com/image-${i}.jpg`;
    }

    headers[80] = "Product Custom Fields";
    productRow[80] = "Type=Recessed";

    const edgeCsv = buildLoadingDockCsvText(headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
    const emailSingleCsv = buildCsvViaAppsScript(emailSingleExports, headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
    const sendDockCsv = buildCsvViaAppsScript(sendDockExports, headers, productRow, LOADING_DOCK_CSV_MAX_COLS);

    // Should include up to slot 8 (minimum) but NOT slot 9+
    expect(edgeCsv).toContain("Product Image Sort - 8");
    expect(edgeCsv).not.toContain("Product Image ID - 9");
    expect(edgeCsv).not.toContain("Product Image Sort - 9");
    // Parity
    expect(emailSingleCsv).toBe(edgeCsv);
    expect(sendDockCsv).toBe(edgeCsv);
  });

  it("ignores invisible or placeholder file-cell residue in parity", () => {
    const headers = new Array<string>(120).fill("");
    const productRow = new Array<string>(120).fill("");

    headers[0] = "Product Name";
    productRow[0] = "Example";

    for (let i = 1; i <= 12; i++) {
      const base = 1 + (i - 1) * 5;
      headers[base] = `Product Image ID - ${i}`;
      headers[base + 1] = `Product Image File - ${i}`;
      headers[base + 2] = `Product Image Description - ${i}`;
      headers[base + 3] = `Product Image Is Thumbnail - ${i}`;
      headers[base + 4] = `Product Image Sort - ${i}`;
      productRow[base + 3] = i === 1 ? "Y" : "N";
      productRow[base + 4] = String(i - 1);
      if (i <= 2) productRow[base + 1] = `https://example.com/image-${i}.jpg`;
    }

    // Invisible residue in file cells of slots 9-12
    productRow[42] = "\u200B";
    productRow[47] = "\uFEFF";
    productRow[52] = "N/A";
    productRow[57] = "0";

    const edgeCsv = buildLoadingDockCsvText(headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
    const emailSingleCsv = buildCsvViaAppsScript(emailSingleExports, headers, productRow, LOADING_DOCK_CSV_MAX_COLS);
    const sendDockCsv = buildCsvViaAppsScript(sendDockExports, headers, productRow, LOADING_DOCK_CSV_MAX_COLS);

    expect(edgeCsv).toContain("Product Image Sort - 8");
    expect(edgeCsv).not.toContain("Product Image ID - 9");
    expect(emailSingleCsv).toBe(edgeCsv);
    expect(sendDockCsv).toBe(edgeCsv);
  });
});
