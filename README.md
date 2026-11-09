# Agent Bridges

Catalog of three companion plugins — **OpenCode**, **Claude**, and **Cursor Agent** — for Claude Code, Codex CLI, Cursor, and OpenCode.

Repository: https://github.com/mubeda/agent-bridges

License: Apache-2.0

Install plugins with the catalog id `@agent-bridges`.

## Plugins

| Plugin | What it does |
|---|---|
| `opencode` | Review, rescue, and transfer via the local `opencode` CLI |
| `claude` | Review, rescue, and transfer via the Claude CLI |
| `cursor` | Review, rescue, and transfer via the Cursor Agent CLI |

Each plugin can be installed independently.

## Claude Code

```bash
/plugin marketplace add mubeda/agent-bridges
/plugin install opencode@agent-bridges
/plugin install cursor@agent-bridges
```

Then `/opencode:setup` and `/cursor:setup`.

Optional Claude-only stop review-gate: `/opencode:setup --enable-review-gate` (use `--disable-review-gate` to turn off).

The Claude companion is not for Claude Code and is not listed in the Claude marketplace.

## Codex CLI

```bash
codex plugin marketplace add https://github.com/mubeda/agent-bridges.git
codex plugin add opencode@agent-bridges
codex plugin add claude@agent-bridges
codex plugin add cursor@agent-bridges
```

Invoke skills such as `opencode-review`, `opencode-setup`, `claude-review`, `cursor-review`, `opencode-transfer`, `claude-transfer`, and `cursor-transfer`.

## Cursor

Team marketplace: Dashboard → Plugins → import this GitHub repo.

Local:

```bash
# copy or symlink
# ~/.cursor/plugins/local/opencode  ->  <clone>/plugins/opencode
# ~/.cursor/plugins/local/claude    ->  <clone>/plugins/claude
```

Reload the window. OpenCode commands come from its `commands/` folder; the Claude companion has no `commands/` folder and exposes skills instead.

## OpenCode

```bash
node scripts/install-opencode.mjs --plugin all --scope user
# project: --scope project --project /path/to/repo
```

Use `--force` to overwrite modified installer-managed files. Use `--uninstall` to remove only the selected plugins' installer-managed files.

Community CLI (optional, not vendored): `opencode-marketplace install <path-to-plugins/opencode>`.

This installer does not add entries to `opencode.json` `"plugins"` (`"plugin"` on OpenCode 1.x).

Commands and agents install as `<plugin>--<name>` (for example `/opencode--review`). Agents are rewritten to OpenCode frontmatter (`mode: subagent`; Claude-only `tools`, `model`, and `skills` are dropped).

## OpenCode backend (1.x and 2.x)

The OpenCode companion reads `opencode --version` and supports both lines. Install 2.x with `npm install -g @opencode/cli`.

- 2.x removed `run --dir` and `run --variant`. The companion runs in the working directory and sends effort as `--model provider/model#effort`, so effort needs `--model` or a configured default model. Variants depend on the model.
- Transfer into OpenCode uses `opencode session import` on 2.x (`opencode import` on 1.x).

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

## Transfer

All three companions support `transfer`: move the current host session (Claude, Codex, or Cursor — auto-detected, or `--source <path>`) into a resumable OpenCode session, or send a prompt handoff into Claude or Cursor Agent.

- Claude / Cursor: `/opencode:transfer` (Claude Code also has `/cursor:transfer`)
- Codex / Cursor: skills `opencode-transfer`, `claude-transfer`, or `cursor-transfer`

## Delegate

All three companions ship a `delegate` skill: a strict manager/implementer split where the companion backend makes every repository change and the host session plans chunks, code-reviews every diff, and commits. It triggers only on an explicit delegation request ("delegate this to opencode") and never on ordinary coding requests.

- Claude / Cursor: `/opencode:delegate` (Claude Code also has `/cursor:delegate`)
- Codex / OpenCode: skills `opencode-delegate`, `claude-delegate`, and `cursor-delegate`

Implementation chunks run through the companion `task` runtime as fresh write-capable jobs (`--background --fresh --write`; the Claude backend uses `--wait` because `claude --bg` may isolate jobs in `.claude/worktrees/`). The supervising session re-runs every claimed-green suite itself and is the only party that commits.

## Review gate (Claude only)

Stop review-gate is Claude Code only. It is off by default. Enable with setup `--enable-review-gate`; when on, a Stop hook may require a fresh read-only review before the turn ends. Codex, Cursor, and OpenCode do not use this gate.

## State and env

Companions resolve plugin roots via `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` (host-specific paths). Job state lives under:

1. `$PLUGIN_DATA/state` when set
2. else `$CLAUDE_PLUGIN_DATA/state`
3. else `~/.opencode-companion/state`, `~/.claude-companion/state`, or `~/.cursor-companion/state`

Use only `PLUGIN_*` / `CLAUDE_PLUGIN_*` env names and the companion state dirs above.

## Manual checklist

- Setup: `/opencode:setup` and `/cursor:setup` (or Codex/Cursor equivalents, including `claude-setup`)
- Review: run with `--background` when you want a detached review job
- Rescue: defaults to `--write` for unattended edits; omit only for read-only asks
- Transfer: `/opencode:transfer` (or Codex transfer skills)
- Delegate: explicit invocation only (`/opencode:delegate` or the `*-delegate` skills); the backend implements, the session reviews and commits
- Claude only (optional): `--enable-review-gate` on setup

## Layout

Point at `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.cursor-plugin/marketplace.json`, `.opencode/catalog.json`, and `plugins/`.
