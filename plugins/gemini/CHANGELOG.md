# Changelog

## 0.2.2 — 2026-11-19

### Security
- **Prompts always go to the backend on stdin**, never in argv, where other local users can read them (`/proc/<pid>/cmdline`).
- **Job state is private to your user.** State folders are created as 0700 and job files as 0600, and folders made by older versions are tightened; job files hold prompts and packed transcripts.
- **Windows: the CLI launch never uses a bare name.** The run itself, not just the version check, now starts an absolute path from trusted PATH entries, so a CLI planted in the checkout is never started.
- **Transfer only auto-picks a transcript proven to belong to this workspace.** Claude and Cursor project folder names are a lossy encoding (`/a-b` and `/a/b` collide), so a Claude transcript must record a `cwd` inside this workspace and a Cursor project must carry a `.workspace-trusted` marker for it; otherwise transfer asks for `--source`. Cursor folder names also no longer get a leading dash, which never matched real Cursor folders.
- **Windows: a checkout can no longer plant the CLI or git.** `cmd.exe` and process spawning search the working folder before PATH, so a repository with `agy.cmd`, `agent.cmd` or `git.exe` would have run it. Bare names now resolve from absolute PATH entries only.
- **Windows: an npm-installed CLI now starts.** npm installs a `.cmd` shim, which Node cannot start without a shell; jobs now run its `.ps1` through PowerShell, and setup reports a `.cmd` with no `.ps1`.
- **Windows: a CLI path with spaces now works.** A binary under `C:\\Program Files` was passed to `cmd.exe` unquoted and failed.
- **Transfer never picks another repository's Codex session.** With no session for the current folder it now stops and asks for `--source`.
- Git really runs without a shell now; the earlier change was ignored by this plugin's process helper.
- **BREAKING: `--write` needs an explicit opt-in.** The companion refuses `--write` without `--bypass-permissions` or `AGENT_BRIDGES_ALLOW_BYPASS=1`. Rescue is read-only by default. The backend's folder-trust bypass is passed only with `--trust` or `AGENT_BRIDGES_TRUST=1`.
- **Git is run without a shell**, so a ref containing `&` reaches git intact on Windows.

### Changed
- **Skills find the companion in the sibling `<plugin>-cli-runtime` folder**, so installs with `npx skills` work. The runtime skill now carries synced copies of `scripts/`, `prompts/` and `schemas/` (`npm run sync:skills`).
- **Read-only `agy` runs deny file writes and shell commands** with `--settings` (`write_file(*)`, `command(*)`). Before, an `agy` review could edit files.

## 0.2.1 — 2026-11-09

### Fixed
- **`gemini-delegate` cancels a blocked job before relaunching it**, so two implementers never edit the same owned files, and requires a clean worktree before the first launch.
- **`gemini-delegate` polling is portable.** The `timeout`/`grep`/`sleep` loop is replaced by `status <job-id> --wait --timeout-ms 600000 --json`; stock macOS has no `timeout`.
- `gemini-prompting` no longer says to drop `--effort` (it is forwarded for `agy`), and `gemini-cli-runtime` documents the resume flag for both backends.
- Runtime and prompting skills say "host" instead of "Claude", since they also ship to Codex, Cursor, and OpenCode.
- **Rescue keeps task text intact.** `gemini-rescue`, `gemini-cli-runtime`, and the rescue agent pass flags separately and the task text as one argument after `--`; a lone combined string was re-split by the companion and lost apostrophes.
- The `gemini-rescue` skill reports companion failures and points to `gemini-setup` instead of returning nothing.
- Wrapper skills no longer paste raw `$ARGUMENTS` into the shell command.

### Changed
- Plugin-root lookup names the Codex and Claude plugin caches as examples.

## 0.2.0 — 2026-08-31

### Added
- **`gemini-delegate`: manager/implementer delegation.** `/gemini:delegate` command plus the `gemini-delegate` skill. Gemini makes every repository change through the companion `task` runtime (fresh write-capable jobs); the host session plans chunks, code-reviews every diff, re-runs claimed-green suites, and is the only party that commits. Triggers only on explicit delegation requests.

## 0.1.2

- Drop `"hooks": "./hooks/hooks.json"` from the Claude manifest. Claude Code
  auto-loads that file, so the extra `plugin.json` pointer was a duplicate.

## 0.1.1 — 2026-05-12

