// Shared helpers for the antigravity tests: a git sandbox, the stand-in ACP server, and its log.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const COMPANION = path.join(root, "plugins/antigravity/scripts/antigravity-companion.mjs");
export const POSIX_ONLY = process.platform === "win32" ? "the stand-in agy needs a POSIX shebang" : false;
const FAKE_SOURCE = path.join(root, "tests/fixtures/fake-agy-acp.cjs");

export function makeSandbox(t, { changedFiles = 1, fakeName = "fake-agy", git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const fake = path.join(bin, fakeName);
  fs.copyFileSync(FAKE_SOURCE, fake);
  fs.chmodSync(fake, 0o755);
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  if (git) {
    spawnSync("git", ["init", "-q"], { cwd: repo });
    for (let i = 0; i < changedFiles; i += 1) fs.writeFileSync(path.join(repo, `f${i}.txt`), "a\n");
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
    for (let i = 0; i < changedFiles; i += 1) fs.writeFileSync(path.join(repo, `f${i}.txt`), "b\n");
  }
  return { dir, bin, fake, repo, data: path.join(dir, "data"), log: path.join(dir, "agy.log"), pidfile: path.join(dir, "pids.json") };
}

export function companionEnv(sandbox, extraEnv = {}) {
  // A short settle time, so a task does not wait 20 s for its session to go quiet; and never the real ~/.gemini.
  const env = { ...process.env, PLUGIN_DATA: sandbox.data, ANTIGRAVITY_BIN: sandbox.fake, FAKE_AGY_LOG: sandbox.log, FAKE_AGY_PIDFILE: sandbox.pidfile, AGENT_BRIDGES_ACP_SETTLE_MS: "100", HOME: sandbox.dir };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.FAKE_ACP;
  Object.assign(env, extraEnv);
  for (const [key, value] of Object.entries(extraEnv)) if (value === undefined) delete env[key];
  return env;
}

export function run(sandbox, args, extraEnv = {}, options = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], { cwd: sandbox.repo, env: companionEnv(sandbox, extraEnv), encoding: "utf8", ...options });
}

export function startCompanion(sandbox, args, extraEnv = {}) {
  return spawn(process.execPath, [COMPANION, ...args], { cwd: sandbox.repo, env: companionEnv(sandbox, extraEnv), stdio: "ignore" });
}

export function scenario(value) {
  return { FAKE_ACP: JSON.stringify(value) };
}

export function logEntries(sandbox) {
  if (!fs.existsSync(sandbox.log)) return [];
  return fs.readFileSync(sandbox.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** One entry per `agy acp` start, with the messages that process received. */
export function sessions(sandbox) {
  const byPid = new Map();
  for (const entry of logEntries(sandbox)) {
    if (entry.argv && !entry.argv.includes("--version")) byPid.set(entry.pid, { argv: entry.argv, pid: entry.pid, readerFiles: entry.readerFiles, received: [] });
    else if (entry.received) byPid.get(entry.pid)?.received.push(entry.received);
  }
  return [...byPid.values()];
}

export function requests(session, method) {
  return session.received.filter((message) => message.method === method);
}

export function promptTexts(session) {
  return requests(session, "session/prompt").map((message) => message.params.prompt[0].text);
}

export function jobFiles(sandbox) {
  const stateRoot = path.join(sandbox.data, "state");
  if (!fs.existsSync(stateRoot)) return [];
  return fs.readdirSync(stateRoot).flatMap((workspace) => {
    const jobs = path.join(stateRoot, workspace, "jobs");
    return fs.existsSync(jobs) ? fs.readdirSync(jobs) : [];
  });
}

export function lastJob(sandbox) {
  const status = JSON.parse(run(sandbox, ["status", "--all", "--json"]).stdout);
  return status.running[0] ?? status.latestFinished;
}

export function jobStatus(sandbox, id) {
  return JSON.parse(run(sandbox, ["status", id, "--json"]).stdout).job;
}
