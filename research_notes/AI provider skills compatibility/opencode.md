# OpenCode (anomalyco/opencode, opencode.ai): state as of 2026-11-09, with a focus on 2.0

Method: I read the official V2 docs (opencode.ai/docs, which now describe V2) and the GitHub releases. I also inspected a **locally installed OpenCode v2.2.6** (`@opencode/cli@2.2.6`, installed via mise) and ran `--help` against it. The `run --format json` emitter was read out of the compiled binary's embedded JS (`strings`). Findings marked "local" come from that install and have no web URL. They can be reproduced with the commands shown.

## 1. Release date, versioning, and changelog highlights for 2.0

### Takeaway
OpenCode 2.0.0 was tagged on 11 Sep 2026, and the current V2 release is v2.2.6 (6 Nov 2026). V1 is still maintained in parallel: v1.19.5 (28 Oct 2026) is the release GitHub marks "Latest". The official migration guide lists three intentional breaks (plugins, server API/SDK, TUI config). In practice the CLI surface also changed in ways that break agent-bridges: `--dir`, `--variant`, top-level `export`/`import`.

### Cited Findings
- The repo is `anomalyco/opencode`. v2.0.0 was tagged "11 Sep" by thdxr (commit 63f7cee). Its release body is a single line: "fix(release): use V2 Docker artifact paths (#48571)". — [GitHub v2.0.0](https://github.com/anomalyco/opencode/releases/tag/v2.0.0)
- The releases page shows v2.2.6 (Nov 6), v2.2.5/v2.2.4/v2.2.3 (Oct 30), v2.2.2/v2.2.1 (Oct 29), and **v1.19.5 (Oct 28, marked Latest)**, so the V1 and V2 lines ship side by side. — [GitHub releases](https://github.com/anomalyco/opencode/releases)
- v2.2.6: adds `opencode run -w/--worktree[=name]` and `opencode run --archived`. `run` now waits for background jobs it started and emits a `background_wait` event under `--format json`, with no time limit ("CI needs a timeout"). SIGTERM cancels the session and exits with code 143. `--worktree` can't be combined with `--continue`/`--session`. — [GitHub releases](https://github.com/anomalyco/opencode/releases)
- v2.2.3 **Breaking**: TUI plugins need OpenTUI ≥0.8. Managed policy `integration.use` now covers only integrations; new `mcp.use`, `skill.use`, `plugin.use` actions were added, and old prefixed rules are auto-converted. The release also adds a "Claude Agent" provider (`OPENCODE_CLAUDE_PATH`). — [GitHub releases](https://github.com/anomalyco/opencode/releases)
- v2.2.1 **Breaking** (`@opencode/ai` SDK): several providers removed and entry points renamed. The release also adds `/goal`, `/schedule`, `/reload`. — [GitHub releases](https://github.com/anomalyco/opencode/releases)
- 2.1.0 reportedly changed the public SDK and the HTTP message/event and plugin contracts again. This comes from secondary sources only and I did not verify it against the official changelog. — [qcode.cc (de)](https://qcode.cc/de/opencode-2-1-breaking-changes)
- The official migration guide's breaking changes: (1) a new plugin API, and "V1 plugin implementations don't run in V2"; (2) new server API/client contracts (`@opencode/client`); (3) TUI config moves from layered `tui.json(c)` to a single global `~/.config/opencode/cli.json` (global settings are auto-migrated; project-local `tui.json` is not). Other supported V1 functionality is meant to keep working, and the guide treats breakage there as a compatibility bug. — [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)
- Install: the migration guide says V1 and V2 both use the `opencode` command and are **not** installed side by side by default, and the V2 curl installer replaces the V1 binary. — [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)
- Local: the V2 npm package is **`@opencode/cli`** (V1 was `opencode-ai`). Its `package.json` declares two bins, `opencode` and `opencode2`, both pointing at the same binary. `opencode --version` prints `opencode v2.2.6`.
- Config/permission renames in V2 (normalized in memory, files are not rewritten): `permission` becomes an ordered `permissions` array of rules (`action`, `resource`, `effect`). Actions are renamed `bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`. `external_directory` is now allowed by default. `agent`/`mode`→`agents`, `prompt`→`system`, `disable`→`disabled`, and `variant` is joined into the model ref after `#`. Other renames: `provider`→`providers`, `snapshot`→`snapshots`, `attachment`→`media`. MCP moves under `mcp.servers` with `enabled`→`disabled`. `lsp` is kept but does nothing. `logLevel` is ignored; use `OPENCODE_LOG_LEVEL`. **V2 does not read `CLAUDE.md`**; use `AGENTS.md`. — [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)

### Inferences
- "2.0" lives in three places: the `@opencode/cli` package, the `v2.x` tags, and the docs at opencode.ai/docs. Some users will still be on V1 1.19.x. agent-bridges should detect the major version from `opencode --version` (`opencode v2.x.y` versus V1 output) and branch its CLI argv on it.

### Gaps
- I found no official, consolidated 2.0.0 changelog. The tag body has only one line, and the highlights are spread across the migration guide and later releases.
- Third-party sources disagree on dates: one claims 12 Oct, another a 22 Sep beta. I used the GitHub tag date, 11 Sep.
- I did not verify the exact V1 `opencode --version` output format.

## 2. Install locations: `command/` vs `commands/`, `agent/` vs `agents/`, skills, plugins

### Takeaway
Root paths are **still valid**: `~/.config/opencode/` and `<project>/.opencode/`. The subdir names have **changed** to plural: `commands/` and `agents/` are canonical, and the singular forms are still discovered as legacy. `skills/` is still valid, and V2 also reads `.claude/skills` and `.agents/skills`. Copying a tree to `plugins/<name>/` is still a valid location, but a V1-style plugin won't execute.

### Cited Findings
- V2 reads the same config locations as V1: global `~/.config/opencode/`, plus project `opencode.json(c)` and `.opencode/`. — [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)
- Agents: prefer `.opencode/agents/<name>.md`. V1 `agent/`, `agents/`, `mode/`, `modes/` are still discovered, and files in `mode/` or `modes/` need `mode: primary`. — [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)
- Agents doc: global `~/.config/opencode/agents/<name>.md`, project `.opencode/agents/<name>.md` (searched from the cwd up to the project root). Nested paths become the ID (`agents/team/reviewer.md` → `team/reviewer`). — [Agents](https://opencode.ai/docs/agents/)
- Commands: global `~/.config/opencode/commands/`, project `.opencode/commands/`. The legacy singular `command/` is also discovered, but the docs say to "use `commands/` for new files". Only `.md` files are read. The filename sets the name (`review.md` → `/review`, `commands/team/review.md` → `/team/review`). — [Commands](https://opencode.ai/docs/commands/)
- Skills: global `~/.config/opencode/skills`, plus compatibility paths `~/.claude/skills` and `~/.agents/skills`. Project `.opencode/skills`, `.claude/skills` and `.agents/skills` are searched from the cwd up to the project root. The `skills` array in `opencode.json(c)` can add directories or HTTP catalogs. — [Skills](https://opencode.ai/docs/skills/)
- Migration guide: skills go in `.opencode/skills/<skill-id>/SKILL.md` (move the whole directory). Both `skill/` and `skills/` are discovered. — [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)
- Plugins: direct `.ts`/`.js` files and immediate package directories are auto-loaded from every discovered `.opencode/plugins/` and from `~/.config/opencode/plugins/`. A `plugins/` directory beside a project-root config is "not discovered automatically". — [Plugins](https://opencode.ai/docs/plugins/)
- Local: `opencode debug paths` shows config `~/.config/opencode`, data `~/.local/share/opencode`, and db `~/.local/share/opencode/opencode.db` (sessions live in SQLite).

### Inferences
- Repo status: `command/` is **changed** (works as legacy; write `commands/`). `agent/` is **changed** (works as legacy; write `agents/`). `skills/` is **still valid**. `plugins/<name>/` is **still valid as a location**, but OpenCode will try to load that directory as a V2 plugin. If the copied tree isn't a V2 plugin (no `index`/`server` entry exporting `Plugin.define`), it will either fail to load or be ignored. Copying a non-plugin tree there is risky, so consider a different storage dir.
- Because V2 reads `~/.claude/skills` and `.claude/skills` natively, skills that agent-bridges already installs for Claude Code are visible to OpenCode without a copy. Installing a second copy into `.opencode/skills` would put the same skill ID in two places. I did not find docs on the precedence rule for duplicate IDs.

### Gaps
- Precedence or dedup between the `.opencode/skills`, `.claude/skills` and `.agents/skills` copies of the same skill ID is not documented.
- Whether V2 reads `.claude/commands` or `.claude/agents` is not documented. I found no statement either way, so assume no.

## 3. SKILL.md frontmatter

### Takeaway
Honored fields: `description` (required to be advertised), `name` (display label only, since the ID comes from the directory), `disable-model-invocation`, and `metadata` (for example `opencode/autoinvoke`). `license` and `compatibility` are accepted but not interpreted. `allowed-tools` and `user-invocable` are not documented. Skill access is controlled through `permissions` rules with action `skill`.

### Cited Findings
- `name` is a display label; "the skill ID comes from the file path". `description` is the summary shown to the model, and skills without one are not advertised. `metadata` holds namespaced keys such as `opencode/autoinvoke`. `disable-model-invocation: true` hides the skill from the model's list, and `opencode/autoinvoke` wins if both are set. `license` and `compatibility` are "accepted for portability in V2, but not interpreted". — [Skills](https://opencode.ai/docs/skills/)
- Recommended ID: lowercase kebab-case, 1–64 characters, matching `^[a-z0-9]+(-[a-z0-9]+)*$` and the directory name. "V2 currently does not enforce this pattern", nor the name/dir match or a description length limit. — [Skills](https://opencode.ai/docs/skills/)
- Permissions: action `skill`, resource = skill ID, wildcards allowed. Effects: `allow` (advertise and load), `ask`, `deny` (hide and reject). The last matching rule wins. Per-agent rules go under `agents.<id>.permissions`. — [Skills](https://opencode.ai/docs/skills/)
- Managed policy `skill.use` action (v2.2.3). — [GitHub releases](https://github.com/anomalyco/opencode/releases)

### Inferences
- `allowed-tools` and `user-invocable` are probably ignored silently. The docs don't mention them, and the loader tolerates extra portability fields. Keeping them is harmless.

### Gaps
- No doc confirms whether unknown SKILL.md fields produce warnings.

## 4. Command markdown frontmatter

### Takeaway
OpenCode honors `description`, `agent`, `model` (`provider/model[#variant]`) and `subagent` (`subtask` is a deprecated alias). The body is the template, with `$ARGUMENTS`, `$1..$n`, and `` !`shell` `` placeholders. The repo's `name`, `argument-hint`, `disable-model-invocation` and `allowed-tools` are **not honored**. The name comes from the filename.

### Cited Findings
- Fields: `description`, `agent`, `model` (`provider/model` or `provider/model#variant`), `subagent` (`true` runs in a background child session, `false` forces the current session), and `subtask` (a deprecated alias; `subagent` wins if both are set). `template` is JSON-only, since in Markdown the trimmed body is the template. — [Commands](https://opencode.ai/docs/commands/)
- Placeholders: `$ARGUMENTS` (the full string), `$1`, `$2`, … (quotes group words, and the highest-numbered placeholder takes the rest). `` !`shell` `` runs in the project dir and inlines its output. `@path` is not expanded in stored templates. With no placeholder, the arguments are appended after a blank line. — [Commands](https://opencode.ai/docs/commands/)
- Model precedence: command `model` > the command agent's model > the session model. If `subagent` is omitted, the command runs in a child session only when the agent has `mode: subagent`. — [Commands](https://opencode.ai/docs/commands/)
- Migration: commands use `commands` and `subagent`, and `variant` is joined into `model`. — [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)

### Inferences
- Repo field status: `description` is **still valid**. `name` is **not used** (the filename decides the name). `argument-hint`, `disable-model-invocation` and `allowed-tools` are **not honored** (undocumented). If the repo writes `subtask:`, it should switch to `subagent:`. If it writes a separate `variant:` field, it should move that into `model: provider/model#variant`.

### Gaps
- Whether unknown command frontmatter keys cause warnings or errors is not documented.

## 5. Agent markdown frontmatter

### Takeaway
V2 agent frontmatter fields: `description`, `mode` (`primary` default / `subagent` / `all`), `model`, `permissions` (an ordered rule list), `steps`, `hidden`, `color`, `disabled`, `request`. The body is the system prompt. V1 `tools`, `permission` (singular map), `temperature`, `top_p`, `prompt`, `disable`, `maxSteps` are **legacy/deprecated** (read via V1 normalization, not for new files).

### Cited Findings
- Frontmatter takes the same fields as an `agents` config entry, and the Markdown body becomes the system prompt. Documented fields: `description`, `mode`, `model`, `permissions`, `steps`, `hidden`, `color`, `disabled`, `request`. — [Agents](https://opencode.ai/docs/agents/)
- `temperature`, `top_p`, `prompt`, `permission`, `tools`, `disable`, `maxSteps` are listed as legacy fields not to use in new V2 agent config. Request-level `temperature` "is not sent by the V2 runner yet". Set it on the provider, model, or variant instead. — [Agents](https://opencode.ai/docs/agents/)
- Permissions are an ordered list of `{action, resource, effect}` with `allow|ask|deny` and wildcards. The last match wins. Global rules apply first and agent rules refine them. Subagent launches are controlled by `subagent` action rules on the parent. — [Agents](https://opencode.ai/docs/agents/)
- Built-ins: `build` and `plan` (primary), `general` and `explore` (subagent), and hidden `compaction`/`title`/`summary`. There is no `scout`. A built-in can be overridden by reusing its ID, or removed with `disabled: true`. — [Agents](https://opencode.ai/docs/agents/)
- Migration action renames: `bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`. — [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)

### Inferences
- Repo status: `mode: subagent|primary` is **still valid**. `model` is **still valid** (put the variant in `#variant`). `tools:` is **deprecated**; it still works via normalization, but should become `permissions` rules. `permission:` (a V1 map) has **changed** to `permissions:` (an ordered array, renamed actions). For example, Claude-style `allowed-tools: Bash` maps to the action `shell`.

### Gaps
- The exact V2 YAML for a `permissions` list in frontmatter (for example `- action: shell\n  resource: "git *"\n  effect: allow`) is inferred from the config schema description. I did not see a verbatim frontmatter example.

## 6. CLI invocation (the backend driver)

### Takeaway
In V2, `opencode run --format json`, `--continue/-c`, `--session/-s`, `--model/-m`, `--auto`, `--agent`, `--file`, `--title` and `--fork` **still exist**. **`--dir` is removed**: it's a hard error, and run uses `$PWD`/cwd, so set the subprocess cwd. **`--variant` is removed**: it's a hard error; use `--model provider/model#variant`. **Top-level `opencode export` / `opencode import` are removed**: use `opencode session export|import`. `--version` still works and prints `opencode v2.2.6`.

### Cited Findings
- Local, `opencode run --help` (v2.2.6) flags: `--continue,-c`; `--session,-s <id>` ("continue, or create if it does not exist"); `--fork` (requires `--continue` or `--session`); `--worktree,-w [=name]`; `--model,-m` "in the format provider/model#variant"; `--agent`; `--format <default|json>`; `--file,-f`; `--title`; `--archived`; `--thinking`; `--auto` ("Auto-approve permissions that are not explicitly denied"). Global flags: `--standalone` (private server instead of the background service), `--server <url>`, `--log-level`, `--print-logs`, `--version,-v`.
- Local: `opencode run --dir /tmp` → `ERROR Unrecognized flag: --dir in command opencode run`. `opencode run --variant high` → `ERROR Unrecognized flag: --variant in command opencode run`. Both print the help text and exit.
- Local: `opencode export` is treated as the positional `[<directory>]` arg → `Error: ENOENT ... chdir '/tmp' -> 'export'`. The `session` subcommands are `list` (`--format table|json`, `-n`), `delete`, `export [<session>] [--sanitize]` ("Export session data as JSON"), and `import <file|URL> [--directory <dir>]`.
- Local (from the binary source): run takes its directory from `process.env.PWD ?? process.cwd()`. If stdin is not a TTY, it is read and combined with the message. Without `--auto`, permission requests are **auto-rejected**, with a stderr note: "permission requested: … auto-rejecting". Questions/forms are cancelled with the instruction "make reasonable assumptions". `--worktree` with `--continue`/`--session` is an error.
- V2 runs against a shared **background service** by default. `opencode service start|...` manages it, and `--standalone` runs a private server. — [CLI](https://opencode.ai/docs/cli/); also local `opencode --help`.
- Variants: the syntax is `provider/model#variant`. Example: `opencode run --model openai/gpt-6.1-sol#high "…"`. "Names such as `low`, `high`, and `max` are not available for every model". Variants come from catalog metadata (`capabilities.reasoning.effort`), `toggle` adds a `none` variant, and custom variants go in a model's `variants` array (`id`, `settings`, `headers`, `body`). The root default `model` keeps no variant. — [Models](https://opencode.ai/docs/models/)
- Local: `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, `"none"` all appear as string literals in the binary. Effort names are provider- or model-specific and not a fixed enum.
- Local, from the binary: in run, a variant without a model errors with "Cannot select a variant before selecting a model".

### Inferences
- The required argv change for agent-bridges on V2 is `cwd=<dir>` (drop `--dir`) plus `opencode run --format json [--auto] [--continue | --session <id>] --model <provider/model>[#<effort>] -- <prompt>`. You can't pass an effort without a model, so the bridge must know or resolve the model first, for example via `opencode models`. Pass `--archived` for scripted runs so they stay out of the user's session list. Wrap the call in a timeout, since run now waits for background jobs indefinitely.
- Mapping effort `minimal/low/medium/high/max` to `#variant` only works if that model's catalog defines the variant. The bridge should validate or fall back. `xhigh` and `none` also exist.

### Gaps
- I didn't check whether `opencode run` exits non-zero for an unknown `#variant`.
- V2 has no `--dir`-equivalent flag for `run`. The top-level `opencode [<directory>]` positional applies to the TUI, not to `run`.

## 7. `run --format json` event stream format

### Takeaway
The output is JSONL on stdout, with one object per line: `{type, timestamp, sessionID, ...}`. Types: `step_start`, `text`, `reasoning` (only with `--thinking`), `tool_use`, `step_finish`, `error`, `retry`, `background_wait`. This is broadly the same shape as V1 (`step_start`/`text`/`tool_use`/`step_finish`/`error` with a `part` payload), plus the new types `reasoning`, `retry`, `background_wait`.

### Cited Findings (local, read from the v2.2.6 binary's run emitter)
- Envelope: `JSON.stringify({type, timestamp, sessionID, ...payload}) + EOL`, written only when `--format json`.
- `text` / `reasoning`: `{part:{id, sessionID, messageID, type:"text"|"reasoning", text, time:{start,end}, metadata?}}`. The `text` field holds the **new delta** relative to what was already emitted for that part, and an event is emitted at the text-ended boundary (not per token). `reasoning` is emitted only with `--thinking`.
- `tool_use`: `{part:{partID, sessionID, messageID, type:"tool", id, tool, state:{status:"completed", input, output, title, metadata, time} | {status:"error", input, error, metadata, time}}}`.
- `step_start`: `{part:{id, sessionID, messageID, type:"step-start", snapshot}}`. `step_finish`: `{part:{…, type:"step-finish", reason, snapshot, cost, tokens}}`.
- `error`: `{error:{type, message}}`. On failure the process sets `exitCode = 1`. `retry`: `{messageID, attempt, nextRetryAt, error}`. `background_wait`: `{jobs:[{id, kind, title}]}`. Part IDs have the form `prt_…`.
- `background_wait` and the SIGTERM → exit 143 behavior are documented in v2.2.6. — [GitHub releases](https://github.com/anomalyco/opencode/releases)

### Inferences
- An existing V1 JSON parser that keys on `type` ∈ {`text`, `tool_use`, `step_finish`, `error`} and reads `part.text` / `sessionID` should mostly keep working. It needs to ignore the new types. Capture `sessionID` from any line to use with `--session` later.

### Gaps
- The docs have no official schema page for run JSON output; this section is derived from the minified source. The fields could change in a minor release. 2.1 reportedly changed the "HTTP message/event" contracts, but I did not verify that against the official changelog.

## 8. Plugin system and packaging

### Takeaway
V2 has a **new, incompatible plugin API**: `@opencode/plugin` with `Plugin.define({id, setup(ctx)})`, shipped as an npm package with an `exports` map (`.`/`./server`, `./tui`, `./gui-experimental`, `./rpc`). The config key is **`plugins`** (plural); V1 used `plugin`. Entries can be npm names, git specifiers, local dirs, or `file://`. `opencode plugin add|list|check|update|remove` manages them. There is **no manifest file** (no plugin.json), **no marketplace**, and **no Claude-style plugin compatibility** documented. Server plugins can add tools, hooks, integrations, commands and agents. Skills are not listed.

### Cited Findings
- Import from `@opencode/plugin` (subpaths `@opencode/plugin/tui`, `@opencode/plugin/gui`). The server entry is `export default Plugin.define({ id, async setup(ctx) { … } })`. `package.json` needs `name`, `version`, `"type":"module"`, `exports`, `files`, and dependency `@opencode/plugin`. Export keys: `"."`/`"./server"`, `"./tui"`, `"./gui-experimental"`, `"./rpc"`. Without an exports map, local dirs use root files `server`|`index`, `tui`, `rpc` (`.ts/.tsx/.js`) and `gui-experimental.cjs`. A TUI-only package goes in `cli.json`. Server plugins add "tools, hooks, integrations, commands, and agents". Publish with `npm publish`. — [Build a plugin](https://opencode.ai/docs/build/plugins/)
- The config uses the `plugins` key in `opencode.json(c)`. Entry forms: npm name[@version], scoped package, relative or absolute dir, `file://`, or `{package, options}`. Git forms: `github:`, HTTPS, `git+ssh://`, with branch/tag/commit and the `::path:` subdir selector. Local paths must be directories. Arrays merge across configs. Unpinned plugins are checked for updates at startup. — [Plugins](https://opencode.ai/docs/plugins/)
- "V1 plugin implementations don't run in V2", so plugins must be ported. Local plugin paths must be directories (for example `./plugin/local/index.ts`). — [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)
- Local: `opencode plugin add <package>` ("npm registry or Git package specifier") installs a plugin and adds it to the **global** config. The other subcommands are `list`, `check`, `update`, `remove`.
- The plugin API has continued to change since 2.0: `ctx.experimental.artifact.transform(...)` "for Effect and Promise plugins" (v2.2.4), an `experimental.idle` hook (v2.2.1), and OpenTUI ≥0.8 for TUI plugins (v2.2.3). — [GitHub releases](https://github.com/anomalyco/opencode/releases)
- The V1 import `@opencode-ai/plugin` appears only in third-party guides and is not in the V2 docs. — [Build a plugin](https://opencode.ai/docs/build/plugins/)

### Inferences
- agent-bridges has two options. The simple, robust one: keep installing plain files (`commands/*.md`, `agents/*.md`, `skills/<id>/SKILL.md`), which need no plugin. The second: ship an npm/git package exporting `Plugin.define` that registers commands and agents programmatically. Skills would still need files, or the `skills` config array, which accepts directories and HTTP catalogs. Pointing `skills: ["<repo>/skills"]` in opencode.json at the repo's skill dir avoids copying altogether.
- Whether OpenCode V2 maps the V1 `plugin` key to `plugins` is not documented. The guide says supported V1 fields are normalized, but `plugin` isn't explicitly listed, so treat it as uncertain.

### Gaps
- The docs have no Claude-Code-plugin (`.claude-plugin/plugin.json`) or marketplace support. I found none, so the answer appears to be no.
- I didn't check whether plugins can register skills via `setup(ctx)`; the docs don't say.

## 9. Session import/export JSON format

### Takeaway
The commands moved from `opencode export` / `opencode import <file>` (V1) to `opencode session export [<id>] [--sanitize]` and `opencode session import <file|URL> [--directory <dir>]` (V2). The JSON schema is not documented, and because V2 changed the server/message contracts, V1 export files may not round-trip.

### Cited Findings
- Local: the `opencode session` help lists `export` (stdout JSON, optional session ID, `--sanitize` to redact transcript and file data) and `import` (JSON file **or URL**, `--directory` to set the target project). `opencode export` at top level is treated as a directory and errors.
- Sessions are stored in SQLite at `~/.local/share/opencode/opencode.db` (local, `opencode debug paths`).
- The server API and clients have new contracts in V2. — [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)

### Inferences
- If agent-bridges builds an import file by hand (for example to seed a session), it must target the V2 export shape. The safest path is to export a real V2 session and use it as the template.

### Gaps
- I could not find an official schema for V2 session export JSON or a statement on importing V1 exports. I did not run an export locally, because it would print the user's transcript.
