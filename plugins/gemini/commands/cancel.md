---
name: cancel
description: Cancel an active background Gemini job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Resolve `<plugin-root>` as the first directory that contains `scripts/gemini-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/gemini`
4. `~/.config/opencode/plugins/gemini`
5. otherwise search the host plugin cache for this plugin's `scripts/gemini-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Then run:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" cancel "$ARGUMENTS"
```
