# Cursor Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `cursor` companion plugin that runs the local Cursor Agent CLI (`agent`) from Claude Code, Codex CLI, and OpenCode with the same command surface as the Claude companion.

**Architecture:** Clone `plugins/claude` into `plugins/cursor` and replace the Claude CLI layer with `agent` argv/JSON parsing. Do not extract a shared framework. Do not list the plugin on the Cursor marketplace. Detach print-mode processes for background jobs (Cursor has no `--bg`).

**Tech Stack:** Node.js >= 18.18 ESM, `node:test`, existing companion libs copied into `plugins/cursor/scripts/lib/`, Cursor Agent CLI (`agent`).

**Spec:** `docs/superpowers/specs/2026-08-21-cursor-companion-design.md`

## Global Constraints

- Binary is `agent`, override `CURSOR_BIN`. Auth is `CURSOR_API_KEY` or `agent status` / `agent whoami` exit 0.
- Review/read-only: `agent -p --mode plan --output-format json --trust` and never `--force`.
- Rescue `--write` (the default): add `--force`. Reject `--effort` with an error.
- Resume uses JSON `session_id` → `--resume <id>`. Parse `{ type, subtype, result, session_id }`.
- State fallback is `~/.cursor-companion/state`.
- Hosts: Claude Code, Codex, OpenCode. Not Cursor-host.
- After the plugin exists, bump marketplace/catalog versions in the same change set: Claude `metadata.version` `0.1.0` → `0.2.0`, Cursor `metadata.version` `0.1.1` → `0.1.2`, Codex and OpenCode catalogs add top-level `version` `0.2.0`.
- Do not `git commit` unless the user explicitly asks. Skip commit steps.
- Run tests with `node --test tests/<file>.test.mjs` or `node scripts/run-tests.mjs`.

## File map

**Create**

- `plugins/cursor/` tree (companion, libs, commands, skills, agents, prompts, schemas, manifests, CHANGELOG, LICENSE, NOTICE, package.json)
- `tests/cursor-args.test.mjs`
- `tests/cursor-backend.test.mjs`
- `tests/cursor-jobs.test.mjs`

**Modify**

- `scripts/lib/catalogs.mjs` — allowed plugin name sets
- `tests/catalogs.test.mjs` — fixtures for 3 Claude-host plugins and 4 Codex/OpenCode plugins
- `scripts/lib/opencode-install.mjs` — `PLUGINS` set includes `cursor`
- `tests/install-opencode.test.mjs` — `--plugin cursor`, install-all copies cursor
- `tests/copy-plugins.test.mjs` — cursor tree present
- `tests/state.test.mjs` — `~/.cursor-companion/state`
- `tests/readme.test.mjs` and `README.md`
- `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.opencode/catalog.json`, `.cursor-plugin/marketplace.json` (version bump even though plugin list unchanged)

---

### Task 1: Catalog name sets

**Files:**
- Modify: `scripts/lib/catalogs.mjs`
- Modify: `tests/catalogs.test.mjs`
- Test: `tests/catalogs.test.mjs`

**Interfaces:**
- Consumes: existing `requireAllowedPlugins(catalog, label, errors, requiredNames)`
- Produces: `CLAUDE_HOST_PLUGIN_NAMES = ["opencode", "gemini", "cursor"]`, `CODEX_OPENCODE_PLUGIN_NAMES = ["opencode", "gemini", "claude", "cursor"]`, `CURSOR_HOST_PLUGIN_NAMES = ["opencode", "gemini", "claude"]`, `PLUGIN_TREES` includes `"cursor"`

- [ ] **Step 1: Write the failing catalog fixture test**

In `tests/catalogs.test.mjs`, change `"fixture with catalogs and plugin manifests passes"` so Claude lists three (`opencode`, `gemini`, `cursor`) with `./plugins/...` sources, Codex/OpenCode list four including `claude` and `cursor`, Cursor host still lists `opencode`, `gemini`, `claude` only, and `writePluginManifests` includes `"cursor"`. Keep `"claude marketplace must not list the claude plugin"` as a Claude catalog that includes `claude` (still must fail). Update `"cursor marketplace accepts pluginRoot sources"` Codex/OpenCode arrays to four plugins.

