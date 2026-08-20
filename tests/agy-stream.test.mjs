import assert from "node:assert/strict";
import test from "node:test";

import { applyAgyEvent } from "../plugins/gemini/scripts/lib/gemini.mjs";

test("agy result maps conversation_id and response", () => {
  const state = {};
  applyAgyEvent(state, {
    event: "init",
    conversation_id: "abc",
    init: { cwd: "/repo", model: "gemini-2.5-pro" }
  });
  applyAgyEvent(state, {
    event: "step_update",
    step_update: { step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" }, output: "hi" } }
  });
  applyAgyEvent(state, {
    event: "result",
    result: {
      conversation_id: "abc",
      status: "SUCCESS",
      response: "done\n",
      usage: { input_tokens: 10, output_tokens: 2 }
    }
  });
  assert.equal(state.sessionId, "abc");
  assert.equal(state.model, "gemini-2.5-pro");
  assert.equal(state.finalMessage.trim(), "done");
  assert.equal(state.commandExecutions[0].command, "echo hi");
  assert.deepEqual(state.stats, { input_tokens: 10, output_tokens: 2 });
});
