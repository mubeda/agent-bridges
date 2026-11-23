---
name: rescue
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Antigravity rescue subagent
argument-hint: "[--background|--wait] [--write --bypass-permissions] [--trust] [--resume|--resume-job <job-id>|--fresh] [--model <id>] [--effort <level>] [--include <path>]... [what Antigravity should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `antigravity:antigravity-rescue` subagent via the `Agent` tool (`subagent_type: "antigravity:antigravity-rescue"`), forwarding the raw user request as the prompt.
`antigravity:antigravity-rescue` is a subagent, not a skill — do not call `Skill(antigravity:antigravity-rescue)` (no such skill) or `Skill(antigravity:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Antigravity's output verbatim.

Raw user request:
$ARGUMENTS

Resolve `<plugin-root>` as the first directory that contains `scripts/antigravity-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/antigravity`
4. `~/.config/opencode/plugins/antigravity`
5. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/antigravity-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Execution mode:

- If the request includes `--background`, forward it to the companion `task` call; the companion detaches itself.
- If the request includes `--wait`, forward it to the companion `task` call so the task runs in the foreground.
- If neither flag is present, omit both and let `task` default to foreground.
- `--background` and `--wait` are companion runtime controls. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- `--model`, `--effort`, `--include`, `--write`, `--bypass-permissions` and `--trust` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume` or `--resume-job`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, only when the request will run with `--write --bypass-permissions` (the user asked for changes), check for an Antigravity thread that run could continue:

```bash
node "<plugin-root>/scripts/antigravity-companion.mjs" task-resume-candidate --for-write --json
```

- A read-only request never continues a thread (only a write run continues an Antigravity session, and only an earlier write session), so do not run the helper or ask; route it as a new thread.
- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue that thread or start a new one. Name the thread in the continue choice with the candidate's `summary` and `id`.
- The two choices must be:
  - `Continue Antigravity thread: <summary> (<id>)`
  - `Start a new Antigravity thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put the continue choice first with ` (Recommended)` added.
- Otherwise put `Start a new Antigravity thread (Recommended)` first.
- If the user chooses continue, add `--resume-job <id>` with the candidate's `id` before routing to the subagent (not `--resume`, which would look up the latest task again and could pick a job that finished while the question was open).
- Only a write run continues an Antigravity session, and only the most recent task, when it was a write task whose prompt reached its session. `--resume-last` without `--write` starts a new read-only session, because the restricted reader cannot be attached to an earlier one. `--write --resume-last` continues the most recent task when it can, and otherwise starts a new session; it never jumps back to an older one. The output says when a new session was started and why. `--resume-job <job-id>` (write runs only) continues exactly that job, or fails and runs nothing when it cannot be continued. Never add `--write` just to continue a session the user did not ask to change.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "<plugin-root>/scripts/antigravity-companion.mjs" task <flags> <<'TASK_TEXT'`, with the task text on the following lines and a closing `TASK_TEXT` line, so the text goes on stdin and never as an argument (arguments are visible to other local users) and return that command's stdout as-is.
- Return the Antigravity companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/antigravity:status`, fetch `/antigravity:result`, call `/antigravity:cancel`, summarize output, or do follow-up work of its own.
- Default to a read-only run. Add `--write --bypass-permissions` only when the user asked for changes to be made (a fix, an implementation, "apply it"): `--write` lets the backend change files and run commands without asking, and the companion refuses it without `--bypass-permissions` (or `AGENT_BRIDGES_ALLOW_BYPASS=1`). A write run also sets the session mode `auto`, so subagents of the session can run commands that Antigravity counts as safe; Antigravity still asks before irreversible ones, and the companion answers each such request once.
- A read-only run has no file tool: it sees only the task text and the files named with `--include <path>` (one flag per file, inside the workspace, refused with `--write`). When the user names files Antigravity should look at in a read-only run, add one `--include` per file.
- Leave the model unset unless the user explicitly asks for one. Forward whatever model string they pass verbatim.
- Leave `--resume`, `--resume-job <id>` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Antigravity is missing or not signed in, stop and tell the user to run `/antigravity:setup`.
- If the user did not supply a request, ask what Antigravity should investigate or fix.

