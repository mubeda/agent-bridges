---
name: antigravity-transfer
description: Transfer the current Claude, Codex, or Cursor session into a resumable Antigravity thread. Use when the user asks for /antigravity:transfer or a Antigravity session transfer.
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

Transfer source rules:
- By default the companion auto-detects the newest workspace transcript from Claude, Codex, or Cursor JSONL.
- Pass `--source <path-to-jsonl>` to override auto-detect (supports `~`).
- Do not invent transcript paths. If auto-detect fails, return the companion error and tell the user to retry with `--source`.
- Default to `--background`; pass `--wait` through when the user requests it.

In Antigravity, do not transfer the current session: the companion reads only Claude Code, Codex and Cursor transcripts (`.jsonl`) and would otherwise pick an older conversation of another host. Transfer there only when the user gives the path of such a transcript, with `--source <path>`. This bridge starts a separate session of the same client: a second Antigravity session over ACP, on the model the caller names with `--model` (Antigravity's default otherwise), for example a Gemini review asked for by a session on another provider's model. Start every call with `--background`, never `--wait`, even when the user asked for it: the session's shell moves a long command to the background, and a call left in the foreground can be cut off when the outer session ends. Then run `node "<plugin-root>/scripts/antigravity-companion.mjs" status <job-id> --wait` until the job is `completed`, `failed` or `cancelled` (run it again only while it is still `queued` or `running`, and stop at `failed`: `status` also reports it when the process that ran the job ended without a result), then `node "<plugin-root>/scripts/antigravity-companion.mjs" result <job-id>`. Give `status` and `result` the same `--cwd <dir>` (or `-C <dir>`) the launch had, or a job started for another workspace is not found, and add `--json` to `result` when the user asked for JSON, and return that output verbatim. Do not finish before you have read the result.

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument:

```bash
node "<plugin-root>/scripts/antigravity-companion.mjs" transfer <arguments>
```

