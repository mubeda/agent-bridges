import assert from "node:assert/strict";
import test from "node:test";
import {
  formatResumeCommand,
  renderSetupReport,
  renderStoredJobResult
} from "../plugins/claude/scripts/lib/render.mjs";

test("formatResumeCommand depends on invoke", () => {
  assert.equal(
    formatResumeCommand({ invoke: "bg", shortId: "7c5dcf5d" }),
    "claude attach 7c5dcf5d"
  );
  assert.equal(
    formatResumeCommand({ invoke: "print", claudeSessionId: "abc" }),
    "claude -r abc"
  );
});

test("setup report names claude and bypass disclaimer, not review-gate enablement", () => {
  const text = renderSetupReport({
    ready: true,
    node: { detail: "ok" },
    npm: { detail: "ok" },
    claude: { detail: "claude 2.1.x" },
    auth: { detail: "logged in" },
    bypassDisclaimer: { accepted: false, detail: "run claude --dangerously-skip-permissions once" },
    actionsTaken: [],
    nextSteps: ["run claude --dangerously-skip-permissions once"]
  });
  assert.match(text, /claude/);
  assert.match(text, /dangerously-skip-permissions/);
  assert.doesNotMatch(text, /enable-review-gate/);
});

test("stored print reviews prefer the rendered structured result", () => {
  const output = renderStoredJobResult(
    { id: "review-1", status: "completed", title: "Claude Review" },
    {
      invoke: "print",
      rendered: "# Claude Review\n\nStructured finding.\n",
      result: {
        rawOutput: "{\"verdict\":\"needs-attention\"}",
        structuredOutput: { verdict: "needs-attention" }
      }
    }
  );

  assert.match(output, /Structured finding/);
  assert.doesNotMatch(output, /\{"verdict"/);
});
