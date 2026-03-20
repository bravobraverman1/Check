const fs = require('fs');

const f = 'google-scripts/EmailSingle.gs';
let content = fs.readFileSync(f, 'utf8');

const lockPattern = /const lock = LockService\.getScriptLock\(\);\s*if \(\!lock\.tryLock\(\d+\)\) \{\s*Logger\.log\("[^"]+"\);\s*return;\s*\}/g;
const robustLock = `const lock = LockService.getScriptLock();
  var lockAcquired = false;
  for (var lockWaitAttempt = 0; lockWaitAttempt < 11; lockWaitAttempt++) {
    if (lock.tryLock(29000)) {
      lockAcquired = true;
      break;
    }
  }
  if (!lockAcquired) {
    Logger.log("EmailSingle: Could not acquire lock after 5 minutes, skipping.");
    return;
  }`;

content = content.replace(lockPattern, robustLock);
fs.writeFileSync(f, content);
console.log("Updated EmailSingle");