Add:

```js
test("claude marketplace must list cursor and must not list claude", () => {
  const { root, write } = createFixture();
  write(".claude-plugin/marketplace.json", {
    name: "agent-bridges",
    owner: { name: "mubeda" },
    plugins: [
      { name: "opencode", source: "./plugins/opencode" },
      { name: "gemini", source: "./plugins/gemini" },
      { name: "claude", source: "./plugins/claude" }
    ]
  });
  // ...valid Codex (4), Cursor (3 without cursor), OpenCode (4) catalogs + manifests...
  const result = validateMarketplaceRepo(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("claude marketplace")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/catalogs.test.mjs`

Expected: FAIL because `CLAUDE_HOST_PLUGIN_NAMES` is still `["opencode", "gemini"]` and OTHER_HOST is still three names. The real repo test `"this repo validates once catalogs exist"` still passes until later tasks change live catalogs.

- [ ] **Step 3: Update `scripts/lib/catalogs.mjs`**

```js
export const CLAUDE_HOST_PLUGIN_NAMES = ["opencode", "gemini", "cursor"];
export const CODEX_OPENCODE_PLUGIN_NAMES = ["opencode", "gemini", "claude", "cursor"];
export const CURSOR_HOST_PLUGIN_NAMES = ["opencode", "gemini", "claude"];
export const PLUGIN_TREES = ["opencode", "gemini", "claude", "cursor"];
```

Use `CLAUDE_HOST_PLUGIN_NAMES` for `.claude-plugin/marketplace.json`, `CODEX_OPENCODE_PLUGIN_NAMES` for Codex and OpenCode, `CURSOR_HOST_PLUGIN_NAMES` for `.cursor-plugin/marketplace.json`. Delete `OTHER_HOST_PLUGIN_NAMES` or keep it as an alias of `CURSOR_HOST_PLUGIN_NAMES` only if tests import it (they currently do not).

Claude source check stays `./plugins/${name}`. Codex `source.path` stays `./plugins/${name}`. Cursor `pluginRoot` / `./plugins/` check unchanged. OpenCode source stays `./plugins/${name}`. Loop `PLUGIN_TREES` still requires `.claude-plugin`, `.codex-plugin`, `.cursor-plugin` JSON for each tree including `cursor`.

- [ ] **Step 4: Run catalog tests**

Run: `node --test tests/catalogs.test.mjs`

Expected: fixture tests PASS. `"this repo validates once catalogs exist"` FAIL until Task 7 writes live catalogs and `plugins/cursor` manifests — that is expected. Leave that failure until Task 7, or skip implementing live catalogs until then. Do not weaken the real-repo test.

---

### Task 2: `agent` argv builder

**Files:**
- Create: `plugins/cursor/scripts/lib/cursor.mjs` (argv + bin resolve only in this task)
- Test: `tests/cursor-args.test.mjs`

**Interfaces:**
- Consumes: none
- Produces: `resolveCursorBin(env)`, `shouldPassPromptViaStdin(prompt, platform)`, `WIN32_ARGV_PROMPT_LIMIT = 20_000`, `buildRunArgs(options)`, `buildReviewArgs(options)`

`buildRunArgs(options)` options: `{ prompt, invoke: "print"|"bg", write, review, model, resumeSessionId, resumeLatest, effort, platform, promptFile }`. `prompt` required non-empty string.

- [ ] **Step 1: Write `tests/cursor-args.test.mjs`**

