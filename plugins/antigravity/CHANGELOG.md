# Changelog

## 0.1.0

### Security
- **Transfer only auto-picks a transcript proven to belong to this workspace.** Claude and Cursor project folder names are a lossy encoding (`/a-b` and `/a/b` collide), so a Claude transcript must record a `cwd` inside this workspace and a Cursor project must carry a `.workspace-trusted` marker for it; otherwise transfer asks for `--source`. Cursor folder names also no longer get a leading dash, which never matched real Cursor folders.
- **Windows: a checkout can no longer plant the CLI or git.** `cmd.exe` and process spawning search the working folder before PATH, so a repository with `agy.cmd`, `agent.cmd` or `git.exe` would have run it. Bare names now resolve from absolute PATH entries only.
- **Windows: a CLI path with spaces now works.** A binary under `C:\\Program Files` was passed to `cmd.exe` unquoted and failed.
- **Windows: a `.cmd` launcher with no `.ps1` is reported by setup** instead of failing later with `spawn EINVAL`.
- **BREAKING: `--write` needs an explicit opt-in.** The companion refuses `--write` without `--bypass-permissions` or `AGENT_BRIDGES_ALLOW_BYPASS=1`. Rescue is read-only by default.

- First release: an Antigravity CLI (`agy`) companion for Claude Code, Codex, Cursor and OpenCode, cloned from the Cursor companion.
