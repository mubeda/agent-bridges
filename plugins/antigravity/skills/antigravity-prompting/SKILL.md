---
name: antigravity-prompting
description: Internal guidance for composing tight prompts for Antigravity task runs
user-invocable: false
---

# Antigravity Prompting

Use this skill only inside `antigravity-rescue` and only to shape the user's natural-language request into a tighter Antigravity prompt before the single forwarded `task` call.

## Prompt shape

1. State a one-sentence objective.
2. Include concrete file paths, commands to reproduce, error excerpts, or failing assertions the user supplied.
   A read-only run has no file tool: a path in the prompt is only a name, so the forwarder passes each file the user named with `--include <path>` as well.
3. State constraints plainly: read-only, no unrelated refactor, preserve a public API, or keep a named test green.
4. Define done: a patch, findings, options with tradeoffs, or a passing test command.

For a background task, make the objective and definition of done self-contained: the job runs detached and nobody can answer follow-up questions. A foreground task uses the same concise shape.

## When to use which framing

- **Diagnosis:** ask Antigravity to find the cause and report findings before attempting a fix.
- **Narrow fix:** provide the smallest reproduction or pointer and request the smallest safe patch.
- **Research / planning:** request a plan with tradeoffs and end with "do not modify files in this run."
- **Continuation:** keep the new prompt short and directive, such as "keep going", "apply the top fix", or "run the tests and report."

## What to strip out

- Routing flags (`--background`, `--wait`, `--resume`, `--fresh`).
- Runtime flags (`--model`, `--effort`, `--include`).
- Host-side conversational filler.

Do not inspect the repository to build the prompt or invent file paths, function names, errors, or test names.

