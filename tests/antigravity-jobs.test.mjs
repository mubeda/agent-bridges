import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatDeniedActions } from "../plugins/antigravity/scripts/lib/agy.mjs";
import { QUIET_SETTLE_MS, TOKEN_PROMPT, finishAgyRun, startAcpRun, subagentBusy, subagentStates } from "../plugins/antigravity/scripts/lib/acp.mjs";
import { spawn, spawnSync } from "node:child_process";

import {
  COMPANION,
  POSIX_ONLY,
  companionEnv,
  jobStatus,
  lastJob,
  makeSandbox,
  promptTexts,
  requests,
  root,
  run,
  scenario,
  sessions,
  startCompanion
} from "./fixtures/acp-sandbox.mjs";

const FINDINGS = {
  verdict: "needs-attention",
  summary: "s",
  next_steps: [],
  findings: [{ severity: "high", title: "t", body: "b", file: "a.js", line_start: 3, line_end: 4, confidence: 0.9, recommendation: "r" }]
};
const WRITE = ["task", "--wait", "--write", "--bypass-permissions"];

/** Linux start time of a process (field 22 of /proc/<pid>/stat), as the companion records it. */
function procStart(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

// cancel and a dead worker's cleanup signal a pid only when its Linux start time proves it is the job's.
const LINUX_ONLY = process.platform === "linux" ? false : "signals only a pid whose /proc start time matches";

/** Alive and not a zombie: an orphan whose parent never reaps it still answers signal 0, but cannot write anything. */
function processAlive(pid) {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("denied actions format as tool (title)", () => {
  assert.equal(formatDeniedActions([{ action: "run_command", display_name: "echo hi" }]), "run_command (echo hi)");
  assert.equal(formatDeniedActions([{ action: "run_command" }]), "run_command");
});

test("chunks of the last prompt are concatenated into the answer", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, WRITE.concat("hi"), scenario({ turns: [{ chunks: ["Hel", "lo ", "world"] }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Hello world\n");
  const job = lastJob(sandbox);
  assert.equal(job.agySessionId, "S1");
  assert.equal(jobStatus(sandbox, job.id).status, "completed");
});

test("output that is not JSON, and split lines, do not break the run", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, WRITE.concat("hi"), scenario({ noise: true, turns: [{ chunks: ["fine"] }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fine/);
});

test("a stop reason other than end_turn fails the run with the reason", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, WRITE.concat("hi"), scenario({ turns: [{ chunks: ["partial"], stopReason: "max_tokens" }] }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /max_tokens/);
  assert.equal(jobStatus(sandbox, lastJob(sandbox).id).status, "failed");
});

test("the authentication error maps to the sign-in message", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "hi"], scenario({ authError: true }));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /not signed in: run `agy` once interactively, or `agy acp --login`/);
  const job = lastJob(sandbox);
  assert.equal(jobStatus(sandbox, job.id).status, "failed");
  assert.match(run(sandbox, ["result", job.id]).stdout, /not signed in/);
});

test("agy exiting before it answers fails the run clearly", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, WRITE.concat("hi"), scenario({ turns: [{ exit: 3 }] }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /agy exited .*before it answered/);
  assert.equal(jobStatus(sandbox, lastJob(sandbox).id).status, "failed");
});

test("a server that ignores the end of its input is ended after the run", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const started = Date.now();
  const result = run(sandbox, WRITE.concat("hi"), scenario({ ignoreEof: true }));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 15000);
  const [session] = sessions(sandbox);
  assert.throws(() => process.kill(session.pid, 0));
});

test("a structured review shows its findings", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["review", "--wait"], scenario({ turns: [{ chunks: ["```json\n", JSON.stringify(FINDINGS), "\n```"] }] }));
  assert.equal(result.status, 0, result.stderr);
  for (const text of ["high", "a.js", "3", "r"]) assert.match(result.stdout, new RegExp(text));
  assert.equal(promptTexts(sessions(sandbox)[0]).length, 2);
  assert.deepEqual(lastJob(sandbox).status, "completed");
});

function makeLargeChange(t) {
  const sandbox = makeSandbox(t, { changedFiles: 3 });
  // One tracked diff over the 256 KiB budget; the two files after it are only named.
  fs.writeFileSync(path.join(sandbox.repo, "f0.txt"), "a changed line\n".repeat(20000));
  return sandbox;
}

for (const command of ["review", "adversarial-review"]) {
  test(`${command}: a change over the evidence budget says so in the result and in --json`, { skip: POSIX_ONLY }, (t) => {
    const sandbox = makeLargeChange(t);
    const turns = scenario({ turns: [{ chunks: [JSON.stringify(FINDINGS)] }] });
    const result = run(sandbox, [command, "--wait"], turns);
    assert.equal(result.status, 0, result.stderr);
    const notice = result.stdout.split("\n").filter((line) => line.startsWith("Incomplete review:"));
    assert.equal(notice.length, 1, result.stdout);
    assert.match(notice[0], /cut at 262144 bytes/);
    assert.match(notice[0], /Files shown only in part: f0\.txt\. Files not shown: f1\.txt, f2\.txt\.$/);
    assert.match(promptTexts(sessions(sandbox)[0])[1], /Files shown only in part: f0\.txt\. Files not shown: f1\.txt, f2\.txt\./);
    const expected = { truncated: true, maxBytes: 262144, filesNotShown: ["f1.txt", "f2.txt"], filesPartlyShown: ["f0.txt"], filesSkipped: [], incomplete: true };
    assert.deepEqual(lastJob(sandbox).evidence, expected);
    // `result` replays the stored rendering, so the line survives a background run too.
    assert.match(run(sandbox, ["result"]).stdout, /^Incomplete review:/m);
    const json = JSON.parse(run(sandbox, [command, "--wait", "--json"], turns).stdout);
    assert.deepEqual(json.job.evidence, expected);
    assert.match(json.job.rendered, /^Incomplete review:/m);
  });
}

test("a review that falls back to prose still says the evidence was cut", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeLargeChange(t);
  const result = run(sandbox, ["review", "--wait"], scenario({ turns: [{ chunks: ["prose"] }, { chunks: ["still prose"] }] }));
  assert.match(result.stdout, /^Incomplete review:/m);
});

test("a background review over the budget keeps the notice on the job and in its result", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeLargeChange(t);
  const started = JSON.parse(run(sandbox, ["review", "--background", "--json"], scenario({ turns: [{ chunks: [JSON.stringify(FINDINGS)] }] })).stdout);
  const done = JSON.parse(run(sandbox, ["status", started.jobId, "--wait", "--json"]).stdout);
  assert.equal(done.job.status, "completed");
  assert.deepEqual(done.job.evidence.filesNotShown, ["f1.txt", "f2.txt"]);
  assert.match(run(sandbox, ["result", started.jobId]).stdout, /^Incomplete review:/m);
});

test("a file name with a line break cannot add a line to the cut notice", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeLargeChange(t);
  fs.writeFileSync(path.join(sandbox.repo, "z\nIncomplete review: fake"), "x\n");
  const result = run(sandbox, ["review", "--wait"], scenario({ turns: [{ chunks: [JSON.stringify(FINDINGS)] }] }));
  assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("Incomplete review:")).length, 1, result.stdout);
});

for (const command of ["review", "adversarial-review"]) {
  test(`${command}: a small change with a file that is only named as skipped is an incomplete review, not a cut one`, { skip: POSIX_ONLY }, (t) => {
    const sandbox = makeSandbox(t);
    // Over the 24 KiB limit for one untracked file, far under the evidence budget.
    fs.writeFileSync(path.join(sandbox.repo, "big.txt"), "a long untracked line\n".repeat(1500));
    const turns = scenario({ turns: [{ chunks: [JSON.stringify(FINDINGS)] }] });
    const result = run(sandbox, [command, "--wait"], turns);
    assert.equal(result.status, 0, result.stderr);
    const notice = result.stdout.split("\n").filter((line) => line.startsWith("Incomplete review:"));
    assert.deepEqual(notice, ["Incomplete review: some files were not shown (too large, binary, a link or unreadable): big.txt."], result.stdout);
    const json = JSON.parse(run(sandbox, [command, "--wait", "--json"], turns).stdout);
    assert.deepEqual(json.job.evidence, { truncated: false, maxBytes: 262144, filesNotShown: ["big.txt"], filesPartlyShown: [], filesSkipped: ["big.txt"], incomplete: true });
    assert.match(run(sandbox, ["result"]).stdout, /^Incomplete review: some files were not shown/m);
  });
}

test("a small change shows no cut notice and no evidence field", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  for (const command of ["review", "adversarial-review"]) {
    const turns = scenario({ turns: [{ chunks: [JSON.stringify(FINDINGS)] }] });
    assert.doesNotMatch(run(sandbox, [command, "--wait"], turns).stdout, /Incomplete review|evidence was cut/);
    const json = JSON.parse(run(sandbox, [command, "--wait", "--json"], turns).stdout);
    assert.equal("evidence" in json.job, false);
    assert.doesNotMatch(json.job.rendered, /Incomplete review/);
  }
});

