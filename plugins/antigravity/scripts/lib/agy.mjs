import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./process.mjs";

export const WIN32_ARGV_PROMPT_LIMIT = 20_000;

const MISSING_BIN_DETAIL =
  "`agy` was not found on PATH. Install Antigravity CLI from https://antigravity.google/docs/cli/headless.md then rerun setup. Optional: set ANTIGRAVITY_BIN.";

/** Linux caps one argv string at 128 KiB (MAX_ARG_STRLEN), so larger prompts go on stdin everywhere. */
export const ARGV_PROMPT_BYTE_LIMIT = 100_000;

export function shouldPassPromptViaStdin(prompt, platform = process.platform) {
  if (typeof prompt !== "string") return false;
  if (platform === "win32" && prompt.length > WIN32_ARGV_PROMPT_LIMIT) return true;
  return Buffer.byteLength(prompt, "utf8") > ARGV_PROMPT_BYTE_LIMIT;
}

export function resolveAgyBin(env = process.env) {
  const override = typeof env.ANTIGRAVITY_BIN === "string" ? env.ANTIGRAVITY_BIN.trim() : "";
  return override || "agy";
}

/**
 * Resolve a Windows command name to an executable path before calling spawn.
 * `runCommand` can use cmd.exe for setup checks, but foreground work must not
 * place the user prompt on a shell command line.
 */
