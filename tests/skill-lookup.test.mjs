import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installPlugins } from "../scripts/lib/opencode-install.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PLUGINS = ["opencode", "gemini", "claude", "cursor", "antigravity"];
const POSIX_ONLY = process.platform === "win32" ? "fake agy needs a POSIX shebang" : false;

function companionSkills() {
  return PLUGINS.flatMap((plugin) =>
    fs
      .readdirSync(path.join(root, "plugins", plugin, "skills"))
      .filter((name) => !name.endsWith("-prompting"))
      .map((name) => ({ plugin, name, file: path.join(root, "plugins", plugin, "skills", name, "SKILL.md") }))
  );
}

test("all 50 companion skills look up the companion in the documented order", () => {
  const skills = companionSkills();
  assert.equal(skills.length, 50);
  for (const { plugin, name, file } of skills) {
    const body = fs.readFileSync(file, "utf8");
    const start = body.indexOf("Resolve `<plugin-root>`");
    assert.ok(start >= 0, name);
    const lines = body.slice(start).split("\n");
    const stopIndex = lines.findIndex((line) => line.startsWith("If none exist,"));
    assert.ok(stopIndex > 0, name);
    const entries = lines.slice(0, stopIndex).filter((line) => /^\d+\. /.test(line));
    assert.equal(entries.length, 6, name);
    assert.equal(entries[0], "1. `$CLAUDE_PLUGIN_ROOT`", name);
    assert.equal(entries[1], "2. `$PLUGIN_ROOT`", name);
    assert.match(entries[2], /the folder that holds this SKILL\.md/, name);
    assert.ok(entries[2].includes(`<this skill's folder>/../${plugin}-cli-runtime`), name);
    assert.ok(entries[3].includes(`~/.cursor/plugins/local/${plugin}`), name);
    assert.ok(entries[4].includes(`~/.config/opencode/plugins/${plugin}`), name);
    assert.match(entries[5], /plugin cache/, name);
    assert.ok(lines[stopIndex].includes(`${plugin}-cli-runtime`), name);
    assert.equal(lines.filter((line) => line.startsWith("If none exist,")).length, 1, name);
  }
});

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeAgy(dir) {
  const fake = path.join(dir, "fake-agy");
  fs.writeFileSync(fake, '#!/usr/bin/env node\nif (process.argv.includes("--version")) { process.stdout.write("1.5.12\\n"); process.exit(0); }\nprocess.exit(1);\n', { mode: 0o755 });
  return fake;
}

// Entry 3 resolved the way a host does: from the folder that holds the loaded SKILL.md, never the cwd.
function siblingCompanion(skillFolder) {
  return path.resolve(skillFolder, "..", "antigravity-cli-runtime", "scripts", "antigravity-companion.mjs");
}

function runSetup(base, companion) {
  const env = { ...process.env, ANTIGRAVITY_BIN: fakeAgy(base), PLUGIN_DATA: path.join(base, "data") };
  delete env.CLAUDE_PLUGIN_DATA;
  const unrelated = fs.mkdtempSync(path.join(base, "cwd-"));
  return spawnSync(process.execPath, [companion, "setup", "--json"], { cwd: unrelated, env, encoding: "utf8" });
}

const SOURCE_SKILLS = path.join(root, "plugins/antigravity/skills");

test("a copy install finds the sibling runtime from the setup skill folder", (t) => {
  const base = tempDir(t, "skill-copy-");
  const skills = path.join(base, "skills");
  for (const name of ["antigravity-setup", "antigravity-cli-runtime"]) {
    fs.cpSync(path.join(SOURCE_SKILLS, name), path.join(skills, name), { recursive: true });
  }
  const companion = siblingCompanion(path.join(skills, "antigravity-setup"));
  assert.equal(fs.existsSync(companion), true);
  if (POSIX_ONLY) return;
  const result = runSetup(base, companion);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, "1.5.12");
});

test("a symlink install finds the sibling runtime from the linked setup skill", { skip: POSIX_ONLY }, (t) => {
  const base = tempDir(t, "skill-link-");
  const canonical = path.join(base, "canonical");
  const agentSkills = path.join(base, "agent", "skills");
  fs.mkdirSync(agentSkills, { recursive: true });
  for (const name of ["antigravity-setup", "antigravity-cli-runtime"]) {
    fs.cpSync(path.join(SOURCE_SKILLS, name), path.join(canonical, name), { recursive: true });
    fs.symlinkSync(path.join(canonical, name), path.join(agentSkills, name), "dir");
  }
  const companion = siblingCompanion(path.join(agentSkills, "antigravity-setup"));
  assert.equal(fs.existsSync(companion), true);
  const result = runSetup(base, companion);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, "1.5.12");
});

test("without the runtime skill the sibling is missing and the stop line names it", (t) => {
  const base = tempDir(t, "skill-missing-");
  const skills = path.join(base, "skills");
  fs.cpSync(path.join(SOURCE_SKILLS, "antigravity-setup"), path.join(skills, "antigravity-setup"), { recursive: true });
  assert.equal(fs.existsSync(siblingCompanion(path.join(skills, "antigravity-setup"))), false);
  const body = fs.readFileSync(path.join(skills, "antigravity-setup", "SKILL.md"), "utf8");
  const stop = body.split("\n").find((line) => line.startsWith("If none exist,"));
  assert.match(stop, /antigravity-cli-runtime/);
});

test("the OpenCode installer still replaces the whole lookup block", (t) => {
  const home = tempDir(t, "skill-opencode-");
  installPlugins({ repoRoot: root, plugin: "cursor", scope: "user", homedir: home });
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith(path.join("cursor-review", "SKILL.md")) && !full.includes(`${path.sep}plugins${path.sep}`)) found.push(full);
    }
  })(home);
  assert.equal(found.length, 1, found.join(", "));
  const body = fs.readFileSync(found[0], "utf8");
  assert.match(body, /Use the installed plugin root/);
  assert.doesNotMatch(body, /\.\.\/cursor-cli-runtime/);
  assert.doesNotMatch(body, /If none exist/);
});
