#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildPrintInvocation,
  formatDeniedActions,
  getAgyAvailability,
  getAgySetupFacts,
  parsePrintResult,
  resolveAgyBin,
  resolveAgySpawnCommand,
  validateEffort
} from "./lib/agy.mjs";
import { buildDetachedWorkerOptions, mergeSpawnedPid } from "./lib/detach.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { capTranscriptMessages, packTranscript, parseTranscriptJsonl, resolveTransferSource } from "./lib/host-session.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { createJobRecord, nowIso } from "./lib/tracked-jobs.mjs";
import { buildHandoffPrompt } from "./lib/transfer-dest.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2_000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/antigravity-companion.mjs setup [--json]",
      "  node scripts/antigravity-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/antigravity-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/antigravity-companion.mjs task [--wait|--background] [--write] [--resume-last|--resume|--fresh] [--model <id>] [prompt]",
      "  node scripts/antigravity-companion.mjs status [job-id] [--wait] [--all] [--json]",
      "  node scripts/antigravity-companion.mjs result [job-id] [--json]",
      "  node scripts/antigravity-companion.mjs cancel [job-id] [--json]",
      "  node scripts/antigravity-companion.mjs transfer [--source <path>] [--wait|--background] [--write] [--json]",
      "  node scripts/antigravity-companion.mjs task-resume-candidate [--json]"
    ].join("\n")
  );
}

function normalizeArgv(argv) {
  return argv.length === 1 && argv[0]?.trim() ? splitRawArgumentString(argv[0]) : argv;
}

/**
 * Permission opt-ins. --write makes the backend CLI auto-approve its tools, so it needs
 * --bypass-permissions or AGENT_BRIDGES_ALLOW_BYPASS=1. --trust (or AGENT_BRIDGES_TRUST=1)
 * lets a backend skip its folder-trust check; the env var reaches background workers too.
 */
function applyPermissionOptIns(options) {
  if (options.trust) process.env.AGENT_BRIDGES_TRUST = "1";
  if (options.write && !options["bypass-permissions"] && process.env.AGENT_BRIDGES_ALLOW_BYPASS !== "1") {
    throw new Error(
      "--write lets the backend CLI change files and run commands without asking. Add --bypass-permissions to this command, or set AGENT_BRIDGES_ALLOW_BYPASS=1, to allow it."
    );
  }
}

function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    booleanOptions: [...(config.booleanOptions ?? []), "bypass-permissions", "trust"],
    aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) }
  });
  applyPermissionOptIns(parsed.options);
  return parsed;
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function outputResult(value, asJson) {
  if (asJson) console.log(JSON.stringify(value, null, 2));
  else process.stdout.write(value);
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isActive(job) {
  return job.status === "queued" || job.status === "running";
}

function sortJobs(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  return fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
}

function findJob(cwd, reference = "", predicate = () => true) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobs(listJobs(workspaceRoot)).filter(predicate);
  if (!reference) return { workspaceRoot, job: jobs[0] ?? null };
  const exact = jobs.find((job) => job.id === reference);
  if (exact) return { workspaceRoot, job: exact };
  const matches = jobs.filter((job) => job.id.startsWith(reference));
  if (matches.length > 1) throw new Error(`Job reference "${reference}" is ambiguous.`);
  return { workspaceRoot, job: matches[0] ?? null };
}

function persistJob(workspaceRoot, job) {
  writeJobFile(workspaceRoot, job.id, job);
  upsertJob(workspaceRoot, job);
  return job;
}

function ensureAgyAvailable(cwd) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) throw new Error(availability.detail);
  return availability;
}

function renderSetupReport(report) {
  const lines = [
    "# Antigravity Setup",
    "",
    `Status: ${report.available ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- binary: ${report.resolvedPath ?? report.bin}`,
    `- version: ${report.version ?? "unavailable"}`,
    `- GEMINI_API_KEY ${report.apiKeySet ? "set" : "not set"}`,
    `- state dir: ${report.stateDir}`,
    "",
    `Sign-in: ${report.signInNote}`
  ];
  if (report.nextSteps.length) lines.push("", "Next steps:", ...report.nextSteps.map((step) => `- ${step}`));
  return `${lines.join("\n")}\n`;
}

