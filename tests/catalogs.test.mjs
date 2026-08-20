import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CATALOG_NAME, validateMarketplaceRepo } from "../scripts/lib/catalogs.mjs";

test("CATALOG_NAME is agent-bridges", () => {
  assert.equal(CATALOG_NAME, "agent-bridges");
});

test("empty directory fails validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridges-catalog-"));
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes(".claude-plugin/marketplace.json")));
});

test("fixture with catalogs and plugin manifests passes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridges-catalog-"));
  const write = (rel, obj) => {
    const full = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(obj, null, 2)}\n`);
  };
  write(".claude-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: [
      { name: "opencode", source: "./plugins/opencode" },
      { name: "gemini", source: "./plugins/gemini" }
    ]
  });
  write(".agents/plugins/marketplace.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: { source: "local", path: "./plugins/opencode" } },
      { name: "gemini", source: { source: "local", path: "./plugins/gemini" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: [
      { name: "opencode", source: "./plugins/opencode" },
      { name: "gemini", source: "./plugins/gemini" }
    ]
  });
  write(".opencode/catalog.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: "./plugins/opencode" },
      { name: "gemini", source: "./plugins/gemini" }
    ]
  });
  for (const name of ["opencode", "gemini"]) {
    write(`plugins/${name}/.claude-plugin/plugin.json`, { name });
    write(`plugins/${name}/.codex-plugin/plugin.json`, { name, skills: "./skills/" });
    write(`plugins/${name}/.cursor-plugin/plugin.json`, { name });
  }
  const result = validateMarketplaceRepo(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("extra plugin name in catalog fails validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridges-catalog-"));
  const write = (rel, obj) => {
    const full = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(obj, null, 2)}\n`);
  };
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
      { name: "gemini", source: { source: "local", path: "./plugins/gemini" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: [
      { name: "opencode", source: "./plugins/opencode" },
      { name: "gemini", source: "./plugins/gemini" }
    ]
  });
  write(".opencode/catalog.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: "./plugins/opencode" },
      { name: "gemini", source: "./plugins/gemini" }
    ]
  });
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("pathfinder") && e.includes("not allowed")));
});

test("duplicate plugin name in catalog fails validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridges-catalog-"));
  const write = (rel, obj) => {
    const full = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(obj, null, 2)}\n`);
  };
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
      { name: "gemini", source: { source: "local", path: "./plugins/gemini" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: [
      { name: "opencode", source: "./plugins/opencode" },
      { name: "gemini", source: "./plugins/gemini" }
    ]
  });
  write(".opencode/catalog.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: "./plugins/opencode" },
      { name: "gemini", source: "./plugins/gemini" }
    ]
  });
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("claude marketplace") && e.includes("opencode") && e.includes("gemini")));
});

test("wrong catalog name fails validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridges-catalog-"));
  const write = (rel, obj) => {
    const full = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(obj, null, 2)}\n`);
  };
  const plugins = [
    { name: "opencode", source: "./plugins/opencode" },
    { name: "gemini", source: "./plugins/gemini" }
  ];
  write(".claude-plugin/marketplace.json", {
    name: "wrong-name",
    owner: { name: "mubeda" },
    plugins
  });
  write(".agents/plugins/marketplace.json", {
    name: "agent-bridges",
    plugins: [
      { name: "opencode", source: { source: "local", path: "./plugins/opencode" } },
      { name: "gemini", source: { source: "local", path: "./plugins/gemini" } }
    ]
  });
  write(".cursor-plugin/marketplace.json", { name: "agent-bridges", owner: { name: "mubeda" }, plugins });
  write(".opencode/catalog.json", { name: "agent-bridges", plugins });
  for (const name of ["opencode", "gemini"]) {
    write(`plugins/${name}/.claude-plugin/plugin.json`, { name });
    write(`plugins/${name}/.codex-plugin/plugin.json`, { name, skills: "./skills/" });
    write(`plugins/${name}/.cursor-plugin/plugin.json`, { name });
  }
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
