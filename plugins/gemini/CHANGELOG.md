# Changelog

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
