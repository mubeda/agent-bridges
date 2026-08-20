---
name: gemini-cli-runtime
description: Internal helper contract for calling the gemini-companion runtime
user-invocable: false
---

# Gemini Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Resolve `<plugin-root>` as the first directory that contains `scripts/gemini-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/gemini`
4. `~/.config/opencode/plugins/gemini`
5. otherwise search the host plugin cache for this plugin's `scripts/gemini-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Primary helper:
- `node "<plugin-root>/scripts/gemini-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Gemini CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `gemini:gemini-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gemini-prompting` skill to rewrite the user's request into a tighter Gemini prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave the model unset by default. Add `--model` only when the user explicitly asks for one, and pass the alias or id verbatim. Supported aliases: `auto` (default, routes Pro↔Flash by phase), `pro` (Gemini Pro), `flash` (Gemini 2.5 Flash), `flash-lite` (Gemini 2.5 Flash-Lite). Full ids like `gemini-3-pro-preview` are also accepted.
- Leave `--effort` unset unless the user explicitly requests it (`low|medium|high`). Forward `--effort` for `agy`; on Gemini CLI the companion ignores it and prints the existing deprecation note.
- Default to a write-capable Gemini run by adding `--write` unless the user clearly asked for read-only / review-only behavior.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, pass it through to `task`; the companion handles foreground waiting or background detachment. Do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass the alias or id through to `task` verbatim.
- If the forwarded request includes `--effort`, pass it through to `task` (`low|medium|high` for `agy`; Gemini CLI ignores it with the companion note).
- If the forwarded request includes `--write`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run. Translates to `gemini -r latest`.

Safety rules:
- Default rescue/`task` jobs pass `--write` so the companion can complete unattended edits. Omit `--write` only when the user clearly asked for read-only / review-only behavior. Reviews use plan/read-only mode. If the user asks for a read-only investigation, say so in the forwarded prompt when `--write` is omitted.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Gemini cannot be invoked, return nothing.
