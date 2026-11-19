import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildRunArgs as cursorArgs } from "../plugins/cursor/scripts/lib/cursor.mjs";
import { buildRunArgs as geminiArgs } from "../plugins/gemini/scripts/lib/gemini.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PLUGINS = ["opencode", "gemini", "claude", "cursor", "antigravity"];

function runCompanion(t, plugin, args, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opt-in-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, PLUGIN_DATA: path.join(dir, "data"), ...extraEnv };
  delete env.CLAUDE_PLUGIN_DATA;
  if (!("AGENT_BRIDGES_ALLOW_BYPASS" in extraEnv)) delete env.AGENT_BRIDGES_ALLOW_BYPASS;
  // Point every backend at a missing binary, so a run that gets past the gate fails on availability instead.
  for (const name of ["ANTIGRAVITY_BIN", "CURSOR_BIN", "CLAUDE_BIN", "GEMINI_BIN", "OPENCODE_BIN"]) env[name] = path.join(dir, "missing-bin");
  return spawnSync(process.execPath, [path.join(root, `plugins/${plugin}/scripts/${plugin}-companion.mjs`), ...args], { cwd: dir, env, encoding: "utf8" });
}

for (const plugin of PLUGINS) {
  test(`${plugin}: --write alone is refused before anything runs`, (t) => {
    const result = runCompanion(t, plugin, ["task", "--wait", "--write", "do it"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--bypass-permissions/);
    assert.match(result.stderr, /AGENT_BRIDGES_ALLOW_BYPASS/);
  });

  test(`${plugin}: --write with an opt-in gets past the gate`, (t) => {
    for (const [args, env] of [
      [["task", "--wait", "--write", "--bypass-permissions", "do it"], {}],
      [["task", "--wait", "--write", "do it"], { AGENT_BRIDGES_ALLOW_BYPASS: "1" }]
    ]) {
      const result = runCompanion(t, plugin, args, env);
      assert.doesNotMatch(result.stderr, /--bypass-permissions/, `${plugin} ${args.join(" ")}`);
    }
  });
}

test("cursor passes --trust only with the trust opt-in", () => {
  assert.equal(cursorArgs({ prompt: "p", env: {} }).includes("--trust"), false);
  assert.equal(cursorArgs({ prompt: "p", env: { AGENT_BRIDGES_TRUST: "1" } }).includes("--trust"), true);
});

test("gemini passes --skip-trust only with the trust opt-in", () => {
  assert.equal(geminiArgs("/repo", { backend: "gemini", prompt: "p", env: {} }).includes("--skip-trust"), false);
  assert.equal(geminiArgs("/repo", { backend: "gemini", prompt: "p", env: { AGENT_BRIDGES_TRUST: "1" } }).includes("--skip-trust"), true);
});

test("the --trust flag reaches the cursor CLI", { skip: process.platform === "win32" ? "POSIX fake" : false }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opt-in-trust-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "log");
  const fake = path.join(dir, "agent");
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nif (process.argv.includes("--version")) { console.log("1.0"); process.exit(0); }\nconsole.log('{"type":"result","result":"ok","session_id":"s"}');\n`, { mode: 0o755 });
  const env = { ...process.env, PLUGIN_DATA: path.join(dir, "data"), CURSOR_BIN: fake };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.AGENT_BRIDGES_TRUST;
  const companion = path.join(root, "plugins/cursor/scripts/cursor-companion.mjs");
  spawnSync(process.execPath, [companion, "task", "--wait", "plain"], { cwd: dir, env, encoding: "utf8" });
  spawnSync(process.execPath, [companion, "task", "--wait", "--trust", "trusted"], { cwd: dir, env, encoding: "utf8" });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a) => a.includes("-p"));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes("--trust"), false);
  assert.equal(calls[1].includes("--trust"), true);
});

test("docs: rescue is read-only by default and delegate opts in explicitly", () => {
  for (const plugin of PLUGINS) {
    const skills = path.join(root, "plugins", plugin, "skills");
    const rescue = fs.readFileSync(path.join(skills, `${plugin}-rescue`, "SKILL.md"), "utf8");
    assert.doesNotMatch(rescue, /Default to a write-capable/, plugin);
    assert.match(rescue, /Default to a read-only run/, plugin);
    assert.match(rescue, /--write --bypass-permissions/, plugin);
    const delegate = fs.readFileSync(path.join(skills, `${plugin}-delegate`, "SKILL.md"), "utf8");
    assert.match(delegate, /--fresh --write --bypass-permissions/, plugin);
    assert.doesNotMatch(delegate, /--fresh --write(?! --bypass-permissions)/, plugin);
  }
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /## Permissions are opt-in/);
  assert.match(readme, /AGENT_BRIDGES_ALLOW_BYPASS=1/);
  assert.match(readme, /AGENT_BRIDGES_TRUST=1/);
});