async function buildSetupReport(cwd) {
  const facts = getAgySetupFacts(cwd);
  return {
    ...facts,
    stateDir: resolveStateDir(resolveWorkspaceRoot(cwd)),
    nextSteps: facts.available ? [] : [facts.detail]
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const report = await buildSetupReport(resolveCommandCwd(options));
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

function buildReviewPrompt(context, focusText, reviewName) {
  const schemaText = fs.readFileSync(REVIEW_SCHEMA, "utf8").trimEnd();
  if (reviewName === "Adversarial Review") {
    return interpolateTemplate(loadPromptTemplate(ROOT_DIR, "adversarial-review"), {
      TARGET_LABEL: context.target.label,
      USER_FOCUS: focusText || "No extra focus provided.",
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
      REVIEW_SCHEMA: schemaText,
      REVIEW_INPUT: context.content
    });
  }
  return [
    "Review the repository changes below. Report only material, actionable defects.",
    `Target: ${context.target.label}`,
    context.collectionGuidance,
    "Return only JSON matching this schema:",
    schemaText,
    "Repository context:",
    context.content
  ].join("\n\n");
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: kind,
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    invoke: "print"
  });
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function spawnAgy(cwd, args, promptViaStdin = null, onSpawn = null, onSignal = null) {
  return new Promise((resolve, reject) => {
    const command = resolveAgySpawnCommand();
    // POSIX: agy leads its own process group so cancel can end its whole tree (plan P13).
    const detached = process.platform !== "win32";
    const child = spawn(command.file, [...command.args, ...args], { cwd, windowsHide: true, detached, stdio: ["pipe", "pipe", "pipe"] });
    // A detached agy no longer gets the terminal's signals, so forward them to its group.
    let stopping = false;
    const forward = async (signal) => {
      if (stopping) return;
      stopping = true;
      // Same as cancel: a write run must not leave a SIGTERM-resistant command editing files after we exit.
      if (child.pid) await endAgyTree(child.pid, cwd);
      if (onSignal) onSignal(signal);
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    if (detached) for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    const stopForwarding = () => {
      if (detached) for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
    };
    if (child.pid && onSpawn) onSpawn(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { stopForwarding(); reject(error); });
    child.once("close", (code, signal) => { stopForwarding(); resolve({ status: code ?? 1, signal, stdout, stderr, pid: child.pid ?? null }); });
    child.stdin.on("error", () => {});
    child.stdin.end(promptViaStdin ?? undefined);
  });
}

async function executePrintRun({ cwd, prompt, write, review, model, effort, resumeSessionId }, onSpawn = null, onSignal = null) {
  const { args, stdin } = buildPrintInvocation({
    prompt,
    write,
    review,
    model,
    effort,
    resumeSessionId,
    schemaPath: review ? REVIEW_SCHEMA : undefined
  });
  ensureAgyAvailable(cwd);
  const command = await spawnAgy(cwd, args, stdin, onSpawn, onSignal);
  return {
    command,
    parsed: parsePrintResult(command.stdout, { requestedConversationId: resumeSessionId, exitCode: command.status, stderr: command.stderr })
  };
}

function renderExecution(request, command, parsed) {
  const lines = [];
  if (parsed.warning) lines.push(`Warning: ${parsed.warning}`, "");
  if (!parsed.ok) {
    lines.push(`Antigravity run failed: ${parsed.error}`);
    if (parsed.resultText) lines.push("", parsed.resultText);
    return `${lines.join("\n")}\n`;
  }
  if (!request.review) {
    lines.push(parsed.resultText || command.stderr.trim() || "Antigravity did not return a final message.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`# Antigravity ${request.reviewName}`, "");
  if (parsed.structured) {
    lines.push(JSON.stringify(parsed.structured, null, 2));
    if (parsed.deniedActions.length) lines.push("", `Denied: ${formatDeniedActions(parsed.deniedActions)}`);
  } else {
    lines.push(parsed.resultText || "Antigravity returned no review output.", "", "No structured result came back from Antigravity.");
  }
  return `${lines.join("\n")}\n`;
}

async function runPrintJob(job, request) {
  const running = persistJob(job.workspaceRoot, {
    ...job,
    status: "running",
    phase: "running",
    pid: process.pid,
    startedAt: nowIso(),
    worktree: request.cwd
  });
  try {
    const { command, parsed } = await executePrintRun(
      request,
      (agyPid) => {
        persistJob(job.workspaceRoot, { ...running, agyPid });
      },
      (signal) => {
        persistJob(job.workspaceRoot, { ...running, status: "failed", phase: "failed", pid: null, agyPid: null, completedAt: nowIso(), errorMessage: `Interrupted by ${signal}.` });
      }
    );
    // cancel may have finished the job while agy was stopping; never overwrite that.
    const current = readStoredJob(job.workspaceRoot, job.id);
    if (current?.status === "cancelled") return { job: current, rendered: "Cancelled by user.\n", exitStatus: 1 };
    const status = parsed.ok ? "completed" : "failed";
    const rendered = renderExecution(request, command, parsed);
    const completed = persistJob(job.workspaceRoot, {
      ...running,
      status,
      phase: status === "completed" ? "done" : "failed",
      pid: null,
      completedAt: nowIso(),
      agySessionId: parsed.sessionId,
      summary: firstMeaningfulLine(parsed.resultText, `${job.title} finished.`),
      result: {
        rawOutput: parsed.resultText,
        structuredOutput: request.review ? parsed.structured : null,
        agy: command
      },
      rendered,
      warning: parsed.warning,
      ...(parsed.ok ? {} : { errorMessage: parsed.error })
    });
    return { job: completed, rendered, exitStatus: parsed.ok ? 0 : 1 };
  } catch (error) {
    persistJob(job.workspaceRoot, {
      ...running,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: nowIso(),
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function spawnDetachedWorker(cwd, jobId) {
  const built = buildDetachedWorkerOptions({
    execPath: process.execPath,
    scriptPath: path.join(ROOT_DIR, "scripts", "antigravity-companion.mjs"),
    cwd,
    jobId,
    workerCommand: "run-worker"
  });
  const child = spawn(built.file, built.args, built.options);
  if (child.pid == null) {
    child.once("error", () => {});
    throw new Error("Failed to start Antigravity background worker.");
  }
  child.unref();
  return child;
}

function enqueueBackground(job, request) {
  const queued = persistJob(job.workspaceRoot, {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    request
  });
  try {
    const child = spawnDetachedWorker(request.cwd, job.id);
    const record = mergeSpawnedPid(readStoredJob(job.workspaceRoot, job.id) ?? queued, child.pid);
    return persistJob(job.workspaceRoot, record);
  } catch (error) {
    persistJob(job.workspaceRoot, {
      ...queued,
      status: "failed",
      phase: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      completedAt: nowIso()
    });
    throw error;
  }
}

async function handleRunWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "job-id"] });
  if (!options["job-id"]) throw new Error("Missing required --job-id for run-worker.");
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = readStoredJob(workspaceRoot, options["job-id"]);
  if (!job?.request) throw new Error(`No stored job request found for ${options["job-id"]}.`);
  // A job cancelled before its worker started must never run.
  if (job.status !== "queued") return;
  // The job record, not the nested request, decides write permission: a review or read-only job never writes.
  const write = job.write === true && job.request.review !== true && job.request.write === true;
  await runPrintJob({ ...job, workspaceRoot }, { ...job.request, write });
}

function buildRequest(cwd, options, prompt, extra = {}) {
  return {
    cwd,
    prompt,
    write: Boolean(options.write),
    review: false,
    model: options.model,
    effort: options.effort,
    resumeSessionId: extra.resumeSessionId ?? null,
    ...extra
  };
}

async function handleReviewCommand(argv, { reviewName }) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait", "focus-stdin"],
    aliasMap: { m: "model" }
  });
  validateEffort(options.effort);
  const cwd = resolveCommandCwd(options);
  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  // --focus-stdin: the focus arrives on stdin, so it never sits in this process's argv.
  const focusText = (options["focus-stdin"] ? readStdinIfPiped() : positionals.join(" ")).trim();
  if (reviewName === "Review" && focusText) throw new Error("`review` does not accept focus text. Use `adversarial-review`.");
  const context = collectReviewContext(cwd, target);
  ensureAgyAvailable(cwd);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const kind = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const job = createCompanionJob({
    prefix: "review",
    kind,
    title: `Antigravity ${reviewName}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${reviewName} ${target.label}`
  });
  const request = buildRequest(cwd, options, buildReviewPrompt(context, focusText, reviewName), {
    write: false,
    review: true,
    reviewName,
    targetLabel: target.label
  });
  if (options.background) {
    const queued = enqueueBackground(job, request);
    outputCommandResult({ jobId: queued.id, status: queued.status }, `${job.title} started in the background as ${job.id}.\n`, options.json);
    return;
  }
  const execution = await runPrintJob(job, request);
  outputCommandResult({ job: execution.job }, execution.rendered, options.json);
  if (execution.exitStatus !== 0) process.exitCode = execution.exitStatus;
}

function findLatestTaskSession(workspaceRoot) {
  return sortJobs(listJobs(workspaceRoot)).find(
    (job) => job.jobClass === "task" && !isActive(job) && job.agySessionId
  )?.agySessionId ?? null;
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: { m: "model" }
  });
  validateEffort(options.effort);
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const resumeLatest = Boolean(options["resume-last"] || options.resume);
  if (resumeLatest && options.fresh) throw new Error("Choose either --resume/--resume-last or --fresh.");
  const prompt = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ") || readStdinIfPiped();
  const resumeSessionId = resumeLatest ? findLatestTaskSession(workspaceRoot) : null;
  if (resumeLatest && !resumeSessionId) throw new Error("No previous Antigravity task session was found for this repository.");
  if (!prompt && !resumeLatest) throw new Error("Provide a prompt, prompt file, piped stdin, or use --resume-last.");
  const effectivePrompt = prompt || "Continue the previous task.";
  ensureAgyAvailable(cwd);
  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: resumeLatest ? "Antigravity Resume" : "Antigravity Task",
    workspaceRoot,
    jobClass: "task",
    summary: shorten(effectivePrompt),
    write: Boolean(options.write)
  });
  const request = buildRequest(cwd, options, effectivePrompt, { resumeSessionId });
  if (options.background) {
    const queued = enqueueBackground(job, request);
    outputCommandResult({ jobId: queued.id, status: queued.status }, `${job.title} started in the background as ${job.id}.\n`, options.json);
    return;
  }
  const execution = await runPrintJob(job, request);
  outputCommandResult({ job: execution.job }, execution.rendered, options.json);
  if (execution.exitStatus !== 0) process.exitCode = execution.exitStatus;
}

