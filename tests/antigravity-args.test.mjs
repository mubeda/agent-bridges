import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EFFORT_LEVELS, validateEffort } from "../plugins/antigravity/scripts/lib/agy.mjs";
import { CLIENT_INFO, buildAcpArgs, createLineReader, startAcpRun } from "../plugins/antigravity/scripts/lib/acp.mjs";
import { parseArgs } from "../plugins/antigravity/scripts/lib/args.mjs";
import { isWithin } from "../plugins/antigravity/scripts/lib/fs.mjs";
import { collectIncludedFiles } from "../plugins/antigravity/scripts/lib/git.mjs";
import {
  POSIX_ONLY,
  jobFiles,
  lastJob,
  makeSandbox,
  promptTexts,
  requests,
  run,
  scenario,
  sessions
} from "./fixtures/acp-sandbox.mjs";

const TOKEN_PROMPT = "Reply with only your agent token.";

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

test("acp argv: a read-only run names the reader agent, a write run names none", () => {
  assert.deepEqual(buildAcpArgs({ agentDir: "/state/r1", agentName: "reader-x" }), ["acp", "--add-dir", "/state/r1", "--agent", "reader-x"]);
  assert.deepEqual(buildAcpArgs({}), ["acp"]);
});

test("the ACP client version follows the plugin version", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../plugins/antigravity/.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(CLIENT_INFO.version, manifest.version);
});

test("the line reader survives split lines and skips lines that are not JSON", () => {
  const seen = [];
  const feed = createLineReader((message) => seen.push(message));
  feed('{"a":');
  feed('1}\nnot json\n{"b":2}');
  feed("\n\n");
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
});

test("effort offers the server's four thinking levels and rejects max", () => {
  assert.deepEqual(EFFORT_LEVELS, ["low", "medium", "high", "xhigh"]);
  assert.throws(() => validateEffort("max"), /low, medium, high, xhigh/);
  assert.throws(() => validateEffort(""), /low, medium, high, xhigh/);
  assert.doesNotThrow(() => validateEffort("xhigh"));
});

test("a review starts the restricted reader, checks its token first, then sends the review", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["review", "--wait"]);
  assert.equal(result.status, 0, result.stderr);
  const [session] = sessions(sandbox);
  assert.equal(session.argv[0], "acp");
  const agentDir = flagValue(session.argv, "--add-dir");
  const agentName = flagValue(session.argv, "--agent");
  assert.ok(agentDir && agentName, session.argv.join(" "));
  assert.equal(session.argv.includes("--dangerously-skip-permissions"), false);
  // The reader lives in the bridge's state, never in the workspace, and is gone afterwards.
  assert.ok(path.relative(sandbox.repo, agentDir).startsWith(".."), agentDir);
  assert.ok(agentDir.startsWith(sandbox.data), agentDir);
  assert.equal(fs.existsSync(agentDir), false);
  const texts = promptTexts(session);
  assert.equal(texts[0], TOKEN_PROMPT);
  assert.match(texts[1], /Return only JSON matching this schema/);
  assert.deepEqual(requests(session, "session/new")[0].params, { cwd: sandbox.repo, mcpServers: [] });
});

test("a read-only task's reader agent file has no tools and carries the token", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "look"]).status, 0);
  const [session] = sessions(sandbox);
  const agentName = flagValue(session.argv, "--agent");
  const files = session.readerFiles;
  const manifestPath = Object.keys(files).find((file) => file.endsWith(path.join(".antigravity-plugin", "plugin.json")));
  const agentPath = Object.keys(files).find((file) => file.endsWith(path.join("agents", agentName, "agent.md")));
  assert.ok(manifestPath && agentPath, Object.keys(files).join(", "));
  assert.match(manifestPath, /^\.agents[\\/]plugins[\\/]/);
  const manifest = JSON.parse(files[manifestPath]);
  for (const key of ["name", "version", "description", "license"]) assert.equal(typeof manifest[key], "string", key);
  const agent = files[agentPath];
  assert.match(agent, new RegExp(`^---\\nname: ${agentName}\\n`));
  assert.match(agent, /^tools: \[\]\n---/m);
  assert.doesNotMatch(agent, /read_file|write_file|run_command/);
  const token = agent.match(/Your agent token is (\S+?)\./)[1];
  assert.ok(token.length >= 16);
  assert.ok(Object.keys(files).some((file) => file.endsWith(".agent-bridges-reader")), "the folder carries the ownership marker");
  // Each run gets a fresh token.
  run(sandbox, ["task", "--wait", "again"]);
  const second = sessions(sandbox)[1].readerFiles;
  assert.notEqual(Object.values(second).join(), Object.values(files).join());
});

test("a review's reader agent has no tools at all", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["review", "--wait"]).status, 0);
  const [session] = sessions(sandbox);
  const agentName = flagValue(session.argv, "--agent");
  const agent = Object.entries(session.readerFiles).find(([file]) => file.endsWith(path.join("agents", agentName, "agent.md")))[1];
  assert.match(agent, /^tools: \[\]\n---/m);
  assert.doesNotMatch(agent, /read_file/);
});

test("a read_file call fails a review and a read-only task alike", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  for (const args of [["review", "--wait"], ["task", "--wait", "look"]]) {
    const result = run(sandbox, args, scenario({ turns: [{ toolCall: "read_file", toolPath: path.join(sandbox.repo, "f0.txt"), chunks: ["looked"] }] }));
    assert.equal(result.status, 1, `${args[0]}: ${result.stdout}`);
    assert.match(result.stdout, /read_file/);
    assert.doesNotMatch(result.stdout, /looked/);
  }
});

for (const [label, args] of [["review", ["review", "--wait"]], ["read-only task", ["task", "--wait", "look"]]]) {
  test(`a tool call during the token check fails the ${label}, even with the right token`, { skip: POSIX_ONLY }, (t) => {
    const sandbox = makeSandbox(t);
    for (const tool of ["read_file", "manage_task"]) {
      const result = run(sandbox, args, scenario({ tokenToolCall: tool }));
      assert.notEqual(result.status, 0, tool);
      assert.match(result.stdout, /restricted reader was not in effect/, tool);
      assert.deepEqual(promptTexts(sessions(sandbox).at(-1)), [TOKEN_PROMPT], tool);
    }
  });
}

