import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PACKED_TRANSCRIPT_LIMIT,
  TRANSCRIPT_PATH_ENV as GEMINI_TRANSCRIPT_PATH_ENV,
  capTranscriptMessages,
  claudeProjectDirName,
  packTranscript,
  parseTranscriptJsonl,
  resolveTransferSource
} from "../plugins/gemini/scripts/lib/host-session.mjs";
import {
  TRANSCRIPT_PATH_ENV as CLAUDE_TRANSCRIPT_PATH_ENV,
  resolveTransferSource as resolveClaudeTransferSource
} from "../plugins/claude/scripts/lib/host-session.mjs";
import { TRANSCRIPT_PATH_ENV as OPENCODE_TRANSCRIPT_PATH_ENV } from "../plugins/opencode/scripts/lib/host-session.mjs";
import { TRANSCRIPT_PATH_ENV as CURSOR_TRANSCRIPT_PATH_ENV } from "../plugins/cursor/scripts/lib/host-session.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureRoot = path.join(repoRoot, "tests", ".tmp", "host-session");
const workspaceRoot = path.join(fixtureRoot, "workspace");

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function setMtime(filePath, epochSeconds) {
  const when = new Date(epochSeconds * 1000);
  fs.utimesSync(filePath, when, when);
}

function cursorProjectDirName(cwd) {
  return path.resolve(cwd).replace(/\\/g, "/").replace(/:/g, "").replace(/\//g, "-");
}

function resetFixtures() {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const home = path.join(fixtureRoot, "home");
  const claudeDir = path.join(home, ".claude", "projects", claudeProjectDirName(workspaceRoot));
  const codexDir = path.join(home, ".codex", "sessions", "2026", "08", "19");
  const cursorDir = path.join(
    home,
    ".cursor",
    "projects",
    cursorProjectDirName(workspaceRoot),
    "agent-transcripts",
    "session-a"
  );

  const claudeFile = path.join(claudeDir, "claude-session.jsonl");
  const claudeOlder = path.join(claudeDir, "claude-older.jsonl");
  const codexFile = path.join(codexDir, "rollout-2026-08-19T10-00-00-codex.jsonl");
  const cursorFile = path.join(cursorDir, "cursor-session.jsonl");
  const explicitFile = path.join(fixtureRoot, "explicit-source.jsonl");

  writeFile(
    claudeFile,
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "claude hello" }
    })}\n${JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "claude reply" }] }
    })}\n`
  );
  writeFile(
    claudeOlder,
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "older claude" }
    })}\n`
  );
  writeFile(
    codexFile,
    `${JSON.stringify({
      timestamp: "2026-08-19T10:00:00.000Z",
      type: "session_meta",
      payload: { cwd: workspaceRoot, session_id: "codex-1" }
    })}\n${JSON.stringify({
      timestamp: "2026-08-19T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "codex hello" }]
      }
    })}\n`
  );
  writeFile(
    cursorFile,
    `${JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "cursor hello" }] }
    })}\n${JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text: "cursor reply" }] }
    })}\n`
  );
  writeFile(
    explicitFile,
    `${JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "explicit hello" }] }
    })}\n`
  );

  // Codex newest overall; within Claude, claudeFile is newer than claudeOlder.
  setMtime(claudeOlder, 1_700_000_000);
  setMtime(claudeFile, 1_700_000_050);
  setMtime(cursorFile, 1_700_000_100);
  setMtime(codexFile, 1_700_000_200);
  setMtime(explicitFile, 1_700_000_300);

  return { home, claudeFile, claudeOlder, codexFile, cursorFile, explicitFile };
}

test("OpenCode TRANSCRIPT_PATH_ENV is OPENCODE_COMPANION_TRANSCRIPT_PATH", () => {
  assert.equal(GEMINI_TRANSCRIPT_PATH_ENV, "GEMINI_COMPANION_TRANSCRIPT_PATH");
  assert.equal(OPENCODE_TRANSCRIPT_PATH_ENV, "OPENCODE_COMPANION_TRANSCRIPT_PATH");
});

test("Claude companion TRANSCRIPT_PATH_ENV is CLAUDE_COMPANION_TRANSCRIPT_PATH", () => {
  assert.equal(CLAUDE_TRANSCRIPT_PATH_ENV, "CLAUDE_COMPANION_TRANSCRIPT_PATH");
});

test("Cursor companion TRANSCRIPT_PATH_ENV is CURSOR_COMPANION_TRANSCRIPT_PATH", () => {
  assert.equal(CURSOR_TRANSCRIPT_PATH_ENV, "CURSOR_COMPANION_TRANSCRIPT_PATH");
});

test("Claude companion prefers Codex over a newer Claude file", () => {
  const { home } = resetFixtures();
  const resolved = resolveClaudeTransferSource(workspaceRoot, { home, env: {} });
  assert.equal(resolved.host, "codex");
});

