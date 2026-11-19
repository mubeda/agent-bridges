---
name: opencode-adversarial-review
description: Run an adversarial OpenCode review that challenges implementation and design choices. Use when the user asks for /opencode:adversarial-review.
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

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument, including `--wait` or `--background` when provided. Put free-form focus text last, as one quoted argument after `--`:

```bash
node "<plugin-root>/scripts/opencode-companion.mjs" adversarial-review <arguments>
```

This skill is review-only. Do not patch code.
