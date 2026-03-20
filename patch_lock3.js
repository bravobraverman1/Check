import fs from 'fs';

let code = fs.readFileSync('google-scripts/CopyEngine.gs', 'utf8');

const acquireLockCode = `
    if (pendingEvents.length === 0) return;

    // --- ACQUIRE GLOBAL EDGE FUNCTION LOCK (H1) ---
    var lockCell = eventsSheet.getRange("H1");
    var lockAcquired = false;
    for (var lockAttempt = 0; lockAttempt < 30; lockAttempt++) {
        var currentLock = String(lockCell.getValue() || "");
        if (currentLock === "") {
            lockAcquired = true; break;
        }
        var parts = currentLock.split("|");
        if (parts.length > 1) {
            var ts = parseInt(parts[1], 10);
            if (Date.now() - ts > 180000) { // stale
               lockAcquired = true; break;
            }
        }
        if (currentLock.indexOf("APPS_SCRIPT|") === 0) {
            lockAcquired = true; break;
        }
        Utilities.sleep(1000);
    }
    if (lockAcquired) {
        lockCell.setValue("APPS_SCRIPT|" + Date.now());
        SpreadsheetApp.flush();
    }
    // ----------------------------------------------
`;

const releaseLockCode = `
  } finally {
    try {
      if (typeof eventsSheet !== "undefined" && eventsSheet) {
          var lockValue = String(eventsSheet.getRange("H1").getValue() || "");
          if (lockValue.indexOf("APPS_SCRIPT|") === 0) {
              eventsSheet.getRange("H1").setValue("");
              SpreadsheetApp.flush();
          }
      }
    } catch(e) {}
    lock.releaseLock();
  }`;

if (code.includes('if (pendingEvents.length === 0) return;')) {
    code = code.replace('if (pendingEvents.length === 0) return;', acquireLockCode);
} else {
    throw new Error("Could not find 'if (pendingEvents.length === 0) return;'");
}

code = code.replace(/}\s*finally\s*\{\s*lock\.releaseLock\(\);\s*}/g, releaseLockCode.trim());

fs.writeFileSync('google-scripts/CopyEngine.gs', code);
console.log("Lock patch applied!");
