import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("opencode plugin tree is present", () => {
  assert.equal(
    fs.existsSync(path.join(root, "plugins/opencode/scripts/opencode-companion.mjs")),
    true
  );
  assert.equal(fs.existsSync(path.join(root, "plugins/opencode/commands/review.md")), true);
});

test("gemini plugin tree is present", () => {
  assert.equal(
    fs.existsSync(path.join(root, "plugins/gemini/scripts/gemini-companion.mjs")),
    true
  );
  assert.equal(fs.existsSync(path.join(root, "plugins/gemini/commands/review.md")), true);
});

test("cursor plugin tree is present", () => {
  assert.equal(
    fs.existsSync(path.join(root, "plugins/cursor/scripts/cursor-companion.mjs")),
    true
  );
  assert.equal(fs.existsSync(path.join(root, "plugins/cursor/commands/review.md")), true);
  assert.equal(fs.existsSync(path.join(root, "plugins/cursor/skills/cursor-review/SKILL.md")), true);
});

test("antigravity plugin tree is present with every command, skill and agent", () => {
  const base = path.join(root, "plugins/antigravity");
  assert.equal(fs.existsSync(path.join(base, "scripts/antigravity-companion.mjs")), true);
  assert.equal(fs.existsSync(path.join(base, "agents/antigravity-rescue.md")), true);
  const commands = fs.readdirSync(path.join(base, "commands")).map((f) => f.replace(/\.md$/, "")).sort();
  assert.deepEqual(commands, ["adversarial-review", "cancel", "delegate", "rescue", "result", "review", "setup", "status", "transfer"]);
  const skills = fs.readdirSync(path.join(base, "skills")).sort();
  assert.deepEqual(
    skills,
    ["adversarial-review", "cancel", "cli-runtime", "delegate", "prompting", "rescue", "result", "review", "setup", "status", "transfer"].map(
      (s) => `antigravity-${s}`
    )
  );
  for (const skill of skills) {
    const body = fs.readFileSync(path.join(base, "skills", skill, "SKILL.md"), "utf8");
    assert.match(body, new RegExp(`^name:\\s*${skill}\\s*$`, "m"), skill);
  }
});

test("claude plugin tree is present without Claude-host commands or hooks", () => {
  const rootClaude = path.join(root, "plugins/claude");
  assert.equal(fs.existsSync(path.join(rootClaude, "scripts/claude-companion.mjs")), true);
  assert.equal(fs.existsSync(path.join(rootClaude, "commands")), false);
  assert.equal(fs.existsSync(path.join(rootClaude, "hooks")), false);
  assert.equal(fs.existsSync(path.join(rootClaude, "skills/claude-review/SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(rootClaude, "agents/claude-rescue.md")), true);
});
