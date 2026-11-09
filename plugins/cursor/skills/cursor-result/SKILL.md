---
name: cursor-result
description: Show the stored final output for a Cursor companion job. Use when the user asks for /cursor:result.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/cursor-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/cursor`
4. `~/.config/opencode/plugins/cursor`
5. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/cursor-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument:

```bash
node "<plugin-root>/scripts/cursor-companion.mjs" result <arguments>
```

