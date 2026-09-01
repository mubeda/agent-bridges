---
name: cursor-delegate
description: Run a coding task with a strict manager/implementer split - Cursor Agent makes every repository change while you plan, coordinate parallel chunks, code-review every diff, and commit. Use ONLY when the user explicitly invokes /cursor:delegate or explicitly asks to delegate implementation to Cursor Agent ("delegate this to cursor", "have cursor implement this", "cursor implements, you review"). Never auto-trigger for ordinary coding requests that don't name Cursor Agent delegation.
user-invocable: true
---

# Delegate to Cursor Agent

You are the **manager and code reviewer**. Cursor Agent is the **implementer**. This
split exists because an implementer reviewing its own work misses what a
separate reviewer catches — the value of this skill is that every change gets
an independent adversarial review before it lands.

## Companion runtime

Resolve `<plugin-root>` as the first directory that contains `scripts/cursor-companion.mjs`:
1. `$CLAUDE_PLUGIN_ROOT`
2. `$PLUGIN_ROOT`
3. `~/.cursor/plugins/local/cursor`
4. `~/.config/opencode/plugins/cursor`
5. otherwise search the host plugin cache for this plugin's `scripts/cursor-companion.mjs`

If none exist, stop and print those paths. Do not invent a companion elsewhere.

Every Cursor Agent run goes through the companion's `task`, `status`, and `result`
subcommands; never invoke the backend CLI directly.

## Hard rules

1. **Every repository file change goes through Cursor Agent** — code, tests, docs,
   fixtures, configs, reports, all of it. No exception for "trivial" fixes:
   a one-line lint fix found in review goes back to Cursor Agent like anything
   else. Your only writes are: git commits (staging + message), your docket,
   and your own notes outside the repository. If a report or doc needs
   writing, hand Cursor Agent your evidence notes and let it write the file.
2. **Cursor Agent never commits.** An uncommitted worktree is your review
   boundary: `git status` must show exactly the unreviewed work. Tell
   Cursor Agent this in every prompt.
3. **Cursor Agent never touches protected paths.** Three layers, all restated
   verbatim in every prompt:
   - Shipped defaults: `.git/`, `node_modules/`, `target/`, `dist/`,
     `vendor/`, other generated/vendored directories.
   - Whatever the repo's AGENTS.md / CLAUDE.md declares off-limits.
   - Anything the user names at invocation time.
4. **Nothing is pushed** unless the user explicitly asks.
5. **Cursor Agent reports are claims, not evidence.** Verify every claim yourself
   before acting on it.

## Workflow

### 1. Plan chunks and open the docket

Decompose the task into chunks, each with a **predicted-disjoint owned file
set**. Chunks with no dependency between them may run in parallel; a chunk
that needs another's output serializes behind it.

Parallelism is your judgment call, guided by:
- Prefer splitting across languages or packages — their toolchains don't
  contend.
- Keep at most one chunk in flight that hammers a shared build lock (cargo,
  gradle, and similar toolchains serialize; a second command just blocks).
- Reviews queue on you, a single reviewer — width beyond 2–3 rarely helps.

Before launching anything, create a docket outside the repository (your
scratchpad if the host provides one, otherwise a temp directory) and keep it
current after every event. It is what makes the run recoverable after a
context compaction or interruption:

```markdown
# cursor-delegate docket — <task> — <date>
Base commit: <sha>   Repo: <path>   Branch: <branch>
Protected paths (beyond defaults): <list>

| # | Chunk | Description | Owned files | Job id | Status | Progress | Re-feeds | Commit |
|---|-------|-------------|-------------|--------|--------|----------|----------|--------|
| 1 | <name> | <one-line what this chunk does> | <files/globs> | task-... | queued/running/blocked/restarted/review/committed/escalated | <evidence: files touched vs. owned, elapsed, attempt n/3> | 0 | - |
```

### 2. Launch each chunk as a fresh background job

