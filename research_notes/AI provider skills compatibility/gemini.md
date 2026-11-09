# Gemini CLI (`gemini`) and Antigravity CLI (`agy`): headless flags, output formats, skills/plugins (as of 2026-11-09)

Versions checked: **agy 1.5.3** (installed locally via mise, `agy --version` → `1.5.3`; `agy --help` and `agy changelog` read directly) and **@google/gemini-cli 0.67.0** (npm `latest`, published 2026-11-04; installed in a scratch dir and `gemini --help` read directly; preview is 0.68.0-preview.0). "Local `--help`" below means output captured from those binaries on 2026-11-09. Companion code referenced: `plugins/gemini/scripts/lib/gemini.mjs` `buildRunArgs` (lines ~472-535).

## 1. Does Antigravity CLI exist as `agy`, where are its docs, and what is its release status?

### Takeaway
Yes. Antigravity CLI ships as the `agy` binary. Its docs live at antigravity.google/docs (getting started at `/docs/getting-started?tab=cli`, CLI reference pages under `/docs/cli/...`). Google announced on 2026-05-19 that it replaces Gemini CLI for individual tiers, and Gemini CLI stopped serving those users on 2026-06-18. Gemini CLI is still released (0.67.0 on 2026-11-04) for Code Assist Standard/Enterprise and paid API-key users. No page labels agy as "GA" or "preview"; the docs cite "CLI v1.2+", and the current build is 1.5.3.

