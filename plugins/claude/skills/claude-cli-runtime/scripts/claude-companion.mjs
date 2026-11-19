#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildClaudeSpawnOptions,
  buildRunArgs,
  getBypassDisclaimerStatus,
  getClaudeAuthStatus,
  getClaudeAvailability,
  parseBgShortId,
  parsePrintResult,
  refreshJobFromAgentsJson,
  resolveClaudeBin,
  shouldPassPromptViaStdin
} from "./lib/claude.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  capTranscriptMessages,
  packTranscript,
  parseTranscriptJsonl,
  resolveTransferSource
} from "./lib/host-session.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { buildHandoffPrompt } from "./lib/transfer-dest.mjs";
import { createJobRecord, nowIso } from "./lib/tracked-jobs.mjs";
import {
  generateJobId,
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobsDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2_000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/claude-companion.mjs setup [--json]",
      "  node scripts/claude-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/claude-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/claude-companion.mjs task [--wait|--background] [--write] [--resume-last|--resume|--fresh] [--model <alias|id>] [--effort <low|medium|high>] [prompt]",
      "  node scripts/claude-companion.mjs status [job-id] [--wait] [--all] [--json]",
      "  node scripts/claude-companion.mjs result [job-id] [--json]",
      "  node scripts/claude-companion.mjs cancel [job-id] [--json]",
      "  node scripts/claude-companion.mjs transfer [--source <path>] [--wait|--background] [--write] [--json]",
      "  node scripts/claude-companion.mjs task-resume-candidate [--json]"
    ].join("\n")
  );
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    return raw?.trim() ? splitRawArgumentString(raw) : [];
  }
  return argv;
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
  return ["queued", "running", "blocked"].includes(job.status);
}

function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  return fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
}

function sortJobs(jobs) {
  return [...jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
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

function ensureClaudeAvailable(cwd) {
  const availability = getClaudeAvailability(cwd);
  if (!availability.available) throw new Error(availability.detail);
  return availability;
}

async function buildSetupReport(cwd) {
  const node = binaryAvailable("node", ["--version"], { cwd });
  const npm = binaryAvailable("npm", ["--version"], { cwd });
  const claude = getClaudeAvailability(cwd);
  const auth = getClaudeAuthStatus(cwd);
  const bypassDisclaimer = getBypassDisclaimerStatus();
  const nextSteps = [];
  if (!claude.available) nextSteps.push(claude.detail);
  else if (!auth.loggedIn) nextSteps.push("Run `claude auth login`.");
  if (!bypassDisclaimer.accepted) nextSteps.push(bypassDisclaimer.detail);
  return {
    ready: node.available && claude.available && auth.loggedIn,
    node,
    npm,
    claude,
    auth,
    bypassDisclaimer,
    actionsTaken: [],
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
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
    invoke: null
  });
}

function spawnClaude(cwd, args, promptViaStdin = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveClaudeBin(), args, buildClaudeSpawnOptions(cwd));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ status: code ?? 1, signal, stdout, stderr, pid: child.pid ?? null }));
    child.stdin.on("error", () => {
      // Ignore EPIPE if Claude exits before consuming stdin.
    });
    child.stdin.end(promptViaStdin ?? undefined);
  });
}

async function executePrintRun({ cwd, prompt, write, review, model, effort, resumeSessionId, resumeLatest }) {
  ensureClaudeAvailable(cwd);
  const stdinPrompt = shouldPassPromptViaStdin(prompt) ? prompt : null;
  const args = buildRunArgs({
    invoke: "print",
    prompt,
    write,
    review,
    model,
    effort,
    resumeSessionId,
    resumeLatest,
    schemaPath: review ? REVIEW_SCHEMA : null
  });
  const command = await spawnClaude(cwd, args, stdinPrompt);
  const parsed = parsePrintResult(command.stdout);
  return { command, parsed };
}

