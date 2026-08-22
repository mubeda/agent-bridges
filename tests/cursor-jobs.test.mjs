import assert from "node:assert/strict";
import test from "node:test";
import { parsePrintResult, parseStructuredResult } from "../plugins/cursor/scripts/lib/cursor.mjs";

test("parsePrintResult reads session_id and result", () => {
  const parsed = parsePrintResult(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "looks fine",
    session_id: "c6b62c6f-7ead-4fd6-9922-e952131177ff"
  }));
  assert.equal(parsed.sessionId, "c6b62c6f-7ead-4fd6-9922-e952131177ff");
  assert.equal(parsed.resultText, "looks fine");
});

test("parsePrintResult ignores leading noise then reads JSON", () => {
  const parsed = parsePrintResult("warn\n{\"result\":\"ok\",\"session_id\":\"abc\"}");
  assert.equal(parsed.sessionId, "abc");
  assert.equal(parsed.resultText, "ok");
});

test("parsePrintResult returns text when JSON is missing", () => {
  const parsed = parsePrintResult("not json");
  assert.equal(parsed.sessionId, null);
  assert.equal(parsed.resultText, "not json");
});

test("parseStructuredResult accepts JSON fenced result text", () => {
  assert.deepEqual(parseStructuredResult("```json\n{\"findings\": []}\n```"), { findings: [] });
});
