import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseStopReviewOutput } from "../plugins/opencode/scripts/stop-review-gate-hook.mjs";
import {
  getConfig as getOpencodeConfig,
  setConfig as setOpencodeConfig
} from "../plugins/opencode/scripts/lib/state.mjs";
import {
  getConfig as getGeminiConfig,
  setConfig as setGeminiConfig
} from "../plugins/gemini/scripts/lib/state.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("ALLOW and BLOCK parse", () => {
  assert.equal(parseStopReviewOutput("ALLOW: no edits").ok, true);
  assert.equal(parseStopReviewOutput("BLOCK: leak").ok, false);
});

test("hooks.json is Stop-only", () => {
  for (const plugin of ["opencode", "gemini"]) {
    const hooks = JSON.parse(
      fs.readFileSync(path.join(ROOT, "plugins", plugin, "hooks", "hooks.json"), "utf8")
    );
    assert.ok(hooks.hooks.Stop);
    assert.equal(hooks.hooks.SessionStart, undefined);
    assert.equal(hooks.hooks.SessionEnd, undefined);
    assert.equal(hooks.hooks.Stop[0].hooks[0].timeout, 900);
  }
});

test("plugin.json does not redeclare auto-loaded hooks/hooks.json", () => {
  for (const plugin of ["opencode", "gemini"]) {
    const pluginRoot = path.join(ROOT, "plugins", plugin);
    const defaultHooks = path.resolve(pluginRoot, "hooks", "hooks.json");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")
    );
    assert.equal(fs.existsSync(defaultHooks), true);
    if (typeof manifest.hooks === "string") {
      const declared = path.resolve(pluginRoot, manifest.hooks);
      assert.notEqual(
        path.normalize(declared),
        path.normalize(defaultHooks),
        `${plugin} plugin.json hooks must not point at the auto-loaded hooks/hooks.json`
      );
    }
  }
});

test("setup.md advertises review-gate flags", () => {
  for (const plugin of ["opencode", "gemini"]) {
    const setup = fs.readFileSync(
      path.join(ROOT, "plugins", plugin, "commands", "setup.md"),
      "utf8"
    );
    assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  }
});

test("setConfig stopReviewGate toggles via PLUGIN_DATA", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-gate-"));
  const cwd = path.join(tmp, "workspace");
  fs.mkdirSync(cwd);
  const prev = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = path.join(tmp, "plugin-data");
  try {
    setOpencodeConfig(cwd, "stopReviewGate", true);
    assert.equal(getOpencodeConfig(cwd).stopReviewGate, true);
    setOpencodeConfig(cwd, "stopReviewGate", false);
    assert.equal(getOpencodeConfig(cwd).stopReviewGate, false);

    setGeminiConfig(cwd, "stopReviewGate", true);
    assert.equal(getGeminiConfig(cwd).stopReviewGate, true);
  } finally {
    if (prev === undefined) {
      delete process.env.PLUGIN_DATA;
    } else {
      process.env.PLUGIN_DATA = prev;
    }
  }
});

test("stop-review-gate hook spawns read-only task", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "plugins", "opencode", "scripts", "stop-review-gate-hook.mjs"),
    "utf8"
  );
  assert.match(source, /task.*--json/);
  assert.doesNotMatch(source, /--write/);
  assert.doesNotMatch(source, /--auto/);
});

test("stop-review-gate prompt uses host wording", () => {
  const prompt = fs.readFileSync(
    path.join(ROOT, "plugins", "opencode", "prompts", "stop-review-gate.md"),
    "utf8"
  );
  assert.match(prompt, /previous host turn/i);
  assert.doesNotMatch(prompt, /previous Claude turn/);
});
