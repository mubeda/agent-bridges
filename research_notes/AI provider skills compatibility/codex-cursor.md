# Codex CLI and Cursor plugin/skills/CLI compatibility (checked 2026-11-09)

Ground truth used: the docs (fetched 2026-11-09), the `openai/plugins` plugin-creator spec, and the CLIs installed on this machine: `codex-cli 0.167.0` (GitHub release `rust-v0.167.0`, published 2026-11-06) and Cursor Agent CLI `2026.10.01-e373342`. Docs pages carry no dates, so "current" means "live on 2026-11-09".

Note: `developers.openai.com/codex/*` now returns a 308 redirect to `learn.chatgpt.com/docs/*`. Update doc links in the repo to match.

## Codex: marketplace, plugin.json, install commands, env vars

### Takeaway
Most of what the repo assumes about Codex is still valid. The marketplace path, the `.codex-plugin/plugin.json` fields, `codex plugin marketplace add`, `codex plugin add name@marketplace`, and `PLUGIN_ROOT`/`PLUGIN_DATA` all still work. There are two additions: a portable root `plugin.json` (Agent Plugins standard 1.0.0), and extra manifest fields (`hooks`, `mcpServers`, `apps`, `onboardingSkill`, more `interface` keys). Codex plugins have no documented `commands` or `agents` component.

