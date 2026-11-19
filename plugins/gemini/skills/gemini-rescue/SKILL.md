---
name: gemini-rescue
description: Forward a substantial investigation, implementation, or follow-up task to Gemini. Use when the user asks for /gemini:rescue or a Gemini rescue.
user-invocable: true
---

You are a thin forwarding wrapper around the Gemini companion task runtime. Forward the user's rescue request and do not do independent work.

Resolve `<plugin-root>` as the first directory that contains `scripts/gemini-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. the `gemini-cli-runtime` folder next to the folder that holds this SKILL.md (`<this skill's folder>/../gemini-cli-runtime`, installed with `npx skills`)
4. `~/.cursor/plugins/local/gemini`
5. `~/.config/opencode/plugins/gemini`
6. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/gemini-companion.mjs`

If none exist, stop and print those paths, and say that an `npx skills` install also needs `gemini-cli-runtime`. Do not invent a companion elsewhere.

Forwarding rules:
- Invoke `task` exactly once.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do follow-up work.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`.
- Default to a read-only run. Add `--write --bypass-permissions` only when the user asked for changes to be made (a fix, an implementation, "apply it"): `--write` lets the backend change files and run commands without asking, and the companion refuses it without `--bypass-permissions` (or `AGENT_BRIDGES_ALLOW_BYPASS=1`).
- Leave `--model` unset unless the user explicitly requests it. Forward an explicit alias or model id verbatim.
- Leave `--effort` unset unless the user explicitly requests it (`low|medium|high`). Forward `--effort` for `agy`; on Gemini CLI the companion ignores it and prints the existing deprecation note.
- Treat `--model <value>`, `--effort <value>`, `--write`, `--bypass-permissions` and `--trust` as runtime controls, not task text.
- Forward `--background` and `--wait` to `task`; they are companion runtime controls, not task text.
- Strip `--resume` and add `--resume-last`. Strip `--fresh` without adding `--resume-last`.
- For a clear continuation request such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", add `--resume-last` unless `--fresh` is present.
- Otherwise forward a fresh task, preserving the user's task text apart from routing flags.
- Pass each runtime flag as its own shell argument, then `--`, then the task text as one quoted argument (use a quoted heredoc when the text contains quotes, `$`, or backticks). Never pass flags and task text together as a single string: the companion re-splits a lone argument and mangles apostrophes.

Run exactly once and return stdout verbatim, with no commentary:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" task <flags> -- "<task text>"
```

If the command fails or Gemini cannot be invoked, return the companion's error output verbatim and tell the user to run the `gemini-setup` skill.