```js
import assert from "node:assert/strict";
import {
  WIN32_ARGV_PROMPT_LIMIT,
  buildRunArgs,
  buildReviewArgs,
  resolveCursorBin,
  shouldPassPromptViaStdin
} from "../plugins/cursor/scripts/lib/cursor.mjs";

test("resolveCursorBin prefers CURSOR_BIN", () => {
  assert.equal(resolveCursorBin({ CURSOR_BIN: "C:\\tools\\agent.exe" }), "C:\\tools\\agent.exe");
  assert.equal(resolveCursorBin({}), "agent");
});

test("review wait uses plan, json, trust, and no force", () => {
  const args = buildReviewArgs({ prompt: "review", invoke: "print" });
  assert.ok(args.includes("-p"));
  assert.equal(args[args.indexOf("--mode") + 1], "plan");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.ok(args.includes("--trust"));
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--yolo"), false);
});

test("review ignores write overrides", () => {
  const args = buildReviewArgs({ prompt: "review", invoke: "print", write: true });
  assert.equal(args.includes("--force"), false);
  assert.equal(args[args.indexOf("--mode") + 1], "plan");
});

test("rescue write uses force and not plan", () => {
  const args = buildRunArgs({ prompt: "fix it", invoke: "print", write: true });
  assert.ok(args.includes("--force"));
  assert.ok(args.includes("-p"));
  assert.equal(args.includes("--mode"), false);
});

test("rescue without write uses plan", () => {
  const args = buildRunArgs({ prompt: "diagnose", invoke: "print", write: false });
  assert.equal(args[args.indexOf("--mode") + 1], "plan");
  assert.equal(args.includes("--force"), false);
});

test("background is still print-mode (no --bg)", () => {
  const args = buildRunArgs({ prompt: "fix it", invoke: "bg", write: true });
  assert.ok(args.includes("-p"));
  assert.equal(args.includes("--bg"), false);
  assert.ok(args.includes("--force"));
});

test("resume uses --resume", () => {
  const args = buildRunArgs({ prompt: "go", invoke: "print", resumeSessionId: "abc" });
  assert.equal(args[args.indexOf("--resume") + 1], "abc");
});

test("model passes through and effort throws", () => {
  const args = buildRunArgs({ prompt: "go", invoke: "print", model: "composer-2.5" });
  assert.equal(args[args.indexOf("--model") + 1], "composer-2.5");
  assert.throws(
    () => buildRunArgs({ prompt: "go", invoke: "print", effort: "high" }),
    /effort/
  );
});

test("win32 long prompt is omitted from argv", () => {
  const prompt = "x".repeat(WIN32_ARGV_PROMPT_LIMIT + 1);
  assert.equal(shouldPassPromptViaStdin(prompt, "win32"), true);
  const args = buildRunArgs({ prompt, invoke: "print", platform: "win32" });
  assert.equal(args.includes(prompt), false);
  assert.ok(args.includes("-p"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cursor-args.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `plugins/cursor/scripts/lib/cursor.mjs`.

- [ ] **Step 3: Implement argv helpers in `plugins/cursor/scripts/lib/cursor.mjs`**

Follow `plugins/claude/scripts/lib/claude.mjs` `shouldPassPromptViaStdin` / `WIN32_ARGV_PROMPT_LIMIT`. Differences from Claude:

```js
export function resolveCursorBin(env = process.env) {
  const override = typeof env.CURSOR_BIN === "string" ? env.CURSOR_BIN.trim() : "";
  return override || "agent";
}

export function buildRunArgs(options = {}) {
  const prompt = options.prompt;
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("buildRunArgs: a non-empty prompt is required.");
  }
  if (options.effort) {
    throw new Error("Cursor Agent CLI has no --effort flag; omit --effort.");
  }
  const review = options.review === true;
  const write = review ? false : options.write === true;
  const args = [];
  if (!write) {
    args.push("--mode", "plan");
  } else {
    args.push("--force");
  }
  args.push("--trust");
  if (options.model) args.push("--model", String(options.model));
  if (options.resumeSessionId) args.push("--resume", String(options.resumeSessionId));
  args.push("--output-format", "json");
  args.push("-p");
  const platform = options.platform ?? process.platform;
  if (!shouldPassPromptViaStdin(prompt, platform)) args.push(prompt);
  return args;
}

