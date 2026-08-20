---
name: gemini-transfer
description: Transfer the current Claude, Codex, or Cursor Agent session into a resumable Gemini thread. Use when the user asks for /gemini:transfer or a Gemini session transfer.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/gemini-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/gemini`
4. `~/.config/opencode/plugins/gemini`
5. otherwise search the host plugin cache for this plugin's `scripts/gemini-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Transfer source rules:
- By default the companion auto-detects the newest workspace transcript from Claude, Codex, or Cursor Agent JSONL.
- Pass `--source <path-to-jsonl>` to override auto-detect (supports `~`).
- Do not invent transcript paths. If auto-detect fails, return the companion error and tell the user to retry with `--source`.

Run and return stdout verbatim:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" transfer $ARGUMENTS
```
