/**
 * OpenCode bridge: wraps the local `opencode` CLI for the companion script.
 *
 * Spawns `opencode run --format json` per task, parses the JSON event stream
 * line-by-line, and exposes the result shape the companion expects
 * (sessionID, final message, reasoning summary, file changes, command
 * executions). See README "OpenCode Integration" for the wire format.
 */

import { spawn } from "node:child_process";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, formatCommandFailure, runCommand } from "./process.mjs";

const TASK_THREAD_PREFIX = "OpenCode Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
const REVIEW_INSTRUCTIONS = [
  "You are running a focused code review.",
  "Output a Markdown report with: a short summary, a Findings list (each with severity, file:line, description, recommendation), and Next Steps.",
  "Do not modify any files. Do not run shell commands that change state.",
  "Inspect the repository as needed with read-only tools to ground your findings."
].join(" ");

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function cleanOpencodeStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

export function getOpencodeAvailability(cwd) {
  return binaryAvailable("opencode", ["--version"], { cwd });
}

export async function getOpencodeAuthStatus(cwd) {
  const availability = getOpencodeAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      provider: null
    };
  }

  const result = runCommand("opencode", ["auth", "list"], { cwd });
  if (result.error || result.status !== 0) {
    return {
      available: true,
      loggedIn: false,
      detail: cleanOpencodeStderr(result.stderr) || formatCommandFailure(result),
      source: "auth-list",
      provider: null
    };
  }

  const stripAnsi = (text) => text.replace(/\[[0-9;]*m/g, "");
  const stdout = stripAnsi(String(result.stdout ?? ""));
  const credentialMatch = stdout.match(/^\s*◝\s+(\S+)/m);
  const loggedIn = Boolean(credentialMatch);
  const providerName = loggedIn ? credentialMatch[1].trim() : null;
  return {
    available: true,
    loggedIn,
    detail: loggedIn
      ? `Provider configured: ${providerName}`
      : "No providers configured. Run `opencode auth login` to add one.",
    source: "auth-list",
    provider: providerName
  };
}

export function extractConfiguredModel(config) {
  if (!config || typeof config !== "object") {
    return null;
  }
  if (typeof config.model === "string" && config.model.trim()) {
    return { model: config.model.trim(), source: "config" };
  }
  const agents = config.agent;
  if (!agents || typeof agents !== "object") {
    return null;
  }
  // OpenCode resolves the active primary agent from `default_agent` and falls
  // back to `build` when unset or invalid. See https://opencode.ai/docs/config#default-agent.
  const defaultAgent =
    typeof config.default_agent === "string" && config.default_agent.trim()
      ? config.default_agent.trim()
      : "build";
  const agentEntry = agents[defaultAgent];
  if (
    agentEntry &&
    typeof agentEntry === "object" &&
    typeof agentEntry.model === "string" &&
    agentEntry.model.trim()
  ) {
    return { model: agentEntry.model.trim(), source: "agent", agent: defaultAgent };
  }
  return null;
}

