import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SKIP = process.platform === "win32" ? "symlinks need privileges on Windows" : false;

for (const plugin of ["opencode", "gemini", "claude", "cursor", "antigravity"]) {
  test(`${plugin} review context never follows an untracked symlink`, { skip: SKIP }, async (t) => {
    const { collectReviewContext, resolveReviewTarget } = await import(`../plugins/${plugin}/scripts/lib/git.mjs`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-symlink-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    spawnSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
    fs.writeFileSync(path.join(dir, "secret.txt"), "TOP-SECRET-TOKEN\n");
    fs.symlinkSync(path.join(dir, "secret.txt"), path.join(repo, "leak.txt"));
    const context = collectReviewContext(repo, resolveReviewTarget(repo, {}));
    assert.doesNotMatch(JSON.stringify(context), /TOP-SECRET-TOKEN/);
  });

  test(`${plugin} git helpers never use a shell`, () => {
    const source = fs.readFileSync(new URL(`../plugins/${plugin}/scripts/lib/git.mjs`, import.meta.url), "utf8");
    assert.match(source, /runCommand\("git", args, \{ cwd, shell: false, \.\.\.options \}\)/);
    assert.match(source, /runCommandChecked\("git", args, \{ cwd, shell: false, \.\.\.options \}\)/);
  });
}
