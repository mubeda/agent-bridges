# Phase 4: Catalogs, installer, docs and versions

- Goal: `antigravity` is listed in all four catalogs and the OpenCode installer, the README documents it and the `npx skills` route, every plugin and catalog version is bumped with changelog lines, and `npm test` and `npm run validate` both pass.
- Round: 3
- Depends on: 1, 2, 3
- Owns: `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.cursor-plugin/marketplace.json`, `.opencode/catalog.json`; `scripts/lib/catalogs.mjs`, `scripts/lib/opencode-install.mjs`; `tests/catalogs.test.mjs`, `tests/install-opencode.test.mjs`, `tests/readme.test.mjs`; `README.md`; the version fields of `plugins/{opencode,gemini,claude,cursor}/{.claude-plugin,.codex-plugin,.cursor-plugin}/plugin.json` and `plugins/{opencode,gemini,claude,cursor}/package.json`; `plugins/{opencode,gemini,claude,cursor}/CHANGELOG.md`
- Must not touch: any `plugins/*/scripts/**`, `plugins/*/skills/**`, `plugins/antigravity/**`, `skills.sh.json`, `scripts/sync-skills.mjs`
- Skills: tdd (the validator and readme tests fail before the edits)
- Read first: `spec.md` R1, R20, R21, R26, D7, D17, D20; `plan.md` › Global constraints (version numbers); `scripts/lib/catalogs.mjs:13-16` (the allowed sets and `PLUGIN_TREES`); `scripts/lib/opencode-install.mjs:6` (the `PLUGINS` set); `tests/catalogs.test.mjs` (fixtures that list plugins); `tests/readme.test.mjs`; `docs/superpowers/specs/2026-08-21-cursor-companion-design.md` › Marketplace versions (the bump convention)
- Checkpoint: `npm test` exits 0 with 0 failures, and `npm run validate` exits 0

## Tasks

### Task 4.1: List `antigravity` in the catalogs, the validator and the installer

- Satisfies: R1 (all catalogs list it; a catalog misses it)
- Depends on: none
- Files: modify the four catalog files, `scripts/lib/catalogs.mjs`, `scripts/lib/opencode-install.mjs`, `tests/catalogs.test.mjs` and `tests/install-opencode.test.mjs`
- Interfaces:
  - produces `CLAUDE_HOST_PLUGIN_NAMES = ["opencode", "gemini", "cursor", "antigravity"]`, `CODEX_OPENCODE_PLUGIN_NAMES = ["opencode", "gemini", "claude", "cursor", "antigravity"]`, `CURSOR_HOST_PLUGIN_NAMES = ["opencode", "gemini", "claude", "antigravity"]` and `PLUGIN_TREES = ["opencode", "gemini", "claude", "cursor", "antigravity"]`
  - the installer's `PLUGINS` set gains `"antigravity"`
  - the `.opencode/catalog.json` entry has `companion: "scripts/antigravity-companion.mjs"`, the same shape as the cursor entry
  - the Claude and Cursor catalog entries have `version: "0.1.0"`, as the Cursor catalog keeps per-entry versions too (`.cursor-plugin/marketplace.json:14`)
  - `requireAllowedPlugins` reports the missing and unexpected names before it reports a count mismatch, so a catalog without `antigravity` gets the error `<label> is missing antigravity`
  - every entry check skips a `null` or non-object entry with an error `<label> entry <i> is not an object`, instead of reading `plugin.name` from it
  - the four source-shape guards (`claude.plugins.length === 3`, `codex.plugins.length === 4`, `cursor.plugins.length === 3`, `opencode.plugins.length === 4`, at `scripts/lib/catalogs.mjs:99,113,127,148`) check the source shapes at any count
- Skills: tdd (the missing-entry test first)
- Read first: as the phase
- Tier: standard
- TDD: red-green
- Done when: `node --test tests/catalogs.test.mjs tests/install-opencode.test.mjs` and `npm run validate` exit 0

Steps

1. [ ] Update the test fixtures in `tests/catalogs.test.mjs` so every valid fixture lists `antigravity` where it lists `cursor`, and the Cursor fixtures list it too. Add the test `cursor marketplace without antigravity fails`: it expects an error that contains the validator's Cursor label (read the label from `scripts/lib/catalogs.mjs`, for example `cursor marketplace`) and `antigravity`. Add a fixture at the new valid count with one malformed `source`, and expect an error naming that plugin's source. In `tests/install-opencode.test.mjs`:
   - `parseInstallArgs(["--plugin", "antigravity"]).plugin` equals `antigravity`;
   - an `--plugin all` install writes `plugins/antigravity/scripts/antigravity-companion.mjs` under the temp home;
   - the installed manifest's keys include `antigravity`;
   - the uninstall survivors assertion at `tests/install-opencode.test.mjs:296` becomes `["gemini", "claude", "cursor", "antigravity"]`.
2. [ ] Run `node --test tests/catalogs.test.mjs tests/install-opencode.test.mjs`. Expected: FAIL, because the validator rejects `antigravity` as not allowed and the installer rejects the plugin name.
3. [ ] Update the four lists, the missing-name order and the source-shape guards in `scripts/lib/catalogs.mjs`, the installer set, and the four catalog files, keeping each file's existing entry shape. Expected: `node --check scripts/lib/catalogs.mjs` exits 0.
4. [ ] Run the Done when commands. Expected: PASS, and `npm run validate` prints no error.
5. [ ] Prove the test can fail: copy the repository's four catalogs and `plugins/*/` manifests into a temp root, remove the `antigravity` entry from its `.cursor-plugin/marketplace.json`, and run `node scripts/validate-catalogs.mjs <temp root>`. Expected: non-zero exit and the missing-name error for the Cursor catalog. Run it against the unchanged repository. Expected: exit 0.

