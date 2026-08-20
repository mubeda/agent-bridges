---
name: gemini-prompting
description: Internal guidance for composing prompts that the gemini CLI forwards to Google Gemini models
user-invocable: false
---

# Gemini Prompting

Use this skill only inside `gemini:gemini-rescue` and only to shape the user's natural-language request into a tighter Gemini prompt **before** the single forwarded `task` call.

The gemini CLI runs prompts through Google Gemini (Pro / Flash / Flash-Lite, auto-routed unless `--model` overrides). Two Gemini-specific niceties worth using:

- **`@path` injection in the prompt body.** Anywhere in the prompt text, `@README.md` or `@src/foo.ts` causes Gemini to splice in the file (or directory) contents at that location. Prefer this over restating code in the prompt — it's both shorter and grounded.
- **`GEMINI.md`** is Gemini's persistent project-context file (analog of `CLAUDE.md`). If the repo has one, Gemini already sees it; don't duplicate that context in the prompt.

## When to use which framing

- **Diagnosis** (something is failing, slow, or behaving unexpectedly): ask Gemini to investigate the cause first and report findings before attempting a fix. Avoid pre-committing to a solution in the prompt.
- **Narrow fix** (the user already identified the change): hand Gemini the smallest reproduction or pointer (file path, failing test name, error message) and the constraint ("apply the smallest safe patch", "do not refactor unrelated code", "preserve existing public API").
- **Research / planning** (the user wants options or a strategy): ask for a plan with tradeoffs, not an implementation. End the prompt with "do not modify files in this run."
- **Continuation** (`--resume`): the user has already given context to Gemini in a previous task. Keep the new prompt short and directive ("keep going", "apply the top fix", "now run the tests and report"). Trust the session memory.

## Prompt shape

1. One-sentence objective.
2. Concrete pointers (file paths, command to reproduce, error excerpt, failing assertion). Skip if the user already provided them.
3. Constraints in plain language (read-only, no refactor, must not change behavior of X, must keep test Y green).
4. Output expectation (a diff, a list of options, a brief explanation, a passing test).

## What to strip out

- Routing flags (`--background`, `--wait`, `--resume`, `--fresh`).
- Runtime flags (`--model`). Gemini has no `--effort` flag; drop it.
- Claude-side conversational filler ("can you ask Gemini to...", "please have the model...").

The prompt text passed to `task` should read as a direct instruction to whoever is solving the problem, with no meta-references to Claude Code or to the delegation step itself.

## What not to do

- Do not inspect the repository to build the prompt. The user's words plus any context they explicitly shared are enough.
- Do not invent file paths, function names, error messages, or test names. Better to forward a slightly underspecified prompt than a confidently wrong one.
- Do not coach the model on technique ("use TDD", "think step by step"). Gemini runs whatever instructions you write through the configured model; let the model handle its own technique.
