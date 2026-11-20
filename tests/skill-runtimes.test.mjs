import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PLUGIN_SKILL_DIRS = ["opencode", "gemini", "claude", "cursor", "antigravity"].map((p) => `./plugins/${p}/skills`);

test("skills.sh.json lists the five plugin skill folders", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "skills.sh.json"), "utf8"));
  assert.deepEqual(catalog.paths, PLUGIN_SKILL_DIRS);
  const names = [];
  for (const entry of catalog.paths) {
    assert.ok(entry.startsWith("./"), entry);
    assert.doesNotMatch(entry, /\/(commands|agents|scripts|tests)(\/|$)/, entry);
    const dir = path.join(root, entry);
    assert.ok(fs.statSync(dir).isDirectory(), entry);
    for (const skill of fs.readdirSync(dir)) {
      const file = path.join(dir, skill, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      names.push(fs.readFileSync(file, "utf8").match(/^name:\s*(\S+)/m)?.[1]);
    }
  }
  assert.equal(names.length, 55);
  assert.equal(new Set(names).size, 55);
  assert.ok(names.includes("antigravity-review"));
  assert.ok(names.includes("gemini-cli-runtime"));
});

const sync = await import("../scripts/sync-skills.mjs");

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("every runtime skill holds a byte-identical copy of its plugin sources", () => {
  const runtimes = sync.listPluginRuntimes(root);
  assert.equal(runtimes.length, sync.PLUGINS.length * sync.SYNCED_DIRS.length);
  for (const plugin of sync.PLUGINS) {
    assert.ok(fs.existsSync(path.join(root, `plugins/${plugin}/skills/${plugin}-cli-runtime/SKILL.md`)), plugin);
  }
  for (const { plugin, dir, source, target } of runtimes) {
    const diff = sync.compareTrees(source, target);
    assert.deepEqual(diff, [], `${plugin}/${dir}: first difference ${diff[0]}; run npm run sync:skills`);
  }
});

test("compareTrees reports changed, extra and orphaned files", (t) => {
  const base = tempDir(t, "skill-compare-");
  const source = path.join(base, "src");
  const target = path.join(base, "dst");
  write(path.join(source, "lib/a.mjs"), "a");
  write(path.join(target, "lib/a.mjs"), "b");
  assert.deepEqual(sync.compareTrees(source, target), ["lib/a.mjs"]);
  write(path.join(target, "lib/a.mjs"), "a");
  write(path.join(target, "extra.txt"), "x");
  assert.deepEqual(sync.compareTrees(source, target), ["extra.txt"]);
  fs.rmSync(source, { recursive: true, force: true });
  assert.deepEqual(sync.compareTrees(source, target).sort(), ["extra.txt", "lib/a.mjs"]);
});

test("syncPair repairs a changed file, an extra file and a removed source", (t) => {
  const base = tempDir(t, "skill-sync-");
  const source = path.join(base, "src");
  const target = path.join(base, "dst");
  write(path.join(source, "a.mjs"), "a");
  write(path.join(target, "a.mjs"), "old");
  write(path.join(target, "extra.txt"), "x");
  sync.syncPair(source, target);
  assert.deepEqual(sync.compareTrees(source, target), []);
  fs.rmSync(source, { recursive: true, force: true });
  sync.syncPair(source, target);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(sync.compareTrees(source, target), []);
});

test("the runtime copy runs the companion from an unrelated folder", { skip: process.platform === "win32" ? "fake agy needs a POSIX shebang" : false }, (t) => {
  const base = tempDir(t, "skill-runtime-");
  const fake = path.join(base, "fake-agy");
  fs.writeFileSync(fake, '#!/usr/bin/env node\nif (process.argv.includes("--version")) { process.stdout.write("1.5.12\\n"); process.exit(0); }\nprocess.exit(1);\n', { mode: 0o755 });
  const env = { ...process.env, ANTIGRAVITY_BIN: fake, PLUGIN_DATA: path.join(base, "data") };
  delete env.CLAUDE_PLUGIN_DATA;
  const result = spawnSync(
    process.execPath,
    [path.join(root, "plugins/antigravity/skills/antigravity-cli-runtime/scripts/antigravity-companion.mjs"), "setup", "--json"],
    { cwd: base, env, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, "1.5.12");
});
