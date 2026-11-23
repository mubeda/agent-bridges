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
  // Only a .cmd can be a shim; never read a native .exe, which can be tens of megabytes.
  if (path.extname(String(cmdFile ?? "")).toLowerCase() !== ".cmd") return null;
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

/** Linux /proc/<pid>/stat: the state letter (field 3) and the start time in clock ticks (field 22), or null. */
function readProcStat(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may hold spaces and parentheses: the fields after it start past the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], startTime: fields[19] };
  } catch {
    return { state: null, startTime: null };
  }
}

/** A process's identity beside its pid: its Linux start time. null where none can be read (other systems). */
export function processIdentity(pid) {
  return readProcStat(pid)?.startTime ?? null;
}

/**
 * "dead": gone, a zombie, or the pid now names a process with another start time; "alive" otherwise.
 * Without a recorded identity (other systems, old records) a pid that answers signal 0 counts as alive.
 */
export function processState(pid, identity) {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  const stat = readProcStat(pid);
  if (stat) {
    if (!stat.state || stat.state === "Z") return "dead";
    return identity && stat.startTime !== identity ? "dead" : "alive";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return error.code === "EPERM" ? "alive" : "dead";
  }
}

/**
 * True only when the pid provably still names the recorded process: the only case in which it may be signalled.
 * A zombie with the recorded start time still counts: its pid cannot be reused before it is reaped.
 */
export function isSameProcess(pid, identity) {
  const stat = readProcStat(pid);
  return Boolean(identity && stat?.startTime && stat.startTime === identity);
}
