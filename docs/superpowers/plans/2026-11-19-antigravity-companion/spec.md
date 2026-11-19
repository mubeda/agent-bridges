# Antigravity companion plugin and npx skills installs

Status: Approved 2026-11-19 (approved in chat by the user)
Size: full    Mode: gated    Type: feature
Source: conversation 2026-11-19 (add Antigravity support like the other providers; redo `npx skills` installs). Pattern: `docs/superpowers/specs/2026-08-21-cursor-companion-design.md`.

## Problem

agent-bridges reaches the Antigravity CLI (`agy`) only as a hidden backend of the `gemini` plugin. There is no `antigravity` plugin with its own setup, review, rescue, transfer and delegate commands, so a Claude Code, Codex, Cursor or OpenCode user cannot pick Antigravity the way they pick OpenCode, Claude or Cursor. On `agy` 1.5.12 the `gemini` plugin's read-only path can also edit files: a run without write permission created a file in a scratch repository (interview record, 2026-11-19). The `npx skills` install route recorded on 2026-11-09 is on no branch of the repository, so users can install the companions only as host plugins.

## Goals

1. A user with `agy` on PATH installs `antigravity@agent-bridges` in Claude Code, Codex, Cursor or OpenCode. They run a read-only review and a write rescue against the current git workspace, then check status, read the result, cancel the job and resume it.
2. No read-only Antigravity run, from either the `antigravity` plugin or the `gemini` plugin's `agy` backend, can change a workspace file or run a shell command.
3. A user installs any companion skill of the five plugins with `npx skills`, globally or in a project, by symlink or by copy, and the installed skill runs its companion.
4. Existing users of `opencode`, `gemini`, `claude` and `cursor` see no change in behavior, except the `gemini` read-only fix in Goal 2.

## Non-goals

- Antigravity as a host that loads these plugins with `agy plugin install`. The user scoped it out, and `agy plugin validate` rejects the current manifests (it wants `.antigravity-plugin/plugin.json`).
- Step-by-step progress in `status` from `--output-format stream-json`. Jobs report running and finished only, like the Cursor companion.
- A shared `agy` module used by both `gemini` and `antigravity`. Each plugin stays self-contained.
- A Claude Code stop review-gate for `antigravity`. Neither the Cursor nor the Claude companion has one.
- Removing the `gemini` plugin or its `agy` backend, or merging the branch `mubeda/opencode-v2-drop-gemini`.
- Making write-permission bypass opt-in. That is still an open decision for every companion (Notion "agent-bridges host compatibility").
- `agy` remote agents, projects, `--sandbox` and `--mode auto`.
- Anti-goal: a "read-only" review that passes because the model behaved, while the CLI would still have allowed a write.
- Anti-goal: an `npx skills` install that lists or installs skills but cannot find its companion script at run time.

## Users and scenarios

1. (P1) As a Claude Code or Codex user who also has Antigravity, I want `/antigravity:review`, `/antigravity:rescue` and the `antigravity-*` skills, so that I can get a second opinion or hand off a task to Antigravity without leaving my session.
2. (P1) As a user who asks for a read-only review, I want the CLI to block writes and shell commands, so that a review never changes my working tree.
3. (P2) As a user who installs skills with `npx skills` rather than a host plugin, I want the companion skills of every plugin to work after install, so that I can choose project or global scope and symlink or copy.
4. (P3) As a `gemini` plugin user whose backend is `agy`, I want read-only runs to stay read-only, so that the Gemini companion keeps its promise.

## Requirements

**Stories 1 and 2: the Antigravity companion**

### R1. Catalog listing  [Must]
The catalog validator SHALL require the `antigravity` plugin in the Claude Code, Codex, Cursor and OpenCode catalogs.
#### Scenario: all catalogs list it
- GIVEN the four catalog files with an `antigravity` entry
- WHEN `npm run validate` runs
- THEN it exits 0
#### Scenario: a catalog misses it
- GIVEN the Cursor catalog without an `antigravity` entry
- WHEN `npm run validate` runs
- THEN it exits non-zero and names the Cursor catalog and the missing plugin, and does not report success