test("a review that is not JSON gets one retry in the same session", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["review", "--wait"], scenario({ turns: [{ chunks: ["prose"] }, { chunks: [JSON.stringify(FINDINGS)] }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"findings"/);
  const texts = promptTexts(sessions(sandbox)[0]);
  assert.equal(texts.length, 3);
  assert.match(texts[2], /only the JSON object/);
});

test("a review that is still not JSON after the retry keeps the fallback", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["review", "--wait"], scenario({ turns: [{ chunks: ["prose"] }, { chunks: ["still prose"] }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /still prose/);
  assert.match(result.stdout, /No structured result came back from Antigravity\./);
  assert.equal(promptTexts(sessions(sandbox)[0]).length, 3);
});

test("a write resume reopens the stored session with session/resume", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, WRITE.concat("start")).status, 0);
  assert.equal(run(sandbox, WRITE.concat("--resume-last", "more")).status, 0);
  assert.equal(run(sandbox, WRITE.concat("--resume", "again")).status, 0);
  const [, resumed, again] = sessions(sandbox);
  for (const session of [resumed, again]) {
    assert.deepEqual(requests(session, "session/resume")[0].params, { sessionId: "S1", cwd: sandbox.repo, mcpServers: [] });
    assert.equal(requests(session, "session/new").length, 0);
  }
});

for (const flag of ["--resume-last", "--resume"]) {
  test(`a read-only ${flag} never continues an earlier session: it starts a fresh reader session and says so`, { skip: POSIX_ONLY }, (t) => {
    const sandbox = makeSandbox(t);
    assert.equal(run(sandbox, WRITE.concat("start")).status, 0);
    const result = run(sandbox, ["task", "--wait", flag, "what did you write?"], scenario({ newSessionId: "S2", turns: [{ chunks: ["fresh answer"] }] }));
    assert.equal(result.status, 0, result.stderr);
    const readOnly = sessions(sandbox)[1];
    assert.equal(requests(readOnly, "session/resume").length, 0);
    assert.equal(requests(readOnly, "session/load").length, 0);
    assert.equal(requests(readOnly, "session/new").length, 1);
    assert.ok(readOnly.argv.includes("--agent"));
    assert.deepEqual(promptTexts(readOnly), ["Reply with only your agent token.", "what did you write?"]);
    const warning = "A read-only run cannot continue an earlier Antigravity session, because the restricted reader cannot be attached to it; this started a new session. Add --write to continue the earlier one.";
    assert.ok(result.stdout.startsWith(`Warning: ${warning}\n`), result.stdout);
    assert.match(result.stdout, /fresh answer/);
    const job = lastJob(sandbox);
    assert.equal(job.agySessionId, "S2");
    const stored = JSON.parse(run(sandbox, ["result", job.id, "--json"]).stdout).storedJob;
    assert.equal(stored.warning, warning);
  });
}

const WRITE_AFTER_READ_ONLY = "The earlier Antigravity session was read-only and cannot be continued with write access; this started a new session.";

test("a write --resume-last after only read-only tasks starts a fresh write session and says so", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "look"], scenario({ newSessionId: "R1" })).status, 0);
  assert.equal(lastJob(sandbox).agyReadOnly, true);
  const result = run(sandbox, WRITE.concat("--resume-last", "write it"), scenario({ newSessionId: "W2", turns: [{ chunks: ["written"] }] }));
  assert.equal(result.status, 0, result.stderr);
  const write = sessions(sandbox)[1];
  assert.deepEqual(write.argv, ["acp"]);
  assert.equal(requests(write, "session/resume").length, 0);
  assert.equal(requests(write, "session/load").length, 0);
  assert.equal(requests(write, "session/new").length, 1);
  assert.ok(result.stdout.startsWith(`Warning: ${WRITE_AFTER_READ_ONLY}\n`), result.stdout);
  const job = lastJob(sandbox);
  assert.equal(job.agySessionId, "W2");
  assert.equal(job.agyReadOnly, false);
});

test("a write --resume-last after a newer read-only task starts afresh instead of jumping back", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, WRITE.concat("first"), scenario({ newSessionId: "W1" })).status, 0);
  assert.equal(run(sandbox, ["task", "--wait", "look"], scenario({ newSessionId: "R2" })).status, 0);
  const result = run(sandbox, WRITE.concat("--resume-last", "more"), scenario({ newSessionId: "W3" }));
  assert.equal(result.status, 0, result.stderr);
  const write = sessions(sandbox)[2];
  assert.equal(requests(write, "session/resume").length, 0);
  assert.ok(result.stdout.startsWith(`Warning: ${WRITE_AFTER_READ_ONLY}\n`), result.stdout);
});

test("a write --resume-last after a run that failed before its prompt starts afresh and says why", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, WRITE.concat("first"), scenario({ newSessionId: "W1" })).status, 0);
  assert.notEqual(run(sandbox, WRITE.concat("--model", "no-such-model", "second"), scenario({ newSessionId: "EMPTY2" })).status, 0);
  assert.equal(lastJob(sandbox).agyPromptSent, false);
  assert.equal(candidate(sandbox, ["--for-write"]).available, false);
  const result = run(sandbox, WRITE.concat("--resume-last", "more"), scenario({ newSessionId: "W3" }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests(sessions(sandbox)[2], "session/resume").length, 0);
  assert.match(result.stdout, /^Warning: The most recent Antigravity task failed before its prompt reached the session/);
});

test("--resume-job without new text continues the chosen job with the default prompt", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, WRITE.concat("first"), scenario({ newSessionId: "W1" })).status, 0);
  const writeJob = lastJob(sandbox);
  const ok = run(sandbox, WRITE.concat("--resume-job", writeJob.id));
  assert.equal(ok.status, 0, ok.stderr);
  const resumed = sessions(sandbox)[1];
  assert.deepEqual(requests(resumed, "session/resume").map((message) => message.params.sessionId), ["W1"]);
  assert.deepEqual(requests(resumed, "session/prompt").map((message) => message.params.prompt[0].text), ["Continue the previous task."]);
});

test("--resume-job continues exactly the chosen write job, and refuses one that cannot be continued", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, WRITE.concat("first"), scenario({ newSessionId: "W1" })).status, 0);
  const writeJob = lastJob(sandbox);
  assert.equal(run(sandbox, ["task", "--wait", "look"], scenario({ newSessionId: "R2" })).status, 0);
  const readJob = lastJob(sandbox);
  const ok = run(sandbox, WRITE.concat("--resume-job", writeJob.id, "more"));
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(requests(sessions(sandbox)[2], "session/resume").map((message) => message.params.sessionId), ["W1"]);
  assert.doesNotMatch(ok.stdout, /Warning/);
  const before = sessions(sandbox).length;
  const jobsBefore = JSON.parse(run(sandbox, ["status", "--all", "--json"]).stdout).recent.length;
  for (const args of [WRITE.concat("--resume-job", readJob.id, "more"), ["task", "--wait", "--resume-job", writeJob.id, "more"], WRITE.concat("--resume-job", "task-nope", "more")]) {
    const refused = run(sandbox, args);
    assert.notEqual(refused.status, 0, args.join(" "));
    assert.match(refused.stderr, /cannot be continued|--write|No job/, args.join(" "));
  }
  assert.equal(sessions(sandbox).length, before);
  assert.equal(JSON.parse(run(sandbox, ["status", "--all", "--json"]).stdout).recent.length, jobsBefore);
});

function stripReadOnlyField(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) stripReadOnlyField(full);
    else if (entry.name.endsWith(".json")) {
      const text = fs.readFileSync(full, "utf8").replace(/,?\s*"agyReadOnly":\s*(true|false)/g, "");
      fs.writeFileSync(full, text);
    }
  }
}

test("a write task sets the session mode auto before its prompt; a read-only task and a review keep the default", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, WRITE.concat("go")).status, 0);
  const [write] = sessions(sandbox);
  assert.deepEqual(requests(write, "session/set_mode").map((message) => message.params), [{ sessionId: "S1", modeId: "auto" }]);
  const methods = write.received.map((message) => message.method);
  assert.ok(methods.indexOf("session/new") < methods.indexOf("session/set_mode") && methods.indexOf("session/set_mode") < methods.indexOf("session/prompt"));
  assert.equal(run(sandbox, ["task", "--wait", "look"]).status, 0);
  assert.equal(run(sandbox, ["review", "--wait"], scenario({ turns: [{ chunks: [JSON.stringify(FINDINGS)] }] })).status, 0);
  for (const session of sessions(sandbox).slice(1)) assert.equal(requests(session, "session/set_mode").length, 0);
});

test("a resumed write session sets the mode auto again", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, WRITE.concat("start")).status, 0);
  assert.equal(run(sandbox, WRITE.concat("--resume-last", "more")).status, 0);
  const resumed = sessions(sandbox)[1];
  assert.equal(requests(resumed, "session/resume").length, 1);
  assert.deepEqual(requests(resumed, "session/set_mode").map((message) => message.params), [{ sessionId: "S1", modeId: "auto" }]);
});

test("without the auto mode, or when setting it fails, a write task goes on in the session's mode and says which in one line", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  for (const [env, sent] of [[{ noAutoMode: true }, 0], [{ setModeError: "mode boom" }, 1]]) {
    const result = run(sandbox, WRITE.concat("go"), scenario({ ...env, turns: [{ chunks: ["done anyway"] }] }));
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split("\n").filter((line) => /auto mode/.test(line));
    assert.equal(lines.length, 1, result.stdout);
    assert.match(lines[0], /^Warning: .*the session stayed in mode "default"/);
    assert.match(result.stdout, /done anyway/);
    assert.equal(requests(sessions(sandbox).at(-1), "session/set_mode").length, sent);
  }
  // A resumed session lists no modes, so its current mode is not known.
  const resumed = run(sandbox, WRITE.concat("--resume-last", "more"), scenario({ setModeError: "mode boom" }));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /^Warning: .*auto mode.*the mode was left unchanged/m);
});

