import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WIN32_ARGV_PROMPT_LIMIT,
  buildRunArgs,
  buildReviewArgs,
  resolveClaudeBin,
  shouldPassPromptViaStdin
} from "../plugins/claude/scripts/lib/claude.mjs";

test("resolveClaudeBin prefers CLAUDE_BIN", () => {
  assert.equal(resolveClaudeBin({ CLAUDE_BIN: "C:\\tools\\claude.exe" }), "C:\\tools\\claude.exe");
  assert.equal(resolveClaudeBin({}), "claude");
});

test("review wait uses plan, json, and json-schema", () => {
  const args = buildReviewArgs({
    prompt: "review",
    invoke: "print",
    schemaPath: "/plugin/schemas/review-output.schema.json"
  });
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("--permission-mode"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(args.includes("--output-format"));
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.ok(args.includes("--json-schema"));
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(args.includes("--bg"), false);
});

test("review ignores write/approval overrides", () => {
  const args = buildReviewArgs({ prompt: "review", invoke: "print", write: true });
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
});

test("rescue wait write uses dangerously-skip-permissions", () => {
  const args = buildRunArgs({ prompt: "fix it", invoke: "print", write: true });
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("-p"));
});

test("rescue wait without write uses plan", () => {
  const args = buildRunArgs({ prompt: "diagnose", invoke: "print", write: false });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("background argv has --bg and no -p", () => {
  const args = buildRunArgs({
    prompt: "fix it",
    invoke: "bg",
    write: true,
    name: "job-1"
  });
  assert.ok(args.includes("--bg"));
  assert.ok(args.includes("--name"));
  assert.equal(args[args.indexOf("--name") + 1], "job-1");
  assert.equal(args.includes("-p"), false);
  assert.equal(args.includes("--print"), false);
  assert.equal(args.includes("--json-schema"), false);
  assert.equal(args.at(-1), "fix it");
  assert.ok(args.includes("--dangerously-skip-permissions"));
});

test("resume print uses -r or -c", () => {
  const idArgs = buildRunArgs({ prompt: "go", invoke: "print", resumeSessionId: "abc" });
  assert.equal(idArgs[idArgs.indexOf("-r") + 1], "abc");
  const latest = buildRunArgs({ prompt: "go", invoke: "print", resumeLatest: true });
  assert.ok(latest.includes("-c") || latest.includes("--continue"));
});

test("model and effort pass through", () => {
  const args = buildRunArgs({
    prompt: "go",
    invoke: "print",
    model: "sonnet",
    effort: "high"
  });
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
});

test("win32 long print keeps -p while omitting the prompt from argv", () => {
  const prompt = "X".repeat(40_000);
  assert.equal(shouldPassPromptViaStdin(prompt, "win32"), true);
  const args = buildRunArgs({ prompt, invoke: "print", platform: "win32" });
  assert.equal(args.includes("-p"), true);
  assert.equal(args.some((e) => typeof e === "string" && e.length > WIN32_ARGV_PROMPT_LIMIT), false);
});

test("win32 long background prompt is staged outside argv", (t) => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bg-prompt-"));
  t.after(() => fs.rmSync(jobDir, { recursive: true, force: true }));
  const prompt = "X".repeat(40_000);
  const promptFile = path.join(jobDir, "task-1.prompt.md");

  const args = buildRunArgs({ prompt, promptFile, invoke: "bg", platform: "win32" });

  assert.equal(fs.readFileSync(promptFile, "utf8"), prompt);
  assert.equal(args.includes("-p"), false);
  assert.equal(args.includes("--bg"), true);
  assert.equal(args.some((value) => typeof value === "string" && value.length > WIN32_ARGV_PROMPT_LIMIT), false);
  assert.match(args.at(-1), /read and follow/i);
  assert.match(args.at(-1), /task-1\.prompt\.md/);
});
