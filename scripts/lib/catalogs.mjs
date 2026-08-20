import fs from "node:fs";
import path from "node:path";

export const CATALOG_NAME = "agent-bridges";

export const REQUIRED_CATALOG_FILES = [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  ".cursor-plugin/marketplace.json",
  ".opencode/catalog.json"
];

export const CLAUDE_HOST_PLUGIN_NAMES = ["opencode", "gemini"];
export const OTHER_HOST_PLUGIN_NAMES = ["opencode", "gemini", "claude"];
export const PLUGIN_TREES = ["opencode", "gemini", "claude"];

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

function formatNameList(names) {
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function requireAllowedPlugins(catalog, label, errors, requiredNames) {
  const allowed = new Set(requiredNames);
  const exactCount = requiredNames.length;
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
    errors.push(`${label} must list exactly one entry each for ${formatNameList(requiredNames)}`);
    return;
  }
  for (const plugin of catalog.plugins) {
    if (!allowed.has(plugin.name)) {
      errors.push(`${label} plugin ${plugin.name} is not allowed`);
    }
  }
  for (const required of requiredNames) {
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
    requireAllowedPlugins(claude, "claude marketplace", errors, CLAUDE_HOST_PLUGIN_NAMES);
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
    requireAllowedPlugins(codex, "codex marketplace", errors, OTHER_HOST_PLUGIN_NAMES);
    if (Array.isArray(codex.plugins) && codex.plugins.length === 3) {
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
    requireAllowedPlugins(cursor, "cursor marketplace", errors, OTHER_HOST_PLUGIN_NAMES);
    if (Array.isArray(cursor.plugins) && cursor.plugins.length === 3) {
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
    requireAllowedPlugins(opencode, "opencode catalog", errors, OTHER_HOST_PLUGIN_NAMES);
    if (Array.isArray(opencode.plugins) && opencode.plugins.length === 3) {
      for (const plugin of opencode.plugins) {
        if (typeof plugin.source !== "string" || !plugin.source.startsWith("./plugins/")) {
          errors.push(`opencode plugin ${plugin.name} source must be a ./plugins/... string`);
        }
      }
    }
  }

  for (const name of PLUGIN_TREES) {
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
