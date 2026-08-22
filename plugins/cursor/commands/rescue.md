---
name: rescue
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Cursor rescue subagent
argument-hint: "[--background|--wait] [--write] [--resume|--fresh] [--model <provider/model>] [what Cursor should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `cursor:cursor-rescue` subagent via the `Agent` tool (`subagent_type: "cursor:cursor-rescue"`), forwarding the raw user request as the prompt.
`cursor:cursor-rescue` is a subagent, not a skill — do not call `Skill(cursor:cursor-rescue)` (no such skill) or `Skill(cursor:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Cursor's output verbatim.

Raw user request:
$ARGUMENTS

Resolve `<plugin-root>` as the first directory that contains `scripts/cursor-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/cursor`
4. `~/.config/opencode/plugins/cursor`
5. otherwise search the host plugin cache for this plugin's `scripts/cursor-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Execution mode:

- If the request includes `--background`, forward it to the companion `task` call; the companion detaches itself.
- If the request includes `--wait`, forward it to the companion `task` call so the task runs in the foreground.
- If neither flag is present, omit both and let `task` default to foreground.
- `--background` and `--wait` are companion runtime controls. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- `--model` and `--write` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Cursor, check for a resumable rescue thread from this Claude session by running:

```bash
node "<plugin-root>/scripts/cursor-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Cursor thread or start a new one.
- The two choices must be:
  - `Continue current Cursor thread`
  - `Start a new Cursor thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Cursor thread (Recommended)` first.
- Otherwise put `Start a new Cursor thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "<plugin-root>/scripts/cursor-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Cursor companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/cursor:status`, fetch `/cursor:result`, call `/cursor:cancel`, summarize output, or do follow-up work of its own.
- Default to a write-capable Cursor run by adding `--write` to the companion `task` invocation unless the user clearly asked for read-only / review-only behavior.
- Leave the model unset unless the user explicitly asks for one. Forward whatever provider/model string they pass verbatim (for example `openrouter/anthropic/claude-sonnet-4.6`).
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Cursor is missing or unauthenticated, stop and tell the user to run `/cursor:setup`.
- If the user did not supply a request, ask what Cursor should investigate or fix.

