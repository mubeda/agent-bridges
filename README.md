# Agent Bridges

Catalog of four companion plugins — **OpenCode**, **Gemini**, **Claude**, and **Cursor Agent** — for Codex CLI, Cursor, and OpenCode.

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

Each plugin can be installed independently.

## Claude Code

```bash
/plugin marketplace add mubeda/agent-bridges
/plugin install opencode@agent-bridges
/plugin install gemini@agent-bridges
/plugin install cursor@agent-bridges
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
```

Reload the window. OpenCode and Gemini commands come from their `commands/` folders; the Claude companion has no `commands/` folder and exposes skills instead.

## OpenCode

```bash
node scripts/install-opencode.mjs --plugin all --scope user
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

## Gemini backends

The Gemini companion prefers **`agy`** (Antigravity CLI) on PATH, then falls back to **`gemini`**.

Override with `GEMINI_BACKEND=agy` or `GEMINI_BACKEND=gemini`. Optional `GEMINI_BIN` points at a specific binary.

## Transfer

All four companions support `transfer`: move the current host session (Claude, Codex, or Cursor — auto-detected, or `--source <path>`) into a resumable OpenCode or Gemini thread, or send a prompt handoff into Claude or Cursor Agent.

- Claude / Cursor: `/opencode:transfer` or `/gemini:transfer`
- Codex / Cursor: skills `opencode-transfer`, `gemini-transfer`, or `claude-transfer`

## Review gate (Claude only)

Stop review-gate is Claude Code only. It is off by default. Enable with setup `--enable-review-gate`; when on, a Stop hook may require a fresh read-only review before the turn ends. Codex, Cursor, and OpenCode do not use this gate.

## State and env

Companions resolve plugin roots via `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` (host-specific paths). Job state lives under:

1. `$PLUGIN_DATA/state` when set
2. else `$CLAUDE_PLUGIN_DATA/state`
3. else `~/.opencode-companion/state`, `~/.gemini-companion/state`, `~/.claude-companion/state`, or `~/.cursor-companion/state`

Use only `PLUGIN_*` / `CLAUDE_PLUGIN_*` env names and the companion state dirs above.

## Manual checklist

- Setup: `/opencode:setup` and `/gemini:setup` (or Codex/Cursor equivalents, including `claude-setup`)
- Review: run with `--background` when you want a detached review job
- Rescue: defaults to `--write` for unattended edits; omit only for read-only asks
- Transfer: `/opencode:transfer` / `/gemini:transfer` (or Codex transfer skills)
- Claude only (optional): `--enable-review-gate` on setup

## Layout

Point at `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.cursor-plugin/marketplace.json`, `.opencode/catalog.json`, and `plugins/`.