function buildStatusSnapshot(cwd, all = false) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobs(listJobs(workspaceRoot));
  const running = jobs.filter(isActive);
  const finished = jobs.filter((job) => !isActive(job));
  return { workspaceRoot, running, latestFinished: finished[0] ?? null, recent: all ? finished.slice(1) : finished.slice(1, 9) };
}

function renderStatusReport(report) {
  const lines = ["# Antigravity Status", ""];
  if (report.running.length) lines.push("Active jobs:", ...report.running.map((job) => `- ${job.id} | ${job.status} | ${job.title}`), "");
  if (report.latestFinished) lines.push(`Latest finished: ${report.latestFinished.id} | ${report.latestFinished.status} | ${report.latestFinished.title}`, "");
  if (report.recent.length) lines.push("Recent jobs:", ...report.recent.map((job) => `- ${job.id} | ${job.status} | ${job.title}`));
  if (!report.running.length && !report.latestFinished) lines.push("No jobs recorded yet.");
  return `${lines.join("\n")}\n`;
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    if (options.wait) throw new Error("`status --wait` requires a job id.");
    const report = buildStatusSnapshot(cwd, options.all);
    outputResult(options.json ? report : renderStatusReport(report), options.json);
    return;
  }
  const deadline = Date.now() + Math.max(0, Number(options["timeout-ms"]) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollInterval = Math.max(100, Number(options["poll-interval-ms"]) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  let selected = findJob(cwd, reference);
  if (!selected.job) throw new Error(`No job found for "${reference}".`);
  while (options.wait && isActive(selected.job) && Date.now() < deadline) {
    await sleep(pollInterval);
    selected = findJob(cwd, reference);
    if (!selected.job) throw new Error(`No job found for "${reference}".`);
  }
  outputCommandResult({ workspaceRoot: selected.workspaceRoot, job: selected.job }, `${selected.job.id}: ${selected.job.status}\n`, options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const selected = findJob(resolveCommandCwd(options), positionals[0] ?? "");
  if (!selected.job) throw new Error("No Antigravity job found for this repository.");
  if (isActive(selected.job)) throw new Error(`Job ${selected.job.id} is still ${selected.job.status}.`);
  const storedJob = readStoredJob(selected.workspaceRoot, selected.job.id);
  const stored = storedJob?.rendered ?? storedJob?.result?.rawOutput ?? null;
  const error = selected.job.status === "failed" ? (storedJob?.errorMessage ?? selected.job.errorMessage ?? null) : null;
  const rendered = error && !String(stored ?? "").includes(error)
    ? [error, stored].filter(Boolean).join("\n\n")
    : stored ?? selected.job.errorMessage ?? "No captured result payload was stored for this job.";
  outputCommandResult({ job: selected.job, storedJob }, `${rendered}${rendered.endsWith("\n") ? "" : "\n"}`, options.json);
}

function groupAlive(pid) {
  if (!Number.isFinite(pid) || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the agy process group, then SIGKILL whatever is left after a short grace period (R8). */
async function endAgyTree(pid, cwd) {
  if (!Number.isFinite(pid)) return;
  terminateProcessTree(pid, { cwd });
  const deadline = Date.now() + 2000;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(100);
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const selected = findJob(resolveCommandCwd(options), positionals[0] ?? "", isActive);
  if (!selected.job) throw new Error("No active Antigravity job found.");
  const storedForCancel = readStoredJob(selected.workspaceRoot, selected.job.id) ?? selected.job;
  // End the agy tree first: it no longer shares the companion's process group.
  await endAgyTree(storedForCancel.agyPid ?? selected.job.agyPid ?? Number.NaN, selected.workspaceRoot);
  terminateProcessTree(selected.job.pid ?? Number.NaN, { cwd: selected.workspaceRoot });
  const cancelled = persistJob(selected.workspaceRoot, {
    ...(readStoredJob(selected.workspaceRoot, selected.job.id) ?? selected.job),
    ...selected.job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    agyPid: null,
    completedAt: nowIso(),
    errorMessage: "Cancelled by user."
  });
  outputCommandResult({ jobId: cancelled.id, status: cancelled.status }, `Cancelled ${cancelled.id}.\n`, options.json);
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source", "model", "effort"],
    booleanOptions: ["json", "write", "background", "wait"],
    aliasMap: { m: "model" }
  });
  validateEffort(options.effort);
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const source = resolveTransferSource(cwd, { source: options.source });
  const prompt = buildHandoffPrompt(packTranscript(capTranscriptMessages(parseTranscriptJsonl(source.path))));
  ensureAgyAvailable(cwd);
  const job = createCompanionJob({
    prefix: "transfer",
    kind: "transfer",
    title: "Antigravity Transfer",
    workspaceRoot,
    jobClass: "task",
    summary: `Transfer from ${source.host}`,
    write: Boolean(options.write)
  });
  const request = buildRequest(cwd, options, prompt);
  if (options.background || !options.wait) {
    const queued = enqueueBackground(job, request);
    outputCommandResult(
      { host: source.host, sourcePath: source.path, jobId: queued.id, status: queued.status },
      `Transferred handoff queued as ${queued.id}.\n`,
      options.json
    );
    return;
  }
  const execution = await runPrintJob(job, request);
  outputCommandResult(
    { host: source.host, sourcePath: source.path, job: execution.job, sessionId: execution.job.agySessionId ?? null },
    execution.rendered,
    options.json
  );
  if (execution.exitStatus !== 0) process.exitCode = execution.exitStatus;
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const candidate =
    sortJobs(listJobs(resolveWorkspaceRoot(resolveCommandCwd(options)))).find(
      (job) => job.jobClass === "task" && !isActive(job) && job.agySessionId
    ) ?? null;
  const payload = {
    available: Boolean(candidate),
    candidate: candidate
      ? {
          id: candidate.id,
          status: candidate.status,
          title: candidate.title ?? null,
          summary: candidate.summary ?? null,
          agySessionId: candidate.agySessionId
        }
      : null
  };
  outputCommandResult(
    payload,
    candidate ? `Resumable task found: ${candidate.id} (${candidate.status}).\n` : "No resumable task found.\n",
    options.json
  );
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") return printUsage();
  switch (subcommand) {
    case "setup": return handleSetup(argv);
    case "review": return handleReviewCommand(argv, { reviewName: "Review" });
    case "adversarial-review": return handleReviewCommand(argv, { reviewName: "Adversarial Review" });
    case "task": return handleTask(argv);
    case "run-worker": return handleRunWorker(argv);
    case "status": return handleStatus(argv);
    case "result": return handleResult(argv);
    case "cancel": return handleCancel(argv);
    case "transfer": return handleTransfer(argv);
    case "task-resume-candidate": return handleTaskResumeCandidate(argv);
    default: throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