async function launchBackground(job, { cwd, prompt, write, review, model, effort, resumeSessionId, resumeLatest }) {
  ensureClaudeAvailable(cwd);
  const args = buildRunArgs({
    invoke: "bg",
    name: job.id,
    prompt,
    promptFile: path.join(resolveJobsDir(job.workspaceRoot), `${job.id}.prompt.md`),
    write,
    review,
    model,
    effort,
    resumeSessionId,
    resumeLatest
  });
  const command = await spawnClaude(cwd, args);
  const combined = `${command.stdout}\n${command.stderr}`;
  if (/bypass disclaimer|dangerously-skip-permissions/i.test(combined) && command.status !== 0) {
    throw new Error(getBypassDisclaimerStatus().detail);
  }
  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || command.stdout.trim() || `claude --bg exited ${command.status}`);
  }
  const shortId = parseBgShortId(command.stdout);
  if (!shortId) throw new Error("Claude background launch did not return a session short id.");
  const record = {
    ...job,
    invoke: "bg",
    shortId,
    status: "running",
    phase: "running",
    pid: null,
    startedAt: nowIso(),
    worktree: null
  };
  persistJob(job.workspaceRoot, record);
  return record;
}

async function runPrintJob(job, request) {
  const running = {
    ...job,
    invoke: "print",
    status: "running",
    phase: "running",
    pid: process.pid,
    startedAt: nowIso(),
    worktree: request.cwd
  };
  persistJob(job.workspaceRoot, running);
  try {
    const { command, parsed } = await executePrintRun(request);
    const reviewMeta = { reviewLabel: request.reviewName, targetLabel: request.targetLabel };
    const rendered = request.review
      ? renderReviewResult(
          {
            parsed: parsed.structuredOutput,
            rawOutput: parsed.resultText,
            parseError: parsed.structuredOutput ? null : "Claude returned no structured output."
          },
          reviewMeta
        )
      : renderTaskResult({ rawOutput: parsed.resultText, failureMessage: command.stderr });
    const status = command.status === 0 ? "completed" : "failed";
    const completed = {
      ...running,
      status,
      phase: status === "completed" ? "done" : "failed",
      pid: null,
      completedAt: nowIso(),
      claudeSessionId: parsed.sessionId,
      summary: firstMeaningfulLine(parsed.resultText, `${job.title} finished.`),
      result: {
        rawOutput: parsed.resultText,
        structuredOutput: parsed.structuredOutput,
        claude: command
      },
      rendered,
      ...(command.status === 0 ? {} : { errorMessage: command.stderr.trim() || `Claude exited ${command.status}.` })
    };
    persistJob(job.workspaceRoot, completed);
    return { job: completed, rendered, exitStatus: command.status };
  } catch (error) {
    const failed = {
      ...running,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: nowIso(),
      errorMessage: error instanceof Error ? error.message : String(error)
    };
    persistJob(job.workspaceRoot, failed);
    throw error;
  }
}

async function handleReviewCommand(argv, { reviewName }) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const focusText = positionals.join(" ").trim();
  if (reviewName === "Review" && focusText) {
    throw new Error("`review` does not accept focus text. Use `adversarial-review`.");
  }
  const context = collectReviewContext(cwd, target);
  const prompt = buildReviewPrompt(context, focusText, reviewName);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const kind = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const job = createCompanionJob({
    prefix: "review",
    kind,
    title: `Claude ${reviewName}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${reviewName} ${target.label}`,
    write: false
  });
  const request = {
    cwd,
    prompt,
    write: false,
    review: true,
    model: options.model,
    effort: options.effort,
    reviewName,
    targetLabel: target.label
  };
  if (options.background) {
    const launched = await launchBackground(job, request);
    const payload = { jobId: launched.id, status: launched.status, shortId: launched.shortId };
    outputCommandResult(payload, `${job.title} started in the background as ${job.id}.\n`, options.json);
    return;
  }
  const execution = await runPrintJob(job, request);
  outputCommandResult({ job: execution.job }, execution.rendered, options.json);
  if (execution.exitStatus !== 0) process.exitCode = execution.exitStatus;
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const prompt = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ") || readStdinIfPiped();
  const resumeLatest = Boolean(options["resume-last"] || options.resume);
  if (resumeLatest && options.fresh) throw new Error("Choose either --resume/--resume-last or --fresh.");
  if (!prompt && !resumeLatest) throw new Error("Provide a prompt, prompt file, piped stdin, or use --resume-last.");
  const effectivePrompt = prompt || "Continue the previous task.";
  const title = resumeLatest ? "Claude Resume" : "Claude Task";
  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title,
    workspaceRoot,
    jobClass: "task",
    summary: shorten(effectivePrompt),
    write: Boolean(options.write)
  });
  const request = {
    cwd,
    prompt: effectivePrompt,
    write: Boolean(options.write),
    review: false,
    model: options.model,
    effort: options.effort,
    resumeLatest
  };
  if (options.background) {
    const launched = await launchBackground(job, request);
    const payload = { jobId: launched.id, status: launched.status, shortId: launched.shortId };
    outputCommandResult(payload, `${title} started in the background as ${job.id}.\n`, options.json);
    return;
  }
  const execution = await runPrintJob(job, request);
  outputCommandResult({ job: execution.job }, execution.rendered, options.json);
  if (execution.exitStatus !== 0) process.exitCode = execution.exitStatus;
}