### Cited Findings
- Blog "An important update: Transitioning Gemini CLI to Antigravity CLI", May 19 2026, by Dmitry Lyalin and Taylor Mullen: "On June 18, 2026, Gemini CLI and Gemini Code Assist IDE extensions will stop serving requests" for Google AI Pro/Ultra and free individual tiers. Code Assist Standard/Enterprise and paid Gemini / Gemini Enterprise Agent Platform API keys keep Gemini CLI. Carried over: Agent Skills, Hooks, Subagents, and Extensions, which are now "Antigravity plugins". There is no 1:1 parity at launch. Migration docs are at antigravity.google/docs/gcli-migration. — [Google Developers Blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- geminicli.com docs pages now carry a banner saying Gemini CLI was replaced by Antigravity CLI on June 18th 2026 and "has not been optimized for Gemini 4 Argon". — [geminicli.com headless](https://geminicli.com/docs/cli/headless)
- Binary name `agy`. Install with `curl -fsSL https://antigravity.google/cli/install.sh | bash` (default `~/.local/bin/agy`) or on Windows `irm https://antigravity.google/cli/install.ps1 | iex`. Verify with `agy --version`. Versions cited: App v2.5+, CLI v1.2+, Python SDK `google-antigravity`. No GA/preview label for the CLI. Only some enterprise IDE integrations and auth types are marked Preview. — [Antigravity Getting started (CLI tab)](https://antigravity.google/docs/getting-started?tab=cli)
- `antigravity.google/docs/cli` redirects to `/docs/getting-started?tab=cli`. CLI pages: `/docs/cli/reference/`, `/docs/cli/headless/`, `/docs/cli/conversations/`, `/docs/cli/gcli-migration/`, `/docs/cli/modes/`, `/docs/cli/acp/`, `/docs/cli/commands/resume/`, `/docs/cli/commands/effort/`, and others. Skills are at `/docs/skills/` and plugins at `/docs/plugins/`. — [Antigravity Getting started](https://antigravity.google/docs/getting-started?tab=cli)
- Local `agy changelog` lists releases from 1.4.5 up to 1.5.3. Gemini CLI GitHub repo `google-gemini/gemini-cli`: not archived, Apache-2.0, last push 2026-11-09. Releases: v0.67.0 (Latest, 2026-11-04) and v0.68.0-preview.0 (2026-11-04). npm 0.64.0 → 2026-10-13, 0.65.0 → 10-20, 0.66.0 → 10-27, 0.67.0 → 11-04 (weekly cadence). — [gemini-cli releases](https://github.com/google-gemini/gemini-cli/releases); [npm @google/gemini-cli](https://www.npmjs.com/package/@google/gemini-cli)
- A developer forum thread complained that the official docs did not name the `agy` command. The current getting-started page does name it. — [Google AI Developers Forum](https://discuss.ai.google.dev/t/antigravity-cli-documentation-lacks-invoke-command/146893)

### Inferences
- Keeping agy as the preferred backend is correct. Gemini CLI fallback only works for users on Code Assist Standard/Enterprise or paid API keys. Users on free or AI Pro/Ultra OAuth get errors from `gemini` after 2026-06-18, so setup/auth checks should say so.
- agy ships fast (1.4.5 → 1.5.3 within a few months, per the changelog), and flag behavior has changed between patch versions (see section 2). Record the agy version in setup output.

### Gaps
- No exact release dates per agy version: `agy changelog` prints no dates, and I did not find a dated release feed.
- Whether the Gemini CLI repo will stay open source or maintained long-term: the blog does not say, and third-party coverage disagrees.

## 2. agy flags the companion uses: still valid, changed, or removed

### Takeaway
Every agy flag the companion passes exists in agy 1.5.3. `--effort` gained `xhigh|max`. `--print-timeout` expiry now exits with code 3. `--dangerously-skip-permissions` now blocks commands on the denylist. **Bug:** the companion appends `--include-directories a,b` for both backends, but agy has no such flag. The agy equivalent is the repeatable `--add-dir`. Also, agy reviews (`write=false`) pass no mode, so tools that need approval are soft-denied. agy has `--mode plan` as an explicit read-only mode.

### Cited Findings (all from local `agy --help` for 1.5.3 unless another source is cited)
| Flag (as used by companion) | Status | Notes |
|---|---|---|
| `-p <prompt>` | **Still valid** | `-p` is "Short alias for --print". `--print` runs "a single prompt non-interactively and print the response". `--prompt` is also an alias. The docs say: "Pass a prompt with `-p` (or its aliases `--print` and `--prompt`) to run once and exit". Responses go to stdout, diagnostics to stderr. — [agy headless](https://antigravity.google/docs/cli/headless/) |
| `--output-format=stream-json` | **Still valid** | Choices are `text`, `json`, `stream-json` (default text). |
| `--print-timeout 15m` | **Still valid, behavior changed** | Default is `0s` (no limit). Changelog (1.4.x): runs without `--print-timeout` "wait for background tasks to finish, where they previously stopped them after a hidden 30-minute limit". When the timeout cuts a turn short, the run "exits with code `3`, prints an `AGY_ERROR` line naming the tasks it terminated, and writes a `[agy] print timeout after ...` line to stderr". |
| `--dangerously-skip-permissions` | **Still valid, semantics narrowed** | 1.5.2 changelog: commands on the system command denylist "are blocked instead of approved automatically". Under `-p`, it denies out-of-workspace terminal/file access that a Gemini Enterprise admin requires to be reviewed. 1.5.2 also fixed a ~60 s subagent stall on file permissions under this flag. Explicit deny rules still apply. |
| `--model <id>` | **Still valid** | `agy models` subcommand lists models. |
| `--effort low\|medium\|high` | **Still valid, widened** | Accepts `low\|medium\|high\|xhigh\|max`. The companion's subset still works. |
| `--conversation <id>` | **Still valid** | "Resume a previous conversation by ID". |
| `--continue` / `-c` | **Still valid** | "Continue the most recent conversation". History is scoped to the current working directory. — [agy conversations](https://antigravity.google/docs/cli/conversations/) |
| `--version` | **Still valid** | Prints `1.5.3`. (Via a mise shim, the first run printed mise install progress before the version, so parse the last line.) |
| `--include-directories a,b` (companion sends to both backends) | **Not an agy flag** | agy uses `--add-dir` ("Add a directory to the workspace (repeatable)"). I did not test whether agy rejects or ignores the unknown flag. |

Other agy flags relevant to the companion (local `--help`):
- `--mode accept-edits|auto|plan` sets the agent execution mode.
- `--sandbox` runs "in a sandbox with terminal restrictions enabled".
- `--input-format text|stream-json` reads NDJSON from stdin and requires `--output-format stream-json`.
- `--json-schema` enforces structured output.
- `--disable-slash-commands` disables slash command and skill expansion in print mode.
- `--settings` takes one-session JSON settings.
- `--agent`, `--project`, `--new-project`, `--remote-agent`, `--log-file`.
- Subcommands: `acp`, `agents`, `changelog`, `install`, `mcp`, `models`, `plugin`, `remote-control`, `update`.
- Headless permissions: "Tools needing approval are soft-denied, the run continues, exits `0`, and prints a stderr notice." You can pre-approve with `permissions.allow` rules in `settings.json`. — [agy headless](https://antigravity.google/docs/cli/headless/)
- Exit codes: `0` success; non-zero on failure (the unknown-model example exits `1`); `3` on print timeout (changelog). In stream-input mode, `2` for control messages or CLI-handled slash commands and `1` for invalid JSON, a missing `event` field, or a non-text content block. — [agy headless](https://antigravity.google/docs/cli/headless/)

### agy stream-json / json schema
- `json` prints one envelope at the end with these fields: `conversation_id`, `status` (`SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING`), `response`, `error` (failures only), `duration_seconds`, `num_turns`, `usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`. With `--json-schema` it adds `structured_output` and `json_schema`. — [agy headless](https://antigravity.google/docs/cli/headless/)
- `stream-json` emits NDJSON with the discriminator key **`event`** (not `type`):
  - `{"event":"init","init":{cwd,tools,permission_mode,model?,agent?,json_schema?}}`
  - `{"event":"step_update","step_update":{conversation_id,step_index,state:"ACTIVE"|"DONE",step_type:"user_input"|"agent_response"|"tool"|"checkpoint",tool_name,text_delta,duration_seconds,usage,tool_info{name,parameters,output,error?},subagent_info}}`
  - `{"event":"result","result":{...same as json envelope...}}`
  - Unknown events are skipped with a stderr warning. — [agy headless](https://antigravity.google/docs/cli/headless/)
- `finished_reason` was added to the json/stream-json result in 1.4.x: `print_timeout` (partial response), `interrupted`, or `error`, "omitted when the turn" completes normally. The docs page does not list it yet. — local `agy changelog`
- Observed locally (agy 1.5.3, not signed in), `agy -p ... --output-format=stream-json --print-timeout 90s` printed exactly one line: `{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{...all 0},"finished_reason":"error"}}`. Before that line it printed an OAuth URL to stderr, waited 60 s ("Waiting for authentication (timeout 60s)..."), and **blocked for that minute instead of failing fast**. The exit code was masked by a pipe in my test, so it is not verified. — local run

### Inferences
- The companion parser at `gemini.mjs:713-775` already keys on `event.event`, `step_update.text_delta`, and `result.conversation_id`, which matches the documented schema. Consider surfacing `finished_reason === "print_timeout"` and exit code 3 as "partial/timeout" rather than success.
- Fix `--include-directories` so it only goes to `gemini`. For agy, emit `--add-dir <d>` once per directory.
- For read-only agy reviews, consider `--mode plan`. Without it, write tools are only soft-denied, and the run still exits 0.
- An unauthenticated agy in headless mode hangs about 60 s on the OAuth prompt. Setup's auth check should time-box it or detect the `authentication failed` result.

### Gaps
- I did not verify `--mode plan` behavior in headless mode or whether it combines with `--dangerously-skip-permissions`. `/docs/cli/modes/` was not fetched.
- How agy handles an unknown flag (`--include-directories`) was not tested, because a real run needs auth.
- The `/docs/cli/reference/` page was not fetched. The flag list above comes from the binary's `--help`, which I consider authoritative.

## 3. gemini flags the companion uses: still valid, changed, or removed

### Takeaway
All gemini flags the companion uses are still valid in 0.67.0. `--yolo` and `--approval-mode` both exist: choices are `default|auto_edit|yolo|plan`, and `plan` is read-only. `-r/--resume` accepts `latest`, an index, or a UUID. New flags appeared: `--session-file`, `--session-id`, and `-w/--worktree`. There is still no `--effort`.

### Cited Findings (local `gemini --help`, v0.67.0, unless another source is cited)
| Flag | Status | Notes |
|---|---|---|
| `--skip-trust` | **Still valid** | "Trust the current workspace for this session." |
| `-s/--sandbox` | **Still valid** | boolean |
| `--include-directories a,b` | **Still valid** | "comma-separated or multiple --include-directories" |
| `-o/--output-format text\|json\|stream-json` | **Still valid** | |
| `-p/--prompt` | **Still valid** | "Run in non-interactive (headless) mode with the given prompt. Appended to input on stdin (if any)." Headless also triggers in a non-TTY environment. — [geminicli headless](https://geminicli.com/docs/cli/headless) |
| `-y/--yolo` | **Still valid** | |
| `--approval-mode default\|auto_edit\|yolo\|plan` | **Still valid** | `plan` = "read-only mode" |
| `-r/--resume` | **Still valid** | "Use "latest" for most recent or index number". The docs also accept a full session UUID, e.g. `gemini --resume a1b2c3d4-...`. — [geminicli session management](https://geminicli.com/docs/cli/session-management) |
| `-m/--model` | **Still valid** | `gemini models` subcommand and `--list-models` also exist. |
| `-v/--version` | **Still valid** | prints `0.67.0` |
| `--effort` | **Does not exist** | Absent from `--help`. The companion is right to drop it. |

Other: `--policy`/`--admin-policy` (Policy Engine). `--allowed-tools` is marked "[DEPRECATED: Use Policy Engine instead]". Also `--acp` (`--experimental-acp` is deprecated), `-e/--extensions`, `--list-sessions`, `--delete-session`, `--session-file`, `--session-id`, `-w/--worktree`, `--raw-output`. Subcommands: `mcp`, `extensions`, `skills`, `hooks`, `gemma`, `models`.

### gemini JSON / stream-json schema
- `json` returns a single object: `response` (string), `stats` (token usage and API latency metrics), and optional `error`. — [geminicli headless](https://geminicli.com/docs/cli/headless). The 0.67.0 bundle's JSON formatter also sets `session_id` from `config.getSessionId()`. I read this in the bundled source, and the docs do not list it, so treat it as likely but undocumented.
- `stream-json` emits JSONL with the discriminator **`type`**. Types are `init`, `message`, `tool_use`, `tool_result`, `error`, and `result`. — [geminicli headless](https://geminicli.com/docs/cli/headless). Field names from the 0.67.0 bundled source:
  - `init{timestamp,session_id,model}`
  - `message{timestamp,role,content}` (assistant chunks may carry `delta`; not verified)
  - `tool_use{timestamp,tool_name,tool_id,parameters}`
  - `tool_result{timestamp,tool_id,status:"success"|"error",output,error?{type,message}}`
  - `result{timestamp,status,error?{type,message},stats}`
- Exit codes: `0` success, `1` general/API error, `42` input error, `53` turn limit exceeded. — [geminicli headless](https://geminicli.com/docs/cli/headless)

### Inferences
- The gemini argv in `buildRunArgs` needs no flag changes. The `--approval-mode=plan` choice for reviews still maps to read-only.

### Gaps
- The exact `message` delta field name and the `stats` sub-structure were not confirmed from the docs.

## 4. Skills, extensions/plugins, custom commands, and installing a plugin repo into the host

### Takeaway
Both CLIs support Agent Skills (`SKILL.md` with `name`/`description` frontmatter):
- **Gemini CLI** discovers skills in `.gemini/skills/` and the `.agents/skills/` alias (workspace), `~/.gemini/skills/` and `~/.agents/skills/` (user), and in extensions. It installs extensions from a git URL or local path that contains a `gemini-extension.json`.
- **agy** uses `.agents/skills/` (workspace) and `~/.gemini/config/skills/` (global). It installs plugins (`plugin.json` or `.antigravity-plugin/plugin.json`) from the marketplace, a GitHub URL, or a local path, and it has `agy plugin import claude|gemini`. That import is the most direct way to bring a Claude Code plugin repo into agy as a host.

### Cited Findings
**Gemini CLI skills**
- Precedence from low to high: built-in skills, extension skills, user (`~/.gemini/skills/` or `~/.agents/skills/` alias), workspace (`.gemini/skills/` or `.agents/skills/` alias). "Within the user or workspace tier, the `.agents/skills/` alias takes precedence over `.gemini/skills/`." Names and descriptions are injected at session start. The model calls the `activate_skill` tool, and the user gets a consent prompt. After that, the SKILL.md body is added and the skill directory is allowed. `/skills enable|disable <name>` defaults to user scope (`--scope workspace` also works). Page last updated Apr 30 2026. — [geminicli skills](https://geminicli.com/docs/cli/skills)
- CLI: `gemini skills list [--all] | enable | disable [--scope] | install <git-url|path> [--scope] [--path] | link <path> | uninstall`. — local `gemini skills --help` (0.67.0)

**Gemini CLI extensions**
- Install with `gemini extensions install <github-url|local-path>`. Options: `--ref`, `--auto-update`, `--pre-release`, `--consent`, `--skip-settings`. Other subcommands: `link`, `new`, `validate`, `update`, `enable/disable --scope`, `config`. — [geminicli extensions reference](https://geminicli.com/docs/extensions/reference); local `gemini extensions --help`
- `gemini-extension.json` fields:
  - `name`: lowercase and dashes, and it should match the directory name.
  - `version`, `description`.
  - `migratedTo`: a new repo URL used for updates.
  - `mcpServers`: separate `command`/`args`. `${extensionPath}` is recommended, and `trust` is unsupported.
  - `contextFileName`: defaults to `GEMINI.md`.
  - `excludeTools`, e.g. `run_shell_command(rm -rf)`.
  - `plan.directory`.
  - `settings[]` with `{name,description,envVar,sensitive}`.
  - `themes`.
  - Layout: `commands/*.toml` (where `commands/gcs/sync.toml` becomes `/gcs:sync`), `skills/<name>/SKILL.md`, `hooks/hooks.json` (not in the manifest), `agents/*.md` (sub-agents, preview), and `policies/*.toml`. Extension `allow` decisions and `yolo` in policies are ignored.
  - Variables: `${extensionPath}`, `${workspacePath}`, `${/}`. — [geminicli extensions reference](https://geminicli.com/docs/extensions/reference)

**Gemini CLI custom commands (.toml)**
- Commands live in `~/.gemini/commands/` (global) and `<project>/.gemini/commands/` (project, which wins on collision). The name comes from the path, so `git/commit.toml` becomes `/git:commit`.
- Keys: `prompt` (required) and `description` (optional).
- `{{args}}` is inserted raw, or shell-escaped inside `!{...}`. If the prompt has no `{{args}}`, the typed command is appended after two newlines.
- `!{...}` runs a shell command after confirmation. `@{...}` injects a file or directory, runs first, and supports multimodal files. — [geminicli custom commands](https://geminicli.com/docs/cli/custom-commands)

**agy skills/plugins**
- Skills live in workspace `<root>/.agents/skills/<skill>/` and global `~/.gemini/config/skills/<skill>/`. Plugin skills live in `~/.gemini/config/plugins/<plugin>/skills/`. "Antigravity defaults to `.agents/skills`, but still maintains backward compatibility for `.agent/skills`." — [agy skills](https://antigravity.google/docs/skills/)
- Frontmatter: `name` is optional (lowercase-hyphen, defaults to the folder name) and `description` is required. No other fields are listed. Skills use progressive disclosure, and in the CLI each skill becomes a slash command. — [agy skills](https://antigravity.google/docs/skills/)
- The migration guide lists the global skills location as `~/.gemini/skills/` or `~/.gemini/antigravity-cli/skills/`, which differs from the skills page's `~/.gemini/config/skills/`. Workspace `.gemini/skills/` is not picked up: "you must manually rename or relocate the folder to `.agents/skills/`". — [agy gcli-migration](https://antigravity.google/docs/cli/gcli-migration). **Conflict:** the two official pages give different global paths. Treat `~/.gemini/config/skills/` (skills page) as current, but verify on a real install.
- Plugin manifest: `plugin.json` or `.antigravity-plugin/plugin.json`, with example fields `$schema`, `name`, `displayName`, `version`, `description`, `logo`, `suggestedPrompts`. Components: skills, MCP servers (namespaced `<plugin>_<server>`), custom agents/subagents, rules, and hooks (`PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`). Commands are not listed as a component. — [agy plugins](https://antigravity.google/docs/plugins/)
- Install with `agy plugin install <name>@antigravity-plugins-official` (only this marketplace is supported), `agy plugin install https://github.com/<owner>/<repo>`, or `agy plugin install </local/path>`. Manual placement goes in `.agents/plugins/` (workspace) or `~/.gemini/config/plugins/` (global). `agy plugin import gemini` reads `~/.gemini/extensions/`, and `agy plugin import claude` reads `~/.claude/plugins/`; both also accept a specific directory. `agy plugin validate [--strict]` checks plugins. — [agy plugins](https://antigravity.google/docs/plugins/); local `agy plugin --help` (`list [--json]`, `import [source]`, `install <target>` "supports plugin[@marketplace]", `uninstall`, `enable`, `disable`, `validate`, `link <mp> <target>`)
- Changelog details:
  - `agy plugin import claude` now reads Claude Code's installed-plugins list, skips disabled and project-only plugins, and keeps remote MCP servers.
  - Plugin hook commands get `PLUGIN_ROOT` and `PLUGIN_DATA` env vars (1.5.3).
  - `plugin.json` accepts `category`, and `extensions["com.google.antigravity"]` holds agy-specific settings.
  - Workspace `.agents/plugins.json` and `.agents/skills.json` entries load only from inside the workspace (1.5.2).
  - `validate` warns about `skills` entries without a `SKILL.md`. — local `agy changelog`

### Inferences
- To make this repo installable into agy as a host, the lowest-effort paths are `agy plugin install https://github.com/mubeda/agent-bridges` (if a root or per-plugin `plugin.json` is acceptable) or `agy plugin import claude <path>` pointing at a Claude Code plugin dir. Run `agy plugin validate` on a plugin dir to see what agy accepts. Whether it reads `.claude-plugin/plugin.json` directly is undocumented.
- For Gemini CLI as host: add a `gemini-extension.json` per plugin. Skills under `skills/<name>/SKILL.md` and commands as `commands/*.toml` then install with `gemini extensions install <repo-url|path>`. Gemini commands are TOML, not Claude's Markdown commands, so a conversion step is required.
- A workspace skill placed in `.agents/skills/` is discovered by both CLIs (Gemini through its alias, agy natively). That makes it the most portable skill location.

### Gaps
- The full `plugin.json` schema (the "Build plugins" page) was not fetched, so the exact component directory names for agy plugins are unconfirmed.
- Whether agy plugins support slash commands (Markdown or TOML) is unclear. The plugins page omits commands, but the changelog mentions `agy plugin install` listing "command" components.
- Whether `agy plugin install <github-url>` handles a multi-plugin repo with a marketplace manifest was not verified.

## 5. Session import, resume, and transfer into Gemini/agy

### Takeaway
Gemini CLI can load a session from a JSON file (`--session-file`) and set a session UUID (`--session-id`), in addition to `--resume`. That is the closest thing to "import a conversation". agy only resumes its own conversations (`--conversation <id>`, `-c`, `/resume`) and documents no import or export. For agy, transfer has to be done by sending prior context in the prompt, or by stream-json stdin input inside one process.

### Cited Findings
- Gemini sessions are stored in `~/.gemini/tmp/<project_hash>/chats/` and are project-specific. `--resume` takes latest, an index, or a UUID. Other options: `--list-sessions`, `--delete-session`, the `/resume` session browser, and named checkpoints via `/chat` or `/resume` save/list/resume. — [geminicli session management](https://geminicli.com/docs/cli/session-management)
- `--session-file`: "Load a session from a JSON file". `--session-id`: "Start a new session with a manually provided UUID." Neither appears on the session-management doc page. — local `gemini --help` (0.67.0)
- agy history is scoped to the working directory. Resume options are `-c/--continue`, the `/resume` picker, and `/fork`, which allocates a new session ID. The page documents no import or export. — [agy conversations](https://antigravity.google/docs/cli/conversations/). `--conversation` "Resume a previous conversation by ID". — local `agy --help`
- Headless agy is stateless by default. Each `-p` call is a new process. `--input-format stream-json` keeps one process and one conversation across stdin turns. — [agy headless](https://antigravity.google/docs/cli/headless/)
- The migration guide does not describe migrating Gemini CLI session history into agy. — [agy gcli-migration](https://antigravity.google/docs/cli/gcli-migration)

### Inferences
- A "transfer" into the gemini backend could write a Gemini-format session JSON and pass `--session-file`. The file format is undocumented, so it would have to be reverse-engineered from `~/.gemini/tmp/.../chats/*.json`, and it is brittle.
- For agy, the practical transfer is a summary or transcript packed into the first `-p` prompt. Later turns continue with `--conversation <conversation_id from result>`.

### Gaps
- The JSON schema for `--session-file` is undocumented, and I did not inspect a real chat file.
- Where agy stores conversations on disk, and their format, is not documented.
- The `/docs/cli/commands/resume/` page was not fetched.
