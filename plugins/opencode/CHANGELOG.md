# Changelog

## 0.3.2 — 2026-11-19

### Security
- **Windows: a checkout can no longer plant the CLI or git.** `cmd.exe` and process spawning search the working folder before PATH, so a repository with `agy.cmd`, `agent.cmd` or `git.exe` would have run it. Bare names now resolve from absolute PATH entries only.
- **Windows: an npm-installed CLI now starts.** npm installs a `.cmd` shim, which Node cannot start without a shell; jobs now run its `.ps1` through PowerShell, and setup reports a `.cmd` with no `.ps1`.
- **Windows: a CLI path with spaces now works.** A binary under `C:\\Program Files` was passed to `cmd.exe` unquoted and failed.
- **Transfer never picks another repository's Codex session.** With no session for the current folder it now stops and asks for `--source`.
- Git really runs without a shell now; the earlier change was ignored by this plugin's process helper.
- **BREAKING: `--write` needs an explicit opt-in.** The companion refuses `--write` without `--bypass-permissions` or `AGENT_BRIDGES_ALLOW_BYPASS=1`. Rescue is read-only by default.
- **Reviews no longer follow untracked symlinks.** A symlink to a file outside the repository is listed as skipped, not inlined into the review prompt.
- **Git is run without a shell**, so a ref containing `&` reaches git intact on Windows.

### Changed
- **Skills find the companion in the sibling `<plugin>-cli-runtime` folder**, so installs with `npx skills` work. The runtime skill now carries synced copies of `scripts/`, `prompts/` and `schemas/` (`npm run sync:skills`).

## 0.3.1 — 2026-11-09

### Fixed
- **`opencode-delegate` cancels a blocked job before relaunching it**, so two implementers never edit the same owned files, and requires a clean worktree before the first launch.
- **`opencode-delegate` polling is portable.** The `timeout`/`grep`/`sleep` loop is replaced by `status <job-id> --wait --timeout-ms 600000 --json`; stock macOS has no `timeout`.
- `opencode-delegate` describes `--write` as `--auto` instead of a "workspace-write sandbox".
- Runtime and prompting skills say "host" instead of "Claude", since they also ship to Codex, Cursor, and OpenCode.
- **Rescue keeps task text intact.** `opencode-rescue`, `opencode-cli-runtime`, and the rescue agent pass flags separately and the task text as one argument after `--`; a lone combined string was re-split by the companion and lost apostrophes.
- The `opencode-rescue` skill reports companion failures and points to `opencode-setup` instead of returning nothing.
- Wrapper skills no longer paste raw `$ARGUMENTS` into the shell command.

### Changed
- Plugin-root lookup names the Codex and Claude plugin caches as examples.

## 0.3.0 — 2026-08-31

### Added
- **`opencode-delegate`: manager/implementer delegation.** `/opencode:delegate` command plus the `opencode-delegate` skill. OpenCode makes every repository change through the companion `task` runtime (fresh write-capable jobs); the host session plans chunks, code-reviews every diff, re-runs claimed-green suites, and is the only party that commits. Triggers only on explicit delegation requests.

## 0.2.1

- Drop `"hooks": "./hooks/hooks.json"` from the Claude manifest. Claude Code
  auto-loads `hooks/hooks.json`, and redeclaring it made `/plugin diagnose`
  fail with a duplicate-hooks error while skipping the extra load.

## 0.1.0

- Initial version of the OpenCode plugin for Claude Code.
- Seven slash commands: `/opencode:review`, `/opencode:adversarial-review`,
  `/opencode:rescue`, `/opencode:status`, `/opencode:result`,
  `/opencode:cancel`, `/opencode:setup`.
- `opencode:opencode-rescue` subagent and `opencode-cli-runtime` /
  `opencode-prompting` skills.
- Companion bridge that spawns `opencode run --format json` per task,
  captures session IDs for resume/cancel, and tracks jobs in
  `${CLAUDE_PLUGIN_DATA}/state/`.
