# Changelog

## 0.3.4 — 2026-11-21

### Fixed
- **Job state stays in this companion's own folder.** The state root no longer comes from `CLAUDE_PLUGIN_DATA`, which another plugin (the OpenAI Codex plugin) exports into every Bash command of a Claude Code session, so its `state.json` and this companion's were one file. State now lives in `$PLUGIN_DATA/state` when set, else `~/.opencode-companion/state`, the same folder from a session, a terminal or a hook. Jobs that older versions wrote into another plugin's folder stay there and are not listed. ([#7](https://github.com/mubeda/agent-bridges/issues/7))
- **The stop review gate sees the setting `setup` wrote.** The Stop hook ran with this plugin's own `CLAUDE_PLUGIN_DATA` while `setup --enable-review-gate` ran from Bash without it, so the two used different folders and an enabled gate could stay off. Both now use the same folder. If you enabled the gate before, run `setup --enable-review-gate` once more.

## 0.3.3 — 2026-11-20

### Fixed
- **Windows: npm-installed CLIs get the prompt byte for byte.** A `.cmd` shim is now started by running the script or `.exe` it names, with the running Node, instead of its `.ps1` through Windows PowerShell 5.1, which turned non-ASCII into `?` and LF into CRLF.
- **OpenCode 1.x runs work again.** The prompt-file message now goes before `-f`; `-f` takes every value up to the next flag, so OpenCode 1.x read the message as a second file (`File not found`).

### Security
- **Read-only runs are now read-only.** Without `--write`, the companion only left out `--auto`, and OpenCode's defaults still allowed edits and shell commands. Reviews and tasks without `--write` now get a per-run configuration (`OPENCODE_CONFIG_CONTENT`) that allows only `read`, `glob` and `list`, MCP tools included. `grep` is denied because it would print `.env` contents, and reading `*.env` and `*.env.*` is denied (`*.env.example` is allowed). The rest of a user's `OPENCODE_CONFIG_CONTENT` is kept, except `permission` and OpenCode 2's native `permissions` list, which would outrank the allowlist.
- **Large reviews still see the diff.** A review too big to inline (more than two files or 256 KiB) used to tell OpenCode to run `git diff` itself, which shell is now denied. The companion writes the full target diff to a private file and lets OpenCode read only that folder outside the workspace, in parts; the file is deleted after the review.

## 0.3.2 — 2026-11-19

### Security
- **Adversarial-review focus text goes on stdin** with the new `--focus-stdin` flag, never as an argument.
- **Rescue (skills, agents and commands) and delegate pipe the task text to the companion on stdin** (a quoted heredoc) instead of passing it as an argument, so it never shows in the companion's own process arguments. The companion reads stdin until end of file.
- **The prompt no longer goes in argv**, where other local users can read it. It is written to a private 0600 file (in a 0700 temp folder) that is attached with `-f` and deleted after the run.
- **Job state is private to your user.** State folders are created as 0700 and job files as 0600, and folders made by older versions are tightened; job files hold prompts and packed transcripts.
- **Windows: the CLI launch never uses a bare name.** The run itself, not just the version check, now starts an absolute path from trusted PATH entries, so a CLI planted in the checkout is never started.
- **Transfer only auto-picks a transcript proven to belong to this workspace.** Claude and Cursor project folder names are a lossy encoding (`/a-b` and `/a/b` collide), so a Claude transcript must record a `cwd` inside this workspace and a Cursor project must carry a `.workspace-trusted` marker for it; otherwise transfer asks for `--source`. Cursor folder names also no longer get a leading dash, which never matched real Cursor folders.
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
