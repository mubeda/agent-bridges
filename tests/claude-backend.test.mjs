import assert from "node:assert/strict";
import test from "node:test";
import {
  agentsStateToJobStatus,
  getBypassDisclaimerStatus,
  mapAgentsSession,
  parseBgShortId,
  parsePrintResult
} from "../plugins/claude/scripts/lib/claude.mjs";

test("parsePrintResult reads session_id, result, structured_output", () => {
  const parsed = parsePrintResult(
    JSON.stringify({
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      result: "looks good",
      structured_output: { verdict: "approve" }
    })
  );
  assert.equal(parsed.sessionId, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(parsed.resultText, "looks good");
  assert.equal(parsed.structuredOutput.verdict, "approve");
});

test("parsePrintResult ignores leading noise then reads JSON", () => {
  const parsed = parsePrintResult(`Starting…\n{"result":"ok","session_id":"abc"}`);
  assert.equal(parsed.sessionId, "abc");
  assert.equal(parsed.resultText, "ok");
});

test("parseBgShortId reads attach command and bare id", () => {
  const fromCmd = parseBgShortId("Starting background service…\nclaude attach 7c5dcf5d\nclaude logs 7c5dcf5d\n");
  assert.equal(fromCmd, "7c5dcf5d");
  const fromBare = parseBgShortId("7c5dcf5d\n");
  assert.equal(fromBare, "7c5dcf5d");
});

test("mapAgentsSession and status mapping", () => {
  const mapped = mapAgentsSession({
    id: "7c5dcf5d",
    state: "blocked",
    waitingFor: "permission prompt",
    cwd: "/repo/.claude/worktrees/job",
    pid: 42
  });
  assert.equal(mapped.shortId, "7c5dcf5d");
  assert.equal(mapped.waitingFor, "permission prompt");
  assert.equal(mapped.cwd, "/repo/.claude/worktrees/job");
  assert.equal(agentsStateToJobStatus("working"), "running");
  assert.equal(agentsStateToJobStatus("blocked"), "blocked");
  assert.equal(agentsStateToJobStatus("done"), "completed");
  assert.equal(agentsStateToJobStatus("failed"), "failed");
  assert.equal(agentsStateToJobStatus("stopped"), "cancelled");
});

test("getBypassDisclaimerStatus finds a nested bypass flag", () => {
  const home = "/tmp/fake-home";
  const result = getBypassDisclaimerStatus({
    home,
    existsSync: (p) => String(p).endsWith(".claude.json"),
    readFileSync: () => JSON.stringify({ permissions: { bypassPermissionsAccepted: true } })
  });
  assert.equal(result.accepted, true);
});

test("getBypassDisclaimerStatus is false when files are missing", () => {
  const result = getBypassDisclaimerStatus({
    home: "/tmp/missing",
    existsSync: () => false,
    readFileSync: () => {
      throw new Error("should not read");
    }
  });
  assert.equal(result.accepted, false);
  assert.match(result.detail, /dangerously-skip-permissions/);
});
