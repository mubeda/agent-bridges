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
- `node "<plugin-root>/scripts/antigravity-companion.mjs" task <flags> <<'TASK_TEXT'`, then the task text, then a line `TASK_TEXT`: the task text goes on stdin, never as an argument, because arguments are visible to other local users.

How the companion reaches Antigravity: it starts `agy acp` (Antigravity's ACP server) and speaks the Agent Client Protocol over its stdin and stdout. Prompts travel on that channel, never as arguments. Only the Google sign-in cached by `agy` is supported, not API keys. A read-only run uses a restricted reader agent: for a review it has no tools and answers only from the evidence in its prompt; for a task without `--write` it can read files by path, and cannot write, run commands, list folders or search.

Execution rules:
- The rescue agent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Use the helper rather than direct Antigravity CLI calls or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `antigravity-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `antigravity-prompting` skill to rewrite the user's request into a tighter Antigravity prompt before the single `task` call.
- That prompt drafting is the only host-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, and pass the model string verbatim.
- Default to a read-only run. Add `--write --bypass-permissions` only when the user asked for changes to be made (a fix, an implementation, "apply it"): `--write` lets the backend change files and run commands without asking, and the companion refuses it without `--bypass-permissions` (or `AGENT_BRIDGES_ALLOW_BYPASS=1`). When `--write` is set, the companion runs Antigravity's default agent and allows every permission request; never tell the host to pass a skip-permissions flag. Without `--write`, the companion runs a restricted reader agent that can only read files by path (no writes, no commands, no listing or search) and stops the run when that reader is not in effect. That reader can read any file the user can read when given its absolute path, and what it reads goes to the model provider.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- Pass each runtime flag as its own shell argument, then `--`, then the task text as one quoted argument (use a quoted heredoc when the text contains quotes, `$`, or backticks). Never pass flags and task text together as a single string: the companion re-splits a lone argument and mangles apostrophes.
- If the forwarded request includes `--background` or `--wait`, pass it through to `task`; the companion handles foreground waiting or background detachment. Do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass the model string through to `task` verbatim.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- If the forwarded request includes `--resume-job <job-id>`, pass it to `task` verbatim with its value, together with `--write --bypass-permissions` from the request, and do not add `--resume-last`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.
- Only a write run continues an Antigravity session, and only the most recent task, when it was a write task whose prompt reached its session. `--resume-last` without `--write` starts a new read-only session, because the restricted reader cannot be attached to an earlier one. `--write --resume-last` continues the most recent task when it can, and otherwise starts a new session; it never jumps back to an older one. The output says when a new session was started and why. `--resume-job <job-id>` (write runs only) continues exactly that job, or fails and runs nothing when it cannot be continued. Never add `--write` just to continue a session the user did not ask to change.

Safety rules:
- Reviews are read-only and omit `--write`. Rescue/`task` jobs that change files pass `--write --bypass-permissions`, so the companion allows Antigravity's permission requests; never ask the host to supply a skip-permissions flag.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Antigravity cannot be invoked, return nothing.

