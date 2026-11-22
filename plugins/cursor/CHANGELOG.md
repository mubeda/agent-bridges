# Changelog

## 0.2.5 — 2026-11-21

### Added
- **Antigravity plugin.** The plugin has an `.antigravity-plugin/plugin.json`, so `agy plugin install https://github.com/mubeda/agent-bridges/tree/main/plugins/cursor` takes it as a plugin of its own, and `agy plugin validate` accepts it. The `cursor-transfer` skill says that an Antigravity session cannot be transferred. ([#9](https://github.com/mubeda/agent-bridges/issues/9))

### Fixed
- **The rescue agent's `tools` is a YAML list.** Antigravity's validator rejects `tools` as a plain string; `tools: [Bash]` is the form it and Claude Code both accept. Antigravity cannot start an agent that names a tool it does not have (`tool "Bash" not found in registry`), so the rescue agent does not run there; use the rescue skill in Antigravity. ([#9](https://github.com/mubeda/agent-bridges/issues/9))

## 0.2.4 — 2026-11-21

### Fixed
- **Job state stays in this companion's own folder.** The state root no longer comes from `CLAUDE_PLUGIN_DATA`, which another plugin (the OpenAI Codex plugin) exports into every Bash command of a Claude Code session, so its `state.json` and this companion's were one file. State now lives in `$PLUGIN_DATA/state` when set, else `~/.cursor-companion/state`, the same folder from a session, a terminal or a hook. Jobs that older versions wrote into another plugin's folder stay there and are not listed. ([#7](https://github.com/mubeda/agent-bridges/issues/7))
  Before updating, wait for running background jobs to finish or cancel them: a job started by an older version in another plugin's folder cannot be found by `status` or `cancel` after the update.

## 0.2.3 — 2026-11-20

### Fixed
- **Windows: npm-installed CLIs get the prompt byte for byte.** A `.cmd` shim is now started by running the script or `.exe` it names, with the running Node, instead of its `.ps1` through Windows PowerShell 5.1, which turned non-ASCII into `?` and LF into CRLF.

## 0.2.2 — 2026-11-19

### Security
- **Adversarial-review focus text goes on stdin** with the new `--focus-stdin` flag, never as an argument.
- **Rescue (skills, agents and commands) and delegate pipe the task text to the companion on stdin** (a quoted heredoc) instead of passing it as an argument, so it never shows in the companion's own process arguments. The companion reads stdin until end of file.
- **Prompts always go to the backend on stdin**, never in argv, where other local users can read them (`/proc/<pid>/cmdline`).
- **Job state is private to your user.** State folders are created as 0700 and job files as 0600, and folders made by older versions are tightened; job files hold prompts and packed transcripts.
- **Windows: the CLI launch never uses a bare name.** The run itself, not just the version check, now starts an absolute path from trusted PATH entries, so a CLI planted in the checkout is never started.
- **Transfer only auto-picks a transcript proven to belong to this workspace.** Claude and Cursor project folder names are a lossy encoding (`/a-b` and `/a/b` collide), so a Claude transcript must record a `cwd` inside this workspace and a Cursor project must carry a `.workspace-trusted` marker for it; otherwise transfer asks for `--source`. Cursor folder names also no longer get a leading dash, which never matched real Cursor folders.
- **Windows: a checkout can no longer plant the CLI or git.** `cmd.exe` and process spawning search the working folder before PATH, so a repository with `agy.cmd`, `agent.cmd` or `git.exe` would have run it. Bare names now resolve from absolute PATH entries only.
- **Windows: a CLI path with spaces now works.** A binary under `C:\\Program Files` was passed to `cmd.exe` unquoted and failed.
- **Transfer never picks another repository's Codex session.** With no session for the current folder it now stops and asks for `--source`.
- **Windows: a `.cmd` launcher with no `.ps1` is reported by setup** instead of failing later with `spawn EINVAL`.
- **BREAKING: `--write` needs an explicit opt-in.** The companion refuses `--write` without `--bypass-permissions` or `AGENT_BRIDGES_ALLOW_BYPASS=1`. Rescue is read-only by default. The backend's folder-trust bypass is passed only with `--trust` or `AGENT_BRIDGES_TRUST=1`.
- **Reviews no longer follow untracked symlinks.** A symlink to a file outside the repository is listed as skipped, not inlined into the review prompt.
- **Git is run without a shell**, so a ref containing `&` reaches git intact on Windows.

### Changed
- **Skills find the companion in the sibling `<plugin>-cli-runtime` folder**, so installs with `npx skills` work. The runtime skill now carries synced copies of `scripts/`, `prompts/` and `schemas/` (`npm run sync:skills`).

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
