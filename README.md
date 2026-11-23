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

## Antigravity

```bash
agy plugin install https://github.com/mubeda/agent-bridges/tree/main/plugins/claude
agy plugin install https://github.com/mubeda/agent-bridges/tree/main/plugins/cursor
agy plugin install https://github.com/mubeda/agent-bridges/tree/main/plugins/antigravity
```

The `claude`, `cursor` and `antigravity` bridges are Antigravity plugins. `opencode` and `gemini` are not yet: their rescue agent names a model that Antigravity's loader rejects ([#9](https://github.com/mubeda/agent-bridges/issues/9)). Inside Antigravity, the `antigravity` bridge starts a separate session of the same client (a second ACP session, on the model the caller names), for example a Gemini review for a session on another provider's model; its skills start every call with `--background`, then wait with `status <job-id> --wait` and read `result <job-id>`, because a call left in the foreground can be cut off when the outer session ends. There the skills find the companion in the `<plugin>-cli-runtime` skill that comes with the plugin. `transfer` cannot send an Antigravity session: it reads only Claude Code, Codex and Cursor transcripts, so pass one with `--source <path>`. The rescue agent names the tool `Bash`, which Antigravity does not have, so Antigravity cannot start it (`tool "Bash" not found in registry`); use the `<plugin>-rescue` skill there.

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

