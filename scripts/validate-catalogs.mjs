import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateMarketplaceRepo } from "./lib/catalogs.mjs";

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const result = validateMarketplaceRepo(root);
if (!result.ok) {
  for (const error of result.errors) {
    process.stderr.write(`${error}\n`);
  }
  process.exitCode = 1;
}
