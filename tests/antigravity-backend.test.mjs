import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getAgyAvailability, resolveAgyBin } from "../plugins/antigravity/scripts/lib/agy.mjs";
import { POSIX_ONLY, jobFiles, logEntries, makeSandbox as makeAcpSandbox, run as runCompanion } from "./fixtures/acp-sandbox.mjs";

// The stand-in agy answers --version with 1.5.14 and logs every start.
function makeSandbox(t, { fakeName = "fake-agy" } = {}) {
  return makeAcpSandbox(t, { fakeName });
}

function run(sandbox, args, extraEnv = {}) {
  return runCompanion(sandbox, args, { GEMINI_API_KEY: undefined, ...extraEnv });
}

function logLines(sandbox) {
  return logEntries(sandbox).filter((entry) => entry.argv);
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
  assert.match(status.detail, /https:\/\/antigravity\.google\/docs\/cli\/acp\.md/);
});

test("setup --json reports the stand-in agy with exactly one --version call", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["setup", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.available, true);
  assert.equal(report.version, "1.5.14");
  assert.ok(report.stateDir);
  assert.match(report.signInNote, /interactive/);
  assert.match(report.signInNote, /agy acp --login/);
  assert.doesNotMatch(report.signInNote, /GEMINI_API_KEY/);
  // API keys are not supported by this bridge, so the report carries no key fact.
  assert.equal("apiKeySet" in report, false);
  assert.equal(report.loggedIn, undefined);
  const lines = logLines(sandbox);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].argv, ["--version"]);
});

test("plain setup shows the path, version, state dir and sign-in note, and no key line", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const text = run(sandbox, ["setup"], { GEMINI_API_KEY: "x" }).stdout;
  assert.ok(text.includes(sandbox.fake), text);
  assert.match(text, /1\.5\.14/);
  assert.match(text, /state dir/);
  assert.match(text, /interactive `agy` session/);
  assert.doesNotMatch(text, /GEMINI_API_KEY/);
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
