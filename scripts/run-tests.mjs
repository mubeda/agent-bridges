import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const testsDir = path.join(root, "tests");

function findTestFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(full);
    }
  }
  return files;
}

const testFiles = findTestFiles(testsDir);
if (testFiles.length === 0) {
  process.stderr.write("no test files found\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  cwd: root
});
process.exit(result.status ?? 1);
