---
name: gemini-status
description: Show active and recent Gemini companion jobs. Use when the user asks for /gemini:status or Gemini job status.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/gemini-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/gemini`
4. `~/.config/opencode/plugins/gemini`
5. otherwise search the host plugin cache for this plugin's `scripts/gemini-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Run and return stdout verbatim:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" status $ARGUMENTS
```
