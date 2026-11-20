---
name: claude-result
description: Show the stored final output for a Claude companion job. Use when the user asks for the result of a Claude companion job.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/claude-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. the `claude-cli-runtime` folder next to the folder that holds this SKILL.md (`<this skill's folder>/../claude-cli-runtime`, installed with `npx skills`)
4. `~/.cursor/plugins/local/claude`
5. `~/.config/opencode/plugins/claude`
6. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/claude-companion.mjs`

If none exist, stop and print those paths, and say that an `npx skills` install also needs `claude-cli-runtime`. Do not invent a companion elsewhere.

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" result <arguments>
```
