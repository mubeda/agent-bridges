#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getAgyAuthStatus,
    getGeminiAuthStatus,
    getGeminiAvailability,
    getGeminiDefaultModel,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    pickTaskRunBackend,
    resolveGeminiBackend,
    resumeTargetFromJob,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/gemini.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { buildDetachedWorkerOptions, mergeSpawnedPid } from "./lib/detach.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";
import {
  packTranscript,
  parseTranscriptJsonl,
  resolveTransferSource
} from "./lib/host-session.mjs";
import { buildHandoffPrompt, formatTransferResult } from "./lib/transfer-dest.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_AGY_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
// Gemini CLI has no per-invocation reasoning-effort knob (Pro<->Flash routing
// happens through `general.plan.modelRouting` in settings). When users pass
// --effort against the gemini backend we log a deprecation note and ignore it.
// Against agy, --effort low|medium|high is forwarded.

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/gemini-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/gemini-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/gemini-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <alias|id>] [--effort <low|medium|high>] [prompt]",
      "  node scripts/gemini-companion.mjs review-worker --cwd <path> --job-id <id>",
      "  node scripts/gemini-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/gemini-companion.mjs result [job-id] [--json]",
      "  node scripts/gemini-companion.mjs cancel [job-id] [--json]",
      "  node scripts/gemini-companion.mjs transfer [--source <path>] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function normalizeReasoningEffort(effort, backend = "gemini") {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (backend === "agy") {
    if (!VALID_AGY_REASONING_EFFORTS.has(normalized)) {
      throw new Error(
        `Unsupported reasoning effort "${effort}". Use one of: low, medium, high.`
      );
    }
    return normalized;
  }
  process.stderr.write(
    `[gemini-companion] --effort=${normalized} is ignored: Gemini has no per-invocation effort knob. Use --model auto|pro|flash|flash-lite instead.\n`
  );
  return null;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const geminiStatus = getGeminiAvailability(cwd);
  const backend = geminiStatus.backend ?? null;
  const bin = geminiStatus.bin ?? null;
  const authStatus =
    backend === "agy" ? getAgyAuthStatus() : await getGeminiAuthStatus(cwd);
  const modelStatus = geminiStatus.available
    ? getGeminiDefaultModel(cwd)
    : {
        configured: false,
        model: null,
        source: "unavailable",
        detail: geminiStatus.detail
      };

  const config = getConfig(workspaceRoot);
  const nextSteps = [];
  if (!geminiStatus.available) {
    nextSteps.push(
      "Install Antigravity (`agy`) and/or Gemini CLI with `npm install -g @google/gemini-cli` (or `brew install gemini-cli`)."
    );
  }
  if (geminiStatus.available && !authStatus.loggedIn) {
    if (backend === "agy") {
      nextSteps.push("Run `agy` once interactively to sign in to Antigravity.");
    } else {
      nextSteps.push(
        "Export `GEMINI_API_KEY` (AI Studio) or set the Vertex triple `GOOGLE_API_KEY` + `GOOGLE_GENAI_USE_VERTEXAI=true` + `GOOGLE_CLOUD_PROJECT`."
      );
    }
  }
  if (!config.stopReviewGate) {
    nextSteps.push(
      "Optional: run `/gemini:setup --enable-review-gate` to require a fresh review before stop."
    );
  }

  return {
    ready: nodeStatus.available && geminiStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    gemini: geminiStatus,
    auth: authStatus,
    model: modelStatus,
    backend,
    bin,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  const schemaText = fs.readFileSync(REVIEW_SCHEMA, "utf8").trimEnd();
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_SCHEMA: schemaText,
    REVIEW_INPUT: context.content
  });
}

function ensureGeminiAvailable(cwd) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      availability.detail ||
        "Neither `agy` nor `gemini` is installed. Install Antigravity (`agy`) and/or `npm install -g @google/gemini-cli`, then rerun `/gemini:setup`."
    );
  }
  return availability;
}

