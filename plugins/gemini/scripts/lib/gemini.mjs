/**
 * Gemini bridge: wraps the local `gemini` CLI for the companion script.
 *
 * Spawns `gemini --skip-trust --approval-mode=yolo --output-format=stream-json
 * -p <prompt>` per task, parses the NDJSON event stream line-by-line, and
 * exposes the result shape the companion expects (sessionId/threadId,
 * final assistant message, file changes, tool outcomes).
 *
 * Wire format documented in docs/notes/gemini-stream-json.md.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { binaryAvailable, formatCommandFailure, runCommand } from "./process.mjs";

const TASK_THREAD_PREFIX = "Gemini Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
/** Win32 CreateProcess argv limit is ~32k; keep `-p` under this and use stdin above it. */
export const WIN32_ARGV_PROMPT_LIMIT = 20_000;
const REVIEW_INSTRUCTIONS = [
  "You are running a focused code review.",
  "Output a Markdown report with: a short summary, a Findings list (each with severity, file:line, description, recommendation), and Next Steps.",
  "Do not modify any files. Do not run shell commands that change state.",
  "Inspect the repository as needed with read-only tools to ground your findings."
].join(" ");

/**
 * On win32, argv `-p <prompt>` hits ENAMETOOLONG around ~32k. For prompts over
 * WIN32_ARGV_PROMPT_LIMIT, omit `-p` and write the body on stdin: gemini/agy
 * headless treats a non-TTY stdin pipe as the query (same as `-p` without
 * putting the huge string on argv). Do not pass `-p` with an empty value.
 */
export function shouldPassPromptViaStdin(prompt, platform = process.platform) {
  return (
    platform === "win32" &&
    typeof prompt === "string" &&
    prompt.length > WIN32_ARGV_PROMPT_LIMIT
  );
}

// Tools that mutate files. tool_use events with these names are tracked in
// state.fileChanges so the companion can summarize what changed.
const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "write_to_file",
  "edit_file",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "replace"
]);

const SHELL_TOOL_NAMES = new Set([
  "shell",
  "bash",
  "run_shell_command",
  "run_command"
]);

const AGY_WRITE_TOOL_NAMES = new Set([
  ...WRITE_TOOL_NAMES,
  "write_to_file",
  "create_file",
  "search_replace"
]);

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

function cleanGeminiStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.startsWith("Warning: True color"))
    .filter((line) => !line.startsWith("Ripgrep is not available"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Backend resolution (agy preferred, then gemini)
// ---------------------------------------------------------------------------

const MISSING_BACKEND_DETAIL =
  "Neither `agy` (Antigravity CLI) nor `gemini` is available on PATH. Install Antigravity (`agy`) and/or `npm install -g @google/gemini-cli`, then rerun setup.";

function normalizeGeminiBackend(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "agy" || normalized === "gemini") {
    return normalized;
  }
  return null;
}

function defaultWhichBinary(name) {
  const status = binaryAvailable(name, ["--version"]);
  return status.available ? name : null;
}

/**
 * Infer which CLI backend a binary path maps to.
 * Explicit override wins; otherwise basename containing `agy` → agy; else gemini.
 */
export function inferBackendFromBin(binPath, backendOverride = null) {
  const override = normalizeGeminiBackend(backendOverride);
  if (override) {
    return override;
  }
  const raw = String(binPath ?? "");
  const base = path.basename(raw.replace(/\\/g, "/")).toLowerCase();
  if (base.includes("agy")) {
    return "agy";
  }
  return "gemini";
}

/**
 * Prefer the backend that owns a resume session over current PATH preference.
 * Order: resume job backend → explicit request backend → resolved PATH backend → gemini.
 */
export function pickTaskRunBackend({ resumeBackend = null, requestBackend = null, resolvedBackend = null } = {}) {
  return (
    normalizeGeminiBackend(resumeBackend) ??
    normalizeGeminiBackend(requestBackend) ??
    normalizeGeminiBackend(resolvedBackend) ??
    "gemini"
  );
}

/**
 * Resume target from a stored job: session/thread id plus the backend that created it.
 */
export function resumeTargetFromJob(job) {
  if (!job?.threadId) {
    return null;
  }
  return {
    id: job.threadId,
    backend: normalizeGeminiBackend(job.backend)
  };
}

/**
 * Resolve which Gemini-family CLI to spawn.
 * Order: GEMINI_BIN → GEMINI_BACKEND on PATH → agy → gemini → fail with install hints.
 * `whichBinary(name)` is injectable for tests; production uses `--version` probes only (no TUI).
 */
export function resolveGeminiBackend(options = {}) {
  const env = options.env ?? process.env;
  const whichBinary = options.whichBinary ?? defaultWhichBinary;

  const geminiBin =
    typeof env.GEMINI_BIN === "string" && env.GEMINI_BIN.trim() ? env.GEMINI_BIN.trim() : null;
  if (geminiBin) {
    const backend = inferBackendFromBin(geminiBin, env.GEMINI_BACKEND);
    return {
      backend,
      bin: geminiBin,
      available: true,
      detail: `Using GEMINI_BIN=${geminiBin} (backend: ${backend}).`
    };
  }

  const backendOverride = normalizeGeminiBackend(env.GEMINI_BACKEND);
  if (backendOverride) {
    const bin = whichBinary(backendOverride);
    if (bin) {
      return {
        backend: backendOverride,
        bin,
        available: true,
        detail: `Using GEMINI_BACKEND=${backendOverride}.`
      };
    }
    return {
      backend: null,
      bin: null,
      available: false,
      detail: `GEMINI_BACKEND=${backendOverride} but that binary was not found on PATH. ${MISSING_BACKEND_DETAIL}`
    };
  }

  const agyBin = whichBinary("agy");
  if (agyBin) {
    return {
      backend: "agy",
      bin: agyBin,
      available: true,
      detail: "Using agy (Antigravity CLI) from PATH."
    };
  }

  const geminiPath = whichBinary("gemini");
  if (geminiPath) {
    return {
      backend: "gemini",
      bin: geminiPath,
      available: true,
      detail: "Using gemini CLI from PATH."
    };
  }

  return {
    backend: null,
    bin: null,
    available: false,
    detail: MISSING_BACKEND_DETAIL
  };
}

/**
 * Probe agy auth without spawning the TUI.
 * Logged in only when ~/.gemini/antigravity-cli exists and stat.isDirectory() is true.
 * A regular file at that path is loggedIn false. Does not spawn agy.
 */
export function getAgyAuthStatus({
  home = os.homedir(),
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  statSync = fs.statSync
} = {}) {
  const authDir = path.join(home, ".gemini", "antigravity-cli");
  if (!existsSync(authDir)) {
    return {
      loggedIn: false,
      detail:
        "No Antigravity CLI auth dir at ~/.gemini/antigravity-cli. Run `agy` once interactively to sign in."
    };
  }

  try {
    const stat = statSync(authDir);
    if (!stat.isDirectory()) {
      return {
        loggedIn: false,
        detail:
          "~/.gemini/antigravity-cli exists but is not a directory. Run `agy` once interactively to sign in."
      };
    }
    let entries = [];
    try {
      entries = readdirSync(authDir);
    } catch {
      entries = [];
    }
    return {
      loggedIn: true,
      detail:
        entries.length > 0
          ? `Antigravity CLI auth present under ~/.gemini/antigravity-cli (${entries.length} entr${entries.length === 1 ? "y" : "ies"}).`
          : "Antigravity CLI auth directory present at ~/.gemini/antigravity-cli."
    };
  } catch {
    return {
      loggedIn: false,
      detail:
        "Could not read ~/.gemini/antigravity-cli. Run `agy` once interactively to sign in."
    };
  }
}

// ---------------------------------------------------------------------------
// Availability + auth
// ---------------------------------------------------------------------------

export function getGeminiAvailability(cwd, options = {}) {
  const resolved = resolveGeminiBackend(options);
  if (!resolved.available || !resolved.bin) {
    return {
      available: false,
      detail: resolved.detail,
      backend: resolved.backend,
      bin: resolved.bin
    };
  }

  const status = binaryAvailable(resolved.bin, ["--version"], { cwd });
  return {
    available: status.available,
    detail: status.available ? status.detail || resolved.detail : status.detail,
    backend: resolved.backend,
    bin: resolved.bin
  };
}

/**
 * Probe Gemini auth status. Unlike `opencode auth list`, the gemini CLI has
 * no programmatic auth-listing command. We approximate by checking three
 * sources, in priority order:
 *
 *   1. `GEMINI_API_KEY` env (AI Studio).
 *   2. Vertex AI env triple: `GOOGLE_API_KEY` + `GOOGLE_GENAI_USE_VERTEXAI=true`
 *      + `GOOGLE_CLOUD_PROJECT`.
 *   3. Cached browser-OAuth credentials at `~/.gemini/oauth_creds.json`
 *      (also recognised: `~/.gemini/google_accounts.json` from older CLI
 *      versions, or a `~/.gemini/.env` file with one of the env keys above).
 *
 * Tests can inject `env`, `home`, and `existsSync` overrides.
 */
export function getGeminiAuthStatus(
  cwd,
  {
    env = process.env,
    home = os.homedir(),
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync
  } = {}
) {
  const availability = getGeminiAvailability(cwd);

  if (typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim()) {
    return {
      available: availability.available,
      loggedIn: true,
      source: "env",
      provider: "api-key",
      detail: "GEMINI_API_KEY detected in the environment."
    };
  }

  const hasVertexKey = typeof env.GOOGLE_API_KEY === "string" && env.GOOGLE_API_KEY.trim();
  const vertexEnabled = String(env.GOOGLE_GENAI_USE_VERTEXAI ?? "").toLowerCase() === "true";
  const hasVertexProject =
    typeof env.GOOGLE_CLOUD_PROJECT === "string" && env.GOOGLE_CLOUD_PROJECT.trim();
  if (hasVertexKey && vertexEnabled && hasVertexProject) {
    return {
      available: availability.available,
      loggedIn: true,
      source: "env",
      provider: "vertex",
      detail: `Vertex AI configured (project: ${env.GOOGLE_CLOUD_PROJECT.trim()}).`
    };
  }

  // Look for a cached browser-OAuth login. The CLI writes oauth_creds.json
  // after `gemini` completes the OAuth dance. If we can see a non-empty
  // creds file plus a google_accounts.json companion, headless `gemini -p`
  // will work without any env vars.
  const oauthCredsPath = path.join(home, ".gemini", "oauth_creds.json");
  if (existsSync(oauthCredsPath)) {
    let account = null;
    const accountsPath = path.join(home, ".gemini", "google_accounts.json");
    if (existsSync(accountsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(accountsPath, "utf8"));
        account = parsed?.active ?? parsed?.email ?? null;
      } catch {
        account = null;
      }
    }
    return {
      available: availability.available,
      loggedIn: true,
      source: "oauth",
      provider: "google-oauth",
      detail: account
        ? `OAuth credentials cached for ${account} at ~/.gemini/oauth_creds.json.`
        : "OAuth credentials cached at ~/.gemini/oauth_creds.json."
    };
  }

  // Last resort: gemini also reads a project/user .env file. If one exists
  // and contains a recognised key, treat that as logged in. We don't parse
  // values — just key presence.
  const dotenvPath = path.join(home, ".gemini", ".env");
  if (existsSync(dotenvPath)) {
    try {
      const body = readFileSync(dotenvPath, "utf8");
      if (/^\s*(GEMINI_API_KEY|GOOGLE_API_KEY)\s*=/m.test(body)) {
        return {
          available: availability.available,
          loggedIn: true,
          source: "dotenv",
          provider: "dotenv",
          detail: "Auth key found in ~/.gemini/.env."
        };
      }
    } catch {
      // unreadable — fall through to not-logged-in
    }
  }

  return {
    available: availability.available,
    loggedIn: false,
    source: "none",
    provider: null,
    detail:
      "No Gemini auth detected. Run `gemini` once to OAuth, export `GEMINI_API_KEY` (from AI Studio), or set the Vertex triple `GOOGLE_API_KEY` + `GOOGLE_GENAI_USE_VERTEXAI=true` + `GOOGLE_CLOUD_PROJECT`."
  };
}

