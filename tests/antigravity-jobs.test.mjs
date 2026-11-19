import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatDeniedActions, parsePrintResult } from "../plugins/antigravity/scripts/lib/agy.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(root, "plugins/antigravity/scripts/antigravity-companion.mjs");
const POSIX_ONLY = process.platform === "win32" ? "fake agy needs a POSIX shebang" : false;

// Fake agy (plan P5), copied per test file. FAKE_AGY_ENVELOPES (JSON array) answers successive model calls in order.
const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
let stdin = "";
try { if (!process.stdin.isTTY) stdin = fs.readFileSync(0, "utf8"); } catch {}
const log = process.env.FAKE_AGY_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv, stdin, pid: process.pid }) + "\\n");
if (argv.includes("--version")) { process.stdout.write("1.5.12\\n"); process.exit(0); }
let envelope = process.env.FAKE_AGY_ENVELOPE ?? '{"conversation_id":"C1","status":"SUCCESS","response":"ok","num_turns":1}';
if (process.env.FAKE_AGY_ENVELOPES && log) {
  const calls = fs.readFileSync(log, "utf8").trim().split("\\n").filter((l) => !JSON.parse(l).argv.includes("--version")).length;
  const list = JSON.parse(process.env.FAKE_AGY_ENVELOPES);
  envelope = list[Math.min(calls, list.length) - 1];
}
const finish = () => {
  process.stdout.write(envelope);
  if (process.env.FAKE_AGY_STDERR) process.stderr.write(process.env.FAKE_AGY_STDERR);
  process.exit(Number(process.env.FAKE_AGY_EXIT ?? 0));
};
const sleep = Number(process.env.FAKE_AGY_SLEEP_MS ?? 0);
if (sleep > 0) {
  const code = (process.env.FAKE_AGY_CHILD_IGNORES_TERM ? "process.on(\x27SIGTERM\x27, () => {});" : "") + "setTimeout(() => {}, " + sleep + ")";
  const child = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
  fs.writeFileSync(process.env.FAKE_AGY_PIDFILE, JSON.stringify({ pid: process.pid, childPid: child.pid }));
  setTimeout(finish, sleep);
} else {
  finish();
}
`;

function makeSandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-jobs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake-agy");
  fs.writeFileSync(fake, FAKE_AGY, { mode: 0o755 });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "b\n");
  return { dir, fake, repo, data: path.join(dir, "data"), log: path.join(dir, "agy.log"), pidfile: path.join(dir, "pids.json") };
}

function run(sandbox, args, extraEnv = {}) {
  const env = { ...process.env, PLUGIN_DATA: sandbox.data, ANTIGRAVITY_BIN: sandbox.fake, FAKE_AGY_LOG: sandbox.log, FAKE_AGY_PIDFILE: sandbox.pidfile, ...extraEnv };
  delete env.CLAUDE_PLUGIN_DATA;
  return spawnSync(process.execPath, [COMPANION, ...args], { cwd: sandbox.repo, env, encoding: "utf8" });
}

function modelCalls(sandbox) {
  if (!fs.existsSync(sandbox.log)) return [];
  return fs.readFileSync(sandbox.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !e.argv.includes("--version"));
}

function lastJob(sandbox) {
  const status = JSON.parse(run(sandbox, ["status", "--all", "--json"]).stdout);
  return status.running[0] ?? status.latestFinished;
}

function jobStatus(sandbox, id) {
  return JSON.parse(run(sandbox, ["status", id, "--json"]).stdout).job;
}

const FINDINGS = {
  verdict: "needs-attention",
  summary: "s",
  next_steps: [],
  findings: [{ severity: "high", title: "t", body: "b", file: "a.js", line_start: 3, line_end: 4, confidence: 0.9, recommendation: "r" }]
};

test("parsePrintResult reads the agy envelope and structured output", () => {
  const parsed = parsePrintResult(JSON.stringify({ conversation_id: "C9", status: "SUCCESS", response: "x", structured_output: FINDINGS }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, "C9");
  assert.equal(parsed.structured.findings[0].severity, "high");
  assert.equal(parsed.warning, null);
});

test("a changed conversation id gives the warning and keeps the new id", () => {
  const parsed = parsePrintResult('{"conversation_id":"C2","status":"SUCCESS","response":"ok"}', { requestedConversationId: "C1" });
  assert.equal(parsed.warning, "conversation C1 not found; Antigravity started a new one");
  assert.equal(parsed.sessionId, "C2");
  assert.equal(parsed.ok, true);
});

test("failures come from the exit code or the status", () => {
  const auth = parsePrintResult("", { exitCode: 1, stderr: "authentication required\n" });
  assert.equal(auth.ok, false);
  assert.match(auth.error, /authentication required/);
  const error = parsePrintResult('{"status":"ERROR","error":"boom","conversation_id":"C3"}', { exitCode: 0 });
  assert.equal(error.ok, false);
  assert.equal(error.error, "boom");
});

test("plain stdout is a result at exit 0 and a failure otherwise", () => {
  const ok = parsePrintResult("hello\n", { exitCode: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, null);
  assert.equal(ok.resultText, "hello");
  assert.equal(parsePrintResult("hello\n", { exitCode: 1 }).ok, false);
});

test("denied actions are shown, with or without an answer", () => {
  const denied = [{ action: "command", display_name: "Bash" }];
  assert.equal(formatDeniedActions(denied), "command (Bash)");
  const empty = parsePrintResult(JSON.stringify({ status: "SUCCESS", response: "", denied_actions: denied }));
  assert.equal(empty.resultText, "no answer; denied: command (Bash)");
  const partial = parsePrintResult(JSON.stringify({ status: "SUCCESS", response: "partial", denied_actions: denied }));
  assert.match(partial.resultText, /^partial/);
  assert.match(partial.resultText, /Denied: command \(Bash\)$/);
});

test("a structured review shows its findings", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const env = { FAKE_AGY_ENVELOPE: JSON.stringify({ conversation_id: "C1", status: "SUCCESS", response: JSON.stringify(FINDINGS), structured_output: FINDINGS }) };
  const result = run(sandbox, ["review", "--wait"], env);
  assert.equal(result.status, 0, result.stderr);
  for (const text of ["high", "a.js", "3", "r"]) assert.match(result.stdout, new RegExp(text));
});

test("a review without structured output shows the text and a note", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["review", "--wait"], { FAKE_AGY_ENVELOPE: '{"conversation_id":"C1","status":"SUCCESS","response":"plain"}' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plain/);
  assert.match(result.stdout, /No structured result came back from Antigravity\./);
  assert.doesNotMatch(result.stdout, /"findings"/);
});

test("a failed sign-in marks the job failed and shows the error", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_ENVELOPE: "", FAKE_AGY_EXIT: "1", FAKE_AGY_STDERR: "authentication required" });
  assert.notEqual(result.status, 0);
  const job = lastJob(sandbox);
  assert.equal(jobStatus(sandbox, job.id).status, "failed");
  assert.match(run(sandbox, ["result", job.id]).stdout, /authentication required/);
});

test("an ERROR status at exit 0 still fails the command", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_ENVELOPE: '{"status":"ERROR","error":"boom","conversation_id":"C3"}' });
  assert.equal(result.status, 1);
  const job = lastJob(sandbox);
  assert.equal(jobStatus(sandbox, job.id).status, "failed");
  assert.match(run(sandbox, ["result", job.id]).stdout, /boom/);
});

test("denied actions appear in the stored result", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  run(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_ENVELOPE: '{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"Bash"}]}' });
  assert.match(run(sandbox, ["result", lastJob(sandbox).id]).stdout, /no answer; denied: command \(Bash\)/);
});

test("plain stdout from agy is shown as the result", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const ok = run(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_ENVELOPE: "hello" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /hello/);
  const failed = run(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_ENVELOPE: "hello", FAKE_AGY_EXIT: "1" });
  assert.notEqual(failed.status, 0);
});

test("a resume that comes back with a new conversation warns and stores it", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const envelopes = JSON.stringify([
    '{"conversation_id":"C1","status":"SUCCESS","response":"first"}',
    '{"conversation_id":"C2","status":"SUCCESS","response":"second"}',
    '{"conversation_id":"C2","status":"SUCCESS","response":"third"}'
  ]);
  const env = { FAKE_AGY_ENVELOPES: envelopes };
  assert.equal(run(sandbox, ["task", "--wait", "start"], env).status, 0);
  const resumed = run(sandbox, ["task", "--wait", "--resume-last", "more"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /conversation C1 not found; Antigravity started a new one/);
  const job = lastJob(sandbox);
  assert.equal(job.agySessionId, "C2");
  assert.notEqual(jobStatus(sandbox, job.id).status, "failed");
  assert.equal(run(sandbox, ["task", "--wait", "--resume-last", "again"], env).status, 0);
  const calls = modelCalls(sandbox);
  assert.deepEqual(calls[1].argv.slice(calls[1].argv.indexOf("--conversation"), calls[1].argv.indexOf("--conversation") + 2), ["--conversation", "C1"]);
  assert.deepEqual(calls[2].argv.slice(calls[2].argv.indexOf("--conversation"), calls[2].argv.indexOf("--conversation") + 2), ["--conversation", "C2"]);
});

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function startCompanion(sandbox, args, extraEnv = {}) {
  const env = { ...process.env, PLUGIN_DATA: sandbox.data, ANTIGRAVITY_BIN: sandbox.fake, FAKE_AGY_LOG: sandbox.log, FAKE_AGY_PIDFILE: sandbox.pidfile, ...extraEnv };
  delete env.CLAUDE_PLUGIN_DATA;
  return spawn(process.execPath, [COMPANION, ...args], { cwd: sandbox.repo, env, stdio: "ignore" });
}

function readPids(sandbox) {
  return fs.existsSync(sandbox.pidfile) ? JSON.parse(fs.readFileSync(sandbox.pidfile, "utf8")) : null;
}

test("a background task runs, completes and stores its result", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const started = JSON.parse(run(sandbox, ["task", "--background", "--json", "hi"], { FAKE_AGY_SLEEP_MS: "3000" }).stdout);
  const seen = new Set();
  assert.ok(await waitFor(() => {
    const status = jobStatus(sandbox, started.jobId).status;
    seen.add(status);
    return status === "running" && readPids(sandbox);
  }));
  for (const status of seen) assert.ok(["queued", "running"].includes(status), status);
  const done = JSON.parse(run(sandbox, ["status", started.jobId, "--wait", "--json"]).stdout);
  assert.equal(done.job.status, "completed");
  assert.match(run(sandbox, ["result", started.jobId]).stdout, /ok/);
});

test("cancel ends a background agy and its child", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const started = JSON.parse(run(sandbox, ["task", "--background", "--json", "hi"], { FAKE_AGY_SLEEP_MS: "30000" }).stdout);
  assert.ok(await waitFor(() => readPids(sandbox)));
  const { pid, childPid } = readPids(sandbox);
  assert.equal(run(sandbox, ["cancel", started.jobId]).status, 0);
  assert.ok(await waitFor(() => !pidAlive(pid) && !pidAlive(childPid)), "agy or its child survived cancel");
  assert.equal(jobStatus(sandbox, started.jobId).status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(jobStatus(sandbox, started.jobId).status, "cancelled");
});

test("cancel ends a foreground agy and its child", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const companion = startCompanion(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_SLEEP_MS: "30000" });
  t.after(() => companion.kill("SIGKILL"));
  assert.ok(await waitFor(() => readPids(sandbox)));
  const { pid, childPid } = readPids(sandbox);
  const job = lastJob(sandbox);
  assert.equal(run(sandbox, ["cancel", job.id]).status, 0);
  assert.ok(await waitFor(() => !pidAlive(pid) && !pidAlive(childPid)), "agy or its child survived cancel");
  assert.equal(jobStatus(sandbox, job.id).status, "cancelled");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} to the companion stops agy and its child`, { skip: POSIX_ONLY }, async (t) => {
    const sandbox = makeSandbox(t);
    const companion = startCompanion(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_SLEEP_MS: "30000" });
    t.after(() => companion.kill("SIGKILL"));
    assert.ok(await waitFor(() => readPids(sandbox)));
    const { pid, childPid } = readPids(sandbox);
    companion.kill(signal);
    assert.ok(await waitFor(() => !pidAlive(pid) && !pidAlive(childPid)), `agy or its child survived ${signal}`);
  });
}

