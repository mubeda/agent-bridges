import assert from "node:assert/strict";
import test from "node:test";

import { renderSetupReport } from "../plugins/opencode/scripts/lib/render.mjs";

test("setup report keeps review gate with Claude-only wording", () => {
  const text = renderSetupReport({
    ready: false,
    node: { detail: "ok" },
    npm: { detail: "ok" },
    opencode: { detail: "ok" },
    auth: { detail: "missing" },
    sessionRuntime: { label: "direct" },
    reviewGateEnabled: true,
    actionsTaken: [],
    nextSteps: []
  });
  assert.match(text, /review gate:/i);
  assert.match(text, /Claude Stop hook only/);
});
