---
name: transfer
description: Transfer the current host session into a resumable OpenCode thread
argument-hint: '[--source <jsonl-path>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Resolve `<plugin-root>` as the first directory that contains `scripts/opencode-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/opencode`
4. `~/.config/opencode/plugins/opencode`
5. otherwise search the host plugin cache for this plugin's `scripts/opencode-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Run:

```bash
node "<plugin-root>/scripts/opencode-companion.mjs" transfer $ARGUMENTS
```

Present the command stdout to the user exactly as returned. Preserve any session ID and resume command.
