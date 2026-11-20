import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  READ_ONLY_SETTINGS,
  buildPrintInvocation,
  buildReviewArgs,
  buildRunArgs,
  shouldPassPromptViaStdin
} from "../plugins/antigravity/scripts/lib/agy.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(root, "plugins/antigravity/scripts/antigravity-companion.mjs");
const POSIX_ONLY = process.platform === "win32" ? "fake agy needs a POSIX shebang" : false;
// Literal on purpose: the test must not trust the exported constant.
const S = '{"permissions":{"deny":["write_file(*)","command(*)"]}}';

// Fake agy (plan P5), copied per test file.
const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
let stdin = "";
if (!process.stdin.isTTY) { const chunks = []; const buf = Buffer.alloc(65536); for (;;) { let n; try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code === "EAGAIN") continue; break; } if (!n) break; chunks.push(Buffer.from(buf.subarray(0, n))); } stdin = Buffer.concat(chunks).toString("utf8"); }
if (process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ argv, stdin, pid: process.pid }) + "\\n");
if (argv.includes("--version")) { process.stdout.write("1.5.12\\n"); process.exit(0); }
process.stdout.write(process.env.FAKE_AGY_ENVELOPE ?? '{"conversation_id":"C1","status":"SUCCESS","response":"ok","num_turns":1}');
process.exit(Number(process.env.FAKE_AGY_EXIT ?? 0));
`;

function makeSandbox(t, changedFiles = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-args-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake-agy");
  fs.writeFileSync(fake, FAKE_AGY, { mode: 0o755 });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  for (let i = 0; i < changedFiles; i += 1) fs.writeFileSync(path.join(repo, `f${i}.txt`), "a\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  for (let i = 0; i < changedFiles; i += 1) fs.writeFileSync(path.join(repo, `f${i}.txt`), "b\n");
  return { dir, fake, repo, data: path.join(dir, "data"), log: path.join(dir, "agy.log") };
}

function run(sandbox, args) {
  const env = { ...process.env, PLUGIN_DATA: sandbox.data, ANTIGRAVITY_BIN: sandbox.fake, FAKE_AGY_LOG: sandbox.log };
  delete env.CLAUDE_PLUGIN_DATA;
  return spawnSync(process.execPath, [COMPANION, ...args], { cwd: sandbox.repo, env, encoding: "utf8" });
}

function modelCalls(sandbox) {
  if (!fs.existsSync(sandbox.log)) return [];
  return fs
    .readFileSync(sandbox.log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => !entry.argv.includes("--version"));
}

function allCalls(sandbox) {
  if (!fs.existsSync(sandbox.log)) return [];
  return fs.readFileSync(sandbox.log, "utf8").trim().split("\n").filter(Boolean);
}

function jobFiles(sandbox) {
  const stateRoot = path.join(sandbox.data, "state");
  if (!fs.existsSync(stateRoot)) return [];
  return fs.readdirSync(stateRoot).flatMap((w) => {
    const jobs = path.join(stateRoot, w, "jobs");
    return fs.existsSync(jobs) ? fs.readdirSync(jobs) : [];
  });
}

test("the read-only settings constant matches the literal deny rules", () => {
  assert.equal(READ_ONLY_SETTINGS, S);
  assert.deepEqual(JSON.parse(READ_ONLY_SETTINGS), { permissions: { deny: ["write_file(*)", "command(*)"] } });
});

test("review argv denies writes and shell and passes the schema", () => {
  assert.deepEqual(buildReviewArgs({ prompt: "P", schemaPath: "/s.json", platform: "linux" }), [
    "--settings", S, "--output-format", "json", "--json-schema", "/s.json"
  ]);
});

test("read-only task argv denies writes and shell", () => {
  assert.deepEqual(buildRunArgs({ prompt: "P", write: false, platform: "linux" }), ["--settings", S, "--output-format", "json"]);
});

test("write task argv auto-approves and carries no deny settings", () => {
  assert.deepEqual(buildRunArgs({ prompt: "P", write: true, platform: "linux" }), [
    "--dangerously-skip-permissions", "--output-format", "json"
  ]);
});

test("a review never reaches the bypass, even with write requested", () => {
  const args = buildReviewArgs({ prompt: "P", write: true, platform: "linux" });
  assert.ok(args.includes(S));
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  for (const argv of [args, buildRunArgs({ prompt: "P", platform: "linux" })]) assert.equal(argv.includes("--mode"), false);
});

test("model, effort and resume pass through in order", () => {
  assert.deepEqual(buildRunArgs({ prompt: "P", model: "m1", effort: "high", resumeSessionId: "C1", platform: "linux" }), [
    "--settings", S, "--model", "m1", "--effort", "high", "--conversation", "C1", "--output-format", "json"
  ]);
});

test("an unknown effort is rejected with the five levels", () => {
  assert.throws(() => buildRunArgs({ prompt: "P", effort: "extreme" }), /low, medium, high, xhigh, max/);
  assert.throws(() => buildRunArgs({ prompt: "P", effort: "" }), /low, medium, high, xhigh, max/);
});

test("every prompt goes on stdin, never in argv where other local users can read it", () => {
  for (const platform of ["win32", "linux"]) {
    for (const prompt of ["short secret", "x".repeat(20000)]) {
      assert.equal(shouldPassPromptViaStdin(prompt, platform), true);
      const invocation = buildPrintInvocation({ prompt, platform });
      assert.equal(invocation.args.includes("-p"), false);
      assert.equal(invocation.args.includes(prompt), false);
      assert.equal(invocation.stdin, prompt);
    }
  }
  const large = buildPrintInvocation({ prompt: "y".repeat(20001), platform: "win32" });
  assert.equal(large.args.includes("-p"), false);
  assert.equal(large.args.includes("y".repeat(20001)), false);
  assert.equal(large.stdin, "y".repeat(20001));
});

test("the companion spawns agy with the write and read-only vectors", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "--write", "--bypass-permissions", "P"]).status, 0);
  assert.equal(run(sandbox, ["task", "--wait", "P"]).status, 0);
  const [write, readOnly] = modelCalls(sandbox);
  assert.deepEqual(write.argv, ["--dangerously-skip-permissions", "--output-format", "json"]);
  assert.deepEqual(readOnly.argv, ["--settings", S, "--output-format", "json"]);
});

test("a review with effort uses the fixed read-only prefix and the schema prompt", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["review", "--wait", "--effort", "high"]);
  assert.equal(result.status, 0, result.stderr);
  const [call] = modelCalls(sandbox);
  assert.deepEqual(call.argv.slice(0, 6), ["--settings", S, "--effort", "high", "--output-format", "json"]);
  assert.equal(call.argv[6], "--json-schema");
  assert.match(call.argv[7], /schemas[\\/]review-output\.schema\.json$/);
  assert.equal(call.argv.length, 8);
  assert.match(call.stdin, /Return only JSON matching this schema/);
});

test("an invalid effort starts nothing and writes no job", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  for (const args of [
    ["review", "--wait", "--effort", "extreme"],
    ["task", "--wait", "--effort", "extreme", "P"],
    ["task", "--background", "--effort", "extreme", "P"],
    ["task", "--wait", "--effort=", "P"]
  ]) {
    const result = run(sandbox, args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.deepEqual(allCalls(sandbox), [], args.join(" "));
    assert.deepEqual(jobFiles(sandbox), [], args.join(" "));
  }
});

test("over the inline limit the review prompt says shell is denied", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t, 3);
  assert.equal(run(sandbox, ["review", "--wait"]).status, 0);
  const [call] = modelCalls(sandbox);
  const prompt = call.stdin;
  assert.match(prompt, /Shell commands are denied in this review/);
  assert.doesNotMatch(prompt, /read-only git commands/);
});

test("a review never follows an untracked symlink out of the repository", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const secret = path.join(sandbox.dir, "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET-TOKEN\n");
  fs.symlinkSync(secret, path.join(sandbox.repo, "leak.txt"));
  assert.equal(run(sandbox, ["review", "--wait"]).status, 0);
  const [call] = modelCalls(sandbox);
  const prompt = call.stdin;
  assert.doesNotMatch(prompt, /TOP-SECRET-TOKEN/);
  assert.match(prompt, /symlink targets are never followed/);
});

test("a prompt too large for one argument goes on stdin on every platform", () => {
  const big = "z".repeat(120_001);
  assert.equal(shouldPassPromptViaStdin(big, "linux"), true);
  const invocation = buildPrintInvocation({ prompt: big, platform: "linux" });
  assert.equal(invocation.args.includes("-p"), false);
  assert.equal(invocation.stdin, big);
  assert.equal(shouldPassPromptViaStdin("z".repeat(1000), "linux"), true);
});

test("a self-collected review never lists a symlink for the model to read", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t, 2);
  const secret = path.join(sandbox.dir, "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET-TOKEN\n");
  fs.writeFileSync(path.join(sandbox.dir, "harmless.txt"), "fine\n");
  fs.symlinkSync(path.join(sandbox.dir, "harmless.txt"), path.join(sandbox.repo, "link.txt"));
  spawnSync("git", ["add", "link.txt"], { cwd: sandbox.repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "link"], { cwd: sandbox.repo });
  fs.rmSync(path.join(sandbox.repo, "link.txt"));
  fs.symlinkSync(secret, path.join(sandbox.repo, "link.txt"));
  assert.equal(run(sandbox, ["review", "--wait"]).status, 0);
  const prompt = modelCalls(sandbox)[0].stdin;
  assert.match(prompt, /Never open a symlink/);
  assert.doesNotMatch(prompt, /^link\.txt$/m);
  assert.match(prompt, /1 symlink\(s\) not listed/);
});
