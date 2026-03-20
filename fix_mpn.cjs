const fs = require('fs');

const f = 'google-scripts/MpnPanel.gs';
let content = fs.readFileSync(f, 'utf8');

const lockPattern = /var lock = LockService\.getDocumentLock\(\);\s*lock\.waitLock\(\d+\);\s*try \{/g;
const robustLock = `var lock = LockService.getDocumentLock();
  var lockAcquired = false;
  for (var lockWaitAttempt = 0; lockWaitAttempt < 11; lockWaitAttempt++) {
    try {
      lock.waitLock(29000);
      lockAcquired = true;
      break;
    } catch (e) {
      Utilities.sleep(1000);
    }
  }
  if (!lockAcquired) throw new Error("Could not acquire lock for MPN Panel after ~5 minutes.");
  try {`;

content = content.replace(lockPattern, robustLock);
fs.writeFileSync(f, content);
console.log("Updated MpnPanel");
