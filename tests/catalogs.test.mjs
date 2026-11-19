import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CATALOG_NAME, validateMarketplaceRepo } from "../scripts/lib/catalogs.mjs";

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridges-catalog-"));
  const write = (rel, obj) => {
    const full = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(obj, null, 2)}\n`);
  };
  return { root, write };
}

function writePluginManifests(write, names) {
  for (const name of names) {
    write(`plugins/${name}/.claude-plugin/plugin.json`, { name });
    write(`plugins/${name}/.codex-plugin/plugin.json`, { name, skills: "./skills/" });
    write(`plugins/${name}/.cursor-plugin/plugin.json`, { name });
  }
}

test("CATALOG_NAME is agent-bridges", () => {
  assert.equal(CATALOG_NAME, "agent-bridges");
});

test("empty directory fails validation", () => {
  const { root } = createFixture();
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes(".claude-plugin/marketplace.json")));
});

test("fixture with catalogs and plugin manifests passes", () => {
  const { root, write } = createFixture();
  const claudePlugins = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" },
    { name: "cursor", source: "./plugins/cursor" },
    { name: "antigravity", source: "./plugins/antigravity" }
  ];
  const cursorPlugins = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" },
    { name: "claude", source: "./plugins/claude" },
    { name: "antigravity", source: "./plugins/antigravity" }
  ];
  const codexPlugins = [
    { name: "opencode", source: { source: "local", path: "./plugins/opencode" } },
    { name: "gemini", source: { source: "local", path: "./plugins/gemini" } },
    { name: "claude", source: { source: "local", path: "./plugins/claude" } },
    { name: "cursor", source: { source: "local", path: "./plugins/cursor" } },
    { name: "antigravity", source: { source: "local", path: "./plugins/antigravity" } }
  ];
  const opencodePlugins = [...cursorPlugins, { name: "cursor", source: "./plugins/cursor" }];
  write(".claude-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: claudePlugins
  });
  write(".agents/plugins/marketplace.json", {
    name: "agent-bridges",
    plugins: codexPlugins
  });
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: cursorPlugins
  });
  write(".opencode/catalog.json", {
    name: "agent-bridges",
    plugins: opencodePlugins
  });
  writePluginManifests(write, ["opencode", "gemini", "claude", "cursor", "antigravity"]);
  const result = validateMarketplaceRepo(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("claude marketplace must not list the claude plugin", () => {
  const { root, write } = createFixture();
  const two = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" }
  ];
  const three = [...two, { name: "claude", source: "./plugins/claude" }];
  const four = [...three, { name: "cursor", source: "./plugins/cursor" }];
  write(".claude-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: three
  });
  write(".agents/plugins/marketplace.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: { source: "local", path: "./plugins/opencode" } },
      { name: "gemini", source: { source: "local", path: "./plugins/gemini" } },
      { name: "claude", source: { source: "local", path: "./plugins/claude" } },
      { name: "cursor", source: { source: "local", path: "./plugins/cursor" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: three
  });
  write(".opencode/catalog.json", { name: "agent-bridges", plugins: four });
  writePluginManifests(write, ["opencode", "gemini", "claude", "cursor"]);
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("claude marketplace")));
});

test("claude marketplace must list cursor and must not list claude", () => {
  const { root, write } = createFixture();
  const cursorPlugins = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" },
    { name: "claude", source: "./plugins/claude" }
  ];
  write(".claude-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: cursorPlugins
  });
  write(".agents/plugins/marketplace.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: { source: "local", path: "./plugins/opencode" } },
      { name: "gemini", source: { source: "local", path: "./plugins/gemini" } },
      { name: "claude", source: { source: "local", path: "./plugins/claude" } },
      { name: "cursor", source: { source: "local", path: "./plugins/cursor" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: cursorPlugins
  });
  write(".opencode/catalog.json", {
    name: "agent-bridges",
    plugins: [...cursorPlugins, { name: "cursor", source: "./plugins/cursor" }]
  });
  writePluginManifests(write, ["opencode", "gemini", "claude", "cursor"]);
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("claude marketplace")));
});

test("extra plugin name in catalog fails validation", () => {
  const { root, write } = createFixture();
  const three = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" },
    { name: "claude", source: "./plugins/claude" }
  ];
  write(".claude-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: [
      { name: "opencode", source: "./plugins/opencode" },
      { name: "pathfinder", source: "./plugins/pathfinder" },
      { name: "cursor", source: "./plugins/cursor" }
    ]
  });
  write(".agents/plugins/marketplace.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: { source: "local", path: "./plugins/opencode" } },
      { name: "gemini", source: { source: "local", path: "./plugins/gemini" } },
      { name: "claude", source: { source: "local", path: "./plugins/claude" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: three
  });
  write(".opencode/catalog.json", { name: "agent-bridges", plugins: three });
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("pathfinder") && e.includes("not allowed")));
});

test("duplicate plugin name in catalog fails validation", () => {
  const { root, write } = createFixture();
  const three = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" },
    { name: "claude", source: "./plugins/claude" }
  ];
  write(".claude-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: [
      { name: "opencode", source: "./plugins/opencode" },
      { name: "opencode", source: "./plugins/opencode" },
      { name: "cursor", source: "./plugins/cursor" }
    ]
  });
  write(".agents/plugins/marketplace.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: { source: "local", path: "./plugins/opencode" } },
      { name: "gemini", source: { source: "local", path: "./plugins/gemini" } },
      { name: "claude", source: { source: "local", path: "./plugins/claude" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: three
  });
  write(".opencode/catalog.json", { name: "agent-bridges", plugins: three });
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("claude marketplace") && e.includes("opencode") && e.includes("gemini")));
});

test("wrong catalog name fails validation", () => {
  const { root, write } = createFixture();
  const two = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" }
  ];
  const three = [...two, { name: "claude", source: "./plugins/claude" }];
  write(".claude-plugin/marketplace.json", {
    name: "wrong-name",
    owner: { name: "mubeda" },
    plugins: two
  });
  write(".agents/plugins/marketplace.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: { source: "local", path: "./plugins/opencode" } },
      { name: "gemini", source: { source: "local", path: "./plugins/gemini" } },
      { name: "claude", source: { source: "local", path: "./plugins/claude" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", { name: "agent-bridges", owner: { name: "mubeda" }, plugins: three });
  write(".opencode/catalog.json", { name: "agent-bridges", plugins: three });
  writePluginManifests(write, ["opencode", "gemini", "claude"]);
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("wrong-name") && e.includes("agent-bridges")));
});

test("cursor marketplace accepts pluginRoot sources", () => {
  const { root, write } = createFixture();
  const claudePlugins = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" },
    { name: "cursor", source: "./plugins/cursor" },
    { name: "antigravity", source: "./plugins/antigravity" }
  ];
  const cursorPlugins = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" },
    { name: "claude", source: "./plugins/claude" },
    { name: "antigravity", source: "./plugins/antigravity" }
  ];
  write(".claude-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: claudePlugins
  });
  write(".agents/plugins/marketplace.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: { source: "local", path: "./plugins/opencode" } },
      { name: "gemini", source: { source: "local", path: "./plugins/gemini" } },
      { name: "claude", source: { source: "local", path: "./plugins/claude" } },
      { name: "cursor", source: { source: "local", path: "./plugins/cursor" } },
      { name: "antigravity", source: { source: "local", path: "./plugins/antigravity" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    metadata: { pluginRoot: "plugins", version: "0.1.1" },
    plugins: [
      { name: "opencode", source: "opencode" },
      { name: "gemini", source: "gemini" },
      { name: "claude", source: "claude" },
      { name: "antigravity", source: "antigravity" }
    ]
  });
  write(".opencode/catalog.json", {
    name: "agent-bridges",
    plugins: [...cursorPlugins, { name: "cursor", source: "./plugins/cursor" }]
  });
  writePluginManifests(write, ["opencode", "gemini", "claude", "cursor", "antigravity"]);
  const result = validateMarketplaceRepo(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("this repo validates once catalogs exist", () => {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const result = validateMarketplaceRepo(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

function validFiveFixture() {
  const { root, write } = createFixture();
  const local = (name) => ({ name, source: { source: "local", path: `./plugins/${name}` } });
  const rel = (name) => ({ name, source: `./plugins/${name}` });
  const catalogs = {
    ".claude-plugin/marketplace.json": { name: "agent-bridges", owner: { name: "mubeda" }, plugins: ["opencode", "gemini", "cursor", "antigravity"].map(rel) },
    ".agents/plugins/marketplace.json": { name: "agent-bridges", plugins: ["opencode", "gemini", "claude", "cursor", "antigravity"].map(local) },
    ".cursor-plugin/marketplace.json": { name: "agent-bridges", owner: { name: "mubeda" }, plugins: ["opencode", "gemini", "claude", "antigravity"].map(rel) },
    ".opencode/catalog.json": { name: "agent-bridges", plugins: ["opencode", "gemini", "claude", "cursor", "antigravity"].map(rel) }
  };
  const save = () => {
    for (const [file, body] of Object.entries(catalogs)) write(file, body);
    writePluginManifests(write, ["opencode", "gemini", "claude", "cursor", "antigravity"]);
  };
  return { root, catalogs, save };
}

test("a five-plugin fixture passes", () => {
  const fixture = validFiveFixture();
  fixture.save();
  assert.deepEqual(validateMarketplaceRepo(fixture.root).errors, []);
});

test("cursor marketplace without antigravity fails and names it", () => {
  const fixture = validFiveFixture();
  const cursor = fixture.catalogs[".cursor-plugin/marketplace.json"];
  cursor.plugins = cursor.plugins.filter((plugin) => plugin.name !== "antigravity");
  fixture.save();
  const result = validateMarketplaceRepo(fixture.root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("cursor marketplace") && e.includes("antigravity")), result.errors.join("; "));
});

test("a malformed source at the five-plugin count is reported", () => {
  const fixture = validFiveFixture();
  fixture.catalogs[".opencode/catalog.json"].plugins[4] = { name: "antigravity", source: "antigravity" };
  fixture.save();
  const result = validateMarketplaceRepo(fixture.root);
  assert.ok(result.errors.some((e) => e.includes("opencode plugin antigravity source")), result.errors.join("; "));
});

test("a null catalog entry is an error, not a crash", () => {
  const fixture = validFiveFixture();
  fixture.catalogs[".claude-plugin/marketplace.json"].plugins.push(null);
  fixture.save();
  const result = validateMarketplaceRepo(fixture.root);
  assert.ok(result.errors.some((e) => e.includes("claude marketplace entry 4 is not an object")), result.errors.join("; "));
});

test("a catalog file containing null is an error", () => {
  const fixture = validFiveFixture();
  fixture.save();
  fs.writeFileSync(path.join(fixture.root, ".cursor-plugin", "marketplace.json"), "null\n");
  const result = validateMarketplaceRepo(fixture.root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes(".cursor-plugin/marketplace.json")), result.errors.join("; "));
});