### R2. Setup report  [Must]
WHEN setup runs, the Antigravity companion SHALL report the `agy` binary path, its version, whether `GEMINI_API_KEY` is set, the state directory, and that sign-in cannot be checked without a run, and SHALL start no `agy` model run.
#### Scenario: agy installed
- GIVEN `agy` 1.5.12 on PATH and no `GEMINI_API_KEY`
- WHEN the user runs `/antigravity:setup`
- THEN the report shows the path, `1.5.12`, "GEMINI_API_KEY not set", the state directory, and "sign in once with an interactive `agy` session"
#### Scenario: setup makes no model call
- GIVEN a fake `agy` that records its arguments
- WHEN setup runs
- THEN the only recorded call is `--version`, and no `-p` call is recorded

### R3. Binary resolution  [Must]
The Antigravity companion SHALL run the binary named by `ANTIGRAVITY_BIN` when it is set, and `agy` from PATH otherwise.
#### Scenario: override
- GIVEN `ANTIGRAVITY_BIN=/opt/agy/agy`
- WHEN any job starts
- THEN the spawned file is `/opt/agy/agy`

### R4. Missing binary  [Must]
IF the resolved binary cannot run `--version`, THEN the Antigravity companion SHALL report that Antigravity CLI is not available, with an install hint, and SHALL start no job.
#### Scenario: no agy
- GIVEN no `agy` on PATH and no `ANTIGRAVITY_BIN`
- WHEN the user runs a review
- THEN the output names the missing `agy` and the install hint, no job file is written, and the exit code is non-zero

### R5. Read-only enforcement  [Must]
WHEN a review, an adversarial review or a rescue without `--write` starts, the Antigravity companion SHALL run `agy` with every file-write tool and every shell command denied for that session.
#### Scenario: a review that tries to write
- GIVEN a clean git workspace
- WHEN a read-only run gets a prompt that asks it to create a file and run `touch shell.txt`
- THEN `git status --short` is empty afterwards, and no file was created or touched
#### Scenario: argv
- GIVEN a read-only run
- WHEN its arguments are built
- THEN they deny the write tool and shell commands, and they contain no write-permission bypass and no `--mode plan`

### R6. Write runs  [Must]
WHEN a rescue with `--write`, a delegate chunk or a transfer with `--write` starts, the Antigravity companion SHALL run `agy` with every tool permission auto-approved.
#### Scenario: rescue writes and runs commands
- GIVEN a clean git workspace
- WHEN a write rescue asks for `touch shell.txt` and a new file
- THEN both files exist afterwards

### R7. Structured review result  [Must]
WHEN a review or an adversarial review finishes, the Antigravity companion SHALL render the findings from the review-output contract that the other companions share.
#### Scenario: structured output present
- GIVEN an `agy` result whose structured output matches the review schema
- WHEN the review renders
- THEN each finding shows its severity, file, lines and recommendation
#### Scenario: no structured output
- GIVEN an `agy` result without structured output
- WHEN the review renders
- THEN the plain response text is shown with a note that no structured result came back, and no empty findings list is shown as success

### R8. Foreground and background jobs  [Must]
The Antigravity companion SHALL run each review, rescue and transfer either in the foreground (`--wait`) or as a detached background job (`--background`), with `status`, `result` and `cancel` for that job.
#### Scenario: background lifecycle
- GIVEN a background rescue
- WHEN the user runs `status`, waits for the end, and runs `result`
- THEN `status` shows the job running and then completed, and `result` prints the stored response
#### Scenario: cancel
- GIVEN a running background job
- WHEN the user runs `cancel <job>`
- THEN the `agy` process tree has ended and `status` shows the job as cancelled

### R9. Resume  [Must]
WHEN a task runs with `--resume-last` or `--resume`, the Antigravity companion SHALL continue the conversation ID stored on the latest job.
#### Scenario: resume
- GIVEN a finished job with conversation ID `C1`
- WHEN the user runs a task with `--resume-last`
- THEN `agy` receives `--conversation C1`

### R10. Unknown conversation  [Must]
IF `agy` returns a conversation ID that differs from the one requested, THEN the Antigravity companion SHALL finish the job with the warning "conversation <requested> not found; Antigravity started a new one" and SHALL store the returned ID.
#### Scenario: expired conversation
- GIVEN a resume request for `C1` and an `agy` result with conversation ID `C2`
- WHEN the job finishes
- THEN the result shows the warning naming `C1`, the job stores `C2`, and the job is not marked failed