### Cited Findings
- **Marketplace location: still valid.** The repo path is `$REPO_ROOT/.agents/plugins/marketplace.json`. Codex also reads a legacy-compatible `$REPO_ROOT/.claude-plugin/marketplace.json` and a personal `~/.agents/plugins/marketplace.json`. — [Codex: Build plugins](https://developers.openai.com/codex/plugins/build)
- **Marketplace schema.** Top level is `name`, optional `interface.displayName`, and `plugins[]` (the array order sets render order). Each entry has `name`, `source`, `policy`, and `category`. `source.source` is one of `local` (`path` starting `./`), `url`, `git-subdir` (`url`, `path`, `ref`/`sha`), or `npm` (`package`, `version`, `registry`). `policy.installation` is `AVAILABLE`, `INSTALLED_BY_DEFAULT`, or `NOT_AVAILABLE`. `policy.authentication` is `ON_INSTALL` or on first use. — [Codex: Build plugins](https://developers.openai.com/codex/plugins/build); [openai/plugins plugin-json-spec.md](https://raw.githubusercontent.com/openai/plugins/main/.agents/skills/plugin-creator/references/plugin-json-spec.md)
- **`.codex-plugin/plugin.json`: still valid, now called a "compatibility overlay".** Spec fields:
  - Top level: `name` (kebab-case; it is also the component namespace), `version`, `description`, `author{name,email,url}`, `homepage`, `repository`, `license`, `keywords[]`, `skills` (path), `hooks` (path), `mcpServers` (path, e.g. `./.mcp.json`), `apps` (path, e.g. `./.app.json`), `interface`.
  - `interface`: `displayName`, `shortDescription`, `longDescription`, `developerName`, `category`, `capabilities[]`, `websiteURL`, `privacyPolicyURL`, `termsOfServiceURL`, `defaultPrompt[]` (at most 3, each at most 128 chars), `brandColor`, `composerIcon`, `logo`, `screenshots[]` (PNG files under `./assets/`).
  - Paths should be relative and start with `./`. `skills`, `hooks` and `mcpServers` add to default discovery; they do not replace it.

  — [openai/plugins plugin-json-spec.md](https://raw.githubusercontent.com/openai/plugins/main/.agents/skills/plugin-creator/references/plugin-json-spec.md)
- **Build-page additions.** `hooks` can be a path, an array of paths, an inline object, or an array of inline objects. `onboardingSkill` is a SKILL.md path. `apps` is "used only for registered MCP server mappings". The build page does not document `commands`, `agents` or `mcpServers` for this manifest; it says MCP servers go in `mcp.json` under `mcpServers`. — [Codex: Build plugins](https://developers.openai.com/codex/plugins/build)
- **New portable root `plugin.json`.** It uses `$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` with `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`. — [Codex: Build plugins](https://developers.openai.com/codex/plugins/build)
- **Plugin components in Codex.** The user docs list skills, MCP servers, browser extensions and hooks. They do not list commands or agents. The IDE extension does not support plugins. Skills become available only in a new session after install. — [Codex: Plugins](https://learn.chatgpt.com/docs/plugins)
- **`codex plugin marketplace add <source>`: still valid.** It accepts a local path, `owner/repo[@ref]`, an HTTPS Git URL or an SSH Git URL, with options `--ref` and `--sparse <PATH>` (repeatable). Sibling commands: `marketplace list`, `marketplace upgrade [name]`, `marketplace remove <name>`. — local `codex plugin marketplace add --help` (0.167.0); [Codex: Build plugins](https://developers.openai.com/codex/plugins/build)
- **`codex plugin add PLUGIN@MARKETPLACE`: still valid.** It also accepts `PLUGIN --marketplace/-m NAME`. Other subcommands: `list` and `remove` (remove uninstalls and clears the cache). The web docs only describe the interactive `/plugins` browser, so this command is visible only in CLI help. — local `codex plugin --help`, `codex plugin add --help` (0.167.0); [Codex: Plugins](https://learn.chatgpt.com/docs/plugins)
- **Install cache.** Plugins install to `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/`. Local plugins get the version `local`. — [Codex: Build plugins](https://developers.openai.com/codex/plugins/build)
- **Env vars: still valid.** Hook commands get `PLUGIN_ROOT` (the installed plugin root) and `PLUGIN_DATA` (a writable data dir). `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` are also set for compatibility. — [Codex: Build plugins](https://developers.openai.com/codex/plugins/build)

### Inferences
- The repo's current `plugins/*/.codex-plugin/plugin.json` files use name, version, description, author, license, keywords, `skills: "./skills/"`, and `interface{displayName, shortDescription, longDescription, developerName, category, capabilities}`. All of these match the spec, so no change is required.
- The `capabilities` value set is not enumerated anywhere. The spec example uses `["Interactive","Write"]` and the repo uses `["Read","Write"]`. Both are probably free-form strings.
- The env vars are documented for hook commands. Skill-invoked scripts run through the model's shell, so they may not get `PLUGIN_ROOT`. Resolve script paths relative to the skill directory instead of relying on the env var.
- The `cursor` plugin's `longDescription` says "existing cursor-agent install". It should say `agent`.

### Gaps
- I could not find an official enumerated list of `capabilities` or `category` values; the submit page `learn.chatgpt.com/docs/plugins/submit` returns 404.
- Neither source documents `commands` or `agents` fields. Third-party blogs contradict each other, so treat both fields as unsupported.
- Whether `PLUGIN_ROOT` is exported to skill-run shell commands, as opposed to hooks, is not documented.

## Codex: skills

### Takeaway
SKILL.md needs `name` and `description`. `agents/openai.yaml` is still the place for UI metadata and invocation policy. The documented user path is now `~/.agents/skills`; `~/.codex/skills` is no longer in the Codex docs.

### Cited Findings
- **Frontmatter.** SKILL.md "must include `name` and `description`". No other frontmatter fields are documented. — [Codex: Build skills](https://learn.chatgpt.com/docs/build-skills)
- **Discovery locations.**
  - Repo: `$CWD/.agents/skills` and `.agents/skills` in each parent directory up to the repo root.
  - User: `$HOME/.agents/skills`.
  - Admin: `/etc/codex/skills`.
  - System: bundled skills such as `skill-creator` and `skill-installer`.
  - `~/.codex/skills` is **not mentioned (changed/removed from docs)**.

  — [Codex: Build skills](https://learn.chatgpt.com/docs/build-skills)
- **`agents/openai.yaml`: still valid.**
  - `interface`: `display_name`, `short_description`, `icon_small`, `icon_large`, `brand_color`, `default_prompt`.
  - `policy.allow_implicit_invocation`: default `true`.
  - `dependencies.tools[]`: each entry has `type`, `value`, `description`, `transport`, `url`, e.g. for an MCP server.

  — [Codex: Build skills](https://learn.chatgpt.com/docs/build-skills)
- **Invocation.** Explicit invocation uses `$skill-name` or `/skills` in the CLI and IDE. Implicit invocation happens when the task matches the `description`. With `allow_implicit_invocation: false`, explicit `$skill` still works. — [Codex: Build skills](https://learn.chatgpt.com/docs/build-skills)
- **Disabling skills.** Add `[[skills.config]]` entries in `~/.codex/config.toml` with `enabled = false`, using exactly one selector per entry: `path` or `name`. The last matching entry wins. `[skills.bundled] enabled = false` goes in a trusted project `.codex/config.toml`. Restart Codex after changing either. — [Codex: Build skills](https://learn.chatgpt.com/docs/build-skills)

### Inferences
- Plugin skills are namespaced by the plugin `name` (per the plugin-json spec), so a skill in the `cursor` plugin presumably appears as `cursor:<skill>`. I have not confirmed this in the CLI.

### Gaps
- I did not verify whether Codex 0.167.0 still silently reads `~/.codex/skills` for back-compat.

## Cursor: plugins (IDE)

### Takeaway
`.cursor-plugin/plugin.json` and `.cursor-plugin/marketplace.json` both match the repo's assumptions, but the manifest has **no `displayName` field**. It does add `logo`, `homepage`, `repository` and `variables`. Local installs go in `~/.cursor/plugins/local/<name>`. Team marketplaces are imported from the dashboard.

### Cited Findings
- **plugin.json fields.**
  - Required: `name` (lowercase kebab-case; alphanumerics, hyphens and periods; must start and end alphanumeric).
  - Optional: `description`, `version` (semver), `license`, `homepage`, `repository`, `author{name, email?}`, `keywords[]`, `logo` (relative path or URL), `variables` (JSON Schema of variable names, set by users in the dashboard; no secrets in the repo).
  - Optional component paths: `skills`, `commands`, `agents`, `rules` (string or array), `hooks` (path or inline object), `mcpServers` (path, inline object or array; overrides default `mcp.json` discovery).
  - **`displayName` is not listed.**

  — [Cursor: Plugins reference](https://cursor.com/docs/reference/plugins)
- **marketplace.json.** It lives at `.cursor-plugin/marketplace.json` in the repo root and must be 10 MB or smaller.
  - Top level: `name` (required, kebab-case), `owner{name, email?}` (required), `metadata{description, version, pluginRoot}` (optional), `plugins[]` (required).
  - Each entry: `name` and `source` (a string path or `{path,...}`). Entries also accept most manifest fields, including `category`, `tags`, component paths, `hooks`, `mcpServers` and `variables`.

  — [Cursor: Plugins reference](https://cursor.com/docs/reference/plugins)
- **Default component dirs.**
  - `rules/*.mdc`.
  - `skills/<name>/SKILL.md`.
  - `commands/`: `.md`, `.mdc`, `.markdown` or `.txt`, with optional frontmatter `name` and `description`.
  - `agents/`: `.md`, `.mdc` or `.markdown`, with frontmatter `name` (kebab-case) and `description`.
  - `mcp.json`.
  - Hooks are a top-level `hooks` object in which each event maps to `[{command, matcher?}]`. Events include `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeSubmitPrompt`, `afterFileEdit`, `stop` and `workspaceOpen`.
  - Agents, commands and hooks are "Cursor Plugins only". Skills, MCP and rules are shared with the open Agent Plugin format.

  — [Cursor: Plugins reference](https://cursor.com/docs/reference/plugins); [Cursor: Plugins](https://cursor.com/docs/plugins)
- **Env and path vars.** Cursor expands `${CURSOR_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` in MCP `command`, `args`, `env` and `cwd`. It does **not** expand the standard's `${PLUGIN_ROOT}` or `${PLUGIN_DATA}`. Env vars for hook scripts are not listed. — [Cursor: Plugins reference](https://cursor.com/docs/reference/plugins)
- **Local install.** Put plugins in `~/.cursor/plugins/local/<plugin-name>`, then restart or run "Developer: Reload Window". A symlink loads only if it resolves to a directory inside that folder. On Enterprise, "Allow Local Plugin Imports" must be enabled; it is off by default. — [Cursor: Plugins](https://cursor.com/docs/plugins)
- **Team marketplace.** Go to Dashboard → Plugins & MCPs → Team Marketplaces → Add Marketplace → Import from Repo. Supported hosts are GitHub, GitLab, Bitbucket and Azure DevOps. Auto Refresh re-indexes at most every 10 minutes. The Teams plan allows 1 team marketplace; Enterprise allows unlimited. — [Cursor: Plugins](https://cursor.com/docs/plugins)
- **History.**
  - Cursor 2.5 introduced Plugins. — [Cursor 2.5 changelog](https://cursor.com/changelog/2-5)
  - Marketplace plugins with user or project scope arrived via `/plugin` in March 2026. — [Cursor changelog 03-11-26](https://cursor.com/changelog/03-11-26)
  - The CLI changelog v2026.07.13 added `agent plugin marketplace add <git-url>` (per search summary). The local CLI confirms `agent plugin marketplace`. — [Cursor CLI changelog](https://cursor.com/docs/cli/changelog); local `agent plugin --help`

### Inferences
- If the repo's Cursor manifests include `displayName`, Cursor most likely ignores it. It is harmless but undocumented; keep it only if a validator does not reject unknown keys.
- Cursor expands `${CLAUDE_PLUGIN_ROOT}`, so the same MCP config can work for both Claude Code and Cursor.

### Gaps
- The docs give no env-var list for hook or command scripts, and I could not confirm whether `CURSOR_PLUGIN_ROOT` is exported to hook processes.
- I did not fetch the `agent plugin marketplace` subcommand flags or the v2026.07.13 changelog entry verbatim.

## Cursor: skills, commands, subagents

### Takeaway
Cursor supports SKILL.md and reads `.agents/skills`, `.codex/skills` and `.claude/skills`, so a single skills tree serves both tools. Slash commands are being migrated into skills with `disable-model-invocation: true`. Subagents are markdown files with frontmatter.

### Cited Findings
- **SKILL.md frontmatter.**
  - `name` (required; lowercase, digits and hyphens; must match the parent folder name).
  - `description` (required).
  - `paths` (globs as a list or comma-separated string; the legacy `globs` is still accepted).
  - `disable-model-invocation` (when true, the skill runs only via `/skill-name`).
  - `icon` and `color` (for the Custom Mode badge).
  - `metadata`.

  — [Cursor: Skills](https://cursor.com/docs/context/skills)
- **Skill locations.**
  - Project: `.agents/skills/` and `.cursor/skills/`.
  - User: `~/.agents/skills/` and `~/.cursor/skills/`.
  - Compatibility: `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/` and `~/.codex/skills/`.
  - Cursor searches these recursively.

  — [Cursor: Skills](https://cursor.com/docs/context/skills)
- **Skill invocation.** Skills run automatically when relevant, manually via `/` in chat, or for a whole session as a Custom Mode (Alt/Option+Enter). Cursor 2.4 added `/migrate-to-skills`, which converts slash commands into skills with `disable-model-invocation: true`. — [Cursor: Skills](https://cursor.com/docs/context/skills)
- **Subagents.**
  - Project files: `.cursor/agents/`, `.claude/agents/`, `.codex/agents/`. User files: `~/.cursor/agents/`, `~/.claude/agents/`, `~/.codex/agents/`.
  - Project subagents override user ones, and `.cursor/` takes precedence within each scope.
  - Frontmatter: `name`, `description`, `model` (`inherit` or a model ID), `readonly` (bool), `is_background` (bool).
  - Invocation: automatic, `/name`, or by mention.

  — [Cursor: Subagents](https://cursor.com/docs/context/subagents)

### Inferences
- Plugin `commands/` still work, but Cursor is steering toward skills. New user-invocable entry points should be skills with `disable-model-invocation: true`.

### Gaps
- None material.

## Cursor Agent CLI (`agent`)

### Takeaway
Every flag the repo uses is still current: `-p/--print`, `--mode plan` (or `--plan`), `--force` (alias `--yolo`), `--trust`, `--model`, `--resume [chatId]`, `--output-format text|json|stream-json`, `--api-key`/`CURSOR_API_KEY`, and `agent login`/`agent status`. New flags include `--continue`, `--mode ask`, `--sandbox`, `--approve-mcps`, `--workspace`, `--plugin-dir`, `-w/--worktree` and `--stream-partial-output`. `CURSOR_BIN` is the repo's own variable, not Cursor's.

### Cited Findings
- **Flags.**
  - `-p/--print`.
  - `--output-format text|json|stream-json`, which requires `--print`.
  - `--stream-partial-output`, which requires `--print` and `stream-json`.
  - `--resume [chatId]`, and `--continue` (an alias for `--resume=-1`).
  - `--model <model>` and `--list-models`.
  - `--mode plan|ask` (default is agent mode), and `--plan` (short for `--mode=plan`).
  - `-f/--force` and `--yolo`.
  - `--trust`: trusts the workspace without prompting, headless only.
  - `--sandbox enabled|disabled`, `--approve-mcps`, `--workspace <path>`, `--plugin-dir <path>` (repeatable).
  - `-w/--worktree [name]`, `--worktree-base`, `--skip-worktree-setup`.
  - `--api-key <key>`.

  — [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters); confirmed in local `agent --help` (2026.10.01)
- **Commands.**
  - Auth and info: `login` (`NO_OPEN_BROWSER` suppresses the browser), `logout`, `status` (alias `whoami`) and `about`, all with `--format text|json`.
  - Sessions: `ls`, `resume`, `create-chat` (returns a chat ID).
  - Other: `models`, `mcp`, `sandbox`, `worker`, `update`, `generate-rule`.
  - `plugin` (marketplace): seen in local help only, not on the parameters page.

  — [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters); local `agent --help`, `agent plugin --help`
- **Env vars.** `CURSOR_API_KEY` sets the API key and `CURSOR_WORKER_LABELS_FILE` points at worker labels. No `CURSOR_BIN` exists. — [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters)
- **Headless behaviour.** Without `--force`, print mode only proposes changes; `--force` applies edits directly. Install with `curl https://cursor.com/install -fsS | bash`. The docs use only `agent`. — [Cursor CLI headless](https://cursor.com/docs/cli/headless)
- **`--output-format json`.** The output is a single object `{type:"result", subtype:"success", is_error:false, duration_ms, duration_api_ms, result, session_id, request_id?}`. On failure the process exits non-zero, writes to stderr, and emits **no JSON**. — [Cursor CLI output format](https://cursor.com/docs/cli/reference/output-format)
- **`stream-json`.** Output is NDJSON. Events:
  - `system`/`init`: `apiKeySource`, `cwd`, `session_id`, `model`, `permissionMode`.
  - `user`.
  - `assistant`: with partial output, only events that have `timestamp_ms` and no `model_call_id` carry new text.
  - `tool_call` `started`/`completed`: carries `call_id` and a `tool_call` keyed `readToolCall`, `writeToolCall` or `function`.
  - Terminal `result`/`success`: may be missing on failure.

  — [Cursor CLI output format](https://cursor.com/docs/cli/reference/output-format)
- **`cursor-agent` name.** On this machine `~/.local/bin/cursor-agent` and `~/.local/bin/agent` both exist; `cursor-agent` symlinks to `~/.local/share/cursor-agent/versions/2026.10.01-e373342/cursor-agent`. I found no doc that states the rename or a deprecation date. — local install; [Cursor CLI headless](https://cursor.com/docs/cli/headless)

### Inferences
- Backend parsing should treat a missing JSON object or a non-zero exit as failure and read stderr. It should not expect `is_error:true` in JSON.
- Passing `--trust` together with `-p` avoids workspace-trust prompts in headless runs.
- Keep `cursor-agent` only as a fallback; `agent` is the documented binary.

### Gaps
- I found no official statement on when `cursor-agent` was renamed or whether it will be removed.
- I did not verify the exact `--mode plan` semantics (read-only?) beyond "plan mode".
