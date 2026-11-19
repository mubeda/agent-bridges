import fs from "node:fs";
import path from "node:path";

export const CATALOG_NAME = "agent-bridges";

export const REQUIRED_CATALOG_FILES = [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  ".cursor-plugin/marketplace.json",
  ".opencode/catalog.json"
];

export const CLAUDE_HOST_PLUGIN_NAMES = ["opencode", "gemini", "cursor", "antigravity"];
export const CODEX_OPENCODE_PLUGIN_NAMES = ["opencode", "gemini", "claude", "cursor", "antigravity"];
export const CURSOR_HOST_PLUGIN_NAMES = ["opencode", "gemini", "claude", "antigravity"];
export const PLUGIN_TREES = ["opencode", "gemini", "claude", "cursor", "antigravity"];

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
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`${label} must hold a JSON object`);
      return null;
    }
    return parsed;
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

function pluginEntries(catalog) {
  return Array.isArray(catalog.plugins) ? catalog.plugins.filter((plugin) => plugin && typeof plugin === "object") : [];
}

function requireAllowedPlugins(catalog, label, errors, requiredNames) {
  const allowed = new Set(requiredNames);
  if (!Array.isArray(catalog.plugins)) {
    errors.push(`${label} missing plugins array`);
    return;
  }
  catalog.plugins.forEach((plugin, index) => {
    if (!plugin || typeof plugin !== "object") errors.push(`${label} entry ${index} is not an object`);
  });
  const names = pluginEntries(catalog).map((plugin) => plugin.name);
  const uniqueNames = new Set(names);
  // Name the missing and unexpected plugins first: a bare count mismatch hides which one is wrong.
  for (const required of requiredNames) {
    if (!uniqueNames.has(required)) errors.push(`${label} missing required plugin ${required}`);
  }
  for (const name of uniqueNames) {
    if (!allowed.has(name)) errors.push(`${label} plugin ${name} is not allowed`);
  }
  if (uniqueNames.size !== names.length) {
    errors.push(`${label} must list exactly one entry each for ${formatNameList(requiredNames)}`);
  } else if (catalog.plugins.length !== requiredNames.length) {
    errors.push(`${label} must list exactly ${requiredNames.length} plugins`);
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
    {
      for (const plugin of pluginEntries(claude)) {
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
    requireAllowedPlugins(codex, "codex marketplace", errors, CODEX_OPENCODE_PLUGIN_NAMES);
    {
      for (const plugin of pluginEntries(codex)) {
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
    requireAllowedPlugins(cursor, "cursor marketplace", errors, CURSOR_HOST_PLUGIN_NAMES);
    {
      const pluginRoot = cursor.metadata?.pluginRoot;
      for (const plugin of pluginEntries(cursor)) {
        const source = plugin.source;
        const shortOk = pluginRoot === "plugins" && source === plugin.name;
        const prefixedOk = typeof source === "string" && source === `./plugins/${plugin.name}`;
        if (!shortOk && !prefixedOk) {
          errors.push(
            `cursor plugin ${plugin.name} source must be ./plugins/${plugin.name} or ${plugin.name} with metadata.pluginRoot plugins`
          );
        }
      }
    }
  }

  const opencode = catalogs[".opencode/catalog.json"];
  if (opencode) {
    requireName(opencode, "opencode catalog", errors);
    requireCatalogId(opencode, "opencode catalog", errors);
    requireAllowedPlugins(opencode, "opencode catalog", errors, CODEX_OPENCODE_PLUGIN_NAMES);
    {
      for (const plugin of pluginEntries(opencode)) {
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
