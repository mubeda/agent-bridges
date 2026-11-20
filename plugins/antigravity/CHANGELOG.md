# Changelog

## 0.1.0

### Security
- **Windows: a checkout can no longer plant the CLI or git.** `cmd.exe` and process spawning search the working folder before PATH, so a repository with `agy.cmd`, `agent.cmd` or `git.exe` would have run it. Bare names now resolve from absolute PATH entries only.
- **Windows: a CLI path with spaces now works.** A binary under `C:\\Program Files` was passed to `cmd.exe` unquoted and failed.
- **Windows: a `.cmd` launcher with no `.ps1` is reported by setup** instead of failing later with `spawn EINVAL`.
- **BREAKING: `--write` needs an explicit opt-in.** The companion refuses `--write` without `--bypass-permissions` or `AGENT_BRIDGES_ALLOW_BYPASS=1`. Rescue is read-only by default.

- First release: an Antigravity CLI (`agy`) companion for Claude Code, Codex, Cursor and OpenCode, cloned from the Cursor companion.
