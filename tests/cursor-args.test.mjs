import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  WIN32_ARGV_PROMPT_LIMIT,
  buildRunArgs,
  buildReviewArgs,
  resolveCursorBin,
  resolveCursorSpawnBin,
  resolveCursorSpawnCommand,
  shouldPassPromptViaStdin
} from "../plugins/cursor/scripts/lib/cursor.mjs";

test("resolveCursorBin prefers CURSOR_BIN", () => {
  assert.equal(resolveCursorBin({ CURSOR_BIN: "C:\\tools\\agent.exe" }), "C:\\tools\\agent.exe");
  assert.equal(resolveCursorBin({}), "agent");
});

test("Windows resolves a PATH command to a spawnable .cmd or .exe path", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bin-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "agent.cmd");
  fs.writeFileSync(executable, "@echo off\r\nexit /b 0\r\n", "utf8");
  fs.writeFileSync(path.join(directory, "agent.ps1"), "exit 0\r\n", "utf8");
  assert.equal(
    resolveCursorSpawnBin({ PATH: directory, PATHEXT: ".EXE;.CMD" }, "win32"),
    executable
  );
  const command = resolveCursorSpawnCommand(
    { PATH: directory, PATHEXT: ".EXE;.CMD", SystemRoot: "C:\\Windows" },
    "win32"
  );
  assert.match(command.file, /powershell\.exe$/i);
  assert.ok(command.args.includes(path.join(directory, "agent.ps1")));
  const missingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bin-missing-"));
  t.after(() => fs.rmSync(missingDirectory, { recursive: true, force: true }));
  assert.equal(
    resolveCursorSpawnBin({ PATH: missingDirectory, PATHEXT: ".EXE;.CMD" }, "win32"),
    "agent"
  );
});

test("resolved installed agent path is directly spawnable", (t) => {
  const probe = spawnSync("agent", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  if (probe.error?.code === "ENOENT" || probe.status !== 0) {
    t.skip("agent is not installed and available");
    return;
  }
  const command = resolveCursorSpawnCommand();
  assert.match(command.file, /(?:\.exe|powershell\.exe)$/i);
  const result = spawnSync(command.file, [...command.args, "--version"], { encoding: "utf8", shell: false });
  assert.equal(result.error, undefined);
});

test("review wait uses plan, json, trust, and no force", () => {
  const args = buildReviewArgs({ prompt: "review", invoke: "print" });
  assert.ok(args.includes("-p"));
  assert.equal(args[args.indexOf("--mode") + 1], "plan");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.ok(args.includes("--trust"));
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--yolo"), false);
});

test("review ignores write overrides", () => {
  const args = buildReviewArgs({ prompt: "review", invoke: "print", write: true });
  assert.equal(args.includes("--force"), false);
  assert.equal(args[args.indexOf("--mode") + 1], "plan");
});

test("rescue write uses force and not plan", () => {
  const args = buildRunArgs({ prompt: "fix it", invoke: "print", write: true });
  assert.ok(args.includes("--force"));
  assert.ok(args.includes("-p"));
  assert.equal(args.includes("--mode"), false);
});

test("rescue without write uses plan", () => {
  const args = buildRunArgs({ prompt: "diagnose", invoke: "print", write: false });
  assert.equal(args[args.indexOf("--mode") + 1], "plan");
  assert.equal(args.includes("--force"), false);
});

test("background is still print-mode (no --bg)", () => {
  const args = buildRunArgs({ prompt: "fix it", invoke: "bg", write: true });
  assert.ok(args.includes("-p"));
  assert.equal(args.includes("--bg"), false);
  assert.ok(args.includes("--force"));
});

test("resume uses --resume", () => {
  const args = buildRunArgs({ prompt: "go", invoke: "print", resumeSessionId: "abc" });
  assert.equal(args[args.indexOf("--resume") + 1], "abc");
});

test("model passes through and effort throws", () => {
  const args = buildRunArgs({ prompt: "go", invoke: "print", model: "composer-2.5" });
  assert.equal(args[args.indexOf("--model") + 1], "composer-2.5");
  assert.throws(
    () => buildRunArgs({ prompt: "go", invoke: "print", effort: "high" }),
    /effort/
  );
});

test("win32 long prompt is omitted from argv", () => {
  const prompt = "x".repeat(WIN32_ARGV_PROMPT_LIMIT + 1);
  assert.equal(shouldPassPromptViaStdin(prompt, "win32"), true);
  const args = buildRunArgs({ prompt, invoke: "print", platform: "win32" });
  assert.equal(args.includes(prompt), false);
  assert.ok(args.includes("-p"));
});
