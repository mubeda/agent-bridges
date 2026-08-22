#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildReviewArgs,
  buildRunArgs,
  getCursorAuthStatus,
  getCursorAvailability,
  parsePrintResult,
  parseStructuredResult,
  resolveCursorBin,
  resolveCursorSpawnCommand,
  shouldPassPromptViaStdin
} from "./lib/cursor.mjs";
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
      "  node scripts/cursor-companion.mjs setup [--json]",
      "  node scripts/cursor-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/cursor-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/cursor-companion.mjs task [--wait|--background] [--write] [--resume-last|--resume|--fresh] [--model <id>] [prompt]",
      "  node scripts/cursor-companion.mjs status [job-id] [--wait] [--all] [--json]",
      "  node scripts/cursor-companion.mjs result [job-id] [--json]",
      "  node scripts/cursor-companion.mjs cancel [job-id] [--json]",
      "  node scripts/cursor-companion.mjs transfer [--source <path>] [--wait|--background] [--write] [--json]",
      "  node scripts/cursor-companion.mjs task-resume-candidate [--json]"
    ].join("\n")
  );
}

function normalizeArgv(argv) {
  return argv.length === 1 && argv[0]?.trim() ? splitRawArgumentString(argv[0]) : argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) }
  });
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

function ensureCursorAvailable(cwd) {
  const availability = getCursorAvailability(cwd);
  if (!availability.available) throw new Error(availability.detail);
  return availability;
}

function renderSetupReport(report) {
  const lines = [
    "# Cursor Agent Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- binary: ${report.cursor.detail}`,
    `- version: ${report.version}`,
    `- auth: ${report.auth.detail}`,
    `- state dir: ${report.stateDir}`
  ];
  if (report.nextSteps.length) lines.push("", "Next steps:", ...report.nextSteps.map((step) => `- ${step}`));
  return `${lines.join("\n")}\n`;
}

async function buildSetupReport(cwd) {
  const cursor = getCursorAvailability(cwd);
  const auth = getCursorAuthStatus(cwd);
  const versionResult = runCommand(resolveCursorBin(), ["--version"], { cwd });
  const version = versionResult.error
    ? versionResult.error.message
    : (versionResult.stdout || versionResult.stderr || `exit ${versionResult.status}`).trim();
  const nextSteps = [];
  if (!cursor.available) nextSteps.push(cursor.detail);
  else if (!auth.loggedIn) nextSteps.push("Sign in to Cursor, then run `agent status`.");
  return {
    ready: cursor.available && auth.loggedIn,
    binary: resolveCursorBin(),
    cursor,
    version,
    auth,
    stateDir: resolveStateDir(resolveWorkspaceRoot(cwd)),
    nextSteps
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

function spawnCursor(cwd, args, promptViaStdin = null) {
  return new Promise((resolve, reject) => {
    const command = resolveCursorSpawnCommand();
    const child = spawn(command.file, [...command.args, ...args], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ status: code ?? 1, signal, stdout, stderr, pid: child.pid ?? null }));
    child.stdin.on("error", () => {});
    child.stdin.end(promptViaStdin ?? undefined);
  });
}

async function executePrintRun({ cwd, prompt, write, review, model, effort, resumeSessionId }) {
  const args = review
    ? buildReviewArgs({ prompt, model, effort, resumeSessionId })
    : buildRunArgs({ prompt, write, model, effort, resumeSessionId });
  ensureCursorAvailable(cwd);
  const command = await spawnCursor(cwd, args, shouldPassPromptViaStdin(prompt) ? prompt : null);
  return { command, parsed: parsePrintResult(command.stdout) };
}

function parseStructuredOutput(resultText) {
  return parseStructuredResult(resultText);
}