export function getOpencodeDefaultModel(cwd) {
  const availability = getOpencodeAvailability(cwd);
  if (!availability.available) {
    return {
      configured: false,
      model: null,
      source: "unavailable",
      detail: availability.detail
    };
  }

  const result = runCommand("opencode", ["debug", "config"], { cwd });
  if (result.error || result.status !== 0) {
    return {
      configured: false,
      model: null,
      source: "error",
      detail: cleanOpencodeStderr(result.stderr) || formatCommandFailure(result)
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch (error) {
    return {
      configured: false,
      model: null,
      source: "error",
      detail: `Failed to parse opencode debug config output: ${error.message}`
    };
  }

  const extracted = extractConfiguredModel(parsed);
  if (!extracted) {
    return {
      configured: false,
      model: null,
      source: "none",
      detail: "not configured (selected per session in TUI or via `-m`)"
    };
  }

  const detail =
    extracted.source === "agent"
      ? `${extracted.model} (from agent.${extracted.agent})`
      : extracted.model;
  return {
    configured: true,
    model: extracted.model,
    source: extracted.source,
    agent: extracted.agent ?? null,
    detail
  };
}

export function getSessionRuntimeStatus(_env = process.env, _cwd = process.cwd()) {
  return {
    mode: "direct",
    label: "direct startup",
    detail: "OpenCode runs are spawned on demand per task; no shared runtime is maintained.",
    endpoint: null
  };
}

export async function interruptAppServerTurn(cwd, { threadId } = {}) {
  if (!threadId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId"
    };
  }

  const availability = getOpencodeAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  const result = runCommand("opencode", ["session", "delete", threadId], { cwd });
  if (result.error) {
    return {
      attempted: true,
      interrupted: false,
      transport: "cli",
      detail: result.error.message
    };
  }
  if (result.status !== 0) {
    return {
      attempted: true,
      interrupted: false,
      transport: "cli",
      detail: cleanOpencodeStderr(result.stderr) || formatCommandFailure(result)
    };
  }
  return {
    attempted: true,
    interrupted: true,
    transport: "cli",
    detail: `Deleted OpenCode session ${threadId}.`
  };
}

function applyOpencodeEvent(state, event) {
  if (event && typeof event.sessionID === "string" && !state.threadId) {
    state.threadId = event.sessionID;
  }

  const eventType = typeof event?.type === "string" ? event.type : null;
  if (!eventType) {
    return;
  }

  const part = event.part ?? {};
  const partType = typeof part.type === "string" ? part.type : null;

  switch (eventType) {
    case "step_start":
    case "step-start":
      emitProgress(state.onProgress, "Starting step.", "starting");
      return;

    case "step_finish":
    case "step-finish":
      state.finalAnswerSeen = true;
      emitProgress(state.onProgress, "Step finished.", "finalizing");
      return;

    case "text": {
      const text = typeof part.text === "string" ? part.text : "";
      if (text) {
        state.lastAgentMessage = text;
        emitProgress(state.onProgress, `Message: ${shorten(text, 96)}`, "running");
      }
      return;
    }

    case "reasoning": {
      const text = typeof part.text === "string" ? part.text : "";
      if (text) {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (normalized && !state.reasoningSummary.includes(normalized)) {
          state.reasoningSummary.push(normalized);
          emitProgress(state.onProgress, `Reasoning: ${shorten(normalized, 96)}`, "investigating");
        }
      }
      return;
    }

    case "tool":
    case "tool_call":
    case "tool-call": {
      const tool = part.tool ?? part.name ?? "tool";
      emitProgress(state.onProgress, `Calling tool: ${tool}.`, "investigating");
      if (tool === "edit" || tool === "write" || tool === "patch") {
        const path = part.input?.filePath ?? part.input?.path;
        if (path && !state.fileChanges.some((change) => change.path === path)) {
          state.fileChanges.push({ path });
        }
      }
      if (tool === "bash" || tool === "shell") {
        const command = part.input?.command;
        if (command) {
          state.commandExecutions.push({ command, status: "started" });
          emitProgress(state.onProgress, `Running command: ${shorten(command, 96)}.`, "running");
        }
      }
      return;
    }

    case "tool_result":
    case "tool-result": {
      emitProgress(state.onProgress, `Tool ${part.tool ?? "result"} finished.`, "investigating");
      return;
    }

    case "error": {
      const message = part.message ?? event.message ?? "OpenCode reported an error.";
      state.error = { message };
      emitProgress(state.onProgress, `Error: ${message}`, "failed");
      return;
    }

    case "message":
    case "message_complete":
    case "message-complete":
    case "done":
      state.finalAnswerSeen = true;
      return;

    default:
      if (partType === "text" && typeof part.text === "string" && part.text) {
        state.lastAgentMessage = part.text;
      }
      emitProgress(state.onProgress, `Event: ${eventType}.`, null);
  }
}

function appendPromptSuffix(prompt, suffix) {
  if (!suffix) {
    return prompt;
  }
  const trimmed = prompt.replace(/\s+$/, "");
  return `${trimmed}\n\n${suffix}`;
}

function buildReviewPrompt(target, focusText, contextSummary) {
  const targetLabel = target?.label ?? "the current changes";
  const focus = focusText && focusText.trim() ? focusText.trim() : null;
  const segments = [
    REVIEW_INSTRUCTIONS,
    `Review target: ${targetLabel}.`,
    contextSummary ? `Repository context summary:\n${contextSummary}` : null,
    focus ? `Caller focus:\n${focus}` : null
  ];
  return segments.filter(Boolean).join("\n\n");
}

function spawnOpencodeRun(cwd, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const state = {
      threadId: null,
      lastAgentMessage: "",
      reasoningSummary: [],
      fileChanges: [],
      commandExecutions: [],
      error: null,
      finalAnswerSeen: false,
      onProgress
    };

    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            applyOpencodeEvent(state, JSON.parse(line));
          } catch {
            // ignore non-JSON output lines
          }
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
    });

    child.on("error", reject);

    child.on("close", (code, signal) => {
      const trailing = stdoutBuffer.trim();
      if (trailing) {
        try {
          applyOpencodeEvent(state, JSON.parse(trailing));
        } catch {
          // ignore
        }
      }

      const status = code === 0 ? 0 : signal ? 130 : code ?? 1;
      const turnStatus = status === 0 ? "completed" : "failed";

      resolve({
        status,
        threadId: state.threadId,
        turnId: state.threadId ? `${state.threadId}-turn` : null,
        finalMessage: state.lastAgentMessage,
        reasoningSummary: state.reasoningSummary,
        turn: { id: state.threadId ? `${state.threadId}-turn` : null, status: turnStatus },
        error: state.error,
        stderr: cleanOpencodeStderr(stderrBuffer),
        fileChanges: state.fileChanges,
        touchedFiles: state.fileChanges.map((change) => change.path).filter(Boolean),
        commandExecutions: state.commandExecutions
      });
    });
  });
}

