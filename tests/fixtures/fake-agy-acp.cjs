#!/usr/bin/env node
// Stand-in for `agy`: answers --version, and for `agy acp` speaks newline-delimited JSON-RPC on stdio.
// Scripted by FAKE_ACP (JSON). Logs its argv and every message it receives to FAKE_AGY_LOG.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const argv = process.argv.slice(2);
const logFile = process.env.FAKE_AGY_LOG;
const log = (entry) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + "\n"); };
if (argv.includes("--version")) {
  log({ argv, pid: process.pid });
  if (process.env.FAKE_AGY_VERSION_SIGNAL) process.kill(process.pid, process.env.FAKE_AGY_VERSION_SIGNAL);
  if (process.env.FAKE_AGY_VERSION_EXIT) process.exit(Number(process.env.FAKE_AGY_VERSION_EXIT));
  process.stdout.write("1.5.14\n");
  process.exit(0);
}

const scenario = JSON.parse(process.env.FAKE_ACP || "{}");
const line = (message) => JSON.stringify({ jsonrpc: "2.0", ...message, ...(scenario.stringIds && message.id !== undefined && !message.method ? { id: String(message.id) } : {}) }) + "\n";
const send = (message) => process.stdout.write(line(message));
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };

// The token of the restricted reader, read from the agent file the client wrote under --add-dir.
function readerToken() {
  const dir = flag("--add-dir");
  const agent = flag("--agent");
  if (!dir || !agent) return null;
  const plugins = path.join(dir, ".agents", "plugins");
  for (const plugin of fs.existsSync(plugins) ? fs.readdirSync(plugins) : []) {
    const file = path.join(plugins, plugin, "agents", agent, "agent.md");
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").match(/Your agent token is (\S+?)\./)?.[1] ?? null;
  }
  return null;
}

function readerFiles() {
  const dir = flag("--add-dir");
  const plugins = dir ? path.join(dir, ".agents", "plugins") : null;
  if (!plugins || !fs.existsSync(plugins)) return null;
  const files = {};
  const walk = (folder) => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const full = path.join(folder, entry.name); if (entry.isDirectory()) walk(full); else files[path.relative(dir, full)] = fs.readFileSync(full, "utf8"); } };
  walk(dir);
  return files;
}
log({ argv, pid: process.pid, readerFiles: readerFiles() });

const MODELS = [{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" }, { modelId: "gemini-3.8-flash-medium", name: "Flash" }];
let turn = 0;
let onCancel = null;
let nextServerId = 1;
const waiting = new Map();

function update(sessionId, body) {
  send({ method: "session/update", params: { sessionId, update: body } });
}

function askPermission(sessionId, toolCall) {
  const id = String(nextServerId++);
  send({ id, method: "session/request_permission", params: {
    sessionId,
    toolCall,
    options: scenario.permissionOptions ?? [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }]
  } });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt?.[0]?.text ?? "";
  if (text === "Reply with only your agent token.") {
    const token = readerToken();
    if (scenario.tokenToolCall) update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tk", name: scenario.tokenToolCall, kind: "read", status: "completed" });
    if (scenario.tokenPermission) await askPermission(sessionId, { toolCallId: "tp", name: "run_command", title: "cat agent.md" });
    if (scenario.hangOn === "token") return;
    if (token && scenario.token !== "omit") update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: (scenario.tokenPrefix ?? "") + token } });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  const script = (scenario.turns ?? [])[turn++] ?? {};
  if (script.exit) process.exit(Number(script.exit));
  // Close the protocol output but stay alive: the client must not wait for the process to exit.
  if (script.closeStdout) { process.stdout.end(); setInterval(() => {}, 1000); return; }
  // "$READER" in a tool path stands for the reader folder passed with --add-dir.
  const fill = (value) => (typeof value === "string" ? value.replace("$READER", flag("--add-dir") ?? "") : value);
  const input = script.toolPath === undefined ? undefined : { Path: fill(script.toolPath), StartLine: 1, EndLine: 10 };
  if (script.toolCall) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "t0",
      name: script.toolCall,
      kind: script.toolCall === "read_file" ? "read" : "edit",
      status: "in_progress",
      ...(input && script.toolPathVia !== "args" && script.toolPathVia !== "locations" ? { rawInput: input } : {}),
      ...(input && script.toolPathVia === "args" ? { args: input } : {}),
      ...(input && script.toolPathVia === "locations" ? { locations: [{ path: input.Path }] } : {})
    });
  }
  // The tool call completes within the turn (with a path when toolUpdatePath is set).
  if (script.toolCall || script.toolUpdatePath) {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t0", status: "completed", ...(script.toolUpdatePath ? { rawInput: { Path: fill(script.toolUpdatePath) } } : {}) });
  }
  if (script.permission) await askPermission(sessionId, { toolCallId: "t1", name: "run_command", title: "echo hi" });
  const sleep = Number(process.env.FAKE_AGY_SLEEP_MS ?? 0);
  if (sleep > 0 && scenario.answerOnCancel) {
    // Finish the turn successfully the moment the client asks to cancel it.
    onCancel = () => {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE SUCCESS" } });
      send({ id, result: { stopReason: "end_turn", usage: {} } });
    };
    fs.writeFileSync(process.env.FAKE_AGY_PIDFILE, JSON.stringify({ pid: process.pid }));
    return;
  }
  if (sleep > 0) {
    const code = (process.env.FAKE_AGY_CHILD_IGNORES_TERM ? "process.on('SIGTERM', () => {});" : "") + "setTimeout(() => {}, " + sleep + ")";
    const child = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
    fs.writeFileSync(process.env.FAKE_AGY_PIDFILE, JSON.stringify({ pid: process.pid, childPid: child.pid }));
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  for (const chunk of script.chunks ?? ["ok"]) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
  if (script.holdStdout) {
    // A detached descendant that keeps our stdout open after we exit, in its own process group.
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: ["ignore", 1, "ignore"] });
    holder.unref();
    fs.writeFileSync(process.env.FAKE_AGY_PIDFILE, JSON.stringify({ holderPid: holder.pid }));
  }
  const done = line({ id, result: { stopReason: script.stopReason ?? "end_turn", usage: {} } });
  if (script.lateToolCall) {
    // Sent in a later write, after the response: the client must still see it.
    setTimeout(() => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "later", name: script.lateToolCall, kind: "edit", status: "pending" } } }), 100);
  }
  // A trailing update in the same write as the response: the client must still see it.
  const trailing = script.trailingToolCall
    ? line({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "late", name: script.trailingToolCall, kind: "edit", status: "pending" } } })
    : script.trailingChunk
      ? line({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: script.trailingChunk } } } })
      : "";
  process.stdout.write(done + trailing);
  if (script.after) afterTurn(sessionId, script.after);
}