test("a job record without the read-only field counts as a write session", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "old"], scenario({ newSessionId: "OLD1" })).status, 0);
  stripReadOnlyField(path.join(sandbox.data, "state"));
  assert.equal(lastJob(sandbox).agyReadOnly, undefined);
  const result = run(sandbox, WRITE.concat("--resume-last", "more"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requests(sessions(sandbox)[1], "session/resume").map((message) => message.params.sessionId), ["OLD1"]);
});

test("without the resume capability a write resume starts a new session and says why; session/load is never used", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const env = scenario({ noResume: true, newSessionId: "S2", turns: [{ chunks: ["new answer"] }] });
  assert.equal(run(sandbox, WRITE.concat("start")).status, 0);
  const resumed = run(sandbox, WRITE.concat("--resume-last", "more"), env);
  assert.equal(resumed.status, 0, resumed.stderr);
  const session = sessions(sandbox)[1];
  assert.equal(requests(session, "session/load").length, 0);
  assert.equal(requests(session, "session/resume").length, 0);
  assert.match(resumed.stdout, /^Warning: This Antigravity version cannot continue sessions/);
  assert.match(resumed.stdout, /new answer/);
  assert.equal(lastJob(sandbox).agySessionId, "S2");
});

test("a resume error other than a missing session fails the run and sends no prompt", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, WRITE.concat("start")).status, 0);
  const resumed = run(sandbox, WRITE.concat("--resume-last", "more"), scenario({ resumeError: "internal boom" }));
  assert.equal(resumed.status, 1);
  assert.match(resumed.stdout, /internal boom/);
  const session = sessions(sandbox)[1];
  assert.deepEqual(promptTexts(session), []);
  assert.equal(requests(session, "session/new").length, 0);
});

test("a resume the server rejects starts a new session and warns", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, WRITE.concat("start")).status, 0);
  const resumed = run(sandbox, WRITE.concat("--resume-last", "more"), scenario({ resumeFails: true, newSessionId: "S2" }));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /conversation S1 not found; Antigravity started a new one/);
  assert.equal(requests(sessions(sandbox)[1], "session/load").length, 0);
  const job = lastJob(sandbox);
  assert.equal(job.agySessionId, "S2");
  assert.equal(jobStatus(sandbox, job.id).status, "completed");
});

function candidate(sandbox, args = []) {
  return JSON.parse(run(sandbox, ["task-resume-candidate", "--json", ...args]).stdout);
}

test("task-resume-candidate offers only the most recent task, and only when a write run can continue it", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(candidate(sandbox, ["--for-write"]).available, false);
  assert.equal(run(sandbox, WRITE.concat("fix"), scenario({ newSessionId: "W1" })).status, 0);
  const writeJob = lastJob(sandbox);
  const found = candidate(sandbox, ["--for-write"]);
  assert.equal(found.available, true);
  assert.equal(found.candidate.agySessionId, "W1");
  assert.equal(found.candidate.id, writeJob.id);
  assert.match(run(sandbox, ["task-resume-candidate", "--for-write"]).stdout, new RegExp(writeJob.id));
  assert.equal(run(sandbox, ["task", "--wait", "look again"], scenario({ newSessionId: "R2" })).status, 0);
  assert.equal(candidate(sandbox, ["--for-write"]).available, false, "the most recent task is read-only");
  // A read-only follow-up never continues a session, so it never has a candidate.
  assert.equal(candidate(sandbox).available, false);
});

test("a review answer that is an object but not a review gets the retry, then the fallback", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const bad = run(sandbox, ["review", "--wait"], scenario({ turns: [{ chunks: ["{}"] }, { chunks: [JSON.stringify({ ...FINDINGS, verdict: "maybe" })] }] }));
  assert.equal(bad.status, 0, bad.stderr);
  assert.match(bad.stdout, /No structured result came back from Antigravity\./);
  assert.equal(promptTexts(sessions(sandbox)[0]).length, 3);
  const fixed = run(sandbox, ["review", "--wait"], scenario({ turns: [{ chunks: [JSON.stringify({ verdict: "approve" })] }, { chunks: [JSON.stringify(FINDINGS)] }] }));
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.doesNotMatch(fixed.stdout, /No structured result/);
  assert.match(fixed.stdout, /"verdict": "needs-attention"/);
});

test("the review check follows the schema's required fields and enums", async () => {
  const { isReviewResult } = await import("../plugins/antigravity/scripts/lib/acp.mjs");
  assert.equal(isReviewResult(FINDINGS), true);
  assert.equal(isReviewResult({ verdict: "approve", summary: "fine", findings: [], next_steps: [] }), true);
  assert.equal(isReviewResult({}), false);
  assert.equal(isReviewResult({ ...FINDINGS, summary: "" }), false);
  assert.equal(isReviewResult({ ...FINDINGS, extra: 1 }), false);
  assert.equal(isReviewResult({ ...FINDINGS, next_steps: [""] }), false);
  const finding = FINDINGS.findings[0];
  for (const broken of [{ severity: "urgent" }, { line_start: 0 }, { line_end: 1.5 }, { confidence: 2 }, { file: "" }, { recommendation: 3 }, { extra: true }]) {
    assert.equal(isReviewResult({ ...FINDINGS, findings: [{ ...finding, ...broken }] }), false, JSON.stringify(broken));
  }
  const { recommendation, ...missing } = finding;
  void recommendation;
  assert.equal(isReviewResult({ ...FINDINGS, findings: [missing] }), false);
});

test("a server that closes its output but stays alive fails the run without hanging", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const started = Date.now();
  const result = run(sandbox, WRITE.concat("hi"), scenario({ turns: [{ closeStdout: true }] }), { timeout: 30000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /agy closed its output before it answered/);
  assert.ok(Date.now() - started < 15000);
  assert.throws(() => process.kill(sessions(sandbox)[0].pid, 0));
});

test("a server that stops reading its input fails the run without hanging", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, WRITE.concat("hi"), scenario({ closeStdinAfterInit: true }), { timeout: 30000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /could not write to agy/);
  assert.throws(() => process.kill(sessions(sandbox)[0].pid, 0));
});

test("an error response with a null id fails the run instead of hanging", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, WRITE.concat("hi"), scenario({ nullIdError: "session/new" }), { timeout: 30000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Parse error/);
});

test("responses whose ids are numeric strings match their requests", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, WRITE.concat("hi"), scenario({ stringIds: true, turns: [{ chunks: ["matched"] }] }), { timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /matched/);
});

for (const hangOn of ["initialize", "session/new", "token"]) {
  test(`a server that never answers ${hangOn} times out`, { skip: POSIX_ONLY }, (t) => {
    const sandbox = makeSandbox(t);
    const args = hangOn === "token" ? ["task", "--wait", "look"] : WRITE.concat("hi");
    const result = run(sandbox, args, { ...scenario({ hangOn }), AGENT_BRIDGES_ACP_SETUP_TIMEOUT_MS: "500" }, { timeout: 30000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, hangOn === "token" ? /token check/ : new RegExp(`did not answer ${hangOn}`));
    assert.throws(() => process.kill(sessions(sandbox)[0].pid, 0));
  });
}

test("lines that are not JSON are skipped but shown with a failure", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, WRITE.concat("hi"), scenario({ noise: true, turns: [{ exit: 3 }] }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /starting server \(not json\)/);
});

test("a forbidden tool call that arrives in a later write after the final answer still fails the run", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "look"], scenario({ exitDelayMs: 400, turns: [{ chunks: ["looks fine"], lateToolCall: "write_file" }] }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /write_file/);
  assert.doesNotMatch(result.stdout, /looks fine/);
  assert.equal(jobStatus(sandbox, lastJob(sandbox).id).status, "failed");
});