```bash
cd <repo> && node "<plugin-root>/scripts/cursor-companion.mjs" task --background --fresh --write "$(cat <<'CHUNK_PROMPT'
<chunk prompt>
CHUNK_PROMPT
)"
```

- **Always `--fresh --write` for implementation.** `--write` runs the
  agent with write access; without it the run stays in plan mode and
  produces no edits. `--fresh` keeps every chunk on its own thread: the companion can
  only resume the latest thread in a workspace, so with parallel chunks in
  flight a resume may target the wrong one.
- `cd <repo>` matters: the companion keys its job state to the working
  directory.
- Launch independent chunks together so they run concurrently.
- If the companion or the Cursor `agent` CLI is missing or unauthenticated, stop
  and tell the user to run setup (`/cursor:setup` or the `cursor-setup`
  skill).

**Chunk prompt template** — every prompt is fully self-contained (fresh
threads have no memory; self-contained prompts also make re-feeds and
parallel launches trivial). The opening approval line is load-bearing: on a
fresh thread the implementer may propose a design and stop to wait for a
"yes", which burns a whole round-trip producing zero files:

```
<task>
This task text IS the approved design — do not pause to propose a plan or
ask for approval; implement and finish in this run.

Work in repo <path> (branch <branch>). You have write access; apply
edits directly. Do NOT commit. Do NOT touch: <all protected
paths>. Other agents may be editing other files concurrently — restrict
yourself strictly to your owned files below; the supervising session
reviews, validates, and commits.

Owned files: <the chunk's file set — create/modify only these>

Background facts you may rely on: <verified facts: versions, constants,
locations, prior decisions — everything Cursor Agent would otherwise re-derive>

TASK: <precise description; expected behavior; tests to write/update;
which focused test commands to run — focused suites only, the supervisor
runs cross-cutting gates>

Finish with: every file touched, every command run with its result,
anything incomplete.
</task>
```

### 3. Monitor: bounded polls + 10-minute health loop

A background launch prints a job id (`task-...`). Poll per chunk while
continuing other work — in a background shell if your harness supports one,
otherwise between other steps — and **cap every poll at 10 minutes** so it
returns on completion OR on timeout; the timeout is the health-loop tick:

```bash
timeout 600 bash -c 'until node "<plugin-root>/scripts/cursor-companion.mjs" status <job-id> --json | grep -qE "\"status\": *\"(completed|failed|cancelled)\""; do sleep 30; done'
```

Every time a poll returns — chunk finished or the 10 minutes lapsed — run
one **health pass** over ALL in-flight chunks, then re-arm a capped poll
for each chunk still running. Re-arm only while any chunk is queued or
running; the loop ends when every chunk is committed or escalated.

**Health pass** (also run once right after launching the first chunk):

1. For every in-flight chunk, run
   `node "<plugin-root>/scripts/cursor-companion.mjs" status <job-id> --json`
   and pull any new output.
2. Snapshot `git status --short` and diff it against the previous tick's
   snapshot (keep snapshots next to the docket).
3. Classify each chunk:
   - **alive** — status running AND (new output OR worktree changed since
     last tick).
   - **dead** — status failed/cancelled, job id unknown, or the companion
     errors.
   - **blocked** — status running but NO new output AND NO worktree change
     for **2 consecutive ticks** (~20 min), or the output shows the
     implementer waiting for approval/input. One quiet tick is not
     blocked — it may be running tests or thinking without writing.
4. Restart what needs it, always as a fresh `--background --fresh --write`
   job whose prompt states the worktree may already contain partial edits
   from the prior attempt and exactly what remains:
   - A **dead** restart is environmental — it does NOT count against the
     re-feed budget.
   - A **blocked** restart DOES count against the two-re-feed budget; over
     budget → escalate as usual.
5. Update the docket's Status and Progress columns, then **print the
   status table to the user** — every tick, even when nothing changed:

