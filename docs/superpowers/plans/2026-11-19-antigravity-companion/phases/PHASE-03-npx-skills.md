# Phase 3: npx skills support

- Goal: the repository offers all 55 skills to the skills CLI. Each `<plugin>-cli-runtime` skill carries a byte-identical copy of its plugin's `scripts/`, `prompts/` and `schemas/`, guarded by a test. Every companion skill of the five plugins uses the new lookup order.
- Round: 2
- Depends on: 1, 2 (the sync copies files those phases create and change)
- Owns: `skills.sh.json`; `package.json` (the `scripts.sync:skills` entry only); `scripts/sync-skills.mjs`; `plugins/{opencode,gemini,claude,cursor,antigravity}/skills/*-cli-runtime/{scripts,prompts,schemas}/**` (generated); `plugins/{opencode,gemini,claude,cursor}/skills/*/SKILL.md`; `tests/skill-runtimes.test.mjs`, `tests/skill-lookup.test.mjs`
- Must not touch: `plugins/*/scripts/**` sources, `plugins/antigravity/skills/*/SKILL.md` (phase 1 wrote them with the new order), the catalogs, `README.md` and the manifests (phase 4)
- Skills: tdd (each check is a failing test before its file)
- Read first:
  - `spec.md` R22–R25 and D9, D18
  - `plan.md` › Sources, the skills CLI entries: `skills.sh.json` `paths` entries start with `./`, the whole folder is copied, and symlink is the default
  - `plugins/*/scripts/*-companion.mjs`, the `ROOT_DIR` lines: the companion resolves everything from its own folder, which is why a copy runs on its own
  - `plugins/opencode/skills/opencode-review/SKILL.md:7-14`: the current lookup block
- Checkpoint: `npm run sync:skills && node --test tests/skill-runtimes.test.mjs tests/skill-lookup.test.mjs` exits 0. A second `npm run sync:skills` leaves `git status --short` unchanged.

## Tasks

### Task 3.1: The discovery catalog

- Satisfies: R22 (list: 55 skills, including `antigravity-review` and `gemini-cli-runtime`; no extras)
- Depends on: none
- Files: create `skills.sh.json` and `tests/skill-runtimes.test.mjs`
- Interfaces: produces `skills.sh.json` = `{"paths": ["./plugins/opencode/skills", "./plugins/gemini/skills", "./plugins/claude/skills", "./plugins/cursor/skills", "./plugins/antigravity/skills"]}`
- Skills: tdd (the catalog test first); mstack-research (only if the skills CLI docs need a recheck of `paths`)
- Read first: https://raw.githubusercontent.com/vercel-labs/skills/HEAD/docs/creating-skills.md (the `skills.sh.json` `paths` field)
- Tier: cheap
- TDD: red-green
- Done when: `node --test tests/skill-runtimes.test.mjs` exits 0

Steps

1. [ ] Write the failing test `skills.sh.json lists the five plugin skill folders` in `tests/skill-runtimes.test.mjs`.
   - It reads `skills.sh.json` and checks that `paths` deep-equals the five entries above, in that order.
   - Every path starts with `./` and exists.
   - The count of `<path>/*/SKILL.md` over all paths is 55. The set of frontmatter `name` values has 55 unique entries and includes `antigravity-review` and `gemini-cli-runtime`.
   - No path points into a `commands`, `agents`, `scripts` or `tests` folder.
2. [ ] Run `node --test tests/skill-runtimes.test.mjs`. Expected: FAIL with ENOENT for `skills.sh.json`.
3. [ ] Create `skills.sh.json` with the JSON above.
4. [ ] Run the test. Expected: PASS.
5. [ ] Prove the test can fail: remove the antigravity entry and run the test. Expected: FAIL (the deep-equal or the count of 55). Restore it and run again. Expected: PASS.

### Task 3.2: `npm run sync:skills` and the byte-equality guard

