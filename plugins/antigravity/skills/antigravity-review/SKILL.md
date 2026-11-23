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

Run the companion from its own folder and name the workspace with `--cwd`, as below: `<workspace>` is the absolute path of the folder this session works in. Never start `node` with the workspace as the shell's current folder: on Windows the shell looks there for `node.exe` before PATH, so one checked into the workspace would run as the user.

User arguments (hosts that support it substitute them here; otherwise take them from the user's request): `$ARGUMENTS`

Run and return stdout verbatim. Pass each flag and its value as a separate shell argument, including `--wait` or `--background` when provided:

```bash
cd "<plugin-root>" && node scripts/antigravity-companion.mjs review --cwd "<workspace>" <arguments>
```

This skill is review-only. Do not patch code or pass `--write`.

Antigravity reviews through a restricted reader agent with no tools: it answers only from the diff and the new files' contents that the companion puts in its prompt (up to 256 KiB). It cannot read other files, list folders, search or run commands. When any file of the change was not shown in full (a larger change is cut at the budget, and an untracked file that is too large, binary, a link or unreadable is only named), the result has a line that starts with `Incomplete review:` and names those files, and the job record in `--json` output has an `evidence` field with `incomplete: true` and the lists. Keep that line in what you return, and never count such a review as a review of the whole change. If the companion reports that the restricted reader was not in effect, nothing was reviewed; return that message as is.

In Antigravity, this bridge starts a separate session of the same client: a second Antigravity session over ACP, on the model the caller names with `--model` (Antigravity's default otherwise), for example a Gemini review asked for by a session on another provider's model. Start every call with `--background`, never `--wait`, even when the user asked for it: the session's shell moves a long command to the background, and a call left in the foreground can be cut off when the outer session ends. Run every command of this flow, the launch included, in the form above, and give `--include` and `--source` paths as absolute paths. Then run `cd "<plugin-root>" && node scripts/antigravity-companion.mjs status <job-id> --wait --cwd "<workspace>"` until the job is `completed`, `failed` or `cancelled` (run it again while it reports any other state; when it has returned a state other than those three 10 times in a row, stop polling and do not fetch the result: report the job id to the user as stuck, or, when that state is `cancelling`, as a cancellation that was interrupted), then `cd "<plugin-root>" && node scripts/antigravity-companion.mjs result <job-id> --cwd "<workspace>"`. `status` and `result` carry the same `--cwd` as the launch, or a job started for another workspace is not found. Add `--json` to `result` when the user asked for JSON, and return that output verbatim. Do not finish before you have read the result.
