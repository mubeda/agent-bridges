import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { binaryAvailable, runCommand } from "./process.mjs";

export const WIN32_ARGV_PROMPT_LIMIT = 20_000;

export function shouldPassPromptViaStdin(prompt, platform = process.platform) {
  return platform === "win32" && typeof prompt === "string" && prompt.length > WIN32_ARGV_PROMPT_LIMIT;
}

export function resolveClaudeBin(env = process.env) {
  const override = typeof env.CLAUDE_BIN === "string" ? env.CLAUDE_BIN.trim() : "";
  return override || "claude";
}

export function buildClaudeSpawnOptions(cwd, env = process.env) {
  return {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  };
}

export function buildRunArgs(options = {}) {
  const prompt = options.prompt;
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("buildRunArgs: a non-empty prompt is required.");
  }
  const invoke = options.invoke === "bg" ? "bg" : "print";
  const review = options.review === true;
  const write = review ? false : options.write === true;
  const args = [];

  if (invoke === "bg") {
    args.push("--bg");
    if (options.name) {
      args.push("--name", String(options.name));
    }
  }

  if (write) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "plan");
  }

  if (options.model) {
    args.push("--model", String(options.model));
  }
  if (options.effort) {
    args.push("--effort", String(options.effort));
  }
  if (options.resumeSessionId) {
    args.push("-r", String(options.resumeSessionId));
  } else if (options.resumeLatest) {
    args.push("-c");
  }

  if (invoke === "print") {
    args.push("--output-format", "json");
    if (review && options.schemaPath) {
      args.push("--json-schema", String(options.schemaPath));
    }
    const platform = options.platform ?? process.platform;
    args.push("-p");
    if (!shouldPassPromptViaStdin(prompt, platform)) args.push(prompt);
    return args;
  }

  const platform = options.platform ?? process.platform;
  if (shouldPassPromptViaStdin(prompt, platform)) {
    if (!options.promptFile) {
      throw new Error("buildRunArgs: promptFile is required for an oversized Windows background prompt.");
    }
    const promptFile = path.resolve(String(options.promptFile));
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, prompt, "utf8");
    args.push(`Read and follow the complete prompt in this UTF-8 file: ${promptFile}`);
  } else {
    args.push(prompt);
  }
  return args;
}

export function buildReviewArgs(options = {}) {
  return buildRunArgs({ ...options, write: false, review: true });
}

const MISSING_BIN_DETAIL =
  "`claude` was not found on PATH. Install Claude Code from https://code.claude.com/docs/en/setup then rerun setup. Optional: set CLAUDE_BIN to the binary.";

export function getClaudeAvailability(cwd, env = process.env) {
  const bin = resolveClaudeBin(env);
  const status = binaryAvailable(bin, ["--version"], { cwd });
  return {
    available: status.available,
    bin,
    detail: status.available ? status.detail || `${bin} is available.` : MISSING_BIN_DETAIL
  };
}

export function getClaudeAuthStatus(cwd, env = process.env) {
  const availability = getClaudeAvailability(cwd, env);
  if (!availability.available) {
    return { available: false, loggedIn: false, detail: availability.detail };
  }
  const result = runCommand(availability.bin, ["auth", "status"], { cwd });
  const loggedIn = result.status === 0 && !result.error;
  return {
    available: true,
    loggedIn,
    detail: loggedIn
      ? "Logged in (`claude auth status` exited 0)."
      : "Not logged in. Run `claude auth login`."
  };
}

function objectHasBypassFlag(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/bypass/i.test(key) && (child === true || child === "accepted" || child === "allow")) {
      return true;
    }
    if (objectHasBypassFlag(child)) {
      return true;
    }
  }
  return false;
}

export function getBypassDisclaimerStatus({
  home = os.homedir(),
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  const candidates = [
    path.join(home, ".claude.json"),
    path.join(home, ".claude", "settings.json")
  ];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (objectHasBypassFlag(parsed)) {
        return { accepted: true, detail: `Bypass disclaimer flag found in ${filePath}.` };
      }
    } catch {
      // keep looking
    }
  }
  return {
    accepted: false,
    detail:
      "Claude refuses `claude --bg --dangerously-skip-permissions` until you accept the bypass disclaimer once. Run `claude --dangerously-skip-permissions` interactively, accept the prompt, then rerun setup."
  };
}

export function parsePrintResult(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  if (start === -1) {
    return { sessionId: null, resultText: text.trim(), structuredOutput: null, raw: null };
  }
  try {
    const raw = JSON.parse(text.slice(start));
    return {
      sessionId: raw.session_id ?? raw.sessionId ?? null,
      resultText: typeof raw.result === "string" ? raw.result : text.trim(),
      structuredOutput: raw.structured_output ?? raw.structuredOutput ?? null,
      raw
    };
  } catch {
    return { sessionId: null, resultText: text.trim(), structuredOutput: null, raw: null };
  }
}

export function parseBgShortId(stdout) {
  const text = String(stdout ?? "");
  const fromCmd = text.match(/claude\s+(?:attach|logs|stop)\s+([A-Za-z0-9_-]+)/);
  if (fromCmd) {
    return fromCmd[1];
  }
  const hex = text.match(/\b([a-f0-9]{8})\b/i);
  return hex ? hex[1] : null;
}

export function mapAgentsSession(entry) {
  const row = entry && typeof entry === "object" ? entry : {};
  return {
    shortId: row.id ?? row.shortId ?? null,
    state: String(row.state ?? ""),
    waitingFor: row.waitingFor ?? row.waiting_for ?? null,
    cwd: row.cwd ?? row.worktree ?? null,
    pid: typeof row.pid === "number" ? row.pid : null
  };
}

export function agentsStateToJobStatus(state) {
  switch (String(state)) {
    case "working":
      return "running";
    case "blocked":
      return "blocked";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "cancelled";
    default:
      return "queued";
  }
}

export function refreshJobFromAgentsJson(job, stdout) {
  const text = String(stdout || "");
  const start = text.indexOf("[");
  let rows;
  try {
    rows = start === -1 ? null : JSON.parse(text.slice(start));
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) {
    return { ...job, summary: "Unable to parse Claude agents JSON; keeping the last known status." };
  }
  const match = rows.map(mapAgentsSession).find((row) => row.shortId && row.shortId === job.shortId);
  if (!match) {
    return { ...job, summary: "Claude session not listed in `claude agents --json`." };
  }
  return {
    ...job,
    status: agentsStateToJobStatus(match.state),
    waitingFor: match.waitingFor,
    worktree: match.cwd ?? job.worktree ?? null,
    pid: match.pid ?? job.pid ?? null
  };
}
