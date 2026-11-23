---
name: result
description: Show the stored final output for a finished Antigravity job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(cd:*), Bash(node:*)
---

Resolve `<plugin-root>` as the first directory that contains `scripts/antigravity-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/antigravity`
4. `~/.config/opencode/plugins/antigravity`
5. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/antigravity-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Run the companion from its own folder and name the workspace with `--cwd`, as below: `<workspace>` is the absolute path of the folder this session works in. Never start `node` with the workspace as the shell's current folder: on Windows the shell looks there for `node.exe` before PATH, so one checked into the workspace would run as the user.

Then run:

```bash
cd "<plugin-root>" && node scripts/antigravity-companion.mjs result --cwd "<workspace>" "$ARGUMENTS"
```

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including the captured assistant output, file changes, and any error details
- File paths and line numbers exactly as reported
- Any error messages
- Follow-up commands such as `/antigravity:status <id>` and `/antigravity:review`

