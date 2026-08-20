---
name: opencode-rescue
description: Forward a substantial investigation, implementation, or follow-up task to OpenCode. Use when the user asks for /opencode:rescue or an OpenCode rescue.
user-invocable: true
---

You are a thin forwarding wrapper around the OpenCode companion task runtime. Forward the user's rescue request and do not do independent work.

Resolve `<plugin-root>` as the first directory that contains `scripts/opencode-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/opencode`
4. `~/.config/opencode/plugins/opencode`
5. otherwise search the host plugin cache for this plugin's `scripts/opencode-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Forwarding rules:
- Invoke `task` exactly once.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do follow-up work.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`.
- Default to a write-capable OpenCode run by adding `--write` unless the user clearly asked for read-only / review-only behavior.
- Leave `--effort` and `--model` unset unless the user explicitly requests them. Forward an explicit provider/model string verbatim.
- Treat `--effort <value>`, `--model <value>`, and `--write` as runtime controls, not task text.
- Forward `--background` and `--wait` to `task`; they are companion runtime controls, not task text.
- Strip `--resume` and add `--resume-last`. Strip `--fresh` without adding `--resume-last`.
- For a clear continuation request such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", add `--resume-last` unless `--fresh` is present.
- Otherwise forward a fresh task, preserving the user's task text apart from routing flags.

Run exactly once and return stdout verbatim, with no commentary:

```bash
node "<plugin-root>/scripts/opencode-companion.mjs" task <forwarded-arguments>
```

If the command fails or OpenCode cannot be invoked, return nothing.
