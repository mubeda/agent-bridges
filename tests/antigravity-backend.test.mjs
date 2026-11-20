import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getAgyAvailability, resolveAgyBin } from "../plugins/antigravity/scripts/lib/agy.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(root, "plugins/antigravity/scripts/antigravity-companion.mjs");
const POSIX_ONLY = process.platform === "win32" ? "fake agy needs a POSIX shebang" : false;

// Fake agy (plan P5): logs every call, answers --version with 1.5.12, prints a canned envelope.
const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
let stdin = "";
if (!process.stdin.isTTY) { const chunks = []; const buf = Buffer.alloc(65536); for (;;) { let n; try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code === "EAGAIN") continue; break; } if (!n) break; chunks.push(Buffer.from(buf.subarray(0, n))); } stdin = Buffer.concat(chunks).toString("utf8"); }
if (process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ argv, stdin, pid: process.pid }) + "\\n");
if (argv.includes("--version")) {
  if (process.env.FAKE_AGY_VERSION_SIGNAL) process.kill(process.pid, process.env.FAKE_AGY_VERSION_SIGNAL);
  if (process.env.FAKE_AGY_VERSION_EXIT) process.exit(Number(process.env.FAKE_AGY_VERSION_EXIT));
  process.stdout.write("1.5.12\\n");
  process.exit(0);
}
const finish = () => {
  process.stdout.write(process.env.FAKE_AGY_ENVELOPE ?? '{"conversation_id":"C1","status":"SUCCESS","response":"ok","num_turns":1}');
  if (process.env.FAKE_AGY_STDERR) process.stderr.write(process.env.FAKE_AGY_STDERR);
  process.exit(Number(process.env.FAKE_AGY_EXIT ?? 0));
};
const sleep = Number(process.env.FAKE_AGY_SLEEP_MS ?? 0);
if (sleep > 0) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, " + sleep + ")"], { stdio: "ignore" });
  fs.writeFileSync(process.env.FAKE_AGY_PIDFILE, JSON.stringify({ pid: process.pid, childPid: child.pid }));
  setTimeout(finish, sleep);
} else {
  finish();
}
`;

function makeSandbox(t, { fakeName = "fake-agy" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-backend-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const fake = path.join(bin, fakeName);
  fs.writeFileSync(fake, FAKE_AGY, { mode: 0o755 });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "b\n");
  const data = path.join(dir, "data");
  const log = path.join(dir, "agy.log");
  return { dir, bin, fake, repo, data, log };
}

function run(sandbox, args, extraEnv = {}) {
  const base = { ...process.env };
  delete base.CLAUDE_PLUGIN_DATA;
  delete base.GEMINI_API_KEY;
  const env = { ...base, PLUGIN_DATA: sandbox.data, ANTIGRAVITY_BIN: sandbox.fake, FAKE_AGY_LOG: sandbox.log, ...extraEnv };
  for (const [key, value] of Object.entries(extraEnv)) if (value === undefined) delete env[key];
  return spawnSync(process.execPath, [COMPANION, ...args], { cwd: sandbox.repo, env, encoding: "utf8" });
}

function logLines(sandbox) {
  if (!fs.existsSync(sandbox.log)) return [];
  return fs.readFileSync(sandbox.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function jobFiles(sandbox) {
  const stateRoot = path.join(sandbox.data, "state");
  if (!fs.existsSync(stateRoot)) return [];
  const files = [];
  for (const workspace of fs.readdirSync(stateRoot)) {
    const jobs = path.join(stateRoot, workspace, "jobs");
    if (fs.existsSync(jobs)) files.push(...fs.readdirSync(jobs));
  }
  return files;
}

test("resolveAgyBin honours ANTIGRAVITY_BIN and defaults to agy", () => {
  assert.equal(resolveAgyBin({ ANTIGRAVITY_BIN: " /opt/agy/agy " }), "/opt/agy/agy");
  assert.equal(resolveAgyBin({}), "agy");
});

test("missing binary is unavailable and names agy and ANTIGRAVITY_BIN", () => {
  const status = getAgyAvailability(process.cwd(), { ...process.env, ANTIGRAVITY_BIN: "/nonexistent/agy" });
  assert.equal(status.available, false);
  assert.match(status.detail, /agy/);
  assert.match(status.detail, /ANTIGRAVITY_BIN/);
});

test("setup --json reports the fake agy with exactly one --version call", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["setup", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.available, true);
  assert.equal(report.version, "1.5.12");
  assert.equal(report.apiKeySet, false);
  assert.ok(report.stateDir);
  assert.match(report.signInNote, /interactive/);
  assert.match(report.signInNote, /agy/);
  assert.equal(report.loggedIn, undefined);
  const lines = logLines(sandbox);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].argv, ["--version"]);
});

test("setup --json reports apiKeySet when GEMINI_API_KEY is set", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const report = JSON.parse(run(sandbox, ["setup", "--json"], { GEMINI_API_KEY: "x" }).stdout);
  assert.equal(report.apiKeySet, true);
});

test("plain setup shows the path, version, key state, state dir and sign-in note", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const text = run(sandbox, ["setup"]).stdout;
  assert.ok(text.includes(sandbox.fake), text);
  assert.match(text, /1\.5\.12/);
  assert.match(text, /GEMINI_API_KEY not set/);
  assert.match(text, /state dir/);
  assert.match(text, /interactive `agy` session/);
  assert.match(run(sandbox, ["setup"], { GEMINI_API_KEY: "x" }).stdout, /GEMINI_API_KEY set/);
});

test("a failing or signalled --version probe is unavailable", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const failing = JSON.parse(run(sandbox, ["setup", "--json"], { FAKE_AGY_VERSION_EXIT: "1" }).stdout);
  assert.equal(failing.available, false);
  const signalled = JSON.parse(run(sandbox, ["setup", "--json"], { FAKE_AGY_VERSION_SIGNAL: "SIGKILL" }).stdout);
  assert.equal(signalled.available, false);
  const task = run(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_VERSION_SIGNAL: "SIGKILL" });
  assert.notEqual(task.status, 0);
  assert.deepEqual(jobFiles(sandbox), []);
});

test("setup finds agy on PATH and reports its absolute path", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t, { fakeName: "agy" });
  const result = run(sandbox, ["setup", "--json"], { ANTIGRAVITY_BIN: undefined, PATH: `${sandbox.bin}${path.delimiter}${process.env.PATH}` });
  const report = JSON.parse(result.stdout);
  assert.equal(report.available, true);
  assert.equal(report.resolvedPath, sandbox.fake);
});

test("no job is written when agy is missing, in every mode", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const transcript = path.join(sandbox.dir, "t.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`);
  const missing = { ANTIGRAVITY_BIN: path.join(sandbox.dir, "missing-agy") };
  for (const args of [
    ["review", "--wait"],
    ["review", "--background"],
    ["task", "--wait", "hi"],
    ["task", "--background", "hi"],
    ["transfer", "--wait", "--source", transcript]
  ]) {
    const result = run(sandbox, args, missing);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /agy/, args.join(" "));
    assert.match(result.stderr, /ANTIGRAVITY_BIN/, args.join(" "));
    assert.deepEqual(jobFiles(sandbox), [], args.join(" "));
  }
});

test("findOnPath skips a non-executable file named agy", { skip: POSIX_ONLY }, async (t) => {
  const { findOnPath } = await import("../plugins/antigravity/scripts/lib/agy.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-path-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = path.join(dir, "a");
  const second = path.join(dir, "b");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, "agy"), "not executable", { mode: 0o644 });
  fs.writeFileSync(path.join(second, "agy"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(findOnPath("agy", { PATH: `${first}${path.delimiter}${second}` }), path.join(second, "agy"));
});