### R11. Failed runs  [Must]
IF `agy` exits non-zero or reports a status other than `SUCCESS`, THEN the Antigravity companion SHALL mark the job failed and show the error text `agy` gave.
#### Scenario: not signed in
- GIVEN `agy` exits non-zero with "authentication required"
- WHEN the job finishes
- THEN `status` shows failed, and `result` shows "authentication required", and the job is not shown as completed

### R12. Denied actions  [Should]
IF an `agy` result lists denied actions, THEN the Antigravity companion SHALL show them in the result, and an empty response SHALL read "no answer; denied: <actions>".
#### Scenario: headless auto-deny
- GIVEN a result with an empty response and one denied `command` action named `Bash`
- WHEN the result renders
- THEN it reads "no answer; denied: command (Bash)" and is not blank

### R13. Model and effort  [Should]
WHERE the user passes `--model` or `--effort`, the Antigravity companion SHALL pass the value to `agy`.
#### Scenario: pass-through
- GIVEN `--model m1 --effort high`
- WHEN the arguments are built
- THEN they contain `--model m1` and `--effort high`

### R14. Effort validation  [Should]
IF the effort is not one of `low`, `medium`, `high`, `xhigh` or `max`, THEN the Antigravity companion SHALL reject the run before starting `agy`.
#### Scenario: bad effort
- GIVEN `--effort extreme`
- WHEN the run starts
- THEN it fails with a message that lists the five levels, and `agy` is not started

### R15. Transfer  [Must]
WHEN transfer runs, the Antigravity companion SHALL pack the current host session (Claude, Codex or Cursor, detected automatically, or the file given with `--source`) into a handoff prompt, start an `agy` run with it, and store the conversation ID for resume.
#### Scenario: transfer from Codex
- GIVEN a Codex session transcript
- WHEN the user runs the `antigravity-transfer` skill
- THEN an `agy` run starts with the packed handoff, and its conversation ID is stored
#### Scenario: no session
- GIVEN no detectable host transcript and no `--source`
- WHEN transfer runs
- THEN it fails with a message that names `--source`, and no `agy` run starts

### R16. Delegate  [Must]
The `antigravity-delegate` skill SHALL trigger only when the user explicitly asks to delegate to Antigravity, SHALL run every implementation chunk through the companion as a fresh, write-enabled background job, and SHALL leave review and commits to the host session.
#### Scenario: explicit trigger
- GIVEN the skill description
- WHEN it is read
- THEN it names explicit invocation (`/antigravity:delegate`, "delegate this to antigravity") and says never to trigger on ordinary coding requests

### R17. Long prompts on Windows  [Should]
IF the platform is win32 and the prompt is longer than 20,000 characters, THEN the Antigravity companion SHALL send the prompt on stdin and leave it out of the argument list.
#### Scenario: oversized prompt
- GIVEN a 25,000-character prompt on win32
- WHEN the arguments are built
- THEN they hold no prompt text and no `-p` value, and the prompt is written to stdin

### R18. Commands and skills  [Must]
The Antigravity companion SHALL provide the commands `setup`, `review`, `adversarial-review`, `rescue`, `status`, `result`, `cancel`, `transfer` and `delegate` for Claude Code, Cursor and OpenCode, and SHALL provide the matching `antigravity-*` skills, plus `antigravity-cli-runtime` and `antigravity-prompting`, for Codex and the skills route.
#### Scenario: names
- GIVEN the plugin tree
- WHEN the tests list its commands and skills
- THEN the nine commands and eleven skills exist with those names

**Story 4: the Gemini read-only fix**

### R19. Gemini agy read-only  [Must]
WHILE the `gemini` plugin uses the `agy` backend, the Gemini companion SHALL run every read-only job with every file-write tool and every shell command denied.
#### Scenario: gemini review on agy
- GIVEN `GEMINI_BACKEND=agy` and a clean git workspace
- WHEN a read-only Gemini run gets a prompt that asks it to create a file
- THEN `git status --short` is empty afterwards
#### Scenario: gemini CLI backend unchanged
- GIVEN `GEMINI_BACKEND=gemini`
- WHEN a read-only run's arguments are built
- THEN they equal today's arguments (`--approval-mode=plan`)