test("a task waits for a tool call that completes after its turn ended, and keeps the text after it", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const after = [{ toolCall: "run_command", id: "bg" }, { delayMs: 800, toolDone: "bg" }, { chunk: " second step done" }];
  const started = Date.now();
  const result = run(sandbox, WRITE.concat("go"), scenario({ turns: [{ chunks: ["started in the background"], after }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started >= 800);
  assert.equal(result.stdout, "started in the background second step done\n");
  assert.equal(requests(sessions(sandbox)[0], "session/cancel").length, 0);
});

test("a permission request after the turn ended is allowed once in a write task and refused in a read-only task", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const after = [{ delayMs: 300, permission: true }, { chunk: " after the permission" }];
  // The settle time outlasts the gap before the request: an update within it keeps the session open.
  const turns = { ...scenario({ turns: [{ chunks: ["first"], after }] }), AGENT_BRIDGES_ACP_SETTLE_MS: "1000" };
  const write = run(sandbox, WRITE.concat("go"), turns);
  assert.equal(write.status, 0, write.stderr);
  assert.equal(write.stdout, "first after the permission\n");
  const replies = (session) => session.received.filter((message) => !message.method && message.result?.outcome);
  assert.deepEqual(replies(sessions(sandbox).at(-1)).map((reply) => reply.result.outcome), [{ outcome: "selected", optionId: "allow" }]);
  const readOnly = run(sandbox, ["task", "--wait", "look"], turns);
  assert.equal(readOnly.status, 0, readOnly.stderr);
  assert.equal(readOnly.stdout, "first after the permission\nDenied: run_command (echo later)\n");
  assert.deepEqual(replies(sessions(sandbox).at(-1)).map((reply) => reply.result.outcome), [{ outcome: "selected", optionId: "deny" }]);
});

test("a busy subagent keeps the task open until its transcript has a SYSTEM_MESSAGE after the RUNNING record", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  // HOME is the sandbox folder, so the client reads ~/.gemini from there.
  const brain = path.join(sandbox.dir, ".gemini", "antigravity-cli", "brain");
  const after = [{ subagent: "sub1" }, { delayMs: 1500, subagentDone: "sub1" }];
  const started = Date.now();
  const result = run(sandbox, WRITE.concat("go"), scenario({ brain, turns: [{ chunks: ["asked a subagent"], after }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started >= 1500, "the run ended while the subagent was still RUNNING");
  assert.equal(result.stdout, "asked a subagent\n");
});

test("subagentBusy: RUNNING without a later SYSTEM_MESSAGE is busy, unless the transcript predates the run", (t) => {
  const gemini = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  t.after(() => fs.rmSync(gemini, { recursive: true, force: true }));
  const brain = path.join(gemini, "antigravity-cli", "brain");
  const list = path.join(brain, "S1", ".system_generated", "subagents");
  const logs = path.join(brain, "sub1", ".system_generated", "logs");
  fs.mkdirSync(list, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(list, "sub1.json"), JSON.stringify({ conversationId: "sub1" }));
  const transcript = path.join(logs, "transcript.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "TOOL_CALL", status: "RUNNING" })}\nnot json\n`);
  const mtime = fs.statSync(transcript).mtimeMs;
  const later = mtime + 60_000;
  assert.equal(subagentBusy(gemini, "S1", 1000, { now: mtime + 10 }), true, "changed within the settle time");
  assert.equal(subagentBusy(gemini, "S1", 1000, { now: later }), true, "RUNNING");
  assert.equal(subagentBusy(gemini, "S1", 1000, { now: later, since: mtime + 1 }), false, "left by an earlier run");
  assert.equal(subagentBusy(gemini, "../S1", 1000, { now: later }), false, "an id with a separator");
  assert.equal(subagentBusy(gemini, "S2", 1000, { now: later }), false, "no subagents");
  fs.appendFileSync(transcript, `${JSON.stringify({ type: "SYSTEM_MESSAGE" })}\n`);
  assert.equal(subagentBusy(gemini, "S1", 1000, { now: fs.statSync(transcript).mtimeMs + 60_000 }), false, "SYSTEM_MESSAGE after RUNNING");
});

test("the default settle time is 30 s: a thinking model can be silent for 17 s", () => {
  assert.equal(QUIET_SETTLE_MS, 30_000);
});

test("subagentBusy: two background commands and one SYSTEM_MESSAGE are still busy", (t) => {
  const gemini = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  t.after(() => fs.rmSync(gemini, { recursive: true, force: true }));
  const brain = path.join(gemini, "antigravity-cli", "brain");
  fs.mkdirSync(path.join(brain, "S1", ".system_generated", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(brain, "S1", ".system_generated", "subagents", "sub1.json"), JSON.stringify({ conversationId: "sub1" }));
  const logs = path.join(brain, "sub1", ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const transcript = path.join(logs, "transcript.jsonl");
  const running = JSON.stringify({ type: "TOOL_CALL", status: "RUNNING" });
  const done = JSON.stringify({ type: "SYSTEM_MESSAGE" });
  fs.writeFileSync(transcript, `${running}\n${running}\n${done}\n`);
  const later = () => fs.statSync(transcript).mtimeMs + 60_000;
  assert.equal(subagentBusy(gemini, "S1", 1000, { now: later() }), true, "one of two commands ended");
  fs.appendFileSync(transcript, `${done}\n`);
  assert.equal(subagentBusy(gemini, "S1", 1000, { now: later() }), false, "both ended");
});

test("a subagent stuck on a command it never ran is named, and the task is not a plain success", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const brain = path.join(sandbox.dir, ".gemini", "antigravity-cli", "brain");
  const after = [{ subagent: "sub1", role: "implementer", stuck: true }];
  const result = run(sandbox, WRITE.concat("go"), scenario({ brain, turns: [{ chunks: ["Waiting for its report."], after }] }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Waiting for its report\./);
  assert.match(result.stdout, /^Unfinished subagents: implementer \(sub1\): stuck on a command$/m);
  const job = lastJob(sandbox);
  assert.equal(job.status, "failed");
  assert.deepEqual(job.unfinishedSubagents, [{ id: "sub1", role: "implementer", reason: "stuck on a command" }]);
});

test("an over-long transcript record is noted in the reason and never makes a subagent stuck by itself", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const brain = path.join(sandbox.dir, ".gemini", "antigravity-cli", "brain");
  const env = (after) => ({ ...scenario({ brain, turns: [{ chunks: ["asked"], after }] }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "1500" });
  const stuckThenHuge = run(sandbox, WRITE.concat("go"), env([{ subagent: "sub1", role: "implementer", stuck: true }, { subagentHuge: "sub1" }]));
  assert.equal(stuckThenHuge.status, 0, stuckThenHuge.stdout);
  assert.equal(stuckThenHuge.stdout, "asked\n");
  const running = run(sandbox, WRITE.concat("go"), env([{ subagent: "sub2", role: "tester" }, { subagentHuge: "sub2" }]));
  assert.equal(running.status, 1, running.stdout);
  assert.match(running.stdout, /^Unfinished subagents: tester \(sub2\): still running \(a transcript record over 1 MiB was skipped\)$/m);
});

test("a subagent still running when the wait's bound hits is named", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const brain = path.join(sandbox.dir, ".gemini", "antigravity-cli", "brain");
  const after = [{ subagent: "sub1", role: "tester" }];
  const result = run(sandbox, WRITE.concat("go"), { ...scenario({ brain, turns: [{ chunks: ["asked a subagent"], after }] }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "1500" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /still working 2 s after its turn ended/);
  assert.match(result.stdout, /^Unfinished subagents: tester \(sub1\): still running$/m);
  const job = lastJob(sandbox);
  assert.equal(job.status, "failed");
  assert.deepEqual(job.unfinishedSubagents, [{ id: "sub1", role: "tester", reason: "still running" }]);
});

test("text of another session on the connection is not added to the task's answer", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const after = [{ chunk: " finished.", sessionId: "SUB1" }, { chunk: " finished." }];
  const result = run(sandbox, WRITE.concat("go"), scenario({ turns: [{ chunks: ["Waiting."], after }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Waiting. finished.\n");
});

test("an empty title on a later record keeps an ask_question's name, so it neither blocks nor loses its text", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const after = [{ toolCall: "ask_question", id: "q", title: "Which file?" }, { toolCall: "", id: "q", title: "" }];
  const result = run(sandbox, WRITE.concat("go"), { ...scenario({ turns: [{ chunks: ["need input"], after }] }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "3000" });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "need input\nUnanswered questions: Which file?\n");
});

test("a read-only violation after the wait's bound hit still discards the partial answer", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  // An open manage_task (the reader's one allowed tool) holds the wait open until its bound.
  const after = [{ toolCall: "manage_task", id: "r" }, { delayMs: 1150, toolCall: "write_file", id: "w" }];
  // agy ignores SIGTERM, so the violation arrives while its tree is being ended.
  const result = run(sandbox, ["task", "--wait", "look"], { ...scenario({ ignoreTerm: true, exitDelayMs: 1000, turns: [{ chunks: ["PARTIAL"], after }] }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "1000" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /write_file/);
  assert.doesNotMatch(result.stdout, /PARTIAL/);
  assert.doesNotMatch(lastJob(sandbox).rendered ?? "", /PARTIAL/);
});

test("subagentStates re-reads a transcript that changed and skips one that predates the run", (t) => {
  const gemini = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  t.after(() => fs.rmSync(gemini, { recursive: true, force: true }));
  const brain = path.join(gemini, "antigravity-cli", "brain");
  fs.mkdirSync(path.join(brain, "S1", ".system_generated", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(brain, "S1", ".system_generated", "subagents", "sub1.json"), JSON.stringify({ conversationId: "sub1" }));
  const logs = path.join(brain, "sub1", ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const transcript = path.join(logs, "transcript.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "TOOL_CALL", status: "RUNNING" })}\n`);
  const cache = new Map();
  const at = () => ({ now: fs.statSync(transcript).mtimeMs + 60_000, cache });
  assert.equal(subagentStates(gemini, "S1", 1000, at())[0].running, true);
  assert.equal(subagentStates(gemini, "S1", 1000, at())[0].running, true, "from the cache");
  fs.appendFileSync(transcript, `${JSON.stringify({ type: "SYSTEM_MESSAGE" })}\n`);
  assert.equal(subagentStates(gemini, "S1", 1000, at())[0].running, false, "re-read after the change");
  assert.deepEqual(subagentStates(gemini, "S1", 1000, { ...at(), since: Date.now() + 60_000 }), []);
});

test("another session's tool calls neither hold the wait, add questions, nor close this session's call with the same id", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const after = [
    { toolCall: "run_command", id: "never", sessionId: "SUB1" },
    { toolCall: "ask_question", id: "q", question: "Theirs?", sessionId: "SUB1" },
    { toolCall: "run_command", id: "x" },
    { toolDone: "x", sessionId: "SUB1" },
    { delayMs: 600, toolDone: "x" },
    { chunk: " done" }
  ];
  const started = Date.now();
  const result = run(sandbox, WRITE.concat("go"), { ...scenario({ turns: [{ chunks: ["working"], after }] }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "5000" });
  assert.equal(result.status, 0, result.stdout);
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.stdout, "working done\n");
});

test("another session's forbidden tool call still stops a read-only task", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "look"], scenario({ turns: [{ chunks: ["SECRET ANSWER"], after: [{ toolCall: "write_file", id: "w", sessionId: "SUB1" }] }] }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /write_file/);
  assert.doesNotMatch(result.stdout, /SECRET ANSWER/);
});

test("a completion without a call id closes the one open call, and is reported at once when it matches several", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const env = (after) => ({ ...scenario({ turns: [{ chunks: ["go"], after }] }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "5000" });
  let started = Date.now();
  const one = run(sandbox, WRITE.concat("go"), env([{ toolCall: "run_command", id: "bg" }, { delayMs: 300, toolDoneNoId: true }, { chunk: " closed" }]));
  assert.equal(one.status, 0, one.stdout);
  assert.ok(Date.now() - started < 5000);
  assert.equal(one.stdout, "go closed\n");
  // A pending ask_question waits for an answer nobody sends: the completion closes the command, not the question.
  const withQuestion = run(sandbox, WRITE.concat("go"), env([{ toolCall: "ask_question", id: "q", question: "Which?" }, { toolCall: "run_command", id: "bg" }, { delayMs: 300, toolDoneNoId: true }, { chunk: " closed" }]));
  assert.equal(withQuestion.status, 0, withQuestion.stdout);
  assert.equal(withQuestion.stdout, "go closed\nUnanswered questions: Which?\n");
  started = Date.now();
  const two = run(sandbox, WRITE.concat("go"), env([{ toolCall: "run_command", id: "a" }, { toolCall: "run_command", id: "b" }, { delayMs: 300, toolDoneNoId: true }]));
  assert.ok(Date.now() - started < 5000, "waited for the bound");
  assert.match(two.stdout, /^Unmatched tool updates: 1 completion without a call id could not be matched to one open tool call \(2 open\), so the open calls were not waited for\.$/m);
});

test("on the wait's bound, a subagent that is only recently active is named as such", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const brain = path.join(sandbox.dir, ".gemini", "antigravity-cli", "brain");
  const after = [{ subagent: "sub1", role: "explorer", plain: true }, ...Array.from({ length: 10 }, () => ({ delayMs: 200, subagentTouch: "sub1" }))];
  const result = run(sandbox, WRITE.concat("go"), { ...scenario({ brain, turns: [{ chunks: ["asked"], after }] }), AGENT_BRIDGES_ACP_SETTLE_MS: "600", AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "1000" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^Unfinished subagents: explorer \(sub1\): recently active$/m);
  assert.deepEqual(lastJob(sandbox).unfinishedSubagents, [{ id: "sub1", role: "explorer", reason: "recently active" }]);
});

test("on the wait's bound the result keeps its Unanswered questions and Denied lines", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const bound = { AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "1000" };
  const write = run(sandbox, WRITE.concat("go"), { ...scenario({ turns: [{ chunks: ["partial"], after: [{ toolCall: "ask_question", id: "q", question: "Which?" }, { toolCall: "run_command", id: "bg" }] }] }), ...bound });
  assert.equal(write.status, 1, write.stdout);
  assert.match(write.stdout, /^partial\nUnanswered questions: Which\?$/m);
  const readOnly = run(sandbox, ["task", "--wait", "look"], { ...scenario({ turns: [{ chunks: ["partial"], after: [{ permission: true }, { toolCall: "manage_task", id: "r" }] }] }), ...bound });
  assert.equal(readOnly.status, 1, readOnly.stdout);
  assert.match(readOnly.stdout, /^partial\nDenied: run_command \(echo later\)$/m);
});

test("subagentStates does not parse a transcript still changing within the settle time, unless asked to diagnose", (t) => {
  const gemini = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  t.after(() => fs.rmSync(gemini, { recursive: true, force: true }));
  const brain = path.join(gemini, "antigravity-cli", "brain");
  fs.mkdirSync(path.join(brain, "S1", ".system_generated", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(brain, "S1", ".system_generated", "subagents", "sub1.json"), JSON.stringify({ conversationId: "sub1" }));
  const logs = path.join(brain, "sub1", ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const transcript = path.join(logs, "transcript.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "TOOL_CALL", status: "RUNNING" })}\n`);
  const now = fs.statSync(transcript).mtimeMs + 10;
  assert.deepEqual(subagentStates(gemini, "S1", 1000, { now }), [{ id: "sub1", role: null, busy: true, running: false, stuck: false, recent: true, tooLarge: false }]);
  assert.deepEqual(subagentStates(gemini, "S1", 1000, { now, diagnose: true }), [{ id: "sub1", role: null, busy: true, running: true, stuck: false, recent: true, tooLarge: false }]);
});

test("the wait's bound ends agy's whole process group, even after agy itself exited", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const after = [{ toolCall: "run_command", id: "bg" }, { background: true }];
  const result = run(sandbox, WRITE.concat("go"), { ...scenario({ turns: [{ chunks: ["started"], after }] }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "1000" });
  assert.equal(result.status, 1, result.stdout);
  const { bgPid } = JSON.parse(fs.readFileSync(sandbox.pidfile, "utf8"));
  t.after(() => { try { process.kill(bgPid, "SIGKILL"); } catch {} });
  assert.equal(processAlive(bgPid), false, "the background command outlived the run");
});

test("an unexpected agy exit during the wait ends the background command agy left behind", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const after = [{ toolCall: "run_command", id: "bg" }, { background: true }, { delayMs: 300, exit: 3 }];
  const result = run(sandbox, WRITE.concat("go"), scenario({ turns: [{ chunks: ["started"], after }] }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /agy exited/);
  const { bgPid } = JSON.parse(fs.readFileSync(sandbox.pidfile, "utf8"));
  t.after(() => { try { process.kill(bgPid, "SIGKILL"); } catch {} });
  assert.equal(processAlive(bgPid), false, "the background command outlived the run");
});

test("finishAgyRun: a run that did not complete cleanly ends the tree before agy's input closes; a clean one gets its grace first", async () => {
  const order = (clean, exits) => {
    const calls = [];
    return finishAgyRun({
      clean,
      endTree: async () => { calls.push("endTree"); },
      closeInput: () => { calls.push("closeInput"); },
      waitExit: async () => { calls.push("waitExit"); return exits; }
    }).then(() => calls);
  };
  // Windows: taskkill /T reaches the tree only while agy's PID still addresses it, so it comes before EOF.
  assert.deepEqual(await order(false, true), ["endTree", "closeInput"]);
  assert.deepEqual(await order(true, true), ["closeInput", "waitExit"]);
  assert.deepEqual(await order(true, false), ["closeInput", "waitExit", "endTree"]);
});

test("call ids that are absent, null or empty are one case: anonymous starts are waited for and closed", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const env = (after, extra = {}) => ({ ...scenario({ turns: [{ chunks: ["go"], after }] }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "5000", ...extra });
  let started = Date.now();
  const anonymous = run(sandbox, WRITE.concat("go"), env([{ toolCall: "run_command", noId: true }, { delayMs: 600, toolDoneNoId: true }, { chunk: " done" }]));
  assert.equal(anonymous.status, 0, anonymous.stdout);
  assert.ok(Date.now() - started >= 600, "an anonymous command was not waited for");
  assert.equal(anonymous.stdout, "go done\n");
  for (const value of [null, ""]) {
    started = Date.now();
    const closed = run(sandbox, WRITE.concat("go"), env([{ toolCall: "run_command", id: "bg" }, { delayMs: 300, toolDoneWithId: value }, { chunk: " closed" }]));
    assert.equal(closed.status, 0, `${value}: ${closed.stdout}`);
    assert.ok(Date.now() - started < 5000, `${value}: waited for the bound`);
    assert.equal(closed.stdout, "go closed\n");
  }
  const question = run(sandbox, WRITE.concat("go"), env([{ toolCall: "ask_question", noId: true, question: "Which?" }]));
  assert.equal(question.stdout, "go\nUnanswered questions: Which?\n");
});

test("a call reported active again after an ambiguous completion is waited for again", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const after = [
    { toolCall: "run_command", id: "a" },
    { toolCall: "run_command", id: "b" },
    { delayMs: 50, toolDoneNoId: true },
    { delayMs: 50, toolActive: "a" },
    { delayMs: 800, toolDone: "a" },
    { chunk: " a done" }
  ];
  const result = run(sandbox, WRITE.concat("go"), { ...scenario({ turns: [{ chunks: ["go"], after }] }), AGENT_BRIDGES_ACP_SETTLE_MS: "300" });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^go a done$/m);
});

test("a tool call before the session id is known: another session's does not hold the wait; a forbidden one still stops a read-only run", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const started = Date.now();
  const write = run(sandbox, WRITE.concat("go"), { ...scenario({ preSessionToolCall: { name: "run_command", sessionId: "SUB1" } }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "5000" });
  assert.equal(write.status, 0, write.stdout);
  assert.ok(Date.now() - started < 5000);
  const readOnly = run(sandbox, ["task", "--wait", "look"], scenario({ preSessionToolCall: { name: "write_file", sessionId: "SUB1" } }));
  assert.equal(readOnly.status, 1, readOnly.stdout);
  assert.match(readOnly.stdout, /write_file/);
});

test("a read-only violation during the quiet wait ends the run at once, not at the next poll", async () => {
  const token = "tok";
  let run;
  const reply = (message) => setImmediate(() => run.handle(message));
  run = startAcpRun({
    cwd: process.cwd(),
    prompt: "look",
    readOnly: true,
    token,
    quietSettleMs: 10_000,
    geminiDir: path.join(os.tmpdir(), "agy-no-gemini"),
    write(line) {
      const message = JSON.parse(line);
      if (message.method === "initialize") reply({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") reply({ id: message.id, result: { sessionId: "S1" } });
      else if (message.method === "session/prompt" && message.params.prompt[0].text === TOKEN_PROMPT) {
        reply({ method: "session/update", params: { sessionId: "S1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: token } } } });
        reply({ id: message.id, result: { stopReason: "end_turn" } });
      } else if (message.method === "session/prompt") {
        reply({ id: message.id, result: { stopReason: "end_turn" } });
        setTimeout(() => {
          run.violationAt = Date.now();
          run.handle({ method: "session/update", params: { sessionId: "S1", update: { sessionUpdate: "tool_call", toolCallId: "w", name: "write_file", status: "pending" } } });
        }, 30);
      }
    }
  });
  const parsed = await run.result;
  const delay = Date.now() - run.violationAt;
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /write_file/);
  assert.ok(delay < 100, `the wait noticed the stop after ${delay} ms`);
});

test("a pending ask_question does not keep the task open and its question is named in the result", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  for (const [step, named] of [
    [{ question: "Do you prefer red or blue?" }, "Do you prefer red or blue?"],
    [{ question: "Do you prefer red or blue?", questionVia: "args" }, "Do you prefer red or blue?"],
    [{}, "Run ask_question"]
  ]) {
    const after = [{ toolCall: "ask_question", id: "q", ...step }];
    const result = run(sandbox, WRITE.concat("go"), scenario({ turns: [{ chunks: ["need input"], after }] }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `need input\nUnanswered questions: ${named}\n`, JSON.stringify(step));
  }
});

test("a session that never goes quiet is stopped by the bound on the wait, with the text it wrote", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const after = [{ toolCall: "run_command", id: "bg" }];
  const started = Date.now();
  // agy ignores SIGTERM, so it lives long enough to log the session/cancel sent before the tree is ended.
  const result = run(sandbox, WRITE.concat("go"), { ...scenario({ ignoreTerm: true, turns: [{ chunks: ["still going"], after }] }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "1000" });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(Date.now() - started < 15000);
  assert.match(result.stdout, /still working 1 s after its turn ended/);
  assert.match(result.stdout, /still going/);
  assert.equal(requests(sessions(sandbox)[0], "session/cancel").length, 1);
  assert.equal(jobStatus(sandbox, lastJob(sandbox).id).status, "failed");
});

test("agy exiting while a task waits for its session to go quiet fails the run", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const after = [{ toolCall: "run_command", id: "bg" }, { delayMs: 300, exit: 3 }];
  const started = Date.now();
  const result = run(sandbox, WRITE.concat("go"), scenario({ turns: [{ chunks: ["waiting"], after }] }));
  assert.equal(result.status, 1, result.stdout);
  assert.ok(Date.now() - started < 15000);
  assert.match(result.stdout, /agy exited/);
});

test("a review ends at its first end_turn and does not wait for the session to go quiet", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const started = Date.now();
  const result = run(sandbox, ["review", "--wait"], { ...scenario({ turns: [{ chunks: [JSON.stringify(FINDINGS)], after: [{ delayMs: 5000, chunk: "late" }] }] }), AGENT_BRIDGES_ACP_SETTLE_MS: "20000" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 10000);
  assert.match(result.stdout, /a\.js/);
});

test("a bookkeeping failure after spawn fails the run and ends agy", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, WRITE.concat("go"), { AGENT_BRIDGES_TEST_THROW_ON_SPAWN: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /test hook/);
  const [session] = sessions(sandbox);
  assert.deepEqual(promptTexts(session), []);
  assert.throws(() => process.kill(session.pid, 0));
  assert.equal(jobStatus(sandbox, lastJob(sandbox).id).status, "failed");
});

test("a descendant that keeps agy's output open does not keep the companion alive", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  t.after(() => {
    try {
      process.kill(JSON.parse(fs.readFileSync(sandbox.pidfile, "utf8")).holderPid, "SIGKILL");
    } catch {}
  });
  const started = Date.now();
  const result = run(sandbox, WRITE.concat("go"), scenario({ turns: [{ holdStdout: true, chunks: ["held"] }] }), { timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /held/);
  assert.ok(Date.now() - started < 15000, String(Date.now() - started));
});

test("a relative PLUGIN_DATA with --cwd elsewhere gives agy an absolute reader folder", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "--cwd", sandbox.repo, "look"], { PLUGIN_DATA: "rel-data" }, { cwd: sandbox.dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [session] = sessions(sandbox);
  const addDir = session.argv[session.argv.indexOf("--add-dir") + 1];
  assert.ok(path.isAbsolute(addDir), addDir);
  assert.ok(addDir.startsWith(path.join(sandbox.dir, "rel-data")), addDir);
});

test("a companion loaded from a workspace's .agents/plugins keeps its state outside the workspace", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  // An Antigravity workspace install: the plugin copied into <workspace>/.agents/plugins/antigravity.
  const copy = path.join(sandbox.repo, ".agents/plugins/antigravity");
  for (const dir of ["scripts", "prompts", "schemas"]) fs.cpSync(path.join(root, "plugins/antigravity", dir), path.join(copy, dir), { recursive: true });
  const companion = path.join(copy, "scripts/antigravity-companion.mjs");
  const env = companionEnv(sandbox, { PLUGIN_DATA: undefined, CLAUDE_PLUGIN_DATA: path.join(sandbox.repo, "claude-data") });
  const runCopy = (args) => spawnSync(process.execPath, [companion, ...args], { cwd: sandbox.repo, env, encoding: "utf8" });
  const task = runCopy(["task", "--wait", "--json", "look"]);
  assert.equal(task.status, 0, task.stdout + task.stderr);
  const stateRoot = path.join(sandbox.dir, ".antigravity-companion", "state");
  const [workspace] = fs.readdirSync(stateRoot);
  assert.equal(fs.readdirSync(path.join(stateRoot, workspace, "jobs")).length > 0, true);
  assert.deepEqual(fs.readdirSync(sandbox.repo).sort(), [".agents", ".git", "f0.txt"]);
  assert.deepEqual(fs.readdirSync(path.join(sandbox.repo, ".agents/plugins/antigravity")).sort(), ["prompts", "schemas", "scripts"]);
  const status = runCopy(["status", "--all", "--json"]);
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "completed", status.stdout);
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

function readerDirs(sandbox) {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("reader-")) found.push(path.join(dir, entry.name));
      else walk(path.join(dir, entry.name));
    }
  };
  walk(sandbox.data);
  return found;
}

test("cancel ends a background agy and its child, and removes the reader", { skip: LINUX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const started = JSON.parse(run(sandbox, ["task", "--background", "--json", "hi"], { FAKE_AGY_SLEEP_MS: "30000" }).stdout);
  assert.ok(await waitFor(() => readPids(sandbox)));
  const { pid, childPid } = readPids(sandbox);
  assert.equal(readerDirs(sandbox).length, 1);
  assert.equal(run(sandbox, ["cancel", started.jobId]).status, 0);
  assert.ok(await waitFor(() => !pidAlive(pid) && !pidAlive(childPid)), "agy or its child survived cancel");
  assert.equal(jobStatus(sandbox, started.jobId).status, "cancelled");
  assert.deepEqual(readerDirs(sandbox), []);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(jobStatus(sandbox, started.jobId).status, "cancelled");
});

test("a job whose worker died without an end state is failed by status, and its agy is ended", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  // ignoreEof: agy outlives the dead worker, so ending it is status's work.
  const companion = startCompanion(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_SLEEP_MS: "30000", ...scenario({ ignoreEof: true }) });
  t.after(() => companion.kill("SIGKILL"));
  assert.ok(await waitFor(() => readPids(sandbox)));
  const { pid: agyPid } = readPids(sandbox);
  const job = lastJob(sandbox);
  assert.equal(job.status, "running");
  // SIGKILL: the worker gets no chance to record an end state.
  companion.kill("SIGKILL");
  assert.ok(await waitFor(() => !pidAlive(companion.pid)));
  t.after(() => { try { process.kill(agyPid, "SIGKILL"); } catch {} });
  assert.equal(pidAlive(agyPid), true);
  const waited = run(sandbox, ["status", job.id, "--wait", "--json"]);
  assert.equal(waited.status, 0, waited.stderr);
  const failed = JSON.parse(waited.stdout).job;
  assert.equal(failed.status, "failed");
  assert.match(failed.errorMessage, /ended without recording a result/);
  // Only Linux records a start time that proves the pid is still this agy; elsewhere it is never signalled.
  if (process.platform === "linux") assert.ok(await waitFor(() => !pidAlive(agyPid)), "the orphaned agy outlived its dead worker");
  else assert.match(failed.errorMessage, /not signalled/);
  assert.match(run(sandbox, ["result", job.id]).stdout, /ended without recording a result/);
});

/** The one workspace state folder of a sandbox, and a way to rewrite a job in both its file and the index. */
function stateDirOf(sandbox) {
  const stateRoot = path.join(sandbox.data, "state");
  return path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
}

function rewriteJob(sandbox, id, patch, { index = true, file = true } = {}) {
  const dir = stateDirOf(sandbox);
  const jobFile = path.join(dir, "jobs", `${id}.json`);
  if (file) fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, "utf8")), ...patch }));
  if (index) {
    const stateFile = path.join(dir, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.jobs = state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job));
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
}

/** The job file as written, without running status (which would reconcile it). */
function jobRecord(sandbox, id) {
  return JSON.parse(fs.readFileSync(path.join(stateDirOf(sandbox), "jobs", `${id}.json`), "utf8"));
}

function indexEntry(sandbox, id) {
  return JSON.parse(fs.readFileSync(path.join(stateDirOf(sandbox), "state.json"), "utf8")).jobs.find((job) => job.id === id);
}

/** A foreground task whose companion was SIGKILLed while agy kept running: a job with a dead worker. */
async function deadWorkerJob(t, sandbox, fake = {}) {
  // ignoreEof: like a real server, agy outlives its client's end of input, so the dead worker leaves it behind.
  const companion = startCompanion(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_SLEEP_MS: "30000", ...scenario({ ignoreEof: true, ...fake }) });
  t.after(() => companion.kill("SIGKILL"));
  assert.ok(await waitFor(() => readPids(sandbox)));
  const { pid: agyPid } = readPids(sandbox);
  t.after(() => { try { process.kill(agyPid, "SIGKILL"); } catch {} });
  const job = lastJob(sandbox);
  assert.equal(job.status, "running");
  companion.kill("SIGKILL");
  assert.ok(await waitFor(() => !pidAlive(companion.pid)));
  return { job, agyPid, workerPid: companion.pid };
}

