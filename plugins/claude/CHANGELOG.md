# Changelog

## 0.2.2 — 2026-11-19

### Security
- **Windows: a CLI path with spaces now works.** A binary under `C:\\Program Files` was passed to `cmd.exe` unquoted and failed.
- **Transfer never picks another repository's Codex session.** With no session for the current folder it now stops and asks for `--source`.
- **BREAKING: `--write` needs an explicit opt-in.** The companion refuses `--write` without `--bypass-permissions` or `AGENT_BRIDGES_ALLOW_BYPASS=1`. Rescue is read-only by default.
- **Reviews no longer follow untracked symlinks.** A symlink to a file outside the repository is listed as skipped, not inlined into the review prompt.
- **Git is run without a shell**, so a ref containing `&` reaches git intact on Windows.

### Changed
- **Skills find the companion in the sibling `<plugin>-cli-runtime` folder**, so installs with `npx skills` work. The runtime skill now carries synced copies of `scripts/`, `prompts/` and `schemas/` (`npm run sync:skills`).

## 0.2.1 — 2026-11-09

### Fixed
- **`claude-delegate` cancels a blocked job before relaunching it**, so two implementers never edit the same owned files, and requires a clean worktree before the first launch.
- **`claude-delegate` health loop no longer restarts healthy chunks.** A `--wait` run prints nothing until it finishes, so output is no longer a liveness signal; a chunk is blocked only after 3 consecutive ticks (~30 min) without a worktree change. The skill now records each job id after launch, and the step heading no longer calls the launch a background job.
- **Rescue keeps task text intact.** `claude-rescue`, `claude-cli-runtime`, and the rescue agent pass flags separately and the task text as one argument after `--`; a lone combined string was re-split by the companion and lost apostrophes.
- The `claude-rescue` skill reports companion failures and points to `claude-setup` instead of returning nothing.
- Wrapper skills no longer paste raw `$ARGUMENTS` into the shell command.

### Changed
- Plugin-root lookup names the Codex and Claude plugin caches as examples.
- Skill descriptions end with a "Use when" trigger.

## 0.2.0

- `claude-delegate` skill: manager/implementer delegation through the companion `task` runtime.

## 0.1.0

- Initial version of the Claude companion skills for Codex, Cursor, and OpenCode.
