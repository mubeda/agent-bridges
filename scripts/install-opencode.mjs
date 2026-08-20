import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  installPlugins,
  parseInstallArgs,
  uninstallPlugins
} from "./lib/opencode-install.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

try {
  const options = parseInstallArgs(process.argv.slice(2));
  if (options.scope === "project" && options.projectRoot === null) {
    options.projectRoot = process.cwd();
  }

  const common = { ...options, repoRoot, homedir: os.homedir() };
  if (options.uninstall) {
    const { removed } = uninstallPlugins(common);
    process.stdout.write(`Uninstalled ${options.plugin} (${removed.length} files).\n`);
  } else {
    const { recorded } = installPlugins(common);
    process.stdout.write(`Installed ${options.plugin} (${recorded.length} files).\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
