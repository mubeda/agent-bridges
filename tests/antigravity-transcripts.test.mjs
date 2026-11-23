import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_RECORD_BYTES, subagentStates } from "../plugins/antigravity/scripts/lib/acp.mjs";

const line = (record) => `${JSON.stringify(record)}\n`;
const RUNNING = { type: "TOOL_CALL", status: "RUNNING" };
const DONE = { type: "SYSTEM_MESSAGE" };
const ASKS_COMMAND = { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command" }] };

/** A brain with session S1 and one subagent, sub1; returns the transcript path. */
function makeBrain(t) {
  const gemini = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  t.after(() => fs.rmSync(gemini, { recursive: true, force: true }));
  const brain = path.join(gemini, "antigravity-cli", "brain");
  fs.mkdirSync(path.join(brain, "S1", ".system_generated", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(brain, "S1", ".system_generated", "subagents", "sub1.json"), JSON.stringify({ conversationId: "sub1" }));
  const logs = path.join(brain, "sub1", ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  return { gemini, transcript: path.join(logs, "transcript.jsonl") };
}

/** The diagnosis of a whole-file parse, as the bridge did it before reading incrementally. */
function wholeFile(transcript) {
  let open = 0;
  let last = null;
  for (const text of fs.readFileSync(transcript, "utf8").split("\n")) {
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    last = record;
    if (record.type === "SYSTEM_MESSAGE") open = Math.max(0, open - 1);
    else if (record.status === "RUNNING") open += 1;
  }
  const running = open > 0;
  return { running, stuck: !running && Array.isArray(last?.tool_calls) && last.tool_calls.some((call) => call?.name === "run_command") };
}

/** Records every position fs.readSync reads the transcript from, and every whole-file read of it. */
function countReads(t, transcript) {
  const reads = { positions: [], whole: 0 };
  const { readSync, readFileSync, openSync, closeSync } = fs;
  const fds = new Set();
  fs.openSync = (file, ...rest) => {
    const fd = openSync(file, ...rest);
    if (String(file) === transcript) fds.add(fd);
    return fd;
  };
  fs.closeSync = (fd) => {
    fds.delete(fd);
    return closeSync(fd);
  };
  fs.readSync = (fd, buffer, offset, length, position) => {
    if (fds.has(fd)) reads.positions.push({ position, length });
    return readSync(fd, buffer, offset, length, position);
  };
  fs.readFileSync = (file, ...rest) => {
    if (String(file) === transcript) reads.whole += 1;
    return readFileSync(file, ...rest);
  };
  t.after(() => Object.assign(fs, { readSync, readFileSync, openSync, closeSync }));
  return reads;
}

const check = (gemini, transcript, cache) => {
  const [state] = subagentStates(gemini, "S1", 1000, { now: fs.statSync(transcript).mtimeMs + 60_000, cache });
  return state;
};

test("a growing transcript is read only from its offset and gives the whole-file diagnosis", (t) => {
  const { gemini, transcript } = makeBrain(t);
  fs.writeFileSync(transcript, line(RUNNING).repeat(3) + line(DONE));
  const cache = new Map();
  assert.equal(check(gemini, transcript, cache).running, true);
  const offset = fs.statSync(transcript).size;
  const reads = countReads(t, transcript);
  fs.appendFileSync(transcript, line(DONE).repeat(2) + line(ASKS_COMMAND));
  const state = check(gemini, transcript, cache);
  assert.equal(reads.whole, 0, "no whole-file read");
  assert.deepEqual({ running: state.running, stuck: state.stuck }, wholeFile(transcript));
  assert.deepEqual({ running: state.running, stuck: state.stuck }, { running: false, stuck: true });
  assert.ok(reads.positions.length > 0);
  for (const { position } of reads.positions) assert.ok(position >= offset, `read again from ${position}, before ${offset}`);
});

test("a partial last line is carried over and counted once when its newline arrives", (t) => {
  const { gemini, transcript } = makeBrain(t);
  const text = line(RUNNING);
  fs.writeFileSync(transcript, line(DONE) + text.slice(0, 10));
  const cache = new Map();
  assert.equal(check(gemini, transcript, cache).running, false, "half a record is not a record");
  fs.appendFileSync(transcript, text.slice(10, -1));
  assert.equal(check(gemini, transcript, cache).running, true, "a whole record without its newline counts, as in a whole-file parse");
  fs.appendFileSync(transcript, "\n");
  assert.equal(check(gemini, transcript, cache).running, true);
  fs.appendFileSync(transcript, line(DONE));
  assert.equal(check(gemini, transcript, cache).running, false, "the carried record was counted once");
  assert.deepEqual({ running: false, stuck: false }, wholeFile(transcript));
});

test("a transcript that shrank or was replaced is read again from 0", (t) => {
  const { gemini, transcript } = makeBrain(t);
  fs.writeFileSync(transcript, line(RUNNING).repeat(4));
  const cache = new Map();
  assert.equal(check(gemini, transcript, cache).running, true);
  const reads = countReads(t, transcript);
  fs.writeFileSync(transcript, line(ASKS_COMMAND));
  let state = check(gemini, transcript, cache);
  assert.deepEqual({ running: state.running, stuck: state.stuck }, { running: false, stuck: true });
  assert.equal(reads.positions[0].position, 0, "a smaller file is read from 0");
  // Replaced by a larger file with another inode: reading from the old offset would miss its first records.
  const replacement = `${transcript}.new`;
  fs.writeFileSync(replacement, line(RUNNING) + line({ type: "NOTE", pad: "x".repeat(200) }));
  fs.renameSync(replacement, transcript);
  reads.positions.length = 0;
  state = check(gemini, transcript, cache);
  assert.deepEqual({ running: state.running, stuck: state.stuck }, { running: true, stuck: false });
  assert.equal(reads.positions[0].position, 0, "a replaced file is read from 0");
});

test("a record longer than the limit is skipped, leaves the counters alone and is noted", (t) => {
  const { gemini, transcript } = makeBrain(t);
  const huge = line({ ...RUNNING, pad: "x".repeat(MAX_RECORD_BYTES) });
  fs.writeFileSync(transcript, line(ASKS_COMMAND) + huge);
  const cache = new Map();
  let state = check(gemini, transcript, cache);
  assert.deepEqual({ running: state.running, stuck: state.stuck, tooLarge: state.tooLarge }, { running: false, stuck: false, tooLarge: true }, "something followed the model turn");
  fs.appendFileSync(transcript, line(RUNNING));
  state = check(gemini, transcript, cache);
  assert.deepEqual({ running: state.running, stuck: state.stuck, tooLarge: state.tooLarge }, { running: true, stuck: false, tooLarge: true });
  // Still unfinished when the over-long record is the last one, without its newline.
  fs.writeFileSync(transcript, line(DONE) + huge.slice(0, -1));
  state = check(gemini, transcript, new Map());
  assert.deepEqual({ running: state.running, tooLarge: state.tooLarge }, { running: false, tooLarge: true });
  const small = makeBrain(t);
  fs.writeFileSync(small.transcript, line(RUNNING));
  assert.equal(check(small.gemini, small.transcript, new Map()).tooLarge, false);
});

test("a 50 MB transcript is checked with bounded heap growth", (t) => {
  const { gemini, transcript } = makeBrain(t);
  const block = (line(RUNNING) + line({ type: "NOTE", text: "y".repeat(180) }) + line(DONE)).repeat(2000);
  const fd = fs.openSync(transcript, "w");
  for (let written = 0; written < 50 * 1024 * 1024; written += Buffer.byteLength(block)) fs.writeSync(fd, block);
  fs.writeSync(fd, line(ASKS_COMMAND));
  fs.closeSync(fd);
  const reads = countReads(t, transcript);
  const before = process.memoryUsage().heapUsed;
  const state = check(gemini, transcript, new Map());
  const growth = process.memoryUsage().heapUsed - before;
  assert.deepEqual({ running: state.running, stuck: state.stuck }, { running: false, stuck: true });
  assert.equal(reads.whole, 0, "no whole-file read");
  assert.ok(reads.positions.length >= 800);
  for (const { length } of reads.positions) assert.ok(length <= 64 * 1024, `a read of ${length} bytes`);
  assert.ok(growth < 10 * 1024 * 1024, `heap grew by ${Math.round(growth / 1024 / 1024)} MB`);
});

test("a rewrite in place with the same length, or a new file with the same size and mtime, is read from 0", (t) => {
  const { gemini, transcript } = makeBrain(t);
  const first = line({ ...RUNNING, pad: "z".repeat(20) });
  const same = line({ type: "TOOL_CALL", status: "DONE", pad: "z".repeat(23) });
  assert.equal(same.length, first.length);
  fs.writeFileSync(transcript, first);
  const cache = new Map();
  assert.equal(check(gemini, transcript, cache).running, true);
  fs.writeFileSync(transcript, same);
  const later = new Date(fs.statSync(transcript).mtimeMs + 5000);
  fs.utimesSync(transcript, later, later);
  assert.equal(check(gemini, transcript, cache).running, false, "rewritten in place: same size, new mtime");
  const replacement = `${transcript}.new`;
  fs.writeFileSync(replacement, first);
  fs.utimesSync(replacement, later, later);
  fs.renameSync(replacement, transcript);
  assert.equal(check(gemini, transcript, cache).running, true, "another inode with the same size and mtime");
});

test("the read limit comes from the opened file, not from an earlier stat of the path", (t) => {
  const { gemini, transcript } = makeBrain(t);
  fs.writeFileSync(transcript, line(RUNNING));
  const replacement = `${transcript}.new`;
  fs.writeFileSync(replacement, line(RUNNING) + line({ type: "NOTE", text: "w".repeat(500) }) + line(DONE));
  const { openSync } = fs;
  // The file is replaced between the path's stat and the open.
  fs.openSync = (file, ...rest) => {
    if (String(file) === transcript && fs.existsSync(replacement)) fs.renameSync(replacement, transcript);
    return openSync(file, ...rest);
  };
  t.after(() => { fs.openSync = openSync; });
  const now = fs.statSync(transcript).mtimeMs + 60_000;
  const [state] = subagentStates(gemini, "S1", 1000, { now, cache: new Map() });
  assert.deepEqual({ running: state.running, stuck: state.stuck }, { running: false, stuck: false });
});

test("an unchanged unterminated last line is not parsed again on every check", (t) => {
  const { gemini, transcript } = makeBrain(t);
  fs.writeFileSync(transcript, line(DONE) + line(RUNNING).slice(0, -1));
  const cache = new Map();
  assert.equal(check(gemini, transcript, cache).running, true);
  const { parse } = JSON;
  let parses = 0;
  JSON.parse = (...args) => {
    parses += 1;
    return parse(...args);
  };
  t.after(() => { JSON.parse = parse; });
  const listing = 1;
  assert.equal(check(gemini, transcript, cache).running, true);
  assert.equal(parses, listing, "only the subagent listing was parsed");
  fs.appendFileSync(transcript, "\n" + line(DONE));
  assert.equal(check(gemini, transcript, cache).running, false);
});
