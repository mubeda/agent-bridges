import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { binaryAvailable, runCommand } from "./process.mjs";

export const WIN32_ARGV_PROMPT_LIMIT = 20_000;

const MISSING_BIN_DETAIL =
  "`agent` was not found on PATH. Install Cursor CLI from https://cursor.com/docs/cli/installation then rerun setup. Optional: set CURSOR_BIN.";

export function shouldPassPromptViaStdin(prompt, platform = process.platform) {
  return platform === "win32" && typeof prompt === "string" && prompt.length > WIN32_ARGV_PROMPT_LIMIT;
}

export function resolveCursorBin(env = process.env) {
  const override = typeof env.CURSOR_BIN === "string" ? env.CURSOR_BIN.trim() : "";
  return override || "agent";
}

/**
 * Resolve a Windows command name to an executable path before calling spawn.
 * `runCommand` can use cmd.exe for setup checks, but foreground work must not
 * place the user prompt on a shell command line.
 */
export function resolveCursorSpawnBin(env = process.env, platform = process.platform) {
  const bin = resolveCursorBin(env);
  if (platform !== "win32" || path.isAbsolute(bin) || /[\\/]/.test(bin)) {
    return bin;
  }

  const pathEntries = String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  const orderedExtensions = [".cmd", ".exe", ...extensions.filter((extension) => extension !== ".cmd" && extension !== ".exe")];
  for (const directory of pathEntries) {
    for (const extension of orderedExtensions) {
      const candidate = path.join(directory, `${bin}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return bin;
}

export function resolveCursorSpawnCommand(env = process.env, platform = process.platform) {
  const bin = resolveCursorSpawnBin(env, platform);
  if (platform !== "win32" || path.extname(bin).toLowerCase() !== ".cmd") {
    return { file: bin, args: [] };
  }

  const script = path.join(path.dirname(bin), `${path.basename(bin, ".cmd")}.ps1`);
  if (!fs.existsSync(script)) {
    return { file: bin, args: [] };
  }

  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return {
    file: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
  };
}

export function getCursorAvailability(cwd, env = process.env) {
  const bin = resolveCursorBin(env);
  const status = binaryAvailable(bin, ["--version"], { cwd });
  return {
    available: status.available,
    loggedIn: false,
    bin,
    detail: status.available ? status.detail || `${bin} is available.` : MISSING_BIN_DETAIL
  };
}

export function getCursorAuthStatus(cwd, env = process.env, runCommandImpl = runCommand) {
  const availability = getCursorAvailability(cwd, env);
  if (!availability.available) {
    return availability;
  }
  if (typeof env.CURSOR_API_KEY === "string" && env.CURSOR_API_KEY.trim()) {
    return {
      available: true,
      loggedIn: true,
      bin: availability.bin,
      detail: "CURSOR_API_KEY is set."
    };
  }

  const result = runCommandImpl(availability.bin, ["status"], { cwd });
  const loggedIn = !result.error && !result.signal && result.status === 0;
  return {
    available: true,
    loggedIn,
    bin: availability.bin,
    detail: loggedIn
      ? "Logged in (`agent status` exited 0)."
      : "Not logged in (`agent status` did not exit 0)."
  };
}

export function buildRunArgs(options = {}) {
  const prompt = options.prompt;
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("buildRunArgs: a non-empty prompt is required.");
  }
  if (options.effort) {
    throw new Error("Cursor Agent CLI has no --effort flag; omit --effort.");
  }
  const review = options.review === true;
  const write = review ? false : options.write === true;
  const args = [];
  if (!write) {
    args.push("--mode", "plan");
  } else {
    args.push("--force");
  }
  args.push("--trust");
  if (options.model) args.push("--model", String(options.model));
  if (options.resumeSessionId) args.push("--resume", String(options.resumeSessionId));
  args.push("--output-format", "json");
  args.push("-p");
  const platform = options.platform ?? process.platform;
  if (!shouldPassPromptViaStdin(prompt, platform)) args.push(prompt);
  return args;
}

export function buildReviewArgs(options = {}) {
  return buildRunArgs({ ...options, write: false, review: true });
}

export function parsePrintResult(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  if (start === -1) {
    return { sessionId: null, resultText: text.trim(), raw: null };
  }
  try {
    const raw = JSON.parse(text.slice(start));
    return {
      sessionId: raw.session_id ?? raw.sessionId ?? null,
      resultText: typeof raw.result === "string" ? raw.result : text.trim(),
      raw
    };
  } catch {
    return { sessionId: null, resultText: text.trim(), raw: null };
  }
}

export function parseStructuredResult(resultText) {
  const unfenced = String(resultText ?? "")
    .trim()
    .replace(/^```(?:json)?\s*\r?\n?/i, "")
    .replace(/\r?\n?```\s*$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}