### R20. Other companions unchanged  [Must]
The test suite SHALL pass for the `opencode`, `gemini`, `claude` and `cursor` plugins with no change to their run arguments, except R19.
#### Scenario: suite
- GIVEN the finished change
- WHEN `npm test` runs
- THEN it exits 0

### R21. Documentation  [Should]
The README SHALL list `antigravity` in the plugins table and in each host's install lines, and SHALL describe the Antigravity CLI: `ANTIGRAVITY_BIN`, interactive sign-in, or `GEMINI_API_KEY` with `modelProvider: "gemini"` set in the user's own Antigravity settings, how read-only runs are enforced, and the state directory `~/.antigravity-companion/state`.
#### Scenario: readme test
- GIVEN the README
- WHEN the readme test runs
- THEN it finds the plugin in the table, each install line and the state directory list

**Story 3: npx skills installs**

### R22. Skill discovery  [Must]
WHEN a user lists the skills of `mubeda/agent-bridges` with the skills CLI, the repository SHALL offer every skill of the five plugins, 55 skills, and no folder that is not a skill.
#### Scenario: list
- GIVEN the repository at the change's commit
- WHEN the skills CLI lists its skills
- THEN it shows 55 skills, including `antigravity-review` and `gemini-cli-runtime`
#### Scenario: no extras
- GIVEN the same listing
- WHEN it is compared with the plugin trees
- THEN no command, agent, script or test folder appears as a skill

### R23. Installed skills run  [Must]
WHEN a user installs a plugin's `<plugin>-cli-runtime` skill and another skill of that plugin with the skills CLI, the installed skill SHALL find and run that plugin's companion script, in global and project scope and in symlink and copy installs.
#### Scenario: global symlink
- GIVEN a sandbox home with `antigravity-cli-runtime` and `antigravity-setup` installed globally by symlink
- WHEN the setup skill's companion command runs
- THEN it prints the setup report of R2
#### Scenario: runtime missing
- GIVEN a sandbox home with `antigravity-setup` installed without `antigravity-cli-runtime`, and no host plugin of `antigravity`
- WHEN the skill looks for its companion
- THEN it stops and names `antigravity-cli-runtime` as the missing install, and it does not report success

### R24. Companion lookup order  [Must]
Every companion skill SHALL look for its companion script in this order: the host plugin root variables, then the sibling `<plugin>-cli-runtime` skill, then the host paths and plugin caches it searches today.
#### Scenario: host plugin install unchanged
- GIVEN the plugin installed as a Claude Code plugin with its plugin root variable set
- WHEN a skill looks for its companion
- THEN it uses the companion under that plugin root, as it does today
#### Scenario: sibling runtime
- GIVEN a skills-CLI install of `antigravity-cli-runtime` and `antigravity-review` side by side, with no plugin root variable
- WHEN the review skill looks for its companion
- THEN it uses the companion inside `antigravity-cli-runtime`, and not one from a host plugin cache

### R25. Runtime copies stay in sync  [Must]
IF a file in a `<plugin>-cli-runtime` skill differs from its source in that plugin's `scripts/`, `prompts/` or `schemas/`, THEN the test suite SHALL fail and name the file.
#### Scenario: drift
- GIVEN a changed Antigravity companion script without a re-sync
- WHEN `npm test` runs
- THEN it fails and names that file
#### Scenario: re-sync
- GIVEN the same change
- WHEN `npm run sync:skills` runs and then `npm test` runs
- THEN the suite passes

### R26. Skills install guide  [Should]
The README SHALL show the skills CLI commands for global and project installs, say that `<plugin>-cli-runtime` must be installed with the other skills, and say that slash commands, agents and the Claude stop review-gate come only with a host plugin install.
#### Scenario: readme section
- GIVEN the README
- WHEN the readme test runs
- THEN it finds the skills install section with the runtime-skill sentence

## Constraints and assumptions