function startStranger(t) {
  const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => stranger.kill("SIGKILL"));
  return stranger;
}

test("a dead worker's job records process start times, and a pid that now names another process is never signalled", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const { job, agyPid } = await deadWorkerJob(t, sandbox);
  const stored = jobRecord(sandbox, job.id);
  if (process.platform === "linux") {
    assert.equal(typeof stored.pidStart, "string", JSON.stringify(stored));
    assert.equal(typeof stored.agyPidStart, "string", JSON.stringify(stored));
  }
  assert.equal(pidAlive(agyPid), true);
  process.kill(agyPid, "SIGKILL");
  // After a reboot or pid reuse: the recorded agy pid (and the worker pid) now belong to an unrelated process.
  const stranger = startStranger(t);
  const reused = { agyPid: stranger.pid, ...(process.platform === "linux" ? {} : { agyPidStart: undefined }) };
  rewriteJob(sandbox, job.id, reused);
  const failed = JSON.parse(run(sandbox, ["status", job.id, "--wait", "--timeout-ms", "3000", "--json"]).stdout).job;
  assert.equal(failed.status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pidAlive(stranger.pid), true, "status signalled a process it could not prove was the job's");
});

test("a recorded worker pid reused by another process reads as dead, and an old record without start times sends no signal", { skip: process.platform === "linux" ? false : "needs /proc" }, async (t) => {
  const sandbox = makeSandbox(t);
  const { job, agyPid } = await deadWorkerJob(t, sandbox);
  const stranger = startStranger(t);
  // The worker pid now names a live stranger with another start time.
  rewriteJob(sandbox, job.id, { pid: stranger.pid });
  assert.equal(JSON.parse(run(sandbox, ["status", job.id, "--wait", "--timeout-ms", "3000", "--json"]).stdout).job.status, "failed");
  assert.equal(pidAlive(stranger.pid), true);
  // An old record: no start times at all. The job still fails, and the live agy is left alone.
  const sandbox2 = makeSandbox(t);
  const second = await deadWorkerJob(t, sandbox2);
  rewriteJob(sandbox2, second.job.id, { pidStart: undefined, agyPidStart: undefined });
  const failed = JSON.parse(run(sandbox2, ["status", second.job.id, "--json"]).stdout).job;
  assert.equal(failed.status, "failed");
  assert.match(failed.errorMessage, /not signalled/);
  assert.equal(pidAlive(second.agyPid), true, "an agy that could not be confirmed was signalled");
  void agyPid;
});

