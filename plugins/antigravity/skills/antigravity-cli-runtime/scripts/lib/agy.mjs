import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { npmShimTarget, runCommand } from "./process.mjs";

const MISSING_BIN_DETAIL =
  "`agy` was not found on PATH. Install Antigravity CLI (the bridge uses its ACP server, see https://antigravity.google/docs/cli/acp.md) then rerun setup. Optional: set ANTIGRAVITY_BIN.";

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
  // Windows searches the working folder before PATH, so never launch a bare name there.
  if (platform === "win32" && !path.win32.isAbsolute(bin)) throw new Error(`${bin} was not found on PATH`);
  if (platform !== "win32" || path.extname(bin).toLowerCase() !== ".cmd") {
    return { file: bin, args: [] };
  }

  const shim = npmShimTarget(bin);
  if (shim) return shim;
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
  "Sign-in cannot be checked without a run. Sign in once with an interactive `agy` session, or run `agy acp --login`. Only the Google sign-in cached by `agy` is supported; API keys are not.";

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
  // Windows runs only a name with an extension, so try the bare name only when it already has one.
  const extensions = platform === "win32" && !path.extname(bin)
    ? [...String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean)]
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
    signInNote: SIGN_IN_NOTE
  };
}

/** The thinking levels `agy acp` offers as its `thought_level` option. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];

export function validateEffort(value) {
  if (value === undefined || value === null) return;
  if (!EFFORT_LEVELS.includes(value)) {
    throw new Error(`Unknown effort "${value}"; use one of: ${EFFORT_LEVELS.join(", ")}.`);
  }
}

export function formatDeniedActions(list) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => (entry?.display_name ? `${entry.action} (${entry.display_name})` : String(entry?.action ?? "unknown")))
    .join(", ");
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
