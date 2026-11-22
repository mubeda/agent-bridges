import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { formatDeniedActions } from "../plugins/antigravity/scripts/lib/agy.mjs";
import { spawn } from "node:child_process";

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
    assert.match(notice[0], /Files not shown: f1\.txt, f2\.txt\./);
    assert.match(promptTexts(sessions(sandbox)[0])[1], /Files not shown: f1\.txt, f2\.txt\./);
    const expected = { truncated: true, maxBytes: 262144, filesNotShown: ["f1.txt", "f2.txt"] };
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

test("cancel ends a background agy and its child, and removes the reader", { skip: POSIX_ONLY }, async (t) => {
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

test("cancel escalates when agy's child ignores SIGTERM", { skip: POSIX_ONLY }, async (t) => {
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

test("cancel creates the marker, and a job left cancelling keeps its handles and is retried by a second cancel", { skip: POSIX_ONLY }, async (t) => {
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
  fs.writeFileSync(file, JSON.stringify({ ...record, status: "cancelling", phase: "cancelling", agyPid: sleeper.pid, pid: null, readerDir }));
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