- `agy` version in use: 1.5.12 (`agy --version`, 2026-11-19).
- `agy` 1.5.12 flags used: `-p`, `--output-format json`, `--settings <json>` (session only, never saved), `--dangerously-skip-permissions`, `--conversation <id>`, `--model`, `--effort` (`low|medium|high|xhigh|max`), `--json-schema <string|path>`, and a prompt read from stdin. Source: `agy --help` and local runs.
- The `--output-format json` envelope has `conversation_id`, `status` (SUCCESS, ERROR, CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING), `response`, `error`, `duration_seconds`, `num_turns`, `usage`, and, with `--json-schema`, `structured_output` and `json_schema`. Source: https://antigravity.google/docs/cli/headless.md, opened 2026-11-19. 1.5.12 also emits `denied_actions` when headless mode auto-denies a tool (local run). It does not emit it when a deny rule blocks the tool.
- Permission rule syntax is `write_file(*)` and `command(*)`, and deny beats allow. Source: https://antigravity.google/docs/permissions.md and https://antigravity.google/docs/settings.md, opened 2026-11-19, and confirmed by local runs.
- The settings docs do not list `--settings`; 1.5.12's `--help` does. The installed tool governs.
- Headless runs use the cached credentials of one interactive `agy` sign-in, or `GEMINI_API_KEY` with `modelProvider: "gemini"` in settings. Source: headless and settings docs. No login-status command exists.
- Node `>=18.18.0` (`package.json`).
- The Windows argv prompt limit is 20,000 characters (`WIN32_ARGV_PROMPT_LIMIT` in every plugin).
- Catalog versions today are `0.3.1` in all four catalogs. Plugins today: `opencode` 0.3.1, and `gemini`, `claude` and `cursor` 0.2.1 (manifests, 2026-11-19).
- Each plugin has 11 skills today, so 4 plugins have 44, and 55 with `antigravity`.
- The skills CLI is vercel-labs `skills`, v1.7.6 when the earlier work was verified (Notion, 2026-11-09). Its current version and discovery format are re-checked at planning (agent's call: the earlier design was verified, but not at today's version).
- State directory order: `$PLUGIN_DATA/state`, then `$CLAUDE_PLUGIN_DATA/state`, then `~/.antigravity-companion/state` (README convention).

## Decisions

