# Cursor companion plugin

Date: 2026-08-21

A fourth companion plugin, `cursor`, that runs the local Cursor Agent CLI (`agent`) from Claude Code, Codex CLI, and OpenCode. Same command surface as the existing Claude companion. Not listed on the Cursor marketplace.

## Goal

From Claude Code: `/cursor:review`, `/cursor:rescue`, and the rest of the companion commands. From Codex: skills `cursor-review`, `cursor-rescue`, and the rest. OpenCode gets the same tree via the existing installer.

Success: a user with `agent` on PATH (or `CURSOR_BIN`) can install `cursor@agent-bridges` in Claude Code or Codex and run a read-only review or a write rescue against the current git workspace, then status/result/cancel/resume that job.

## Non-goals (v1)

- `@cursor/sdk` / cloud Agents REST
- Listing the plugin on the Cursor marketplace (do not call Cursor Agent from Cursor via this plugin)
- Claude Code stop review-gate
- Shared companion framework extracted from `plugins/claude`
- Changing OpenCode, Gemini, or Claude companion behavior except catalog validation that must list the new plugin

## Approach

Clone `plugins/claude` into `plugins/cursor` and specialize the CLI layer, the same way Gemini was cloned from OpenCode. Do not introduce `plugins/_shared`.

## Hosts and catalogs

| Host | Lists `cursor`? | How it is invoked |
|---|---|---|
| Claude Code | yes | slash commands `/cursor:*` from `commands/` |
| Codex CLI | yes | skills `cursor-*` |
| OpenCode | yes | installer copies commands, skills, agents, scripts |
| Cursor | no | same rule as Claude not listing itself |

Catalog files:

- `.claude-plugin/marketplace.json`: `opencode`, `gemini`, `cursor` (drop nothing; add `cursor`; still omit `claude`)
- `.agents/plugins/marketplace.json`: add `cursor` (four plugins: opencode, gemini, claude, cursor)
- `.opencode/catalog.json`: add `cursor` with `companion: "scripts/cursor-companion.mjs"`
- `.cursor-plugin/marketplace.json`: unchanged plugin list (`opencode`, `gemini`, `claude`)

`scripts/lib/catalogs.mjs` must stop assuming Claude has exactly two plugins and Codex/OpenCode exactly three. Allowed sets:

- Claude host: `opencode`, `gemini`, `cursor`
- Codex and OpenCode: `opencode`, `gemini`, `claude`, `cursor`
- Cursor host: `opencode`, `gemini`, `claude`

`PLUGIN_TREES` includes `cursor`. The cursor tree still has `.cursor-plugin/plugin.json` for completeness, but that manifest is not referenced from the Cursor marketplace.

## Layout

`plugins/cursor/` mirrors Claude:

- `scripts/cursor-companion.mjs`
- `scripts/lib/cursor.mjs` (CLI resolve, argv, JSON parse, auth) plus copies of the shared-pattern libs (`args`, `state`, `git`, `process`, `detach`, `host-session`, `transfer-dest`, `workspace`, `tracked-jobs`, `prompts`, `render`, `fs`)
- `commands/` for Claude Code and OpenCode: `setup`, `review`, `adversarial-review`, `rescue`, `status`, `result`, `cancel`, `transfer`
- `skills/`: `cursor-review`, `cursor-adversarial-review`, `cursor-rescue`, `cursor-status`, `cursor-result`, `cursor-cancel`, `cursor-setup`, `cursor-transfer`, `cursor-cli-runtime`, `cursor-prompting`
- `agents/cursor-rescue.md`
- `prompts/adversarial-review.md`
- `schemas/review-output.schema.json` (same contract as the other companions)
- `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`
- no `hooks/`

Plugin id: `cursor`. Claude slash prefix: `/cursor:`. Codex skill names: `cursor-<verb>`.

## CLI mapping