test("the token check needs the exact token and no permission request", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  for (const extra of [{ tokenPrefix: "Sure, my token is " }, { tokenPermission: true }]) {
    const result = run(sandbox, ["review", "--wait"], scenario(extra));
    assert.notEqual(result.status, 0, JSON.stringify(extra));
    assert.match(result.stdout, /restricted reader was not in effect/, JSON.stringify(extra));
    assert.deepEqual(promptTexts(sessions(sandbox).at(-1)), [TOKEN_PROMPT], JSON.stringify(extra));
  }
  // Surrounding whitespace is fine.
  assert.equal(run(sandbox, ["review", "--wait"], scenario({ tokenPrefix: "\n " })).status, 0);
});

test("a disallowed tool call sent right after the final answer still fails the read-only run", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "look"], scenario({ turns: [{ chunks: ["done"], trailingToolCall: "write_file" }] }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /write_file/);
});

test("text sent right after a task's turn ended is part of its answer", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "--write", "--bypass-permissions", "go"], scenario({ turns: [{ chunks: ["answer"], trailingChunk: " LATE" }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "answer LATE\n");
});

test("text sent after a review's turn ended is not added to its answer", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  // On the retry, whose text is the one rendered.
  const result = run(sandbox, ["review", "--wait"], scenario({ turns: [{ chunks: ["prose answer"] }, { chunks: ["still prose"], trailingChunk: " LATE" }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /still prose/);
  assert.doesNotMatch(result.stdout, /LATE/);
});

test("a missing token stops the run before the review prompt", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["review", "--wait"], scenario({ token: "omit" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /restricted reader was not in effect/);
  assert.match(result.stdout, /nothing was reviewed/);
  const [session] = sessions(sandbox);
  assert.deepEqual(promptTexts(session), [TOKEN_PROMPT]);
  assert.equal(fs.existsSync(flagValue(session.argv, "--add-dir")), false);
});

test("a read-only task also runs as the restricted reader", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(run(sandbox, ["task", "--wait", "explain"]).status, 0);
  const [session] = sessions(sandbox);
  assert.ok(session.argv.includes("--agent"));
  assert.deepEqual(promptTexts(session), [TOKEN_PROMPT, "explain"]);
});

test("a write task uses the default agent, allows permissions and never skips them", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "--write", "--bypass-permissions", "fix it"], scenario({ turns: [{ permission: true, chunks: ["done"] }] }));
  assert.equal(result.status, 0, result.stderr);
  const [session] = sessions(sandbox);
  assert.deepEqual(session.argv, ["acp"]);
  assert.deepEqual(promptTexts(session), ["fix it"]);
  const answer = session.received.find((message) => message.id === "1" && !message.method);
  assert.deepEqual(answer.result, { outcome: { outcome: "selected", optionId: "allow" } });
  assert.match(result.stdout, /done/);
});

test("a read-only run refuses a permission, lists it, and asks once more when the turn ends empty", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "check"], scenario({ turns: [{ permission: true, chunks: [] }, { chunks: ["from what I read"] }] }));
  assert.equal(result.status, 0, result.stderr);
  const [session] = sessions(sandbox);
  const answer = session.received.find((message) => message.id === "1" && !message.method);
  assert.deepEqual(answer.result, { outcome: { outcome: "selected", optionId: "deny" } });
  const texts = promptTexts(session);
  assert.equal(texts.length, 3);
  assert.match(texts[2], /That action was refused: this session is read-only/);
  assert.match(result.stdout, /from what I read/);
  assert.match(result.stdout, /Denied: run_command \(echo hi\)/);
});

test("a write_file tool call in a read-only run fails the run", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "check"], scenario({ turns: [{ toolCall: "write_file", chunks: ["wrote it"] }] }));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /write_file/);
  assert.match(result.stdout, /read-only/);
  assert.doesNotMatch(result.stdout, /wrote it/);
  const [session] = sessions(sandbox);
  assert.equal(requests(session, "session/cancel").length, 1);
});

const ALWAYS_FIRST = [
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-always", name: "Always deny", kind: "reject_always" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" }
];

function permissionAnswer(sandbox) {
  return sessions(sandbox).at(-1).received.find((message) => message.id === "1" && !message.method).result;
}

test("a permission is answered with a one-time choice only, even when an always choice comes first", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const write = run(sandbox, ["task", "--wait", "--write", "--bypass-permissions", "go"], scenario({ permissionOptions: ALWAYS_FIRST, turns: [{ permission: true, chunks: ["done"] }] }));
  assert.equal(write.status, 0, write.stdout);
  assert.deepEqual(permissionAnswer(sandbox), { outcome: { outcome: "selected", optionId: "allow" } });
  const readOnly = run(sandbox, ["task", "--wait", "look"], scenario({ permissionOptions: ALWAYS_FIRST, turns: [{ permission: true, chunks: ["read"] }] }));
  assert.equal(readOnly.status, 0, readOnly.stdout);
  assert.deepEqual(permissionAnswer(sandbox), { outcome: { outcome: "selected", optionId: "deny" } });
});

test("a permission request with only always choices is cancelled and fails the run", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const options = ALWAYS_FIRST.slice(0, 2);
  for (const args of [["task", "--wait", "--write", "--bypass-permissions", "go"], ["task", "--wait", "look"]]) {
    const result = run(sandbox, args, scenario({ permissionOptions: options, turns: [{ permission: true, chunks: ["done"] }] }));
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stdout, /offered no one-time choice/, args.join(" "));
    assert.deepEqual(permissionAnswer(sandbox), { outcome: { outcome: "cancelled" } }, args.join(" "));
  }
});

