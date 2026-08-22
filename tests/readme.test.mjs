import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readme = fs.readFileSync(
  path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "README.md"),
  "utf8"
);

test("README documents all four hosts", () => {
  assert.match(readme, /plugin marketplace add/);
  assert.match(readme, /codex plugin marketplace add/);
  assert.match(readme, /\.cursor\/plugins\/local/);
  assert.match(readme, /install-opencode\.mjs/);
  assert.match(readme, /Manual checklist/);
  assert.match(readme, /Apache-2\.0/);
});

test("README uses catalog id and GitHub repo agent-bridges", () => {
  assert.match(readme, /# Agent Bridges/);
  assert.match(readme, /opencode@agent-bridges/);
  assert.match(readme, /gemini@agent-bridges/);
  assert.match(readme, /claude@agent-bridges/);
  assert.match(readme, /github\.com\/mubeda\/agent-bridges/);
  assert.match(readme, /marketplace add mubeda\/agent-bridges/);
  assert.doesNotMatch(readme, /mau-ai-marketplace/);
});

test("README documents the Claude companion for three hosts", () => {
  assert.match(readme, /claude@agent-bridges|plugin add claude@agent-bridges/);
  assert.match(readme, /claude --bg/);
  assert.match(readme, /\.claude\/worktrees/);
  assert.match(readme, /dangerously-skip-permissions/);
  assert.match(readme, /~\/\.claude-companion/);
  assert.match(readme, /Claude Code does not install this plugin|not listed in the Claude marketplace/i);
  assert.match(readme, /claude-transfer/);
  assert.match(readme, /Claude companion has no `commands\/` folder/i);
  assert.match(readme, /prompt handoff into Claude/i);
});

test("README documents upgrade surface", () => {
  assert.match(readme, /agy/);
  assert.match(readme, /GEMINI_BACKEND/);
  assert.match(readme, /transfer/);
  assert.match(readme, /review-gate|review gate/);
  assert.doesNotMatch(readme, /MAU_PLUGIN/);
  assert.doesNotMatch(readme, /~\/\.mau-ai/);
});

test("README documents the Cursor companion", () => {
  assert.match(readme, /cursor@agent-bridges/);
  assert.match(readme, /\/plugin install cursor@agent-bridges/);
  assert.match(readme, /codex plugin add cursor@agent-bridges/);
  assert.match(readme, /CURSOR_BIN/);
  assert.match(readme, /CURSOR_API_KEY/);
  assert.match(readme, /agent login/);
  assert.match(readme, /~\/\.cursor-companion/);
});
