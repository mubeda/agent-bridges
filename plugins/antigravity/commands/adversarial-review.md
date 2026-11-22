---
name: adversarial-review
description: Run a Antigravity review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Antigravity review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Antigravity's output verbatim to the user.
- Antigravity reviews through a restricted reader agent with no tools: it answers only from the diff and the new files' contents that the companion puts in its prompt (up to 256 KiB). It cannot read other files, list folders, search or run commands. When any file of the change was not shown in full (a larger change is cut at the budget, and an untracked file that is too large, binary, a link or unreadable is only named), the result has a line that starts with `Incomplete review:` and names those files, and the job record in `--json` output has an `evidence` field with `incomplete: true` and the lists. Keep that line in what you return, and never count such a review as a review of the whole change. If the companion reports that the restricted reader was not in effect, nothing was reviewed; return that message as is.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run through the companion's background mode.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- The companion script handles `--wait` and `--background`; its background mode detaches the review itself.
- `/antigravity:adversarial-review` uses the same review target selection as `/antigravity:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `/antigravity:review`, it can still take extra focus text after the flags.

Resolve `<plugin-root>` as the first directory that contains `scripts/antigravity-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/antigravity`
4. `~/.config/opencode/plugins/antigravity`
5. otherwise search the host plugin cache (for example `~/.codex/plugins/cache` or `~/.claude/plugins/cache`) for this plugin's `scripts/antigravity-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Pass each flag from the arguments as its own shell argument (`<flags>`), and send any free-form focus text on stdin as shown, never as an argument. Without focus text, drop `--focus-stdin` and the heredoc.

Foreground flow:
- Run:
```bash
node "<plugin-root>/scripts/antigravity-companion.mjs" adversarial-review <flags> --focus-stdin <<'FOCUS_TEXT'
<focus text>
FOCUS_TEXT
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- If `--background` is present, run the companion normally and include all of the user's flags:
```bash
node "<plugin-root>/scripts/antigravity-companion.mjs" adversarial-review <flags> --focus-stdin <<'FOCUS_TEXT'
<focus text>
FOCUS_TEXT
```
- The companion detaches the review itself. Do not wait for completion in this turn.
- After launching the command, tell the user: "Antigravity adversarial review started in the background. Check `/antigravity:status` for progress."

