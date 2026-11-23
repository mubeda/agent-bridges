---
name: antigravity-status
description: Show active and recent Antigravity companion jobs. Use when the user asks for /antigravity:status or Antigravity job status.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/antigravity-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. the `antigravity-cli-runtime` folder next to the folder that holds this SKILL.md (`<this skill's folder>/../antigravity-cli-runtime`, installed with `npx skills`)
4. `~/.cursor/plugins/local/antigravity`
5. `~/.config/opencode/plugins/antigravity`
6. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/antigravity-companion.mjs`

If none exist, stop and print those paths, and say that an `npx skills` install also needs `antigravity-cli-runtime`. Do not invent a companion elsewhere.

Run the companion from its own folder and name the workspace with `--cwd`, as below: `<workspace>` is the absolute path of the folder this session works in. Never start `node` with the workspace as the shell's current folder: on Windows the shell looks there for `node.exe` before PATH, so one checked into the workspace would run as the user.

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument:

```bash
cd "<plugin-root>" && node scripts/antigravity-companion.mjs status --cwd "<workspace>" <arguments>
```