function refreshBgJob(workspaceRoot, job) {
  if (job.invoke !== "bg" || !job.shortId) return job;
  const result = runCommand(
    resolveClaudeBin(),
    ["agents", "--json", "--cwd", workspaceRoot, "--all"],
    buildClaudeSpawnOptions(workspaceRoot)
  );
  if (result.error || result.status !== 0) {
    return { ...job, summary: result.stderr.trim() || result.error?.message || job.summary };
  }
  const refreshed = refreshJobFromAgentsJson(job, result.stdout);
  if (refreshed.status !== job.status && !isActive(refreshed)) {
    refreshed.completedAt = refreshed.completedAt ?? nowIso();
    refreshed.phase = refreshed.status === "completed" ? "done" : refreshed.status;
  }
  persistJob(workspaceRoot, refreshed);
  return refreshed;
}

function buildStatusSnapshot(cwd, all = false) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobs(listJobs(workspaceRoot)).map((job) => refreshBgJob(workspaceRoot, job));
  const running = jobs.filter(isActive);
  const finished = jobs.filter((job) => !isActive(job));
  return {
    workspaceRoot,
    running,
    latestFinished: finished[0] ?? null,
    recent: (all ? finished : finished.slice(0, 8)).slice(1)
  };
}

async function waitForJob(cwd, reference, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  let selected;
  do {
    selected = findJob(cwd, reference);
    if (!selected.job) throw new Error(`No job found for "${reference}".`);
    selected.job = refreshBgJob(selected.workspaceRoot, selected.job);
    if (!isActive(selected.job) || selected.job.status === "blocked") return selected;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return selected;
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const selected = options.wait
      ? await waitForJob(
          cwd,
          reference,
          Math.max(0, Number(options["timeout-ms"]) || DEFAULT_STATUS_WAIT_TIMEOUT_MS),
          Math.max(100, Number(options["poll-interval-ms"]) || DEFAULT_STATUS_POLL_INTERVAL_MS)
        )
      : findJob(cwd, reference);
    if (!selected.job) throw new Error(`No job found for "${reference}".`);
    const job = options.wait ? selected.job : refreshBgJob(selected.workspaceRoot, selected.job);
    outputCommandResult({ workspaceRoot: selected.workspaceRoot, job }, renderJobStatusReport(job), options.json);
    return;
  }
  if (options.wait) throw new Error("`status --wait` requires a job id.");
  const report = buildStatusSnapshot(cwd, options.all);
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const selected = findJob(cwd, positionals[0] ?? "");
  if (!selected.job) throw new Error("No Claude job found for this repository.");
  const job = refreshBgJob(selected.workspaceRoot, selected.job);
  const storedJob = readStoredJob(selected.workspaceRoot, job.id);
  if (job.invoke === "bg") {
    const result = runCommand(resolveClaudeBin(), ["logs", job.shortId], { cwd: selected.workspaceRoot });
    if (result.error || result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || "Unable to read Claude logs.");
    const prefix =
      job.status === "blocked"
        ? `Waiting for: ${job.waitingFor ?? "interactive input"}\nAttach: claude attach ${job.shortId}\n\n`
        : "";
    const rendered = `${prefix}${result.stdout}`;
    outputCommandResult({ job, result: result.stdout }, rendered.endsWith("\n") ? rendered : `${rendered}\n`, options.json);
    return;
  }
  if (isActive(job)) throw new Error(`Job ${job.id} is still ${job.status}.`);
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const selected = findJob(cwd, positionals[0] ?? "", isActive);
  if (!selected.job) throw new Error("No active Claude job found.");
  const existing = readStoredJob(selected.workspaceRoot, selected.job.id) ?? selected.job;
  if (selected.job.invoke === "bg") {
    const result = runCommand(resolveClaudeBin(), ["stop", selected.job.shortId], { cwd: selected.workspaceRoot });
    if (result.error || result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || "Unable to stop Claude session.");
  } else {
    terminateProcessTree(selected.job.pid ?? Number.NaN, { cwd: selected.workspaceRoot });
  }
  const completedAt = nowIso();
  const cancelled = {
    ...existing,
    ...selected.job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    cancelledAt: completedAt,
    errorMessage: "Cancelled by user."
  };
  persistJob(selected.workspaceRoot, cancelled);
  outputCommandResult({ jobId: cancelled.id, status: "cancelled" }, renderCancelReport(cancelled), options.json);
}