export function buildReviewArgs(options = {}) {
  return buildRunArgs({ ...options, write: false, review: true });
}
```

Background (`invoke: "bg"`) uses the same argv as print; the companion detaches the process later. `resumeLatest` is unused in v1 (no `agent -c` equivalent unless you confirm `agent resume` with no id; do not invent a flag).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cursor-args.test.mjs`

Expected: PASS

---

### Task 3: Availability and auth

**Files:**
- Modify: `plugins/cursor/scripts/lib/cursor.mjs`
- Test: `tests/cursor-backend.test.mjs`

**Interfaces:**
- Consumes: `resolveCursorBin`, `binaryAvailable` / `runCommand` from a copied `plugins/cursor/scripts/lib/process.mjs` (copy `plugins/claude/scripts/lib/process.mjs` unchanged in this task)
- Produces: `getCursorAvailability(cwd, env)`, `getCursorAuthStatus(cwd, env)` returning `{ available, loggedIn, bin, detail }`

- [ ] **Step 1: Copy `process.mjs` and write `tests/cursor-backend.test.mjs`**

Copy `plugins/claude/scripts/lib/process.mjs` to `plugins/cursor/scripts/lib/process.mjs`.

```js
import assert from "node:assert/strict";
import { getCursorAuthStatus, getCursorAvailability, resolveCursorBin } from "../plugins/cursor/scripts/lib/cursor.mjs";

test("missing binary includes install hint", () => {
  const status = getCursorAvailability("/tmp", { CURSOR_BIN: "cursor-agent-does-not-exist-xyz" });
  assert.equal(status.available, false);
  assert.match(status.detail, /cursor.com\/install|CURSOR_BIN|agent/);
});

test("CURSOR_API_KEY counts as logged in when binary exists", () => {
  // mock by testing the pure branch: if you keep getCursorAuthStatus reading env first
});
```

Implement auth so it does not need a real `agent` binary when `CURSOR_API_KEY` is set **and** availability was already true. Split: `getCursorAuthStatus` if `!availability.available` → `{ loggedIn: false, detail: availability.detail }`. Else if `env.CURSOR_API_KEY?.trim()` → `{ loggedIn: true, detail: "CURSOR_API_KEY is set." }`. Else run `agent status` (or `whoami`); exit 0 → logged in.

For the missing-binary test, pass a nonsense `CURSOR_BIN`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cursor-backend.test.mjs`

Expected: FAIL until `getCursorAvailability` / `getCursorAuthStatus` exist.

- [ ] **Step 3: Implement availability/auth in `cursor.mjs`**

Missing-bin detail: `` `agent` was not found on PATH. Install Cursor CLI from https://cursor.com/docs/cli/installation then rerun setup. Optional: set CURSOR_BIN. ``

Use `binaryAvailable(bin, ["--version"], { cwd })` from `./process.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cursor-backend.test.mjs tests/cursor-args.test.mjs`

Expected: PASS

---

### Task 4: JSON result parse

**Files:**
- Modify: `plugins/cursor/scripts/lib/cursor.mjs`
- Test: `tests/cursor-jobs.test.mjs`

**Interfaces:**
- Produces: `parsePrintResult(stdout)` → `{ sessionId, resultText, raw }`

- [ ] **Step 1: Write `tests/cursor-jobs.test.mjs`**

```js
import assert from "node:assert/strict";
import { parsePrintResult } from "../plugins/cursor/scripts/lib/cursor.mjs";

test("parsePrintResult reads session_id and result", () => {
  const parsed = parsePrintResult(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "looks fine",
    session_id: "c6b62c6f-7ead-4fd6-9922-e952131177ff"
  }));
  assert.equal(parsed.sessionId, "c6b62c6f-7ead-4fd6-9922-e952131177ff");
  assert.equal(parsed.resultText, "looks fine");
});