test("--source wins over env and auto-detect", () => {
  const { home, claudeFile, explicitFile } = resetFixtures();
  const resolved = resolveTransferSource(workspaceRoot, {
    source: explicitFile,
    home,
    env: { [GEMINI_TRANSCRIPT_PATH_ENV]: claudeFile }
  });
  assert.equal(resolved.host, "explicit");
  assert.equal(resolved.path, explicitFile);
});

test("env transcript path wins when --source is omitted", () => {
  const { home, cursorFile, explicitFile } = resetFixtures();
  const resolved = resolveTransferSource(workspaceRoot, {
    home,
    env: { [GEMINI_TRANSCRIPT_PATH_ENV]: explicitFile }
  });
  assert.equal(resolved.host, "explicit");
  assert.equal(resolved.path, explicitFile);
  assert.notEqual(resolved.path, cursorFile);
});

test("prefers Claude when Claude files exist even if Codex is newer", () => {
  const { home, claudeFile } = resetFixtures();
  const resolved = resolveTransferSource(workspaceRoot, { home, env: {} });
  assert.equal(resolved.host, "claude");
  assert.equal(resolved.path, claudeFile);
});

test("picks newest file within the preferred host", () => {
  const { home, claudeFile, claudeOlder } = resetFixtures();
  const resolved = resolveTransferSource(workspaceRoot, { home, env: {} });
  assert.equal(resolved.path, claudeFile);
  assert.notEqual(resolved.path, claudeOlder);
});

test("when Claude is absent, prefers Codex sessions over a newer Cursor file", () => {
  const { home, codexFile, cursorFile, claudeFile, claudeOlder } = resetFixtures();
  fs.rmSync(claudeFile, { force: true });
  fs.rmSync(claudeOlder, { force: true });
  setMtime(cursorFile, 1_700_000_500);
  setMtime(codexFile, 1_700_000_200);

  const resolved = resolveTransferSource(workspaceRoot, { home, env: {} });
  assert.equal(resolved.host, "codex");
  assert.equal(resolved.path, codexFile);
});

test("newest among hosts when only Cursor remains", () => {
  const { home, cursorFile, claudeFile, claudeOlder, codexFile } = resetFixtures();
  fs.rmSync(claudeFile, { force: true });
  fs.rmSync(claudeOlder, { force: true });
  fs.rmSync(codexFile, { force: true });
  fs.rmSync(path.join(home, ".codex"), { recursive: true, force: true });

  const resolved = resolveTransferSource(workspaceRoot, { home, env: {} });
  assert.equal(resolved.host, "cursor");
  assert.equal(resolved.path, cursorFile);
});

test("parseTranscriptJsonl reads Claude, Codex, and Cursor shapes", () => {
  const { claudeFile, codexFile, cursorFile } = resetFixtures();
  assert.deepEqual(parseTranscriptJsonl(claudeFile), [
    { role: "user", text: "claude hello" },
    { role: "assistant", text: "claude reply" }
  ]);
  assert.deepEqual(parseTranscriptJsonl(codexFile), [{ role: "user", text: "codex hello" }]);
  assert.deepEqual(parseTranscriptJsonl(cursorFile), [
    { role: "user", text: "cursor hello" },
    { role: "assistant", text: "cursor reply" }
  ]);
});

test("claudeProjectDirName replaces dots (e.g. .worktrees) with dashes", () => {
  const name = claudeProjectDirName("X:/agent-bridges/.worktrees/feature");
  assert.equal(name.includes("."), false);
  assert.match(name, /worktrees/);
  assert.match(name, /agent-bridges/);
});

test("packTranscript truncates to PACKED_TRANSCRIPT_LIMIT keeping the tail", () => {
  assert.equal(PACKED_TRANSCRIPT_LIMIT, 100000);
  const messages = [
    { role: "user", text: "A".repeat(60_000) },
    { role: "assistant", text: "B".repeat(60_000) },
    { role: "user", text: "TAIL-MARKER" }
  ];
  const packed = packTranscript(messages);
  assert.ok(packed.length <= PACKED_TRANSCRIPT_LIMIT);
  assert.ok(packed.includes("TAIL-MARKER"));
  assert.equal(packed.includes("A".repeat(1000)), false);
  assert.match(packed, /Assistant: B+/);
  assert.ok(packed.endsWith("User: TAIL-MARKER"));
});

test("capTranscriptMessages drops oldest so packed size stays within limit", () => {
  const messages = [
    { role: "user", text: "A".repeat(60_000) },
    { role: "assistant", text: "B".repeat(60_000) },
    { role: "user", text: "TAIL-MARKER" }
  ];
  const capped = capTranscriptMessages(messages);
  const packed = packTranscript(capped);
  assert.ok(packed.length <= PACKED_TRANSCRIPT_LIMIT);
  assert.equal(packed, packTranscript(messages));
  assert.ok(capped.some((message) => message.text === "TAIL-MARKER"));
  assert.equal(
    capped.some((message) => message.text.includes("A".repeat(1000))),
    false
  );
});

