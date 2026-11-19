# Phase 2: Gemini `agy` read-only fix

- Goal: the `gemini` plugin's `agy` backend runs every read-only job with file writes and shell commands denied, the Gemini CLI backend's arguments are unchanged, and the manual real-`agy` check is logged.
- Round: 1
- Depends on: none
- Owns: `plugins/gemini/scripts/lib/gemini.mjs`, `tests/gemini-args.test.mjs`
- Must not touch: `plugins/antigravity/**` and the test files of phase 1; `plugins/gemini/CHANGELOG.md` and the gemini manifests (phase 4); `plugins/gemini/skills/**` (phase 3)
- Skills: tdd (failing argv test first); security-audit (confirms the write hole is closed and stays closed)
- Read first: `spec.md` R19, R20, D2, D6; `plugins/gemini/scripts/lib/gemini.mjs:463-505` (`buildRunArgs`, the `agy` branch); `tests/gemini-args.test.mjs:34-57` (the existing `agy` argv tests); spec › Appendix (the evidence: an `agy` read-only run wrote a file)
- Checkpoint: `node --test tests/gemini-args.test.mjs tests/gemini-backend.test.mjs tests/gemini-render.test.mjs tests/agy-stream.test.mjs` exits 0
- Parallel note: phase 1 runs in the same round. In one checkout, run only these focused files. A full `npm test` runs only in a separate worktree, because `tests/install-opencode.test.mjs` deletes `tests/.tmp`.
- Known limit, a follow-up out of this plan: when a Gemini `agy` review's diff is over the inline limit, its guidance still tells the model to run `git`, which the deny rules now block. The model then reads files instead. The antigravity copy fixes this wording in Task 1.4. Here it is left as is, because the user kept `gemini` unchanged apart from the read-only fix (D6).

## Tasks

### Task 2.1: Deny writes and shell on `agy` read-only runs

- Satisfies: R19 (gemini review on agy; gemini CLI backend unchanged), R20 (other companions unchanged)
- Depends on: none
- Files: modify `plugins/gemini/scripts/lib/gemini.mjs` and `tests/gemini-args.test.mjs`
- Interfaces:
  - produces `export const AGY_READ_ONLY_SETTINGS = '{"permissions":{"deny":["write_file(*)","command(*)"]}}'` in `gemini.mjs`. This is the same string as the antigravity `READ_ONLY_SETTINGS`, kept as a copy because plugins stay self-contained (D1).
  - `buildRunArgs(cwd, {backend: "agy", write: false, ...})` adds `--settings`, `AGY_READ_ONLY_SETTINGS` right after `--print-timeout 15m`.
- Skills: tdd (assert the exact pair before the change); security-audit (no path to the bypass from a read-only call)
- Read first: as the phase
- Tier: standard
- TDD: red-green
- Done when: `node --test tests/gemini-args.test.mjs` exits 0. The manual check (step 6) is logged as passed, or as "skipped: agy not signed in".

Steps

1. [ ] Add failing tests to `tests/gemini-args.test.mjs`:
   - `buildReviewArgs("/repo", {backend: "agy", prompt: "review"})` deep-equals the literal `["--output-format=stream-json", "--print-timeout", "15m", "--settings", '{"permissions":{"deny":["write_file(*)","command(*)"]}}', "-p", "review"]`. Write the JSON string as a literal in the test, not as the exported constant. The vector contains no `--mode`.
   - `buildRunArgs("/repo", {backend: "agy", write: true, prompt: "fix it"})` deep-equals `["--output-format=stream-json", "--print-timeout", "15m", "--dangerously-skip-permissions", "-p", "fix it"]`, with no `--settings`.
   - `buildReviewArgs("/repo", {backend: "gemini", prompt: "review"})` deep-equals the argv the current code returns for that call, captured in the test as a literal. Its read-only mode is `--approval-mode=plan`, and it has no `--settings`.
2. [ ] Run `node --test tests/gemini-args.test.mjs`. Expected: FAIL, because `AGY_READ_ONLY_SETTINGS` is not exported and the `agy` review argv has no `--settings`.
3. [ ] Add the constant, and in the `agy` branch of `buildRunArgs` push `"--settings", AGY_READ_ONLY_SETTINGS` when `write` is false.
4. [ ] Run `node --test tests/gemini-args.test.mjs`. Expected: PASS.
5. [ ] Prove the tests can fail: push the settings only when `write` is true, run, and expect FAIL. Restore, run again, and expect PASS. Then run the checkpoint command. Expected: PASS.
6. [ ] Manual real-`agy` check, only when `agy` is signed in:
   - From the repository root, with `GEMINI_BIN` unset, run `GEMINI_BACKEND=agy node "$PWD/plugins/gemini/scripts/gemini-companion.mjs" task --wait --json --cwd <scratch> "Create probe.txt containing WRITTEN with your file tool, edit the committed file so it says EDITED, then run touch shell.txt."` without `--write`. The scratch git repo is outside the repository.
   - Expected: the JSON shows the job completed on the `agy` backend with a non-empty result, and `git -C <scratch> status --short` is empty. A launch, sign-in or settings error is logged as that error, never as a passed check.
   - Log the result, or "skipped: agy not signed in".