### Fixed
- **Adversarial review now actually runs adversarially.** `/gemini:adversarial-review` was silently building the generic review prompt and discarding `buildAdversarialReviewPrompt()`. `runAppServerReview` now accepts a pre-built `prompt` and the companion passes the adversarial template through. The adversarial prompt also now inlines the JSON output schema instead of saying "matching the provided schema" without providing one.
- **Untracked-file symlinks are no longer followed.** Previously, an untracked symlink in the working tree would have its target inlined into the review prompt (so a symlink to `~/.ssh/id_rsa` could leak its contents to Gemini). `formatUntrackedFile` now uses `lstatSync`, recognises symlinks, and opens regular files with `O_NOFOLLOW` to defeat TOCTOU swaps.
- **Setup probe now detects cached OAuth credentials.** `getGeminiAuthStatus` previously reported `loggedIn: false` for users with a valid `~/.gemini/oauth_creds.json` (the cache the `gemini` CLI writes after browser-OAuth). It now recognises OAuth, surfaces the active Google account from `google_accounts.json`, and additionally honours `~/.gemini/.env` files.

### Changed
- `render.mjs`: `formatOpencodeResumeCommand` renamed to `formatGeminiResumeCommand`; transitional `report.opencode` and `result.opencode.stdout` fallback paths removed.
- `tests/job-control.test.mjs`: test title updated to remove the stale "OpenCode session" wording.
- `NOTICE` files (top-level + plugin): updated attribution chain (codex-plugin-cc → opencode-plugin-cc → gemini-plugin-cc) and dropped the incorrect "Copyright 2026 OpenAI" line in the plugin NOTICE.

## 0.1.0 — 2026-05-12

Initial port of [opencode-plugin-cc](https://github.com/mubeda/opencode-plugin-cc) to wrap the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) (`@google/gemini-cli`).

### Added
- `/gemini:setup` — env-var probe for `GEMINI_API_KEY` (or Vertex triple `GOOGLE_API_KEY` + `GOOGLE_GENAI_USE_VERTEXAI=true` + `GOOGLE_CLOUD_PROJECT`).
- `/gemini:review` and `/gemini:adversarial-review` — read-only reviews via `gemini --approval-mode=plan`.
- `/gemini:rescue` plus the `gemini-rescue` subagent — delegate diagnosis / implementation tasks to Gemini.
- `/gemini:status`, `/gemini:result`, `/gemini:cancel` — job lifecycle for background runs.
- Companion script (`gemini-companion.mjs`) spawns `gemini --skip-trust --approval-mode=yolo --output-format=stream-json -p <prompt>`, parses the NDJSON event stream (init / message / tool_use / tool_result / result), and tracks `fileChanges` for write-class tools.
- Two internal skills: `gemini-cli-runtime` (rescue forwarder contract) and `gemini-prompting` (Gemini-specific prompt hints, `@path` injection, `GEMINI.md` context file).

### Differences vs opencode-plugin-cc
- **No `--effort` flag.** Gemini has no per-invocation reasoning-effort knob (Pro↔Flash routing is automatic via `general.plan.modelRouting`). When users pass `--effort` the companion logs a one-line deprecation note and discards the value.
- **Auth probe via env vars only.** Gemini has no `auth list` command. `/gemini:setup` checks `GEMINI_API_KEY` and the Vertex triple. OAuth detection is best-effort and not surfaced in v0.1.
- **Model selection by alias.** `--model` accepts Gemini aliases (`auto`, `pro`, `flash`, `flash-lite`) and full ids (e.g. `gemini-3-pro-preview`).
- **Reviews use `--approval-mode=plan`** (Gemini's read-only mode) rather than the same approval mode as tasks. Tasks use `--approval-mode=yolo --skip-trust` for unattended runs.
- **No programmatic cancel.** `gemini --delete-session` takes a numeric index, not the UUID. Cancellation kills the subprocess; the session record persists on disk.

### Known limitations
- Gemini's `stream-json` event schema is partially undocumented. The bridge handles all event types observed during the probe (`init`, `message`, `tool_use`, `tool_result`, `result`, `error`) and no-ops on unknown event types. See `docs/notes/gemini-stream-json.md`.
- `--sandbox` (Docker / Podman / Seatbelt) is opt-in passthrough only; reviews and rescue tasks run without a container by default so the agent can run tests freely.
