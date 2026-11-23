// A small Agent Client Protocol client for `agy acp`: newline-delimited JSON-RPC 2.0 on stdio.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatDeniedActions, parseStructuredResult } from "./agy.mjs";

export const TOKEN_PROMPT = "Reply with only your agent token.";
export const REFUSED_PROMPT = "That action was refused: this session is read-only. Answer from what you have read.";
export const JSON_RETRY_PROMPT = "Reply with only the JSON object that matches the schema above, with no other text before or after it.";
export const READ_ONLY_RESUME_WARNING =
  "A read-only run cannot continue an earlier Antigravity session, because the restricted reader cannot be attached to it; this started a new session. Add --write to continue the earlier one.";
export const AUTH_MESSAGE = "Antigravity is not signed in: run `agy` once interactively, or `agy acp --login`.";
const AUTH_ERROR_CODE = -32000;
// manage_task is built into every agy agent. The reader (a review's and a read-only task's) has no other tool.
const READER_TOOLS = new Set(["manage_task"]);
const READER_PLUGIN = "agent-bridges-reader";
/** Written into every reader folder at creation: cleanup removes only folders that carry it. */
export const READER_MARKER = ".agent-bridges-reader";
export const NO_RESUME_WARNING =
  "This Antigravity version cannot continue sessions (its ACP server offers no session/resume); this started a new session.";
export const CLIENT_INFO = { name: "agent-bridges-antigravity", version: "0.2.4" };
/** A task's session goes on after its turn ends: it is done once nothing changed for this long. */
// A thinking model was seen silent for 17 s before its turn ended.
export const QUIET_SETTLE_MS = 30_000;
/** The wait after a task's turn ended is bounded by this, so a session that never goes quiet ends. */
export const QUIET_TIMEOUT_MS = 30 * 60_000;
const TOOL_DONE = new Set(["completed", "failed"]);

/** realpath of the nearest existing ancestor, with the rest of the path appended: works before the folder exists. */
export function canonicalPath(target) {
  let existing = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(existing)) {
    rest.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...rest);
}

/** Whole path components only: `<ws>/..state` is inside `<ws>`, `<ws>-other` is not. */
export function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function buildAcpArgs({ agentDir, agentName } = {}) {
  return agentDir && agentName ? ["acp", "--add-dir", agentDir, "--agent", agentName] : ["acp"];
}

/**
 * Write a plugin with one restricted agent, plus a random token that proves agy loaded it.
 * The reader has no tools (`tools: []`): a read-only task sees only its prompt and the files the bridge put in it.
 */
