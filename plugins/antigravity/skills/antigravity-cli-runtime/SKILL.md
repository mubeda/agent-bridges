---
name: antigravity-cli-runtime
description: Internal helper contract for calling the Antigravity companion runtime
user-invocable: false
---

# Antigravity Runtime

Use this skill only inside the `antigravity-rescue` agent.

Resolve `<plugin-root>` as the first directory that contains `scripts/antigravity-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. the `antigravity-cli-runtime` folder next to the folder that holds this SKILL.md (`<this skill's folder>/../antigravity-cli-runtime`, installed with `npx skills`)
4. `~/.cursor/plugins/local/antigravity`
5. `~/.config/opencode/plugins/antigravity`
6. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/antigravity-companion.mjs`

If none exist, stop and print those paths, and say that an `npx skills` install also needs `antigravity-cli-runtime`. Do not invent a companion elsewhere.

Primary helper:
- `node "<plugin-root>/scripts/antigravity-companion.mjs" task <flags> -- "<task text>"`

Execution rules:
- The rescue agent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Use the helper rather than direct Antigravity CLI calls or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `antigravity-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `antigravity-prompting` skill to rewrite the user's request into a tighter Antigravity prompt before the single `task` call.
- That prompt drafting is the only host-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, and pass the model string verbatim.
- Default to a read-only run. Add `--write --bypass-permissions` only when the user asked for changes to be made (a fix, an implementation, "apply it"): `--write` lets the backend change files and run commands without asking, and the companion refuses it without `--bypass-permissions` (or `AGENT_BRIDGES_ALLOW_BYPASS=1`). When `--write` is set, the companion adds `--dangerously-skip-permissions`; never tell the host to pass that flag itself. Without `--write`, the companion denies file writes and shell commands for the run.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- Pass each runtime flag as its own shell argument, then `--`, then the task text as one quoted argument (use a quoted heredoc when the text contains quotes, `$`, or backticks). Never pass flags and task text together as a single string: the companion re-splits a lone argument and mangles apostrophes.
- If the forwarded request includes `--background` or `--wait`, pass it through to `task`; the companion handles foreground waiting or background detachment. Do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass the model string through to `task` verbatim.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Reviews are read-only and omit `--write`. Rescue/`task` jobs that change files pass `--write --bypass-permissions` so the companion adds `--dangerously-skip-permissions`; never ask the host to supply it directly.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Antigravity cannot be invoked, return nothing.

