---
name: cursor-cli-runtime
description: Internal helper contract for calling the Cursor companion runtime
user-invocable: false
---

# Cursor Runtime

Use this skill only inside the `cursor-rescue` agent.

Resolve `<plugin-root>` as the first directory that contains `scripts/cursor-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/cursor`
4. `~/.config/opencode/plugins/cursor`
5. otherwise search the host plugin cache for this plugin's `scripts/cursor-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Primary helper:
- `node "<plugin-root>/scripts/cursor-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue agent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Use the helper rather than direct Cursor CLI calls or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `cursor-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `cursor-prompting` skill to rewrite the user's request into a tighter Cursor prompt before the single `task` call.
- That prompt drafting is the only host-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, and pass the model string verbatim.
- Default to a write-capable Cursor run by adding `--write` unless the user clearly asked for read-only / review-only behavior. When `--write` is set, the companion adds `--force`; never tell the host to pass that flag itself.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, pass it through to `task`; the companion handles foreground waiting or background detachment. Do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass the model string through to `task` verbatim.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Reviews are read-only and omit `--write`. Rescue/`task` jobs pass `--write` so the companion adds `--force`; never ask the host to supply it directly.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Cursor cannot be invoked, return nothing.

