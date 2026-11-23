#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  READER_MARKER,
  READ_ONLY_RESUME_WARNING,
  buildAcpArgs,
  canonicalPath,
  createLineReader,
  isInside,
  finishAgyRun,
  startAcpRun,
  writeReaderAgent
} from "./lib/acp.mjs";
import {
  formatDeniedActions,
  getAgyAvailability,
  getAgySetupFacts,
  resolveAgySpawnCommand,
  validateEffort
} from "./lib/agy.mjs";
import { buildDetachedWorkerOptions, mergeSpawnedPid } from "./lib/detach.mjs";
import { isWithin, readStdinIfPiped } from "./lib/fs.mjs";
import { collectIncludedFiles, collectReviewContext, ensureGitRepository, formatIncomplete, resolveReviewTarget } from "./lib/git.mjs";
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
      "  node scripts/antigravity-companion.mjs task [--wait|--background] [--write] [--resume-last|--resume|--resume-job <job-id>|--fresh] [--model <id>] [--include <path>]... [prompt]",
      "  node scripts/antigravity-companion.mjs status [job-id] [--wait] [--all] [--json]",
      "  node scripts/antigravity-companion.mjs result [job-id] [--json]",
      "  node scripts/antigravity-companion.mjs cancel [job-id] [--json]",
      "  node scripts/antigravity-companion.mjs transfer [--source <path>] [--wait|--background] [--write] [--json]",
      "  node scripts/antigravity-companion.mjs task-resume-candidate [--for-write] [--json]"
    ].join("\n")
  );
}

function normalizeArgv(argv) {
  // A lone `--include=value` is one option whose path may hold spaces (`--include=docs/task plan.txt`). Any other
  // lone argument is a raw string (`/antigravity:review --base=main --background`) and is split.
  if (argv.length === 1 && argv[0].startsWith("--include=")) return argv;
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

/** cancelling: a cancel whose teardown has not finished yet; a second cancel retries it. */
function isActive(job) {
  return job.status === "queued" || job.status === "running" || job.status === "cancelling";
}

/** Created by cancel before it reads or signals anything; no job update can overwrite a file. */
function cancelMarkerFile(workspaceRoot, jobId) {
  return resolveJobFile(workspaceRoot, jobId).replace(/\.json$/, ".cancelled");
}

function isCancelMarked(workspaceRoot, jobId) {
  return fs.existsSync(cancelMarkerFile(workspaceRoot, jobId));
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
    invoke: "acp"
  });
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Absolute: agy runs in the workspace, so a relative PLUGIN_DATA must not be resolved there. */
function readerRoot(cwd) {
  return path.resolve(resolveStateDir(resolveWorkspaceRoot(cwd)), "readers");
}

/** The reader agent lives in the bridge's state, never in the workspace it reads; there is no fallback location. */
function readerBaseDir(cwd) {
  const base = readerRoot(cwd);
  if (isInside(canonicalPath(base), canonicalPath(resolveWorkspaceRoot(cwd)))) {
    throw new Error(
      `The companion's state folder (${base}) is inside the workspace, so the restricted reader cannot be written safely and nothing was run. Point PLUGIN_DATA at a folder outside the workspace.`
    );
  }
  return base;
}

/** Remove a reader folder only when it sits directly in this workspace's reader root and carries the bridge's marker. */
function removeReaderDir(dir, cwd) {
  if (typeof dir !== "string" || !dir) return;
  try {
    const canonical = fs.realpathSync.native(dir);
    if (path.dirname(canonical) !== canonicalPath(readerRoot(cwd))) return;
    if (!fs.lstatSync(path.join(canonical, READER_MARKER)).isFile()) return;
    fs.rmSync(canonical, { recursive: true, force: true });
  } catch {
    // missing folder or marker: leave it alone
  }
}

/** A wait that never keeps the process alive on its own. */
function unrefSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function stderrTail(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed ? `: ${trimmed.slice(-500)}` : "";
}

