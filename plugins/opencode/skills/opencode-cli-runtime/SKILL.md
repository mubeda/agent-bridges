---
name: opencode-cli-runtime
description: Internal helper contract for calling the opencode-companion runtime
user-invocable: false
---

# OpenCode Runtime

Use this skill only inside the `opencode:opencode-rescue` subagent.

Resolve `<plugin-root>` as the first directory that contains `scripts/opencode-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/opencode`
4. `~/.config/opencode/plugins/opencode`
5. otherwise search the host plugin cache for this plugin's `scripts/opencode-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Primary helper:
- `node "<plugin-root>/scripts/opencode-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct OpenCode CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `opencode:opencode-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `opencode-prompting` skill to rewrite the user's request into a tighter OpenCode prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, and pass the provider/model string verbatim.
- Default to a write-capable OpenCode run by adding `--write` unless the user clearly asked for read-only / review-only behavior.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, pass it through to `task`; the companion handles foreground waiting or background detachment. Do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass the provider/model string through to `task` verbatim (for example `openrouter/anthropic/claude-sonnet-4.6`).
- If the forwarded request includes `--effort`, pass it through to `task` (valid values: `minimal`, `low`, `medium`, `high`, `max`).
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Reviews and other read-only runs omit `--auto`. Rescue/`task` jobs pass `--write`, which adds `--auto` so the companion can complete unattended. The companion never uses `--dangerously-skip-permissions`.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or OpenCode cannot be invoked, return nothing.
