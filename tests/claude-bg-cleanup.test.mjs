import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(root, "plugins/claude/scripts/claude-companion.mjs");

for (const [label, launch] of [["exits non-zero", "echo boom >&2\nexit 3"], ["exits 0 without a session id", "echo started\nexit 0"]]) {
test(`a claude --bg launch that ${label} removes the prompt file it wrote`, { skip: process.platform === "win32" ? "fake claude needs a POSIX shebang" : false }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "claude");
  // Answers the setup probes, then fails the --bg launch.
  fs.writeFileSync(fake, `#!/bin/sh\ncase \"$1\" in --version) echo 2.1.0; exit 0;; auth) exit 0;; esac\n${launch}\n`, { mode: 0o755 });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const data = path.join(dir, "data");
  const env = { ...process.env, PLUGIN_DATA: data, CLAUDE_BIN: fake };
  delete env.CLAUDE_PLUGIN_DATA;
  const result = spawnSync(process.execPath, [COMPANION, "task", "--background"], { cwd: repo, env, input: "SECRET-PROMPT", encoding: "utf8" });
  assert.notEqual(result.status, 0, result.stdout);
  const leftovers = [];
  const walk = (folder) => {
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full, "utf8").includes("SECRET-PROMPT")) leftovers.push(full);
    }
  };
  walk(data);
  assert.deepEqual(leftovers, []);
});
}

test("claude job commands start the CLI the way a launch does, never through a shell", () => {
  // Node cannot spawn an npm .cmd shim without a shell; status, result and cancel must use the shim route too.
  const source = fs.readFileSync(COMPANION, "utf8");
  assert.doesNotMatch(source, /runCommand\(\s*resolveClaudeBin\(\)/);
  for (const sub of ["agents", "logs", "stop"]) assert.match(source, new RegExp(`runClaude\\(\\[\\s*"${sub}"`), sub);
});