// --- antigravity transfer (Task 1.7): private temp roots and a fake agy, never tests/.tmp ---
const AGY_COMPANION = path.join(repoRoot, "plugins/antigravity/scripts/antigravity-companion.mjs");
const AGY_POSIX_ONLY = process.platform === "win32" ? "fake agy needs a POSIX shebang" : false;
const AGY_FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
let stdin = "";
try { if (!process.stdin.isTTY) stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ argv, stdin }) + "\\n");
if (argv.includes("--version")) { process.stdout.write("1.5.12\\n"); process.exit(0); }
process.stdout.write('{"conversation_id":"C1","status":"SUCCESS","response":"ok","num_turns":1}');
`;

function agySandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-transfer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake-agy");
  fs.writeFileSync(fake, AGY_FAKE, { mode: 0o755 });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  return { dir, fake, repo, home: path.join(dir, "home"), data: path.join(dir, "data"), log: path.join(dir, "agy.log") };
}

function codexRollout(home, cwd, text, name = "rollout-2026-11-19T10-00-00-a.jsonl") {
  writeFile(
    path.join(home, ".codex", "sessions", "2026", "11", "19", name),
    `${JSON.stringify({ type: "session_meta", payload: { cwd, session_id: "x" } })}\n${JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] }
    })}\n`
  );
}

function runAgy(sandbox, args) {
  const env = { ...process.env, HOME: sandbox.home, USERPROFILE: sandbox.home, PLUGIN_DATA: sandbox.data, ANTIGRAVITY_BIN: sandbox.fake, FAKE_AGY_LOG: sandbox.log };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CODEX_HOME;
  delete env.ANTIGRAVITY_COMPANION_TRANSCRIPT_PATH;
  return spawnSync(process.execPath, [AGY_COMPANION, ...args], { cwd: sandbox.repo, env, encoding: "utf8" });
}

function agyModelCalls(sandbox) {
  if (!fs.existsSync(sandbox.log)) return [];
  return fs.readFileSync(sandbox.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !e.argv.includes("--version"));
}

test("antigravity transfer packs the matching Codex rollout and stores the conversation", { skip: AGY_POSIX_ONLY }, (t) => {
  const sandbox = agySandbox(t);
  codexRollout(sandbox.home, sandbox.repo, "matching codex text");
  const result = runAgy(sandbox, ["transfer", "--wait", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const calls = agyModelCalls(sandbox);
  assert.equal(calls.length, 1);
  assert.match(calls[0].argv[calls[0].argv.length - 1], /matching codex text/);
  assert.equal(JSON.parse(result.stdout).job.agySessionId, "C1");
});

test("antigravity transfer refuses a Codex rollout from another workspace", { skip: AGY_POSIX_ONLY }, (t) => {
  const sandbox = agySandbox(t);
  codexRollout(sandbox.home, path.join(sandbox.dir, "elsewhere"), "unrelated codex text");
  const result = runAgy(sandbox, ["transfer", "--wait"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--source/);
  assert.deepEqual(agyModelCalls(sandbox), []);
});

test("antigravity transfer prefers a local Claude transcript over an unrelated Codex rollout", { skip: AGY_POSIX_ONLY }, (t) => {
  const sandbox = agySandbox(t);
  codexRollout(sandbox.home, path.join(sandbox.dir, "elsewhere"), "unrelated codex text");
  writeFile(
    path.join(sandbox.home, ".claude", "projects", claudeProjectDirName(sandbox.repo), "s.jsonl"),
    `${JSON.stringify({ type: "user", message: { role: "user", content: "local claude text" } })}\n`
  );
  const result = runAgy(sandbox, ["transfer", "--wait"]);
  assert.equal(result.status, 0, result.stderr);
  const prompt = agyModelCalls(sandbox)[0].argv.at(-1);
  assert.match(prompt, /local claude text/);
  assert.doesNotMatch(prompt, /unrelated codex text/);
});

test("antigravity transfer --write auto-approves, and without it the run is read-only", { skip: AGY_POSIX_ONLY }, (t) => {
  const sandbox = agySandbox(t);
  const source = path.join(sandbox.dir, "source.jsonl");
  writeFile(source, `${JSON.stringify({ type: "user", message: { role: "user", content: "explicit" } })}\n`);
  assert.equal(runAgy(sandbox, ["transfer", "--wait", "--write", "--source", source]).status, 0);
  assert.equal(runAgy(sandbox, ["transfer", "--wait", "--source", source]).status, 0);
  const [write, readOnly] = agyModelCalls(sandbox);
  assert.equal(write.argv[0], "--dangerously-skip-permissions");
  assert.equal(readOnly.argv[0], "--settings");
});