function renderExecution(request, command, parsed) {
  if (!request.review) {
    return parsed.resultText
      ? `${parsed.resultText}${parsed.resultText.endsWith("\n") ? "" : "\n"}`
      : `${command.stderr.trim() || "Cursor Agent did not return a final message."}\n`;
  }
  const title = `# Cursor Agent ${request.reviewName}`;
  const result = parseStructuredOutput(parsed.resultText);
  if (result) return `${title}\n\n${JSON.stringify(result, null, 2)}\n`;
  return `${title}\n\n${parsed.resultText || command.stderr || "Cursor Agent returned no review output."}\n`;
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
    const { command, parsed } = await executePrintRun(request);
    const status = command.status === 0 ? "completed" : "failed";
    const rendered = renderExecution(request, command, parsed);
    const completed = persistJob(job.workspaceRoot, {
      ...running,
      status,
      phase: status === "completed" ? "done" : "failed",
      pid: null,
      completedAt: nowIso(),
      cursorSessionId: parsed.sessionId,
      summary: firstMeaningfulLine(parsed.resultText, `${job.title} finished.`),
      result: {
        rawOutput: parsed.resultText,
        structuredOutput: request.review ? parseStructuredOutput(parsed.resultText) : null,
        cursor: command
      },
      rendered,
      ...(command.status === 0 ? {} : { errorMessage: command.stderr.trim() || `agent exited ${command.status}.` })
    });
    return { job: completed, rendered, exitStatus: command.status };
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
    scriptPath: path.join(ROOT_DIR, "scripts", "cursor-companion.mjs"),
    cwd,
    jobId,
    workerCommand: "run-worker"
  });
  const child = spawn(built.file, built.args, built.options);
  if (child.pid == null) {
    child.once("error", () => {});
    throw new Error("Failed to start Cursor Agent background worker.");
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
  await runPrintJob({ ...job, workspaceRoot }, job.request);
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
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const focusText = positionals.join(" ").trim();
  if (reviewName === "Review" && focusText) throw new Error("`review` does not accept focus text. Use `adversarial-review`.");
  const context = collectReviewContext(cwd, target);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const kind = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const job = createCompanionJob({
    prefix: "review",
    kind,
    title: `Cursor Agent ${reviewName}`,
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
    (job) => job.jobClass === "task" && !isActive(job) && job.cursorSessionId
  )?.cursorSessionId ?? null;
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const resumeLatest = Boolean(options["resume-last"] || options.resume);
  if (resumeLatest && options.fresh) throw new Error("Choose either --resume/--resume-last or --fresh.");
  const prompt = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ") || readStdinIfPiped();
  const resumeSessionId = resumeLatest ? findLatestTaskSession(workspaceRoot) : null;
  if (resumeLatest && !resumeSessionId) throw new Error("No previous Cursor Agent task session was found for this repository.");
  if (!prompt && !resumeLatest) throw new Error("Provide a prompt, prompt file, piped stdin, or use --resume-last.");
  const effectivePrompt = prompt || "Continue the previous task.";
  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: resumeLatest ? "Cursor Agent Resume" : "Cursor Agent Task",
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
  const lines = ["# Cursor Agent Status", ""];
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
  if (!selected.job) throw new Error("No Cursor Agent job found for this repository.");
  if (isActive(selected.job)) throw new Error(`Job ${selected.job.id} is still ${selected.job.status}.`);
  const storedJob = readStoredJob(selected.workspaceRoot, selected.job.id);
  const rendered = storedJob?.rendered ?? storedJob?.result?.rawOutput ?? selected.job.errorMessage ?? "No captured result payload was stored for this job.";
  outputCommandResult({ job: selected.job, storedJob }, `${rendered}${rendered.endsWith("\n") ? "" : "\n"}`, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const selected = findJob(resolveCommandCwd(options), positionals[0] ?? "", isActive);
  if (!selected.job) throw new Error("No active Cursor Agent job found.");
  terminateProcessTree(selected.job.pid ?? Number.NaN, { cwd: selected.workspaceRoot });
  const cancelled = persistJob(selected.workspaceRoot, {
    ...(readStoredJob(selected.workspaceRoot, selected.job.id) ?? selected.job),
    ...selected.job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
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
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const source = resolveTransferSource(cwd, { source: options.source });
  const prompt = buildHandoffPrompt(packTranscript(capTranscriptMessages(parseTranscriptJsonl(source.path))));
  const job = createCompanionJob({
    prefix: "transfer",
    kind: "transfer",
    title: "Cursor Agent Transfer",
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
    { host: source.host, sourcePath: source.path, job: execution.job, sessionId: execution.job.cursorSessionId ?? null },
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
      (job) => job.jobClass === "task" && !isActive(job) && job.cursorSessionId
    ) ?? null;
  const payload = {
    available: Boolean(candidate),
    candidate: candidate
      ? {
          id: candidate.id,
          status: candidate.status,
          title: candidate.title ?? null,
          summary: candidate.summary ?? null,
          cursorSessionId: candidate.cursorSessionId
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