function validateReviewRequest(_target, focusText, { reviewName }) {
  if (reviewName === "Review" && focusText.trim()) {
    throw new Error(
      `\`/gemini:review\` does not accept custom focus text. Retry with \`/gemini:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  // Only completed or failed tasks are resumable; queued/running/cancelled
  // are not. The Gemini CLI has no programmatic session deletion, so
  // cancelled sessions still exist server-side, but resuming a session the
  // user explicitly stopped is intentionally unsupported here.
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        (job.status === "completed" || job.status === "failed")
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /gemini:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return resumeTargetFromJob(trackedTask);
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  const availability = ensureGeminiAvailable(request.cwd);
  const backend = request.backend ?? availability.backend ?? "gemini";
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  validateReviewRequest(target, focusText, { reviewName });

  const context = collectReviewContext(request.cwd, target);
  const adversarialPrompt =
    reviewName === "Adversarial Review"
      ? buildAdversarialReviewPrompt(context, focusText)
      : null;
  const result = await runAppServerReview(context.repoRoot, {
    target,
    focusText: reviewName === "Adversarial Review" ? focusText : null,
    contextSummary: context.content,
    prompt: adversarialPrompt,
    model: request.model,
    backend,
    onProgress: request.onProgress
  });

  const reviewText = typeof result.reviewText === "string" ? result.reviewText : "";
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    sourceThreadId: result.sourceThreadId,
    backend: result.backend ?? backend,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    gemini: {
      status: result.status,
      stderr: result.stderr,
      stdout: reviewText,
      reasoning: result.reasoningSummary
    }
  };

  const rendered = renderNativeReviewResult(
    {
      status: result.status,
      stdout: reviewText,
      stderr: result.stderr
    },
    {
      reviewLabel: reviewName,
      targetLabel: target.label,
      reasoningSummary: result.reasoningSummary
    }
  );

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    backend: result.backend ?? backend,
    payload,
    rendered,
    summary: firstMeaningfulLine(reviewText, `${reviewName} completed.`),
    jobTitle: `Gemini ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const availability = ensureGeminiAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  let resumeBackend = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Gemini task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
    resumeBackend = latestThread.backend ?? null;
  }

  const backend = pickTaskRunBackend({
    resumeBackend,
    requestBackend: request.backend,
    resolvedBackend: availability.backend
  });

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    backend,
    write: request.write === true,
    effort: request.effort ?? null,
    // Gemini reads/writes within the workspace by default. Opt-in sandbox
    // (Docker/Podman/Seatbelt) is enabled via the request.sandbox flag set
    // upstream; leave undefined to inherit the user's local config.
    sandbox: request.sandbox === true,
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      backend: result.backend ?? backend
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    backend: result.backend ?? backend,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    backend: result.backend ?? backend,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: `Gemini ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "Gemini Resume" : "Gemini Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /gemini:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, backend = null }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    ...(backend ? { backend } : {})
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, backend = null) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
    backend
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, backend }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    backend
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedWorker(cwd, jobId, workerCommand) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "gemini-companion.mjs");
  const built = buildDetachedWorkerOptions({
    execPath: process.execPath,
    scriptPath,
    cwd,
    jobId,
    workerCommand
  });
  try {
    const child = spawn(built.file, built.args, built.options);
    if (child.pid == null) {
      child.once("error", () => {});
      throw new Error(`Failed to start ${workerCommand}: child process has no pid.`);
    }
    child.unref();
    return child;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to start ${workerCommand}: ${message}`, { cause: error });
  }
}

function enqueueBackgroundTask(cwd, job, request, workerCommand = "task-worker") {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // Write the job record before spawning the worker so the detached child
  // can never lose the race to readStoredJob — otherwise --background can
  // silently fail with "No stored job found" on fast filesystems.
  const baseRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, baseRecord);
  upsertJob(job.workspaceRoot, baseRecord);

  let child;
  try {
    child = spawnDetachedWorker(cwd, job.id, workerCommand);
  } catch (error) {
    const failedRecord = {
      ...baseRecord,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage: error instanceof Error ? error.message : String(error),
      completedAt: nowIso()
    };
    writeJobFile(job.workspaceRoot, job.id, failedRecord);
    upsertJob(job.workspaceRoot, failedRecord);
    throw error;
  }
  const storedAfterSpawn = readStoredJob(job.workspaceRoot, job.id);
  if (storedAfterSpawn) {
    const recordWithPid = mergeSpawnedPid(storedAfterSpawn, child.pid);
    if (recordWithPid !== storedAfterSpawn) {
      writeJobFile(job.workspaceRoot, job.id, recordWithPid);
      upsertJob(job.workspaceRoot, recordWithPid);
    }
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const availability = getGeminiAvailability(cwd);
  const backend = availability.backend ?? null;
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
    backend
  });
  if (options.background) {
    ensureGeminiAvailable(cwd);

    const request = {
      cwd,
      base: options.base,
      scope: options.scope,
      model: options.model,
      focusText,
      reviewName: config.reviewName,
      backend
    };
    const { payload } = enqueueBackgroundTask(cwd, job, request, "review-worker");
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        backend,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: (target, focusText) =>
      validateReviewRequest(target, focusText, { reviewName: "Review" })
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const resolved = resolveGeminiBackend();
  const backend = resolved.backend ?? "gemini";
  const effort = normalizeReasoningEffort(options.effort, backend);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureGeminiAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, backend);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      backend
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, backend);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        backend,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleReviewWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for review-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its review request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeReviewRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Gemini session interrupt for ${threadId}.`
        : `Gemini session interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

function renderTransferResult(payload) {
  const label = payload.backend === "agy" ? "Antigravity" : "Gemini";
  const lines = [
    `Transferred the host transcript into a ${label} session via prompt handoff.`,
    `Source (${payload.host}): ${payload.sourcePath}`,
    `${label} session ID: ${payload.sessionId}`,
    `Resume in ${label}: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const availability = ensureGeminiAvailable(cwd);
  const backend = availability.backend ?? "gemini";

  const resolved = resolveTransferSource(cwd, { source: options.source });
  const messages = parseTranscriptJsonl(resolved.path);
  const packed = packTranscript(messages);
  const prompt = buildHandoffPrompt(packed);

  const result = await runAppServerTurn(workspaceRoot, {
    prompt,
    write: false,
    backend,
    persistThread: true,
    threadName: buildPersistentTaskThreadName(`Transfer from ${resolved.host}`)
  });

  if (result.status !== 0) {
    const failure = result.error?.message ?? result.stderr ?? "Transfer handoff failed.";
    throw new Error(failure);
  }

  const threadId = result.threadId ?? result.sessionId;
  if (!threadId) {
    throw new Error("Transfer handoff completed without a session id.");
  }

  const transfer = formatTransferResult({
    backend: result.backend ?? backend,
    threadId
  });

  const payload = {
    host: resolved.host,
    sourcePath: resolved.path,
    backend: result.backend ?? backend,
    sessionId: transfer.sessionId,
    threadId,
    resumeCommand: transfer.resumeCommand
  };

  outputCommandResult(payload, renderTransferResult(payload), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "review-worker":
      await handleReviewWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
