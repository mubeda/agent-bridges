---
name: antigravity-review
description: Run a Antigravity code review of the current git work via the Antigravity companion. Use when the user asks for a Antigravity review.
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

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument, including `--wait` or `--background` when provided:

```bash
node "<plugin-root>/scripts/antigravity-companion.mjs" review <arguments>
```

This skill is review-only. Do not patch code or pass `--write`.

Antigravity reviews through a restricted reader agent with no tools: it answers only from the diff and the new files' contents that the companion puts in its prompt (up to 256 KiB). It cannot read other files, list folders, search or run commands. A larger change is cut: the result then has a line that starts with `Incomplete review:` and names the files left out entirely (the file where the cut fell is not named), and the job record in `--json` output has an `evidence` field. Keep that line in what you return, and never count such a review as a review of the whole change. If the companion reports that the restricted reader was not in effect, nothing was reviewed; return that message as is.

