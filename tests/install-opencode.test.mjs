import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  installPlugins,
  parseInstallArgs,
  resolveInstallPaths,
  uninstallPlugins
} from "../scripts/lib/opencode-install.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = path.join(repoRoot, "tests", ".tmp");

function makeTemp(prefix) {
  fs.mkdirSync(tempRoot, { recursive: true });
  return fs.mkdtempSync(path.join(tempRoot, prefix));
}

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("parseInstallArgs defaults to all plugins in user scope", () => {
  assert.deepEqual(parseInstallArgs([]), {
    plugin: "all",
    scope: "user",
    force: false,
    uninstall: false,
    projectRoot: null
  });
});

test("parseInstallArgs accepts every supported option", () => {
  const projectRoot = path.resolve(makeTemp("args-"));
  assert.deepEqual(
    parseInstallArgs([
      "--plugin",
      "gemini",
      "--scope",
      "project",
      "--project",
      projectRoot,
      "--force",
      "--uninstall"
    ]),
    {
      plugin: "gemini",
      scope: "project",
      force: true,
      uninstall: true,
      projectRoot
    }
  );
});

test("parseInstallArgs accepts claude plugin", () => {
  assert.equal(parseInstallArgs(["--plugin", "claude"]).plugin, "claude");
});

test("resolveInstallPaths uses OpenCode user directories", () => {
  const home = makeTemp("paths-");
  assert.deepEqual(
    resolveInstallPaths({
      scope: "user",
      projectRoot: null,
      homedir: home,
      pluginName: "opencode"
    }),
    {
      pluginTree: path.join(home, ".config", "opencode", "plugins", "opencode"),
      commandDir: path.join(home, ".config", "opencode", "command"),
      agentDir: path.join(home, ".config", "opencode", "agent"),
      skillsDir: path.join(home, ".config", "opencode", "skills"),
      installedManifest: path.join(
        home,
        ".config",
        "opencode",
        "plugins",
        "marketplace-installed.json"
      )
    }
  );
});

test("user install copies and rewrites commands, agents, skills, and scripts", () => {
  const home = makeTemp("home-");
  const result = installPlugins({
    repoRoot,
    plugin: "opencode",
    scope: "user",
    force: false,
    homedir: home
  });
  const root = path.join(home, ".config", "opencode");
  const pluginTree = path.join(root, "plugins", "opencode");
  const review = path.join(root, "command", "opencode--review.md");
  const agent = path.join(root, "agent", "opencode--opencode-rescue.md");
  const skill = path.join(root, "skills", "opencode-review", "SKILL.md");
  const companion = path.join(pluginTree, "scripts", "opencode-companion.mjs");

  for (const installed of [review, agent, skill, companion]) {
    assert.equal(fs.existsSync(installed), true, installed);
    assert.ok(result.recorded.includes(installed), installed);
  }

  const companionInvocation = `node "${companion}"`;
  for (const markdown of [review, agent, skill]) {
    const body = fs.readFileSync(markdown, "utf8");
    assert.match(body, new RegExp(companionInvocation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(body, /<plugin-root>/);
  }

  assert.equal(
    fs.existsSync(path.join(pluginTree, "commands", "review.md")),
    true,
    "the full plugin tree is copied"
  );
  assert.equal(fs.existsSync(path.join(root, "opencode.json")), false);
});

test("installing the same plugin twice is idempotent", () => {
  const home = makeTemp("idempotent-");
  const options = {
    repoRoot,
    plugin: "opencode",
    scope: "user",
    force: false,
    homedir: home
  };
  const first = installPlugins(options);
  const review = path.join(
    home,
    ".config",
    "opencode",
    "command",
    "opencode--review.md"
  );
  const oldTime = new Date("2000-01-01T00:00:00.000Z");
  fs.utimesSync(review, oldTime, oldTime);
  const second = installPlugins(options);
  assert.deepEqual(second.recorded, first.recorded);
  assert.equal(fs.statSync(review).mtimeMs, oldTime.getTime());
});

test("installing all plugins copies the Claude plugin tree without commands", () => {
  const home = makeTemp("all-");
  installPlugins({
    repoRoot,
    plugin: "all",
    scope: "user",
    force: false,
    homedir: home
  });

  assert.equal(
    fs.existsSync(
      path.join(home, ".config", "opencode", "plugins", "claude", "scripts", "claude-companion.mjs")
    ),
    true
  );
});

test("reinstall removes files recorded by the plugin that are no longer produced", () => {
  const home = makeTemp("stale-");
  const options = {
    repoRoot,
    plugin: "opencode",
    scope: "user",
    force: false,
    homedir: home
  };
  installPlugins(options);
  const root = path.join(home, ".config", "opencode");
  const stale = path.join(root, "command", "opencode--stale.md");
  const review = path.join(root, "command", "opencode--review.md");
  const manifestPath = path.join(
    root,
    "plugins",
    "marketplace-installed.json"
  );
  fs.writeFileSync(stale, "previously installed\n");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.plugins.opencode.files.push(stale);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  installPlugins(options);

  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(review), true);
  const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(updatedManifest.plugins.opencode.files.includes(stale), false);
});

test("install refuses to overwrite an unrecorded destination without force", () => {
  const home = makeTemp("collision-");
  const commandDir = path.join(home, ".config", "opencode", "command");
  fs.mkdirSync(commandDir, { recursive: true });
  fs.writeFileSync(path.join(commandDir, "opencode--review.md"), "mine\n");

  assert.throws(
    () =>
      installPlugins({
        repoRoot,
        plugin: "opencode",
        scope: "user",
        force: false,
        homedir: home
      }),
    /not installed by agent-bridges/
  );
});

test("project scope installs beneath the requested project", () => {
  const projectRoot = path.resolve(makeTemp("project-"));
  installPlugins({
    repoRoot,
    plugin: "opencode",
    scope: "project",
    projectRoot,
    force: false
  });

  assert.equal(
    fs.existsSync(path.join(projectRoot, ".opencode", "command", "opencode--review.md")),
    true
  );
});

test("CLI installs project scope and prints a one-line summary", () => {
  const projectRoot = path.resolve(makeTemp("cli-project-"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "install-opencode.mjs"),
      "--plugin",
      "opencode",
      "--scope",
      "project",
      "--project",
      projectRoot
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Installed opencode \(\d+ files\)\.\r?\n$/);
  assert.equal(
    fs.existsSync(path.join(projectRoot, ".opencode", "command", "opencode--review.md")),
    true
  );
});

test("uninstall removes only files recorded for selected plugins", () => {
  const home = makeTemp("uninstall-");
  const options = {
    repoRoot,
    plugin: "all",
    scope: "user",
    force: false,
    homedir: home
  };
  installPlugins(options);
  const root = path.join(home, ".config", "opencode");
  const stray = path.join(root, "command", "stray.md");
  const geminiReview = path.join(root, "command", "gemini--review.md");
  const opencodeReview = path.join(root, "command", "opencode--review.md");
  fs.writeFileSync(stray, "mine\n");

  const result = uninstallPlugins({ ...options, plugin: "opencode" });

  assert.equal(fs.existsSync(stray), true);
  assert.equal(fs.existsSync(geminiReview), true);
  assert.equal(fs.existsSync(opencodeReview), false);
  assert.ok(result.removed.includes(opencodeReview));

  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(root, "plugins", "marketplace-installed.json"),
      "utf8"
    )
  );
  assert.deepEqual(Object.keys(manifest.plugins), ["gemini", "claude"]);
});
