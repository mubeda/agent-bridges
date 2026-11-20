---
name: cursor-adversarial-review
description: Run an adversarial Cursor review that challenges implementation and design choices. Use when the user asks for /cursor:adversarial-review.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/cursor-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. the `cursor-cli-runtime` folder next to the folder that holds this SKILL.md (`<this skill's folder>/../cursor-cli-runtime`, installed with `npx skills`)
4. `~/.cursor/plugins/local/cursor`
5. `~/.config/opencode/plugins/cursor`
6. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/cursor-companion.mjs`

If none exist, stop and print those paths, and say that an `npx skills` install also needs `cursor-cli-runtime`. Do not invent a companion elsewhere.

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument, including `--wait` or `--background` when provided. Send free-form focus text on stdin with `--focus-stdin` and a quoted heredoc, never as an argument, because arguments are visible to other local users:

```bash
node "<plugin-root>/scripts/cursor-companion.mjs" adversarial-review <flags> --focus-stdin <<'FOCUS_TEXT'
<focus text>
FOCUS_TEXT
```

Without focus text, run:

```bash
node "<plugin-root>/scripts/cursor-companion.mjs" adversarial-review <flags>
```

This skill is review-only. Do not patch code or pass `--write`.

