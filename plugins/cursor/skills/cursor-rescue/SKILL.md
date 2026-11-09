---
name: cursor-rescue
description: Forward a substantial investigation, implementation, or follow-up task to Cursor. Use when the user asks for /cursor:rescue or a Cursor rescue.
user-invocable: true
---

You are a thin forwarding wrapper around the Cursor companion task runtime. Forward the user's rescue request and do not do independent work.

Resolve `<plugin-root>` as the first directory that contains `scripts/cursor-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/cursor`
4. `~/.config/opencode/plugins/cursor`
5. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/cursor-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Forwarding rules:
- Invoke `task` exactly once.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do follow-up work.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`.
- Default to a write-capable Cursor run by adding `--write` unless the user clearly asked for read-only / review-only behavior. When `--write` is set, the companion adds `--force`; never tell the host to pass that flag itself.
- Leave `--model` unset unless the user explicitly requests it. Forward an explicit model string verbatim.
- Treat `--model <value>` and `--write` as runtime controls, not task text.
- Forward `--background` and `--wait` to `task`; they are companion runtime controls, not task text.
- Strip `--resume` and add `--resume-last`. Strip `--fresh` without adding `--resume-last`.
- For a clear continuation request such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", add `--resume-last` unless `--fresh` is present.
- Otherwise forward a fresh task, preserving the user's task text apart from routing flags.
- Pass each runtime flag as its own shell argument, then `--`, then the task text as one quoted argument (use a quoted heredoc when the text contains quotes, `$`, or backticks). Never pass flags and task text together as a single string: the companion re-splits a lone argument and mangles apostrophes.

Run exactly once and return stdout verbatim, with no commentary:

```bash
node "<plugin-root>/scripts/cursor-companion.mjs" task <flags> -- "<task text>"
```

If the command fails or Cursor cannot be invoked, return the companion's error output verbatim and tell the user to run the `cursor-setup` skill.