test("--resume and --resume-last both continue the stored conversation", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "start"]).status, 0);
  assert.equal(run(sandbox, ["task", "--wait", "--resume-last", "more"]).status, 0);
  assert.equal(run(sandbox, ["task", "--wait", "--resume", "again"]).status, 0);
  const calls = modelCalls(sandbox);
  for (const call of calls.slice(1)) {
    const index = call.argv.indexOf("--conversation");
    assert.deepEqual(call.argv.slice(index, index + 2), ["--conversation", "C1"]);
  }
});

test("the delegate skill triggers only on an explicit Antigravity request", () => {
  const body = fs.readFileSync(path.join(root, "plugins/antigravity/skills/antigravity-delegate/SKILL.md"), "utf8");
  const description = body.match(/^description:\s*(.*)$/m)?.[1] ?? "";
  assert.match(description, /\/antigravity:delegate/);
  assert.match(description, /delegate this to antigravity/);
  assert.match(description, /Never auto-trigger/);
  assert.match(body, /--background --fresh --write/);
});

test("an array in structured_output does not hide the review text", () => {
  const parsed = parsePrintResult(JSON.stringify({ status: "SUCCESS", response: "Inspect the retry logic", structured_output: [] }));
  assert.equal(parsed.structured, null);
  assert.equal(parsed.resultText, "Inspect the retry logic");
});

