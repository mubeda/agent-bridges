// Copies each plugin's scripts/, prompts/ and schemas/ into its <plugin>-cli-runtime skill,
// so a skill installed with `npx skills` carries the companion it runs (spec D9, R25).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SYNCED_DIRS = ["scripts", "prompts", "schemas"];
export const PLUGINS = ["opencode", "gemini", "claude", "cursor", "antigravity"];

export function listPluginRuntimes(root) {
  return PLUGINS.flatMap((plugin) =>
    SYNCED_DIRS.map((dir) => ({
      plugin,
      dir,
      source: path.join(root, "plugins", plugin, dir),
      target: path.join(root, "plugins", plugin, "skills", `${plugin}-cli-runtime`, dir)
    }))
  );
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

/** Relative paths that differ, are missing in the target, or exist only in the target. */
export function compareTrees(sourceDir, targetDir) {
  const sourceFiles = listFiles(sourceDir);
  const targetFiles = new Set(listFiles(targetDir));
  const diff = [];
  for (const rel of sourceFiles) {
    if (!targetFiles.has(rel)) diff.push(rel);
    else if (!fs.readFileSync(path.join(sourceDir, rel)).equals(fs.readFileSync(path.join(targetDir, rel)))) diff.push(rel);
    targetFiles.delete(rel);
  }
  return [...diff, ...targetFiles].sort();
}

/** Replace the target with a fresh copy; a removed source leaves no stale copy behind. */
export function syncPair(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (const plugin of PLUGINS) {
    for (const { source, target } of listPluginRuntimes(root).filter((entry) => entry.plugin === plugin)) syncPair(source, target);
    process.stdout.write(`synced ${plugin}-cli-runtime\n`);
  }
}