/** Start `agy acp`, run one session over its stdio, and end it (spec: ACP transport). */
async function executeAcpRun(request, hooks = {}) {
  const { cwd } = request;
  ensureAgyAvailable(cwd);
  const readOnly = request.review === true || request.write !== true;
  let reader = null;
  let child = null;
  let run = null;
  let stopping = false;
  // Registered before anything is written, on every platform: the reader is removed and the process exits
  // whenever a signal arrives, even when ending the tree throws.
  const forward = async (signal) => {
    if (stopping) return;
    stopping = true;
    try {
      // Best effort: let the server stop the turn, then fail the run at once, so a turn that still
      // finishes during the teardown is never stored or printed as a success.
      const reachable = run?.abort(new Error(`Interrupted by ${signal}.`));
      if (reachable) await sleep(250);
      // Same as cancel: a write run must not leave a SIGTERM-resistant command editing files after we exit.
      if (child?.pid) await endAgyTree(child.pid, cwd);
    } catch {
      // still clean up and exit below
    } finally {
      try {
        if (reader) removeReaderDir(reader.dir, cwd);
        if (hooks.onSignal) hooks.onSignal(signal);
      } finally {
        process.exit(signal === "SIGINT" ? 130 : 143);
      }
    }
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  try {
    if (readOnly) {
      reader = writeReaderAgent(readerBaseDir(cwd));
      if (hooks.onReader) hooks.onReader(reader.dir);
    }
    const command = resolveAgySpawnCommand();
    const args = buildAcpArgs({ agentDir: reader?.dir, agentName: reader?.name });
    // POSIX: agy leads its own process group so cancel can end its whole tree (plan P13).
    const detached = process.platform !== "win32";
    child = spawn(command.file, [...command.args, ...args], { cwd, windowsHide: true, detached, stdio: ["pipe", "pipe", "pipe"] });
    run = startAcpRun({
      write: (line) => {
        if (!child.stdin.writable) throw new Error("could not write to agy: its input is closed");
        child.stdin.write(line);
      },
      cwd,
      prompt: request.prompt,
      readOnly,
      token: reader?.token,
      model: request.model,
      effort: request.effort,
      resumeSessionId: request.resumeSessionId,
      warning: request.resumeWarning ?? null,
      review: request.review === true,
      // Test hook: the tests shorten the 60 s setup timeout.
      setupTimeoutMs: Number(process.env.AGENT_BRIDGES_ACP_SETUP_TIMEOUT_MS) || undefined,
      // Test hooks: the tests shorten the 30 s settle time and the 30 min bound of the wait after a task's turn.
      quietSettleMs: Number(process.env.AGENT_BRIDGES_ACP_SETTLE_MS) || undefined,
      quietTimeoutMs: Number(process.env.AGENT_BRIDGES_ACP_QUIET_TIMEOUT_MS) || undefined
    });
    let stderr = "";
    const keep = (text) => {
      stderr = (stderr + text).slice(-64 * 1024);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Lines that are not protocol messages (a server log) are skipped but shown with a failure.
    child.stdout.on("data", createLineReader((message) => run.handle(message), (line) => keep(`[stdout] ${line}\n`)));
    child.stderr.on("data", keep);
    child.stdin.on("error", (error) => run.fail(new Error(`could not write to agy: ${error.message}`)));
    // Output can end while the process lives on; give a real exit a moment to report itself first.
    const stdoutDone = new Promise((resolve) => {
      child.stdout.once("end", resolve);
      child.stdout.once("close", resolve);
    });
    child.stdout.once("end", () => {
      unrefSleep(200).then(() => run.fail(new Error("agy closed its output before it answered")));
    });
    const closed = new Promise((resolve) => {
      child.once("error", (error) => {
        run.fail(error);
        resolve({ status: 1, signal: null });
      });
      child.once("close", (code, signal) => {
        run.fail(new Error(`agy exited (${signal ?? `code ${code}`}) before it answered${stderrTail(stderr)}`));
        resolve({ status: code ?? 1, signal });
      });
    });
    if (child.pid && hooks.onSpawn) hooks.onSpawn(child.pid);
    // cancel may have marked the job between the worker's check and this spawn.
    if (hooks.isCancelled?.()) run.abort(new Error("Cancelled by user."));
    let parsed = await run.result;
    // A forwarded signal owns the rest: it ends the tree and exits; nothing is stored or printed here.
    if (stopping) await new Promise(() => {});
    // Every end that is not a clean completion ends the whole tree, by one path (and only once).
    let ended = null;
    const endTree = () => (ended ??= child.pid ? endAgyTree(child.pid, cwd) : Promise.resolve());
    await finishAgyRun({
      clean: parsed.ok && !run.securityStopped(),
      endTree,
      closeInput: () => child.stdin.end(),
      // agy acp may not exit at the end of its input.
      waitExit: (ms) => Promise.race([closed.then(() => true), unrefSleep(ms).then(() => false)])
    });
    // Keep reading until the output closes, so a forbidden tool call after the final answer still fails the run.
    await Promise.race([stdoutDone, unrefSleep(1000)]);
    const status = await Promise.race([closed, unrefSleep(1000).then(() => ({ status: null, signal: null }))]);
    parsed = run.settle(parsed);
    // A violation after the final answer fails the run too: end whatever agy left (a no-op when already ended).
    if (!parsed.ok) await endTree();
    if (stopping) await new Promise(() => {});
    return { command: { ...status, stderr, pid: child.pid ?? null }, parsed };
  } catch (error) {
    // Any failure after spawn (bookkeeping included) stops the protocol run and ends the tree.
    run?.abort(error);
    if (child?.pid) await endAgyTree(child.pid, cwd).catch(() => {});
    throw error;
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
    // A descendant that kept a pipe open must not keep the companion alive.
    if (child) {
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      child.unref();
    }
    if (reader) removeReaderDir(reader.dir, cwd);
  }
}

const INCLUDE_NOTICE = { cutLabel: "the included files were cut", rest: "the rest of them was not shown to Antigravity" };

function renderExecution(request, command, parsed, evidence) {
  const lines = [];
  if (parsed.warning) lines.push(`Warning: ${parsed.warning}`, "");
  // A task's included files that were not shown in full; a partial answer of a failed run needs it too.
  const taskNotice = !request.review && evidence?.incomplete ? `Incomplete task: ${formatIncomplete(evidence, INCLUDE_NOTICE)}` : null;
  if (!parsed.ok) {
    lines.push(`Antigravity run failed: ${parsed.error}`);
    if (parsed.resultText) lines.push("", ...(taskNotice ? [taskNotice, ""] : []), parsed.resultText);
    return `${lines.join("\n")}\n`;
  }
  if (!request.review) {
    if (taskNotice) lines.push(taskNotice, "");
    lines.push(parsed.resultText || command.stderr.trim() || "Antigravity did not return a final message.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`# Antigravity ${request.reviewName}`, "");
  // The model is told inside its prompt; this line tells the caller.
  if (evidence?.incomplete) lines.push(`Incomplete review: ${formatIncomplete(evidence)}`, "");
  if (parsed.structured) {
    lines.push(JSON.stringify(parsed.structured, null, 2));
    if (parsed.deniedActions.length) lines.push("", `Denied: ${formatDeniedActions(parsed.deniedActions)}`);
  } else {
    lines.push(parsed.resultText || "Antigravity returned no review output.", "", "No structured result came back from Antigravity.");
  }
  return `${lines.join("\n")}\n`;
}

async function runAcpJob(job, request) {
  const { workspaceRoot } = job;
  const isCancelled = () => isCancelMarked(workspaceRoot, job.id);
  const cancelledResult = () => ({ job: readStoredJob(workspaceRoot, job.id) ?? job, rendered: "Cancelled by user.\n", exitStatus: 1 });
  // Every write merges onto the stored record. Once cancel has left its marker, the run only adds the handles
  // cancel needs (agy's pid, the reader folder) and never touches the status cancel wrote.
  const save = (patch) => {
    const stored = readStoredJob(workspaceRoot, job.id) ?? job;
    if (!isCancelled()) return persistJob(workspaceRoot, { ...stored, ...patch });
    const handles = Object.fromEntries(Object.entries(patch).filter(([key]) => key === "agyPid" || key === "readerDir"));
    return Object.keys(handles).length ? persistJob(workspaceRoot, { ...stored, ...handles }) : stored;
  };
  // A job cancelled before it started never starts agy.
  if (isCancelled()) return cancelledResult();
  const running = save({
    ...job,
    status: "running",
    phase: "running",
    pid: process.pid,
    startedAt: nowIso(),
    worktree: request.cwd,
    // A session keeps its agent: a write resume must never pick a read-only (reader) session.
    agyReadOnly: request.review === true || request.write !== true
  });
  try {
    const { command, parsed } = await executeAcpRun(request, {
      onReader: (readerDir) => save({ readerDir }),
      onSpawn: (agyPid) => {
        save({ agyPid });
        // Test hook: simulates a failed bookkeeping write after spawn.
        if (process.env.AGENT_BRIDGES_TEST_THROW_ON_SPAWN) throw new Error(`test hook: recording the agy pid ${agyPid} failed`);
      },
      isCancelled,
      onSignal: (signal) => {
        if (!isCancelled()) save({ status: "failed", phase: "failed", pid: null, agyPid: null, readerDir: null, completedAt: nowIso(), errorMessage: `Interrupted by ${signal}.` });
      }
    });
    // cancel may have run while agy was stopping; never overwrite it.
    if (isCancelled()) return cancelledResult();
    const status = parsed.ok ? "completed" : "failed";
    const rendered = renderExecution(request, command, parsed, job.evidence);
    const completed = save({
      ...running,
      status,
      phase: status === "completed" ? "done" : "failed",
      pid: null,
      agyPid: null,
      readerDir: null,
      completedAt: nowIso(),
      agySessionId: parsed.sessionId,
      // Only a session that received the task prompt can be continued by a write run.
      agyPromptSent: parsed.promptSent === true,
      summary: firstMeaningfulLine(parsed.resultText, `${job.title} finished.`),
      result: {
        rawOutput: parsed.resultText,
        structuredOutput: request.review ? parsed.structured : null,
        agy: command
      },
      rendered,
      warning: parsed.warning,
      ...(parsed.unfinishedSubagents?.length ? { unfinishedSubagents: parsed.unfinishedSubagents } : {}),
      ...(parsed.ok ? {} : { errorMessage: parsed.error })
    });
    return { job: completed, rendered, exitStatus: parsed.ok ? 0 : 1 };
  } catch (error) {
    if (!isCancelled()) {
      save({
        ...running,
        status: "failed",
        phase: "failed",
        pid: null,
        agyPid: null,
        readerDir: null,
        agyPromptSent: false,
        completedAt: nowIso(),
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
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
  if (job.status !== "queued" || isCancelMarked(workspaceRoot, job.id)) return;
  // The job record, not the nested request, decides write permission: a review or read-only job never writes.
  const write = job.write === true && job.request.review !== true && job.request.write === true;
  await runAcpJob({ ...job, workspaceRoot }, { ...job.request, write });
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
  // Before the evidence is collected or a job is written: a state folder inside the workspace would hold copies of it.
  readerBaseDir(cwd);
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
  // Kept on the job record, so `--json`, `status` and `result` show that only part of the change was reviewed.
  // `incomplete` is what a caller reads; `truncated` is the budget cut only.
  if (context.truncated || context.skipped.length) {
    job.evidence = {
      incomplete: true,
      truncated: context.truncated,
      maxBytes: context.maxBytes,
      filesNotShown: context.notShown,
      filesPartlyShown: context.partlyShown,
      filesSkipped: context.skipped
    };
  }
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
  const execution = await runAcpJob(job, request);
  outputCommandResult({ job: execution.job }, execution.rendered, options.json);
  if (execution.exitStatus !== 0) process.exitCode = execution.exitStatus;
}

const WRITE_AFTER_READ_ONLY_WARNING =
  "The earlier Antigravity session was read-only and cannot be continued with write access; this started a new session.";

const PRE_PROMPT_WARNING =
  "The most recent Antigravity task failed before its prompt reached the session, so there is nothing to continue; this started a new session.";

/**
 * Why a write run cannot continue this task job, or null when it can. A record without the fields comes
 * from 0.1.x, whose print-mode sessions had the full agent and always received their prompt.
 */
function whyNotContinuable(job) {
  if (job.agyReadOnly === true) return WRITE_AFTER_READ_ONLY_WARNING;
  if (job.agyPromptSent === false || !job.agySessionId) return PRE_PROMPT_WARNING;
  return null;
}

/** The most recent finished task job: a write resume continues it or nothing, never an older one. */
function findLatestTaskJob(workspaceRoot) {
  return sortJobs(listJobs(workspaceRoot)).find((job) => job.jobClass === "task" && !isActive(job)) ?? null;
}

/** --resume-job: exactly the job the user confirmed, still continuable, or nothing runs. */
function resolveResumeJob(cwd, reference) {
  const { job } = findJob(cwd, reference, (entry) => entry.jobClass === "task");
  if (!job) throw new Error(`No job found for "${reference}".`);
  if (isActive(job)) throw new Error(`Job ${job.id} cannot be continued yet: it is still ${job.status}.`);
  if (job.agyReadOnly === true) throw new Error(`Job ${job.id} cannot be continued: it was a read-only task, and a read-only session cannot be continued with write access.`);
  if (whyNotContinuable(job)) throw new Error(`Job ${job.id} cannot be continued: it failed before its prompt reached an Antigravity session.`);
  return job.agySessionId;
}

/**
 * The files a read-only task names with --include, each checked before any session starts: its real path (links
 * resolved) must be a regular file inside the workspace's real path, by whole path components.
 */
function resolveIncludes(cwd, workspaceRoot, includes) {
  const root = fs.realpathSync.native(workspaceRoot);
  const seen = new Set();
  const files = includes.flatMap((include) => {
    let real;
    try {
      // Not path.resolve: it would collapse "link/.." before the OS follows the link.
      real = fs.realpathSync.native(path.isAbsolute(include) ? include : `${cwd}${path.sep}${include}`);
    } catch (error) {
      throw new Error(`--include ${include} cannot be read (${error.code ?? error.message}), so nothing was run.`);
    }
    if (!isWithin(real, root)) {
      throw new Error(`--include ${include} is outside the workspace (${workspaceRoot}): a read-only task sees only files inside it, so nothing was run.`);
    }
    if (!fs.statSync(real).isFile()) throw new Error(`--include ${include} is not a regular file, so nothing was run.`);
    if (seen.has(real)) return [];
    seen.add(real);
    return [{ name: path.relative(root, real).split(path.sep).join("/"), real }];
  });
  return { root, files };
}

/** The task prompt with the included files after it, and the evidence record when some were not shown in full. */
function buildIncludedPrompt(prompt, { root, files }) {
  const included = collectIncludedFiles(files, { root });
  const cut = included.truncated ? ` The files are larger than ${included.maxBytes} bytes, so they were cut; say in your answer that the rest was not shown.` : "";
  const text = [
    prompt,
    `You have no tools in this task: you cannot read files, list folders, search or run commands. Answer only from this prompt and the files below.${cut}`,
    included.content
  ].join("\n\n");
  const evidence = included.truncated || included.skipped.length
    ? { incomplete: true, truncated: included.truncated, maxBytes: included.maxBytes, filesNotShown: included.notShown, filesPartlyShown: included.partlyShown, filesSkipped: included.skipped }
    : null;
  return { text, evidence };
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "resume-job"],
    arrayOptions: ["include"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: { m: "model" }
  });
  validateEffort(options.effort);
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const resumeLatest = Boolean(options["resume-last"] || options.resume);
  const resumeJob = options["resume-job"];
  if ([resumeLatest, Boolean(resumeJob), Boolean(options.fresh)].filter(Boolean).length > 1) {
    throw new Error("Choose one of --resume-job, --resume/--resume-last or --fresh.");
  }
  const includes = options.include ?? [];
  if (includes.length && options.write) {
    throw new Error("--include is for a read-only task, which cannot open files itself. A task with --write reads files on its own: name them in the prompt.");
  }
  if (resumeJob && !options.write) {
    throw new Error("--resume-job continues a write session: add --write --bypass-permissions, or start a new read-only task without it.");
  }
  const prompt = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ") || readStdinIfPiped();
  let resumeSessionId = resumeJob ? resolveResumeJob(cwd, resumeJob) : null;
  let resumeWarning = null;
  if (resumeLatest) {
    const latest = findLatestTaskJob(workspaceRoot);
    if (!latest) throw new Error("No previous Antigravity task was found for this repository.");
    // A read-only run never continues a session (acp.mjs refuses it too); a write run continues only the latest job.
    if (!options.write) resumeWarning = READ_ONLY_RESUME_WARNING;
    else resumeWarning = whyNotContinuable(latest);
    if (options.write && !resumeWarning) resumeSessionId = latest.agySessionId;
  }
  if (!prompt && !resumeLatest && !resumeJob) throw new Error("Provide a prompt, prompt file, piped stdin, or use --resume-last or --resume-job.");
  const effectivePrompt = prompt || "Continue the previous task.";
  // A read-only run's state folder must be outside the workspace; checked before anything is read or written, so a
  // job file with the prompt (and copies of the included files) never lands in the worktree.
  if (!options.write) readerBaseDir(cwd);
  // Checked and read before agy is looked for and before any job exists: a refused file starts nothing.
  const included = includes.length ? buildIncludedPrompt(effectivePrompt, resolveIncludes(cwd, workspaceRoot, includes)) : null;
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
  // Kept on the job record, like a review's, so `--json`, `status` and `result` show what was not shown.
  if (included?.evidence) job.evidence = included.evidence;
  const request = buildRequest(cwd, options, included?.text ?? effectivePrompt, { resumeSessionId, resumeWarning });
  if (options.background) {
    const queued = enqueueBackground(job, request);
    outputCommandResult({ jobId: queued.id, status: queued.status }, `${job.title} started in the background as ${job.id}.\n`, options.json);
    return;
  }
  const execution = await runAcpJob(job, request);
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
  const { workspaceRoot } = selected;
  const id = selected.job.id;
  // The marker comes first: from here on no worker, finishing run or signal handler can undo the cancellation.
  fs.writeFileSync(cancelMarkerFile(workspaceRoot, id), `${nowIso()}\n`, { mode: 0o600 });
  const stored = { ...selected.job, ...(readStoredJob(workspaceRoot, id) ?? {}) };
  // cancelling keeps the handles, so an interrupted teardown can be retried by another cancel.
  persistJob(workspaceRoot, { ...stored, status: "cancelling", phase: "cancelling", errorMessage: "Cancelled by user." });
  // End the agy tree first: it no longer shares the companion's process group.
  await endAgyTree(stored.agyPid ?? Number.NaN, workspaceRoot);
  terminateProcessTree(stored.pid ?? Number.NaN, { cwd: workspaceRoot });
  // The session ran in another process, so it cannot get a session/cancel from here; remove its reader.
  removeReaderDir(stored.readerDir, workspaceRoot);
  // A worker may have recorded agy, its own pid or its reader after the first read.
  const late = readStoredJob(workspaceRoot, id) ?? stored;
  if (late.agyPid && late.agyPid !== stored.agyPid) await endAgyTree(late.agyPid, workspaceRoot);
  if (late.pid && late.pid !== stored.pid) terminateProcessTree(late.pid, { cwd: workspaceRoot });
  if (late.readerDir && late.readerDir !== stored.readerDir) removeReaderDir(late.readerDir, workspaceRoot);
  const cancelled = persistJob(workspaceRoot, {
    ...late,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    agyPid: null,
    readerDir: null,
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
  // As for a task: a read-only run's job (with the transcript in its prompt) is never written inside the workspace.
  if (!options.write) readerBaseDir(cwd);
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
  const execution = await runAcpJob(job, request);
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
    booleanOptions: ["json", "for-write"]
  });
  // Same rule as execution: only a write run continues a session, and only the most recent task, when it can.
  const latest = options["for-write"] ? findLatestTaskJob(resolveWorkspaceRoot(resolveCommandCwd(options))) : null;
  const candidate = latest && !whyNotContinuable(latest) ? latest : null;
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
    candidate
      ? `Resumable write task found: ${candidate.id} (${candidate.status}), Antigravity session ${candidate.agySessionId}: ${candidate.summary ?? candidate.title ?? ""}\n`
      : options["for-write"]
        ? "No resumable write task found.\n"
        : "No resumable task: a read-only run never continues an Antigravity session.\n",
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
