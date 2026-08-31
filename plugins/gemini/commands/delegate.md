---
name: delegate
description: Run a coding task with a strict manager/implementer split — Gemini makes every repository change while this session plans chunks, code-reviews every diff, and commits
argument-hint: "[task description, protected paths, and any constraints]"
---

Load the `gemini:gemini-delegate` skill with the `Skill` tool and follow it for the raw user request below. You are the manager and code reviewer; Gemini is the implementer and makes every repository file change. Run the workflow inline in this session — do not forward it to a subagent, because the review-and-commit loop is yours.

Only proceed on an explicit delegation request like this one; report back with chunks, review findings, commits, and validation results as the skill prescribes.

Raw user request:
$ARGUMENTS
