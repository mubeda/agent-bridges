# Changelog

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