test("a zombie worker counts as dead", { skip: process.platform === "linux" ? false : "needs /proc" }, async (t) => {
  const sandbox = makeSandbox(t);
  // The companion's parent becomes `sleep`, which never reaps it: killed, it stays a zombie.
  const holder = spawn("sh", ["-c", `"${process.execPath}" "${COMPANION}" task --wait hi & exec sleep 60`], {
    cwd: sandbox.repo, env: companionEnv(sandbox, { FAKE_AGY_SLEEP_MS: "30000" }), stdio: "ignore"
  });
  t.after(() => holder.kill("SIGKILL"));
  assert.ok(await waitFor(() => readPids(sandbox)));
  t.after(() => { try { process.kill(readPids(sandbox).pid, "SIGKILL"); } catch {} });
  const job = lastJob(sandbox);
  const workerPid = jobRecord(sandbox, job.id).pid;
  process.kill(workerPid, "SIGKILL");
  assert.ok(await waitFor(() => fs.readFileSync(`/proc/${workerPid}/stat`, "utf8").split(") ")[1][0] === "Z"));
  const result = JSON.parse(run(sandbox, ["status", job.id, "--wait", "--timeout-ms", "3000", "--json"]).stdout).job;
  assert.equal(result.status, "failed");
});

test("an unreadable job record is skipped, not a crash, and status --all lists the other jobs", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "first"]).status, 0);
  const { job } = await deadWorkerJob(t, sandbox);
  fs.writeFileSync(path.join(stateDirOf(sandbox), "jobs", `${job.id}.json`), "{\"id\": ");
  const all = run(sandbox, ["status", "--all", "--json"]);
  assert.equal(all.status, 0, all.stderr);
  const report = JSON.parse(all.stdout);
  assert.equal(report.running.length, 1);
  assert.equal(report.latestFinished.status, "completed");
  const single = run(sandbox, ["status", job.id, "--json"]);
  assert.equal(single.status, 0, single.stderr);
  assert.equal(JSON.parse(single.stdout).job.status, "running");
});

