---
name: opencode-prompting
description: Internal guidance for composing prompts that OpenCode forwards to the configured provider/model
user-invocable: false
---

# OpenCode Prompting

Use this skill only inside `opencode:opencode-rescue` and only to shape the user's natural-language request into a tighter OpenCode prompt **before** the single forwarded `task` call.

This skill is provider-neutral. OpenCode forwards prompts to whatever provider and model the user has configured (Anthropic Claude via Bedrock, OpenRouter, Anthropic direct, OpenAI, local Ollama, etc.). Tailor the prompt to the kind of work being requested, not to a specific model family.

## When to use which framing

- **Diagnosis** (something is failing, slow, or behaving unexpectedly): ask OpenCode to investigate the cause first and report findings before attempting a fix. Avoid pre-committing to a solution in the prompt.
- **Narrow fix** (the user already identified the change): hand OpenCode the smallest reproduction or pointer (file path, failing test name, error message) and the constraint ("apply the smallest safe patch", "do not refactor unrelated code", "preserve existing public API").
- **Research / planning** (the user wants options or a strategy): ask for a plan with tradeoffs, not an implementation. End the prompt with "do not modify files in this run."
- **Continuation** (`--resume`): the user has already given context to OpenCode in a previous task. Keep the new prompt short and directive ("keep going", "apply the top fix", "now run the tests and report"). Trust the session memory.

## Prompt shape

1. One-sentence objective.
2. Concrete pointers (file paths, command to reproduce, error excerpt, failing assertion). Skip if the user already provided them.
3. Constraints in plain language (read-only, no refactor, must not change behavior of X, must keep test Y green).
4. Output expectation (a diff, a list of options, a brief explanation, a passing test).

## What to strip out

- Routing flags (`--background`, `--wait`, `--resume`, `--fresh`).
- Runtime flags (`--model`, `--effort`).
- Claude-side conversational filler ("can you ask OpenCode to...", "please have OpenCode...").

The prompt text passed to `task` should read as a direct instruction to whoever is solving the problem, with no meta-references to Claude Code or to the delegation step itself.

## What not to do

- Do not inspect the repository to build the prompt. The user's words plus any context they explicitly shared are enough.
- Do not invent file paths, function names, error messages, or test names. Better to forward a slightly underspecified prompt than a confidently wrong one.
- Do not coach the model on technique ("use TDD", "think step by step"). OpenCode runs whatever instructions you write through the configured model; let the model handle its own technique.