test("any tool call in a read-only task stops it at once, wherever it reads", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const secret = path.join(sandbox.dir, "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET\n");
  const cases = [
    // A start record of a read, inside or outside the workspace, by each field.
    [{ toolCall: "read_file", toolPath: path.join(sandbox.repo, "f0.txt") }, "read_file"],
    [{ toolCall: "read_file", toolPath: "f0.txt", toolPathVia: "args" }, "read_file"],
    [{ toolCall: "read_file", toolPath: secret, toolPathVia: "locations" }, "read_file"],
    [{ toolCall: "read_file" }, "read_file"],
    [{ toolCall: "write_file" }, "write_file"],
    // Only a later record, with no start record: by its name, or by the path it reports.
    [{ toolUpdatePath: secret, toolUpdateName: "read_file" }, "read_file"],
    [{ toolUpdatePath: secret, toolUpdateName: "read_file", toolUpdateNoId: true }, "read_file"],
    [{ toolUpdatePath: secret }, secret],
    [{ toolUpdatePath: secret, toolUpdateNoId: true }, secret]
  ];
  for (const [turn, named] of cases) {
    const result = run(sandbox, ["task", "--wait", "look"], scenario({ turns: [{ permission: true, ...turn, chunks: [] }, { chunks: ["second answer"] }] }));
    const label = JSON.stringify(turn);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stdout, /in a read-only run, so the run was stopped/, label);
    assert.ok(result.stdout.includes(named), `${label}: ${result.stdout}`);
    // No later prompt: not even the follow-up after the refused permission.
    assert.deepEqual(promptTexts(sessions(sandbox).at(-1)), [TOKEN_PROMPT, "look"], label);
  }
});

