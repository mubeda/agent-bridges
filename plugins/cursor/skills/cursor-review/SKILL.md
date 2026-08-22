---
name: cursor-review
description: Run a Cursor code review of the current git work via the Cursor companion. Use when the user asks for a Cursor review.
user-invocable: true
---

Resolve `<plugin-root>` as the first directory that contains `scripts/cursor-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/cursor`
4. `~/.config/opencode/plugins/cursor`
5. otherwise search the host plugin cache for this plugin's `scripts/cursor-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Run and return stdout verbatim. Pass `--wait` or `--background` through when provided:

```bash
node "<plugin-root>/scripts/cursor-companion.mjs" review $ARGUMENTS
```

This skill is review-only. Do not patch code or pass `--write`.