```markdown
| # | Chunk | Description | Status | Progress |
|---|-------|-------------|--------|----------|
| 1 | parser | extract tokenizer into module | running (alive) | 3/5 owned files touched, 12m elapsed, attempt 1/3 |
| 2 | tests | port fixtures to new API | review | diff read, suites re-running |
```

The tick table is just the docket's live columns — never a second table
kept in sync by hand. Progress is short free-text **evidence** (files
touched vs. owned, elapsed time, attempt count), never a guessed
percentage.

When a chunk finishes, pull the report with
`node "<plugin-root>/scripts/cursor-companion.mjs" result <job-id>` and move
it to review.

### 4. Review every chunk — mandatory checklist

Run all five for every chunk, no matter how small:

1. **Scope**: `git status --short` + `git diff --stat` — the diff touches
   exactly the chunk's owned files. Out-of-scope edits are a review failure
   (see collisions below).
2. **Boundaries**: HEAD unchanged (no commits by Cursor Agent); no protected
   path touched.
3. **Read every diff hunk.** Cursor Agent's report describes intent; only the
   diff shows what happened. Review the code as you would a human PR:
   design fit, conventions, edge cases, comments.
4. **Assertion integrity**: tests were strengthened or preserved — watch
   for weakened rejections, deleted assertions, loosened matchers,
   `.skip`s, and expectations rewritten to match buggy output.
5. **Re-run every suite Cursor Agent claims green, yourself.** Also run the
   repo's language gates (lint, typecheck, format — whatever the repo uses)
   for each language the chunk touched.

Cross-cutting gates (full lint/typecheck, broad suites) are yours, run
serially — never delegated to parallel chunks. Reserve the repo's full
battery for milestone end, not per chunk.

The implementer's sandbox can be more restricted than your environment
(e.g. no loopback binds, so socket tests fail there) — a failure Cursor Agent
reports as environmental must be re-run locally before you believe either
way.

### 5. Findings: re-feed, at most twice

Every finding — however small — goes back to Cursor Agent with precise
file-and-line feedback. Launch the re-feed as a **fresh `--fresh --write`
job** whose prompt states that the worktree already contains the prior
attempt's edits and lists exactly what to change. (The companion can only
resume the *latest* thread in a workspace, so with parallel chunks in
flight, `--resume-last` may target the wrong thread; a strictly serial run
may use `--resume-last` instead, since the thread history is then
unambiguous.)

Budget: **two re-feeds per chunk** (three implementation attempts total).
If findings remain, stop and escalate to the user with the diff, your
findings, and what Cursor Agent did instead. Update the docket's re-feed count
each time.

### 6. Collisions

When a chunk's diff touches a file another in-flight chunk owns (the
disjointness prediction failed):

1. Freeze launching new parallel chunks.
2. Review and commit the first-finished chunk as normal.
3. Re-feed the offending chunk: "revert your edits to `<file>` — it belongs
   to another chunk / rework on top of the now-committed state."
4. A recurring collision after the re-feed budget escalates like any other
   stuck chunk.

### 7. Commit per reviewed chunk

After a chunk passes review, stage **only its owned files** (parallel
chunks' edits may coexist in the worktree) and commit with a message that
explains the why, credits the split honestly, and carries whatever trailers
your harness requires:

```
<type>(<scope>): <what and why>

Implemented by Cursor Agent (cursor-delegate) under supervision; reviewed,
validated, and committed by the supervising session.
```

Record the SHA in the docket, then launch the next chunk(s).

### 8. Milestone end

Run the repo's full battery (full test suite, all gates). Failures here are
findings: diagnose, then re-feed the responsible chunk's fix to Cursor Agent
like any other finding — you still do not edit repo files. Report to the
user: chunks, commits, validation results with real numbers, escalations,
anything incomplete. Do not push.

## When Cursor Agent is unavailable

If the companion is missing, the Cursor `agent` CLI is unauthenticated, or jobs
persistently fail, do not silently fall back to implementing yourself —
that inverts the skill's contract. Tell the user and let them choose.