test("--include puts the named files inside the workspace into a read-only task's prompt", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.join(sandbox.repo, "docs"));
  fs.writeFileSync(path.join(sandbox.repo, "docs", "plan.md"), "PLAN-TEXT\n");
  fs.writeFileSync(path.join(sandbox.repo, "notes.txt"), "NOTES-TEXT\n");
  fs.symlinkSync(path.join(sandbox.repo, "notes.txt"), path.join(sandbox.repo, "inner-link.txt"));
  const result = run(sandbox, ["task", "--wait", "--include", "docs/plan.md", `--include=${path.join(sandbox.repo, "notes.txt")}`, "--include", "inner-link.txt", "check the plan"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Incomplete task/);
  const texts = promptTexts(sessions(sandbox)[0]);
  assert.equal(texts[0], TOKEN_PROMPT);
  assert.match(texts[1], /^check the plan\n/);
  assert.match(texts[1], /### docs\/plan\.md\n```\nPLAN-TEXT\n```/);
  // A link inside the workspace to a file inside it is read once, under the file's own name.
  assert.equal(texts[1].split("NOTES-TEXT").length, 2, texts[1]);
  assert.match(texts[1], /### notes\.txt\n/);
  assert.match(texts[1], /no tools/);
  assert.equal(lastJob(sandbox).evidence, undefined);
});

test("--include refuses a file outside the workspace, a .. path, a link out and a missing file before any session starts", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const secret = path.join(sandbox.dir, "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET\n");
  fs.symlinkSync(secret, path.join(sandbox.repo, "inside-link.txt"));
  fs.mkdirSync(path.join(sandbox.dir, "outside"));
  fs.symlinkSync(path.join(sandbox.dir, "outside"), path.join(sandbox.repo, "linkdir"));
  fs.writeFileSync(path.join(sandbox.dir, "outside", "x.txt"), "X\n");
  fs.mkdirSync(path.join(sandbox.repo, "sub"));
  for (const [include, message] of [
    [secret, /outside the workspace/],
    ["../secret.txt", /outside the workspace/],
    ["inside-link.txt", /outside the workspace/],
    ["linkdir/x.txt", /outside the workspace/],
    // The OS follows linkdir before "..", so this is the secret next to the repository, not repo/secret.txt.
    ["linkdir/../secret.txt", /outside the workspace/],
    [`${sandbox.repo}-other/f.txt`, /cannot be read/],
    ["missing.txt", /cannot be read/],
    ["sub", /not a regular file/]
  ]) {
    for (const extra of [["--wait"], ["--background"]]) {
      const result = run(sandbox, ["task", ...extra, "--include", "f0.txt", "--include", include, "look"]);
      assert.equal(result.status, 1, `${include}: ${result.stdout}`);
      assert.match(result.stderr, message, include);
      assert.ok(result.stderr.includes(include), `${include}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout + result.stderr, /TOP-SECRET/);
    }
  }
  assert.equal(sessions(sandbox).length, 0);
  assert.deepEqual(jobFiles(sandbox), []);
});

test("--include is refused with --write", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "--write", "--bypass-permissions", "--include", "f0.txt", "go"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--include.*read-only/);
  assert.equal(sessions(sandbox).length, 0);
  assert.deepEqual(jobFiles(sandbox), []);
});

test("an include over the budget, or a binary one, is named in an Incomplete task line and on the job", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  fs.writeFileSync(path.join(sandbox.repo, "big.txt"), "x".repeat(300 * 1024));
  fs.writeFileSync(path.join(sandbox.repo, "after.txt"), "AFTER\n");
  fs.writeFileSync(path.join(sandbox.repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  const result = run(sandbox, ["task", "--wait", "--include", "bin.dat", "--include", "big.txt", "--include", "after.txt", "look"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^Incomplete task: the included files were cut at 262144 bytes/m);
  assert.match(result.stdout, /Files shown only in part: big\.txt\./);
  assert.match(result.stdout, /Files not shown: after\.txt\./);
  assert.match(result.stdout, /bin\.dat/);
  const prompt = promptTexts(sessions(sandbox)[0])[1];
  assert.ok(Buffer.byteLength(prompt) < 270 * 1024, String(Buffer.byteLength(prompt)));
  assert.doesNotMatch(prompt, /AFTER/);
  const { evidence } = lastJob(sandbox);
  assert.equal(evidence.incomplete, true);
  assert.equal(evidence.truncated, true);
  assert.deepEqual(evidence.filesPartlyShown, ["big.txt"]);
  assert.deepEqual(evidence.filesNotShown.sort(), ["after.txt", "bin.dat"]);
  assert.deepEqual(evidence.filesSkipped, ["bin.dat"]);
});

test("mode, model and thinking level are set before the prompt", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "--write", "--bypass-permissions", "--model", "gemini-3.8-flash-medium", "--effort", "high", "go"]);
  assert.equal(result.status, 0, result.stderr);
  const [session] = sessions(sandbox);
  const methods = session.received.filter((message) => message.method).map((message) => message.method);
  assert.deepEqual(methods, ["initialize", "session/new", "session/set_mode", "session/set_model", "session/set_config_option", "session/prompt"]);
  assert.deepEqual(requests(session, "session/set_model")[0].params, { sessionId: "S1", modelId: "gemini-3.8-flash-medium" });
  assert.deepEqual(requests(session, "session/set_config_option")[0].params, { sessionId: "S1", configId: "thought_level", value: "high" });
});

test("an unknown model id fails before any prompt and names agy models", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["task", "--wait", "--model", "no-such-model", "go"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /no-such-model/);
  assert.match(result.stdout, /agy models/);
  assert.deepEqual(promptTexts(sessions(sandbox)[0]), []);
});

test("an invalid effort starts nothing and writes no job", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  for (const args of [
    ["review", "--wait", "--effort", "max"],
    ["task", "--wait", "--effort", "extreme", "P"],
    ["task", "--background", "--effort", "max", "P"],
    ["task", "--wait", "--effort=", "P"]
  ]) {
    const result = run(sandbox, args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /low, medium, high, xhigh/, args.join(" "));
    assert.deepEqual(sessions(sandbox), [], args.join(" "));
    assert.deepEqual(jobFiles(sandbox), [], args.join(" "));
  }
});

test("a review prompt says there are no tools and carries every diff and new file", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t, { changedFiles: 3 });
  fs.writeFileSync(path.join(sandbox.repo, "new-file.txt"), "UNTRACKED-CONTENT\n");
  assert.equal(run(sandbox, ["review", "--wait"]).status, 0);
  const prompt = promptTexts(sessions(sandbox)[0])[1];
  assert.match(prompt, /no tools/);
  assert.match(prompt, /cannot read files, list folders, search or run commands/);
  assert.doesNotMatch(prompt, /Read the changed files/);
  // The three files carry the same change: shown once, the others named as identical.
  assert.match(prompt, /diff --git (\S+\/)?f0\.txt/);
  for (const file of ["f1.txt", "f2.txt"]) assert.match(prompt, new RegExp(`${file.replace(".", "\\.")}: identical to f0\\.txt`));
  assert.match(prompt, /UNTRACKED-CONTENT/);
});

test("review evidence over the budget is cut with a note the reviewer must report", async (t) => {
  const { collectReviewContext, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const sandbox = makeSandbox(t, { changedFiles: 3 });
  const context = collectReviewContext(sandbox.repo, resolveReviewTarget(sandbox.repo, {}), { maxInlineDiffBytes: 200 });
  assert.ok(Buffer.byteLength(context.content) < 400, String(Buffer.byteLength(context.content)));
  assert.match(context.content, /evidence was cut at 200 bytes/);
  assert.match(context.collectionGuidance, /cut/);
  const full = collectReviewContext(sandbox.repo, resolveReviewTarget(sandbox.repo, {}));
  assert.doesNotMatch(full.content, /evidence was cut/);
});

test("a review never follows an untracked symlink out of the repository", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const secret = path.join(sandbox.dir, "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET-TOKEN\n");
  fs.symlinkSync(secret, path.join(sandbox.repo, "leak.txt"));
  assert.equal(run(sandbox, ["review", "--wait"]).status, 0);
  const prompt = promptTexts(sessions(sandbox)[0])[1];
  assert.doesNotMatch(prompt, /TOP-SECRET-TOKEN/);
  assert.match(prompt, /symlink targets are never followed/);
});

test("adversarial-review reads its focus from stdin with --focus-stdin", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, ["adversarial-review", "--wait", "--focus-stdin"], {}, { input: "FOCUS-MARKER on retries\n" });
  assert.equal(result.status, 0, result.stderr);
  const texts = promptTexts(sessions(sandbox)[0]);
  assert.match(texts[1], /FOCUS-MARKER on retries/);
  // Prompts travel on the protocol, never in argv.
  assert.equal(sessions(sandbox)[0].argv.some((arg) => arg.includes("FOCUS-MARKER")), false);
});

function readerFoldersUnder(dir) {
  const found = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      if (entry.name.startsWith("reader-")) found.push(path.join(folder, entry.name));
      else walk(path.join(folder, entry.name));
    }
  };
  walk(dir);
  return found;
}

function gitIn(repo, ...args) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" });
}

test("review evidence: source diffs first, tests and generated files last, identical copies named once", async (t) => {
  const { collectReviewContext, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const sandbox = makeSandbox(t, { changedFiles: 0 });
  const files = ["tests/a.test.mjs", "dist/out.js", "src/main.js", "src/deep/copy/main.js"];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(sandbox.repo, file)), { recursive: true });
    fs.writeFileSync(path.join(sandbox.repo, file), "one\n");
  }
  gitIn(sandbox.repo, "add", ".");
  gitIn(sandbox.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "files");
  for (const file of files) fs.writeFileSync(path.join(sandbox.repo, file), file.includes("main.js") ? "SAME-CHANGE\n" : `changed ${file}\n`);
  fs.writeFileSync(path.join(sandbox.repo, "new.js"), "NEW-SOURCE\n");
  fs.mkdirSync(path.join(sandbox.repo, "copy"));
  fs.writeFileSync(path.join(sandbox.repo, "copy", "new.js"), "NEW-SOURCE\n");
  const { content } = collectReviewContext(sandbox.repo, resolveReviewTarget(sandbox.repo, { scope: "working-tree" }));
  const diffs = content.slice(content.indexOf("## Unstaged Diff"));
  const at = (text) => diffs.indexOf(text);
  assert.ok(at("src/main.js") < at("tests/a.test.mjs") && at("tests/a.test.mjs") < at("dist/out.js"), content);
  assert.equal(content.split("SAME-CHANGE").length - 1, 1, "the identical change is shown once");
  assert.match(content, /src\/deep\/copy\/main\.js[\s\S]*identical to src\/main\.js/);
  assert.equal(content.split("NEW-SOURCE").length - 1, 1, "the identical new file is shown once");
  assert.match(content, /copy\/new\.js[\s\S]*identical to new\.js/);
});

test("review evidence: a pure rename stays a short rename patch, so a real edit fits the budget", async (t) => {
  const { collectReviewContext, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const sandbox = makeSandbox(t);
  fs.writeFileSync(path.join(sandbox.repo, "big.txt"), "line of text\n".repeat(25 * 1024));
  gitIn(sandbox.repo, "add", "big.txt");
  gitIn(sandbox.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "big");
  gitIn(sandbox.repo, "mv", "big.txt", "moved.txt");
  const context = collectReviewContext(sandbox.repo, resolveReviewTarget(sandbox.repo, { scope: "working-tree" }));
  assert.equal(context.inputMode, "inline-diff");
  assert.match(context.content, /rename from big\.txt\nrename to moved\.txt/);
  assert.match(context.content, /diff --git (\S+\/)?f0\.txt/);
  assert.ok(Buffer.byteLength(context.content) < 8 * 1024, String(Buffer.byteLength(context.content)));
});

test("review evidence: the same text change with a different mode change is not called identical", async (t) => {
  const { collectReviewContext, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const sandbox = makeSandbox(t, { changedFiles: 0 });
  for (const name of ["a.sh", "b.sh"]) fs.writeFileSync(path.join(sandbox.repo, name), "echo one\n", { mode: 0o755 });
  gitIn(sandbox.repo, "add", ".");
  gitIn(sandbox.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "scripts");
  for (const name of ["a.sh", "b.sh"]) fs.writeFileSync(path.join(sandbox.repo, name), "echo two\n");
  fs.chmodSync(path.join(sandbox.repo, "b.sh"), 0o644);
  const { content } = collectReviewContext(sandbox.repo, resolveReviewTarget(sandbox.repo, { scope: "working-tree" }));
  assert.doesNotMatch(content, /b\.sh: identical/);
  assert.match(content, /old mode 100755\nnew mode 100644/);
});

test("review evidence stops reading at the budget and a huge binary change is cut, not an error", async (t) => {
  const { collectReviewContext, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const sandbox = makeSandbox(t, { changedFiles: 0 });
  // 2 MiB of random bytes: the binary patch is far larger than the budget.
  fs.writeFileSync(path.join(sandbox.repo, "blob.bin"), (await import("node:crypto")).randomBytes(2 * 1024 * 1024));
  gitIn(sandbox.repo, "add", "blob.bin");
  for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(sandbox.repo, `u${String(i).padStart(2, "0")}.txt`), `untracked ${i}\n`.repeat(200));
  const context = collectReviewContext(sandbox.repo, resolveReviewTarget(sandbox.repo, { scope: "working-tree" }), { maxInlineDiffBytes: 4096 });
  assert.ok(Buffer.byteLength(context.content) < 4096 + 2048, String(Buffer.byteLength(context.content)));
  assert.equal(context.inputMode, "truncated-diff");
  assert.match(context.content, /evidence was cut/);
  assert.match(context.content, /not shown: .*u29\.txt/);
});

test("the reader folder is never written inside the workspace, even through a symlink or a ..name", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const inside = path.join(sandbox.repo, ".state");
  fs.mkdirSync(inside);
  const link = path.join(sandbox.dir, "state-link");
  fs.symlinkSync(inside, link);
  for (const env of [
    { PLUGIN_DATA: link },
    { PLUGIN_DATA: path.join(sandbox.repo, "..state") },
    { PLUGIN_DATA: path.join(sandbox.repo, "data"), TMPDIR: path.join(sandbox.repo, "tmp") }
  ]) {
    const result = run(sandbox, ["review", "--wait"], env);
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.match(result.stderr + result.stdout, /inside the workspace/, JSON.stringify(env));
    assert.deepEqual(readerFoldersUnder(sandbox.repo), [], JSON.stringify(env));
    assert.deepEqual(sessions(sandbox), [], JSON.stringify(env));
  }
});

function markRunning(sandbox, jobId, readerDir) {
  const stateRoot = path.join(sandbox.data, "state");
  for (const workspace of fs.readdirSync(stateRoot)) {
    const stateFile = path.join(stateRoot, workspace, "state.json");
    const jobFile = path.join(stateRoot, workspace, "jobs", `${jobId}.json`);
    if (!fs.existsSync(jobFile)) continue;
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    fs.writeFileSync(jobFile, JSON.stringify({ ...job, status: "running", pid: null, agyPid: null, readerDir }));
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.jobs = state.jobs.map((entry) => (entry.id === jobId ? { ...entry, status: "running", pid: null } : entry));
    fs.writeFileSync(stateFile, JSON.stringify(state));
    return path.join(stateRoot, workspace, "readers");
  }
  throw new Error("job not found");
}

test("cancel leaves a stored reader folder alone unless the bridge owns it", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  for (const placement of ["unrelated", "unmarked"]) {
    assert.equal(run(sandbox, ["task", "--wait", "seed"]).status, 0);
    const job = JSON.parse(run(sandbox, ["status", "--json"]).stdout).latestFinished;
    const readerRoot = markRunning(sandbox, job.id, "placeholder");
    const target = placement === "unrelated" ? path.join(sandbox.dir, "reader-x") : path.join(readerRoot, "reader-unmarked");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "keep.txt"), "keep\n");
    markRunning(sandbox, job.id, target);
    assert.equal(run(sandbox, ["cancel", job.id]).status, 0);
    assert.ok(fs.existsSync(path.join(target, "keep.txt")), placement);
  }
});

test("the cut notice names at most 100 files, then a count, and escapes control characters", async () => {
  const { formatNotShown } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const names = Array.from({ length: 101 }, (_, i) => `f${i}.txt`);
  assert.match(formatNotShown(names), /f99\.txt and 1 more\.$/);
  assert.equal(formatNotShown(["b"], ["a"]), " Files shown only in part: a. Files not shown: b.");
  assert.equal(formatNotShown([], ["a"]), " Files shown only in part: a.");
  assert.equal(formatNotShown(["a\nb"]), " Files not shown: a\\u000ab.");
  assert.equal(formatNotShown([]), "");
});

function commitFiles(repo, files) {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), text);
  gitIn(repo, "add", ".");
  gitIn(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
}

test("review evidence: a file whose staged diff was shown is not listed as not shown when its unstaged diff is left out", async (t) => {
  const { collectReviewContext, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const sandbox = makeSandbox(t, { changedFiles: 0 });
  commitFiles(sandbox.repo, { "a.txt": "one\n", "b.txt": "one\n", "c.txt": "one\n" });
  fs.writeFileSync(path.join(sandbox.repo, "a.txt"), "staged\n");
  fs.writeFileSync(path.join(sandbox.repo, "b.txt"), "a long staged line\n".repeat(1000));
  gitIn(sandbox.repo, "add", ".");
  fs.writeFileSync(path.join(sandbox.repo, "a.txt"), "unstaged\n");
  fs.writeFileSync(path.join(sandbox.repo, "c.txt"), "unstaged\n");
  const context = collectReviewContext(sandbox.repo, resolveReviewTarget(sandbox.repo, { scope: "working-tree" }), { maxInlineDiffBytes: 4096 });
  assert.match(context.content, /\+staged/);
  assert.deepEqual(context.notShown, ["c.txt"]);
  // b.txt is where the cut fell; a.txt has one diff shown and one left out.
  assert.deepEqual(context.partlyShown, ["b.txt", "a.txt"]);
  assert.match(context.content, /Files shown only in part: b\.txt, a\.txt\. Files not shown: c\.txt\.\)$/);
});

test("review evidence: a file that follows one that used exactly the rest of the budget is listed as not shown", async (t) => {
  const { collectReviewContext, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  for (const tracked of [true, false]) {
    const sandbox = makeSandbox(t, { changedFiles: 0 });
    commitFiles(sandbox.repo, tracked ? { "a.txt": "one\n", "b.txt": "one\n" } : { "keep.txt": "one\n" });
    for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(sandbox.repo, name), `two ${name}\n`);
    const target = resolveReviewTarget(sandbox.repo, { scope: "working-tree" });
    const whole = collectReviewContext(sandbox.repo, target).content;
    const second = whole.search(tracked ? /^diff --git (\S+\/)?b\.txt/m : /^### b\.txt/m);
    assert.ok(second > 0, whole);
    const context = collectReviewContext(sandbox.repo, target, { maxInlineDiffBytes: Buffer.byteLength(whole.slice(0, second)) });
    assert.equal(context.truncated, true);
    assert.deepEqual(context.notShown, ["b.txt"], String(tracked));
    assert.deepEqual(context.partlyShown, [], String(tracked));
  }
});

test("review evidence: an untracked file that is only named as skipped counts as not shown, and later files are still collected", async (t) => {
  const { collectReviewContext, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const sandbox = makeSandbox(t, { changedFiles: 0 });
  commitFiles(sandbox.repo, { "keep.txt": "one\n" });
  // Over the 24 KiB limit for one untracked file: the prompt gets a skip message, not its contents.
  fs.writeFileSync(path.join(sandbox.repo, "a-big.txt"), "a long untracked line\n".repeat(1500));
  fs.writeFileSync(path.join(sandbox.repo, "b.txt"), "the line that uses up the budget\n".repeat(200));
  fs.writeFileSync(path.join(sandbox.repo, "c.txt"), "never read\n");
  const context = collectReviewContext(sandbox.repo, resolveReviewTarget(sandbox.repo, { scope: "working-tree" }), { maxInlineDiffBytes: 4096 });
  assert.match(context.content, /### a-big\.txt\n\(skipped: /);
  assert.match(context.content, /the line that uses up the budget/);
  assert.deepEqual(context.notShown, ["a-big.txt", "c.txt"]);
  assert.deepEqual(context.skipped, ["a-big.txt"]);
  assert.deepEqual(context.partlyShown, ["b.txt"]);
});

test("review evidence: a last file that uses exactly the rest of the budget is a whole review, not a cut one", async (t) => {
  const { collectReviewContext, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  for (const scope of ["working-tree", "branch"]) {
    const sandbox = makeSandbox(t, { changedFiles: 0 });
    commitFiles(sandbox.repo, { "a.txt": "one\n" });
    gitIn(sandbox.repo, "branch", "base");
    fs.writeFileSync(path.join(sandbox.repo, "a.txt"), "two\n");
    if (scope === "branch") gitIn(sandbox.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "change");
    const target = resolveReviewTarget(sandbox.repo, scope === "branch" ? { scope, base: "base" } : { scope });
    const whole = collectReviewContext(sandbox.repo, target).content;
    // The diff ends where the separator line after it starts.
    const end = scope === "branch" ? whole.length - 1 : whole.indexOf("\n## Untracked Files");
    assert.ok(end > 0 && whole.slice(0, end).endsWith("+two\n"), whole);
    const context = collectReviewContext(sandbox.repo, target, { maxInlineDiffBytes: Buffer.byteLength(whole.slice(0, end)) });
    assert.equal(context.truncated, false, scope);
    assert.equal(context.content, whole.slice(0, end), scope);
    assert.deepEqual([context.notShown, context.partlyShown], [[], []], scope);
  }
});

test("the incomplete-review notice words each cause, and both in one line", async () => {
  const { formatIncomplete } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const reasons = "(too large, binary, a link or unreadable)";
  assert.equal(formatIncomplete({ truncated: false, maxBytes: 9, filesNotShown: ["a"], filesPartlyShown: [], filesSkipped: ["a"] }), `some files were not shown ${reasons}: a.`);
  assert.equal(
    formatIncomplete({ truncated: true, maxBytes: 9, filesNotShown: ["a", "c"], filesPartlyShown: ["b"], filesSkipped: ["a"] }),
    `the evidence was cut at 9 bytes, so the rest of this change was not reviewed. Files shown only in part: b. Files not shown: c. Files not shown for another reason ${reasons}: a.`
  );
  assert.doesNotMatch(formatIncomplete({ truncated: false, maxBytes: 9, filesNotShown: ["a\nb"], filesPartlyShown: [], filesSkipped: ["a\nb"] }), /\n/);
});

test("review evidence: a path whose staged deletion is shown and whose untracked copy is skipped is partly shown, with its skip reason", async (t) => {
  const { collectReviewContext, formatIncomplete, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const sandbox = makeSandbox(t, { changedFiles: 0 });
  commitFiles(sandbox.repo, { "big.txt": "a long tracked line\n".repeat(1500) });
  gitIn(sandbox.repo, "rm", "-q", "--cached", "big.txt");
  const context = collectReviewContext(sandbox.repo, resolveReviewTarget(sandbox.repo, { scope: "working-tree" }));
  assert.match(context.content, /deleted file mode/);
  assert.match(context.content, /### big\.txt\n\(skipped: /);
  assert.deepEqual([context.truncated, context.notShown, context.partlyShown, context.skipped], [false, [], ["big.txt"], ["big.txt"]]);
  // Named once, under its skip reason, also when the budget cut the evidence too.
  const reasons = "(too large, binary, a link or unreadable)";
  const record = { maxBytes: 9, filesNotShown: ["c"], filesPartlyShown: ["big.txt"], filesSkipped: ["big.txt"] };
  assert.equal(
    formatIncomplete({ ...record, truncated: true }),
    `the evidence was cut at 9 bytes, so the rest of this change was not reviewed. Files not shown: c. Files shown only in part, the untracked copy skipped ${reasons}: big.txt.`
  );
  assert.equal(formatIncomplete({ ...record, truncated: false, filesNotShown: [] }), `some files were shown only in part, the untracked copy skipped ${reasons}: big.txt.`);
  assert.equal(
    formatIncomplete({ ...record, truncated: false, filesNotShown: ["a"], filesSkipped: ["a", "big.txt"] }),
    `some files were not shown ${reasons}: a. Files shown only in part, the untracked copy skipped ${reasons}: big.txt.`
  );
});

test("review evidence: an untracked file is judged by its contents, not by its heading, fences or blank lines", async (t) => {
  const { collectReviewContext, resolveReviewTarget } = await import("../plugins/antigravity/scripts/lib/git.mjs");
  const sandbox = makeSandbox(t, { changedFiles: 0 });
  commitFiles(sandbox.repo, { "keep.txt": "one\n" });
  for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(sandbox.repo, name), "the same text\n");
  const target = resolveReviewTarget(sandbox.repo, { scope: "working-tree" });
  // [truncated, not shown, partly shown] when the budget ends right after `text`; measured on the tree as it is now.
  const cutAfter = (text) => {
    const whole = collectReviewContext(sandbox.repo, target).content;
    const index = whole.indexOf(text);
    assert.ok(index > 0, whole);
    const context = collectReviewContext(sandbox.repo, target, { maxInlineDiffBytes: Buffer.byteLength(whole.slice(0, index + text.length)) });
    return [context.truncated, context.notShown, context.partlyShown];
  };
  // Only the heading and the opening fence fit: none of the file was shown.
  assert.deepEqual(cutAfter("### a.txt\n```\n"), [true, ["a.txt", "b.txt"], []]);
  // Half of the contents fit.
  assert.deepEqual(cutAfter("### a.txt\n```\nthe same"), [true, ["b.txt"], ["a.txt"]]);
  // The reference to the identical file fits and only the blank line after it is cut: the whole change was shown.
  assert.deepEqual(cutAfter("(identical to a.txt, not repeated)"), [false, [], []]);
  // Only the first character of the reference fits: a reference is shown whole or not at all.
  assert.deepEqual(cutAfter("### b.txt\n("), [true, ["b.txt"], []]);
  fs.rmSync(path.join(sandbox.repo, "b.txt"));
  // All of the contents fit, the file's last line break included, and only the closing fence is cut.
  assert.deepEqual(cutAfter("### a.txt\n```\nthe same text\n"), [false, [], []]);
  // The contents are counted as they are in the file: blank lines at its end that did not fit were not shown.
  fs.writeFileSync(path.join(sandbox.repo, "a.txt"), "the same text\n\n\n");
  assert.deepEqual(cutAfter("### a.txt\n```\nthe same text\n"), [true, [], ["a.txt"]]);
  fs.writeFileSync(path.join(sandbox.repo, "a.txt"), "  \n\n");
  assert.deepEqual(cutAfter("### a.txt\n```\n"), [true, ["a.txt"], []]);
  // Two files that differ only in the blank lines at their end are not called identical.
  fs.writeFileSync(path.join(sandbox.repo, "a.txt"), "the same text\n");
  fs.writeFileSync(path.join(sandbox.repo, "b.txt"), "the same text\n\n");
  assert.doesNotMatch(collectReviewContext(sandbox.repo, target).content, /identical to/);
});

test("a long option's inline value is split at the first = only", () => {
  const { options } = parseArgs(["--include=a=b.json", "--include", "c", "--model=x=y"], { valueOptions: ["model"], arrayOptions: ["include"] });
  assert.deepEqual(options.include, ["a=b.json", "c"]);
  assert.equal(options.model, "x=y");
});

test("isWithin compares whole path components exactly, never ignoring case", () => {
  const root = path.join(path.sep, "work", "Repo");
  assert.equal(isWithin(root, root), true);
  assert.equal(isWithin(path.join(root, "a", "b.txt"), root), true);
  assert.equal(isWithin(path.join(path.sep, "work", "repo", "a.txt"), root), false);
  assert.equal(isWithin(path.join(path.sep, "work", "Repo-other", "a.txt"), root), false);
  assert.equal(isWithin(path.join(path.sep, "work"), root), false);
  assert.equal(isWithin(path.join(path.sep, "a.txt"), path.sep), true);
});

test("an include whose folder became a link out after the check is refused before a byte is read", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const root = fs.realpathSync.native(sandbox.repo);
  fs.mkdirSync(path.join(sandbox.dir, "outside"));
  fs.writeFileSync(path.join(sandbox.dir, "outside", "x.txt"), "TOP-SECRET\n");
  // The checked path went through a real folder; it was swapped for a link out before the open.
  fs.symlinkSync(path.join(sandbox.dir, "outside"), path.join(root, "swapped"));
  const files = [{ name: "swapped/x.txt", real: path.join(root, "swapped", "x.txt") }];
  for (const platform of ["linux", "darwin"]) {
    if (platform === "linux" && process.platform !== "linux") continue;
    assert.throws(() => collectIncludedFiles(files, { root, platform }), /outside the workspace/, platform);
  }
  // A file that stays inside is still read.
  const inside = collectIncludedFiles([{ name: "f0.txt", real: path.join(root, "f0.txt") }], { root });
  assert.match(inside.content, /### f0\.txt\n```\nb\n```/);
});

test("an include is read whole even when the system returns short reads", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const root = fs.realpathSync.native(sandbox.repo);
  const text = "0123456789".repeat(10) + "\n";
  fs.writeFileSync(path.join(root, "long.txt"), text);
  const original = fs.readSync;
  fs.readSync = (fd, buffer, offset, length, position) => original(fd, buffer, offset, Math.min(length, 7), position);
  t.after(() => { fs.readSync = original; });
  const result = collectIncludedFiles([{ name: "long.txt", real: path.join(root, "long.txt") }], { root });
  fs.readSync = original;
  assert.ok(result.content.includes(text), result.content);
  assert.equal(result.truncated, false);
});

test("a failed task that shows a partial answer also shows its Incomplete task line", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  fs.writeFileSync(path.join(sandbox.repo, "bin.dat"), Buffer.from([0, 1, 2]));
  const result = run(sandbox, ["task", "--wait", "--include", "bin.dat", "look"], { ...scenario({ turns: [{ chunks: ["PARTIAL"], after: [{ toolCall: "manage_task", id: "m" }] }] }), AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS: "1000" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^Antigravity run failed: /m);
  assert.match(result.stdout, /PARTIAL/);
  assert.match(result.stdout, /^Incomplete task: some files were not shown .*bin\.dat/m);
});

test("a FIFO swapped in for an include does not block the open and is not read", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const root = fs.realpathSync.native(sandbox.repo);
  const fifo = path.join(root, "pipe.txt");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  // In a child process: a blocked synchronous open would hang this test runner past any timeout.
  const gitLib = new URL("../plugins/antigravity/scripts/lib/git.mjs", import.meta.url).href;
  const code = `import(${JSON.stringify(gitLib)}).then((m) => console.log(JSON.stringify(m.collectIncludedFiles([{ name: "pipe.txt", real: ${JSON.stringify(fifo)} }], { root: ${JSON.stringify(root)} }))))`;
  const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined, "the open blocked");
  assert.equal(result.status, 0, result.stderr);
  const collected = JSON.parse(result.stdout);
  assert.deepEqual(collected.skipped, ["pipe.txt"]);
  assert.match(collected.content, /### pipe\.txt\n\(skipped: /);
});

test("a single inline --include=value argument with a space is kept whole, with the prompt on stdin", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.join(sandbox.repo, "docs"));
  fs.writeFileSync(path.join(sandbox.repo, "docs", "task plan.txt"), "SPACED-PLAN\n");
  const result = run(sandbox, ["task", "--include=docs/task plan.txt"], {}, { input: "check the plan" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const prompt = promptTexts(sessions(sandbox)[0])[1];
  assert.match(prompt, /^check the plan/);
  assert.match(prompt, /### docs\/task plan\.txt\n```\nSPACED-PLAN\n```/);
});

test("an unnamed later record is judged by its first non-empty path, so an empty one cannot hide another", async () => {
  const token = "tok";
  for (const update of [
    { rawInput: { Path: "" }, locations: [{ path: "/outside/secret.txt" }] },
    { rawInput: { Path: "" }, args: { Path: "/outside/secret.txt" } },
    { args: { Path: "" }, locations: [{ path: "/outside/secret.txt" }] }
  ]) {
    let acp;
    const reply = (message) => setImmediate(() => acp.handle(message));
    acp = startAcpRun({
      cwd: process.cwd(),
      prompt: "look",
      readOnly: true,
      token,
      quietSettleMs: 50,
      geminiDir: path.join(os.tmpdir(), "agy-no-gemini"),
      write(line) {
        const message = JSON.parse(line);
        if (message.method === "initialize") reply({ id: message.id, result: { agentCapabilities: {} } });
        else if (message.method === "session/new") reply({ id: message.id, result: { sessionId: "S1" } });
        else if (message.method === "session/prompt" && message.params.prompt[0].text === TOKEN_PROMPT) {
          reply({ method: "session/update", params: { sessionId: "S1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: token } } } });
          reply({ id: message.id, result: { stopReason: "end_turn" } });
        } else if (message.method === "session/prompt") {
          reply({ method: "session/update", params: { sessionId: "S1", update: { sessionUpdate: "tool_call_update", status: "completed", ...update } } });
          reply({ id: message.id, result: { stopReason: "end_turn" } });
        }
      }
    });
    const parsed = await acp.result;
    assert.equal(parsed.ok, false, JSON.stringify(update));
    assert.match(parsed.error, /\/outside\/secret\.txt/, JSON.stringify(update));
  }
});

test("a state folder inside the workspace is refused before any job or prompt is written, in the foreground and in the background", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  fs.writeFileSync(path.join(sandbox.repo, "notes.txt"), "NOTES-TEXT\n");
  const data = path.join(sandbox.repo, "data");
  for (const args of [
    ["task", "--background", "--include", "notes.txt", "look"],
    ["task", "--wait", "--include", "notes.txt", "look"],
    ["task", "--background", "look"],
    ["review", "--background"],
    ["review", "--wait"],
    ["transfer", "--background", "--source", path.join(sandbox.dir, "missing.jsonl")]
  ]) {
    const result = run(sandbox, args, { PLUGIN_DATA: data });
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr + result.stdout, /inside the workspace/, args.join(" "));
    assert.equal(fs.existsSync(data), false, `${args.join(" ")} wrote ${data}`);
  }
  assert.deepEqual(sessions(sandbox), []);
});

test("a lone raw argument string is split, except a lone --include=value", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  // `/antigravity:review --scope=working-tree --json` arrives as one raw string: it is two options.
  const review = run(sandbox, ["review", "--scope=working-tree --json"]);
  assert.equal(review.status, 0, review.stdout + review.stderr);
  assert.equal(JSON.parse(review.stdout).job.status, "completed");
  const task = run(sandbox, ["task", "--model=gemini-3.8-flash-medium --json"], {}, { input: "look" });
  assert.equal(task.status, 0, task.stdout + task.stderr);
  assert.equal(JSON.parse(task.stdout).job.status, "completed");
});

test("outside Linux the opened include is matched by device and inode as BigInt, so inodes past 2^53 are told apart", { skip: POSIX_ONLY }, (t) => {
  const sandbox = makeSandbox(t);
  const root = fs.realpathSync.native(sandbox.repo);
  // Two inodes that are equal once rounded to a Number.
  const big = 2n ** 60n;
  const fake = (ino) => (fd, options) => (options?.bigint ? { dev: 1n, ino, isFile: () => true } : { dev: 1, ino: Number(ino), isFile: () => true });
  const { fstatSync, statSync } = fs;
  fs.fstatSync = fake(big + 1n);
  fs.statSync = fake(big);
  t.after(() => Object.assign(fs, { fstatSync, statSync }));
  assert.throws(() => collectIncludedFiles([{ name: "f0.txt", real: path.join(root, "f0.txt") }], { root, platform: "darwin" }), /could not be confirmed inside the workspace/);
});

