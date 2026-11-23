---
name: setup
description: Check whether the local Antigravity CLI is ready
allowed-tools: Bash(node:*), AskUserQuestion
---

Resolve `<plugin-root>` as the first directory that contains `scripts/antigravity-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/antigravity`
4. `~/.config/opencode/plugins/antigravity`
5. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/antigravity-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Run:

```bash
node "<plugin-root>/scripts/antigravity-companion.mjs" setup --json $ARGUMENTS
```

If the result says Antigravity is unavailable:
- Use `AskUserQuestion` exactly once to ask whether the user wants Antigravity CLI installation instructions.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Show Antigravity CLI installation instructions (Recommended)`
  - `Skip for now`
- If the user chooses the instructions, direct them to
  `https://antigravity.google/docs/cli/acp.md`. After installation, they should
  sign in once with an interactive `agy` session (or run `agy acp --login`), then
  rerun setup. The bridge talks to Antigravity through its ACP server and supports
  only the Google sign-in cached by `agy`; API keys are not supported.

If Antigravity is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- Preserve the sign-in note from the setup output: sign-in cannot be checked without a
  run, so the user signs in once with an interactive `agy` session or `agy acp --login`.