export function buildRunArgs(cwd, options = {}) {
  const args = ["run", "--format", "json", "--dir", cwd];
  if (options.write) {
    args.push("--auto");
  }
  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.effort) {
    args.push("--variant", options.effort);
  }
  if (options.resumeThreadId) {
    args.push("-s", options.resumeThreadId);
  } else if (options.resumeLatest) {
    args.push("--continue");
  }
  return args;
}

function ensureOpencodeAvailable(cwd) {
  const availability = getOpencodeAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "OpenCode CLI is not installed or is missing required runtime support. Install it with `npm install -g opencode-ai`, then rerun `/opencode:setup`."
    );
  }
}

export async function runAppServerTurn(cwd, options = {}) {
  ensureOpencodeAvailable(cwd);

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this OpenCode run.");
  }

  const args = buildRunArgs(cwd, options);
  args.push(prompt);

  emitProgress(
    options.onProgress,
    options.resumeThreadId
      ? `Resuming OpenCode session ${options.resumeThreadId}.`
      : "Starting OpenCode run.",
    "starting"
  );

  const result = await spawnOpencodeRun(cwd, args, options.onProgress);
  if (result.threadId) {
    emitProgress(options.onProgress, `Session ready (${result.threadId}).`, "running", {
      threadId: result.threadId
    });
  }
  return result;
}

export async function runAppServerReview(cwd, options = {}) {
  ensureOpencodeAvailable(cwd);

  const prompt = buildReviewPrompt(
    options.target ?? null,
    options.focusText ?? null,
    options.contextSummary ?? null
  );

  const result = await runAppServerTurn(cwd, {
    prompt,
    model: options.model ?? null,
    effort: options.effort ?? null,
    write: false,
    onProgress: options.onProgress
  });

  return {
    ...result,
    sourceThreadId: result.threadId,
    reviewText: result.finalMessage
  };
}

export async function findLatestTaskThread(_cwd) {
  // For v0.1, OpenCode's `opencode session list` does not expose
  // per-directory filtering or task-name prefixes through a stable JSON
  // contract. Fall back to null and let the companion's job state act as
  // the source of truth for resumable rescue threads. Callers already
  // handle null gracefully.
  return null;
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "OpenCode did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