- Satisfies: R25 (drift; re-sync), R23 (offline: the runtime copy runs the companion)
- Depends on: 3.1
- Files: create `scripts/sync-skills.mjs`; modify `package.json` (add `"sync:skills": "node scripts/sync-skills.mjs"`); generate `plugins/*/skills/*-cli-runtime/{scripts,prompts,schemas}/**`; modify `tests/skill-runtimes.test.mjs`
- Interfaces:
  - `scripts/sync-skills.mjs` exports `SYNCED_DIRS = ["scripts", "prompts", "schemas"]`, `PLUGINS = ["opencode", "gemini", "claude", "cursor", "antigravity"]`, `listPluginRuntimes(root) -> [{plugin, dir, source, target}]` (one entry per plugin and synced dir, built from `PLUGINS` so a missing runtime skill is never skipped silently) and `compareTrees(sourceDir, targetDir) -> string[]` (the relative paths that differ, are missing or are extra; a missing source with an existing target reports the whole target as extra).
  - Run as a script, it replaces each target folder with a fresh copy of its source folder, for every plugin that has one, and prints one line per plugin.
  - `syncPair(source, target) -> void`: removes `target`, then copies `source` to it when `source` exists. When `source` is gone, `target` is only removed, so a removed source never leaves stale generated files. The script calls it for every entry of `listPluginRuntimes`.
- Skills: tdd (the drift test before the script)
- Read first: `plugins/*/` (which of `scripts/`, `prompts/` and `schemas/` each plugin has); `package.json` (the scripts block)
- Tier: standard
- TDD: red-green
- Done when: `npm run sync:skills && node --test tests/skill-runtimes.test.mjs` exits 0

Steps

1. [ ] Add failing tests to `tests/skill-runtimes.test.mjs`:
   - Every `<plugin>-cli-runtime/SKILL.md` of the five plugins exists. For each entry of `listPluginRuntimes(root)`, `compareTrees(source, target)` deep-equals `[]`, and the assertion message names the first differing file.
   - `compareTrees` on two temp dirs where one file differs by one byte returns that file's relative path. With an extra file in the target, it returns the extra path. With the source dir removed, it returns the target's files.
   - `syncPair` on temp pairs: after it runs, `compareTrees` returns `[]` for a changed file, for an extra target file, and for a removed source (the target is gone too).
   - Running `node <repo>/plugins/antigravity/skills/antigravity-cli-runtime/scripts/antigravity-companion.mjs setup --json` from an unrelated temp cwd, with a fake `agy`, prints `version: "1.5.12"`. The fake is a Node script that this test writes into a temp dir, with `#!/usr/bin/env node` and mode 0755. It prints `1.5.12` for `--version`, and `ANTIGRAVITY_BIN` points at it. It is a copy of the phase 1 helper, not shared. The test skips on win32.
2. [ ] Run `node --test tests/skill-runtimes.test.mjs`. Expected: FAIL, because `scripts/sync-skills.mjs` is missing.
3. [ ] Implement `scripts/sync-skills.mjs` with `fs.rmSync(target, {recursive: true, force: true})` and `fs.cpSync(source, target, {recursive: true})`, and add the npm script.
4. [ ] Run `npm run sync:skills`, then `node --test tests/skill-runtimes.test.mjs`. Expected: PASS. Run `npm run sync:skills` again. Expected: `git status --short` lists no new changes.
5. [ ] Prove the test can fail without touching plugin sources, which this phase must not edit: append one byte to a file under `plugins/antigravity/skills/antigravity-cli-runtime/scripts/` (a generated copy) and run the test. Expected: FAIL naming that file. Run `npm run sync:skills` and the test again. Expected: PASS.
6. [ ] Run `node --check scripts/sync-skills.mjs`. Expected: exit 0.

### Task 3.3: The lookup order in the other 40 skills

- Satisfies: R24 (host plugin install unchanged; sibling runtime), R23 (runtime missing: the stop text names the runtime skill)
- Depends on: 3.2
- Files: modify the 40 `plugins/{opencode,gemini,claude,cursor}/skills/*/SKILL.md` files that hold a "Resolve `<plugin-root>`" block (every skill except `*-prompting`); create `tests/skill-lookup.test.mjs`
- Interfaces:
  - consumes the block format phase 1 used for the `antigravity` skills: six numbered entries, with entry 3 reading "the `<plugin>-cli-runtime` folder next to the folder that holds this SKILL.md (`<this skill's folder>/../<plugin>-cli-runtime`, installed with `npx skills`)". The anchor is the skill's own folder, which each host shows when it loads a skill. It is never the shell's cwd.
  - The block keeps its first line `Resolve \`<plugin-root>\`` and a one-line stop text that starts `If none exist,`, because `scripts/lib/opencode-install.mjs:134-150` replaces exactly that span.
  - The stop line: "If none exist, stop and print those paths, and say that an `npx skills` install also needs `<plugin>-cli-runtime`. Do not invent a companion elsewhere."
