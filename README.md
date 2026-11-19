# Agent Bridges

Catalog of five companion plugins — **OpenCode**, **Gemini**, **Claude**, **Cursor Agent**, and **Antigravity** — for Claude Code, Codex CLI, Cursor, and OpenCode.

Repository: https://github.com/mubeda/agent-bridges

License: Apache-2.0

Install plugins with the catalog id `@agent-bridges`.

## Plugins

| Plugin | What it does |
|---|---|
| `opencode` | Review, rescue, and transfer via the local `opencode` CLI |
| `gemini` | Review, rescue, and transfer via Antigravity (`agy`) or Gemini CLI |
| `claude` | Review, rescue, and transfer via the Claude CLI |
| `cursor` | Review, rescue, and transfer via the Cursor Agent CLI |
| `antigravity` | Review, rescue, transfer, and delegate via the Antigravity CLI (`agy`) |

Each plugin can be installed independently.

## Claude Code

```bash
/plugin marketplace add mubeda/agent-bridges
/plugin install opencode@agent-bridges
/plugin install gemini@agent-bridges
/plugin install cursor@agent-bridges
/plugin install antigravity@agent-bridges
```

Then `/opencode:setup` and `/gemini:setup`.

Optional Claude-only stop review-gate: `/opencode:setup --enable-review-gate` or `/gemini:setup --enable-review-gate` (use `--disable-review-gate` to turn off).

The Claude companion is not for Claude Code and is not listed in the Claude marketplace.

## Codex CLI

```bash
codex plugin marketplace add https://github.com/mubeda/agent-bridges.git
codex plugin add opencode@agent-bridges
codex plugin add gemini@agent-bridges
codex plugin add claude@agent-bridges
codex plugin add cursor@agent-bridges
codex plugin add antigravity@agent-bridges
```

Invoke skills such as `opencode-review`, `gemini-setup`, `claude-review`, `cursor-review`, `opencode-transfer`, `gemini-transfer`, `claude-transfer`, and `cursor-transfer`.

## Cursor

Team marketplace: Dashboard → Plugins → import this GitHub repo.

Local:

```bash
# copy or symlink
# ~/.cursor/plugins/local/opencode  ->  <clone>/plugins/opencode
# ~/.cursor/plugins/local/gemini    ->  <clone>/plugins/gemini
# ~/.cursor/plugins/local/claude    ->  <clone>/plugins/claude
# ~/.cursor/plugins/local/antigravity ->  <clone>/plugins/antigravity
```

Reload the window. OpenCode and Gemini commands come from their `commands/` folders; the Claude companion has no `commands/` folder and exposes skills instead.

## OpenCode

```bash
node scripts/install-opencode.mjs --plugin all --scope user
# one plugin: node scripts/install-opencode.mjs --plugin antigravity --scope user
# project: --scope project --project /path/to/repo
```

Use `--force` to overwrite modified installer-managed files. Use `--uninstall` to remove only the selected plugins' installer-managed files.

Community CLI (optional, not vendored): `opencode-marketplace install <path-to-plugins/opencode>`.

This installer does not add entries to `opencode.json` `"plugin": []`.

## Claude CLI

- `--wait` runs `claude -p --output-format json`; reviews also use `--permission-mode plan` and `--json-schema`.
- `--background` runs `claude --bg`. Jobs may be isolated in `.claude/worktrees/`; reconnect with `claude attach <id>`.
- Rescue `--write` uses `--dangerously-skip-permissions`. Run `claude --dangerously-skip-permissions` once interactively first to acknowledge the bypass disclaimer.
- Claude job state lives under `~/.claude-companion/state`.
- Transfer packs Codex and Cursor transcripts first, then Claude JSONL transcripts last.

## Cursor Agent CLI

- The companion runs the `agent` CLI. Set `CURSOR_BIN` to use a specific executable.
- Authenticate with `CURSOR_API_KEY` or run `agent login`.
- Reviews use plan mode by default; pass `--force` only when the requested operation should write changes.
- Cursor Agent job state lives under `~/.cursor-companion/state`.

## Antigravity CLI

- The companion runs the `agy` CLI. Set `ANTIGRAVITY_BIN` to use a specific executable.
- Sign in once with an interactive `agy` session; headless runs reuse those credentials. For an API key, set `GEMINI_API_KEY` and `modelProvider: "gemini"` in your own Antigravity settings (`~/.gemini/antigravity-cli/settings.json`). Setup cannot check sign-in without a model run, so it reports the binary, its version, and whether `GEMINI_API_KEY` is set.
- Read-only runs (reviews, and rescue without `--write`) pass `--settings` with deny rules for `write_file(*)` and `command(*)`, so `agy` itself blocks file writes and shell commands. `agy --mode plan` is not used: it does not block writes. A future `agy` tool that writes files under another rule name would not be covered, and MCP tools are not denied.
- Write runs (`--write`) use `--dangerously-skip-permissions`.
- Resume continues the stored conversation with `--conversation <id>`. If Antigravity no longer has it, it starts a new one; the result says so and the new id is stored.
- Antigravity job state lives under `~/.antigravity-companion/state`.

