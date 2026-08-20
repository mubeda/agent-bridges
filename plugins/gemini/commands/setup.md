---
name: setup
description: Check whether the local Gemini CLI is ready and authenticated
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Resolve `<plugin-root>` as the first directory that contains `scripts/gemini-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/gemini`
4. `~/.config/opencode/plugins/gemini`
5. otherwise search the host plugin cache for this plugin's `scripts/gemini-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Run:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" setup --json $ARGUMENTS
```

Present the resulting setup report to the user verbatim.

If `gemini.available` is false:
- Surface the install hint from the report (`npm install -g @google/gemini-cli` or `brew install gemini-cli`).

If `gemini.available` is true but `auth.loggedIn` is false:
- Surface the auth hint from the report:
  - Export `GEMINI_API_KEY` (from https://aistudio.google.com/apikey), **or**
  - Set the Vertex triple: `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`.

Do not run any other commands. Do not install anything automatically.
