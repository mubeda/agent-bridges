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
  const two = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" }
  ];
  const three = [...two, { name: "claude", source: "./plugins/claude" }];
  write(".claude-plugin/marketplace.json", {
    name: "agent-bridges",
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
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: three
  });
  write(".opencode/catalog.json", {
    name: "agent-bridges",
    plugins: three
  });
  writePluginManifests(write, ["opencode", "gemini", "claude"]);
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
      { name: "claude", source: { source: "local", path: "./plugins/claude" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: three
  });
  write(".opencode/catalog.json", { name: "agent-bridges", plugins: three });
  writePluginManifests(write, ["opencode", "gemini", "claude"]);
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("claude marketplace") && e.includes("exactly")));
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
      { name: "pathfinder", source: "./plugins/pathfinder" }
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
      { name: "opencode", source: "./plugins/opencode" }
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

test("this repo validates once catalogs exist", () => {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const result = validateMarketplaceRepo(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});
