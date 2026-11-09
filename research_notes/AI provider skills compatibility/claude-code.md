# Claude Code: plugins, skills, marketplaces, and the `claude` CLI (state as of 2026-11-09)

Baseline: the docs at code.claude.com/docs were fetched 2026-11-09. The CHANGELOG top entry is **2.1.319**, and the CHANGELOG gives no dates. The local binary is `2.1.319 (Claude Code)`. Version gates in the docs go up to v2.1.302 (`-p` starts in Manual mode).

Status legend: **VALID** means unchanged and safe. **CHANGED** means it still works but the semantics or best practice moved. **DEPRECATED** means a legacy path or one marked for removal. **NEW** means a field or flag worth adopting.

## 1. plugin.json schema

### Takeaway
Only `name` is required, and the manifest file itself is optional. Every field the repo uses (name, version, description, author, license, keywords, and the component paths) is still valid. Watch four rules. Component paths must start with `./`. `commands` and `agents` *replace* their default dirs, while `skills` *adds to* its default. `hooks` files need a top-level `"hooks"` wrapper. Unknown top-level keys are stripped and reported as warnings.

### Cited Findings
- The manifest lives at `.claude-plugin/plugin.json`. All other files (skills/, commands/, hooks/) go at the plugin root, not inside `.claude-plugin/`. The manifest is optional, and without one the components load from the standard layout — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- Fields (VALID unless noted) — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference):
  - `name` (required, kebab-case): every component is namespaced under it (`deploy-tools:reviewer`). Reserved: an error for names starting `claude-`, `anthropic-`, `anthropics-`, or `cc-plugin-`, or equal to `claude`, `claude-code`, and similar. A **warning** for `claude`/`anthropic` as a whole word elsewhere (e.g. `mcp-for-claude`).
  - `version`: not semver-checked. Setting it pins users to that version until it changes.
  - `description`, `author` (object; `name` required, `email` and `url` optional), `homepage` (must parse as a URL or the plugin fails to load), `repository` (not validated), `license` (SPDX), `keywords` (array).
  - NEW/optional: `displayName`, `$schema`, `metadata` (v2.1.222+), `defaultEnabled` (default true), `dependencies`, `settings` (only `agent` and `subagentStatusLine` take effect), `userConfig`, `channels`, `types`, `lspServers`, `outputStyles`, `workflows`, `experimental.{themes,monitors,evals}`. The directory-listing fields `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, and `termsOfServiceUrl` are read only by Anthropic's directory. Before v2.1.281, `validate` warned on them.
  - `skills`: a path or array of directories. It **adds to** the default `skills/` scan. `"."` means the plugin root (v2.1.221+; use `"./"` for older versions).
  - `commands`: a path, an array, or an object map `{name: {source|content, description, argumentHint, model, allowedTools}}`. It **replaces** the default `commands/` scan.
  - `agents`: a path or array of `.md` **files** (directories aren't accepted). It **replaces** the default `agents/` scan.
  - `hooks`: a path, an inline object, or an array. It **merges** with `hooks/hooks.json`.
  - `mcpServers`: a path, a `.mcpb`/`.dxt` bundle, an `https://` bundle URL, an inline map, or an array. It merges with `.mcp.json`, and a later name wins.