/**
 * Gemini does not expose a stable per-project "configured model" config to
 * read out of band (model is per-invocation via `-m` or auto-routed). Report
 * "not configured" so the setup renderer shows a sensible message.
 */
export function getGeminiDefaultModel(cwd) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    return {
      configured: false,
      model: null,
      source: "unavailable",
      detail: availability.detail
    };
  }
  return {
    configured: false,
    model: null,
    source: "none",
    detail: "not configured (Gemini routes per invocation; pass -m to override)"
  };
}

export function getSessionRuntimeStatus(_env = process.env, _cwd = process.cwd()) {
  return {
    mode: "direct",
    label: "direct startup",
    detail:
      "Gemini runs are spawned on demand per task; no shared runtime is maintained.",
    endpoint: null
  };
}

// ---------------------------------------------------------------------------
// Argument builders
// ---------------------------------------------------------------------------

/**
 * Build CLI args for a Gemini-family task run (`gemini` or `agy`).
 *
 * Flag map (see design spec):
 * - gemini: always `--skip-trust` + `--output-format=stream-json`;
 *   write → `--approval-mode=yolo`, else `plan`; resume via `-r`.
 * - agy: always `--output-format=stream-json` + `--print-timeout 15m`;
 *   write → `--dangerously-skip-permissions`; resume via `--conversation` /
 *   `--continue`; model via `--model`; effort via `--effort`.
 */
