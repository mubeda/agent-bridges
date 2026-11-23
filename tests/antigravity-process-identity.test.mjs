import assert from "node:assert/strict";
import test from "node:test";

import { isSameProcess, processStartTime, processState } from "../plugins/antigravity/scripts/lib/process.mjs";

const MAC_START = "Mon Nov 23 10:00:00 2026";
const WIN_START = "2026-11-23T13:00:00.0000000Z";

function stubSpawn(result) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    return typeof result === "function" ? result() : result;
  };
  return { spawn, calls };
}

test("macOS: the start time comes from ps -o lstart=, as an argument array, trimmed", () => {
  const { spawn, calls } = stubSpawn({ status: 0, stdout: `${MAC_START}\n` });
  assert.equal(processStartTime(4242, { platform: "darwin", spawn }), MAC_START);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "ps");
  assert.deepEqual(calls[0].args, ["-o", "lstart=", "-p", "4242"]);
});

test("other POSIX systems use ps too", () => {
  const { spawn, calls } = stubSpawn({ status: 0, stdout: `  ${MAC_START}  \n` });
  assert.equal(processStartTime(7, { platform: "freebsd", spawn }), MAC_START);
  assert.equal(calls[0].file, "ps");
});

test("Windows: the start time comes from Get-Process, the pid as a checked number", () => {
  const { spawn, calls } = stubSpawn({ status: 0, stdout: `${WIN_START}\r\n` });
  assert.equal(processStartTime(4242, { platform: "win32", spawn }), WIN_START);
  assert.equal(calls[0].file, "powershell");
  assert.deepEqual(calls[0].args, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "(Get-Process -Id 4242).StartTime.ToUniversalTime().ToString('o')"
  ]);
});

test("a failed, empty or thrown lookup, or a pid that is not a positive integer, gives null without running anything for a bad pid", () => {
  for (const platform of ["darwin", "win32"]) {
    assert.equal(processStartTime(1, { platform, spawn: stubSpawn({ status: 1, stdout: "" }).spawn }), null, platform);
    assert.equal(processStartTime(1, { platform, spawn: stubSpawn({ status: 0, stdout: "  \n" }).spawn }), null, platform);
    assert.equal(processStartTime(1, { platform, spawn: stubSpawn({ status: null, error: new Error("ENOENT"), stdout: null }).spawn }), null, platform);
    assert.equal(processStartTime(1, { platform, spawn: stubSpawn(() => { throw new Error("boom"); }).spawn }), null, platform);
    const { spawn, calls } = stubSpawn({ status: 0, stdout: MAC_START });
    for (const pid of [0, -1, 1.5, "1; rm -rf /", null, Number.NaN]) assert.equal(processStartTime(pid, { platform, spawn }), null, `${platform} ${pid}`);
    assert.equal(calls.length, 0, platform);
  }
});

test("a live pid is the recorded process only when its start time matches, on any platform", () => {
  for (const [platform, start] of [["darwin", MAC_START], ["win32", WIN_START]]) {
    const { spawn } = stubSpawn({ status: 0, stdout: start });
    assert.equal(isSameProcess(process.pid, start, { platform, spawn }), true, platform);
    assert.equal(isSameProcess(process.pid, "another start", { platform, spawn }), false, platform);
    assert.equal(isSameProcess(process.pid, null, { platform, spawn }), false, platform);
    assert.equal(processState(process.pid, start, { platform, spawn }), "alive", platform);
    // A reused pid: alive, but another start time, so the recorded process is dead.
    assert.equal(processState(process.pid, "another start", { platform, spawn }), "dead", platform);
    // No identity recorded: a live pid cannot be proven dead.
    assert.equal(processState(process.pid, null, { platform, spawn }), "alive", platform);
    // A lookup that fails cannot prove anything either way: alive, never the same process.
    const failing = stubSpawn({ status: 1, stdout: "" }).spawn;
    assert.equal(processState(process.pid, start, { platform, spawn: failing }), "alive", platform);
    assert.equal(isSameProcess(process.pid, start, { platform, spawn: failing }), false, platform);
  }
});

test("a pid that answers no signal is dead without a lookup", () => {
  const { spawn, calls } = stubSpawn({ status: 0, stdout: MAC_START });
  // Large enough to be free on every test machine.
  assert.equal(processState(2 ** 22 + 12345, MAC_START, { platform: "darwin", spawn }), "dead");
  assert.equal(calls.length, 0);
});