test("writeJobFile writes a temporary file in the same folder and renames it into place", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-atomic-"));
  const previous = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const state = await import("../plugins/antigravity/scripts/lib/state.mjs");
  const renames = t.mock.method(fs, "renameSync");
  const jobFile = state.writeJobFile(dir, "job-1", { id: "job-1" });
  const call = renames.mock.calls.find((c) => c.arguments[1] === jobFile);
  assert.ok(call, "no rename into the job file");
  assert.equal(path.dirname(call.arguments[0]), path.dirname(jobFile));
  assert.deepEqual(fs.readdirSync(path.dirname(jobFile)), ["job-1.json"]);
  assert.deepEqual(state.readJobFile(jobFile), { id: "job-1" });
});

test("a cancel during a dead worker's teardown wins over the failed state", { skip: LINUX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  // agy ignores SIGTERM, so ending it takes the 2 s grace: cancel lands in that window.
  const { job } = await deadWorkerJob(t, sandbox, { ignoreTerm: true });
  const status = spawn(process.execPath, [COMPANION, "status", job.id, "--json"], { cwd: sandbox.repo, env: companionEnv(sandbox), stdio: "ignore" });
  const done = new Promise((resolve) => status.on("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 600));
  run(sandbox, ["cancel", job.id]);
  await done;
  assert.equal(jobStatus(sandbox, job.id).status, "cancelled");
  assert.equal(indexEntry(sandbox, job.id).status, "cancelled");
});

test("status --all shows the reconciled record and repairs a stale index entry", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "hi"]).status, 0);
  const job = lastJob(sandbox);
  // The index still says running (a write that stopped between the job file and state.json).
  rewriteJob(sandbox, job.id, { status: "running", phase: "running", pid: 999999 }, { file: false });
  const report = JSON.parse(run(sandbox, ["status", "--all", "--json"]).stdout);
  assert.equal(report.running.length, 0, JSON.stringify(report));
  assert.equal(report.latestFinished.status, "completed");
  assert.equal(indexEntry(sandbox, job.id).status, "completed");
});

test("a relative PLUGIN_DATA reaches a background worker as an absolute path", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const env = { PLUGIN_DATA: "rel-data" };
  const started = run(sandbox, ["task", "--background", "--json", "--cwd", sandbox.repo, "look"], env, { cwd: sandbox.dir });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const { jobId } = JSON.parse(started.stdout);
  const waited = run(sandbox, ["status", jobId, "--wait", "--timeout-ms", "20000", "--json", "--cwd", sandbox.repo], env, { cwd: sandbox.dir });
  assert.equal(JSON.parse(waited.stdout).job.status, "completed", waited.stdout);
  assert.equal(fs.existsSync(path.join(sandbox.repo, "rel-data")), false, "the worker wrote its state inside the workspace");
});

test("cancel never signals a recorded pid that now names another process", { skip: process.platform === "linux" ? false : "needs /proc" }, async (t) => {
  const sandbox = makeSandbox(t);
  const companion = startCompanion(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_SLEEP_MS: "30000", ...scenario({ ignoreEof: true }) });
  t.after(() => companion.kill("SIGKILL"));
  assert.ok(await waitFor(() => readPids(sandbox)));
  const { pid: agyPid } = readPids(sandbox);
  t.after(() => { try { process.kill(agyPid, "SIGKILL"); } catch {} });
  const job = lastJob(sandbox);
  // Both recorded pids now name unrelated processes: their start times differ from the recorded ones.
  const workerStranger = startStranger(t);
  const agyStranger = startStranger(t);
  rewriteJob(sandbox, job.id, { pid: workerStranger.pid, agyPid: agyStranger.pid });
  const cancel = run(sandbox, ["cancel", job.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pidAlive(workerStranger.pid), true, "cancel signalled a reused worker pid");
  assert.equal(pidAlive(agyStranger.pid), true, "cancel signalled a reused agy pid");
  assert.equal(jobRecord(sandbox, job.id).status, "cancelled");
});