export function writeReaderAgent(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(baseDir, "reader-"));
  fs.writeFileSync(path.join(dir, READER_MARKER), "agent-bridges antigravity reader\n", { mode: 0o600 });
  const name = `bridge-reader-${crypto.randomBytes(4).toString("hex")}`;
  const token = crypto.randomBytes(16).toString("hex");
  const pluginDir = path.join(dir, ".agents", "plugins", READER_PLUGIN);
  fs.mkdirSync(path.join(pluginDir, ".antigravity-plugin"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(pluginDir, "agents", name), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(pluginDir, ".antigravity-plugin", "plugin.json"),
    `${JSON.stringify({ name: READER_PLUGIN, version: "1.0.0", description: "Read-only reader for agent-bridges runs.", license: "Apache-2.0" }, null, 2)}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(pluginDir, "agents", name, "agent.md"),
    [
      "---",
      `name: ${name}`,
      "description: Read-only reader for agent-bridges reviews and read-only tasks.",
      "tools: []",
      "---",
      `Your agent token is ${token}. When asked for your agent token, reply with exactly that token and nothing else.`,
      "",
      "You have no tools: you cannot read files, list folders, search or run commands. Answer only from what the prompt gives you.",
      ""
    ].join("\n"),
    { mode: 0o600 }
  );
  return { dir, name, token };
}

/** Feed it stdout chunks; it calls onMessage once per complete JSON line, and onSkipped for any other line (a server log). */
export function createLineReader(onMessage, onSkipped = () => {}) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        onSkipped(line);
        continue;
      }
      if (message && typeof message === "object" && !Array.isArray(message)) onMessage(message);
      else onSkipped(line);
    }
  };
}

function rpcError(error, method) {
  const code = typeof error?.code === "number" ? error.code : null;
  const text = typeof error?.message === "string" ? error.message : "unknown error";
  const auth = code === AUTH_ERROR_CODE || /authentication required/i.test(text);
  return Object.assign(new Error(auth ? AUTH_MESSAGE : `${method} failed: ${text}${code === null ? "" : ` (code ${code})`}`), { code, rpc: true, auth });
}

export function createAcpClient({ write, onRequest = () => undefined, onNotification = () => {} }) {
  let nextId = 1;
  let closedError = null;
  const pending = new Map();
  const send = (message) => write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const client = {
    /**
     * onSettle runs synchronously when the response arrives, before any later line of the same chunk.
     * timeoutMs fails the whole client when the server does not answer in time.
     */
    request(method, params, { onSettle = null, timeoutMs = 0, label = method } = {}) {
      if (closedError) return Promise.reject(closedError);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = timeoutMs > 0
          ? setTimeout(() => client.fail(new Error(`agy did not answer ${label} within ${timeoutMs / 1000} s.`)), timeoutMs)
          : null;
        const settle = (fn) => (value) => {
          if (timer) clearTimeout(timer);
          if (onSettle) onSettle();
          fn(value);
        };
        pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
        try {
          send({ id, method, params });
        } catch (error) {
          client.fail(error);
        }
      });
    },
    notify(method, params) {
      try {
        if (!closedError) send({ method, params });
      } catch {
        // best effort
      }
    },
    async handle(message) {
      // The server's own requests carry string ids, so dispatch on `method` before matching a response.
      if (typeof message.method === "string") {
        if (message.id === undefined || message.id === null) return onNotification(message);
        let reply;
        try {
          const result = await onRequest(message);
          reply = result === undefined ? { error: { code: -32601, message: `Method not found: ${message.method}` } } : { result };
        } catch (error) {
          reply = { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
        }
        try {
          if (!closedError) send({ id: message.id, ...reply });
        } catch (error) {
          client.fail(error);
        }
        return undefined;
      }
      // An error the server could not tie to a request (id null) would otherwise leave a request waiting forever.
      if ((message.id === null || message.id === undefined) && message.error) {
        client.fail(rpcError(message.error, "agy"));
        return undefined;
      }
      const key = pending.has(message.id) ? message.id : typeof message.id === "string" && /^\d+$/.test(message.id) ? Number(message.id) : message.id;
      const entry = pending.get(key);
      if (!entry) return undefined;
      pending.delete(key);
      if (message.error) entry.reject(rpcError(message.error, entry.method));
      else entry.resolve(message.result ?? {});
      return undefined;
    },
    /** The error that closed the client, or null while it is open. */
    closedError: () => closedError,
    fail(error) {
      closedError = closedError ?? error;
      for (const entry of [...pending.values()]) entry.reject(closedError);
      pending.clear();
    }
  };
  return client;
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.length > 0;
const isLine = (value) => Number.isInteger(value) && value >= 1;
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const FINDING_KEYS = ["severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation"];

/** Hand-written check of schemas/review-output.schema.json: required fields, types, enums, no extra keys. */
export function isReviewResult(value) {
  if (!isObject(value) || !onlyKeys(value, ["verdict", "summary", "findings", "next_steps"])) return false;
  if (!["approve", "needs-attention"].includes(value.verdict) || !isText(value.summary)) return false;
  if (!Array.isArray(value.next_steps) || !value.next_steps.every(isText)) return false;
  return Array.isArray(value.findings) && value.findings.every((finding) =>
    isObject(finding) &&
    onlyKeys(finding, FINDING_KEYS) &&
    FINDING_KEYS.every((key) => key in finding) &&
    ["critical", "high", "medium", "low"].includes(finding.severity) &&
    isText(finding.title) && isText(finding.body) && isText(finding.file) &&
    isLine(finding.line_start) && isLine(finding.line_end) &&
    typeof finding.confidence === "number" && finding.confidence >= 0 && finding.confidence <= 1 &&
    typeof finding.recommendation === "string"
  );
}

function toolName(toolCall) {
  return String(toolCall?.name ?? toolCall?.kind ?? "unknown");
}

/** A record's call id; absent, null and empty are one case: no id. */
function callId(update) {
  const id = update.toolCallId;
  return id === undefined || id === null || id === "" ? null : id;
}

/** A session or subagent id used as one path component: no separators, never "." or "..". */
function safeId(value) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^[\w.-]+$/.test(text) && !/^\.+$/.test(text) ? text : null;
}

/**
 * The subagents this run's session started, read only (never written), each { id, role, busy, running, stuck, recent, tooLarge }:
 * - running: a background command is still open. RUNNING tool records are counted against the SYSTEM_MESSAGE
 *   records after them, because the transcript does not say which command a SYSTEM_MESSAGE ends.
 * - stuck: the latest record is a model turn with run_command in its tool_calls and nothing followed (in the
 *   default mode such a command is never asked of the client and never runs).
 * - recent: the transcript changed within settleMs. Such a transcript is busy by that alone and is not parsed
 *   (running and stuck stay false) unless `diagnose` asks for the reasons at the wait's bound.
 * - busy: running, or recent.
 * - tooLarge: a record over MAX_RECORD_BYTES was skipped; it does not change the open count, and it ends
 *   stuck like any later record does, so running may miss a RUNNING record it held.
 * A transcript is read incrementally (see readTranscript), so memory stays bounded however long it grows.
 * Missing folders and unreadable files are skipped, and so is a transcript last changed before `since` (this
 * run's start): a resumed session lists earlier runs' subagents, which may have been cut off.
 */
export function subagentStates(geminiDir, sessionId, settleMs, { now = Date.now(), since = 0, cache = null, diagnose = false } = {}) {
  const brain = path.join(geminiDir, "antigravity-cli", "brain");
  const session = safeId(sessionId);
  if (!session) return [];
  const listDir = path.join(brain, session, ".system_generated", "subagents");
  let names;
  try {
    names = fs.readdirSync(listDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    let id;
    let role;
    let file;
    let stat;
    try {
      const listing = JSON.parse(fs.readFileSync(path.join(listDir, name), "utf8"));
      id = safeId(listing?.conversationId);
      if (!id) return [];
      role = isText(listing?.subagentDescriptor?.role) ? listing.subagentDescriptor.role : null;
      file = path.join(brain, id, ".system_generated", "logs", "transcript.jsonl");
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    // Checked before reading: an earlier run's transcript is never read.
    const mtime = stat.mtimeMs;
    if (mtime < since) return [];
    const recent = now - mtime < settleMs;
    // Still changing: busy by its mtime alone, so it is parsed only for the diagnostics at the wait's bound.
    if (recent && !diagnose) return [{ id, role, busy: true, running: false, stuck: false, recent, tooLarge: false }];
    // The same file (device and inode) with the same mtime and size is not read again; a grown one is read from
    // where the last read ended.
    let parsed;
    try {
      parsed = readTranscript(file, cache?.get(file));
    } catch {
      return [];
    }
    cache?.set(file, parsed);
    const { open, lastRunCommand } = parsed.view;
    const running = open > 0;
    const stuck = !running && lastRunCommand;
    return [{ id, role, busy: running || recent, running, stuck, recent, tooLarge: parsed.tooLarge }];
  });
}

/** Transcripts are read in chunks of this size, so one read never holds more. */
const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
/** A transcript record longer than this is skipped (its counters unchanged) and noted, never parsed. */
export const MAX_RECORD_BYTES = 1024 * 1024;

/** Folds one transcript line into the counters; a line that is not a JSON object changes nothing. */
function foldRecord(state, text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return state;
  }
  if (!isObject(record)) return state;
  state.lastRunCommand = Array.isArray(record.tool_calls) && record.tool_calls.some((call) => call?.name === "run_command");
  if (record.type === "SYSTEM_MESSAGE") state.open = Math.max(0, state.open - 1);
  else if (record.status === "RUNNING") state.open += 1;
  return state;
}

/**
 * Reads the bytes appended since `previous` ended, chunk by chunk, keeping only the counters, the latest
 * record's run_command flag and the unfinished last line (at most MAX_RECORD_BYTES). Identity, size and mtime
 * come from the opened descriptor, never from an earlier stat of the path. An unchanged file returns `previous`
 * as it is; a file that shrank, was rewritten without growing, or was replaced (another device or inode) is read
 * from 0. `view` is the diagnosis: the counters, plus a whole record at the end without its newline, which counts
 * as it would in a whole-file parse but is not committed, so it is counted once when its newline arrives.
 */
function readTranscript(file, previous) {
  const fd = fs.openSync(file, "r");
  try {
    // BigInt stats, so no platform's inode loses precision.
    const { ino, dev, size: bigSize, mtimeNs: mtime } = fs.fstatSync(fd, { bigint: true });
    const size = Number(bigSize);
    const same = previous && ino === previous.ino && dev === previous.dev;
    if (same && mtime === previous.mtime && size === previous.size) return previous;
    const state = same && size > previous.offset
      ? { ...previous }
      : { ino, dev, offset: 0, partial: Buffer.alloc(0), skipping: false, open: 0, lastRunCommand: false, tooLarge: false };
    const chunk = Buffer.allocUnsafe(TRANSCRIPT_CHUNK_BYTES);
    while (state.offset < size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - state.offset), state.offset);
      if (!read) break;
      state.offset += read;
      let start = 0;
      for (let end = chunk.indexOf(10, start); end !== -1 && end < read; end = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, end);
        start = end + 1;
        if (state.skipping) state.skipping = false;
        else if (state.partial.length + piece.length > MAX_RECORD_BYTES) skipRecord(state);
        else foldRecord(state, (state.partial.length ? Buffer.concat([state.partial, piece]) : piece).toString("utf8"));
        state.partial = Buffer.alloc(0);
      }
      if (start < read && !state.skipping) {
        state.partial = Buffer.concat([state.partial, chunk.subarray(start, read)]);
        if (state.partial.length > MAX_RECORD_BYTES) Object.assign(skipRecord(state), { partial: Buffer.alloc(0), skipping: true });
      }
    }
    const committed = { open: state.open, lastRunCommand: state.lastRunCommand };
    state.view = state.partial.length && !state.skipping ? foldRecord(committed, state.partial.toString("utf8")) : committed;
    return Object.assign(state, { mtime, size });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * An over-long record is noted and not parsed. The open count stays as it was; the latest record is no longer a
 * model turn asking for run_command, since something followed it, so a skip alone never makes a subagent stuck.
 */
function skipRecord(state) {
  return Object.assign(state, { tooLarge: true, lastRunCommand: false });
}

export function subagentBusy(geminiDir, sessionId, settleMs, options) {
  return subagentStates(geminiDir, sessionId, settleMs, options).some((state) => state.busy);
}

/** One `unfinished` entry; the reason notes a skipped over-long record, which may have hidden the real state. */
function unfinishedEntry({ id, role, tooLarge }, reason) {
  return { id, role, reason: tooLarge ? `${reason} (a transcript record over ${MAX_RECORD_BYTES / 1024 / 1024} MiB was skipped)` : reason };
}

/** The `Unfinished subagents:` line, or "" when every subagent finished. */
function unfinishedLine(unfinished) {
  return unfinished.length
    ? `Unfinished subagents: ${unfinished.map(({ id, role, reason }) => `${role ? `${role} (${id})` : id}: ${reason}`).join("; ")}`
    : "";
}

/**
 * The end of an agy run, by one path. A run that did not complete cleanly (the wait's bound, agy exiting, a
 * security stop, cancel, any failure) ends agy's whole tree first, while agy's PID still addresses it: on
 * Windows `taskkill /T` cannot reach a tree whose root already exited (agy may exit on end of input), and on
 * POSIX the process group outlives its leader. A clean run closes agy's input, gives it a grace period, and
 * ends whatever is left.
 */
export async function finishAgyRun({ clean, endTree, closeInput, waitExit, graceMs = 2000 }) {
  if (!clean) {
    await endTree();
    closeInput();
    return;
  }
  closeInput();
  if (!(await waitExit(graceMs))) await endTree();
}

/**
 * One run: initialize, open or resume a session, set model and thinking level, prove the reader in a
 * read-only run, send the prompt(s). Returns { handle, fail, cancel, result }; result never rejects and
 * resolves to the parsed shape the companion renders.
 */
export function startAcpRun(options) {
  const { write, cwd, prompt, readOnly, token, model, effort, resumeSessionId, review } = options;
  // Every tool call of the session by id: { name, title, status, questions }.
  const toolCalls = new Map();
  // Setup requests and the token check are bounded; the real prompt is not (jobs may run long; cancel ends them).
  // Only the wait for a quiet session after a task's turn ended is bounded, by quietTimeoutMs.
  const setup = { timeoutMs: options.setupTimeoutMs ?? 60_000 };
  const settleMs = options.quietSettleMs ?? QUIET_SETTLE_MS;
  const quietTimeoutMs = options.quietTimeoutMs ?? QUIET_TIMEOUT_MS;
  const geminiDir = options.geminiDir ?? path.join(os.homedir(), ".gemini");
  const runStarted = Date.now();
  let lastUpdate = runStarted;
  // Subagents left unfinished when the last wait ended: { id, role, reason }.
  let unfinished = [];
  const transcriptCache = new Map();
  let sessionId = null;
  // Updates that came before the session id was known, for the bookkeeping once it is.
  const heldBack = [];
  let anonymousCalls = 0;
  // Resolves the quiet wait's sleep, so a stop or a closed server ends the wait at once.
  let wakeWait = null;
  let turn = null;
  let stopped = null;
  let securityStop = false;
  let promptSent = false;
  let warning = options.warning ?? null;
  const deniedActions = [];

  // afterReply: mark the run stopped now, but let a reply that is being sent reach the server first.
  const stop = (error, { afterReply = false, security = false } = {}) => {
    // A security stop after another stop (the wait's bound) still wins: the run's answer must be discarded.
    if (stopped && security && !securityStop) {
      stopped = error;
      securityStop = true;
      return;
    }
    if (stopped) return;
    stopped = error;
    wakeWait?.();
    securityStop = security;
    const end = () => {
      if (sessionId) client.notify("session/cancel", { sessionId });
      client.fail(error);
    };
    if (afterReply) setImmediate(end);
    else end();
  };

  const client = createAcpClient({
    write,
    onNotification(message) {
      if (message.method !== "session/update") return;
      // Before the session id is known no update can be told apart as this session's: the bookkeeping waits for
      // the id, while the read-only rules check every update at once.
      if (sessionId === null) heldBack.push(message);
      else bookkeep(message);
      enforce(message);
    },
    onRequest(message) {
      if (message.method !== "session/request_permission") return undefined;
      const params = message.params ?? {};
      if (isOwn(params)) lastUpdate = Date.now();
      if (turn?.verifying) stop(new Error(`${readerMissing()} A permission request came during the token check.`), { security: true });
      const choices = Array.isArray(params.options) ? params.options : [];
      // Exact one-time kinds only: an *_always choice could save a rule in the user's Antigravity settings.
      const kind = readOnly ? "reject_once" : "allow_once";
      const choice = choices.find((option) => option?.kind === kind);
      if (readOnly) deniedActions.push({ action: toolName(params.toolCall), display_name: params.toolCall?.title ?? null });
      if (!choice) {
        stop(
          new Error(`Antigravity's permission request for ${toolName(params.toolCall)} offered no one-time choice (${kind}), so it was cancelled and the run was stopped.`),
          { afterReply: true }
        );
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: choice.optionId } };
    }
  });

  /**
   * This session's updates only: another session's (a subagent's, on the same connection) never hold the wait
   * open and never add text, questions or tool calls.
   */
  function bookkeep(message) {
    const update = message.params?.update ?? {};
    if (!isOwn(message.params)) return;
    lastUpdate = Date.now();
    // Text counts only inside an open turn (a task's stays open until its session is quiet).
    if (update.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
      if (turn) turn.text += update.content.text;
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const id = callId(update);
      if (id !== null) recordCall(id, update);
      // A start without an id is tracked under a key of its own, so an id-less completion can close it.
      else if (update.sessionUpdate === "tool_call") recordCall(`\0anonymous-${anonymousCalls++}`, update);
      else if (TOOL_DONE.has(update.status)) closeWithoutId(update.status);
    }
  }

  function recordCall(key, update) {
    const call = toolCalls.get(key) ?? { name: "", title: null, status: "pending" };
    // Only non-empty values: a later record with an empty field must not erase what an earlier one said.
    if (isText(update.name)) call.name = update.name;
    if (isText(update.title)) call.title = update.title;
    if (isText(update.status)) call.status = update.status;
    // A call this record shows active again is waited for again, after an ambiguous id-less completion too.
    if (isText(update.status) && !TOOL_DONE.has(update.status)) call.untracked = false;
    // An ask_question carries its questions in rawInput (or args) .questions[].question.
    const asked = [update.rawInput, update.args].find((input) => Array.isArray(input?.questions))?.questions
      .map((entry) => entry?.question).filter(isText);
    if (asked?.length) call.questions = asked;
    toolCalls.set(key, call);
  }

  /**
   * The read-only rules, for every update of every session, at every moment. The reader has no tools, so any
   * tool call but manage_task stops the run; a later record is judged by its own name, then the tracked one.
   * One that names neither but reports a path is a read and stops the run too.
   */
  function enforce(message) {
    if (!readOnly) return;
    const update = message.params?.update ?? {};
    if (update.sessionUpdate === "tool_call_update") {
      // The tool map holds only this session's calls, so another session's record goes by its own name.
      const tracked = sessionId !== null && isOwn(message.params) && callId(update) !== null ? toolCalls.get(callId(update))?.name : undefined;
      const name = isText(update.name) ? update.name : tracked;
      if (isText(name) ? !READER_TOOLS.has(name) : readPath(update) !== null) {
        stop(new Error(`Antigravity used ${isText(name) ? `the tool "${name}"` : `a tool on "${readPath(update)}"`} in a read-only run, so the run was stopped.`), { security: true });
      }
    } else if (update.sessionUpdate === "tool_call") {
      const name = typeof update.name === "string" ? update.name : "";
      // The real reader has the token in its instructions: a tool used to answer the check proves nothing.
      if (turn?.verifying) {
        stop(new Error(`${readerMissing()} A tool (${name || "unnamed"}) was used during the token check.`), { security: true });
      } else if (!READER_TOOLS.has(name)) {
        stop(new Error(`Antigravity started the tool "${name || "unnamed"}" in a read-only run, so the run was stopped.`), { security: true });
      }
    }
  }

  /** The session id is known: apply the bookkeeping of the updates that came before it. */
  function setSession(id) {
    sessionId = id;
    for (const message of heldBack.splice(0)) bookkeep(message);
  }

  /** The path a read record reports: rawInput.Path, then args.Path, then the first location. */
  function readPath(update) {
    // The first non-empty one: an empty field must not hide a path in another.
    return [update.rawInput?.Path, update.args?.Path, update.locations?.[0]?.path].find(isText) ?? null;
  }

  const readerMissing = () =>
    `Antigravity's restricted reader was not in effect (its token check failed), so the run was stopped and nothing was ${review ? "reviewed" : "run"}.`;

  /**
   * keepOpen (a task's prompts): the session goes on after end_turn (a backgrounded command completes, a
   * subagent answers), so the turn's text keeps growing until the session is quiet.
   */
  async function sendPrompt(text, { verifying = false, keepOpen = false } = {}) {
    const current = { text: "", verifying };
    turn = current;
    // Otherwise close the turn the moment its response arrives, so a later line of the same chunk cannot add to it.
    const close = () => { if (turn === current) turn = null; };
    const response = await client.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      { onSettle: keepOpen ? null : close, ...(verifying ? { ...setup, label: "the token check" } : {}) }
    );
    if (stopped) throw stopped;
    if (response?.stopReason !== "end_turn") {
      close();
      throw new Error(`Antigravity ended the turn with stop reason "${response?.stopReason ?? "none"}".`);
    }
    if (keepOpen) {
      await waitQuiet(current);
      close();
    }
    return current.text;
  }

  /** An update of this run's session (one with no session id counts as this session's). */
  function isOwn(params) {
    const id = params?.sessionId;
    return id === undefined || id === null || id === "" || String(id) === sessionId;
  }

  // Open calls that a completion without a call id may have closed: no longer waited for, and reported.
  const isOpen = (call) => !TOOL_DONE.has(call.status) && !call.untracked;
  const openCalls = (questions) => [...toolCalls.values()].filter((call) => isOpen(call) && (call.name === "ask_question") === questions);
  const unmatched = [];

  /**
   * A terminal record without a call id closes the one open call; with several open, none can be trusted.
   * A pending ask_question is never the one it closes: it waits for an answer nobody sends.
   */
  function closeWithoutId(status) {
    const open = openCalls(false);
    if (open.length === 1) open[0].status = status;
    else if (open.length > 1) {
      unmatched.push(open.length);
      for (const call of open) call.untracked = true;
    }
  }

  /** The answer with the lines every result carries: denials, unanswered questions, unmatched updates, unfinished subagents. */
  function resultLines(text) {
    const response = text.trim();
    let resultText = response;
    if (deniedActions.length) {
      const denied = formatDeniedActions(deniedActions);
      resultText = response ? `${response}\nDenied: ${denied}` : `no answer; denied: ${denied}`;
    }
    const questions = openCalls(true).flatMap((call) => call.questions ?? [call.title ?? "ask_question"]);
    const unmatchedLine = unmatched.length
      ? `Unmatched tool updates: ${unmatched.length} completion${unmatched.length === 1 ? "" : "s"} without a call id could not be matched to one open tool call (${unmatched.join(", ")} open), so the open calls were not waited for.`
      : "";
    return [resultText, questions.length ? `Unanswered questions: ${questions.join("; ")}` : "", unmatchedLine, unfinishedLine(unfinished)]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Quiet: no tool call open (a pending ask_question has no one to answer it, so it does not count), no
   * update for settleMs, and no subagent of the session busy. Bounded by quietTimeoutMs; cancel, a closed
   * server or a security stop end it at once.
   */
  async function waitQuiet(current) {
    const started = Date.now();
    lastUpdate = Math.max(lastUpdate, started);
    for (;;) {
      const error = stopped ?? client.closedError();
      if (error) throw error;
      const now = Date.now();
      const options = { now, since: runStarted, cache: transcriptCache };
      if (!openCalls(false).length && now - lastUpdate >= settleMs) {
        const states = subagentStates(geminiDir, sessionId, settleMs, options);
        if (!states.some((state) => state.busy)) {
          unfinished = states.filter((state) => state.stuck).map((state) => unfinishedEntry(state, "stuck on a command"));
          return;
        }
      }
      if (now - started >= quietTimeoutMs) {
        // The diagnostics read every transcript of this run, the ones still changing too.
        unfinished = subagentStates(geminiDir, sessionId, settleMs, { ...options, diagnose: true })
          .filter((state) => state.running || state.stuck || state.recent)
          .map((state) => unfinishedEntry(state, state.running ? "still running" : state.stuck ? "stuck on a command" : "recently active"));
        stop(Object.assign(
          new Error(`Antigravity's session was still working ${Math.round(quietTimeoutMs / 1000)} s after its turn ended, so the run was stopped.`),
          { partialText: resultLines(current.text) }
        ));
        throw stopped;
      }
      await new Promise((resolve) => {
        wakeWait = resolve;
        setTimeout(resolve, Math.min(250, settleMs));
      });
      wakeWait = null;
    }
  }

  async function main() {
    const init = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: CLIENT_INFO
    }, setup);
    let session = null;
    // A session keeps the agent it was made with, so a read-only run never resumes: it could be a full-tool session.
    if (resumeSessionId && readOnly) warning = READ_ONLY_RESUME_WARNING;
    // Write runs only, and session/resume only: session/load on an unknown id silently creates a session.
    else if (resumeSessionId && !init?.agentCapabilities?.sessionCapabilities?.resume) warning = NO_RESUME_WARNING;
    else if (resumeSessionId) {
      try {
        session = await client.request("session/resume", { sessionId: resumeSessionId, cwd, mcpServers: [] }, setup);
        setSession(String(resumeSessionId));
      } catch (error) {
        // Only a confirmed missing session starts afresh; any other error must not run a prompt that needs the history.
        if (!error?.rpc || !/Failed to read session/.test(error.message)) throw error;
        warning = `conversation ${resumeSessionId} not found; Antigravity started a new one`;
      }
    }
    if (!sessionId) {
      session = await client.request("session/new", { cwd, mcpServers: [] }, setup);
      if (!session?.sessionId) throw new Error("Antigravity returned no session id.");
      setSession(String(session.sessionId));
    }
    // A write task (it needed --bypass-permissions) runs in mode auto, so the session's subagents can run commands
    // Antigravity counts as safe; read-only runs keep the default mode. Without auto the run goes on, and says so.
    if (!readOnly) {
      const modes = session?.modes?.availableModes;
      let missing = null;
      if (Array.isArray(modes) && !modes.some((mode) => mode?.id === "auto")) missing = "this Antigravity version lists no auto mode";
      else {
        try {
          await client.request("session/set_mode", { sessionId, modeId: "auto" }, setup);
        } catch (error) {
          if (!error?.rpc) throw error;
          missing = `setting it failed: ${error.message}`;
        }
      }
      if (missing) {
        // A failed set_mode leaves the mode as it was, which is not always the default (a resumed session).
        const current = isText(session?.modes?.currentModeId) ? `the session stayed in mode "${session.modes.currentModeId}"` : "the mode was left unchanged";
        const note = `the session could not use Antigravity's auto mode (${missing}), so ${current}, and its subagents may not be able to run commands.`;
        warning = warning ? `${warning} Also, ${note}` : `${note[0].toUpperCase()}${note.slice(1)}`;
      }
    }
    if (model) {
      // shortcut: a resumed session may not list its models; then the server's own error decides.
      const available = session?.models?.availableModels;
      if (Array.isArray(available) && !available.some((entry) => entry?.modelId === model)) {
        throw new Error(`Antigravity has no model "${model}". Run \`agy models\` to list the model ids.`);
      }
      await client.request("session/set_model", { sessionId, modelId: model }, setup);
    }
    if (effort) await client.request("session/set_config_option", { sessionId, configId: "thought_level", value: effort }, setup);
    if (readOnly) {
      const answer = await sendPrompt(TOKEN_PROMPT, { verifying: true });
      if (!token || answer.trim() !== token) {
        stop(new Error(readerMissing()), { security: true });
        throw stopped;
      }
    }
    promptSent = true;
    let text = await sendPrompt(prompt, { keepOpen: !review });
    if (readOnly && !text.trim() && deniedActions.length) text = await sendPrompt(REFUSED_PROMPT, { keepOpen: !review });
    let structured = null;
    if (review) {
      structured = isReviewResult(parseStructuredResult(text)) ? parseStructuredResult(text) : null;
      if (!structured) {
        const retry = await sendPrompt(JSON_RETRY_PROMPT);
        const parsed = parseStructuredResult(retry);
        if (isReviewResult(parsed)) structured = parsed;
        if (retry.trim()) text = retry;
      }
    }
    const resultText = resultLines(text);
    if (stopped) throw stopped;
    if (unfinished.length) {
      // Work the session handed to a subagent did not happen: not a plain success.
      return {
        sessionId,
        resultText,
        structured,
        status: "end_turn",
        ok: false,
        error: `the session ended with ${unfinished.length} unfinished subagent${unfinished.length === 1 ? "" : "s"}.`,
        deniedActions,
        warning,
        promptSent,
        unfinishedSubagents: unfinished,
        raw: null
      };
    }
    return { sessionId, resultText, structured, status: "end_turn", ok: true, error: null, deniedActions, warning, promptSent, unfinishedSubagents: [], raw: null };
  }

  const failure = (error) => ({
    sessionId,
    resultText: error?.partialText ?? "",
    structured: null,
    status: null,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    deniedActions,
    warning,
    promptSent,
    unfinishedSubagents: unfinished,
    raw: null
  });
  const result = main().catch((error) => failure(stopped ?? error));

  return {
    result,
    handle: (message) => client.handle(message),
    fail: (error) => {
      client.fail(error);
      wakeWait?.();
    },
    /** Stop the run now (sends session/cancel when a session exists): nothing later can turn it into a success. */
    abort: (error) => {
      stop(error);
      return Boolean(sessionId);
    },
    /** True when a read-only security rule stopped the run: end the tree at once. */
    securityStopped: () => securityStop,
    /** Re-check after the output closed: a violation that came after the final answer still fails the run. */
    settle: (parsed) => ((parsed.ok || securityStop) && stopped ? failure(stopped) : parsed),
  };
}