export function buildRunArgs(_cwd, options = {}) {
  const prompt = options.prompt;
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("buildRunArgs: a non-empty prompt is required.");
  }

  const backend = normalizeGeminiBackend(options.backend) ?? "gemini";
  const write = options.write === true;
  const args = [];

  if (backend === "agy") {
    args.push("--output-format=stream-json", "--print-timeout", "15m");
    if (write) {
      args.push("--dangerously-skip-permissions");
    }
    if (options.model) {
      args.push("--model", String(options.model));
    }
    if (options.effort) {
      args.push("--effort", String(options.effort));
    }
    if (options.resumeSessionId) {
      args.push("--conversation", String(options.resumeSessionId));
    } else if (options.resumeLatest) {
      args.push("--continue");
    }
  } else {
    // Approval mode is derived solely from write — ignore options.approvalMode
    // so reviews cannot be overridden to yolo.
    const approvalMode = write ? "yolo" : "plan";
    args.push(
      "--skip-trust",
      `--approval-mode=${approvalMode}`,
      "--output-format=stream-json"
    );

    if (options.model) {
      args.push("-m", String(options.model));
    }

    if (options.sandbox) {
      args.push("--sandbox");
    }

    if (options.resumeSessionId) {
      args.push("-r", String(options.resumeSessionId));
    } else if (options.resumeLatest) {
      args.push("-r", "latest");
    }
  }

  if (Array.isArray(options.includeDirectories) && options.includeDirectories.length > 0) {
    args.push("--include-directories", options.includeDirectories.join(","));
  }

  const platform = options.platform ?? process.platform;
  // Prompt must be the last entry so spawn() (which doesn't go through a
  // shell) passes it verbatim as the value of `-p` — except on win32 when the
  // prompt is huge: omit `-p` and deliver via stdin (see shouldPassPromptViaStdin).
  if (!shouldPassPromptViaStdin(prompt, platform)) {
    args.push("-p", prompt);
  }
  return args;
}

