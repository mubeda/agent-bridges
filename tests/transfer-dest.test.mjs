import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildHandoffPrompt } from "../plugins/cursor/scripts/lib/transfer-dest.mjs";
import { buildHandoffPrompt as buildClaudeHandoffPrompt } from "../plugins/claude/scripts/lib/transfer-dest.mjs";
import {
  PACKED_TRANSCRIPT_LIMIT,
  capTranscriptMessages,
  packTranscript
} from "../plugins/opencode/scripts/lib/host-session.mjs";
import {
  buildOpencodeImportPayload,
  buildOpencodeV2ImportPayload,
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

test("importToOpencode calls runCommand with import and tempfile on V1", async () => {
  const recorded = [];
  const result = await importToOpencode(
    repoRoot,
    [{ role: "user", text: "hello" }],
    {
      title: "Transfer test",
      majorVersion: 1,
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
    majorVersion: 1,
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

test("importToOpencode uses session import with the export shape on V2", async () => {
  let argvSeen = null;
  let written = null;
  const result = await importToOpencode(
    repoRoot,
    [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" }
    ],
    {
      title: "V2 transfer",
      majorVersion: 2,
      runCommand: async (argv) => {
        argvSeen = argv;
        written = JSON.parse(fs.readFileSync(argv[2], "utf8"));
        return { status: 0, stdout: "Imported session: ses_v2\n", stderr: "" };
      }
    }
  );
  assert.deepEqual(argvSeen.slice(0, 2), ["session", "import"]);
  assert.equal(written.info.location.directory, repoRoot);
  assert.match(written.info.id, /^ses_/);
  assert.deepEqual(
    written.messages.map((m) => [m.type, m.text ?? m.content[0].text]),
    [
      ["user", "hello"],
      ["assistant", "hi"]
    ]
  );
  assert.equal(result.sessionId, "ses_v2");
});

test("buildOpencodeV2ImportPayload fills every key V2 requires", () => {
  const payload = buildOpencodeV2ImportPayload([{ role: "assistant", text: "x" }], { cwd: "/r" });
  for (const key of ["id", "projectID", "agent", "title", "subpath", "cost", "tokens", "time", "location"]) {
    assert.ok(key in payload.info, key);
  }
  for (const key of ["id", "agent", "model", "content", "cost", "tokens", "finish", "time"]) {
    assert.ok(key in payload.messages[0], key);
  }
});