export function resolveAgySpawnBin(env = process.env, platform = process.platform) {
  const bin = resolveAgyBin(env);
  if (platform !== "win32" || path.isAbsolute(bin) || /[\\/]/.test(bin)) {
    return bin;
  }

  // Absolute entries only: the working folder must never supply the CLI (Windows searches it first).
  const pathEntries = String(env.PATH ?? "").split(path.delimiter).filter((entry) => path.win32.isAbsolute(entry));
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

export function resolveAgySpawnCommand(env = process.env, platform = process.platform) {
  const bin = resolveAgySpawnBin(env, platform);
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

/** Node cannot start a .cmd or .bat without a shell, and the prompt must never go through one. */
export function unsupportedLauncher(env = process.env, platform = process.platform) {
  if (platform !== "win32") return null;
  const { file } = resolveAgySpawnCommand(env, platform);
  const extension = path.extname(file).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") return null;
  return `${file} is a ${extension} launcher with no .ps1 next to it, so Antigravity jobs cannot start it. Set ANTIGRAVITY_BIN to the .exe, or to a launcher that ships a .ps1.`;
}

export const SIGN_IN_NOTE =
  "Sign-in cannot be checked without a run. Sign in once with an interactive `agy` session, or set GEMINI_API_KEY with modelProvider \"gemini\" in your Antigravity settings.";

/** The absolute file `bin` resolves to on PATH, or `bin` itself when it already names a path. */
function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findOnPath(bin, env = process.env, platform = process.platform) {
  if (path.isAbsolute(bin) || /[\\/]/.test(bin)) return bin;
  const extensions = platform === "win32"
    ? ["", ...String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean)]
    : [""];
  for (const directory of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${bin}${extension}`);
      try {
        if (fs.statSync(candidate).isFile() && (platform === "win32" || isExecutable(candidate))) return candidate;
      } catch {
        // not in this directory
      }
    }
  }
  return null;
}

export function getAgyAvailability(cwd, env = process.env, runCommandImpl = runCommand) {
  const bin = resolveAgyBin(env);
  const result = runCommandImpl(bin, ["--version"], { cwd, env });
  // runCommand maps a null exit status to 0, so a signal-killed probe must be checked explicitly.
  const probed = !result.error && !result.signal && result.status === 0;
  const launcherProblem = probed ? unsupportedLauncher(env) : null;
  const available = probed && !launcherProblem;
  const version = probed ? (result.stdout || result.stderr || "").trim() : null;
  return {
    available,
    bin,
    version,
    detail: available ? `${bin} ${version}` : launcherProblem ?? MISSING_BIN_DETAIL
  };
}

export function getAgySetupFacts(cwd, env = process.env, runCommandImpl = runCommand) {
  const availability = getAgyAvailability(cwd, env, runCommandImpl);
  return {
    ...availability,
    resolvedPath: findOnPath(availability.bin, env),
    apiKeySet: typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim() !== "",
    signInNote: SIGN_IN_NOTE
  };
}

/** Read-only runs deny every file write and every shell command for the session (spec D2). */
export const READ_ONLY_SETTINGS = '{"permissions":{"deny":["write_file(*)","command(*)"]}}';
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export function validateEffort(value) {
  if (value === undefined || value === null) return;
  if (!EFFORT_LEVELS.includes(value)) {
    throw new Error(`Unknown effort "${value}"; use one of: ${EFFORT_LEVELS.join(", ")}.`);
  }
}

export function buildRunArgs(options = {}) {
  const prompt = options.prompt;
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("buildRunArgs: a non-empty prompt is required.");
  }
  validateEffort(options.effort);
  const review = options.review === true;
  const write = review ? false : options.write === true;
  const args = write ? ["--dangerously-skip-permissions"] : ["--settings", READ_ONLY_SETTINGS];
  if (options.model) args.push("--model", String(options.model));
  if (options.effort) args.push("--effort", String(options.effort));
  if (options.resumeSessionId) args.push("--conversation", String(options.resumeSessionId));
  args.push("--output-format", "json");
  if (review && options.schemaPath) args.push("--json-schema", String(options.schemaPath));
  const platform = options.platform ?? process.platform;
  // On win32 above the argv limit the prompt goes on stdin, with no -p at all.
  if (!shouldPassPromptViaStdin(prompt, platform)) args.push("-p", prompt);
  return args;
}

export function buildReviewArgs(options = {}) {
  return buildRunArgs({ ...options, write: false, review: true });
}

/** One platform decision for both the argv and the stdin payload. */
export function buildPrintInvocation(options = {}) {
  const platform = options.platform ?? process.platform;
  const args = options.review ? buildReviewArgs({ ...options, platform }) : buildRunArgs({ ...options, platform });
  return { args, stdin: shouldPassPromptViaStdin(options.prompt, platform) ? options.prompt : null };
}

export function formatDeniedActions(list) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => (entry?.display_name ? `${entry.action} (${entry.display_name})` : String(entry?.action ?? "unknown")))
    .join(", ");
}

function readEnvelope(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    const raw = JSON.parse(text.slice(start));
    return raw && typeof raw === "object" && ("status" in raw || "conversation_id" in raw || "response" in raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Parse one `agy --output-format json` run (spec R7, R10, R11, R12). */
export function parsePrintResult(stdout, { requestedConversationId = null, exitCode = 0, stderr = "" } = {}) {
  const text = String(stdout ?? "");
  const raw = readEnvelope(text);
  if (!raw) {
    // Non-JSON stdout: the plain-text path, failed only by the exit code.
    const ok = exitCode === 0;
    return {
      sessionId: null,
      resultText: text.trim(),
      structured: null,
      status: null,
      ok,
      error: ok ? null : String(stderr ?? "").trim() || `agy exited ${exitCode}.`,
      deniedActions: [],
      warning: null,
      raw: null
    };
  }
  const status = typeof raw.status === "string" ? raw.status : null;
  const ok = exitCode === 0 && status === "SUCCESS";
  const sessionId = raw.conversation_id ? String(raw.conversation_id) : null;
  const deniedActions = Array.isArray(raw.denied_actions) ? raw.denied_actions : [];
  const response = typeof raw.response === "string" ? raw.response.trim() : "";
  let resultText = response;
  if (deniedActions.length) {
    const denied = formatDeniedActions(deniedActions);
    resultText = response ? `${response}\nDenied: ${denied}` : `no answer; denied: ${denied}`;
  }
  // Only a JSON object counts as a structured review; anything else keeps the plain text visible (R7).
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const fromResponse = parseStructuredResult(response);
  const structured = isObject(raw.structured_output) ? raw.structured_output : isObject(fromResponse) ? fromResponse : null;
  const warning =
    requestedConversationId && sessionId && sessionId !== String(requestedConversationId)
      ? `conversation ${requestedConversationId} not found; Antigravity started a new one`
      : null;
  return {
    sessionId,
    resultText,
    structured,
    status,
    ok,
    error: ok ? null : (typeof raw.error === "string" && raw.error) || String(stderr ?? "").trim() || `agy returned status ${status ?? "unknown"}.`,
    deniedActions,
    warning,
    raw
  };
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
