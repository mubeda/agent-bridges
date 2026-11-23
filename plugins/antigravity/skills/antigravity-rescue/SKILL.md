---
name: antigravity-rescue
description: Forward a substantial investigation, implementation, or follow-up task to Antigravity. Use when the user asks for /antigravity:rescue or a Antigravity rescue.
user-invocable: true
---

You are a thin forwarding wrapper around the Antigravity companion task runtime. Forward the user's rescue request and do not do independent work.

Resolve `<plugin-root>` as the first directory that contains `scripts/antigravity-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. the `antigravity-cli-runtime` folder next to the folder that holds this SKILL.md (`<this skill's folder>/../antigravity-cli-runtime`, installed with `npx skills`)
4. `~/.cursor/plugins/local/antigravity`
5. `~/.config/opencode/plugins/antigravity`
6. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/antigravity-companion.mjs`

If none exist, stop and print those paths, and say that an `npx skills` install also needs `antigravity-cli-runtime`. Do not invent a companion elsewhere.

Run the companion from its own folder and name the workspace with `--cwd`, as below: `<workspace>` is the absolute path of the folder this session works in. Never start `node` with the workspace as the shell's current folder: on Windows the shell looks there for `node.exe` before PATH, so one checked into the workspace would run as the user.

Forwarding rules:
- Invoke `task` exactly once.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do follow-up work.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`.
- Default to a read-only run. Add `--write --bypass-permissions` only when the user asked for changes to be made (a fix, an implementation, "apply it"): `--write` lets the backend change files and run commands without asking, and the companion refuses it without `--bypass-permissions` (or `AGENT_BRIDGES_ALLOW_BYPASS=1`). When `--write` is set, the companion runs Antigravity's default agent and allows every permission request; it also sets the session mode `auto`, so subagents of the session can run commands that Antigravity counts as safe, while Antigravity still asks before irreversible ones and the companion answers each such request once. Never tell the host to pass a skip-permissions flag. Without `--write`, the companion runs a restricted reader agent with no tools at all (it cannot read files, write, run commands, list folders or search), and stops the run when that reader is not in effect or any tool call comes. A read-only task sees only its prompt and the files named with `--include <path>` (one flag per file): the companion reads each one itself, only inside the workspace (links resolved; a file outside, a `..` path out of it or a link out of it is refused before anything runs), and puts them into the prompt up to 256 KiB; a file not shown in full is named on an `Incomplete task:` line of the result. `--include` is refused with `--write`, because a write task opens files itself.
- Leave `--model` unset unless the user explicitly requests it. Forward an explicit model string verbatim.
- Leave `--effort` unset unless the user explicitly requests it. Forward one of `low`, `medium`, `high` or `xhigh` verbatim (Antigravity's thinking levels; the companion rejects any other value).
- Treat `--model <value>`, `--effort <value>`, `--include <path>`, `--write`, `--bypass-permissions` and `--trust` as runtime controls, not task text.
- If the forwarded request names files Antigravity should look at in a read-only run, pass each one to `task` as its own `--include <path>` argument and keep the task text as it is. `--include` takes files only, never a folder (the companion refuses a folder). Do not add files the user did not name, and do not pass `--include` with `--write`.
- Forward `--background` and `--wait` to `task`; they are companion runtime controls, not task text.
- Strip `--resume` and add `--resume-last`. Strip `--fresh` without adding `--resume-last`.
- If the forwarded request includes `--resume-job <job-id>`, pass it to `task` verbatim with its value, together with `--write --bypass-permissions` from the request, and do not add `--resume-last`.
- For a clear continuation request such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", add `--resume-last` unless `--fresh` is present.
- Only a write run continues an Antigravity session, and only the most recent task, when it was a write task whose prompt reached its session. `--resume-last` without `--write` starts a new read-only session, because the restricted reader cannot be attached to an earlier one. `--write --resume-last` continues the most recent task when it can, and otherwise starts a new session; it never jumps back to an older one. The output says when a new session was started and why. `--resume-job <job-id>` (write runs only) continues exactly that job, or fails and runs nothing when it cannot be continued. Never add `--write` just to continue a session the user did not ask to change.
- Otherwise forward a fresh task, preserving the user's task text apart from routing flags.
- Pass each runtime flag as its own shell argument, and send the task text on stdin with the quoted heredoc below, never as an argument: arguments are visible to other local users, and a quoted heredoc keeps quotes, `$` and backticks intact. Never pass flags and task text together as a single string: the companion re-splits a lone argument and mangles apostrophes.

Run exactly once and return stdout verbatim, with no commentary:

```bash
cd "<plugin-root>" && node scripts/antigravity-companion.mjs task --cwd "<workspace>" <flags> <<'TASK_TEXT'
<task text>
TASK_TEXT
```

In Antigravity, this bridge starts a separate session of the same client: a second Antigravity session over ACP, on the model the caller names with `--model` (Antigravity's default otherwise), for example a Gemini review asked for by a session on another provider's model. Start every call with `--background`, never `--wait`, even when the user asked for it: the session's shell moves a long command to the background, and a call left in the foreground can be cut off when the outer session ends. Run every command of this flow, the launch included, in the form above, and give `--include` and `--source` paths as absolute paths. Then run `cd "<plugin-root>" && node scripts/antigravity-companion.mjs status <job-id> --wait --cwd "<workspace>"` until the job is `completed`, `failed` or `cancelled` (run it again while it reports any other state; when it has returned a state other than those three 10 times in a row, stop polling and do not fetch the result: report the job id to the user as stuck, or, when that state is `cancelling`, as a cancellation that was interrupted), then `cd "<plugin-root>" && node scripts/antigravity-companion.mjs result <job-id> --cwd "<workspace>"`. `status` and `result` carry the same `--cwd` as the launch, or a job started for another workspace is not found. Add `--json` to `result` when the user asked for JSON, and return that output verbatim. `task` still runs once; this is the one exception to the rules above against polling `status` and fetching `result`, and to returning the stdout of `task`. Do not finish before you have read the result.

If the command fails or Antigravity cannot be invoked, return the companion's error output verbatim and tell the user to run the `antigravity-setup` skill.

