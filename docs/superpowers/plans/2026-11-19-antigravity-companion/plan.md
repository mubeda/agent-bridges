# Antigravity companion plugin and npx skills installs

Status: Approved 2026-11-19 (approved in chat by the user)
Spec: spec.md (Status line: Approved 2026-11-19 (approved in chat by the user), sha256 003d064427de)
Repository: ../../../.. (the agent-bridges repository root)
Base: main (at d3f4948, the merge of PR #2)

## Goal

1. A user with `agy` on PATH installs `antigravity@agent-bridges` in Claude Code, Codex, Cursor or OpenCode, then runs a read-only review and a write rescue, checks status, reads the result, cancels and resumes.
2. No read-only Antigravity run, from `antigravity` or from the `agy` backend of `gemini`, can change a workspace file or run a shell command.
3. Every companion skill of the five plugins installs with `npx skills` and finds its companion, while host-plugin installs behave as today.

## Global constraints

- `agy` 1.5.12 is the version the plan was checked against (spec › Constraints).
- The read-only `--settings` value is exactly `{"permissions":{"deny":["write_file(*)","command(*)"]}}`, and read-only runs pass no `--mode` (spec D2, R5, R19).
- Write runs pass `--dangerously-skip-permissions` and no `--settings` (spec D3, D19).
- The output format is `--output-format json`, a single envelope with `conversation_id`, `status`, `response`, `error`, `structured_output`, `denied_actions` and `usage` (spec › Constraints, D11).
- Effort levels: `low`, `medium`, `high`, `xhigh`, `max` (R13, R14).
- The binary override is `ANTIGRAVITY_BIN`, with `agy` as the default (R3, D10).
- State dir: `$PLUGIN_DATA/state`, then `$CLAUDE_PLUGIN_DATA/state`, then `~/.antigravity-companion/state` (spec › Constraints).
- The Windows argv prompt limit is 20,000 characters, and longer prompts go on stdin (R17).
- The unknown-conversation warning text is `conversation <requested> not found; Antigravity started a new one` (R10).
- The empty-response text with denied actions is `no answer; denied: <action> (<display_name>)[, ...]` (R12).
- The companion never sets `modelProvider` (D19).
- Versions: `antigravity` 0.1.0; `opencode` 0.3.1 → 0.3.2; `gemini`, `claude` and `cursor` 0.2.1 → 0.2.2; all four catalogs 0.3.1 → 0.4.0 (D17, plan P4).
- 55 skills in five plugins, 11 each (R22).
- The skill lookup order is: `$CLAUDE_PLUGIN_ROOT`, `$PLUGIN_ROOT`, the sibling `../<plugin>-cli-runtime` folder, then the existing host paths and plugin-cache search (R24, D18).
- Node `>=18.18.0`, ESM, `node:test`, no dependencies (`package.json`).

## Review focus

1. A read-only argv that drops or misquotes the deny JSON, so `agy` ignores it. `agy` ignores rules it cannot parse (settings docs). Pinned by Task 1.4 (literal argv equality) and Task 2.1, plus the manual real-`agy` step in both.
2. A review that ignores `structured_output` and parses `response` text, or the other way round, so it shows no findings while reporting success. Pinned by Task 1.5.
3. A resume that silently starts a new conversation without the warning, or stores the old ID. Pinned by Task 1.5 (parser, job record and the next resume, end to end).
4. A skills-CLI runtime copy that drifts from the source after a later edit to a companion script. Pinned by Task 3.2.
5. A lookup-order edit that changes the host-plugin lookup (Goal 4). Pinned by Task 3.3, which asserts the first two entries are unchanged in all 50 skills.

## Out of scope

- Antigravity as a host (`agy plugin install`): scoped out by the user. The manifests don't validate there.
- `stream-json` progress events: the single JSON envelope was chosen (D11).
- A shared `agy` module: plugins stay self-contained (D1).
- A Claude stop review-gate for `antigravity`: none in v1 (D8).
- Removing `gemini` or its `agy` backend, or merging `mubeda/opencode-v2-drop-gemini`: the user kept `gemini` (D6).
- Opt-in write bypass: still open for every companion.
- `agy` remote agents, projects, `--sandbox` and `--mode auto`: not needed.
- A real `npx skills` install run: unit tests only, by the user's choice (P3).

## Sources

- Repository rules: none. There is no AGENTS.md, CLAUDE.md or CONTRIBUTING.
- Repository docs: `README.md` (install lines, state dirs and the host table, which readme tests pin); `docs/superpowers/specs/2026-08-21-cursor-companion-design.md` and `docs/superpowers/plans/2026-08-21-cursor-companion.md` (how the last companion was cloned, catalog rules and version bumps).
- External, Antigravity CLI docs, opened 2026-11-19 through mstack-research: https://antigravity.google/docs/cli/headless.md (the JSON envelope, stream events, `--conversation`, credentials); https://antigravity.google/docs/permissions.md (rule syntax `write_file(*)`, `command(*)`); https://antigravity.google/docs/settings.md (deny beats allow, `modelProvider`, `GEMINI_API_KEY`); https://antigravity.google/docs/cli/modes.md (plan mode is advisory).
- External, local `agy` 1.5.12 runs in a scratch repo, 2026-11-19, recorded in spec › Appendix:
  - plan mode wrote a file;
  - the deny settings blocked writes and shell in both plan and default mode;
  - an unknown `--conversation` started a new conversation with exit 0;
  - `--json-schema` returned `structured_output`;
  - a prompt on stdin worked.
- External, skills CLI (vercel-labs `skills`, repo version 1.9.0 on main), opened 2026-11-19 through mstack-research:
  - https://raw.githubusercontent.com/vercel-labs/skills/HEAD/docs/creating-skills.md: a root `skills.sh.json` lists skill directories in `paths`, with entries starting with `./`. Discovery also reads plugin manifests.
  - https://raw.githubusercontent.com/vercel-labs/skills/HEAD/docs/commands.md: `-l`, `-s`, `-g`, `-a`, `--copy`, `-y`.
  - https://raw.githubusercontent.com/vercel-labs/skills/HEAD/src/installer.ts: the whole folder is copied recursively, and symlink is the default.
  - https://raw.githubusercontent.com/vercel-labs/skills/HEAD/docs/agents.md: the per-agent folders.
  - The npm latest tag was not confirmed (403).
- External, Notion "agent-bridges host compatibility" (the 2026-11-09 `npx skills` design: `skills.sh.json`, synced runtime copies, a byte-equality test).

## Stack and commands

- Node.js ESM scripts, with `node:test` tests and no dependencies.
- Test everything: `npm test` (`node scripts/run-tests.mjs`). It ran on 2026-11-19: 169 tests, 168 pass, and 1 fails (`resolved installed agent path is directly spawnable`, `tests/cursor-args.test.mjs:47`, a Linux run of a win32 assertion). Task 1.1 fixes it.
- Test one file: `node --test tests/<name>.test.mjs`.
- Catalog check: `npm run validate` (`node scripts/validate-catalogs.mjs`).
- Lint and format: none configured in `package.json` or CI. Steps use `node --check <file>` for each new `.mjs` file.

## Phases

| Phase | File | Goal | Round | Depends on | Tier |
|---|---|---|---|---|---|
| 1 | phases/PHASE-01-antigravity-companion.md | `plugins/antigravity` works end to end against a fake `agy` (7 tasks) | 1 | none | most capable |
| 2 | phases/PHASE-02-gemini-agy-read-only.md | `gemini`'s `agy` read-only runs deny writes and shell | 1 | none | standard |
| 3 | phases/PHASE-03-npx-skills.md | 55 skills discoverable, runtime copies synced, lookup order in every skill | 2 | 1, 2 | standard |
| 4 | phases/PHASE-04-catalogs-docs-versions.md | Listed in every catalog, README, versions, changelogs, `npm test` green | 3 | 1, 2, 3 | standard |

## File map

| Path or external change | Action | Phase | Verification |
|---|---|---|---|
| `tests/cursor-args.test.mjs` | modify | 1 | `node --test tests/cursor-args.test.mjs` |
| `plugins/antigravity/**` except `skills/antigravity-cli-runtime/{scripts,prompts,schemas}/**` | create | 1 | `node --test tests/antigravity-*.test.mjs` |
| `tests/antigravity-backend.test.mjs` | create | 1 | `node --test tests/antigravity-backend.test.mjs` |
| `tests/antigravity-args.test.mjs` | create | 1 | `node --test tests/antigravity-args.test.mjs` |
| `tests/antigravity-jobs.test.mjs` | create | 1 | `node --test tests/antigravity-jobs.test.mjs` |
| `tests/copy-plugins.test.mjs` | modify | 1 | `node --test tests/copy-plugins.test.mjs` |
| `tests/state.test.mjs` | modify | 1 | `node --test tests/state.test.mjs` |
| `tests/markdown-lookup.test.mjs` | modify | 1 | `node --test tests/markdown-lookup.test.mjs` |
| `tests/host-session.test.mjs` | modify | 1 | `node --test tests/host-session.test.mjs` |
| `plugins/gemini/scripts/lib/gemini.mjs` | modify | 2 | `node --test tests/gemini-args.test.mjs` |
| `tests/gemini-args.test.mjs` | modify | 2 | `node --test tests/gemini-args.test.mjs` |
| `skills.sh.json` | create | 3 | `node --test tests/skill-runtimes.test.mjs` |
| `package.json` (script `sync:skills`) | modify | 3 | `npm run sync:skills` |
| `scripts/sync-skills.mjs` | create | 3 | `npm run sync:skills` |
| `plugins/{opencode,gemini,claude,cursor,antigravity}/skills/*-cli-runtime/{scripts,prompts,schemas}/**` | create (generated) | 3 | `node --test tests/skill-runtimes.test.mjs` |
| `plugins/{opencode,gemini,claude,cursor}/skills/*/SKILL.md` | modify | 3 | `node --test tests/skill-lookup.test.mjs` |
| `tests/skill-runtimes.test.mjs` | create | 3 | itself |
| `tests/skill-lookup.test.mjs` | create | 3 | itself |
| `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.cursor-plugin/marketplace.json`, `.opencode/catalog.json` | modify | 4 | `npm run validate` |
| `scripts/lib/catalogs.mjs` | modify | 4 | `node --test tests/catalogs.test.mjs` |
| `scripts/lib/opencode-install.mjs` | modify | 4 | `node --test tests/install-opencode.test.mjs` |
| `tests/catalogs.test.mjs`, `tests/install-opencode.test.mjs`, `tests/readme.test.mjs` | modify | 4 | `npm test` |
| `README.md` | modify | 4 | `node --test tests/readme.test.mjs` |
| `plugins/{opencode,gemini,claude,cursor}/{.claude-plugin,.codex-plugin,.cursor-plugin}/plugin.json`, `plugins/{opencode,gemini,claude,cursor}/package.json` (version), `plugins/{opencode,gemini,claude,cursor}/CHANGELOG.md` | modify | 4 | `npm run validate` and a version grep |

Shared files reserved for the executor: `progress.md`.

Parallel conflicts: round 1 runs phases 1 and 2. Phase 1 owns `plugins/antigravity/**` and the test files listed for it; phase 2 owns `plugins/gemini/scripts/lib/gemini.mjs` and `tests/gemini-args.test.mjs`. No path is shared. The full `npm test` is not safe to run concurrently in one checkout (`tests/install-opencode.test.mjs` deletes `tests/.tmp`), so in round 1 each lane runs only its focused test files, or works in its own worktree. Rounds 2 and 3 have one phase each. The rounds are integration barriers: some edges are stronger than the file dependencies (4.1 does not need phase 3), which costs time, not correctness.

## Traceability

| Requirement | Tasks |
|---|---|
| R1 | 4.1 |
| R2 | 1.3 |
| R3 | 1.3 |
| R4 | 1.3 |
| R5 | 1.4 |
| R6 | 1.4 |
| R7 | 1.5 |
| R8 | 1.6 |
| R9 | 1.4 (argv), 1.5 (stored ID), 1.6 (resume aliases) |
| R10 | 1.5 |
| R11 | 1.5 |
| R12 | 1.5 |
| R13 | 1.4 |
| R14 | 1.4 |
| R15 | 1.7 |
| R16 | 1.7 |
| R17 | 1.4 |
| R18 | 1.2 |
| R19 | 2.1 |
| R20 | 1.1, 4.3 |
| R21 | 4.2 |
| R22 | 3.1 |
| R23 | 3.2 (the runtime copy runs from an unrelated cwd), 3.3 (copy, symlink and missing-sibling layouts); a real skills CLI install is not planned, by the user's choice (P3) |
| R24 | 1.2 (antigravity skills), 3.3 (the other 40 skills) |
| R25 | 3.2 |
| R26 | 4.2 |

## End-to-end verification

1. `npm test` exits 0 with no failing test (R20).
2. `npm run validate` exits 0 (R1).
3. `node plugins/antigravity/scripts/antigravity-companion.mjs setup --json` prints `available: true`, the version, `apiKeySet` and the state dir, and makes no `-p` call (R2).
4. Manual, when `agy` is signed in: in a scratch git repo, a read-only `task` asking to create a file and run `touch shell.txt` leaves `git status --short` empty, and a `--write` task creates both (R5, R6). It is logged as skipped when `agy` is not signed in.
5. Manual, when `agy` is signed in: a Gemini read-only run with `GEMINI_BACKEND=agy` leaves `git status --short` empty (R19).
6. `node plugins/antigravity/skills/antigravity-cli-runtime/scripts/antigravity-companion.mjs setup --json` prints the same report as check 3, run from the runtime copy (R23, offline).
7. Every version grep in Task 4.3 matches.

## Risks

- `agy` flags change in a later release, and `--settings` is undocumented. -> Exact-argv tests (1.4, 2.1); the manual checks; setup prints the version.
- A new `agy` write tool falls outside `write_file(*)`. -> The manual check asks for a file without naming a tool. The README notes the limit (4.2).
- `skills.sh.json` adds to the CLI's default scan or replaces it, and the docs leave that open. -> 3.1 pins only our file. R22 and R23 against the real CLI stay unproven (P3), and the final report says so.
- Copying ~3k lines per plugin means fixes made in one plugin must be repeated in the others. -> This is the repo's accepted trade-off (D1).
- The phase 3 lookup edit touches 40 skill files at once. -> 3.3's test checks all 50 skills mechanically.

## Decisions

- P1. One branch (`mubeda/antigravity-companion` from `main`), one commit per task, one PR. Alternative: two PRs (would bump catalogs twice). Decided by: user.
- P2. The real-`agy` checks are manual Done-when steps. `npm test` uses a fake `agy` script that records argv. Alternative: an opt-in live test file. Decided by: user.
- P3. `npx skills` is checked by unit tests only, with no real CLI run. Decided by: user. Recorded gap: R22 and R23 against the real CLI.
- P4. Every plugin gets a patch bump and a CHANGELOG line, the new plugin starts at 0.1.0, and the catalogs go to 0.4.0. Alternative: bump only the new plugin and the catalogs. Decided by: user.
- P5. The fake `agy` is a Node script written by each test into a temp dir and named by `ANTIGRAVITY_BIN`. It records argv and stdin to a JSON file and prints a canned envelope chosen by an env var. Alternative: mocking `spawn` (the Cursor tests use argv builders, not spawn mocks). Decided by: agent's call.
- P6. The review schema reaches `agy` as the schema file path (`--json-schema <ROOT_DIR>/schemas/review-output.schema.json`). The review prompt keeps the schema text the Cursor companion already embeds. Alternative: inline JSON (needed only for Claude, which rejects a path). Decided by: agent's call.
- P7. The skills phase runs after phases 1 and 2, because it syncs and edits files those phases create. Decided by: agent's call (outline approved by the user).
- P8. No task needed a skill that is not installed, so nothing was installed and no gap was recorded. Tasks 1.1, 4.2 and 4.3 need none. `cursor-cli-runtime` is read as a specimen (Read first), not loaded, because it is scoped to the rescue agent.
- P9. The antigravity copy of `findCodexFiles` uses only rollouts that match the cwd, with no fall back to every rollout. The Cursor original keeps its fall back, which is recorded as a follow-up. Alternative: fix every companion now (outside this plan's scope). Decided by: agent's call (plan review round 1, finding 2).
- P10. The availability check runs before any job is persisted or enqueued (R4: no job file). Decided by: agent's call (plan review round 1, finding 4).
- P11. The antigravity review guidance over the inline limit says shell is denied and asks the model to name what it could not inspect. The cost of D2 (no `git` over the limit) stays as the user accepted it. Decided by: agent's call (plan review round 1, finding 9).
- P12. Spawn-based tests use a POSIX fake `agy` and skip on win32. Windows prompt delivery is pinned at the function level. Decided by: agent's call (plan review round 1, finding 5).
- P13. On POSIX, `agy` is spawned detached so cancel can end its whole process tree, and the companion forwards `SIGINT`, `SIGTERM` and `SIGHUP` to it, so Ctrl-C or a host kill still stops a write run. It was added after review round 2, so no reviewer saw it. Decided by: agent's call.
- P14. Deny-rule coverage beyond create and shell was checked on `agy` 1.5.12 after round 2: an `edit_file` edit was blocked by `write_file(*)`, a nested create was blocked, and no delete tool exists besides the shell. MCP tools are not covered by the deny list. `agy` had no MCP servers configured here, so this is untested (kept for approval). Decided by: evidence.

## Appendix: questions record

- 2026-11-19 Q: plan folder / Recommended: docs/superpowers/plans/2026-11-19-antigravity-companion/ / Decision: accepted.
- 2026-11-19 Q: external sources / Recommended: none beyond the researched docs / Decision: accepted.
- 2026-11-19 Q: reviewer / Recommended: gpt-6.2-sol high / Decision: gpt-6.2-astra high.
- 2026-11-19 Q: delivery / Recommended: one branch, one PR / Decision: accepted (P1).
- 2026-11-19 Q: real-agy checks / Recommended: manual step plus a fake in npm test / Decision: accepted (P2).
- 2026-11-19 Q: skills checks / Recommended: unit tests plus a manual sandbox / Decision: unit tests only (P3).
- 2026-11-19 Q: versions / Recommended: patch-bump all plus changelogs / Decision: accepted (P4).
- 2026-11-19 Q: outline / Recommended: approve as is / Decision: approved.
- 2026-11-19 Evidence: `npm test` baseline 168 of 169, with the one failure at `tests/cursor-args.test.mjs:47` / Decision: Task 1.1 fixes it with the drop-gemini branch's one-line guard.
- 2026-11-19 Evidence: every companion resolves `ROOT_DIR` from its own file (`plugins/*/scripts/*-companion.mjs`) and reads only `schemas/`, `prompts/` and `scripts/` under it / Decision: a runtime-skill copy of those three folders runs on its own (3.2).
- 2026-11-19 Evidence: mstack-research on the skills CLI / Decision: `skills.sh.json` with `paths` (3.1).
- 2026-11-19 Q: approval, with the post-review findings (MCP deny, `--write` in a one-string prompt) / Recommended: approve and apply both / Decision: approved as written; both findings left as follow-ups.
