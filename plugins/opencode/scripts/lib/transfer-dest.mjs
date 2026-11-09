import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatCommandFailure, runCommand as defaultSpawnCommand } from "./process.mjs";

// opencode import expects export-shaped JSON; use a messages array of { role, content } when full export shape is unavailable.
export function buildOpencodeImportPayload(messages, { cwd, title } = {}) {
  return {
    cwd: cwd ?? null,
    title: title ?? "Transferred session",
    messages: (messages ?? []).map((message) => ({
      role: message.role,
      content: message.text ?? message.content ?? ""
    }))
  };
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

function opencodeId(prefix) {
  return `${prefix}_${crypto.randomBytes(13).toString("hex")}`;
}

// OpenCode V2 `session import` validates the `session export` shape; these are its required keys
// (checked against v2.2.6, which has no published schema).
export function buildOpencodeV2ImportPayload(messages, { cwd, title, now = Date.now() } = {}) {
  const tokens = () => structuredClone(ZERO_TOKENS);
  return {
    info: {
      id: opencodeId("ses"),
      projectID: "global",
      agent: "build",
      title: title ?? "Transferred session",
      subpath: "",
      cost: 0,
      tokens: tokens(),
      time: { created: now, updated: now },
      location: { directory: cwd ?? process.cwd() }
    },
    messages: (messages ?? []).map((message, index) => {
      const text = message.text ?? message.content ?? "";
      const time = now + index;
      if (message.role === "assistant") {
        return {
          id: opencodeId("msg"),
          type: "assistant",
          agent: "build",
          model: { id: "unknown", providerID: "unknown" },
          content: [{ type: "text", text }],
          cost: 0,
          tokens: tokens(),
          finish: "stop",
          time: { created: time, completed: time }
        };
      }
      return { id: opencodeId("msg"), type: "user", text, time: { created: time } };
    })
  };
}

export function parseOpencodeImportOutput(stdout) {
  const text = String(stdout ?? "");
  const labeled = text.match(/Imported session:\s+(\S+)/);
  if (labeled?.[1]) {
    return labeled[1];
  }
  const ses = text.match(/ses_[a-zA-Z0-9]+/);
  if (ses?.[0]) {
    return ses[0];
  }
  throw new Error(`Could not parse OpenCode session id from import output:\n${text.trim() || "(empty)"}`);
}

async function defaultRunCommand(argv, options = {}) {
  return defaultSpawnCommand("opencode", argv, options);
}

export async function importToOpencode(cwd, messages, options = {}) {
  const title = options.title ?? "Transferred session";
  const run = options.runCommand ?? defaultRunCommand;
  // V2 moved `import` under `session` and changed the payload; unknown versions get V2 (the default install).
  const v1 = options.majorVersion != null && options.majorVersion < 2;
  const payload = v1
    ? buildOpencodeImportPayload(messages, { cwd, title })
    : buildOpencodeV2ImportPayload(messages, { cwd, title });

  const importCommand = v1 ? ["import"] : ["session", "import"];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-import-"));
  const tmpFile = path.join(tmpDir, "session.json");
  fs.writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  let result;
  try {
    result = await run([...importCommand, tmpFile], { cwd });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  if (result?.error) {
    throw result.error;
  }
  if ((result?.status ?? 0) !== 0) {
    throw new Error(
      formatCommandFailure({
        command: "opencode",
        args: [...importCommand, tmpFile],
        status: result?.status ?? 1,
        signal: result?.signal ?? null,
        stdout: result?.stdout ?? "",
        stderr: result?.stderr ?? ""
      })
    );
  }

  const sessionId = parseOpencodeImportOutput(result?.stdout ?? "");
  return {
    sessionId,
    resumeCommand: `opencode -s ${sessionId}`
  };
}
