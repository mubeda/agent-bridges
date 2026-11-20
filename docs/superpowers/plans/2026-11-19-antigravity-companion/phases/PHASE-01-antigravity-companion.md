# Phase 1: Antigravity companion

- Goal: `plugins/antigravity` is a working companion for `agy`, with every behavior of spec stories 1 and 2 pinned by tests against a fake `agy`, the baseline suite green, and the manual real-`agy` read-only check logged.
- Round: 1
- Depends on: none
- Owns: `plugins/antigravity/**` (except `plugins/antigravity/skills/antigravity-cli-runtime/{scripts,prompts,schemas}/**`, owned by phase 3); `tests/antigravity-backend.test.mjs`, `tests/antigravity-args.test.mjs`, `tests/antigravity-jobs.test.mjs` (create); `tests/cursor-args.test.mjs`, `tests/copy-plugins.test.mjs`, `tests/state.test.mjs`, `tests/markdown-lookup.test.mjs`, `tests/host-session.test.mjs` (modify)
- Must not touch: `plugins/gemini/**` and `tests/gemini-args.test.mjs` (phase 2); the catalogs, `scripts/lib/*`, `README.md`, the other plugins' skills and manifests (phases 3 and 4)
- Skills: tdd (each task starts from a failing test of the spec's exact values)
- Read first: `spec.md` R2–R18 and D1–D19 (the binding behavior); `plugins/cursor/scripts/lib/cursor.mjs` and `plugins/cursor/scripts/cursor-companion.mjs` (the code being cloned); `plugins/cursor/skills/cursor-cli-runtime/SKILL.md` (the runtime contract the clone keeps; read it as a specimen, do not load it as a skill: it is scoped to the rescue agent); `plugins/gemini/scripts/lib/gemini.mjs:463-505` (the existing `agy` argv, for comparison only); `docs/superpowers/plans/2026-08-21-cursor-companion.md` (how the Cursor clone was done)
- Checkpoint: `node --test tests/antigravity-backend.test.mjs tests/antigravity-args.test.mjs tests/antigravity-jobs.test.mjs tests/copy-plugins.test.mjs tests/state.test.mjs tests/markdown-lookup.test.mjs tests/host-session.test.mjs tests/cursor-args.test.mjs` exits 0. `node plugins/antigravity/scripts/antigravity-companion.mjs setup` prints the setup report with the `agy` version.
- Parallel note: phase 2 runs in the same round. When both run in one checkout, run only the focused test files listed in each task. Run the full `npm test` only in a separate worktree, or after phase 2 has finished. `tests/install-opencode.test.mjs` deletes `tests/.tmp`, so concurrent full runs collide.

## Fake `agy` used by the tests (plan P5)

Each test file that spawns `agy` writes its own copy of this helper into a temp dir (no shared test module). It is a Node script with `#!/usr/bin/env node`, mode 0755, and `ANTIGRAVITY_BIN` points at it.

For every call it appends one JSON line `{argv, stdin, pid}` to the file named by `FAKE_AGY_LOG`; `--version` calls are logged too. Then:

- With `--version`, it prints `1.5.12` and exits 0.
- Otherwise, when `FAKE_AGY_SLEEP_MS` is set, it spawns one long-lived child (`node -e "setTimeout(()=>{}, <ms>)"`), writes `{pid, childPid}` as JSON to `FAKE_AGY_PIDFILE`, and sleeps that long.
- Then it prints `FAKE_AGY_ENVELOPE`, whose default is `{"conversation_id":"C1","status":"SUCCESS","response":"ok","num_turns":1}`. It writes `FAKE_AGY_STDERR` to stderr and exits with `FAKE_AGY_EXIT` (default 0).

Tests that spawn the fake skip on win32 with `t.skip("fake agy needs a POSIX shebang")`. Windows behavior is pinned at the function level (Task 1.4). Every new test uses its own `fs.mkdtempSync(path.join(os.tmpdir(), "agy-"))` root for the fake, `PLUGIN_DATA` and fixtures, never `tests/.tmp`, which `tests/install-opencode.test.mjs` deletes.

## Rename and preserve list (Tasks 1.2 to 1.7)

| In the Cursor copy | Becomes | Why |
|---|---|---|
| `cursor-companion.mjs`, `cursor.mjs` | `antigravity-companion.mjs`, `agy.mjs` | the plugin's own files |
| `cursor-<verb>` skill and agent names, `cursor:cursor-rescue` (the namespace in commands) | `antigravity-<verb>`, `antigravity:antigravity-rescue` | the plugin's own names |
| `/cursor:`, `Skill(cursor:rescue)`, `cursor:cursor-delegate` and every other `cursor:` namespace reference | `/antigravity:`, `Skill(antigravity:rescue)`, `antigravity:antigravity-delegate` | slash prefix and skill namespace |
| the Cursor install URL (`https://cursor.com/docs/cli/installation`) | the Antigravity CLI docs URL (`https://antigravity.google/docs/cli/headless.md`) | install hint |
| `--force`, `--trust`, `--mode plan` in prose and forwarding rules | the `--write` and read-only wording of D2/D3 | `agy` has none of these |
| `CURSOR_BIN` | `ANTIGRAVITY_BIN` | D10 |
| `CURSOR_COMPANION_TRANSCRIPT_PATH` (in `host-session.mjs`) | `ANTIGRAVITY_COMPANION_TRANSCRIPT_PATH` | the destination plugin's own variable |
| "Cursor Agent" as the backend product | "Antigravity" | the backend |
| the binary `agent` (in argv, help and hints) | `agy` | the backend CLI |
| `CURSOR_API_KEY`, `agent login`, `agent status` | removed; setup prints the D4 sign-in note | `agy` has no status command |
| `.cursor-companion` | `.antigravity-companion` | state dir |
| `cursorSessionId` (job field) | `agySessionId` | the conversation ID |
| the `agents/` folder, the word "agent" in prose about subagents | unchanged | not the CLI |
| `~/.cursor/plugins/local/<plugin>`, the Cursor host transcript path `.cursor/projects/.../agent-transcripts`, `.cursor-plugin/` | unchanged, with only the plugin name changed in the first one | Cursor is still a host |

## Tasks

### Task 1.1: Make the Cursor spawn assertion win32-only

- Satisfies: support for R20 (the baseline suite must pass before new tests count)
- Depends on: none
- Files: modify `tests/cursor-args.test.mjs`
- Interfaces: consumes none; produces a green baseline
- Skills: none
- Read first: `tests/cursor-args.test.mjs:47-57` (the failing test)
- Tier: cheap
- TDD: exempt (it fixes a test that asserts a Windows-only path on every platform; there is no product behavior)
- Done when: `node --test tests/cursor-args.test.mjs` exits 0

Steps

1. [ ] Run `node --test tests/cursor-args.test.mjs`. Expected: FAIL in `resolved installed agent path is directly spawnable` on Linux or macOS when `agent` is installed. When `agent` is not installed, the test skips: note that in the log and continue.
2. [ ] Change `assert.match(command.file, /(?:\.exe|powershell\.exe)$/i);` to `if (process.platform === "win32") assert.match(command.file, /(?:\.exe|powershell\.exe)$/i);`. This is the fix from `origin/mubeda/opencode-v2-drop-gemini`.
3. [ ] Run `node --test tests/cursor-args.test.mjs`. Expected: PASS, 0 failures.

### Task 1.2: Clone the Cursor tree as `antigravity`, renamed and wired

- Satisfies: R18 (names), R24 for the 10 `antigravity` skills that run the companion (host plugin install unchanged; sibling runtime)
- Depends on: 1.1
- Files: create every file under `plugins/antigravity/` that `plugins/cursor/` has, renamed by the list above; modify `tests/copy-plugins.test.mjs` and `tests/markdown-lookup.test.mjs`
- Interfaces: produces the tree, `PLUGIN_NAME = "antigravity"` in `scripts/lib/state.mjs`, and the job field `agySessionId`. The backend functions stay as renamed copies (`resolveAgyBin`, `getAgyAvailability`, `buildRunArgs`, `parsePrintResult`, ...). Their behavior changes in Tasks 1.3 to 1.7.
- Skills: tdd (name and wiring tests before the copy)
- Read first: `plugins/cursor/` (every file); `tests/copy-plugins.test.mjs:25-31` and `tests/markdown-lookup.test.mjs:35-60,109-150` (where `cursor` is pinned, including the host-only-commit assertion near line 143); `scripts/lib/opencode-install.mjs:134-150` (the installer rewrites from `Resolve \`<plugin-root>\`` to the end of the line that starts `If none exist,`, so both markers must stay and the stop text must be one line)
- Tier: standard
- TDD: red-green
- Done when: `node --test tests/copy-plugins.test.mjs tests/markdown-lookup.test.mjs` exits 0

Steps

1. [ ] Write the failing tests.
   - In `tests/copy-plugins.test.mjs`: `plugins/antigravity/scripts/antigravity-companion.mjs` exists. `commands/` holds exactly `setup`, `review`, `adversarial-review`, `rescue`, `status`, `result`, `cancel`, `transfer` and `delegate`. `skills/` holds exactly `antigravity-{adversarial-review,cancel,cli-runtime,delegate,prompting,rescue,result,review,setup,status,transfer}`, and each SKILL.md's frontmatter `name` equals its folder name. `agents/antigravity-rescue.md` exists.
   - In `tests/markdown-lookup.test.mjs`:
     - add `antigravity` to the loops at lines 35 and 57, and to the host-only-commit assertion for the delegate skill;
     - assert that `commands/rescue.md` names `antigravity:antigravity-rescue` and `Skill(antigravity:rescue)`, that `commands/delegate.md` names `antigravity:antigravity-delegate`, and that the rescue command, the rescue agent and the rescue skill all say to forward `--effort` as well as `--model` and `--write`;
     - for each of the 10 `antigravity` skills other than `antigravity-prompting`, assert the six lookup entries in order (`$CLAUDE_PLUGIN_ROOT`, `$PLUGIN_ROOT`, a line containing `the folder that holds this SKILL.md` and `../antigravity-cli-runtime`, `~/.cursor/plugins/local/antigravity`, `~/.config/opencode/plugins/antigravity`, the plugin-cache search), and that the single stop line starts with `If none exist,` and names `antigravity-cli-runtime`.
2. [ ] Run `node --test tests/copy-plugins.test.mjs tests/markdown-lookup.test.mjs`. Expected: FAIL, because `plugins/antigravity` is missing.
3. [ ] Copy `plugins/cursor` to `plugins/antigravity` and apply the rename and preserve list. Set every manifest and `package.json` version to `0.1.0`. The CHANGELOG gets one `0.1.0` entry.
4. [ ] In each of the 10 skills, rewrite the "Resolve `<plugin-root>`" block with these six entries in order. Entry 3 reads: "the `antigravity-cli-runtime` folder next to the folder that holds this SKILL.md (`<this skill's folder>/../antigravity-cli-runtime`, installed with `npx skills`)". The stop line is one line: "If none exist, stop and print those paths, and say that an `npx skills` install also needs `antigravity-cli-runtime`. Do not invent a companion elsewhere."
5. [ ] Run the Done when command. Expected: PASS.
6. [ ] Prove the tests can fail: rename `skills/antigravity-cancel` to `skills/antigravity-cancel-x`, run, and expect FAIL. Restore, run again, and expect PASS.
7. [ ] Run `for f in $(find plugins/antigravity/scripts -name '*.mjs'); do node --check "$f" || exit 1; done`. Expected: exit 0. Run `grep -rnE 'cursor-companion|cursorSessionId|CURSOR_BIN|CURSOR_API_KEY|CURSOR_COMPANION|/cursor:|cursor:|cursor\.com|--force|--trust|--mode plan' plugins/antigravity`. Expected: no output.

### Task 1.3: Setup report and preflight

- Satisfies: R2 (agy installed; setup makes no model call), R3 (override), R4 (no agy)
- Depends on: 1.2
- Files: modify `plugins/antigravity/scripts/lib/agy.mjs` and `plugins/antigravity/scripts/antigravity-companion.mjs`; create `tests/antigravity-backend.test.mjs`; modify `tests/state.test.mjs`
- Interfaces:
  - produces in `agy.mjs`:
    - `resolveAgyBin(env = process.env) -> string`: `ANTIGRAVITY_BIN` trimmed, else `"agy"`
    - `getAgyAvailability(cwd, env) -> {available, bin, version, detail}`: `version` is the `detail` that `binaryAvailable` returns on success, because it holds the trimmed `--version` stdout (`plugins/cursor/scripts/lib/process.mjs:38-50`)
    - `findOnPath(bin, env) -> string | null`: the absolute file `bin` resolves to on `PATH` (with `PATHEXT` on win32), or `bin` itself when it is already a path
    - `getAgySetupFacts(cwd, env) -> {available, bin, resolvedPath, version, apiKeySet, signInNote, detail}`
    - `getAgyAvailability` treats a probe that ended by a signal (`result.signal` set), or with a non-zero status, as unavailable, because `runCommand` maps a null status to 0 (`plugins/cursor/scripts/lib/process.mjs:19`)
  - In the companion: `ensureAgyAvailable(cwd)` runs before any job is persisted or enqueued, for review, adversarial-review, task and transfer, in both `--wait` and `--background`.
- Skills: tdd (setup and missing-binary tests first)
- Read first: spec R2, R3, R4, D4; `plugins/cursor/scripts/cursor-companion.mjs:173-176,231-262,310-320,385-395` (setup, the run path, and where jobs are persisted before the availability check today)
- Tier: standard
- TDD: red-green
- Done when: `node --test tests/antigravity-backend.test.mjs tests/state.test.mjs` exits 0

Steps

1. [ ] Write the failing tests.
   - In `tests/antigravity-backend.test.mjs`:
     - `resolveAgyBin({ANTIGRAVITY_BIN: " /opt/agy/agy "})` returns `/opt/agy/agy`, and `resolveAgyBin({})` returns `agy`.
     - `setup --json` with the fake and no `GEMINI_API_KEY` prints `available: true`, `version: "1.5.12"`, `apiKeySet: false`, a `stateDir`, and a `signInNote` containing `interactive` and `agy`. The fake log has exactly one line, with argv `["--version"]`.
     - The same with `GEMINI_API_KEY=x` gives `apiKeySet: true`.
     - Plain `setup` (text) shows the fake's absolute path, `1.5.12`, `GEMINI_API_KEY not set` (and `set` with the key), the state dir and the sign-in note.
     - A fake whose `--version` exits 1 gives `available: false`.
     - With `PATH` holding a dir that has the fake named `agy` and no `ANTIGRAVITY_BIN`, `setup --json` shows `available: true` and `resolvedPath` equal to that file's absolute path.
     - A fake whose `--version` kills itself with `SIGKILL` gives `available: false`, and `task --wait hi` with it exits non-zero with no job file.
     - With `ANTIGRAVITY_BIN` pointing at a missing file:
       - `review --wait`, `review --background`, `task --wait hi`, `task --background hi` and `transfer --wait --source <file>` each exit non-zero, and the message names `agy` and `ANTIGRAVITY_BIN`;
       - the state dir's jobs folder holds no job file afterwards.
   - In `tests/state.test.mjs`: the antigravity `resolveStateRoot({})` equals `~/.antigravity-companion/state`.
2. [ ] Run `node --test tests/antigravity-backend.test.mjs tests/state.test.mjs`. Expected: FAIL, because setup still reports the Cursor login fields and a job file is written before the availability check.
3. [ ] Implement:
   - Write the functions in Interfaces.
   - `getAgySetupFacts` starts no process other than the `--version` probe. Its `signInNote` reads: "Sign-in cannot be checked without a run. Sign in once with an interactive `agy` session, or set GEMINI_API_KEY with modelProvider \"gemini\" in your Antigravity settings."
   - `buildSetupReport` and `renderSetupReport` use these facts, and the report has no `loggedIn` field.
   - Call `ensureAgyAvailable(cwd)` at the top of each handler, after argument validation (Task 1.4 adds the effort check there) and before `createCompanionJob` and `buildRequest`.
   - Expected: `node --check plugins/antigravity/scripts/antigravity-companion.mjs` exits 0.
4. [ ] Run the Done when command. Expected: PASS.
5. [ ] Prove the tests can fail: move the `ensureAgyAvailable` call in the review handler back to after the job is persisted, run, and expect FAIL on "no job file". Restore, run again, and expect PASS.
6. [ ] Run `node --check plugins/antigravity/scripts/lib/agy.mjs` and `node --check plugins/antigravity/scripts/antigravity-companion.mjs`. Expected: both exit 0.

### Task 1.4: The `agy` argument builder

- Satisfies: R5 (argv; a review that tries to write), R6 (rescue writes and runs commands), R13 (pass-through), R14 (bad effort), R17 (oversized prompt)
- Depends on: 1.3
- Files: modify `plugins/antigravity/scripts/lib/agy.mjs`, `plugins/antigravity/scripts/antigravity-companion.mjs` and `plugins/antigravity/scripts/lib/git.mjs`; create `tests/antigravity-args.test.mjs`
- Interfaces:
  - produces in `agy.mjs`:
    - `READ_ONLY_SETTINGS = '{"permissions":{"deny":["write_file(*)","command(*)"]}}'`
    - `EFFORT_LEVELS = ["low","medium","high","xhigh","max"]`
    - `shouldPassPromptViaStdin(prompt, platform = process.platform) -> boolean`, true only on win32 above 20,000 characters
    - `buildRunArgs({prompt, write, review, model, effort, resumeSessionId, schemaPath, platform}) -> string[]`
    - `buildReviewArgs(options)`, which calls `buildRunArgs({...options, write: false, review: true})`
  - `buildRunArgs` throws `Error("Unknown effort \"<value>\"; use one of: low, medium, high, xhigh, max.")` for any other effort value.
  - `buildPrintInvocation(options) -> {args, stdin}`: `args` from `buildRunArgs`, and `stdin` set to the prompt exactly when `shouldPassPromptViaStdin(prompt, platform)` is true, else `null`. The companion spawns with `args` and writes `stdin`, so one `platform` value decides both.
  - `validateEffort(value) -> void` throws the effort error for an empty string or any value outside `EFFORT_LEVELS`. Every handler calls it on `options.effort` when the option is present, before `ensureAgyAvailable`, `createCompanionJob` and any enqueue, and `buildRunArgs` calls it too.
  - The `review` and `adversarial-review` handlers accept `--effort`.
- Skills: tdd (literal argv expectations before the builder); security-audit (checks that no read-only path reaches the bypass)
- Read first:
  - spec R5, R6, R13, R14, R17, D2, D3, D12, D19, and spec › Appendix (the local `agy` evidence)
  - `plugins/cursor/scripts/lib/cursor.mjs:104-128`, the builder being replaced
  - `plugins/cursor/scripts/cursor-companion.mjs:178-196,231-237,365`: the review prompt, the spawn path, and review options that lack `effort`
  - `plugins/cursor/scripts/lib/git.mjs:290-335`: when a diff is over the inline limit, the guidance tells the model to run `git`
- Tier: most capable
- TDD: red-green
- Done when: `node --test tests/antigravity-args.test.mjs` exits 0. The manual real-`agy` check (step 7) is logged as passed, or as "skipped: agy not signed in".

Steps

1. [ ] Write the failing tests in `tests/antigravity-args.test.mjs`. Compare against literal expectations, not against the exported constants. `S` below is the literal `'{"permissions":{"deny":["write_file(*)","command(*)"]}}'`.
   - `buildReviewArgs({prompt: "P", schemaPath: "/s.json", platform: "linux"})` deep-equals `["--settings", S, "--output-format", "json", "--json-schema", "/s.json", "-p", "P"]`.
   - `buildRunArgs({prompt: "P", write: false, platform: "linux"})` deep-equals `["--settings", S, "--output-format", "json", "-p", "P"]`.
   - `buildRunArgs({prompt: "P", write: true, platform: "linux"})` deep-equals `["--dangerously-skip-permissions", "--output-format", "json", "-p", "P"]`.
   - `buildReviewArgs({prompt: "P", write: true})` contains `S` and not `--dangerously-skip-permissions`. No read-only argv contains `--mode`.
   - `{model: "m1", effort: "high", resumeSessionId: "C1"}` on a read-only run deep-equals `["--settings", S, "--model", "m1", "--effort", "high", "--conversation", "C1", "--output-format", "json", "-p", "P"]`.
   - `{effort: "extreme"}` throws a message containing all five levels.
   - `shouldPassPromptViaStdin("x".repeat(20000), "win32")` is false, and with 20,001 characters it is true. It is false on linux at any length.
   - `buildPrintInvocation({prompt: "x".repeat(20000), platform: "win32"})` gives `args` ending in `-p` plus the prompt and `stdin: null`. With 20,001 characters, `args` contains neither `-p` nor the prompt, and `stdin` equals the prompt exactly.
   - Through the companion with the fake:
     - `task --write P` logs argv equal to the write vector above;
     - `task P` logs the read-only vector;
     - `review --effort high` logs a fixed prefix `["--settings", S, "--effort", "high", "--output-format", "json", "--json-schema", <path ending schemas/review-output.schema.json>, "-p"]` followed by one prompt string, and that prompt is checked separately: it contains `Return only JSON matching this schema`;
     - `review --effort extreme`, `task --effort extreme P`, `task --background --effort extreme P` and `task --effort= P` each exit non-zero, the fake log is empty (no `--version` call either), and the state dir holds no job file.
   - Over the inline limit, the review prompt contains `Shell commands are denied in this review` and does not contain an instruction to run `git`.
   - Expected: `node --check tests/antigravity-args.test.mjs` exits 0.
2. [ ] Run `node --test tests/antigravity-args.test.mjs`. Expected: FAIL, because the argv still has the Cursor shape (`--mode plan`, `--trust`).
3. [ ] Implement:
   - Write `buildRunArgs` and `buildReviewArgs` to produce the asserted order. Add the `EFFORT_LEVELS` check.
   - In the companion, pass `schemaPath: REVIEW_SCHEMA` for reviews, add `effort` to the review `valueOptions`, remove the Cursor "no `--effort`" rejection, and pass one `platform`.
   - In the antigravity copy of `git.mjs`, change the over-the-limit guidance to: "Shell commands are denied in this review. Read the changed files directly, and say in the summary which changes you could not inspect."
4. [ ] Run `node --test tests/antigravity-args.test.mjs`. Expected: PASS.
5. [ ] Prove the tests can fail:
   - Change `"command(*)"` to `"command(rm)"` in `READ_ONLY_SETTINGS` and expect FAIL. Restore.
   - Make the read-only branch of `buildRunArgs` skip the `--settings` pair, and expect FAIL. Restore.
   - Run again. Expected: PASS.
6. [ ] Run `node --check` on each of the three changed files, one call per file. Expected: each exits 0.
7. [ ] Manual real-`agy` check, run only when `agy` is signed in:
   - Make a scratch git repo outside the repository with one committed file.
   - From the repository root, with `ANTIGRAVITY_BIN` unset, run `node "$PWD/plugins/antigravity/scripts/antigravity-companion.mjs" task --wait --json --cwd <scratch> "Create probe.txt containing WRITTEN with your file tool, edit the committed file so it says EDITED, then run touch shell.txt. Say DONE or what was blocked."`. Expected: the JSON shows the job `completed` with a non-empty result and an `agySessionId`, and `git -C <scratch> status --short` is empty. A launch, sign-in or settings error is logged as that error, never as a passed check.
   - Run the same with `--write`. Expected: `probe.txt` and `shell.txt` exist.
   - Log both results, or "skipped: agy not signed in".

### Task 1.5: Parse the envelope and render status and results

- Satisfies: R7 (structured output present; no structured output), R10 (parser part), R11 (not signed in), R12 (headless auto-deny)
- Depends on: 1.4
- Files: modify `plugins/antigravity/scripts/lib/agy.mjs` and `plugins/antigravity/scripts/antigravity-companion.mjs` (`renderExecution`, `runPrintJob`, the foreground exit code and the `result` handler; there is no `render.mjs` in this tree); create `tests/antigravity-jobs.test.mjs`
- Interfaces:
  - produces in `agy.mjs`:
    - `parsePrintResult(stdout, {requestedConversationId = null, exitCode = 0, stderr = ""} = {}) -> {sessionId, resultText, structured, status, ok, error, deniedActions, warning, raw}`
    - `formatDeniedActions(list) -> string` (`"command (Bash)"`, joined with `", "`)
  - With a JSON envelope on stdout, `ok` is true only when `exitCode === 0` and `status === "SUCCESS"`. With no JSON on stdout (spec › Verification: "R7's plain-text path, marked as failed when the exit code is non-zero"), `ok` equals `exitCode === 0`, `status` is null and `resultText` is the trimmed stdout.
  - `warning` is `conversation <requested> not found; Antigravity started a new one` when `requestedConversationId` is set and differs from `conversation_id`, otherwise null.
  - `structured` is `raw.structured_output` when it is an object. Otherwise it is `parseStructuredResult(response)`, because the review prompt asks for JSON, so a JSON `response` is a legitimate result.
  - `resultText` is `response`. When `response` is empty and there are denied actions, it is `no answer; denied: <formatDeniedActions>`. When `response` is not empty and there are denied actions, it is `response` plus a final line `Denied: <formatDeniedActions>`.
  - `error` is `raw.error`, or else the trimmed stderr, when `ok` is false.
  - The job status is `failed` when `ok` is false, whatever the exit code, and the foreground command exits 1 then, and 0 when `ok` is true. The job stores `parsed.structured` for reviews, and a review with structured output still prints the warning and the `Denied:` line.
- Skills: tdd (captured-envelope fixtures first)
- Read first: spec R7, R10, R11, R12, D14; spec › Constraints (envelope fields); `plugins/cursor/scripts/cursor-companion.mjs:239-300,485-500` (`renderExecution`, the job record and `result`); `plugins/antigravity/schemas/review-output.schema.json`
- Tier: standard
- TDD: red-green
- Done when: `node --test tests/antigravity-jobs.test.mjs` exits 0

Steps

1. [ ] Write failing tests, with fixtures as inline strings, at two levels: `parsePrintResult` directly, and `task --wait` / `review --wait` through the fake followed by `status <id> --json` and `result <id>`.
   - A success envelope with `structured_output: {verdict, summary: "s", next_steps: [], findings: [{severity: "high", title: "t", body: "b", file: "a.js", line_start: 3, line_end: 4, confidence: 0.9, recommendation: "r"}]}`, taking `verdict` from the schema's enum. The review `result` shows `high`, `a.js`, `3` and `r`.
   - A success envelope with no `structured_output` and `response: "plain"`. The review `result` shows `plain` and the line `No structured result came back from Antigravity.`, with no findings section.
   - `{conversation_id: "C2", status: "SUCCESS", response: "ok"}` with `requestedConversationId: "C1"`. `warning` is the exact text, `sessionId` is `C2`, and `ok` is true.
   - Exit 1 with stderr `authentication required` and empty stdout. `status` shows `failed`, `result` shows `authentication required`, and the command's exit code is non-zero.
   - `{status: "ERROR", error: "boom", conversation_id: "C3"}` with exit 0. `status` shows `failed`, and `result` shows `boom`.
   - `{status: "SUCCESS", response: "", denied_actions: [{action: "command", display_name: "Bash"}]}`. `result` shows `no answer; denied: command (Bash)`.
   - The same with `response: "partial"`. `result` shows `partial` and `Denied: command (Bash)`.
   - Plain stdout `hello` at exit 0: `ok` true, and `result` shows `hello`. The same at exit 1: `status` shows `failed`.
   - Exit 0 with `{status: "ERROR", error: "boom"}` through `task --wait`: the command exits 1.
   - End to end: finish a task with `C1`, then `task --resume-last more` with a fake that returns `C2`. The job stores `agySessionId: "C2"`, `result` prints the warning, the job is not failed, and the next `task --resume-last again` logs `--conversation C2`.
2. [ ] Run `node --test tests/antigravity-jobs.test.mjs`. Expected: FAIL, because `parsePrintResult` has the Cursor shape and the job status follows only the exit code.
3. [ ] Implement:
   - Write `parsePrintResult` and `formatDeniedActions`.
   - In `executePrintRun`, pass `requestedConversationId`, the exit code and stderr.
   - In `runPrintJob`, set `failed` from `ok`, and store `error` and `warning`.
   - `renderExecution` prints the warning first, uses `parsed.structured` for reviews and prints the no-structured note.
   - The `result` handler shows the stored error for failed jobs, before any stored rendered text.
4. [ ] Run `node --test tests/antigravity-jobs.test.mjs`. Expected: PASS.
5. [ ] Prove the tests can fail: make `ok` ignore `status`, run, and expect FAIL on the ERROR case. Restore, run again, and expect PASS.
6. [ ] Run `node --check plugins/antigravity/scripts/lib/agy.mjs` and `node --check plugins/antigravity/scripts/antigravity-companion.mjs`. Expected: both exit 0.

### Task 1.6: Background lifecycle and process-tree cancel

- Satisfies: R8 (background lifecycle; cancel), R9 (resume, regression coverage)
- Depends on: 1.5
- Files: modify `plugins/antigravity/scripts/antigravity-companion.mjs` and `tests/antigravity-jobs.test.mjs`
- Interfaces: consumes `buildPrintInvocation` (1.4) and `parsePrintResult` (1.5). The companion spawns `agy` with `detached: true` on POSIX, so `agy` leads its own process group, and stores its pid on the job as `agyPid`. `cancel` terminates the `agyPid` process tree first, then the companion pid, using `terminateProcessTree` from `scripts/lib/process.mjs`. Because a detached `agy` no longer gets the terminal's signals, the companion forwards `SIGINT`, `SIGTERM` and `SIGHUP` to the `agyPid` process group while it runs, then exits (plan P13).
- Skills: tdd (lifecycle tests before any wiring change)
- Read first: spec R8, R9, R10; `plugins/cursor/scripts/cursor-companion.mjs:300-330,407-440,485-505` (worker, task, cancel)
- Tier: standard
- TDD: red-green
- Note: the foreground cancel case is the red test. The background lifecycle and resume cases are regression coverage of cloned behavior and may already pass.
- Done when: `node --test tests/antigravity-jobs.test.mjs` exits 0

Steps

1. [ ] Add tests to `tests/antigravity-jobs.test.mjs`, with the fake and a temp `PLUGIN_DATA`.
   - Lifecycle: `task --background hi` with `FAKE_AGY_SLEEP_MS=3000` returns a job ID. Poll `status <id> --json` every 100 ms with a 10 s deadline until `FAKE_AGY_PIDFILE` exists and the status is `running`. `queued` is allowed before that. Then `status <id> --wait` ends at `completed`, and `result <id>` prints `ok`.
   - Background cancel: with `FAKE_AGY_SLEEP_MS=30000`, wait for the pid file, then run `cancel <id>`. Poll with a 10 s deadline until `process.kill(pid, 0)` and `process.kill(childPid, 0)` both throw, and `status` shows `cancelled` twice in a row.
   - Foreground cancel: start `task --wait hi` as a child process with `FAKE_AGY_SLEEP_MS=30000`. Wait for the pid file, then run `cancel <id>` from a second invocation. The same deadline holds for `pid` and `childPid`.
   - Signal forwarding: start `task --wait hi` as a child process with `FAKE_AGY_SLEEP_MS=30000`, wait for the pid file, then send `SIGTERM` to the companion process. Within a 10 s deadline, `pid` and `childPid` are both gone. Repeat with `SIGINT`.
   - Resume: finish a task with conversation `C1`. `task --resume-last more` logs `--conversation C1`. `task --resume more` does too.
   - Expected: the file loads without a syntax error (`node --check tests/antigravity-jobs.test.mjs` exits 0).
2. [ ] Run `node --test tests/antigravity-jobs.test.mjs`. Expected: FAIL on the foreground cancel case, because `agy` and its child outlive the cancelled companion.
3. [ ] Implement: spawn `agy` detached on POSIX, store `agyPid` on the running job, make `cancel` terminate the `agyPid` tree before the companion pid, and forward `SIGINT`, `SIGTERM` and `SIGHUP` to the `agyPid` group. Expected: `node --check plugins/antigravity/scripts/antigravity-companion.mjs` exits 0.
4. [ ] Run the Done when command. Expected: PASS.
5. [ ] Prove the test can fail: make `cancel` skip the `agyPid` termination, run, and expect FAIL on the foreground cancel case. Restore, run again, and expect PASS.
6. [ ] Run `node --check plugins/antigravity/scripts/antigravity-companion.mjs`. Expected: exit 0.

### Task 1.7: Transfer and delegate

- Satisfies: R15 (transfer from Codex; no session), R16 (explicit trigger)
- Depends on: 1.6
- Files: modify `plugins/antigravity/scripts/lib/host-session.mjs`, `plugins/antigravity/scripts/antigravity-companion.mjs`, `plugins/antigravity/skills/antigravity-delegate/SKILL.md` and `plugins/antigravity/commands/delegate.md`; modify `tests/host-session.test.mjs` and `tests/antigravity-jobs.test.mjs`
- Interfaces:
  - In the antigravity copy, `findCodexFiles(cwd, home, env)` returns only rollouts that match `cwd`, with no fall back to every rollout. Spec R15 is "the current host session".
  - `transfer --wait` stores the conversation ID on its job as `agySessionId`.
- Skills: tdd (the cross-workspace transcript test is the red test)
- Read first: spec R15, R16, D15, D16; `plugins/cursor/scripts/lib/host-session.mjs:120-190` (the Codex fall back to all rollouts, and the Codex-first order); `plugins/cursor/scripts/cursor-companion.mjs:510-550` (transfer); `plugins/cursor/skills/cursor-delegate/SKILL.md` (delegate rules); `tests/host-session.test.mjs:20-70`
- Tier: standard
- TDD: red-green
- Note: cases (b) and (c) are the red tests. The delegate text and the happy-path transfer are regression coverage.
- Done when: `node --test tests/host-session.test.mjs tests/antigravity-jobs.test.mjs` exits 0

Steps

1. [ ] Write the tests.
   - In `tests/host-session.test.mjs`, for `antigravity`, using a temp home:
     - (a) A Codex rollout whose cwd matches. `transfer --wait` logs one `-p` call whose prompt contains the rollout text, and the job stores `agySessionId: "C1"`.
     - (b) Only a Codex rollout for an unrelated cwd, and nothing else. `transfer --wait` exits non-zero, the message names `--source`, and the fake log has no non-`--version` line.
     - (c) An unrelated Codex rollout plus a matching Claude transcript for this cwd. The prompt contains the Claude transcript text and not the unrelated rollout's text.
     - (d) `transfer --wait --write --source <file>` logs argv starting with `--dangerously-skip-permissions`, and without `--write` it starts with `--settings`.
   - In `tests/antigravity-jobs.test.mjs`: `antigravity-delegate/SKILL.md`'s frontmatter `description` contains `/antigravity:delegate`, `delegate this to antigravity` and `Never auto-trigger`, and its body contains `--background --fresh --write`.
2. [ ] Run `node --test tests/host-session.test.mjs tests/antigravity-jobs.test.mjs`. Expected: FAIL on (b) and (c), because the copied `findCodexFiles` falls back to every rollout.
3. [ ] Implement:
   - In the antigravity `host-session.mjs`, return only the matching rollouts.
   - Adapt the delegate skill and command: "Antigravity" is the implementer, chunks run as `task --background --fresh --write`, and the explicit-only trigger wording is copied from `cursor-delegate`.
   - Expected: `node --check plugins/antigravity/scripts/lib/host-session.mjs` exits 0.
4. [ ] Run the Done when command. Expected: PASS.
5. [ ] Prove the test can fail: restore the fall back (`return matching.length > 0 ? matching : files;`), run, and expect FAIL on (b). Remove it again, run, and expect PASS.
6. [ ] Run `node --check plugins/antigravity/scripts/lib/host-session.mjs` and `node --check plugins/antigravity/scripts/antigravity-companion.mjs`. Expected: both exit 0. Then run the phase checkpoint. Expected: PASS.
