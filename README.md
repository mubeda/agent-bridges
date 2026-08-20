# Agent Bridges

Catalog of two companion plugins — **OpenCode** and **Gemini** — for Claude Code, Codex CLI, Cursor, and OpenCode.

Repository: https://github.com/mubeda/mau-ai-marketplace

License: Apache-2.0

## Plugins

| Plugin | What it does |
|---|---|
| `opencode` | Review and rescue via the local `opencode` CLI |
| `gemini` | Review and rescue via the local `gemini` CLI |

Each plugin can be installed independently.

## Claude Code

```bash
/plugin marketplace add mubeda/mau-ai-marketplace
/plugin install opencode@agent-bridges
/plugin install gemini@agent-bridges
```

Then `/opencode:setup` and `/gemini:setup`.

## Codex CLI

```bash
codex plugin marketplace add https://github.com/mubeda/mau-ai-marketplace.git
codex plugin add opencode@agent-bridges
codex plugin add gemini@agent-bridges
```

Invoke skills such as `opencode-review` and `gemini-setup`.

## Cursor

Team marketplace: Dashboard → Plugins → import this GitHub repo.

Local:

```bash
# copy or symlink
# ~/.cursor/plugins/local/opencode  ->  <clone>/plugins/opencode
# ~/.cursor/plugins/local/gemini    ->  <clone>/plugins/gemini
```

Reload the window. Commands come from each plugin’s `commands/` folder.

## OpenCode

```bash
node scripts/install-opencode.mjs --plugin all --scope user
# project: --scope project --project /path/to/repo
```

Use `--force` to overwrite modified installer-managed files. Use `--uninstall` to remove only the selected plugins' installer-managed files.

Community CLI (optional, not vendored): `opencode-marketplace install <path-to-plugins/opencode>`.

This installer does not add entries to `opencode.json` `"plugin": []`.

## Manual checklist

- Claude: marketplace add → install → `/opencode:setup` and `/gemini:setup`
- Codex: marketplace add → plugin add → invoke `opencode-review` / `gemini-setup`
- Cursor: local plugin dir → commands visible
- OpenCode: installer `--scope user` → `opencode--review.md` and companion path work

## Layout

Point at `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.cursor-plugin/marketplace.json`, `.opencode/catalog.json`, and `plugins/`.
