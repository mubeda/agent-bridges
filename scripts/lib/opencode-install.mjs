import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGINS = new Set(["opencode", "gemini", "claude", "all"]);
const SCOPES = new Set(["user", "project"]);

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseInstallArgs(argv) {
  const result = {
    plugin: "all",
    scope: "user",
    force: false,
    uninstall: false,
    projectRoot: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--plugin") {
      result.plugin = takeValue(argv, index, option);
      index += 1;
    } else if (option === "--scope") {
      result.scope = takeValue(argv, index, option);
      index += 1;
    } else if (option === "--project") {
      result.projectRoot = takeValue(argv, index, option);
      index += 1;
    } else if (option === "--force") {
      result.force = true;
    } else if (option === "--uninstall") {
      result.uninstall = true;
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }

  if (!PLUGINS.has(result.plugin)) {
    throw new Error(`invalid plugin: ${result.plugin}`);
  }
  if (!SCOPES.has(result.scope)) {
    throw new Error(`invalid scope: ${result.scope}`);
  }
  if (result.projectRoot !== null && !path.isAbsolute(result.projectRoot)) {
    throw new Error("--project must be an absolute path");
  }

  return result;
}

export function resolveInstallPaths({
  scope,
  projectRoot,
  homedir = os.homedir(),
  pluginName
}) {
  if (!SCOPES.has(scope)) {
    throw new Error(`invalid scope: ${scope}`);
  }
  if (scope === "project" && !projectRoot) {
    throw new Error("project scope requires a project root");
  }
  if (scope === "project" && !path.isAbsolute(projectRoot)) {
    throw new Error("project root must be an absolute path");
  }

  const root =
    scope === "project"
      ? path.join(projectRoot, ".opencode")
      : path.join(homedir, ".config", "opencode");

  return {
    pluginTree: path.join(root, "plugins", pluginName),
    commandDir: path.join(root, "command"),
    agentDir: path.join(root, "agent"),
    skillsDir: path.join(root, "skills"),
    installedManifest: path.join(root, "plugins", "marketplace-installed.json")
  };
}

function readCatalog(repoRoot) {
  const catalogPath = path.join(repoRoot, ".opencode", "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  if (!Array.isArray(catalog.plugins)) {
    throw new Error("OpenCode catalog is missing its plugins array");
  }
  return catalog;
}

function selectedPlugins(catalog, requested) {
  const selected =
    requested === "all"
      ? catalog.plugins
      : catalog.plugins.filter((entry) => entry.name === requested);
  if (requested !== "all" && selected.length !== 1) {
    throw new Error(`plugin not found in OpenCode catalog: ${requested}`);
  }
  return selected;
}

function listFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function isRewrittenMarkdown(sourcePath, sourceRoot) {
  if (path.extname(sourcePath) !== ".md") {
    return false;
  }
  const relative = path.relative(sourceRoot, sourcePath);
  const topLevel = relative.split(path.sep)[0];
  return topLevel === "commands" || topLevel === "agents" || topLevel === "skills";
}

function rewriteMarkdown(body, pluginTree, companion) {
  const companionPath = path.join(pluginTree, ...companion.split("/"));
  const start = body.indexOf("Resolve `<plugin-root>`");
  if (start !== -1) {
    const missing = body.indexOf("If none exist,", start);
    if (missing !== -1) {
      const lineEnd = body.indexOf("\n", missing);
      const end = lineEnd === -1 ? body.length : lineEnd + 1;
      body =
        body.slice(0, start) +
        `Use the installed plugin root \`${pluginTree}\`.\n` +
        body.slice(end);
    }
  }
  return body
    .replaceAll(`<plugin-root>/${companion}`, companionPath)
    .replaceAll("<plugin-root>", pluginTree);
}

function fileContent(sourcePath, sourceRoot, pluginTree, companion) {
  const content = fs.readFileSync(sourcePath);
  if (!isRewrittenMarkdown(sourcePath, sourceRoot)) {
    return content;
  }
  return Buffer.from(rewriteMarkdown(content.toString("utf8"), pluginTree, companion));
}

function addTree(
  plan,
  sourceRoot,
  destinationRoot,
  pluginTree,
  companion,
  rewriteRoot = sourceRoot
) {
  for (const sourcePath of listFiles(sourceRoot)) {
    const destination = path.join(destinationRoot, path.relative(sourceRoot, sourcePath));
    plan.set(
      destination,
      fileContent(sourcePath, rewriteRoot, pluginTree, companion)
    );
  }
}

