import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();
const vitestEntrypoint = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");

function listTests(dir, matcher) {
  return readdirSync(path.join(repoRoot, dir))
    .filter((name) => matcher.test(name))
    .map((name) => path.posix.join(dir, name))
    .sort();
}

function runVitestGroup(label, extraArgs, files) {
  if (files.length === 0) return;

  console.log(`\n== ${label} ==`);
  console.log(files.join("\n"));

  const result = spawnSync(
    process.execPath,
    [vitestEntrypoint, "run", "--maxWorkers=1", "--minWorkers=1", ...extraArgs, ...files],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=4096",
      },
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const libTests = listTests("src/lib", /\.test\.ts$/);
const browserDependentLibTests = [
  "src/lib/loadingDockPending.test.ts",
  "src/lib/syncResilience.test.ts",
];
const nodeLibTests = libTests.filter((file) => !browserDependentLibTests.includes(file));
const uiTests = [
  ...browserDependentLibTests,
  ...listTests("src/test", /\.test\.(ts|tsx)$/),
];

for (const file of nodeLibTests) {
  runVitestGroup(`Library test ${file}`, ["--environment=node"], [file]);
}

for (const file of uiTests) {
  runVitestGroup(`UI test ${file}`, ["--environment=jsdom"], [file]);
}
