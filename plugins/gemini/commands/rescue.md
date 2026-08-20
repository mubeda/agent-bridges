---
name: rescue
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Gemini rescue subagent
argument-hint: "[--background|--wait] [--write] [--resume|--fresh] [--model <alias|id>] [--effort <low|medium|high>] [what Gemini should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `gemini:gemini-rescue` subagent via the `Agent` tool (`subagent_type: "gemini:gemini-rescue"`), forwarding the raw user request as the prompt.
`gemini:gemini-rescue` is a subagent, not a skill — do not call `Skill(gemini:gemini-rescue)` (no such skill) or `Skill(gemini:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Gemini's output verbatim.

Raw user request:
$ARGUMENTS

Resolve `<plugin-root>` as the first directory that contains `scripts/gemini-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/gemini`
4. `~/.config/opencode/plugins/gemini`
5. otherwise search the host plugin cache for this plugin's `scripts/gemini-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Execution mode:

- If the request includes `--background`, forward it to the companion `task` call; the companion detaches itself.
- If the request includes `--wait`, forward it to the companion `task` call so the task runs in the foreground.
- If neither flag is present, omit both and let `task` default to foreground.
- `--background` and `--wait` are companion runtime controls. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- `--model`, `--effort`, and `--write` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text. `--effort` (`low|medium|high`) is forwarded for `agy`; on Gemini CLI the companion ignores it and prints the existing deprecation note.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Gemini, check for a resumable rescue thread from this Claude session by running:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Gemini thread or start a new one.
- The two choices must be:
  - `Continue current Gemini thread`
  - `Start a new Gemini thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Gemini thread (Recommended)` first.
- Otherwise put `Start a new Gemini thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "<plugin-root>/scripts/gemini-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Gemini companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/gemini:status`, fetch `/gemini:result`, call `/gemini:cancel`, summarize output, or do follow-up work of its own.
- Default to a write-capable Gemini run by adding `--write` to the companion `task` invocation unless the user clearly asked for read-only / review-only behavior.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort (`low|medium|high`). Forward it for `agy`; Gemini CLI ignores it with the companion's existing note.
- Leave the model unset unless the user explicitly asks for one. Forward whatever model alias or id they pass verbatim (for example `pro`, `flash`, or `gemini-3-pro-preview`).
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Gemini is missing or unauthenticated, stop and tell the user to run `/gemini:setup`.
- If the user did not supply a request, ask what Gemini should investigate or fix.
