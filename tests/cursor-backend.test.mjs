import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  getCursorAuthStatus,
  getCursorAvailability
} from "../plugins/cursor/scripts/lib/cursor.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("missing binary includes PATH, installation, and CURSOR_BIN hints", () => {
  const status = getCursorAvailability(process.cwd(), {
    CURSOR_BIN: "cursor-agent-does-not-exist-xyz"
  });

  assert.equal(status.available, false);
  assert.equal(status.loggedIn, false);
  assert.equal(status.bin, "cursor-agent-does-not-exist-xyz");
  assert.match(status.detail, /PATH/);
  assert.match(status.detail, /https:\/\/cursor\.com\/docs\/cli\/installation/);
  assert.match(status.detail, /CURSOR_BIN/);
});

test("CURSOR_API_KEY counts as logged in when binary exists", () => {
  const status = getCursorAuthStatus(process.cwd(), {
    CURSOR_BIN: process.execPath,
    CURSOR_API_KEY: "  test-key  "
  });

  assert.equal(status.available, true);
  assert.equal(status.loggedIn, true);
  assert.equal(status.bin, process.execPath);
  assert.equal(status.detail, "CURSOR_API_KEY is set.");
});

test("signal-killed status command does not count as logged in", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-auth-"));
  fs.writeFileSync(path.join(cwd, "status"), "", "utf8");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const status = getCursorAuthStatus(
    cwd,
    { CURSOR_BIN: process.execPath },
    () => ({
      status: 0,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      error: null
    })
  );

  assert.equal(status.available, true);
  assert.equal(status.loggedIn, false);
});

test("task rejects --effort instead of adding it to the prompt", (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-effort-state-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [path.join(root, "plugins/cursor/scripts/cursor-companion.mjs"), "task", "--effort", "high", "inspect this"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CURSOR_BIN: "cursor-agent-does-not-exist-xyz", PLUGIN_DATA: state }
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no --effort flag/i);
});
