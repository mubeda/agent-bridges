# Changelog

## 0.2.2 — 2026-11-22

### Fixed
- **A task waits until its session is quiet instead of ending at the first turn end.** Over ACP a turn can end while the session keeps working: a shell command moved to the background completes, a subagent reports back, more tool calls, permission requests and text follow. Before, `task` stopped the server at `end_turn`, killing that work and returning a status note. Now the session stays open, permission requests keep being answered by the same rules (refused in a read-only task, allowed once in a write task), and the run ends when no tool call is still open (a pending `ask_question` does not count, and its question is named on an `Unanswered questions:` line), nothing arrived for 30 seconds, and no subagent of the session is busy (read from its transcript under `~/.gemini/antigravity-cli/brain`; two background commands with one completion still count as busy). A subagent stuck on a `run_command` it never ran, or still running when the wait's bound hits, is named with its role on an `Unfinished subagents:` line, the job record gets `unfinishedSubagents`, and the job is `failed` instead of a plain success. The answer is all the text the session wrote, the text after the turn's end included. A session still working 30 minutes after its turn ended is stopped and the run fails with the text so far; `cancel` still ends a run at once. `review` and `adversarial-review` still end at their first turn end. ([#16](https://github.com/mubeda/agent-bridges/issues/16))

## 0.2.1 — 2026-11-22

### Fixed
- **A review of a change that was cut says so to the caller.** When the evidence of `review` or `adversarial-review` passes the 256 KiB budget, the rendered result now has one line that starts with `Incomplete review:` and names the files shown only in part (the cut fell inside one, or its staged diff was shown and its unstaged diff left out) and the files left out entirely (the first 100 of each, then a count), and the job record, also in `--json`, `status` and `result` output, has an `evidence` field with `truncated`, `maxBytes` and the full `filesNotShown` and `filesPartlyShown` lists. A change that was shown in full has neither. Before, only the model was told. A file that follows one that used exactly the rest of the budget is now listed as not shown. In a cut review, an untracked file the prompt only names as skipped (over 24 KiB, binary, a symlink) is listed as not shown too. A change whose last file uses exactly the rest of the budget reached the reviewer whole and is not called incomplete. A change within the budget that has such a skipped file gets the line too, worded by its cause (`Incomplete review: some files were not shown (too large, binary, a link or unreadable): …`): `evidence.incomplete` is true whenever the line is printed and is the field a caller reads, `evidence.truncated` is the budget cut only, and `filesSkipped` lists the skipped files. ([#14](https://github.com/mubeda/agent-bridges/issues/14))

## 0.2.0 — 2026-11-22

### Changed
- **The bridge talks to Antigravity through its ACP server.** The companion starts `agy acp` and speaks the Agent Client Protocol (newline-delimited JSON-RPC) on its stdin and stdout, instead of running `agy` in print mode. Commands, flags, rendered output, job tracking, background runs and cancel are unchanged. ([#11](https://github.com/mubeda/agent-bridges/issues/11))
- **Read-only runs use a restricted reader agent.** Every review, and every task without `--write`, runs as a restricted agent written for the run into the companion's state folder (never the workspace; the run fails when the state folder is inside it) and removed afterwards; only a folder that carries the bridge's marker is ever removed. A review's agent has no tools; a read-only task's agent can read files by path. The companion first asks it for a random token from its definition; unless the answer is exactly the token, with no tool call or permission request, the run stops before the real prompt, because Antigravity silently falls back to its default agent for a name it does not know. Permission requests are refused, and any tool outside the agent's own stops the run. A review answers only from the diff and new files' contents in its prompt (up to 256 KiB; a larger change is cut and the review is told to say so); it cannot read other files, list folders, search or run commands.
- **Write runs allow every permission request** of Antigravity's default agent, always with the one-time choice (`allow_once`; read-only runs answer `reject_once`), so no rule is saved in Antigravity's settings; a request without a one-time choice is cancelled and fails the run. `--dangerously-skip-permissions` is no longer passed.
- **Reviews ask for JSON in the prompt.** ACP has no schema flag: the schema is in the review prompt, the answer is checked against the schema's required fields and values, and an answer that fails the check gets one follow-up asking for the object only.
- **Review evidence keeps its budget while it is collected.** Git output and new files are read only up to 256 KiB, source files come before tests and generated files, a change identical to one already shown is only named, and the files that did not fit are listed.
- **A read-only task reads only inside its workspace.** Antigravity does not ask before it reads, so the bridge cannot refuse a read beforehand. Each reported `read_file` path (from the tool call and its updates) is resolved through symlinks; a read outside the workspace, or one with no path, stops the session at once and fails the run. The file may already have been read locally by then; stopping at once is meant to end the session before that content is sent on, a race the bridge cannot fully close.
- **Review evidence keeps renames and mode changes.** A renamed file's diff is collected with both paths, so a pure rename stays a short rename patch, and two changes count as identical only when their mode, rename and blob lines all match.
- **Cancel wins.** `cancel` leaves a marker file that no job update can overwrite, keeps the job `cancelling` with its process ids and reader folder until the teardown finished (a second `cancel` retries it), and a run that finishes or is interrupted meanwhile is never stored as a success.
- **A stuck server cannot hang a run.** Setup requests and the token check time out after 60 seconds (the real prompt has no limit; cancel ends it), and a broken pipe, closed output or an error the server cannot tie to a request fails the run.
- **`--effort` takes `low`, `medium`, `high` or `xhigh`**, Antigravity's thinking levels; `max` is rejected before anything runs. `--model` takes an id from `agy models`; an unknown id fails before any prompt.
- **Only a write run continues a session.** A write resume reopens the stored session with `session/resume`; when Antigravity no longer has it (and only then), or its server cannot resume sessions, a new session starts with a warning. Any other resume error fails the run. `session/load` is never used: it silently creates a session for an unknown id. A read-only run never resumes or loads an earlier session, because a session keeps the agent it was made with and the restricted reader cannot be attached to it: a read-only `--resume-last` starts a new reader session and says so in a warning. A write `--resume-last` continues only the most recent task, and only when it was a write task whose prompt reached its session: job records now note whether a run was read-only and whether its prompt was sent. Otherwise the write run starts a new session and says why; it never jumps back to an older session. A record from 0.1.x has neither note and counts as continuable, since print-mode runs had the full agent. The new `task --write --resume-job <job-id>` continues exactly that job or fails without running anything, and `/antigravity:rescue` passes the job the user confirmed this way. `task-resume-candidate --for-write` names the job a write `--resume-last` would continue; without `--for-write` it never offers one.

### Removed
- **API keys are not supported for now.** Only the Google sign-in cached by `agy` works. Setup no longer reports whether `GEMINI_API_KEY` is set; a run that is not signed in says to run `agy` once interactively or `agy acp --login`.

## 0.1.3 — 2026-11-21

### Fixed
- **The rescue agent's `tools` is a YAML list.** Antigravity's validator rejects `tools` as a plain string; `tools: [Bash]` is the form it and Claude Code both accept. Antigravity cannot start an agent that names a tool it does not have (`tool "Bash" not found in registry`), so the rescue agent does not run there; use the rescue skill in Antigravity. ([#9](https://github.com/mubeda/agent-bridges/issues/9))

## 0.1.2 — 2026-11-21

### Fixed
- **Job state stays in this companion's own folder.** The state root no longer comes from `CLAUDE_PLUGIN_DATA`, which another plugin (the OpenAI Codex plugin) exports into every Bash command of a Claude Code session, so its `state.json` and this companion's were one file. State now lives in `$PLUGIN_DATA/state` when set, else `~/.antigravity-companion/state`, the same folder from a session, a terminal or a hook. Jobs that older versions wrote into another plugin's folder stay there and are not listed. ([#7](https://github.com/mubeda/agent-bridges/issues/7))
  Before updating, wait for running background jobs to finish or cancel them: a job started by an older version in another plugin's folder cannot be found by `status` or `cancel` after the update.

## 0.1.1 — 2026-11-20

### Fixed
- **Windows: npm-installed CLIs get the prompt byte for byte.** A `.cmd` shim is now started by running the script or `.exe` it names, with the running Node, instead of its `.ps1` through Windows PowerShell 5.1, which turned non-ASCII into `?` and LF into CRLF.
- **Ctrl-C on a foreground task escalates like cancel.** The companion waits up to two seconds for the agy process group to exit and then SIGKILLs it, so a command that ignores SIGTERM cannot keep changing files after the companion exits.
- **Windows setup shows the launcher it found** (`agy.cmd`), not the extensionless POSIX shim beside it.

## 0.1.0

### Security
- **Adversarial-review focus text goes on stdin** with the new `--focus-stdin` flag, never as an argument.
- **Rescue (skills, agents and commands) and delegate pipe the task text to the companion on stdin** (a quoted heredoc) instead of passing it as an argument, so it never shows in the companion's own process arguments. The companion reads stdin until end of file.
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