## Gemini backends

The Gemini companion prefers **`agy`** (Antigravity CLI) on PATH, then falls back to **`gemini`**.

Override with `GEMINI_BACKEND=agy` or `GEMINI_BACKEND=gemini`. Optional `GEMINI_BIN` points at a specific binary. Read-only runs on the `agy` backend use the same `--settings` deny rules as the Antigravity companion.

## Transfer

All five companions support `transfer`: move the current host session (Claude, Codex, or Cursor — auto-detected, or `--source <path>`) into a resumable OpenCode or Gemini thread, or send a prompt handoff into Claude, Cursor Agent, or Antigravity. The Antigravity companion only picks a Codex session recorded for the current folder.

- Claude / Cursor: `/opencode:transfer`, `/gemini:transfer`, or `/antigravity:transfer`
- Codex / Cursor: skills `opencode-transfer`, `gemini-transfer`, `claude-transfer`, or `antigravity-transfer`

## Delegate

All five companions ship a `delegate` skill: a strict manager/implementer split where the companion backend makes every repository change and the host session plans chunks, code-reviews every diff, and commits. It triggers only on an explicit delegation request ("delegate this to opencode") and never on ordinary coding requests.

- Claude / Cursor: `/opencode:delegate`, `/gemini:delegate`, or `/antigravity:delegate` (Claude Code also has `/cursor:delegate`)
- Codex / OpenCode: skills `opencode-delegate`, `gemini-delegate`, `claude-delegate`, `cursor-delegate`, and `antigravity-delegate`

Implementation chunks run through the companion `task` runtime as fresh write-capable jobs (`--background --fresh --write`; the Claude backend uses `--wait` because `claude --bg` may isolate jobs in `.claude/worktrees/`). The supervising session re-runs every claimed-green suite itself and is the only party that commits.

## Review gate (Claude only)

Stop review-gate is Claude Code only. It is off by default. Enable with setup `--enable-review-gate`; when on, a Stop hook may require a fresh read-only review before the turn ends. Codex, Cursor, and OpenCode do not use this gate.

## State and env

Companions resolve plugin roots via `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` (host-specific paths). Job state lives under:

1. `$PLUGIN_DATA/state` when set
2. else `$CLAUDE_PLUGIN_DATA/state`
3. else `~/.opencode-companion/state`, `~/.gemini-companion/state`, `~/.claude-companion/state`, `~/.cursor-companion/state`, or `~/.antigravity-companion/state`

Use only `PLUGIN_*` / `CLAUDE_PLUGIN_*` env names and the companion state dirs above.

## Install with npx skills

Every companion skill can also be installed with the [skills CLI](https://github.com/vercel-labs/skills), at project or global scope, by symlink (the default) or by copy. The repository lists its five skill folders in `skills.sh.json`.

```bash
npx skills add mubeda/agent-bridges --list
# global, symlink
npx skills add mubeda/agent-bridges --skill antigravity-cli-runtime --skill antigravity-review -g -a claude-code -y
# this project, copy
npx skills add mubeda/agent-bridges --skill antigravity-cli-runtime --skill antigravity-review -a codex --copy -y
```

- A plugin's `<plugin>-cli-runtime` skill must be installed with the other skills of that plugin: it carries the companion scripts, prompts, and schemas, and the other skills look for it in the folder next to their own.
- Slash commands, agents, and the Claude stop review-gate come only with a host plugin install.
- Contributors: after changing a plugin's `scripts/`, `prompts/`, or `schemas/`, run `npm run sync:skills`; a test fails until the runtime copies match.

## Manual checklist

- Setup: `/opencode:setup` and `/gemini:setup` (or Codex/Cursor equivalents, including `claude-setup`)
- Review: run with `--background` when you want a detached review job
- Rescue: defaults to `--write` for unattended edits; omit only for read-only asks
- Transfer: `/opencode:transfer` / `/gemini:transfer` (or Codex transfer skills)
- Delegate: explicit invocation only (`/opencode:delegate` or the `*-delegate` skills); the backend implements, the session reviews and commits
- Claude only (optional): `--enable-review-gate` on setup

## Layout

Point at `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.cursor-plugin/marketplace.json`, `.opencode/catalog.json`, and `plugins/`.
