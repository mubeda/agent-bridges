# Changelog

## 0.2.1 — 2026-11-09

### Fixed
- **`cursor-delegate` cancels a blocked job before relaunching it**, so two implementers never edit the same owned files, and requires a clean worktree before the first launch.
- **`cursor-delegate` polling is portable.** The `timeout`/`grep`/`sleep` loop is replaced by `status <job-id> --wait --timeout-ms 600000 --json`; stock macOS has no `timeout`.
- `cursor-prompting` no longer claims Cursor is launched with `--bg`, and `/cursor:rescue` no longer shows an OpenCode-style model example.
- **Rescue keeps task text intact.** `cursor-rescue`, `cursor-cli-runtime`, and the rescue agent pass flags separately and the task text as one argument after `--`; a lone combined string was re-split by the companion and lost apostrophes.
- The `cursor-rescue` skill reports companion failures and points to `cursor-setup` instead of returning nothing.
- Wrapper skills no longer paste raw `$ARGUMENTS` into the shell command.

### Changed
- Plugin-root lookup names the Codex and Claude plugin caches as examples.
- Skill descriptions end with a "Use when" trigger.

## 0.2.0 — 2026-08-31

### Added
- **`cursor-delegate`: manager/implementer delegation.** `/cursor:delegate` command plus the `cursor-delegate` skill. Cursor Agent makes every repository change through the companion `task` runtime (fresh write-capable jobs); the host session plans chunks, code-reviews every diff, re-runs claimed-green suites, and is the only party that commits. Triggers only on explicit delegation requests.

## 0.1.0

- Initial version of the Cursor plugin for Cursor Agent companion commands and skills.
