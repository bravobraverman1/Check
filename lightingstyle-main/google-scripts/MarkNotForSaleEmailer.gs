/*************************************************************
 * NOT_FOR_SALE Emailer (Hardened Melbourne Time)
 *************************************************************/

const RECIPIENTS = ["bravobraverman@gmail.com", "eran.braverman@lightingstyle.com.au"];
const SUBJECT_TEMPLATE = "TEST ONLY - Product marked NOT FOR SALE: {{SKU}}";
const BODY_TEMPLATE = `
A product has been marked as NOT FOR SALE.

SKU: {{SKU}}
Event Type: {{EVENT_TYPE}}
Timestamp (Melbourne, AUS): {{TIMESTAMP_MELB}}
`;

const EVENTS_SHEET_NAME = "Events";
const TARGET_EVENT_TYPE = "MARK_NOT_FOR_SALE";

// Explicit Melbourne Settings
const MELB_TZ = "Australia/Melbourne";
const MELB_EMAIL_TS_FORMAT = "EEE MMM dd yyyy HH:mm:ss z"; 
const MELB_SHEET_TS_FORMAT = "yyyy-MM-dd HH:mm:ss z";

/**
 * Returns the current time formatted strictly for Melbourne.
 */
function getNowMelbString() {
  return Utilities.formatDate(new Date(), MELB_TZ, MELB_SHEET_TS_FORMAT);
}

function processMarkNotForSaleEvents() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    console.log("Could not obtain lock");
    return;
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(EVENTS_SHEET_NAME);
    if (!sheet) throw new Error(`Sheet "${EVENTS_SHEET_NAME}" not found`);

    const COL_TS = 1;           // A
    const COL_EVENT_TYPE = 3;   // C
    const COL_SKU = 4;          // D
    const COL_PROCESSED_AT = 6; // F
    const COL_ERROR = 7;        // G

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const data = sheet.getRange(2, 1, lastRow - 1, COL_ERROR).getValues();

    for (let i = 0; i < data.length; i++) {
      const rowIndex = i + 2;
      const row = data[i];

      const tsRaw = row[COL_TS - 1];
      const eventType = String(row[COL_EVENT_TYPE - 1] || "").trim();
      const sku = String(row[COL_SKU - 1] || "").trim();
      const processedAt = String(row[COL_PROCESSED_AT - 1] || "").trim();

      // Skip if already processed or wrong event
      if (processedAt || eventType !== TARGET_EVENT_TYPE) continue;

      if (!sku) {
        sheet.getRange(rowIndex, COL_ERROR).setValue("Missing SKU");
        sheet.getRange(rowIndex, COL_PROCESSED_AT).setValue(getNowMelbString());
        continue;
      }

      // Set temporary status
      sheet.getRange(rowIndex, COL_PROCESSED_AT).setValue("PROCESSING");
      SpreadsheetApp.flush();

      try {
        let displayTime;
        
        // Handle the timestamp from Column A
        if (tsRaw instanceof Date) {
          // If it's a real Date object from the sheet, format it to Melb string
          displayTime = Utilities.formatDate(tsRaw, MELB_TZ, MELB_EMAIL_TS_FORMAT);
        } else if (typeof tsRaw === "string" && tsRaw.length > 5) {
          // If it's a string, we trust it or try to convert it
          displayTime = tsRaw; 
        } else {
          // Fallback to current time if A is empty/weird
          displayTime = Utilities.formatDate(new Date(), MELB_TZ, MELB_EMAIL_TS_FORMAT);
        }

        const subject = SUBJECT_TEMPLATE.replace(/{{SKU}}/g, sku);
        const body = BODY_TEMPLATE
          .replace(/{{SKU}}/g, sku)
          .replace(/{{EVENT_TYPE}}/g, eventType)
          .replace(/{{TIMESTAMP_MELB}}/g, displayTime);

        MailApp.sendEmail({
          to: RECIPIENTS.join(","),
          subject: subject,
          body: body
        });

        // Mark success with Melbourne timestamp
        sheet.getRange(rowIndex, COL_PROCESSED_AT).setValue(getNowMelbString());
        sheet.getRange(rowIndex, COL_ERROR).setValue("");

      } catch (err) {
        sheet.getRange(rowIndex, COL_PROCESSED_AT).setValue("");
        sheet.getRange(rowIndex, COL_ERROR).setValue("Error: " + err.message);
      }
    }
  } finally {
    lock.releaseLock();
  }
}
