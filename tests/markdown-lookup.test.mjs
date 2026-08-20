import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("review command documents PLUGIN_ROOT lookup", () => {
  const body = fs.readFileSync(path.join(root, "plugins/opencode/commands/review.md"), "utf8");
  assert.match(body, /PLUGIN_ROOT/);
  assert.doesNotMatch(body, /MAU_PLUGIN_ROOT/);
  assert.match(body, /opencode-companion\.mjs/);
});

test("plugin markdown has no MAU_PLUGIN_ROOT", () => {
  const files = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (/\.(md|mjs|json)$/.test(ent.name)) {
        files.push(full);
      }
    }
  }
  walk(path.join(root, "plugins"));
  for (const file of files) {
    const body = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(body, /MAU_PLUGIN_ROOT|MAU_PLUGIN_DATA/);
  }
});

for (const companion of ["opencode", "gemini"]) {
  for (const command of ["review", "adversarial-review"]) {
    test(`${companion} ${command} command delegates background execution to the companion`, () => {
      const body = fs.readFileSync(
        path.join(root, `plugins/${companion}/commands/${command}.md`),
        "utf8"
      );
      assert.doesNotMatch(body, /run_in_background/);
    });
  }
}

test("codex review skill exists", () => {
  const body = fs.readFileSync(
    path.join(root, "plugins/opencode/skills/opencode-review/SKILL.md"),
    "utf8"
  );
  assert.match(body, /^name:\s*opencode-review/m);
  assert.match(body, /review/);
});

test("transfer command exists for both plugins", () => {
  for (const name of ["opencode", "gemini"]) {
    const body = fs.readFileSync(path.join(root, `plugins/${name}/commands/transfer.md`), "utf8");
    assert.match(body, /PLUGIN_ROOT/);
    assert.match(body, /transfer/);
  }
});

test("codex transfer skills exist", () => {
  assert.match(
    fs.readFileSync(path.join(root, "plugins/opencode/skills/opencode-transfer/SKILL.md"), "utf8"),
    /^name:\s*opencode-transfer/m
  );
  assert.match(
    fs.readFileSync(path.join(root, "plugins/gemini/skills/gemini-transfer/SKILL.md"), "utf8"),
    /^name:\s*gemini-transfer/m
  );
});

test("rescue defaults to --write", () => {
  const body = fs.readFileSync(path.join(root, "plugins/opencode/commands/rescue.md"), "utf8");
  assert.match(body, /--write/);
});

test("claude rescue skill defaults to --write", () => {
  const body = fs.readFileSync(
    path.join(root, "plugins/claude/skills/claude-rescue/SKILL.md"),
    "utf8"
  );
  assert.match(body, /--write/);
});

test("claude transfer skill exists", () => {
  assert.match(
    fs.readFileSync(path.join(root, "plugins/claude/skills/claude-transfer/SKILL.md"), "utf8"),
    /^name:\s*claude-transfer/m
  );
});

test("claude skills document PLUGIN_ROOT lookup", () => {
  const body = fs.readFileSync(
    path.join(root, "plugins/claude/skills/claude-review/SKILL.md"),
    "utf8"
  );
  assert.match(body, /PLUGIN_ROOT/);
  assert.match(body, /claude-companion\.mjs/);
  assert.doesNotMatch(body, /MAU_PLUGIN_ROOT/);
});