export function buildReviewArgs(cwd, options = {}) {
  return buildRunArgs(cwd, { ...options, write: false });
}
export function buildReviewPrompt(target, focusText, contextSummary) {
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

// ---------------------------------------------------------------------------
// Stream-json event parser
// ---------------------------------------------------------------------------

/**
 * Mutate `state` based on one parsed stream-json event from gemini.
 * Event field names are documented in docs/notes/gemini-stream-json.md.
 *
 * State fields used (all optional, created on demand):
 *   sessionId, model, finalMessage, reasoningSummary, fileChanges,
 *   commandExecutions, error, status, onProgress
 */
export function applyGeminiEvent(state, event) {
  if (!event || typeof event !== "object") {
    return;
  }
  const eventType = typeof event.type === "string" ? event.type : null;
  if (!eventType) {
    return;
  }

  switch (eventType) {
    case "init": {
      const sessionId = event.session_id ?? event.sessionId ?? null;
      if (sessionId) {
        state.sessionId = String(sessionId);
      }
      if (event.model) {
        state.model = String(event.model);
      }
      emitProgress(state.onProgress, "Gemini session ready.", "starting", {
        sessionId: state.sessionId
      });
      return;
    }

    case "message": {
      const role = event.role;
      const content = typeof event.content === "string" ? event.content : "";
      if (role !== "assistant" || !content) {
        return;
      }
      state.finalMessage = (state.finalMessage ?? "") + content;
      state.lastAgentMessage = state.finalMessage;
      emitProgress(state.onProgress, `Message: ${shorten(content, 96)}`, "running");
      return;
    }

    case "tool_use": {
      const toolName = typeof event.tool_name === "string" ? event.tool_name : "tool";
      const params = event.parameters ?? {};

      emitProgress(state.onProgress, `Calling tool: ${toolName}.`, "investigating");

      if (WRITE_TOOL_NAMES.has(toolName)) {
        const path = params.file_path ?? params.path ?? params.filePath ?? null;
        if (path) {
          state.fileChanges = state.fileChanges ?? [];
          if (!state.fileChanges.some((change) => change.path === path)) {
            state.fileChanges.push({ path, tool: toolName });
          }
        }
      }

      if (SHELL_TOOL_NAMES.has(toolName)) {
        const command = params.command ?? params.cmd ?? null;
        if (command) {
          state.commandExecutions = state.commandExecutions ?? [];
          state.commandExecutions.push({ command, status: "started" });
          emitProgress(
            state.onProgress,
            `Running command: ${shorten(command, 96)}.`,
            "running"
          );
        }
      }
      return;
    }

    case "tool_result": {
      const status = event.status === "error" ? "error" : "success";
      emitProgress(state.onProgress, `Tool result: ${status}.`, "investigating");
      return;
    }

    case "result": {
      const status = event.status === "success" ? "success" : "error";
      state.status = status;
      state.stats = event.stats ?? null;
      if (status === "error") {
        const errMsg = event.error ?? "Gemini reported an error.";
        state.error = typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg);
        emitProgress(state.onProgress, `Error: ${state.error}`, "failed");
      } else {
        emitProgress(state.onProgress, "Run complete.", "finalizing");
      }
      return;
    }

    case "error": {
      const message = event.error ?? event.message ?? "Gemini reported an error.";
      state.error = typeof message === "string" ? message : JSON.stringify(message);
      emitProgress(state.onProgress, `Error: ${state.error}`, "failed");
      return;
    }

    default:
      // Unknown event types are no-ops by design; the wire format is
      // partially undocumented and may add new event types over time.
      return;
  }
}

function recordAgyFileChange(state, toolName, params) {
  const filePath =
    params.file_path ??
    params.FilePath ??
    params.path ??
    params.Path ??
    params.filePath ??
    params.TargetFile ??
    params.target_file ??
    null;
  if (!filePath) {
    return;
  }
  state.fileChanges = state.fileChanges ?? [];
  const normalized = String(filePath);
  if (!state.fileChanges.some((change) => change.path === normalized)) {
    state.fileChanges.push({ path: normalized, tool: toolName });
  }
}

function recordAgyCommand(state, params) {
  const command =
    params.CommandLine ??
    params.command_line ??
    params.command ??
    params.cmd ??
    null;
  if (!command) {
    return;
  }
  state.commandExecutions = state.commandExecutions ?? [];
  state.commandExecutions.push({ command: String(command), status: "started" });
  emitProgress(
    state.onProgress,
    `Running command: ${shorten(command, 96)}.`,
    "running"
  );
}

/**
 * Mutate `state` based on one parsed stream-json event from `agy`.
 * Same state shape as `applyGeminiEvent` (`sessionId`, `finalMessage`,
 * `fileChanges`, `commandExecutions`, …). Maps `conversation_id` → `sessionId`.
 */