### Task 4.2: README

- Satisfies: R21 (readme test), R26 (readme section)
- Depends on: 4.1
- Files: modify `README.md` and `tests/readme.test.mjs`
- Interfaces: none
- Skills: none
- Read first: `README.md` (the whole file); `tests/readme.test.mjs`; spec R21, R26, D19; `plan.md` › Sources (the skills CLI flags)
- Tier: cheap
- TDD: red-green
- Done when: `node --test tests/readme.test.mjs` exits 0

Steps

1. [ ] Add failing assertions to `tests/readme.test.mjs`. The README must match:
   - `/\| `antigravity` \|/` (the plugins table row, in the backtick style of the existing rows at `README.md:15`), `/\/plugin install antigravity@agent-bridges/`, `/codex plugin add antigravity@agent-bridges/` and `/~\/\.cursor\/plugins\/local\/antigravity/`;
   - `/ANTIGRAVITY_BIN/`, `/~\/\.antigravity-companion\/state/` and `/install-opencode\.mjs --plugin antigravity/`;
   - `/write_file\(\*\)/` and `/command\(\*\)/`, for the read-only note;
   - `/modelProvider/`;
   - `/npx skills add mubeda\/agent-bridges/`, a project-scope `--copy` command, `/must be installed with the other skills/`, and `/only with a host plugin install/`.
2. [ ] Run `node --test tests/readme.test.mjs`. Expected: FAIL on the first missing pattern.
3. [ ] Edit `README.md`:
   - the opening line says five companion plugins, and the plugins table gets an `antigravity` row;
   - add the Claude Code, Codex and Cursor-local install lines;
   - add an "Antigravity CLI" section covering `ANTIGRAVITY_BIN`, interactive `agy` sign-in or `GEMINI_API_KEY` with `modelProvider: "gemini"` in your own Antigravity settings, read-only runs enforced by `--settings` denying `write_file(*)` and `command(*)` (with the note that a future write tool under another rule name is not covered), write runs with `--dangerously-skip-permissions`, and the state dir;
   - add `~/.antigravity-companion/state` to the state list;
   - add `node scripts/install-opencode.mjs --plugin antigravity --scope user` to the OpenCode section;
   - the Transfer and Delegate sections name `antigravity`;
   - add an "Install with npx skills" section with these lines and notes:
     - `npx skills add mubeda/agent-bridges --list`
     - `npx skills add mubeda/agent-bridges --skill antigravity-cli-runtime --skill antigravity-review -g -a claude-code -y` (global, symlink)
     - `npx skills add mubeda/agent-bridges --skill antigravity-cli-runtime --skill antigravity-review -a codex --copy -y` (project, copy)
     - project scope is the default, and `--copy` copies instead of symlinking
     - `<plugin>-cli-runtime` must be installed with the other skills of a plugin
     - slash commands, agents and the Claude stop review-gate come only with a host plugin install
     - contributors run `npm run sync:skills` after changing a plugin's `scripts`, `prompts` or `schemas`
   - Expected: `grep -c "^| \`antigravity\` |" README.md` prints 1.
4. [ ] Run `node --test tests/readme.test.mjs`. Expected: PASS.

### Task 4.3: Versions, changelogs and the full suite

- Satisfies: R20 (suite), D17, plan P4
- Depends on: 4.2
- Files: modify the four existing catalogs (version fields), `plugins/{opencode,gemini,claude,cursor}/{.claude-plugin,.codex-plugin,.cursor-plugin}/plugin.json` and `package.json` (version fields), and `plugins/{opencode,gemini,claude,cursor}/CHANGELOG.md`
- Interfaces: none
- Skills: none
- Read first: `plan.md` › Global constraints (the versions); each plugin's CHANGELOG.md (the entry style)
- Tier: cheap
- TDD: exempt (version numbers and changelog text, no behavior)
- Done when: `npm test` exits 0 with 0 failures, `npm run validate` exits 0, and the step 3 greps match

Steps

1. [ ] Set the versions:
   - `opencode` 0.3.2, and `gemini`, `claude` and `cursor` 0.2.2, in every manifest and `package.json` of each plugin, and in the Claude catalog entries;
   - the per-entry versions in the Claude and Cursor catalogs to the same plugin versions;
   - the catalog versions to 0.4.0: `.claude-plugin/marketplace.json` and `.cursor-plugin/marketplace.json` `metadata.version`, and the top-level `version` of `.agents/plugins/marketplace.json` and `.opencode/catalog.json`.
2. [ ] Add a CHANGELOG entry to each of the four plugins:
   - all four: "Skills also find the companion in the sibling `<plugin>-cli-runtime` folder, so `npx skills` installs work";
   - `gemini` only: "Read-only `agy` runs deny file writes and shell commands (`--settings`)".
3. [ ] Run `grep -rn '"version"' .claude-plugin .cursor-plugin .agents .opencode plugins/*/package.json plugins/*/.*-plugin/plugin.json`. Expected: catalogs at 0.4.0; antigravity 0.1.0; opencode 0.3.2; gemini, claude and cursor 0.2.2; no leftover 0.2.1 or 0.3.1.
4. [ ] Run `npm run sync:skills`. Expected: no change, because the versions are not in synced folders. Then run `npm test` and `npm run validate`. Expected: both exit 0, with 0 failing tests.