test("cancel with no start time to check signals nothing, records why, and names the live agy", { skip: process.platform === "linux" ? false : "needs /proc" }, async (t) => {
  const sandbox = makeSandbox(t);
  const companion = startCompanion(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_SLEEP_MS: "30000", ...scenario({ ignoreEof: true }) });
  t.after(() => companion.kill("SIGKILL"));
  assert.ok(await waitFor(() => readPids(sandbox)));
  const { pid: agyPid } = readPids(sandbox);
  t.after(() => { try { process.kill(agyPid, "SIGKILL"); } catch {} });
  const job = lastJob(sandbox);
  // A record from an older version: pids without start times.
  rewriteJob(sandbox, job.id, { pidStart: undefined, agyPidStart: undefined });
  const cancel = run(sandbox, ["cancel", job.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, new RegExp(`\\b${agyPid}\\b`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pidAlive(agyPid), true, "cancel signalled an agy it could not verify");
  assert.equal(pidAlive(companion.pid), true, "cancel signalled a worker it could not verify");
  const record = jobRecord(sandbox, job.id);
  assert.equal(record.status, "cancelled");
  assert.match(record.errorMessage, /nothing was signalled|not signalled/);
});

test("cancel ends a foreground agy and its child", { skip: LINUX_ONLY }, async (t) => {
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
  test(`${signal} to the companion stops agy and its child, after a session/cancel`, { skip: POSIX_ONLY }, async (t) => {
    const sandbox = makeSandbox(t);
    const companion = startCompanion(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_SLEEP_MS: "30000" });
    t.after(() => companion.kill("SIGKILL"));
    assert.ok(await waitFor(() => readPids(sandbox)));
    const { pid, childPid } = readPids(sandbox);
    companion.kill(signal);
    assert.ok(await waitFor(() => !pidAlive(pid) && !pidAlive(childPid)), `agy or its child survived ${signal}`);
    assert.equal(requests(sessions(sandbox)[0], "session/cancel").length, 1);
    // The companion removes its reader right after the tree is gone.
    assert.ok(await waitFor(() => readerDirs(sandbox).length === 0), "the reader folder survived the signal");
  });
}

test("SIGINT leaves the job in a terminal state, not running", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const companion = startCompanion(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_SLEEP_MS: "30000" });
  t.after(() => companion.kill("SIGKILL"));
  assert.ok(await waitFor(() => readPids(sandbox)));
  const job = lastJob(sandbox);
  companion.kill("SIGINT");
  assert.ok(await waitFor(() => !["running", "queued"].includes(jobStatus(sandbox, job.id).status)), "job stayed running");
});

test("cancel escalates when agy's child ignores SIGTERM", { skip: LINUX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const started = JSON.parse(run(sandbox, ["task", "--background", "--json", "hi"], { FAKE_AGY_SLEEP_MS: "30000", FAKE_AGY_CHILD_IGNORES_TERM: "1" }).stdout);
  assert.ok(await waitFor(() => readPids(sandbox)));
  const { childPid } = readPids(sandbox);
  assert.equal(run(sandbox, ["cancel", started.jobId]).status, 0);
  assert.ok(await waitFor(() => !pidAlive(childPid)), "a SIGTERM-ignoring child survived cancel");
});

test("Ctrl-C on a foreground task escalates to SIGKILL for a child that ignores SIGTERM", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const companion = startCompanion(sandbox, ["task", "--wait", "hi"], { FAKE_AGY_SLEEP_MS: "30000", FAKE_AGY_CHILD_IGNORES_TERM: "1" });
  t.after(() => companion.kill("SIGKILL"));
  assert.ok(await waitFor(() => readPids(sandbox)));
  const { childPid } = readPids(sandbox);
  t.after(() => { try { process.kill(childPid, "SIGKILL"); } catch {} });
  const exited = new Promise((resolve) => companion.once("exit", (code, signal) => resolve({ code, signal })));
  companion.kill("SIGINT");
  const { code } = await exited;
  assert.equal(code, 130);
  assert.equal(pidAlive(childPid), false, "a SIGTERM-resistant child outlived the interrupted companion");
});

test("the delegate skill triggers only on an explicit Antigravity request", () => {
  const body = fs.readFileSync(path.join(root, "plugins/antigravity/skills/antigravity-delegate/SKILL.md"), "utf8");
  const description = body.match(/^description:\s*(.*)$/m)?.[1] ?? "";
  assert.match(description, /\/antigravity:delegate/);
  assert.match(description, /delegate this to antigravity/);
  assert.match(description, /Never auto-trigger/);
  assert.match(body, /--background --fresh --write/);
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
  const before = sessions(sandbox).length;
  run(sandbox, ["run-worker", "--job-id", seed.id]);
  assert.equal(sessions(sandbox).length, before);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).status, "cancelled");
});

function markerFile(sandbox, id) {
  return stateJobFile(sandbox, id).replace(/\.json$/, ".cancelled");
}

test("a cancel marker wins: a worker never starts agy and never overwrites the cancellation", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "seed"]).status, 0);
  const seed = lastJob(sandbox);
  const file = stateJobFile(sandbox, seed.id);
  const job = JSON.parse(fs.readFileSync(file, "utf8"));
  // The record still says queued (a worker's write landed after cancel's), but the marker exists.
  fs.writeFileSync(file, JSON.stringify({ ...job, status: "queued", phase: "queued", request: { cwd: sandbox.repo, prompt: "x", write: false, review: false } }));
  fs.writeFileSync(markerFile(sandbox, seed.id), "");
  const before = sessions(sandbox).length;
  run(sandbox, ["run-worker", "--job-id", seed.id]);
  assert.equal(sessions(sandbox).length, before);
  assert.notEqual(JSON.parse(fs.readFileSync(file, "utf8")).status, "completed");
});

test("cancel creates the marker, and a job left cancelling keeps its handles and is retried by a second cancel", { skip: LINUX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const started = JSON.parse(run(sandbox, ["task", "--background", "--json", "hi"], { FAKE_AGY_SLEEP_MS: "30000" }).stdout);
  assert.ok(await waitFor(() => readPids(sandbox)));
  assert.equal(run(sandbox, ["cancel", started.jobId]).status, 0);
  assert.ok(fs.existsSync(markerFile(sandbox, started.jobId)));
  // A teardown that was interrupted: the record is cancelling, with a live process group and a reader folder.
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-sleeper.pid, "SIGKILL"); } catch {} });
  const file = stateJobFile(sandbox, started.jobId);
  const readers = path.join(path.dirname(path.dirname(file)), "readers");
  const readerDir = path.join(readers, "reader-left");
  fs.mkdirSync(readerDir, { recursive: true });
  fs.writeFileSync(path.join(readerDir, ".agent-bridges-reader"), "");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...record, status: "cancelling", phase: "cancelling", agyPid: sleeper.pid, agyPidStart: procStart(sleeper.pid), pid: null, readerDir }));
  const stateFile = path.join(path.dirname(path.dirname(file)), "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.jobs = state.jobs.map((entry) => (entry.id === started.jobId ? { ...entry, status: "cancelling" } : entry));
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.equal(run(sandbox, ["cancel", started.jobId]).status, 0);
  assert.ok(await waitFor(() => !pidAlive(sleeper.pid)), "the retried cancel did not end the process group");
  assert.equal(fs.existsSync(readerDir), false);
  assert.equal(jobStatus(sandbox, started.jobId).status, "cancelled");
});

test("a signal during a turn that then finishes is never stored or printed as a success", { skip: POSIX_ONLY }, async (t) => {
  const sandbox = makeSandbox(t);
  const companion = spawn(process.execPath, [COMPANION, ...WRITE.concat("go")], {
    cwd: sandbox.repo,
    env: companionEnv(sandbox, { FAKE_AGY_SLEEP_MS: "30000", ...scenario({ answerOnCancel: true }) }),
    stdio: ["ignore", "pipe", "ignore"]
  });
  t.after(() => companion.kill("SIGKILL"));
  let stdout = "";
  companion.stdout.on("data", (chunk) => { stdout += chunk; });
  assert.ok(await waitFor(() => readPids(sandbox)));
  const job = lastJob(sandbox);
  const exited = new Promise((resolve) => companion.once("exit", resolve));
  companion.kill("SIGTERM");
  await exited;
  assert.doesNotMatch(stdout, /LATE SUCCESS/);
  const stored = jobStatus(sandbox, job.id);
  assert.equal(stored.status, "failed");
});

test("a worker replays a read-only job as the restricted reader", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "seed"]).status, 0);
  const seed = lastJob(sandbox);
  const file = stateJobFile(sandbox, seed.id);
  const job = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...job, status: "queued", write: false, request: { cwd: sandbox.repo, prompt: "x", review: false, write: true } }));
  run(sandbox, ["run-worker", "--job-id", seed.id]);
  const last = sessions(sandbox).at(-1);
  assert.ok(last.argv.includes("--agent"));
});

test("background write runs keep the write permission through the worker", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const source = path.join(sandbox.dir, "source.jsonl");
  fs.writeFileSync(source, `${JSON.stringify({ type: "user", message: { role: "user", content: "explicit" } })}\n`);
  const task = JSON.parse(run(sandbox, ["task", "--background", "--write", "--bypass-permissions", "--json", "P"]).stdout);
  run(sandbox, ["status", task.jobId, "--wait"]);
  const transfer = JSON.parse(run(sandbox, ["transfer", "--write", "--bypass-permissions", "--json", "--source", source]).stdout);
  run(sandbox, ["status", transfer.jobId, "--wait"]);
  const readOnly = JSON.parse(run(sandbox, ["task", "--background", "--json", "P"]).stdout);
  run(sandbox, ["status", readOnly.jobId, "--wait"]);
  const list = sessions(sandbox);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0].argv, ["acp"]);
  assert.deepEqual(list[1].argv, ["acp"]);
  assert.ok(list[2].argv.includes("--agent"));
});
