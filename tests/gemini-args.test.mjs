import assert from "node:assert/strict";
import test from "node:test";

import {
  WIN32_ARGV_PROMPT_LIMIT,
  buildRunArgs,
  buildReviewArgs,
  shouldPassPromptViaStdin
} from "../plugins/gemini/scripts/lib/gemini.mjs";

test("gemini review uses plan", () => {
  const args = buildReviewArgs("/repo", { backend: "gemini", prompt: "review" });
  assert.ok(args.includes("--skip-trust"));
  assert.ok(args.includes("--approval-mode=plan"));
  assert.ok(args.includes("--output-format=stream-json"));
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("gemini write uses yolo", () => {
  const args = buildRunArgs("/repo", { backend: "gemini", write: true, prompt: "fix it" });
  assert.ok(args.includes("--approval-mode=yolo"));
});

test("buildReviewArgs ignores approvalMode yolo override", () => {
  const args = buildReviewArgs("/repo", {
    backend: "gemini",
    prompt: "review",
    approvalMode: "yolo"
  });
  assert.ok(args.includes("--approval-mode=plan"));
  assert.equal(args.includes("--approval-mode=yolo"), false);
});

test("agy review omits skip-permissions and adds print-timeout", () => {
  const args = buildReviewArgs("/repo", { backend: "agy", prompt: "review" });
  assert.ok(args.includes("--print-timeout"));
  assert.ok(args.includes("15m"));
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(args.includes("--skip-trust"), false);
});

test("agy write adds dangerously-skip-permissions", () => {
  const args = buildRunArgs("/repo", { backend: "agy", write: true, prompt: "fix it" });
  assert.ok(args.includes("--dangerously-skip-permissions"));
});

test("agy resume uses --conversation", () => {
  const args = buildRunArgs("/repo", {
    backend: "agy",
    resumeSessionId: "c3b66b04",
    prompt: "go"
  });
  const i = args.indexOf("--conversation");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "c3b66b04");
});

test("gemini resume uses -r", () => {
  const args = buildRunArgs("/repo", { backend: "gemini", resumeLatest: true, prompt: "go" });
  const i = args.indexOf("-r");
  assert.equal(args[i + 1], "latest");
});

test("win32 long prompt is omitted from argv (delivered via stdin)", () => {
  const prompt = "X".repeat(40_000);
  assert.ok(prompt.length > WIN32_ARGV_PROMPT_LIMIT);
  assert.equal(shouldPassPromptViaStdin(prompt, "win32"), true);
  assert.equal(shouldPassPromptViaStdin(prompt, "linux"), false);

  const args = buildRunArgs("/repo", {
    backend: "gemini",
    prompt,
    platform: "win32"
  });
  assert.equal(args.includes("-p"), false);
  assert.equal(
    args.some((entry) => typeof entry === "string" && entry.length > WIN32_ARGV_PROMPT_LIMIT),
    false
  );

  const shortArgs = buildRunArgs("/repo", {
    backend: "gemini",
    prompt: "short",
    platform: "win32"
  });
  const pIndex = shortArgs.indexOf("-p");
  assert.ok(pIndex >= 0);
  assert.equal(shortArgs[pIndex + 1], "short");
});
