import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildRunEnv, READ_ONLY_PERMISSION } from "../plugins/opencode/scripts/lib/opencode.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(root, "plugins/opencode/scripts/opencode-companion.mjs");

test("read-only runs deny every tool but read, glob and list, and keep .env out", () => {
  const env = buildRunEnv({ write: false }, { PATH: "/bin" });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.permission, READ_ONLY_PERMISSION);
  assert.equal(READ_ONLY_PERMISSION["*"], "deny");
  // grep searches file contents, so allowing it would print .env secrets the read rule blocks.
  assert.equal(READ_ONLY_PERMISSION.grep, undefined);
  assert.equal(READ_ONLY_PERMISSION.read["*.env"], "deny");
  assert.equal(READ_ONLY_PERMISSION.read["*.env.*"], "deny");
  assert.equal(READ_ONLY_PERMISSION.read["*.env.example"], "allow");
});

test("a read-only run keeps the user's other per-run settings and replaces only permission", () => {
  const env = buildRunEnv({}, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "p/m", permission: { "*": "allow" } }) });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.model, "p/m");
  assert.deepEqual(config.permission, READ_ONLY_PERMISSION);
  assert.deepEqual(JSON.parse(buildRunEnv({}, { OPENCODE_CONFIG_CONTENT: "not json" }).OPENCODE_CONFIG_CONTENT), { permission: READ_ONLY_PERMISSION });
  const writeEnv = { OPENCODE_CONFIG_CONTENT: "{}" };
  assert.equal(buildRunEnv({ write: true }, writeEnv), writeEnv);
});

test("the companion runs OpenCode with the allowlist unless --write is given", { skip: process.platform === "win32" ? "fake opencode needs a POSIX shebang" : false }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ro-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "env.log");
  fs.writeFileSync(path.join(bin, "opencode"), `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("1.19.5\\n"); process.exit(0); }
if (argv[0] === "run") fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ auto: argv.includes("--auto"), config: process.env.OPENCODE_CONFIG_CONTENT ?? null }) + "\\n");
process.exit(0);
`, { mode: 0o755 });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PLUGIN_DATA: path.join(dir, "data") };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.OPENCODE_CONFIG_CONTENT;
  spawnSync(process.execPath, [COMPANION, "task", "--wait"], { cwd: repo, env, input: "look around", encoding: "utf8" });
  spawnSync(process.execPath, [COMPANION, "task", "--wait", "--write", "--bypass-permissions"], { cwd: repo, env, input: "change it", encoding: "utf8" });
  const runs = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].auto, false);
  assert.deepEqual(JSON.parse(runs[0].config).permission, READ_ONLY_PERMISSION);
  assert.equal(runs[1].auto, true);
  assert.equal(runs[1].config, null);
});