// What the session does after its turn ended, one step after another, each after its delayMs:
// { toolCall, id, title } opens a tool call, { toolDone: id } completes it, { chunk } adds text,
// { permission: true } asks and waits for the answer, { exit } exits, { subagent: id } lists a subagent with a RUNNING
// record in its transcript under scenario.brain, { subagentDone: id } adds its SYSTEM_MESSAGE record.
async function afterTurn(sessionId, steps) {
  for (const step of steps) {
    await new Promise((resolve) => setTimeout(resolve, step.delayMs ?? 0));
    if (step.toolCall) update(sessionId, { sessionUpdate: "tool_call", toolCallId: step.id, name: step.toolCall, title: step.title, kind: "execute", status: "in_progress" });
    if (step.toolDone) update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: step.toolDone, status: "completed" });
    if (step.exit) process.exit(Number(step.exit));
    if (step.chunk) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.chunk } });
    if (step.permission) await askPermission(sessionId, { toolCallId: "t2", name: "run_command", title: "echo later" });
    if (step.subagent) {
      const list = path.join(scenario.brain, sessionId, ".system_generated", "subagents");
      const logs = path.join(scenario.brain, step.subagent, ".system_generated", "logs");
      fs.mkdirSync(list, { recursive: true });
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(list, `${step.subagent}.json`), JSON.stringify({ conversationId: step.subagent }));
      fs.writeFileSync(path.join(logs, "transcript.jsonl"), JSON.stringify({ type: "TOOL_CALL", status: "RUNNING" }) + "\n");
    }
    if (step.subagentDone) {
      fs.appendFileSync(path.join(scenario.brain, step.subagentDone, ".system_generated", "logs", "transcript.jsonl"), JSON.stringify({ type: "SYSTEM_MESSAGE" }) + "\n");
    }
  }
}

function handle(message) {
  log({ received: message, pid: process.pid });
  if (!message.method) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    if (resolve) resolve(message.result);
    return;
  }
  const { id, method, params = {} } = message;
  if (method === "session/cancel" && onCancel) { onCancel(); onCancel = null; }
  if (id === undefined) return;
  if (scenario.hangOn === method) return;
  if (scenario.nullIdError === method) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
    return;
  }
  if (scenario.authError && method === "session/new") {
    send({ id, error: { code: -32000, message: "Authentication required" } });
    return;
  }
  switch (method) {
    case "initialize":
      if (scenario.closeStdinAfterInit) { process.stdin.destroy(); try { fs.closeSync(0); } catch {} setInterval(() => {}, 1000); }
      send({ id, result: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" },
        agentCapabilities: { loadSession: true, sessionCapabilities: scenario.noResume ? { load: {} } : { resume: {}, close: {}, load: {}, list: {} } },
        authMethods: []
      } });
      return;
    case "session/new":
      send({ id, result: { sessionId: scenario.newSessionId ?? "S1", models: { availableModels: MODELS, currentModelId: MODELS[0].modelId }, modes: {}, configOptions: [] } });
      return;
    case "session/resume":
      // The error agy 1.5.14 gives for an id it does not have.
      if (scenario.resumeFails) send({ id, error: { code: -32603, message: `Failed to read session ${params.sessionId}; retry, or load it with session/load` } });
      else if (scenario.resumeError) send({ id, error: { code: -32603, message: scenario.resumeError } });
      else send({ id, result: {} });
      return;
    case "session/load":
      // agy 1.5.14 silently creates a session for an unknown id here, which is why the client never calls it.
      send({ id, result: {} });
      return;
    case "session/set_model":
      send({ id, result: {} });
      return;
    case "session/set_config_option":
      send({ id, result: { configOptions: [] } });
      return;
    case "session/prompt":
      prompt(id, params);
      return;
    default:
      send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
// A real server may not exit on end of input; FAKE_ACP.ignoreEof stays up so the client must end it.
process.stdin.on("end", () => {
  if (scenario.ignoreEof) setInterval(() => {}, 1000);
  else setTimeout(() => process.exit(0), Number(scenario.exitDelayMs ?? 0));
});
if (scenario.noise) process.stdout.write("starting server (not json)\n{\"jsonrpc\":\"2.0\",\"method\":\"x\"");
if (scenario.noise) process.stdout.write("}\n");
