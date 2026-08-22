---
name: result
description: Show the stored final output for a finished Cursor job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Resolve `<plugin-root>` as the first directory that contains `scripts/cursor-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/cursor`
4. `~/.config/opencode/plugins/cursor`
5. otherwise search the host plugin cache for this plugin's `scripts/cursor-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Then run:

```bash
node "<plugin-root>/scripts/cursor-companion.mjs" result "$ARGUMENTS"
```

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including the captured assistant output, file changes, and any error details
- File paths and line numbers exactly as reported
- Any error messages
- Follow-up commands such as `/cursor:status <id>` and `/cursor:review`

