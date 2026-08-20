import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildHandoffPrompt,
  formatTransferResult
} from "../plugins/gemini/scripts/lib/transfer-dest.mjs";
import { buildHandoffPrompt as buildClaudeHandoffPrompt } from "../plugins/claude/scripts/lib/transfer-dest.mjs";
import {
  PACKED_TRANSCRIPT_LIMIT,
  capTranscriptMessages,
  packTranscript
} from "../plugins/opencode/scripts/lib/host-session.mjs";
import {
  buildOpencodeImportPayload,
  importToOpencode,
  parseOpencodeImportOutput
} from "../plugins/opencode/scripts/lib/transfer-dest.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("buildOpencodeImportPayload uses messages with role and content", () => {
  const payload = buildOpencodeImportPayload(
    [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" }
    ],
    { cwd: repoRoot, title: "Transfer test" }
  );
  assert.deepEqual(payload.messages, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ]);
});

test("parseOpencodeImportOutput reads Imported session line", () => {
  assert.equal(parseOpencodeImportOutput("Imported session: ses_test\n"), "ses_test");
});

test("parseOpencodeImportOutput falls back to ses_ id match", () => {
  assert.equal(parseOpencodeImportOutput("ok ses_abc123 done"), "ses_abc123");
});

test("importToOpencode calls runCommand with import and tempfile", async () => {
  const recorded = [];
  const result = await importToOpencode(
    repoRoot,
    [{ role: "user", text: "hello" }],
    {
      title: "Transfer test",
      runCommand: async (argv) => {
        recorded.push(argv);
        const filePath = argv[1];
        assert.equal(argv[0], "import");
        assert.ok(typeof filePath === "string" && filePath.length > 0);
        assert.ok(fs.existsSync(filePath), "temp import file should exist during runCommand");
        const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
        assert.deepEqual(written.messages, [{ role: "user", content: "hello" }]);
        return { status: 0, stdout: "Imported session: ses_test\n", stderr: "" };
      }
    }
  );

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0][0], "import");
  assert.match(recorded[0][1], /\.json$/i);
  assert.equal(result.sessionId, "ses_test");
  assert.equal(result.resumeCommand, "opencode -s ses_test");
});

test("OpenCode transfer caps messages to PACKED_TRANSCRIPT_LIMIT before import", async () => {
  const messages = [
    { role: "user", text: "OLD-".repeat(30_000) },
    { role: "assistant", text: "MID-".repeat(30_000) },
    { role: "user", text: "KEEP-TAIL" }
  ];
  const capped = capTranscriptMessages(messages);
  const packed = packTranscript(capped);
  assert.ok(packed.length <= PACKED_TRANSCRIPT_LIMIT);
  assert.ok(packed.includes("KEEP-TAIL"));
  assert.equal(packed.includes("OLD-".repeat(100)), false);

  let importedMessages = null;
  await importToOpencode(repoRoot, capped, {
    title: "Capped transfer",
    runCommand: async (argv) => {
      const written = JSON.parse(fs.readFileSync(argv[1], "utf8"));
      importedMessages = written.messages;
      return { status: 0, stdout: "Imported session: ses_capped\n", stderr: "" };
    }
  });

  assert.ok(Array.isArray(importedMessages));
  assert.ok(importedMessages.some((message) => message.content === "KEEP-TAIL"));
  assert.equal(
    importedMessages.some((message) => String(message.content).includes("OLD-".repeat(100))),
    false
  );
  assert.ok(packTranscript(capped).length <= PACKED_TRANSCRIPT_LIMIT);
});

test("buildHandoffPrompt appends continue instruction", () => {
  const prompt = buildHandoffPrompt("User: hello\nAssistant: hi");
  assert.match(prompt, /User: hello/);
  assert.match(prompt, /Continue this work in this repository\. Do not re-ask for the earlier context\./);
});

test("Claude handoff prompt appends continue instruction", () => {
  const prompt = buildClaudeHandoffPrompt("packed transcript");
  assert.match(prompt, /packed transcript/);
  assert.match(prompt, /Continue this work in this repository/);
});

test("formatTransferResult agy resume command", () => {
  const result = formatTransferResult({ backend: "agy", threadId: "x" });
  assert.equal(result.sessionId, "x");
  assert.equal(result.resumeCommand, "agy --conversation x");
});

test("formatTransferResult gemini resume command", () => {
  const result = formatTransferResult({ backend: "gemini", threadId: "sess-1" });
  assert.equal(result.sessionId, "sess-1");
  assert.equal(result.resumeCommand, "gemini -r sess-1");
});
