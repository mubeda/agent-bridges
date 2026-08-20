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

test("README uses catalog id agent-bridges and keeps the current GitHub URL", () => {
  assert.match(readme, /# Agent Bridges/);
  assert.match(readme, /opencode@agent-bridges/);
  assert.match(readme, /gemini@agent-bridges/);
  assert.match(readme, /github\.com\/mubeda\/mau-ai-marketplace/);
  assert.doesNotMatch(readme, /@mau-ai-marketplace/);
});
