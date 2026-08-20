import assert from "node:assert/strict";
import test from "node:test";

import { buildRunArgs } from "../plugins/opencode/scripts/lib/opencode.mjs";

test("review run has no auto and no dangerously-skip-permissions", () => {
  const args = buildRunArgs("/repo", { write: false });
  assert.ok(args.includes("run"));
  assert.ok(args.includes("--format"));
  assert.ok(args.includes("json"));
  assert.ok(args.includes("--dir"));
  assert.equal(args.includes("--auto"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("write run adds --auto", () => {
  const args = buildRunArgs("/repo", { write: true });
  assert.ok(args.includes("--auto"));
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("resume id uses -s", () => {
  const args = buildRunArgs("/repo", { resumeThreadId: "ses_1" });
  const i = args.indexOf("-s");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "ses_1");
});

test("resume latest uses --continue", () => {
  const args = buildRunArgs("/repo", { resumeLatest: true });
  assert.ok(args.includes("--continue"));
});
