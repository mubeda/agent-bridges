import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRunArgs,
  extractConfiguredModel,
  parseOpencodeMajorVersion
} from "../plugins/opencode/scripts/lib/opencode.mjs";

test("review run has no auto and no dangerously-skip-permissions", () => {
  const args = buildRunArgs("/repo", { write: false });
  assert.ok(args.includes("run"));
  assert.ok(args.includes("--format"));
  assert.ok(args.includes("json"));
  assert.equal(args.includes("--dir"), false);
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

test("V2 folds effort into the model and never passes --variant", () => {
  const args = buildRunArgs("/repo", { model: "openai/gpt-5", effort: "high", majorVersion: 2 });
  assert.equal(args[args.indexOf("-m") + 1], "openai/gpt-5#high");
  assert.equal(args.includes("--variant"), false);
});

test("V1 keeps --variant", () => {
  const args = buildRunArgs("/repo", { model: "openai/gpt-5", effort: "high", majorVersion: 1 });
  assert.equal(args[args.indexOf("-m") + 1], "openai/gpt-5");
  assert.equal(args[args.indexOf("--variant") + 1], "high");
});

test("parses OpenCode major version from V1 and V2 output", () => {
  assert.equal(parseOpencodeMajorVersion("opencode v2.2.6"), 2);
  assert.equal(parseOpencodeMajorVersion("1.19.5"), 1);
  assert.equal(parseOpencodeMajorVersion("ok"), null);
});

test("reads the default model from V2 agents config", () => {
  assert.deepEqual(extractConfiguredModel({ agents: { build: { model: "a/b" } } }), {
    model: "a/b",
    source: "agent",
    agent: "build"
  });
});

test("reads the V2 {providerID, model} config shape", () => {
  assert.deepEqual(extractConfiguredModel({ model: { providerID: "ollama", model: "kimi" } }), {
    model: "ollama/kimi",
    source: "config"
  });
});