function stateJobFile(sandbox, id) {
  const stateRoot = path.join(sandbox.data, "state");
  for (const workspace of fs.readdirSync(stateRoot)) {
    const file = path.join(stateRoot, workspace, "jobs", `${id}.json`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

test("a worker never runs a job that was cancelled before it started", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "seed"]).status, 0);
  const seed = lastJob(sandbox);
  const file = stateJobFile(sandbox, seed.id);
  const job = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...job, status: "cancelled", phase: "cancelled", request: { cwd: sandbox.repo, prompt: "x", write: false, review: false } }));
  const before = modelCalls(sandbox).length;
  run(sandbox, ["run-worker", "--job-id", seed.id]);
  assert.equal(modelCalls(sandbox).length, before);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).status, "cancelled");
});

test("a worker replays a read-only job without the write bypass", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "seed"]).status, 0);
  const seed = lastJob(sandbox);
  const file = stateJobFile(sandbox, seed.id);
  const job = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...job, status: "queued", write: false, request: { cwd: sandbox.repo, prompt: "x", review: false, write: true } }));
  run(sandbox, ["run-worker", "--job-id", seed.id]);
  const last = modelCalls(sandbox).at(-1);
  assert.equal(last.argv[0], "--settings");
  assert.equal(last.argv.includes("--dangerously-skip-permissions"), false);
});

