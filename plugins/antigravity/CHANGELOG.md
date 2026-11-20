# Changelog

## 0.1.0

### Security
- **Rescue and delegate pipe the task text to the companion on stdin** (a quoted heredoc) instead of passing it as an argument, so it never shows in the companion's own process arguments. The companion reads stdin until end of file.
- **Job state is private to your user.** State folders are created as 0700 and job files as 0600, and folders made by older versions are tightened; job files hold prompts and packed transcripts.
- **Prompts always go to `agy` on stdin**, never in argv, where other local users can read them (`/proc/<pid>/cmdline`).
- **Windows: the CLI launch never uses a bare name.** The run itself, not just the version check, now starts an absolute path from trusted PATH entries, so a CLI planted in the checkout is never started.
- **Self-collected reviews never list a symlink.** Changed files that are symlinks are left out, and the model is told never to open one, since a link can point outside the repository.
- **Transfer only auto-picks a transcript proven to belong to this workspace.** Claude and Cursor project folder names are a lossy encoding (`/a-b` and `/a/b` collide), so a Claude transcript must record a `cwd` inside this workspace and a Cursor project must carry a `.workspace-trusted` marker for it; otherwise transfer asks for `--source`. Cursor folder names also no longer get a leading dash, which never matched real Cursor folders.
- **Windows: a checkout can no longer plant the CLI or git.** `cmd.exe` and process spawning search the working folder before PATH, so a repository with `agy.cmd`, `agent.cmd` or `git.exe` would have run it. Bare names now resolve from absolute PATH entries only.
- **Windows: a CLI path with spaces now works.** A binary under `C:\\Program Files` was passed to `cmd.exe` unquoted and failed.
- **Windows: a `.cmd` launcher with no `.ps1` is reported by setup** instead of failing later with `spawn EINVAL`.
- **BREAKING: `--write` needs an explicit opt-in.** The companion refuses `--write` without `--bypass-permissions` or `AGENT_BRIDGES_ALLOW_BYPASS=1`. Rescue is read-only by default.

- First release: an Antigravity CLI (`agy`) companion for Claude Code, Codex, Cursor and OpenCode, cloned from the Cursor companion.