export function applyAgyEvent(state, event) {
  if (!event || typeof event !== "object") {
    return;
  }
  const eventType = typeof event.event === "string" ? event.event : null;
  if (!eventType) {
    return;
  }

  switch (eventType) {
    case "init": {
      const conversationId =
        event.conversation_id ?? event.init?.conversation_id ?? null;
      if (conversationId) {
        state.sessionId = String(conversationId);
      }
      const model = event.init?.model ?? event.model ?? null;
      if (model) {
        state.model = String(model);
      }
      emitProgress(state.onProgress, "Antigravity session ready.", "starting", {
        sessionId: state.sessionId
      });
      return;
    }

    case "step_update": {
      const step = event.step_update ?? {};
      const stepType = typeof step.step_type === "string" ? step.step_type : null;
      const toolName =
        (typeof step.tool_name === "string" && step.tool_name) ||
        (typeof step.tool_info?.name === "string" && step.tool_info.name) ||
        "tool";
      const params = step.tool_info?.parameters ?? step.parameters ?? {};

      if (stepType === "agent_response") {
        const delta =
          typeof step.text_delta === "string"
            ? step.text_delta
            : typeof event.text_delta === "string"
              ? event.text_delta
              : "";
        if (delta) {
          state.finalMessage = (state.finalMessage ?? "") + delta;
          state.lastAgentMessage = state.finalMessage;
          emitProgress(state.onProgress, `Message: ${shorten(delta, 96)}`, "running");
        }
        return;
      }

      if (stepType === "tool" || step.tool_info) {
        emitProgress(state.onProgress, `Calling tool: ${toolName}.`, "investigating");

        if (AGY_WRITE_TOOL_NAMES.has(toolName) || WRITE_TOOL_NAMES.has(toolName)) {
          recordAgyFileChange(state, toolName, params);
        }

        if (SHELL_TOOL_NAMES.has(toolName) || toolName === "run_command") {
          recordAgyCommand(state, params);
        }
      }
      return;
    }

    case "result": {
      const result = event.result ?? {};
      const conversationId = result.conversation_id ?? event.conversation_id ?? null;
      if (conversationId) {
        state.sessionId = String(conversationId);
      }

      const response = typeof result.response === "string" ? result.response : "";
      if (response) {
        state.finalMessage = response;
        state.lastAgentMessage = response;
      } else if (!state.finalMessage && state.lastAgentMessage) {
        state.finalMessage = state.lastAgentMessage;
      }

      if (result.usage != null) {
        state.stats = result.usage;
      }

      const rawStatus = String(result.status ?? "").toUpperCase();
      const status = rawStatus === "SUCCESS" || rawStatus === "OK" ? "success" : "error";
      state.status = status;
      if (status === "error") {
        const errMsg = result.error ?? result.message ?? "Antigravity reported an error.";
        state.error = typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg);
        emitProgress(state.onProgress, `Error: ${state.error}`, "failed");
      } else {
        emitProgress(state.onProgress, "Run complete.", "finalizing");
      }
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Spawning + run helpers
// ---------------------------------------------------------------------------

function spawnGeminiRun(
  cwd,
  args,
  onProgress,
  { backend = "gemini", bin = "gemini", stdin = null } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: process.env,
      stdio: [stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const state = {
      sessionId: null,
      model: null,
      finalMessage: "",
      lastAgentMessage: "",
      reasoningSummary: [],
      fileChanges: [],
      commandExecutions: [],
      error: null,
      status: null,
      stats: null,
      onProgress
    };

    const applyEvent = backend === "agy" ? applyAgyEvent : applyGeminiEvent;

    let stdoutBuffer = "";
    let stderrBuffer = "";

    if (stdin != null && child.stdin) {
      child.stdin.on("error", () => {
        // Ignore EPIPE if the child exits before consuming stdin.
      });
      child.stdin.end(stdin);
    }

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
            applyEvent(state, JSON.parse(line));
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
          applyEvent(state, JSON.parse(trailing));
        } catch {
          // ignore
        }
      }

      const exitStatus = code === 0 ? 0 : signal ? 130 : code ?? 1;
      const turnStatus = exitStatus === 0 ? "completed" : "failed";

      resolve({
        status: exitStatus,
        backend,
        threadId: state.sessionId,
        sessionId: state.sessionId,
        turnId: state.sessionId ? `${state.sessionId}-turn` : null,
        finalMessage: state.finalMessage || state.lastAgentMessage || "",
        reasoningSummary: state.reasoningSummary,
        turn: { id: state.sessionId ? `${state.sessionId}-turn` : null, status: turnStatus },
        error: state.error ? { message: state.error } : null,
        stderr: cleanGeminiStderr(stderrBuffer),
        fileChanges: state.fileChanges,
        touchedFiles: state.fileChanges.map((change) => change.path).filter(Boolean),
        commandExecutions: state.commandExecutions,
        stats: state.stats,
        model: state.model
      });
    });
  });
}