test("parsePrintResult ignores leading noise then reads JSON", () => {
  const parsed = parsePrintResult("warn\n{\"result\":\"ok\",\"session_id\":\"abc\"}");
  assert.equal(parsed.sessionId, "abc");
  assert.equal(parsed.resultText, "ok");
});

test("parsePrintResult returns text when JSON is missing", () => {
  const parsed = parsePrintResult("not json");
  assert.equal(parsed.sessionId, null);
  assert.equal(parsed.resultText, "not json");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cursor-jobs.test.mjs`

Expected: FAIL `parsePrintResult is not a function` (or similar).

- [ ] **Step 3: Implement `parsePrintResult`**

Copy the slice-from-first-`{` logic from `plugins/claude/scripts/lib/claude.mjs` `parsePrintResult`. Read `session_id` / `sessionId` and string `result`. No `structured_output` required in v1.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cursor-jobs.test.mjs`

Expected: PASS

---

### Task 5: Companion runtime clone

**Files:**
- Create: remaining `plugins/cursor/scripts/lib/*.mjs` copied from Claude, then specialized
- Create: `plugins/cursor/scripts/cursor-companion.mjs`
- Create: `plugins/cursor/package.json`, `LICENSE`, `NOTICE`, `schemas/review-output.schema.json`, `prompts/adversarial-review.md`
- Modify: `plugins/cursor/scripts/lib/state.mjs` `PLUGIN_NAME = "cursor"` and default dir `.cursor-companion`
- Modify: `tests/state.test.mjs`

**Interfaces:**
- Consumes: `buildRunArgs`, `parsePrintResult`, `getCursorAvailability`, `getCursorAuthStatus`, `resolveCursorBin`
- Produces: CLI subcommands `setup`, `review`, `adversarial-review`, `task` (rescue), `status`, `result`, `cancel`, `transfer` matching `plugins/claude/scripts/claude-companion.mjs` usage strings but with `cursor-companion.mjs` and no `--effort`

- [ ] **Step 1: Extend `tests/state.test.mjs`**

```js
import { resolveStateRoot as resolveCursorStateRoot } from "../plugins/cursor/scripts/lib/state.mjs";

// inside "default state roots are companion dirs":
assert.equal(resolveCursorStateRoot(env), path.join(os.homedir(), ".cursor-companion", "state"));
```

Also assert `PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA` for the cursor resolver like the others.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/state.test.mjs`

Expected: FAIL module not found for cursor `state.mjs`.

- [ ] **Step 3: Copy Claude libs and companion; specialize**

Copy from `plugins/claude/scripts/lib/` into `plugins/cursor/scripts/lib/`: `args.mjs`, `state.mjs`, `git.mjs`, `detach.mjs`, `host-session.mjs`, `transfer-dest.mjs`, `workspace.mjs`, `tracked-jobs.mjs`, `prompts.mjs`, `render.mjs`, `fs.mjs` (keep existing `process.mjs` / `cursor.mjs`).

In `state.mjs` set `PLUGIN_NAME = "cursor"` and add a `.cursor-companion` branch next to `.claude-companion`.

Copy `claude-companion.mjs` to `cursor-companion.mjs`. Replace every `claude` binary helper import with `cursor.mjs` names. Remove `--effort` from usage and `parseArgs`. Remove `getBypassDisclaimerStatus` / `claude agents --json` refresh; background jobs are detached print-mode processes whose status comes from the pid / job file like OpenCode/Gemini, not `claude --bg`. Use OpenCode's detach path as the model if Claude's `--bg` path does not map: read `plugins/opencode/scripts/opencode-companion.mjs` background enqueue and copy that control flow, still spawning `agent` via `buildRunArgs`.

Copy `plugins/claude/schemas/review-output.schema.json` and `prompts/adversarial-review.md` (swap “Claude” wording for “Cursor Agent”). `package.json` name `@mubeda/cursor-plugin-cc-runtime`. Copy LICENSE/NOTICE and adjust names.

Setup report: binary, version (`agent --version`), auth, state dir. No review-gate flags.

- [ ] **Step 4: Run tests**

Run: `node --test tests/state.test.mjs tests/cursor-args.test.mjs tests/cursor-backend.test.mjs tests/cursor-jobs.test.mjs`

Expected: PASS

---

### Task 6: Commands, skills, agents, manifests

**Files:**
- Create: `plugins/cursor/commands/*.md` from `plugins/opencode/commands/` (those have Claude Code slash commands; Claude plugin has none)
- Create: `plugins/cursor/skills/cursor-*/SKILL.md` from `plugins/claude/skills/` with names/paths rewritten
- Create: `plugins/cursor/agents/cursor-rescue.md`
- Create: `plugins/cursor/.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`
- Create: `plugins/cursor/CHANGELOG.md` `0.1.0`
- Test: `tests/copy-plugins.test.mjs`, `tests/markdown-lookup.test.mjs` if they pin plugin names

**Interfaces:**
- Produces: `/cursor:review` etc. for Claude Code; skills `cursor-review` … `cursor-transfer`, `cursor-cli-runtime`, `cursor-prompting`

- [ ] **Step 1: Add a copy-plugins assertion that fails**

In `tests/copy-plugins.test.mjs`:

```js
test("cursor plugin tree is present", () => {
  assert.equal(
    fs.existsSync(path.join(root, "plugins/cursor/scripts/cursor-companion.mjs")),
    true
  );
  assert.equal(fs.existsSync(path.join(root, "plugins/cursor/commands/review.md")), true);
  assert.equal(fs.existsSync(path.join(root, "plugins/cursor/skills/cursor-review/SKILL.md")), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/copy-plugins.test.mjs`

Expected: FAIL until commands/skills exist.

- [ ] **Step 3: Create commands and skills**

Commands: copy `plugins/opencode/commands/{setup,review,adversarial-review,rescue,status,result,cancel,transfer}.md` and replace OpenCode/`opencode-companion.mjs` with Cursor/`cursor-companion.mjs`, `/opencode:` with `/cursor:`. **Do not** copy review-gate flags from setup.

Skills: copy `plugins/claude/skills/*` renaming `claude-` → `cursor-` and `claude-companion.mjs` → `cursor-companion.mjs`. Plugin-root lookup includes `~/.cursor/plugins/local/cursor` and `~/.config/opencode/plugins/cursor`.

`.claude-plugin/plugin.json`: `{ "name": "cursor", "version": "0.1.0", "description": "Use the local Cursor Agent CLI to review code or delegate tasks.", "author": { "name": "mubeda" } }` — no `hooks` key.

`.codex-plugin/plugin.json`: same pattern as Claude’s, `displayName: "Cursor"`, `skills: "./skills/"`.

`.cursor-plugin/plugin.json`: `{ "name": "cursor", "displayName": "Cursor", "version": "0.1.0", ... }` even though the Cursor marketplace will not list it.

- [ ] **Step 4: Run tests**

Run: `node --test tests/copy-plugins.test.mjs tests/markdown-lookup.test.mjs`

Expected: PASS (update markdown-lookup if it enumerates plugins)

---

### Task 7: Live catalogs, installer, README, marketplace versions

**Files:**
- Modify: `.claude-plugin/marketplace.json` — add `cursor` entry version `0.1.0`; set `metadata.version` to `0.2.0`; update `metadata.description` to mention Cursor Agent
- Modify: `.agents/plugins/marketplace.json` — add `cursor` source path; set top-level `"version": "0.2.0"`
- Modify: `.opencode/catalog.json` — add `{ "name": "cursor", "source": "./plugins/cursor", "companion": "scripts/cursor-companion.mjs" }`; set `"version": "0.2.0"`
- Modify: `.cursor-plugin/marketplace.json` — **do not add `cursor` to `plugins`**; set `metadata.version` to `0.1.2`
- Modify: `scripts/lib/opencode-install.mjs` `PLUGINS` add `"cursor"`
- Modify: `tests/install-opencode.test.mjs` — `parseInstallArgs accepts cursor plugin`; install-all copies cursor tree
- Modify: `README.md` and `tests/readme.test.mjs`

**Interfaces:**
- Consumes: Task 1 name sets and Task 6 `plugins/cursor` tree
- Produces: installable `cursor@agent-bridges` on Claude/Codex/OpenCode; bumped catalog versions

- [ ] **Step 1: Write failing README/install assertions**

README tests: match `cursor@agent-bridges`, `/plugin install cursor@agent-bridges`, `codex plugin add cursor@agent-bridges`, `CURSOR_BIN` or `agent login`, `~/.cursor-companion`.

Install test:

```js
test("parseInstallArgs accepts cursor plugin", () => {
  assert.equal(parseInstallArgs(["--plugin", "cursor"]).plugin, "cursor");
});
```

Extend `"installing all plugins copies the Claude plugin tree without commands"` or add: after `--plugin all`, `plugins/cursor/scripts/cursor-companion.mjs` exists in the dest tree.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/readme.test.mjs tests/install-opencode.test.mjs tests/catalogs.test.mjs`

Expected: FAIL on missing README strings, installer rejecting `cursor`, real-repo catalog missing `cursor` / `plugins/cursor` manifests.

- [ ] **Step 3: Apply catalog, installer, and README edits**

Claude marketplace plugins: `opencode`, `gemini`, `cursor` only. Cursor marketplace plugins unchanged. Codex and OpenCode include all four.

Installer: `const PLUGINS = new Set(["opencode", "gemini", "claude", "cursor", "all"]);`

README: four companions in the table; Claude Code install includes `cursor@agent-bridges`; Codex add line; OpenCode `--plugin all` includes cursor; new section for Cursor Agent CLI (`agent`, `CURSOR_API_KEY` / `agent login`, plan vs `--force`). State dirs list `~/.cursor-companion/state`.

**Marketplace versions (do not skip):**

```json
// .claude-plugin/marketplace.json
"metadata": { "version": "0.2.0", ... }

// .cursor-plugin/marketplace.json
"metadata": { "version": "0.1.2", "pluginRoot": "plugins", ... }

// .agents/plugins/marketplace.json
{ "name": "agent-bridges", "version": "0.2.0", "interface": { ... }, "plugins": [ ... cursor ... ] }

// .opencode/catalog.json
{ "name": "agent-bridges", "version": "0.2.0", "plugins": [ ... cursor ... ] }
```

- [ ] **Step 4: Run the full suite**

Run: `node scripts/run-tests.mjs` and `node scripts/validate-catalogs.mjs`

Expected: all tests PASS, catalog validator exit 0.

Confirm by reading the four catalog files: Claude `metadata.version` is `0.2.0`, Cursor `metadata.version` is `0.1.2`, Codex and OpenCode top-level `version` are `0.2.0`.

---

## Spec coverage

| Spec section | Task |
|---|---|
| Hosts and catalogs | 1, 7 |
| Layout / commands / skills | 5, 6 |
| CLI mapping | 2, 3 |
| JSON session_id | 4 |
| Jobs / `~/.cursor-companion` | 5 |
| Transfer handoff | 5 (companion clone) |
| Setup | 5, 6 |
| Tests listed in spec | 2–7 |
| Docs | 7 |
| Marketplace versions | 7 |

## Placeholder / consistency check

No TBD. `buildRunArgs` / `parsePrintResult` / catalog name constants are the same across tasks. `--effort` is rejected in Task 2 and omitted from the companion in Task 5. Cursor-host marketplace never gains a `cursor` plugin entry; only its `metadata.version` changes.
