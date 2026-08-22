---
name: setup
description: Check whether the local Cursor CLI is ready and authenticated
allowed-tools: Bash(node:*), AskUserQuestion
---

Resolve `<plugin-root>` as the first directory that contains `scripts/cursor-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/cursor`
4. `~/.config/opencode/plugins/cursor`
5. otherwise search the host plugin cache for this plugin's `scripts/cursor-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Run:

```bash
node "<plugin-root>/scripts/cursor-companion.mjs" setup --json $ARGUMENTS
```

If the result says Cursor is unavailable:
- Use `AskUserQuestion` exactly once to ask whether the user wants Cursor CLI installation instructions.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Show Cursor CLI installation instructions (Recommended)`
  - `Skip for now`
- If the user chooses the instructions, direct them to
  `https://cursor.com/docs/cli/installation`. After installation, they should
  authenticate with `agent login` or set `CURSOR_API_KEY`, then rerun setup.

If Cursor is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Cursor is installed but not authenticated, preserve the guidance to run
  `agent login` or set `CURSOR_API_KEY`.

