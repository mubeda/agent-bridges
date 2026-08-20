---
name: setup
description: Check whether the local OpenCode CLI is ready and authenticated
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Resolve `<plugin-root>` as the first directory that contains `scripts/opencode-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/opencode`
4. `~/.config/opencode/plugins/opencode`
5. otherwise search the host plugin cache for this plugin's `scripts/opencode-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Run:

```bash
node "<plugin-root>/scripts/opencode-companion.mjs" setup --json $ARGUMENTS
```

If the result says OpenCode is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install OpenCode now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install OpenCode (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g opencode-ai
```

- Then rerun:

```bash
node "<plugin-root>/scripts/opencode-companion.mjs" setup --json $ARGUMENTS
```

If OpenCode is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If OpenCode is installed but no providers are configured, preserve the guidance to run `!opencode auth login`.