- The companion talks to Antigravity through its ACP server: it starts `agy acp` and speaks the Agent Client Protocol (JSON-RPC) over its stdin and stdout. Set `ANTIGRAVITY_BIN` to use a specific executable.
- Only the Google sign-in cached by `agy` is supported: sign in once with an interactive `agy` session, or run `agy acp --login`. API keys are not supported by this bridge. Setup cannot check sign-in without a model run, so it reports the binary, its version and the state folder; a run that is not signed in fails with a message that says how to sign in.
- Read-only runs (every review, and a task or rescue without `--write`) use a restricted reader agent. The reader has no tools at all. The companion writes the agent into a fresh folder in its own state (never in the workspace; when the state folder is inside the workspace the run fails instead), starts `agy acp --add-dir <folder> --agent <name>`, and first asks the agent for a random token written in its definition. Unless the answer is exactly the token, with no tool call and no permission request on the way, the reader was not in effect and the run stops before the real prompt. Later, permission requests are refused and any other tool stops the run.
- So a review answers only from what the companion puts in its prompt: the git status, the diff and the contents of new files, up to 256 KiB. The budget is kept while collecting (git output and new files are read only up to it), source files come before tests and generated files, and a change identical to one already shown is only named. A larger change is cut, the files not shown are listed, and the reviewer is told to say so; the result then has an `Incomplete review:` line with those files, and the job record has an `evidence` field, so the caller sees it too. A review cannot read other files, list folders, search or run commands. A read-only task answers only from its prompt and the files named with `task --include <path>` (repeatable; refused with `--write`). The companion reads each named file itself, before any session starts, and only inside the workspace: the path is resolved through links and compared with the workspace's real path by whole components, so a file outside, a `..` path out of it or a link out of it is refused and nothing runs; the opened file is checked again before it is read. The files go into the prompt under the same 256 KiB budget; a file not shown in full is named on an `Incomplete task:` line, and the job record has an `evidence` field. Antigravity does not ask before it reads, so a reader with a file tool could read outside the workspace before the bridge saw it; with no tool, there is nothing to read with.
- Write runs (`--write`) use Antigravity's default agent and allow every permission request it makes.
- `--model` takes an id from `agy models`; `--effort` takes `low`, `medium`, `high` or `xhigh` (Antigravity's thinking levels).
- Prompts travel on the protocol, never as arguments, so they never show up in process lists.
- Only a write run continues a session, and only the most recent task, when it was a write task whose prompt reached its session. A write resume (`task --write --resume-last`) reopens that session with `session/resume`; when the most recent task was read-only or failed before its prompt, a new session starts instead (never an older one), and the result says why. `task --write --resume-job <job-id>` continues exactly that job, or fails and runs nothing when it cannot be continued. If Antigravity no longer has the session, or its ACP server cannot resume sessions, a new session starts, the result says so and the new id is stored. `session/load` is never used: it silently creates a session for an id it does not know. A read-only run never resumes an earlier session: a session keeps the agent it was made with, so the restricted reader cannot be attached to it. A read-only `--resume-last` starts a new reader session and says so.
- Antigravity job state lives under `~/.antigravity-companion/state`.

## Gemini backends

The Gemini companion prefers **`agy`** (Antigravity CLI) on PATH, then falls back to **`gemini`**.

Override with `GEMINI_BACKEND=agy` or `GEMINI_BACKEND=gemini`. Optional `GEMINI_BIN` points at a specific binary. Read-only runs on the `agy` backend pass `--settings` with deny rules for `write_file(*)` and `command(*)`.

## Transfer

All five companions support `transfer`: move the current host session (Claude, Codex, or Cursor — auto-detected, or `--source <path>`) into a resumable OpenCode or Gemini thread, or send a prompt handoff into Claude, Cursor Agent, or Antigravity. A Codex session is only picked when it was recorded for the current folder.

- Claude / Cursor: `/opencode:transfer`, `/gemini:transfer`, or `/antigravity:transfer`
- Codex / Cursor: skills `opencode-transfer`, `gemini-transfer`, `claude-transfer`, or `antigravity-transfer`

## Delegate

All five companions ship a `delegate` skill: a strict manager/implementer split where the companion backend makes every repository change and the host session plans chunks, code-reviews every diff, and commits. It triggers only on an explicit delegation request ("delegate this to opencode") and never on ordinary coding requests.

- Claude / Cursor: `/opencode:delegate`, `/gemini:delegate`, or `/antigravity:delegate` (Claude Code also has `/cursor:delegate`)
- Codex / OpenCode: skills `opencode-delegate`, `gemini-delegate`, `claude-delegate`, `cursor-delegate`, and `antigravity-delegate`

Implementation chunks run through the companion `task` runtime as fresh write-capable jobs (`--background --fresh --write --bypass-permissions`; the Claude backend uses `--wait` because `claude --bg` may isolate jobs in `.claude/worktrees/`). The supervising session re-runs every claimed-green suite itself and is the only party that commits.

## Permissions are opt-in

No companion bypasses a backend CLI's safety checks unless you say so.

- **Write runs.** `--write` makes the backend auto-approve its tools (`--dangerously-skip-permissions` for Claude, allowing every permission request for Antigravity, `--force` for Cursor, `--approval-mode=yolo` for Gemini, `--auto` for OpenCode). The companion refuses `--write` unless the same command has `--bypass-permissions`, or `AGENT_BRIDGES_ALLOW_BYPASS=1` is set in the environment.
- **Folder trust.** Cursor's `--trust` and Gemini's `--skip-trust` are passed only with `--trust` on the companion command, or with `AGENT_BRIDGES_TRUST=1`. Without it, the backend applies its own folder-trust check, and a headless run in a folder you have not trusted can stop with the backend's error.
- Rescue is read-only by default.
- **OpenCode read-only runs** (reviews, and tasks without `--write`) pass a per-run configuration in `OPENCODE_CONFIG_CONTENT` that denies every tool except `read`, `glob` and `list`, MCP tools included. `grep` is denied too, because it searches file contents, so it could print secrets from files that `read` refuses. Reading `*.env` and `*.env.*` is denied, and `*.env.example` is allowed. The rest of your `OPENCODE_CONFIG_CONTENT` is kept, except its `permission` block and OpenCode 2's native `permissions` list, which would outrank the allowlist. Without this, OpenCode's defaults allow edits and shell commands even without `--auto`.
- Delegate passes `--write --bypass-permissions` itself, because invoking it is an explicit request for the backend to make the changes.

## Windows

- Companions start an npm-installed CLI (a `.cmd` shim) by running the script or `.exe` that the shim names, never through `cmd.exe` or PowerShell, so a prompt on stdin arrives byte for byte. Any other `.cmd` is refused, except that the OpenCode, Gemini, Cursor and Antigravity companions fall back to the `.ps1` next to it when there is one. When a launcher is refused, set the backend's `*_BIN` variable to its `.exe`.
- Windows PowerShell 5.1 re-encodes text piped into a native command with `$OutputEncoding`, which defaults to ASCII, so `"é" | node …` arrives as `?`. Run `$OutputEncoding = [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()` first, or use PowerShell 7 or Git Bash.

## Review gate (Claude only)

Stop review-gate is Claude Code only. It is off by default. Enable with setup `--enable-review-gate`; when on, a Stop hook may require a fresh read-only review before the turn ends. Codex, Cursor, and OpenCode do not use this gate.

## State and env

Companions resolve plugin roots via `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` (host-specific paths). Job state lives under:

1. `$PLUGIN_DATA/state` when set
2. else `~/.opencode-companion/state`, `~/.gemini-companion/state`, `~/.claude-companion/state`, `~/.cursor-companion/state`, or `~/.antigravity-companion/state`

`CLAUDE_PLUGIN_DATA` is never read for state: another plugin can export its own value into the session, and two tools would then share one `state.json` ([#7](https://github.com/mubeda/agent-bridges/issues/7)).

Plugin roots use only the `PLUGIN_*` and `CLAUDE_PLUGIN_*` names; state uses only the dirs above.

## Install with npx skills

Every companion skill can also be installed with the [skills CLI](https://github.com/vercel-labs/skills), at project or global scope, by symlink (the default) or by copy. The repository lists its five skill folders in `skills.sh.json`.

```bash
npx skills add mubeda/agent-bridges --list
# global, symlink
npx skills add mubeda/agent-bridges --skill antigravity-cli-runtime --skill antigravity-review -g -a claude-code -y
# this project, copy
npx skills add mubeda/agent-bridges --skill antigravity-cli-runtime --skill antigravity-review -a codex --copy -y
# Antigravity
npx skills add mubeda/agent-bridges --skill claude-cli-runtime --skill claude-review -a antigravity -y
```

- A plugin's `<plugin>-cli-runtime` skill must be installed with the other skills of that plugin: it carries the companion scripts, prompts, and schemas, and the other skills look for it in the folder next to their own.
- Slash commands, agents, and the Claude stop review-gate come only with a host plugin install.
- Contributors: after changing a plugin's `scripts/`, `prompts/`, or `schemas/`, run `npm run sync:skills`; a test fails until the runtime copies match.

## Manual checklist

- Setup: `/opencode:setup` and `/gemini:setup` (or Codex/Cursor equivalents, including `claude-setup`)
- Review: run with `--background` when you want a detached review job
- Rescue: read-only by default; add `--write --bypass-permissions` for unattended edits
- Transfer: `/opencode:transfer` / `/gemini:transfer` (or Codex transfer skills)
- Delegate: explicit invocation only (`/opencode:delegate` or the `*-delegate` skills); the backend implements, the session reviews and commits
- Claude only (optional): `--enable-review-gate` on setup

## Layout

Point at `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.cursor-plugin/marketplace.json`, `.opencode/catalog.json`, and `plugins/`.
