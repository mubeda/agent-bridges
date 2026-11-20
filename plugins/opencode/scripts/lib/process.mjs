import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** cmd.exe splits an unquoted path at its first space, so quote a command that has one. */
export function quoteForShell(command) {
  return /\s/.test(command) && !command.startsWith('"') ? `"${command}"` : command;
}

export function runCommand(command, args = [], options = {}) {
  const shell = options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false);
  const resolved = resolveOnTrustedPath(command, options.env ?? process.env, process.platform, options.cwd ?? process.cwd());
  if (resolved === null) {
    const error = Object.assign(new Error(`${command} was not found on PATH`), { code: "ENOENT" });
    return { command, args, status: 1, signal: null, stdout: "", stderr: "", error };
  }
  const result = spawnSync(shell ? quoteForShell(resolved) : resolved, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    // Whether the group-kill failed because no such group exists (ESRCH —
    // the pid is not a process group leader, common for normal Bash-launched
    // children) or for any other reason, still try the single-process kill
    // before giving up. The earlier behavior reported success without ever
    // attempting kill(pid), so cancel could lie about stopping the job.
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process-group" };
      }
      throw innerError;
    }
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

function findWindowsCommand(bin, env) {
  if (path.isAbsolute(bin) || /[\\/]/.test(bin)) return bin;
  const extensions = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
  const ordered = [".cmd", ".exe", ...extensions.filter((ext) => ext !== ".cmd" && ext !== ".exe")];
  for (const directory of String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter((entry) => path.win32.isAbsolute(entry))) {
    for (const extension of ordered) {
      const candidate = path.join(directory, `${bin}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return bin;
}

/** A .cmd or .bat with no .ps1 beside it cannot be started without a shell, and prompts must never go through one. */
export function unsupportedLauncher(bin, env = process.env, platform = process.platform) {
  if (platform !== "win32") return null;
  const file = findWindowsCommand(bin, env);
  const extension = path.extname(file).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") return null;
  if (npmShimTarget(file)) return null;
  const script = path.join(path.dirname(file), `${path.basename(file, extension)}.ps1`);
  if (fs.existsSync(script)) return null;
  return `${file} is a ${extension} launcher with no .ps1 next to it, so jobs cannot start it. Install the CLI so it ships a .ps1 or an .exe.`;
}

/** Windows npm installs a .cmd shim; Node cannot spawn it without a shell, so start its target, or else run its .ps1 through PowerShell. */
export function resolveSpawnCommand(bin, env = process.env, platform = process.platform) {
  if (platform !== "win32") return { file: bin, args: [] };
  const problem = unsupportedLauncher(bin, env, platform);
  if (problem) throw new Error(problem);
  const file = findWindowsCommand(bin, env);
  // Windows searches the working folder before PATH, so never launch a bare name there.
  if (platform === "win32" && !path.win32.isAbsolute(file)) throw new Error(`${file} was not found on PATH`);
  if (path.extname(file).toLowerCase() !== ".cmd") return { file, args: [] };
  const shim = npmShimTarget(file);
  if (shim) return shim;
  const script = path.join(path.dirname(file), `${path.basename(file, ".cmd")}.ps1`);
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return {
    file: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
  };
}

/**
 * On Windows, cmd.exe and CreateProcess look in the working folder before PATH, so a checkout could
 * plant agy.cmd or git.exe and have it run. Resolve a bare name from absolute PATH entries only.
 */
export function resolveOnTrustedPath(command, env = process.env, platform = process.platform, cwd = process.cwd()) {
  if (platform !== "win32") return command;
  if (/[\\/]/.test(command) || /^[a-zA-Z]:/.test(command)) return command;
  const hasExtension = /\.[^.\\/]+$/.test(command);
  const extensions = hasExtension
    ? [""]
    : String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
  const entries = String(env.PATH ?? env.Path ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => /^[a-zA-Z]:[\\/]/.test(entry) || entry.startsWith("\\\\") || (path.isAbsolute(entry) && entry !== cwd));
  for (const directory of entries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * npm's .cmd shim names the Node script or .exe it starts. Launching that target directly skips cmd.exe
 * and PowerShell: the npm .ps1 pipes stdin through Windows PowerShell 5.1, which turns non-ASCII into ?.
 */
export function npmShimTarget(cmdFile) {
  let text;
  try {
    text = fs.readFileSync(cmdFile, "utf8");
  } catch {
    return null;
  }
  const viaNode = /SET "_prog=node"/i.test(text) ? text.match(/"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/) : null;
  const direct = viaNode ? null : text.match(/^"%dp0%\\([^"]+\.(?:exe|com))"\s+%\*\s*$/im);
  const relative = (viaNode ?? direct)?.[1];
  if (!relative) return null;
  const target = path.resolve(path.dirname(cmdFile), relative.replace(/\\/g, path.sep));
  if (!fs.existsSync(target)) return null;
  // The running Node, never a bare node, which Windows would look up in the working folder first.
  return viaNode ? { file: process.execPath, args: [target] } : { file: target, args: [] };
}
