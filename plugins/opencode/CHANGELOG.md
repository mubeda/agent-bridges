# Changelog

## 0.2.1

- Drop `"hooks": "./hooks/hooks.json"` from the Claude manifest. Claude Code
  auto-loads `hooks/hooks.json`, and redeclaring it made `/plugin diagnose`
  fail with a duplicate-hooks error while skipping the extra load.

## 0.1.0

- Initial version of the OpenCode plugin for Claude Code.
- Seven slash commands: `/opencode:review`, `/opencode:adversarial-review`,
  `/opencode:rescue`, `/opencode:status`, `/opencode:result`,
  `/opencode:cancel`, `/opencode:setup`.
- `opencode:opencode-rescue` subagent and `opencode-cli-runtime` /
  `opencode-prompting` skills.
- Companion bridge that spawns `opencode run --format json` per task,
  captures session IDs for resume/cancel, and tracks jobs in
  `${CLAUDE_PLUGIN_DATA}/state/`.
