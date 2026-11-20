import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PLUGINS = ["opencode", "gemini", "claude", "cursor", "antigravity"];

for (const plugin of PLUGINS) {
  test(`${plugin}: a command path with spaces survives a shell`, async (t) => {
    const { runCommand, quoteForShell } = await import(`../plugins/${plugin}/scripts/lib/process.mjs`);
    assert.equal(quoteForShell("C:\\Program Files\\tool\\agent.cmd"), '"C:\\Program Files\\tool\\agent.cmd"');
    assert.equal(quoteForShell("agent"), "agent");
    assert.equal(quoteForShell('"C:\\a b\\x.cmd"'), '"C:\\a b\\x.cmd"');
    if (process.platform === "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dir with space-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const tool = path.join(dir, "tool");
    fs.writeFileSync(tool, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    const result = runCommand(tool, [], { shell: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "ok");
  });

  test(`${plugin}: runCommand honours shell: false`, async () => {
    const { runCommand } = await import(`../plugins/${plugin}/scripts/lib/process.mjs`);
    // With a shell, `&&` would run the second command; without one it is a literal argument.
    const result = runCommand(process.execPath, ["-e", "console.log(process.argv.slice(1).join('|'))", "a&&b"], { shell: false });
    assert.equal(result.stdout.trim(), "a&&b");
    const source = fs.readFileSync(new URL(`../plugins/${plugin}/scripts/lib/process.mjs`, import.meta.url), "utf8");
    assert.match(source, /options\.shell \?\?/);
  });
}

for (const [plugin, lib, envName] of [["antigravity", "agy", "ANTIGRAVITY_BIN"], ["cursor", "cursor", "CURSOR_BIN"]]) {
  test(`${plugin}: a .cmd launcher with no .ps1 is reported as unusable on Windows`, async (t) => {
    const { unsupportedLauncher } = await import(`../plugins/${plugin}/scripts/lib/${lib}.mjs`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cmd = path.join(dir, "tool.cmd");
    fs.writeFileSync(cmd, "@echo off\n");
    assert.match(unsupportedLauncher({ [envName]: cmd }, "win32"), /\.cmd/);
    assert.match(unsupportedLauncher({ [envName]: cmd }, "win32"), new RegExp(envName));
    fs.writeFileSync(path.join(dir, "tool.ps1"), "");
    assert.equal(unsupportedLauncher({ [envName]: cmd }, "win32"), null);
    assert.equal(unsupportedLauncher({ [envName]: path.join(dir, "tool.exe") }, "win32"), null);
    assert.equal(unsupportedLauncher({ [envName]: cmd }, "linux"), null);
  });
}

for (const plugin of ["opencode", "gemini", "claude", "cursor", "antigravity"]) {
  test(`${plugin}: transfer never falls back to another workspace's Codex session`, async (t) => {
    const { resolveTransferSource } = await import(`../plugins/${plugin}/scripts/lib/host-session.mjs`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fallback-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const rollout = path.join(home, ".codex", "sessions", "2026", "11", "20", "rollout-x.jsonl");
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { cwd: path.join(dir, "elsewhere") } })}\n`);
    assert.throws(() => resolveTransferSource(repo, { home, env: {} }));
  });
}

for (const [plugin, bin, lib, spawnFn] of [["opencode", "opencode", "opencode", "spawnOpencodeRun"], ["gemini", "gemini", "gemini", "spawnGeminiRun"]]) {
  test(`${plugin}: an npm .cmd shim runs through its .ps1 on Windows`, async (t) => {
    const { resolveSpawnCommand, unsupportedLauncher } = await import(`../plugins/${plugin}/scripts/lib/process.mjs`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" };
    fs.writeFileSync(path.join(dir, `${bin}.cmd`), "@echo off\n");
    // A .cmd with no .ps1 cannot be started without a shell: refuse it clearly.
    assert.match(unsupportedLauncher(bin, env, "win32"), /\.cmd launcher with no \.ps1/);
    assert.throws(() => resolveSpawnCommand(bin, env, "win32"), /\.cmd launcher with no \.ps1/);
    fs.writeFileSync(path.join(dir, `${bin}.ps1`), "");
    assert.equal(unsupportedLauncher(bin, env, "win32"), null);
    const command = resolveSpawnCommand(bin, env, "win32");
    assert.match(command.file, /powershell\.exe$/i);
    assert.deepEqual(command.args, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, `${bin}.ps1`)]);
    // Off Windows nothing changes.
    assert.deepEqual(resolveSpawnCommand(bin, env, "linux"), { file: bin, args: [] });
    assert.equal(unsupportedLauncher(bin, env, "linux"), null);
    // The real run uses the resolver instead of spawning the bare name.
    const source = fs.readFileSync(new URL(`../plugins/${plugin}/scripts/lib/${lib}.mjs`, import.meta.url), "utf8");
    const body = source.slice(source.indexOf(`function ${spawnFn}(`));
    assert.match(body.slice(0, 600), /resolveSpawnCommand\(/);
  });
}

for (const plugin of PLUGINS) {
  test(`${plugin}: a bare command is never resolved from the working folder on Windows`, async (t) => {
    const { resolveOnTrustedPath } = await import(`../plugins/${plugin}/scripts/lib/process.mjs`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hijack-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const repo = path.join(dir, "repo");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(repo);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(repo, "agy.cmd"), "@echo pwned\n");
    const env = { PATH: `.;relative;${bin}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" }; // Windows PATH uses ;
    // Only absolute PATH entries count, so the planted file in the checkout is never chosen.
    assert.equal(resolveOnTrustedPath("agy", env, "win32", repo), null);
    fs.writeFileSync(path.join(bin, "agy.cmd"), "@echo real\n");
    assert.equal(resolveOnTrustedPath("agy", env, "win32", repo), path.join(bin, "agy.cmd"));
    assert.equal(resolveOnTrustedPath("C:\\Tools\\agy.exe", env, "win32", repo), "C:\\Tools\\agy.exe");
    assert.equal(resolveOnTrustedPath("agy", env, "linux", repo), "agy");
    const source = fs.readFileSync(new URL(`../plugins/${plugin}/scripts/lib/process.mjs`, import.meta.url), "utf8");
    assert.match(source.slice(source.indexOf("export function runCommand(")), /^[\s\S]{0,700}resolveOnTrustedPath\(/);
  });
}

test("the Windows spawn resolvers skip relative PATH entries", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hijack-spawn-"));
  const previous = process.cwd();
  process.chdir(dir);
  // Leave the folder before deleting it: Windows cannot delete a process's working folder.
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const name of ["agy", "agent", "opencode", "gemini"]) fs.writeFileSync(path.join(dir, `${name}.cmd`), "");
  const env = { PATH: ".", PATHEXT: ".CMD" };
  const { resolveAgySpawnBin } = await import("../plugins/antigravity/scripts/lib/agy.mjs");
  const { resolveCursorSpawnBin } = await import("../plugins/cursor/scripts/lib/cursor.mjs");
  assert.equal(resolveAgySpawnBin(env, "win32"), "agy");
  assert.equal(resolveCursorSpawnBin(env, "win32"), "agent");
  for (const plugin of ["opencode", "gemini"]) {
    const { unsupportedLauncher } = await import(`../plugins/${plugin}/scripts/lib/process.mjs`);
    assert.equal(unsupportedLauncher(plugin, env, "win32"), null, plugin);
  }
});

for (const plugin of PLUGINS) {
  test(`${plugin}: transfer only auto-picks transcripts proven to belong to this workspace`, async (t) => {
    const { resolveTransferSource } = await import(`../plugins/${plugin}/scripts/lib/host-session.mjs`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collide-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const home = path.join(dir, "home");
    const repo = path.join(dir, "acme-prod");
    const other = path.join(dir, "acme", "prod");
    fs.mkdirSync(repo, { recursive: true });
    const encoded = (p) => path.resolve(p).replace(/[^a-zA-Z0-9]/g, "-");
    const claudeDir = path.join(home, ".claude", "projects", encoded(repo));
    const cursorProject = path.join(home, ".cursor", "projects", path.resolve(repo).replace(/\\/g, "/").replace(/:/g, "").replace(/\//g, "-").replace(/^-/, ""));
    const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    // Both transcripts sit in the folder the lossy encoding maps acme-prod to, but they belong to acme/prod.
    write(path.join(claudeDir, "s.jsonl"), `${JSON.stringify({ type: "user", cwd: other, message: { role: "user", content: "SECRET" } })}\n`);
    write(path.join(cursorProject, "agent-transcripts", "a", "a.jsonl"), `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "SECRET" }] } })}\n`);
    write(path.join(cursorProject, ".workspace-trusted"), JSON.stringify({ workspacePath: other }));
    assert.throws(() => resolveTransferSource(repo, { home, env: {} }), /--source/);
    // A Cursor folder with no workspace marker cannot be proven either.
    fs.rmSync(path.join(cursorProject, ".workspace-trusted"));
    assert.throws(() => resolveTransferSource(repo, { home, env: {} }), /--source/);
    // The real owner is still found: the Claude transcript recorded this workspace (or a folder inside it).
    write(path.join(claudeDir, "mine.jsonl"), `${JSON.stringify({ type: "user", cwd: path.join(repo, "src"), message: { role: "user", content: "mine" } })}\n`);
    assert.equal(resolveTransferSource(repo, { home, env: {} }).path, path.join(claudeDir, "mine.jsonl"));
  });
}

test("every Windows launch path refuses a CLI that is not on a trusted PATH entry", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-trust-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const untrusted = { PATH: ".", PATHEXT: ".EXE;.CMD", SystemRoot: "C:\\Windows" };
  const trusted = { ...untrusted, PATH: bin };
  const { resolveAgySpawnCommand } = await import("../plugins/antigravity/scripts/lib/agy.mjs");
  const { resolveCursorSpawnCommand } = await import("../plugins/cursor/scripts/lib/cursor.mjs");
  const { resolveClaudeSpawnCommand } = await import("../plugins/claude/scripts/lib/claude.mjs");
  const cases = [
    ["agy", (env) => resolveAgySpawnCommand(env, "win32").file],
    ["agent", (env) => resolveCursorSpawnCommand(env, "win32").file],
    ["claude", (env) => resolveClaudeSpawnCommand(env, "win32").file]
  ];
  for (const plugin of ["opencode", "gemini"]) {
    const { resolveSpawnCommand } = await import(`../plugins/${plugin}/scripts/lib/process.mjs`);
    cases.push([plugin, (env) => resolveSpawnCommand(plugin, env, "win32").file]);
  }
  for (const [name, resolve] of cases) {
    // Never fall back to the bare name: Windows would search the checkout first.
    assert.throws(() => resolve(untrusted), /not found on PATH/, name);
    fs.writeFileSync(path.join(bin, `${name}.exe`), "");
    assert.equal(resolve(trusted), path.join(bin, `${name}.exe`), name);
  }
});

for (const plugin of PLUGINS) {
  test(`${plugin}: job state is private to the user`, { skip: process.platform === "win32" ? "POSIX modes" : false }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-mode-"));
    const previous = process.env.PLUGIN_DATA;
    process.env.PLUGIN_DATA = path.join(dir, "data");
    t.after(() => {
      if (previous === undefined) delete process.env.PLUGIN_DATA;
      else process.env.PLUGIN_DATA = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const state = await import(`../plugins/${plugin}/scripts/lib/state.mjs`);
    const workspace = path.join(dir, "repo");
    fs.mkdirSync(workspace);
    // An existing folder created by an older version must be tightened too.
    fs.mkdirSync(state.resolveJobsDir(workspace), { recursive: true, mode: 0o755 });
    fs.chmodSync(state.resolveStateDir(workspace), 0o755);
    state.writeJobFile(workspace, "job-1", { prompt: "TRANSCRIPT" });
    const mode = (p) => fs.statSync(p).mode & 0o777;
    assert.equal(mode(state.resolveStateDir(workspace)), 0o700);
    assert.equal(mode(state.resolveJobsDir(workspace)), 0o700);
    assert.equal(mode(path.join(state.resolveJobsDir(workspace), "job-1.json")), 0o600);
  });
}

test("claude, cursor and gemini never put a prompt in argv", async () => {
  const secret = "short secret transcript";
  const { buildRunArgs: claudeArgs, shouldPassPromptViaStdin: claudeStdin } = await import("../plugins/claude/scripts/lib/claude.mjs");
  const { buildRunArgs: cursorArgs, shouldPassPromptViaStdin: cursorStdin } = await import("../plugins/cursor/scripts/lib/cursor.mjs");
  const { buildRunArgs: geminiArgs, shouldPassPromptViaStdin: geminiStdin } = await import("../plugins/gemini/scripts/lib/gemini.mjs");
  for (const decide of [claudeStdin, cursorStdin, geminiStdin]) assert.equal(decide(secret, "linux"), true);
  assert.equal(claudeArgs({ prompt: secret, platform: "linux" }).includes(secret), false);
  assert.equal(cursorArgs({ prompt: secret, platform: "linux", env: {} }).includes(secret), false);
  for (const backend of ["gemini", "agy"]) {
    assert.equal(geminiArgs("/repo", { backend, prompt: secret, platform: "linux", env: {} }).includes(secret), false, backend);
  }
});

test("opencode passes the prompt in a private attached file, never in argv", async (t) => {
  const { writePromptAttachment } = await import("../plugins/opencode/scripts/lib/opencode.mjs");
  const secret = "short secret transcript";
  const attachment = writePromptAttachment(secret);
  t.after(() => attachment.cleanup());
  assert.equal(attachment.args.includes(secret), false);
  // OpenCode's -f takes every value up to the next flag, so anything after the file is read as a second file.
  const flag = attachment.args.indexOf("-f");
  assert.deepEqual(attachment.args.slice(flag + 1).filter((arg) => !arg.startsWith("-")).length, 1);
  const file = attachment.args[flag + 1];
  assert.equal(fs.readFileSync(file, "utf8"), secret);
  assert.match(attachment.args.slice(0, flag).join(" "), /attached file/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  attachment.cleanup();
  assert.equal(fs.existsSync(attachment.args[1]), false);
  const source = fs.readFileSync(new URL("../plugins/opencode/scripts/lib/opencode.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /args\.push\(prompt\)/);
});

for (const plugin of PLUGINS) {
  test(`${plugin}: the companion reads stdin until end of file`, () => {
    const source = fs.readFileSync(new URL(`../plugins/${plugin}/scripts/lib/fs.mjs`, import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export function readStdinIfPiped"));
    assert.match(body.slice(0, 700), /EAGAIN/);
  });
}

// Real cmd-shim 9 output (npm's own shim writer), for a Node script and for an .exe.
const NODE_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  "IF EXIST \"%dp0%\\node.exe\" (", "  SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", ")", "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & \"%_prog%\"  \"%dp0%\\node_modules\\pkg\\cli.js\" %*", ""
].join("\r\n");
const exeShim = (name) => ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", `"%dp0%\\node_modules\\pkg\\${name}.exe"   %*`, ""].join("\r\n");

async function spawnResolvers() {
  const { resolveAgySpawnCommand } = await import("../plugins/antigravity/scripts/lib/agy.mjs");
  const { resolveCursorSpawnCommand } = await import("../plugins/cursor/scripts/lib/cursor.mjs");
  const { resolveClaudeSpawnCommand } = await import("../plugins/claude/scripts/lib/claude.mjs");
  const cases = [
    ["antigravity", "agy", (env) => resolveAgySpawnCommand(env, "win32")],
    ["cursor", "agent", (env) => resolveCursorSpawnCommand(env, "win32")],
    ["claude", "claude", (env) => resolveClaudeSpawnCommand(env, "win32")]
  ];
  for (const plugin of ["opencode", "gemini"]) {
    const { resolveSpawnCommand } = await import(`../plugins/${plugin}/scripts/lib/process.mjs`);
    cases.push([plugin, plugin, (env) => resolveSpawnCommand(plugin, env, "win32")]);
  }
  return cases;
}

test("an npm .cmd shim starts its target directly, never through PowerShell or cmd.exe", async (t) => {
  // The npm .ps1 pipes stdin through Windows PowerShell 5.1, which turns non-ASCII into ? and LF into CRLF.
  for (const [plugin, name, resolve] of await spawnResolvers()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-shim-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" };
    const pkg = path.join(dir, "node_modules", "pkg");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "cli.js"), "");
    fs.writeFileSync(path.join(dir, `${name}.cmd`), NODE_SHIM);
    fs.writeFileSync(path.join(dir, `${name}.ps1`), "");
    // The running Node, never a bare node, which Windows would look up in the working folder first.
    assert.deepEqual(resolve(env), { file: process.execPath, args: [path.join(pkg, "cli.js")] }, plugin);
    fs.writeFileSync(path.join(dir, `${name}.cmd`), exeShim(name));
    fs.writeFileSync(path.join(pkg, `${name}.exe`), "");
    assert.deepEqual(resolve(env), { file: path.join(pkg, `${name}.exe`), args: [] }, plugin);
    // A shim whose target is missing is not trusted as one.
    fs.rmSync(path.join(pkg, `${name}.exe`));
    let fallback = null;
    try {
      fallback = resolve(env).file;
    } catch (error) {
      assert.match(error.message, /launcher/, plugin); // claude has no .ps1 route, so it refuses
    }
    assert.notEqual(fallback, path.join(pkg, `${name}.exe`), plugin);
  }
});

test("claude refuses a .cmd launcher that is not an npm shim, in setup and at launch", async (t) => {
  const { resolveClaudeSpawnCommand, unsupportedLauncher } = await import("../plugins/claude/scripts/lib/claude.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  fs.writeFileSync(path.join(dir, "claude.cmd"), "@echo off\r\n");
  assert.match(unsupportedLauncher(env, "win32"), /claude\.cmd/);
  assert.throws(() => resolveClaudeSpawnCommand(env, "win32"), /claude\.cmd/);
  assert.equal(unsupportedLauncher(env, "linux"), null);
  // Setup reports it, so it never says ready and then fails every job with spawn EINVAL.
  const source = fs.readFileSync(new URL("../plugins/claude/scripts/lib/claude.mjs", import.meta.url), "utf8");
  assert.match(source.slice(source.indexOf("export function getClaudeAvailability(")).slice(0, 600), /unsupportedLauncher\(/);
});

test("antigravity setup shows the Windows launcher, not the extensionless POSIX shim", async (t) => {
  const { findOnPath } = await import("../plugins/antigravity/scripts/lib/agy.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-find-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "agy"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(dir, "agy.cmd"), "");
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(findOnPath("agy", env, "win32"), path.join(dir, "agy.cmd"));
  // A name that already has an extension is looked up as given.
  assert.equal(findOnPath("agy.cmd", env, "win32"), path.join(dir, "agy.cmd"));
});

test("only a .cmd is read as an npm shim, never a native .exe", async (t) => {
  // Reading a large claude.exe as text before every launch and job refresh costs seconds and memory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-exe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, "node_modules", "pkg");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "cli.js"), "");
  // An .exe whose bytes happen to look like a shim must still run as itself.
  fs.writeFileSync(path.join(dir, "claude.exe"), NODE_SHIM);
  const { resolveClaudeSpawnCommand } = await import("../plugins/claude/scripts/lib/claude.mjs");
  assert.deepEqual(resolveClaudeSpawnCommand({ PATH: dir, PATHEXT: ".EXE" }, "win32"), { file: path.join(dir, "claude.exe"), args: [] });
  for (const plugin of PLUGINS) {
    const { npmShimTarget } = await import(`../plugins/${plugin}/scripts/lib/process.mjs`);
    assert.equal(npmShimTarget(path.join(dir, "claude.exe")), null, plugin);
  }
});