function ensureGeminiAvailable(_cwd) {
  const resolved = resolveGeminiBackend();
  if (!resolved.available) {
    throw new Error(resolved.detail || MISSING_BACKEND_DETAIL);
  }
  return resolved;
}

function resolveBinForBackend(backend, resolved) {
  if (resolved?.available && resolved.backend === backend && resolved.bin) {
    return resolved.bin;
  }
  const bin = defaultWhichBinary(backend);
  if (!bin) {
    throw new Error(
      backend === "agy"
        ? "`agy` is not available on PATH. Install Antigravity CLI, then rerun setup."
        : "`gemini` is not available on PATH. Install with `npm install -g @google/gemini-cli`, then rerun setup."
    );
  }
  return bin;
}

export async function runAppServerTurn(cwd, options = {}) {
  const resolved = resolveGeminiBackend();
  const backend = normalizeGeminiBackend(options.backend) ?? resolved.backend ?? "gemini";
  if (!normalizeGeminiBackend(options.backend) && !resolved.available) {
    throw new Error(resolved.detail || MISSING_BACKEND_DETAIL);
  }
  const bin = options.bin ?? resolveBinForBackend(backend, resolved);

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Gemini run.");
  }

  const write = options.write === true;
  const platform = options.platform ?? process.platform;
  const promptViaStdin = shouldPassPromptViaStdin(prompt, platform);
  const args = buildRunArgs(cwd, {
    backend,
    prompt,
    write,
    effort: options.effort ?? null,
    model: options.model ?? null,
    resumeSessionId: options.resumeThreadId ?? options.resumeSessionId ?? null,
    resumeLatest: options.resumeLatest ?? false,
    includeDirectories: options.includeDirectories,
    sandbox: options.sandbox ?? false,
    platform
  });

  const label = backend === "agy" ? "Antigravity" : "Gemini";
  emitProgress(
    options.onProgress,
    options.resumeThreadId || options.resumeSessionId
      ? `Resuming ${label} session ${options.resumeThreadId ?? options.resumeSessionId}.`
      : options.resumeLatest
        ? `Resuming the most recent ${label} session.`
        : `Starting ${label} run.`,
    "starting"
  );

  const result = await spawnGeminiRun(cwd, args, options.onProgress, {
    backend,
    bin,
    stdin: promptViaStdin ? prompt : null
  });
  if (result.sessionId) {
    emitProgress(
      options.onProgress,
      `Session ready (${result.sessionId}).`,
      "running",
      { sessionId: result.sessionId, threadId: result.sessionId }
    );
  }
  return result;
}

export async function runAppServerReview(cwd, options = {}) {
  const resolved = ensureGeminiAvailable(cwd);
  const backend = normalizeGeminiBackend(options.backend) ?? resolved.backend ?? "gemini";

  // Caller can supply a fully-built prompt (e.g. the adversarial-review
  // template). Falls back to the generic review prompt otherwise.
  const prompt =
    typeof options.prompt === "string" && options.prompt.trim()
      ? options.prompt
      : buildReviewPrompt(
          options.target ?? null,
          options.focusText ?? null,
          options.contextSummary ?? null
        );

  const result = await runAppServerTurn(cwd, {
    prompt,
    backend,
    write: false,
    model: options.model ?? null,
    onProgress: options.onProgress
  });

  return {
    ...result,
    sourceThreadId: result.sessionId,
    reviewText: result.finalMessage
  };
}
/**
 * Best-effort cancellation. `gemini --delete-session` takes a session *index*
 * (positional within the project's session list), not the UUID we have, so we
 * can't reliably target it from the CLI. The companion always kills the PID
 * via process.mjs as the primary cancel mechanism; this function exists for
 * interface parity with the opencode bridge.
 */
export async function interruptAppServerTurn(_cwd, { threadId } = {}) {
  return {
    attempted: Boolean(threadId),
    interrupted: false,
    transport: null,
    detail: threadId
      ? "Gemini CLI has no programmatic session-by-id cancel; relying on PID termination."
      : "missing threadId"
  };
}

export async function findLatestTaskThread(_cwd) {
  // The companion's persisted job state is the source of truth for resumable
  // tasks; gemini's own `--list-sessions` returns indices that aren't stable
  // for our use case. Mirror opencode.mjs by returning null.
  return null;
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Gemini did not return a final structured message.",
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

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