D1. Clone the Cursor companion into the new plugin and replace only its CLI layer with an `agy` backend. Alternatives considered: clone `plugins/gemini` and strip the Gemini CLI (largest removal, carries stream-json and the weak auth check); a shared `agy` module (breaks self-contained plugins and needs a sync step). Decided by: user. Source: interview, approaches.
D2. Read-only runs pass `--settings` that deny `write_file(*)` and `command(*)`, and no `--mode`. Alternatives considered: `--mode plan` alone (wrote a file on 1.5.12); `--mode plan` with deny (plan mode rewrote a review prompt as `/plan ...`, drafted a plan and tried to write plan files); allowing `git` read prefixes (`git diff --output` still writes, and user allow rules would apply). Decided by: user. Source: interview, rounds 1 and 2.
D3. Write runs use `--dangerously-skip-permissions`. Alternatives considered: `--mode accept-edits` (headless auto-denies shell, so tests cannot run); `--mode auto` (needs the sandbox and a personal account). Decided by: user.
D4. Setup reports the binary, version and `GEMINI_API_KEY`, and states that sign-in cannot be checked without a run, using no model call. Alternatives considered: a probe prompt (spends a model call on every setup); the Gemini plugin's directory check (shows "logged in" for anyone who ever ran `agy`). Decided by: user.
D5. A changed conversation ID on resume finishes the job with a warning and stores the new ID. Alternative considered: fail the job (it would hide work that already ran). Decided by: user.
D6. The `gemini` plugin keeps its `agy` backend, and its read-only runs get D2's deny settings. Alternatives considered: remove `agy` from `gemini` (breaking for its users); leave the hole and record it. Decided by: user.
D7. `antigravity` is listed in all four catalogs, the Cursor catalog included. Antigravity is not a host here, so the "a host does not list itself" rule does not apply. Decided by: user.
D8. No Claude stop review-gate in v1. Decided by: user.
D9. `npx skills` installs cover all five plugins, with the earlier design: a root discovery catalog, `<plugin>-cli-runtime` skills that carry synced copies of `scripts/`, `prompts/` and `schemas/` through `npm run sync:skills`, a byte-equality test, and a README section. Decided by: user.
D10. The binary override is `ANTIGRAVITY_BIN`, following `CURSOR_BIN` and `CLAUDE_BIN`. Decided by: agent's call, accepted by the user.
D11. Output is the single `--output-format json` envelope. Alternative considered: `stream-json` (progress events, more parser code). Decided by: agent's call, accepted by the user.
D12. `--model` and `--effort` pass through. Reviews pass the review schema with `--json-schema` and read the structured output. Decided by: agent's call, accepted by the user.
D13. No `--print-timeout` by default, as in the Cursor and Claude companions. A hung job is ended with `cancel`. Decided by: agent's call, accepted by the user.
D14. Denied actions are listed in the result, and an empty response reads "no answer; denied: …". Decided by: agent's call, accepted by the user.
D15. Transfer is a prompt handoff, like `claude-transfer` and `cursor-transfer`. `agy` has no import API. Decided by: agent's call, accepted by the user.
D16. Delegate runs chunks as `--background --fresh --write`. `agy` does not isolate jobs in worktrees, unlike `claude --bg`. Decided by: agent's call, accepted by the user.
D17. The new plugin starts at `0.1.0`, and every catalog version is bumped in the same change, as in the Cursor spec. Exact catalog numbers are set in the plan. Decided by: agent's call, accepted by the user.
D18. Companion skills look in the host plugin root variables, then in the sibling `<plugin>-cli-runtime` skill, then in today's host paths and plugin caches. When nothing is found, they name the runtime skill to install. Alternative considered: refusing any companion outside the runtime skill for a skills-CLI install (it needs a way to tell how the skill was installed, and it changes nothing for host users). Decided by: user. Source: independent read, round 3.
D19. The companion never sets `modelProvider`. API-key users set it in their own Antigravity settings. Read-only runs pass only the two deny rules, and write runs pass no `--settings`. Alternative considered: adding `modelProvider: "gemini"` when `GEMINI_API_KEY` is set (it overrides the user's provider choice and changes the pinned argv). Decided by: user. Source: independent read, round 3.
D20. The catalog validator checks that the `antigravity` entry exists, not its version. Alternatives considered: hard-coding `0.1.0` (breaks on the next bump); matching every catalog version against its manifest (new scope for all plugins). Decided by: agent's call. Source: independent read.

## Risks

- `agy` is young (1.5.x) and its flags may change. The undocumented `--settings` flag carries D2. -> Argument tests pin the read-only argv. A manual check against the real `agy` (R5, R19) is part of verification, and setup prints the version so reports show which one ran.
- A future `agy` tool that writes files under another rule name would bypass `write_file(*)`. -> The real-binary check in R5 asks for a file write without naming a tool, so a new write tool shows up as a failure. The risk is recorded in the README next to the read-only note.
- `--dangerously-skip-permissions` lets write runs do anything the user can. -> Same exposure as the Claude companion. Making it opt-in stays an open decision for every companion (Non-goals).
- The skills CLI format may have changed since 1.7.6. -> Planning re-checks it against the current version before any task depends on it.
- Duplicated library code across five plugins can drift. -> This is the repo's accepted trade-off (D1). The tests for each plugin pin its behavior.

## Verification

| Requirement | How it is checked |
|---|---|
| R1 | `tests/catalogs.test.mjs` and `npm run validate`, including a fixture without `antigravity` |
| R2, R3, R4 | backend tests with a fake `agy` binary that records its arguments; a missing-binary case |
| R5, R6 | argument tests; a manual run against the real `agy` in a scratch git repo, with `git status --short` before and after |
| R7, R11, R12 | parser and render tests on captured 1.5.12 envelopes (success, structured output, empty response with `denied_actions`, error) |
| R8 | job tests in the style of `tests/cursor-jobs.test.mjs`, plus `tests/background.test.mjs` for detach and cancel |
| R9, R10 | job tests with a fake `agy` that returns the requested or a different conversation ID |
| R13, R14, R17 | argument tests, with win32 as an injected platform |
| R15 | `tests/transfer-dest.test.mjs` and `tests/host-session.test.mjs` cases for `antigravity` |
| R16, R18 | the tree tests (`tests/copy-plugins.test.mjs`, `tests/markdown-lookup.test.mjs`) that list command and skill names and read the delegate description |
| R19 | `tests/gemini-args.test.mjs` read-only `agy` and `gemini` cases; one manual real-`agy` run |
| R20 | `npm test` exits 0 |
| R21, R26 | `tests/readme.test.mjs` |
| R22, R23, R24 | a sandbox-home install with the skills CLI: list, then a global symlink install and a project copy install, each running a setup skill; a lookup-order test over every SKILL.md |
| R25 | a skill-runtime test that compares bytes, and a drift case |

Input classes no scenario covers, and the expected behavior:

- A `--settings` JSON that `agy` rejects: the run fails, and R11 shows `agy`'s error.
- A prompt read from stdin on other platforms: not used. Only win32 above the limit uses stdin (R17).
- An `agy` result that is not JSON: R7's plain-text path, marked as failed when the exit code is non-zero (R11).
- A user `settings.json` that allows `command(*)`: the session deny still wins, because deny beats allow (D2).
- A rescue with no prompt and no resume, or two jobs started at once in one workspace: the same behavior as the Cursor companion, which this plugin clones (D1).

## Appendix: interview record

- 2026-11-19 Evidence: `README.md`, `plugins/gemini/scripts/lib/gemini.mjs` / Decision: `agy` is a backend of `gemini` on `main`. The branch `mubeda/opencode-v2-drop-gemini` removes `gemini` and is unmerged.
- 2026-11-19 Q: scope / Recommended: companion plugin / Decision: companion plugin; Antigravity as host out of scope.
- 2026-11-19 Q: base branch / Recommended: drop-gemini with main merged / Decision: origin/main, keep `gemini`.
- 2026-11-19 Q: process / Recommended: spec, then plan / Decision: spec with mstack-write-specs, then mstack-plan.
- 2026-11-19 Q: lost `npx skills` work / Recommended: out of scope / Decision: include it.
- 2026-11-19 Evidence: local `agy` 1.5.12 runs in a scratch repo / Decision: `--mode plan` wrote a file; default mode writes; headless auto-denies shell without an allow rule and still exits 0 with `status: SUCCESS`; `--settings` deny of `write_file(*)` and `command(*)` blocked both in plan and default mode; `--conversation` with an unknown ID warns on stderr, starts a new conversation and exits 0; `--dangerously-skip-permissions` allowed both; `--json-schema` returned `structured_output`; a prompt on stdin worked; plan mode rewrote a prompt as `/plan ...`.
- 2026-11-19 Evidence: mstack-research on the Antigravity docs (headless, permissions, settings, modes, build-plugins pages) / Decision: as in Constraints.
- 2026-11-19 Q: read-only mapping / Recommended: plan mode plus deny / Decision: accepted, then reopened on the plan-mode evidence; final: deny only, no `--mode`.
- 2026-11-19 Q: write mapping / Recommended: `--dangerously-skip-permissions` / Decision: accepted.
- 2026-11-19 Q: gemini `agy` backend / Recommended: keep it and add the deny fix / Decision: accepted.
- 2026-11-19 Q: setup auth / Recommended: no model call, state that sign-in can't be checked / Decision: accepted.
- 2026-11-19 Q: unknown conversation / Recommended: warn and store the new ID / Decision: accepted.
- 2026-11-19 Q: hosts / Recommended: all four catalogs / Decision: accepted.
- 2026-11-19 Q: review-gate / Recommended: none in v1 / Decision: accepted.
- 2026-11-19 Q: `npx skills` scope / Recommended: all five plugins, earlier design, second story / Decision: accepted.
- 2026-11-19 Q: agent's calls A to I (bin override, JSON output, pass-through, schema, no timeout, denied actions, transfer, delegate, versions) / Recommended: as listed / Decision: accepted.
- 2026-11-19 Q: approach / Recommended: A (clone cursor) / Decision: A.
- 2026-11-19 Evidence: independent read (fresh reader, opus) / Decision: three gaps found; the version check settled as an agent's call (D20).
- 2026-11-19 Q: companion lookup order for skills-CLI installs / Recommended: plugin root variables, then sibling runtime, then today's chain / Decision: accepted (D18, R24).
- 2026-11-19 Q: API-key users and `modelProvider` / Recommended: leave it to the user's own settings / Decision: accepted (D19).
