import assert from "node:assert/strict";
import test from "node:test";

import { formatResumeCommand, renderSetupReport } from "../plugins/gemini/scripts/lib/render.mjs";

test("formatResumeCommand depends on backend", () => {
  assert.equal(formatResumeCommand("agy", "abc"), "agy --conversation abc");
  assert.equal(formatResumeCommand("gemini", "abc"), "gemini -r abc");
});

test("setup report keeps review gate and names backend", () => {
  const text = renderSetupReport({
    ready: false,
    node: { detail: "ok" },
    npm: { detail: "ok" },
    gemini: { detail: "agy 1.0" },
    auth: { detail: "missing" },
    backend: "agy",
    sessionRuntime: { label: "direct" },
    reviewGateEnabled: true,
    actionsTaken: [],
    nextSteps: []
  });
  assert.match(text, /backend: agy/);
  assert.match(text, /Claude Stop hook only/);
});
