---
name: claude-adversarial-review
description: Run an adversarial Claude review that challenges implementation and design choices.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/claude-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/claude`
4. `~/.config/opencode/plugins/claude`
5. otherwise search the host plugin cache for this plugin's `scripts/claude-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Run and return stdout verbatim. Pass `--wait` or `--background` through when provided:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" adversarial-review $ARGUMENTS
```

This skill is review-only. Do not patch code or pass `--write`.