function buildPlan(repoRoot, plugin, paths) {
  const sourceRoot = path.resolve(repoRoot, plugin.source);
  const plan = new Map();

  addTree(plan, sourceRoot, paths.pluginTree, paths.pluginTree, plugin.companion);

  const commandRoot = path.join(sourceRoot, "commands");
  for (const sourcePath of listFiles(commandRoot)) {
    if (path.extname(sourcePath) !== ".md") continue;
    const stem = path.basename(sourcePath, ".md");
    plan.set(
      path.join(paths.commandDir, `${plugin.name}--${stem}.md`),
      fileContent(sourcePath, sourceRoot, paths.pluginTree, plugin.companion)
    );
  }

  const agentRoot = path.join(sourceRoot, "agents");
  for (const sourcePath of listFiles(agentRoot)) {
    if (path.extname(sourcePath) !== ".md") continue;
    plan.set(
      path.join(paths.agentDir, `${plugin.name}--${path.basename(sourcePath)}`),
      fileContent(sourcePath, sourceRoot, paths.pluginTree, plugin.companion)
    );
  }

  const skillsRoot = path.join(sourceRoot, "skills");
  addTree(
    plan,
    skillsRoot,
    paths.skillsDir,
    paths.pluginTree,
    plugin.companion,
    sourceRoot
  );

  return { plan, sourceRoot };
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return { version: 1, plugins: {} };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || !manifest.plugins || typeof manifest.plugins !== "object") {
    throw new Error(`invalid installed manifest: ${manifestPath}`);
  }
  return manifest;
}

function sameContent(filePath, expected) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  return digest(fs.readFileSync(filePath)) === digest(expected);
}

function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function installPlugins({
  repoRoot,
  plugin = "all",
  scope = "user",
  projectRoot = null,
  force = false,
  homedir = os.homedir()
}) {
  if (!PLUGINS.has(plugin)) {
    throw new Error(`invalid plugin: ${plugin}`);
  }
  const catalog = readCatalog(repoRoot);
  const chosen = selectedPlugins(catalog, plugin);
  const installations = [];

  for (const entry of chosen) {
    const paths = resolveInstallPaths({
      scope,
      projectRoot,
      homedir,
      pluginName: entry.name
    });
    const manifest = readManifest(paths.installedManifest);
    const previouslyRecorded = new Set(manifest.plugins[entry.name]?.files ?? []);
    const built = buildPlan(repoRoot, entry, paths);

    for (const [destination, content] of built.plan) {
      if (!fs.existsSync(destination)) continue;
      if (!previouslyRecorded.has(destination) && !force) {
        throw new Error(`${destination} exists and was not installed by agent-bridges`);
      }
      if (previouslyRecorded.has(destination) && !sameContent(destination, content) && !force) {
        throw new Error(`${destination} was modified; use --force to overwrite it`);
      }
    }
    const files = [...built.plan.keys()].sort();
    const previousFiles = [...previouslyRecorded].sort();
    const unchanged =
      files.length === previousFiles.length &&
      files.every((file, index) => file === previousFiles[index]) &&
      [...built.plan].every(([destination, content]) =>
        sameContent(destination, content)
      );
    installations.push({
      entry,
      paths,
      manifest,
      files,
      previousFiles,
      unchanged,
      ...built
    });
  }

  const recorded = [];
  for (const installation of installations) {
    const {
      entry,
      paths,
      files,
      plan,
      previousFiles,
      sourceRoot,
      unchanged
    } = installation;
    if (unchanged) {
      recorded.push(...files);
      continue;
    }
    fs.mkdirSync(path.dirname(paths.pluginTree), { recursive: true });
    fs.cpSync(sourceRoot, paths.pluginTree, { recursive: true, force: true });
    for (const [destination, content] of plan) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }

    const nextFiles = new Set(files);
    for (const previousFile of previousFiles) {
      if (
        !nextFiles.has(previousFile) &&
        fs.existsSync(previousFile) &&
        fs.statSync(previousFile).isFile()
      ) {
        fs.rmSync(previousFile);
      }
    }

    const manifest = readManifest(paths.installedManifest);
    manifest.plugins[entry.name] = { files };
    writeManifest(paths.installedManifest, manifest);
    recorded.push(...files);
  }

  return { recorded };
}

export function uninstallPlugins({
  repoRoot,
  plugin = "all",
  scope = "user",
  projectRoot = null,
  homedir = os.homedir()
}) {
  if (!PLUGINS.has(plugin)) {
    throw new Error(`invalid plugin: ${plugin}`);
  }
  const catalog = readCatalog(repoRoot);
  const chosen = selectedPlugins(catalog, plugin);
  const manifestPath = resolveInstallPaths({
    scope,
    projectRoot,
    homedir,
    pluginName: chosen[0]?.name ?? "opencode"
  }).installedManifest;
  const manifest = readManifest(manifestPath);
  const removed = [];

  for (const entry of chosen) {
    for (const installedPath of manifest.plugins[entry.name]?.files ?? []) {
      if (fs.existsSync(installedPath) && fs.statSync(installedPath).isFile()) {
        fs.rmSync(installedPath);
        removed.push(installedPath);
      }
    }
    delete manifest.plugins[entry.name];
  }

  writeManifest(manifestPath, manifest);
  return { removed };
}
