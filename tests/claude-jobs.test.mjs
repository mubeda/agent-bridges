import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeSpawnOptions,
  refreshJobFromAgentsJson
} from "../plugins/claude/scripts/lib/claude.mjs";

test("Claude prompts are spawned without a shell", () => {
  const options = buildClaudeSpawnOptions("C:/repo", { PATH: "test" });
  assert.equal(options.shell, false);
  assert.equal(options.cwd, "C:/repo");
});

test("refreshJobFromAgentsJson keeps blocked job waiting details", () => {
  const job = {
    id: "task-1",
    invoke: "bg",
    shortId: "7c5dcf5d",
    status: "running",
    worktree: null
  };
  const stdout = JSON.stringify([
    {
      id: "7c5dcf5d",
      state: "blocked",
      waitingFor: "permission approval",
      cwd: "C:/repo/.claude/worktrees/task-1",
      pid: 1234
    }
  ]);

  assert.deepEqual(refreshJobFromAgentsJson(job, stdout), {
    ...job,
    status: "blocked",
    waitingFor: "permission approval",
    worktree: "C:/repo/.claude/worktrees/task-1",
    pid: 1234
  });
});

test("refreshJobFromAgentsJson explains a missing session", () => {
  const job = { id: "task-1", shortId: "missing", status: "running" };
  assert.deepEqual(refreshJobFromAgentsJson(job, "[]"), {
    ...job,
    summary: "Claude session not listed in `claude agents --json`."
  });
});

test("refreshJobFromAgentsJson ignores leading noise", () => {
  const job = { id: "task-1", shortId: "7c5dcf5d", status: "running", worktree: null };
  const stdout = `Claude agents\n${JSON.stringify([
    { id: "7c5dcf5d", state: "working", cwd: "C:/repo/.claude/worktrees/task-1" }
  ])}`;

  assert.equal(refreshJobFromAgentsJson(job, stdout).worktree, "C:/repo/.claude/worktrees/task-1");
});

test("refreshJobFromAgentsJson tolerates malformed and non-array JSON", () => {
  const job = { id: "task-1", shortId: "7c5dcf5d", status: "running" };

  assert.doesNotThrow(() => refreshJobFromAgentsJson(job, "not json"));
  assert.doesNotThrow(() => refreshJobFromAgentsJson(job, '{"id":"7c5dcf5d"}'));
  assert.match(refreshJobFromAgentsJson(job, "not json").summary, /agents JSON/i);
});
