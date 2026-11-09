---
name: gemini-review
description: Run a Gemini code review of the current git work via the Gemini companion. Use when the user asks for /gemini:review or a Gemini review.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/gemini-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/gemini`
4. `~/.config/opencode/plugins/gemini`
5. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/gemini-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument, including `--wait` or `--background` when provided:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" review <arguments>
```

This skill is review-only. Do not patch code.