- Skills: tdd (the test over all 50 skills first)
- Read first: `plugins/antigravity/skills/antigravity-review/SKILL.md` (the finished block from phase 1); `plugins/opencode/skills/opencode-review/SKILL.md:7-14` (the current block); `scripts/lib/opencode-install.mjs:134-150` and `tests/install-opencode.test.mjs:110-130` (the installer rewrite and its test)
- Tier: standard
- TDD: red-green
- Done when: `node --test tests/skill-lookup.test.mjs tests/markdown-lookup.test.mjs tests/install-opencode.test.mjs` exits 0

Steps

1. [ ] Write the failing test in `tests/skill-lookup.test.mjs`. For each of the five plugins, take every `skills/*/SKILL.md` except `*-prompting`, 50 in all. In each file, the numbered list after "Resolve `<plugin-root>`":
   - has entry 1 `$CLAUDE_PLUGIN_ROOT` and entry 2 `$PLUGIN_ROOT`, unchanged;
   - has an entry 3 that contains both `the folder that holds this SKILL.md` and `<this skill's folder>/../<plugin>-cli-runtime`;
   - has entries 4 to 6 equal to that plugin's old entries 3 to 5;
   - ends with a stop line that names `<plugin>-cli-runtime`.
   Also assert the count is 50, and that each block starts with `Resolve \`<plugin-root>\`` and has one stop line starting `If none exist,`.
   Then add installed-layout tests that build temp layouts and resolve entry 3 from the setup skill's folder, never from the cwd. The path assertions run on every platform. The steps that spawn the companion with the POSIX fake skip on win32, and so does the symlink case.
   Also add, in the same file, an OpenCode install check on `cursor`, a plugin the installer already knows (`antigravity` joins it only in Task 4.1). After `installPlugins` for `cursor` into a temp home, the installed `skills/cursor-review/SKILL.md` contains `Use the installed plugin root` and contains neither `../cursor-cli-runtime` nor `If none exist`.
   A simulated resolver that walks the six entries is not written: the host model follows the text, so such a resolver would only test itself (plan review round 2, finding 8).
   Expected: `node --check tests/skill-lookup.test.mjs` exits 0.
   - Copy: `<tmp>/skills/antigravity-setup/` and `<tmp>/skills/antigravity-cli-runtime/` are real folders, copied from the repo. `path.resolve(<tmp>/skills/antigravity-setup, "..", "antigravity-cli-runtime", "scripts", "antigravity-companion.mjs")` exists, and running it with `setup --json` from an unrelated cwd, with the fake `agy`, prints `1.5.12`.
   - Symlink: the same two folders live in `<tmp>/canonical/`, and `<tmp>/agent/skills/<name>` are symlinks to them. Resolving from `<tmp>/agent/skills/antigravity-setup` finds the companion, and it runs.
   - Missing sibling: only `antigravity-setup` is present. The resolved path does not exist, and the setup SKILL.md stop line names `antigravity-cli-runtime`.
2. [ ] Run `node --test tests/skill-lookup.test.mjs`. Expected: FAIL for the 40 skills of `opencode`, `gemini`, `claude` and `cursor`. The 10 `antigravity` skills pass.
3. [ ] Edit the 40 files. In each, insert entry 3, renumber the old entries 3 to 5 as 4 to 6, and replace the stop line. Change nothing else in the files.
4. [ ] Run `npm run sync:skills`, because the `*-cli-runtime` SKILL.md files changed and the runtime copies hold only `scripts`, `prompts` and `schemas`, so nothing should change. Then run the Done when command. Expected: PASS, with no new `git status` changes from the sync.
5. [ ] Prove the test can fail: swap entries 1 and 2 in one cursor skill, run, and expect FAIL naming that file. Restore.
6. [ ] Run `git diff --stat -- plugins/opencode/skills plugins/gemini/skills plugins/claude/skills plugins/cursor/skills`. Expected: 40 files changed, each with only the lookup block lines.
