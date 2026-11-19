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
  const payload = buildOpencodeImportPayload(messages, { cwd, title });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-import-"));
  const tmpFile = path.join(tmpDir, "session.json");
  fs.writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  let result;
  try {
    result = await run(["import", tmpFile], { cwd });
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
        args: ["import", tmpFile],
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