test("SIGINT leaves the job in a terminal state, not running", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const companion = startCompanion(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_SLEEP_MS: "30000" });
  t.after(() => companion.kill("SIGKILL"));
  assert.ok(await waitFor(() => readPids(sandbox)));
  const job = lastJob(sandbox);
  companion.kill("SIGINT");
  assert.ok(await waitFor(() => !["running", "queued"].includes(jobStatus(sandbox, job.id).status)), "job stayed running");
});

test("cancel escalates when agy's child ignores SIGTERM", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const started = JSON.parse(run(sandbox, ["task", "--background", "--json", "hi"], { FAKE_AGY_SLEEP_MS: "30000", FAKE_AGY_CHILD_IGNORES_TERM: "1" }).stdout);
  assert.ok(await waitFor(() => readPids(sandbox)));
  const { childPid } = readPids(sandbox);
  assert.equal(run(sandbox, ["cancel", started.jobId]).status, 0);
  assert.ok(await waitFor(() => !pidAlive(childPid)), "a SIGTERM-ignoring child survived cancel");
});

test("background write runs keep the write permission through the worker", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const source = path.join(sandbox.dir, "source.jsonl");
  fs.writeFileSync(source, `${JSON.stringify({ type: "user", message: { role: "user", content: "explicit" } })}\n`);
  const task = JSON.parse(run(sandbox, ["task", "--background", "--write", "--json", "P"]).stdout);
  run(sandbox, ["status", task.jobId, "--wait"]);
  const transfer = JSON.parse(run(sandbox, ["transfer", "--write", "--json", "--source", source]).stdout);
  run(sandbox, ["status", transfer.jobId, "--wait"]);
  const readOnly = JSON.parse(run(sandbox, ["task", "--background", "--json", "P"]).stdout);
  run(sandbox, ["status", readOnly.jobId, "--wait"]);
  const calls = modelCalls(sandbox);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].argv[0], "--dangerously-skip-permissions");
  assert.equal(calls[1].argv[0], "--dangerously-skip-permissions");
  assert.equal(calls[2].argv[0], "--settings");
});
