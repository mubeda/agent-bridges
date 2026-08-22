import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveStateRoot as resolveOpencodeStateRoot } from "../plugins/opencode/scripts/lib/state.mjs";
import { resolveStateRoot as resolveGeminiStateRoot } from "../plugins/gemini/scripts/lib/state.mjs";
import { resolveStateRoot as resolveClaudeStateRoot } from "../plugins/claude/scripts/lib/state.mjs";
import { resolveStateRoot as resolveCursorStateRoot } from "../plugins/cursor/scripts/lib/state.mjs";

test("default state roots are companion dirs", () => {
  const env = { ...process.env };
  delete env.PLUGIN_DATA;
  delete env.MAU_PLUGIN_DATA;
  delete env.CLAUDE_PLUGIN_DATA;
  assert.equal(
    resolveOpencodeStateRoot(env),
    path.join(os.homedir(), ".opencode-companion", "state")
  );
  assert.equal(
    resolveGeminiStateRoot(env),
    path.join(os.homedir(), ".gemini-companion", "state")
  );
  assert.equal(
    resolveClaudeStateRoot(env),
    path.join(os.homedir(), ".claude-companion", "state")
  );
  assert.equal(
    resolveCursorStateRoot(env),
    path.join(os.homedir(), ".cursor-companion", "state")
  );
});

test("PLUGIN_DATA wins over CLAUDE_PLUGIN_DATA", () => {
  const env = {
    PLUGIN_DATA: path.join(os.tmpdir(), "plugin-data"),
    CLAUDE_PLUGIN_DATA: path.join(os.tmpdir(), "claude-data")
  };
  assert.equal(resolveOpencodeStateRoot(env), path.join(env.PLUGIN_DATA, "state"));
  assert.equal(resolveGeminiStateRoot(env), path.join(env.PLUGIN_DATA, "state"));
  assert.equal(resolveClaudeStateRoot(env), path.join(env.PLUGIN_DATA, "state"));
  assert.equal(resolveCursorStateRoot(env), path.join(env.PLUGIN_DATA, "state"));
});

test("CLAUDE_PLUGIN_DATA is used when PLUGIN_DATA is unset", () => {
  const env = { CLAUDE_PLUGIN_DATA: path.join(os.tmpdir(), "claude-data") };
  delete env.PLUGIN_DATA;
  assert.equal(resolveOpencodeStateRoot(env), path.join(env.CLAUDE_PLUGIN_DATA, "state"));
  assert.equal(resolveClaudeStateRoot(env), path.join(env.CLAUDE_PLUGIN_DATA, "state"));
  assert.equal(resolveCursorStateRoot(env), path.join(env.CLAUDE_PLUGIN_DATA, "state"));
});
