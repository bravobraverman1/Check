const fs = require('fs');
const glob = require('glob');

const lockPattern = /var lock = LockService\.get(Script|Document)Lock\(\);\s*try \{\s*lock\.waitLock\(\d+\);\s*\} catch \([^\)]+\) \{[\s\S]*?return;\s*\}/g;

const robustLock = `var lock = LockService.get$1Lock();
  var lockAcquired = false;
  for (var lockWaitAttempt = 0; lockWaitAttempt < 10; lockWaitAttempt++) {
    try {
      lock.waitLock(29000);
      lockAcquired = true;
      break;
    } catch (e) {
      console.log("Waiting for lock... attempt " + (lockWaitAttempt + 1));
      Utilities.sleep(1000);
    }
  }
  if (!lockAcquired) {
    console.log("Could not acquire lock after 5 minutes, skipping.");
    return;
  }`;

const files = glob.sync('google-scripts/**/*.gs');
files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  let newContent = content.replace(lockPattern, robustLock);
  if (content !== newContent) {
    fs.writeFileSync(f, newContent);
    console.log(`Updated ${f}`);
  }
});
