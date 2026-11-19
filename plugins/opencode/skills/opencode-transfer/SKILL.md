---
name: opencode-transfer
description: Transfer the current Claude, Codex, or Cursor Agent session into a resumable OpenCode thread. Use when the user asks for /opencode:transfer or an OpenCode session transfer.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/opencode-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. the `opencode-cli-runtime` folder next to the folder that holds this SKILL.md (`<this skill's folder>/../opencode-cli-runtime`, installed with `npx skills`)
4. `~/.cursor/plugins/local/opencode`
5. `~/.config/opencode/plugins/opencode`
6. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/opencode-companion.mjs`

If none exist, stop and print those paths, and say that an `npx skills` install also needs `opencode-cli-runtime`. Do not invent a companion elsewhere.

Transfer source rules:
- By default the companion auto-detects the newest workspace transcript from Claude, Codex, or Cursor Agent JSONL.
- Pass `--source <path-to-jsonl>` to override auto-detect (supports `~`).
- Do not invent transcript paths. If auto-detect fails, return the companion error and tell the user to retry with `--source`.

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument:

```bash
node "<plugin-root>/scripts/opencode-companion.mjs" transfer <arguments>
```
