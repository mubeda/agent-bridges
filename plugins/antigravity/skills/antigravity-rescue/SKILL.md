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

Forwarding rules:
- Invoke `task` exactly once.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do follow-up work.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`.
- Default to a read-only run. Add `--write --bypass-permissions` only when the user asked for changes to be made (a fix, an implementation, "apply it"): `--write` lets the backend change files and run commands without asking, and the companion refuses it without `--bypass-permissions` (or `AGENT_BRIDGES_ALLOW_BYPASS=1`). When `--write` is set, the companion runs Antigravity's default agent and allows every permission request; never tell the host to pass a skip-permissions flag. Without `--write`, the companion runs a restricted reader agent that can only read files by path (no writes, no commands, no listing or search) and stops the run when that reader is not in effect. That reader may read only inside the workspace: Antigravity does not ask before it reads, so when a read outside the workspace is reported (symlinks resolved), the companion stops the session at once and fails the run. The file may already have been read locally by then; stopping at once is meant to end the session before that content is sent on, a race the bridge cannot fully close.
- Leave `--model` unset unless the user explicitly requests it. Forward an explicit model string verbatim.
- Leave `--effort` unset unless the user explicitly requests it. Forward one of `low`, `medium`, `high` or `xhigh` verbatim (Antigravity's thinking levels; the companion rejects any other value).
- Treat `--model <value>`, `--effort <value>` `--write`, `--bypass-permissions` and `--trust` as runtime controls, not task text.
- Forward `--background` and `--wait` to `task`; they are companion runtime controls, not task text.
- Strip `--resume` and add `--resume-last`. Strip `--fresh` without adding `--resume-last`.
- If the forwarded request includes `--resume-job <job-id>`, pass it to `task` verbatim with its value, together with `--write --bypass-permissions` from the request, and do not add `--resume-last`.
- For a clear continuation request such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", add `--resume-last` unless `--fresh` is present.
- Only a write run continues an Antigravity session, and only the most recent task, when it was a write task whose prompt reached its session. `--resume-last` without `--write` starts a new read-only session, because the restricted reader cannot be attached to an earlier one. `--write --resume-last` continues the most recent task when it can, and otherwise starts a new session; it never jumps back to an older one. The output says when a new session was started and why. `--resume-job <job-id>` (write runs only) continues exactly that job, or fails and runs nothing when it cannot be continued. Never add `--write` just to continue a session the user did not ask to change.
- Otherwise forward a fresh task, preserving the user's task text apart from routing flags.
- Pass each runtime flag as its own shell argument, and send the task text on stdin with the quoted heredoc below, never as an argument: arguments are visible to other local users, and a quoted heredoc keeps quotes, `$` and backticks intact. Never pass flags and task text together as a single string: the companion re-splits a lone argument and mangles apostrophes.

Run exactly once and return stdout verbatim, with no commentary:

```bash
node "<plugin-root>/scripts/antigravity-companion.mjs" task <flags> <<'TASK_TEXT'
<task text>
TASK_TEXT
```

If the command fails or Antigravity cannot be invoked, return the companion's error output verbatim and tell the user to run the `antigravity-setup` skill.