- Unrecognized top-level key: stripped, the plugin still loads, and `validate` warns. Unknown keys inside `userConfig`/`channels`/`lspServers`/`monitors` are an **error** — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- Path rules: every component path is relative to the root and **must start with `./`** (`commands/foo.md` fails). A path must exist and must not escape the root via `..` — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- If a manifest key replaces a default folder that also exists (e.g. `commands` set while `commands/` exists), the folder is ignored with the warning `Default <folder>/ folder is ignored because the manifest sets "<key>"`. Avoid the warning by pointing at files inside the folder — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- Standard layout: `skills/<name>/SKILL.md`, `commands/*.md` ("**Prefer `skills/` for new plugins**"), `agents/*.md` (subfolders become part of the agent name), `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `output-styles/`, `workflows/`, `themes/`, `monitors/monitors.json`, `bin/` (on the Bash PATH; **claude.ai and Cowork refuse to install plugins with `bin/`**), `settings.json`. A root `CLAUDE.md` is **not loaded**, and `validate` warns about it — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- Env vars: `${CLAUDE_PLUGIN_ROOT}` is the installed version's path and changes on update, so don't write state there. `${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/<id>/`, kept across updates and deleted on the last uninstall unless `--keep-data`. `${CLAUDE_PROJECT_DIR}` is the project root. They're exported to hook processes and MCP stdio servers. **They aren't present in the Bash tool's environment.** In skill, command, and agent Markdown, write `${...}` in the body and it's substituted inline — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- `CLAUDE_PLUGIN_DATA` was added in v2.1.78 — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- `userConfig` values are referenced as `${user_config.KEY}` (MCP/LSP config, exec-form hook `args`, skill and agent content) or as the env var `CLAUDE_PLUGIN_OPTION_<KEY>` in hooks. Shell-form hook commands **reject** `${user_config.*}` — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)

- Status of the fields agent-bridges uses — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference):
  - VALID: `name`, `version`, `description`, `author`, `license`, `keywords`, `homepage`, `repository`, `mcpServers`, `hooks` (path, inline, or array), `skills`, `agents` (files only).
  - CHANGED: the `commands/` default dir still loads, but docs say "Prefer `skills/` for new plugins".
  - NEW: `displayName`, `metadata`, `defaultEnabled`, `dependencies`, `userConfig`, `settings`, `experimental.evals`, the directory-listing fields.
  - DEPRECATED: top-level `themes` and `monitors`. They still load, with a warning, and the docs say to move them under `experimental`.

### Inferences
- For agent-bridges, avoid setting `commands`/`agents` keys in plugin.json while also having those folders. Let the default dirs load.
- Keep `version` in plugin.json **or** marketplace.json, not both. When both are set, plugin.json wins and `validate` warns (see §2).

### Gaps
- No published JSON Schema URL for `$schema` was found on the page.

## 2. marketplace.json schema

### Takeaway
VALID. `name`, `owner`, and `plugins` are required. Relative sources must start with `./` and resolve from the marketplace root (the dir containing `.claude-plugin/`). Unknown keys only warn. The `strict` default is `true`.

### Cited Findings
- Location `.claude-plugin/marketplace.json`. Top-level fields: `name` (letters, digits, `.`, `_`, `-`; starts alphanumeric), `owner` (`name` required, `email`/`url` optional), `plugins`, `$schema`, `description` (missing it is a warning), `version`, `metadata.{description,version,pluginRoot}` (`pluginRoot` v2.1.239+), `forceRemoveDeletedPlugins`, `allowCrossMarketplaceDependenciesOn`, `renames` — [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Plugin entry fields: `name` and `source` (required), `description`, `version`, `category`, `tags`, `strict` (default true), `relevance`, `dependencies`, `defaultEnabled`, `displayName`, `metadata`, `headers`/`headersHelper` (archive only), **plus any plugin.json field** except the directory-listing fields — [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Source types: relative path (`./...`, or a bare name under `pluginRoot`), `github` {repo, ref, sha}, `url` {url, ref, sha}, `git-subdir` {url, path, ref, sha}, `npm` {package, version, registry}, `archive` {url, sha256} (v2.1.224+), `command` {command, timeout, mode} (v2.1.229+) — [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Strict mode: with plugin.json present and `strict: true`, entry `commands`/`agents`/`skills`/`outputStyles`/`themes` are **appended**, and entry `hooks` matchers replace the manifest's per event. With `strict: false` plus any entry component field, the result is `Plugin <name> has conflicting manifests`. When plugin.json exists, the entry's `mcpServers`/`lspServers`/`userConfig`/`channels` are ignored — [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Version precedence: plugin.json `version` beats the entry's. `validate` warns `Entry declares version "x" but <path>/plugin.json says "y". At install time, plugin.json wins` — [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Reserved marketplace names include `claude-code-marketplace`, `claude-plugins-official`, `agent-skills`, `anthropic-agent-skills`, `inline`, `builtin`, `skills-dir`, `synced`, and `npm`/`github`/`gh`, among others, plus impersonating names and names starting `claudeai-` — [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Claude Desktop warnings: names must match letters, digits, `.`, `_`, `-`, start alphanumeric, max 128 chars — [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- New `validate` *advice* (v2.1.295+): it flags a plugin README with no install line (`/plugin install <p>@<mkt>` or `... --marketplace <owner/repo>`). The advice doesn't affect the exit code — [plugins/cli-reference](https://code.claude.com/docs/en/plugins/cli-reference)

### Inferences
- Add an install line `/plugin install <name>@<marketplace>` to each plugin README to silence the advice.

### Gaps
- None material.

## 3. SKILL.md frontmatter, commands merging into skills, and the Agent Skills standard

### Takeaway
All listed fields are VALID. In Claude Code, every frontmatter field is optional, and unknown fields are silently ignored. `description` is recommended, and `description` plus `when_to_use` is truncated at **1,536 chars** in the listing. Commands and skills were **merged in v2.1.3**: `commands/x.md` and `skills/x/SKILL.md` both create `/x`. Commands still work, but docs say "Prefer `skills/` for new plugins". The agentskills.io standard is stricter. `name` and `description` are required there, `name` is ≤64 chars of `[a-z0-9-]` and must match the directory, and `description` is ≤1024 chars. Uploads outside Claude Code reject any key outside the spec set.

### Cited Findings
- Claude Code SKILL.md fields — [skills](https://code.claude.com/docs/en/skills):
  - `name`: defaults to the directory name. Control, zero-width, bidi, and `<`/`>` characters are refused. No length limit is stated.
  - `description`: recommended. It defaults to the first non-empty body line.
  - `when_to_use` (NEW): appended to the description and counts toward the 1,536 cap.
  - `argument-hint`, plus `arguments` (NEW; named positional args used as `$name`).
  - `disable-model-invocation` (default false): also blocks preloading into subagents and scheduled tasks.
  - `user-invocable` (default true): `false` hides the skill from the `/` menu.
  - `allowed-tools`: pre-approval for the invoking turn only. The grant clears on your next message, and it **does not restrict** other tools.
  - `disallowed-tools` (NEW).
  - `model` (or `inherit`).
  - `effort` (`low|medium|high|xhigh|max`).
  - `context: fork`, plus `agent` (default `general-purpose`) and `background` (default true with fork).
  - `hooks`, `paths` (globs), `shell` (`bash|powershell`), `metadata`, `license`, `compatibility` (≤500).
  - Booleans accept true/false, yes/no, on/off, and 1/0.
- Body substitutions: `$ARGUMENTS`, `$ARGUMENTS[N]`/`$N`, `$name`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` (plugin skills only). If no placeholder consumes the args, `ARGUMENTS: <value>` is appended — [skills](https://code.claude.com/docs/en/skills)
- Guidance: keep SKILL.md under 500 lines and move detail into supporting files — [skills](https://code.claude.com/docs/en/skills)
- Commands vs skills: "A file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way. Existing `.claude/commands/` files keep working." — [skills](https://code.claude.com/docs/en/skills). CHANGELOG 2.1.3: "Merged slash commands and skills, simplifying the mental model with no change in behavior". The CHANGELOG now calls command files "legacy" (2.1.277: "a skill or legacy command") — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Portability: outside Claude Code (claude.ai uploads, Skills API, `package_skill.py`), only `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools` are accepted. "Any other key causes a hard error on upload." — [skills](https://code.claude.com/docs/en/skills)
- agentskills.io spec — [agentskills.io/specification](https://agentskills.io/specification):
  - `name`: required, 1–64 chars, lowercase `a-z0-9` and `-`, no leading or trailing `-`, no `--`, and it **must match the parent directory name**.
  - `description`: required, 1–1024 chars, covering what the skill does and when to use it.
  - `license`: optional.
  - `compatibility`: optional, 1–500 chars.
  - `metadata`: a string→string map.
  - `allowed-tools`: a **space-separated** string, and experimental.
  - Optional dirs: `scripts/`, `references/`, `assets/`. Keep file references one level deep.
  - Progressive disclosure: metadata about 100 tokens, body under 5000 tokens recommended, SKILL.md under 500 lines.
  - Validator: `skills-ref validate ./my-skill`.
- Status of the fields — [skills](https://code.claude.com/docs/en/skills):
  - VALID: `name`, `description`, `user-invocable`, `disable-model-invocation`, `allowed-tools`, `argument-hint`, `model`, `context: fork`, `agent`.
  - NEW: `when_to_use`, `arguments`, `disallowed-tools`, `effort`, `background`, `paths`, `shell`, `hooks`, `metadata`, `license`, `compatibility`.
  - CHANGED: standalone `commands/*.md` is legacy and merged into skills (2.1.3).
  - No skill field is marked deprecated.
- No spec version or date is shown on the agentskills.io page — [agentskills.io/specification](https://agentskills.io/specification)

### Inferences
- For a multi-host repo, the portable intersection is: `name` matching the dir, kebab-case, ≤64 chars; `description` ≤1024 chars with the trigger keywords first; optional `license`, `compatibility`, `metadata` (string values), and `allowed-tools`. Claude-only fields (`user-invocable`, `disable-model-invocation`, `argument-hint`, `model`, `context`, `agent`, `effort`, `when_to_use`) are ignored by other Agent Skills hosts at best. They **hard-fail** on claude.ai and Skills API upload, so strip them for those targets.
- Prefer migrating `commands/*.md` to `skills/<name>/SKILL.md` (adding `disable-model-invocation: true` where a command should stay user-only). The docs don't deprecate `commands/`, but they steer away from it.

### Gaps
- No explicit removal date for `commands/` was found. The docs say "legacy" and "prefer skills" only.
- Claude Code's own max `name` length isn't stated. Use the spec's 64.

## 4. Command frontmatter (commands/*.md)

### Takeaway
VALID, through the merge: command files take the same frontmatter as skills (description, argument-hint, allowed-tools, disable-model-invocation, model, etc.). The plugin.json object-map form uses camelCase `argumentHint`/`allowedTools`.

### Cited Findings
- Commands and skills "work the same way" and share frontmatter — [skills](https://code.claude.com/docs/en/skills)
- plugin.json `commands` object-map fields: `source`|`content` (exactly one), `description`, `argumentHint`, `model`, `allowedTools` — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- `validate` checks command-file frontmatter for missing or invalid YAML (`No frontmatter block found` is a warning, fatal only under `--strict`; `YAML frontmatter failed to parse`) — [troubleshooting](https://code.claude.com/docs/en/plugins/troubleshooting)
- An empty `commands` path gives the debug-log warning `No commands found in plugin <name> custom directory ... Expected .md files or SKILL.md in subdirectories.` — [troubleshooting](https://code.claude.com/docs/en/plugins/troubleshooting)

- Status (all from the skills table above): VALID for `description`, `argument-hint`, `allowed-tools`, `disable-model-invocation`, `model`. CHANGED: the command *file format* itself is legacy, so prefer `skills/<name>/SKILL.md` — [skills](https://code.claude.com/docs/en/skills); [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)

### Inferences
- Commands can be migrated 1:1 to `skills/<name>/SKILL.md` with the same frontmatter. Add `disable-model-invocation: true` to keep them user-only.

### Gaps
- I didn't find a separate command-only frontmatter table. The skills table is authoritative.

## 5. Subagent frontmatter (agents/*.md)

### Takeaway
VALID. `name` and `description` are required. **Plugin agents ignore `hooks`, `mcpServers`, `permissionMode`, and `initialPrompt`.**

### Cited Findings
- Fields — [sub-agents](https://code.claude.com/docs/en/sub-agents):
  - `name`: required, ≤256 chars, no `:`. The filename needn't match.
  - `description`: required.
  - `tools`: a comma-string or YAML list. Omit it to inherit. Use `skills`, not `Skill`, to preload skills.
  - `disallowedTools`.
  - `model`: `sonnet|opus|haiku|fable|<full id>|inherit`.
  - `permissionMode`: `default|acceptEdits|auto|dontAsk|bypassPermissions|plan|manual`.
  - `maxTurns`, `autoCompactWindow` (v2.1.296+).
  - `skills`: full content preloaded.
  - `mcpServers`, `hooks`.
  - `memory`: `user|project|local`.
  - `background`, `omitClaudeMd` (v2.1.271+), `effort` (`low..max`).
  - `isolation: worktree`.
  - `color`: red, blue, green, yellow, purple, orange, pink, cyan.
  - `initialPrompt`, `experimental.cacheTtl` (v2.1.248+).
- "For security reasons, plugin subagents don't support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields. These fields are ignored when loading agents from a plugin." `initialPrompt` is also ignored for plugin subagents — [sub-agents](https://code.claude.com/docs/en/sub-agents)
- Plugin agents appear as `<plugin>:<agent>`, and subfolders under `agents/` become part of the name — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)

- Status: VALID for `name`, `description`, `tools`, `model`, `skills`. NEW: `effort`, `isolation`, `memory`, `background`, `omitClaudeMd`, `autoCompactWindow`, `color`, `experimental`. CHANGED for plugin-shipped agents: `hooks`, `mcpServers`, `permissionMode`, and `initialPrompt` are ignored — [sub-agents](https://code.claude.com/docs/en/sub-agents)

### Inferences
- If agent-bridges agents set `permissionMode` or `mcpServers`, those lines have no effect when shipped via the plugin. Move MCP servers to `.mcp.json` and hooks to `hooks/hooks.json`.

### Gaps
- None.

## 6. Hooks: Stop hook format and env vars

### Takeaway
VALID. `hooks/hooks.json` = `{"description"?: "...", "hooks": {"Stop": [{"matcher"?: "...", "hooks": [{"type":"command","command":"...", ...}]}]}}`. A Stop hook blocks with `{"decision":"block","reason":"..."}` or exit 2 (stderr becomes the reason). NEW, softer option: `hookSpecificOutput.additionalContext`. Loop guards are `stop_hook_active` and an 8-consecutive-continuation cap.

### Cited Findings
- File shape: a hooks *file* must wrap the event map in a top-level `"hooks"` key, and a file without the wrapper fails to load. An inline object in plugin.json is the bare event map — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- Command hook fields — [hooks](https://code.claude.com/docs/en/hooks):
  - `type`, `command` (required).
  - `args` (exec form, no shell).
  - `async`, `asyncRewake`, `shell` (`bash|powershell`), `onFailure` (`continue|block`, v2.1.295+).
  - Common: `if`, `timeout` (defaults: command 600s, prompt 30s, agent 60s), `statusMessage`, `once`.
- Stop input: common fields plus `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. Stop doesn't fire on a user interrupt. API errors fire `StopFailure` instead — [hooks](https://code.claude.com/docs/en/hooks)
- Stop decision control: `decision: "block"` plus a required `reason`, or exit code 2 (stderr is the reason), or `hookSpecificOutput: {hookEventName:"Stop", additionalContext:"..."}`, which continues without being labelled an error. After 8 consecutive continuations Claude Code overrides the block. The count resets on any tool call, and `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it — [hooks](https://code.claude.com/docs/en/hooks)
- Use `last_assistant_message` rather than reading `transcript_path` at Stop time, because the transcript may not yet include the final message — [hooks](https://code.claude.com/docs/en/hooks)
- Hook env: `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_OPTION_<KEY>`, `CLAUDE_EFFORT`, `CLAUDE_CODE_REMOTE`. There's no `$CLAUDE_MODEL` — [hooks](https://code.claude.com/docs/en/hooks)
- Quote `${CLAUDE_PLUGIN_ROOT}` in shell-form commands (`"\"${CLAUDE_PLUGIN_ROOT}\"/scripts/x.sh"`) or use exec form. `validate` warns about an unquoted variable — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- Under `claude --bare`, plugin hooks (hooks.json, or loaded via `--plugin-dir`) **don't run** — [headless](https://code.claude.com/docs/en/headless)

- Status: VALID for the `hooks/hooks.json` wrapper shape, Stop `decision: "block"` plus `reason`, exit code 2, `CLAUDE_PLUGIN_ROOT`, and `CLAUDE_PLUGIN_DATA` (since 2.1.78). NEW: Stop `hookSpecificOutput.additionalContext`, the `background_tasks`/`session_crons` inputs, the exec-form `args`, `asyncRewake`, `onFailure`, and the 8-continuation cap — [hooks](https://code.claude.com/docs/en/hooks)

### Inferences
- Stop hooks should check `stop_hook_active` and prefer `additionalContext` for guidance-style continuations. They should use exec form (`command` plus `args`) to avoid quoting bugs with `${CLAUDE_PLUGIN_ROOT}`.

### Gaps
- I didn't fetch the common JSON output fields (`continue`, `stopReason`, `systemMessage`, `suppressOutput`) verbatim. They apply to Stop too, but I didn't record their exact semantics here.

## 7. `claude` CLI flags used as a backend

### Takeaway
All flags exist in 2.1.319. Key corrections:
- `--json-schema` takes an **inline JSON string only**. A file path fails with `Error: --json-schema is not valid JSON` (tested locally).
- `--bg` **cannot combine with `-p`**. The prompt is positional, and the command prints a short id.
- `--effort` values are `low|medium|high|xhigh|max` (docs add `ultracode`).
- Background sessions isolate into `.claude/worktrees/` before their first edit.
- From v2.1.302, `-p` starts in **Manual** mode when nothing sets a mode.

### Cited Findings
- `-p/--print`: non-interactive. `--output-format text|json|stream-json`. The JSON result has `result`, `session_id`, `total_cost_usd` plus a per-model cost breakdown, and `structured_output` when `--json-schema` is used. The `structured_output` field is **absent** if the run ended without valid output, so check it before use — [headless](https://code.claude.com/docs/en/headless); [cli-reference](https://code.claude.com/docs/en/cli-reference)
- `--json-schema`: "Get validated JSON output matching a JSON Schema after the agent completes its workflow (print mode only)". The example is inline JSON. An invalid schema exits with `Error: --json-schema is not a valid JSON Schema`. `format` is accepted as an annotation only (CHANGELOG 2.1.205) — [cli-reference](https://code.claude.com/docs/en/cli-reference); [headless](https://code.claude.com/docs/en/headless). A local test with v2.1.319, `claude -p --bare --json-schema ./s.json ...`, gave `Error: --json-schema is not valid JSON: JSON Parse error: Unexpected token '.'`, so **file paths are unsupported** (local test; for comparison, `--agents` accepts a file path with `--print` since v2.1.281).
- `--permission-mode`: `default|acceptEdits|plan|auto|dontAsk|bypassPermissions|manual` (`manual` is an alias for default, v2.1.200+). `--dangerously-skip-permissions` equals `--permission-mode bypassPermissions`. `--allow-dangerously-skip-permissions` adds bypass to the Shift+Tab cycle without starting in it — [cli-reference](https://code.claude.com/docs/en/cli-reference)
- `-p` default mode: "With Claude Code v2.1.302 or later, `claude -p` runs start in Manual mode when nothing sets a permission mode". In Manual `-p`, calls that need approval are denied unless something approves them. NEW: `--permission-prompts none` (v2.1.259+) for unattended runs — [headless](https://code.claude.com/docs/en/headless)
- `--model`: alias (`sonnet`, `opus`, `haiku`, `fable`) or full name. It overrides the `model` setting and `ANTHROPIC_MODEL` — [cli-reference](https://code.claude.com/docs/en/cli-reference)
- `--effort`: "Options: `low`, `medium`, `high`, `xhigh`, `max`, or `ultracode`. Available levels depend on the model." `ultracode` is xhigh with ultracode on (v2.1.203+). It is session-only and doesn't persist — [cli-reference](https://code.claude.com/docs/en/cli-reference). Local `claude --help` (2.1.319) lists only `low, medium, high, xhigh, max`. `xhigh` was added in 2.1.111, and other models fall back to `high` — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- `--name/-n`: a display name shown in `/resume` and the terminal title. You can resume with `claude --resume <name>`. `claude -p --resume <name>` accepts names set with `--name` or `/rename` — [cli-reference](https://code.claude.com/docs/en/cli-reference); [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- `--resume/-r <id|name|path.jsonl>`: searches the current project and worktrees, then all projects (v2.1.223+). `--continue/-c`: the most recent conversation in the cwd. It **skips `-p`/SDK sessions unless itself run with `-p`**. `--fork-session` makes a new id on resume. `--session-id <uuid>` sets the id — [cli-reference](https://code.claude.com/docs/en/cli-reference). Headless pattern: `session_id=$(claude -p ... --output-format json | jq -r .session_id); claude -p "..." --resume "$session_id"` — [headless](https://code.claude.com/docs/en/headless)
- `--bg/--background`: "Start the session as a background agent and return immediately. Prints the session ID and management commands... Can't be combined with `-p`/`--print`". The prompt is positional (`claude --bg --name x "prompt"`). It combines with `--agent`, `--exec`, and `--resume <id>`. It checks workspace trust first and exits `Workspace not trusted` when no dialog can show. Output: `backgrounded · 7c5dcf5d · <name>` plus the attach/logs/stop commands — [cli-reference](https://code.claude.com/docs/en/cli-reference); [agent-view](https://code.claude.com/docs/en/agent-view)
- Background management: `claude attach <id|name>` (name matching v2.1.290+; by name only while running), `claude logs <id|name>`, `claude stop <id>` (alias `kill`), `claude respawn <id> [--all]`, `claude rm <id>`, `claude agents [--json [--all]] [--cwd]`, `claude daemon status|logs|stop`. The short id is the dir name under `~/.claude/jobs/`, and the `sessionId` UUID is usable with `--resume` — [agent-view](https://code.claude.com/docs/en/agent-view)
- Programmatic polling: use `claude agents --json --all` and read `state` (`working|blocked|done|failed|stopped`), `status` (`busy|waiting|idle`), and `waitingFor`. "The files under `~/.claude/jobs/<id>/` are not a stable interface." — [agent-view](https://code.claude.com/docs/en/agent-view)
- Worktrees: "Before editing files, Claude moves the session into an isolated git worktree under `.claude/worktrees/`". This is skipped if the session is already in a linked worktree, if the directory isn't git (and has no `WorktreeCreate` hook), or if the write is outside the cwd. Disable it with `{"worktree":{"bgIsolation":"none"}}`. Sessions are told to commit and push and never push to main/master. Idle unattached sessions stop after about an hour, and their conversations resume on attach — [agent-view](https://code.claude.com/docs/en/agent-view). `--worktree/-w <name>` creates `<repo>/.claude/worktrees/<name>` explicitly — [cli-reference](https://code.claude.com/docs/en/cli-reference)
- Permission, model, and effort for `--bg`: the session starts as a new `claude` session in that directory would. `--dangerously-skip-permissions` persists across supervisor restarts — [agent-view](https://code.claude.com/docs/en/agent-view); [cli-reference](https://code.claude.com/docs/en/cli-reference)
- Agent view is a **research preview**. It can be disabled with `disableAgentView` or `CLAUDE_CODE_DISABLE_AGENT_VIEW` — [agent-view](https://code.claude.com/docs/en/agent-view)
- Other useful flags:
  - `--bare`: skips the discovery of hooks, skills, plugins, MCP, and CLAUDE.md. It needs `ANTHROPIC_API_KEY` (no OAuth) and "will become the default for `-p` in a future release" — [headless](https://code.claude.com/docs/en/headless)
  - `--max-turns`, `--max-budget-usd`, `--no-session-persistence`: print mode only.
  - `--plugin-dir`: repeatable, accepts a `.zip` or a folder of plugins (v2.1.265+), and must point at the plugin root, not the marketplace root.
  - `--agent`, `--agents <json|file>`.
  - `--forward-subagent-text`.
  - `--enable-auto-mode`: **removed in v2.1.111**.
  - Sources: [cli-reference](https://code.claude.com/docs/en/cli-reference)
- `-p` runs wait up to 10 minutes idle for background work before exiting (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). SIGTERM exits with 143 — [headless](https://code.claude.com/docs/en/headless)
- CI gate: `system/init` in stream-json carries `plugins` and `plugin_errors` — [headless](https://code.claude.com/docs/en/headless)

### Inferences
- A backend wrapper that passes a schema *file* must `cat` it into the argument (`--json-schema "$(cat schema.json)"`).
- For backgrounded work, use `claude --bg --name X "prompt"`, then poll `claude agents --json --all`. You can't get a JSON result from `--bg`. For a result, attach. Or, once `claude agents --json` reports `done` or `stopped`, run `claude -p --resume <sessionId> --output-format json`. Under `-p`, `--resume`/`--continue` open only a *finished* background session. A running one is reached through `claude attach`.
- Flag status:
  - VALID: `-p`, `--output-format json`, `--permission-mode plan`, `--dangerously-skip-permissions`, `--model`, `--resume`, `--continue`, `--name`, `--bg`, `claude attach`.
  - VALID but inline-only: `--json-schema`.
  - CHANGED: the `-p` default permission mode (Manual since v2.1.302). `--effort` gained `xhigh` (2.1.111) and `ultracode` (docs).
  - DEPRECATED/removed: `--enable-auto-mode` (v2.1.111).
  - NEW: `--permission-prompts none`, `--bare`, `--exec`, `claude logs`/`stop`/`respawn`/`rm`/`agents --json`.
- Because `-p` now defaults to Manual mode (deny on prompt), a backend that relied on the older default must pass `--permission-mode` explicitly.

### Gaps
- Whether `ultracode` is accepted on the main `--effort` flag in 2.1.319 is unclear: the docs list it, and local `--help` doesn't. I didn't test it, because doing so would need a paid model call.
- The CHANGELOG has no dates, so the release date per version is unknown.

## 8. `/skill-doctor`, `claude plugin validate`, `claude plugin eval`

### Takeaway
`validate` is the **static** check. It covers manifests, the frontmatter YAML of skills, agents, and commands, `hooks/hooks.json`, MCP entries, paths, reserved names, and unquoted plugin vars. `eval` is the **behavioral** check: trigger rate and outcome versus a no-plugin baseline. `/skill-doctor` is a **usage and context-cost** report, not a linter.

### Cited Findings
- `claude plugin validate <path> [--strict] [--json]`. `--json` needs v2.1.259+. Exit 0 means pass (or pass with warnings), 1 means fail (or a warning under `--strict`), and 2 means a validator error. Given a dir, it validates marketplace.json, else plugin.json, else component dirs (`skills`/`agents`/`commands`, or a `.claude/` dir; v2.1.233+). It validates both manifests when both exist (v2.1.289+). It **doesn't follow symlinks** in skills/agents/commands, and it warns or errors on them. It doesn't check a root-level `SKILL.md`. It warns on a root `CLAUDE.md`. A marketplace run **doesn't open the component files of listed plugins**, so validate each plugin dir separately — [plugins/cli-reference](https://code.claude.com/docs/en/plugins/cli-reference)
- Skill-related validate messages:
  - `Path is a file; skills entries must be directories containing SKILL.md` (error).
  - `No frontmatter block found` (warning; fatal under `--strict`).
  - `YAML frontmatter failed to parse: <error>` (error).
  - `Unknown field '<key>'` (warning) for manifests.
  - Other warnings, such as a missing description, exist but aren't enumerated.
  - Source: [troubleshooting](https://code.claude.com/docs/en/plugins/troubleshooting)
- Manifest warnings include a name that isn't kebab-case and missing `version`/`description`/`author`. MCP checks (v2.1.281+) include undeclared `${user_config.KEY}`, a bad remote URL, non-loopback `http://`, and literal credentials in headers — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- CHANGELOG: 2.1.77 "Improved `claude plugin validate` to check skill, agent, and command frontmatter plus `hooks/hooks.json`, catching YAML parse errors and schema violations". 2.1.145 flags `skills:` entries pointing at a file. 2.1.233 validates a bare `.claude/skills` dir — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- `claude plugin eval` (v2.1.269+):
  - Cases live in `evals/<case>/` with `prompt.md` and/or `case.yaml` (`schema_version: "1.1"`, `name`), plus `graders/*.md`.
  - Grader types: `regex`, `tool_used`, `tool_order`, `file_exists` (free); `llm`, `baseline` (judge model). There are no custom-code graders.
  - Each case runs 3× with the plugin and 3× without it. A case passes at `--threshold` (default 1.0).
  - `tool_used: Skill` graders measure triggering and aren't scored in two-arm runs.
  - Flags: `--runs`, `--model`, `--judge-model`, `--ablation none|with-without`, `--json`, `--eval-dir`, `--case`, `--tag`, `--max-cost-usd`. Exit 2 means a partial run.
  - `claude plugin eval init` scaffolds the cases.
  - Runs are isolated: no user or project settings, CLAUDE.md, or other plugins load.
  - The "most common first finding" is the skill not triggering on natural phrasing, and the fix is to adjust `description`.
  - Source: [plugin-evals](https://code.claude.com/docs/en/plugin-evals)
- The eval directory can be overridden with plugin.json `"experimental": {"evals": "quality/evals"}` — [plugins-reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- `/skill-doctor` (v2.1.252+ per docs; the CHANGELOG adds it in 2.1.261): it reports each skill's context cost and usage, and flags listed skills that were never invoked and plugins unused recently. It excludes bundled and enterprise skills. Interactive runs show it in `/plugin` → Stats, and `-p` prints text. It isn't available over Remote Control — [skills](https://code.claude.com/docs/en/skills); [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Why a skill isn't invoked: `disable-model-invocation: true`, a description that doesn't match how people ask, or a description truncated by the listing budget when many skills are installed — [troubleshooting](https://code.claude.com/docs/en/plugins/troubleshooting)

### Inferences
- Rules to apply in agent-bridges CI:
  1. Run `claude plugin validate . --strict` at the repo root (marketplace plus root plugin) **and** `claude plugin validate plugins/<name> --strict` for each plugin, because marketplace runs skip component files.
  2. Every SKILL.md has valid `---` YAML frontmatter with a `name` that equals its dir in kebab-case ≤64 chars, for agentskills.io portability.
  3. `description` is ≤1024 chars (spec), with the key use case in the first sentence (the Claude listing truncates `description` plus `when_to_use` at 1,536).
  4. No `CLAUDE.md` at the plugin root.
  5. Quote `"${CLAUDE_PLUGIN_ROOT}"` in hook commands.
  6. Don't symlink skills, agents, or commands.
  7. Optionally run `skills-ref validate` per skill.
  8. Optionally add `evals/` cases with a `tool_used: Skill` grader to measure triggering.

### Gaps
- The full list of `validate` warnings for skill frontmatter (e.g. whether it warns on a name/dir mismatch, an unknown skill key, or description length) isn't enumerated in the docs. The docs say only "Other warnings, such as a missing description, aren't listed." Unknown SKILL.md fields are "ignored without error" at runtime.
- The `/skill-doctor` minimum version conflicts: the docs say v2.1.252 and the CHANGELOG entry sits under 2.1.261.