function renderTransferResult(payload) {
  return [
    "Transferred the host transcript into a Claude session via prompt handoff.",
    `Source (${payload.host}): ${payload.sourcePath}`,
    `Claude session ID: ${payload.sessionId}`,
    `Resume in Claude: ${payload.resumeCommand}`,
    ""
  ].join("\n");
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source", "model", "effort"],
    booleanOptions: ["json", "write", "background", "wait"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const resolved = resolveTransferSource(cwd, { source: options.source });
  const messages = capTranscriptMessages(parseTranscriptJsonl(resolved.path));
  const prompt = buildHandoffPrompt(packTranscript(messages));
  const job = createCompanionJob({
    prefix: "transfer",
    kind: "transfer",
    title: "Claude Transfer",
    workspaceRoot,
    jobClass: "task",
    summary: `Transfer from ${resolved.host}`,
    write: Boolean(options.write)
  });
  const request = {
    cwd,
    prompt,
    write: Boolean(options.write),
    review: false,
    model: options.model,
    effort: options.effort,
    resumeLatest: false
  };

  let completedJob;
  let sessionId;
  let resumeCommand;
  if (options.wait) {
    const execution = await runPrintJob(job, request);
    if (execution.exitStatus !== 0) {
      process.exitCode = execution.exitStatus;
      outputCommandResult({ job: execution.job }, execution.rendered, options.json);
      return;
    }
    completedJob = execution.job;
    sessionId = completedJob.claudeSessionId;
    if (!sessionId) throw new Error("Transfer handoff completed without a Claude session id.");
    resumeCommand = `claude -r ${sessionId}`;
  } else {
    completedJob = await launchBackground(job, request);
    sessionId = completedJob.shortId;
    resumeCommand = `claude attach ${sessionId}`;
  }

  const payload = {
    host: resolved.host,
    sourcePath: resolved.path,
    jobId: completedJob.id,
    sessionId,
    resumeCommand
  };
  outputCommandResult(payload, renderTransferResult(payload), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const candidate =
    sortJobs(listJobs(resolveWorkspaceRoot(cwd))).find(
      (job) => job.jobClass === "task" && !isActive(job) && (job.claudeSessionId || job.shortId)
    ) ?? null;
  const payload = {
    available: Boolean(candidate),
    candidate: candidate
      ? {
          id: candidate.id,
          status: candidate.status,
          title: candidate.title ?? null,
          summary: candidate.summary ?? null,
          claudeSessionId: candidate.claudeSessionId ?? null,
          shortId: candidate.shortId ?? null
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
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReviewCommand(argv, { reviewName: "Review" });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      await handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
