---
name: claude-transfer
description: Transfer the current Claude, Codex, or Cursor Agent session into a resumable Claude thread.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/claude-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/claude`
4. `~/.config/opencode/plugins/claude`
5. otherwise search the host plugin cache for this plugin's `scripts/claude-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Transfer source rules:
- By default the companion auto-detects the newest workspace transcript from Claude, Codex, or Cursor Agent JSONL.
- Pass `--source <path-to-jsonl>` to override auto-detect (supports `~`).
- Do not invent transcript paths. If auto-detect fails, return the companion error and tell the user to retry with `--source`.
- Default to `--background`; pass `--wait` through when the user requests it.

Run and return stdout verbatim:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" transfer $ARGUMENTS
```