Binary: `agent`, overridable with `CURSOR_BIN`. Availability: `agent --version`. Auth: `CURSOR_API_KEY` set, or `agent status` / `agent whoami` exit 0 after `agent login`.

| Companion action | `agent` argv |
|---|---|
| review / adversarial-review | `-p --mode plan --output-format json --trust` and no `--force` |
| rescue without `--write` | same as review (read-only) |
| rescue default / `--write` | `-p --force --trust --output-format json` |
| wait | foreground spawn of print mode |
| background | detach that same print-mode process (Cursor has no `claude --bg`) |
| resume | `--resume <session_id>` from stored job JSON |
| cancel | terminate the detached process tree |

`--mode plan` is the review/read-only mapping (not `--mode ask`). `--trust` avoids an interactive workspace prompt in headless runs.

Parse `--output-format json` success objects:

```json
{
  "type": "result",
  "subtype": "success",
  "result": "<assistant text>",
  "session_id": "<uuid>"
}
```

Store `session_id` on the job record. On failure the CLI exits non-zero and writes stderr; no JSON object. Windows oversized prompts use the same stdin/file workaround as Claude (`WIN32_ARGV_PROMPT_LIMIT`).

Optional `--model` passes through as `--model`. There is no Claude `--effort` equivalent in v1; ignore or reject `--effort` with a clear error (prefer reject so callers do not think it applied).

## Jobs and state

State root, in order:

1. `$PLUGIN_DATA/state`
2. `$CLAUDE_PLUGIN_DATA/state`
3. `~/.cursor-companion/state`

Job files, generate/list/upsert, and `--wait`/`--background` polling match the Claude companion. `result` prints stored assistant text. `status --wait` polls until the detached process exits.

## Transfer

Pack the current host session (Claude, Codex, or Cursor transcript auto-detect, or `--source`) into a handoff prompt and run `agent -p` (write unless the user omitted `--write`). Same idea as `claude-transfer`: prompt handoff, not an import API. Resume later with stored `session_id`.

## Setup

`/cursor:setup` (and `cursor-setup`) reports: binary path, version, auth (`CURSOR_API_KEY` or login), and the state directory. It does not enable a review-gate.

## Testing

- `tests/cursor-args.test.mjs`: plan vs `--force`, resume, print `-p`, trust, no `--effort` leak
- `tests/cursor-backend.test.mjs`: `CURSOR_BIN`, missing-binary hint, auth from env vs `agent status`
- `tests/cursor-jobs.test.mjs`: parse JSON `session_id` / `result`
- catalogs, copy-plugins, readme, install-opencode updated for the fourth plugin where those tests pin names

## Docs

README plugins table, Claude Code install (`/plugin install cursor@agent-bridges`), Codex (`codex plugin add cursor@agent-bridges`), OpenCode installer `--plugin all` includes cursor, and a short Cursor CLI section (`agent`, `CURSOR_API_KEY` / `agent login`, plan vs `--force`). Changelog on the new plugin at `0.1.0`.

## Marketplace versions (required after implementation)

Bump every catalog version so Claude Code, Codex, Cursor, and OpenCode clients treat this as a new marketplace revision — not only the new plugin's `0.1.0`.

| File | Field | From | To |
|---|---|---|---|
| `.claude-plugin/marketplace.json` | `metadata.version` | `0.1.0` | `0.2.0` |
| `.cursor-plugin/marketplace.json` | `metadata.version` | `0.1.1` | `0.1.2` |
| `.agents/plugins/marketplace.json` | top-level `version` (add if missing) | none | `0.2.0` |
| `.opencode/catalog.json` | top-level `version` (add if missing) | none | `0.2.0` |

Also set `plugins/cursor` manifests and the Claude marketplace `cursor` entry to plugin version `0.1.0`. Cursor-host marketplace plugin list stays `opencode` / `gemini` / `claude`; still bump its `metadata.version` so a refresh is visible.

Do this in the same change set as the plugin, not as a follow-up.
