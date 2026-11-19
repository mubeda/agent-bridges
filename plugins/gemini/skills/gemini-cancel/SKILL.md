---
name: gemini-cancel
description: Cancel an active Gemini companion job. Use when the user asks for /gemini:cancel.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/gemini-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. the `gemini-cli-runtime` folder next to the folder that holds this SKILL.md (`<this skill's folder>/../gemini-cli-runtime`, installed with `npx skills`)
4. `~/.cursor/plugins/local/gemini`
5. `~/.config/opencode/plugins/gemini`
6. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/gemini-companion.mjs`

If none exist, stop and print those paths, and say that an `npx skills` install also needs `gemini-cli-runtime`. Do not invent a companion elsewhere.

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" cancel <arguments>
```
