import fs from "node:fs";
import path from "node:path";

export const CATALOG_NAME = "agent-bridges";

export const REQUIRED_CATALOG_FILES = [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  ".cursor-plugin/marketplace.json",
  ".opencode/catalog.json"
];

const PLUGIN_NAMES = ["opencode", "gemini"];
const ALLOWED_PLUGIN_NAMES = new Set(PLUGIN_NAMES);

function displayPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function readJson(filePath, errors) {
  const label = displayPath(filePath);
  if (!fs.existsSync(filePath)) {
    errors.push(`missing ${label}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`invalid JSON ${label}: ${error.message}`);
    return null;
  }
}

function requireName(obj, label, errors) {
  if (!obj || typeof obj.name !== "string" || !obj.name.trim()) {
    errors.push(`${label} missing name`);
  }
}

function requireCatalogId(obj, label, errors) {
  if (!obj) {
    return;
  }
  if (obj.name !== CATALOG_NAME) {
    errors.push(`${label} name must be ${CATALOG_NAME} (got ${obj.name ?? "missing"})`);
  }
}

function requireAllowedPlugins(catalog, label, errors, { exactCount = 2 } = {}) {
  if (!Array.isArray(catalog.plugins)) {
    errors.push(`${label} missing plugins array`);
    return;
  }
  if (catalog.plugins.length !== exactCount) {
    errors.push(`${label} must list exactly ${exactCount} plugins`);
    return;
  }
  const names = catalog.plugins.map((plugin) => plugin.name);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== exactCount) {
    errors.push(`${label} must list exactly one entry each for opencode and gemini`);
    return;
  }
  for (const plugin of catalog.plugins) {
    if (!ALLOWED_PLUGIN_NAMES.has(plugin.name)) {
      errors.push(`${label} plugin ${plugin.name} is not allowed`);
    }
  }
  for (const required of PLUGIN_NAMES) {
    if (!uniqueNames.has(required)) {
      errors.push(`${label} missing required plugin ${required}`);
    }
  }
}

export function validateMarketplaceRepo(rootDir) {
  const errors = [];
  const catalogs = {};
  for (const rel of REQUIRED_CATALOG_FILES) {
    catalogs[rel] = readJson(path.join(rootDir, ...rel.split("/")), errors);
  }

  const claude = catalogs[".claude-plugin/marketplace.json"];
  if (claude) {
    requireName(claude, "claude marketplace", errors);
    requireCatalogId(claude, "claude marketplace", errors);
    requireAllowedPlugins(claude, "claude marketplace", errors);
    if (Array.isArray(claude.plugins) && claude.plugins.length === 2) {
      for (const plugin of claude.plugins) {
        if (typeof plugin.source !== "string" || !plugin.source.startsWith("./plugins/")) {
          errors.push(`claude plugin ${plugin.name} source must be a ./plugins/... string`);
        }
      }
    }
  }

  const codex = catalogs[".agents/plugins/marketplace.json"];
  if (codex) {
    requireName(codex, "codex marketplace", errors);
    requireCatalogId(codex, "codex marketplace", errors);
    requireAllowedPlugins(codex, "codex marketplace", errors);
    if (Array.isArray(codex.plugins) && codex.plugins.length === 2) {
      for (const plugin of codex.plugins) {
        const p = plugin.source?.path;
        if (typeof p !== "string" || !p.startsWith("./plugins/")) {
          errors.push(`codex plugin ${plugin.name} missing source.path`);
        }
      }
    }
  }

  const cursor = catalogs[".cursor-plugin/marketplace.json"];
  if (cursor) {
    requireName(cursor, "cursor marketplace", errors);
    requireCatalogId(cursor, "cursor marketplace", errors);
    requireAllowedPlugins(cursor, "cursor marketplace", errors);
    if (Array.isArray(cursor.plugins) && cursor.plugins.length === 2) {
      for (const plugin of cursor.plugins) {
        if (typeof plugin.source !== "string" || !plugin.source.startsWith("./plugins/")) {
          errors.push(`cursor plugin ${plugin.name} source must be a ./plugins/... string`);
        }
      }
    }
  }

  const opencode = catalogs[".opencode/catalog.json"];
  if (opencode) {
    requireName(opencode, "opencode catalog", errors);
    requireCatalogId(opencode, "opencode catalog", errors);
    requireAllowedPlugins(opencode, "opencode catalog", errors);
    if (Array.isArray(opencode.plugins) && opencode.plugins.length === 2) {
      for (const plugin of opencode.plugins) {
        if (typeof plugin.source !== "string" || !plugin.source.startsWith("./plugins/")) {
          errors.push(`opencode plugin ${plugin.name} source must be a ./plugins/... string`);
        }
      }
    }
  }

  for (const name of PLUGIN_NAMES) {
    readJson(path.join(rootDir, "plugins", name, ".claude-plugin", "plugin.json"), errors);
    const codexPlugin = readJson(
      path.join(rootDir, "plugins", name, ".codex-plugin", "plugin.json"),
      errors
    );
    if (codexPlugin && codexPlugin.skills !== "./skills/") {
      errors.push(`plugins/${name}/.codex-plugin/plugin.json skills must be ./skills/`);
    }
    readJson(path.join(rootDir, "plugins", name, ".cursor-plugin", "plugin.json"), errors);
  }

  return { ok: errors.length === 0, errors };
}
