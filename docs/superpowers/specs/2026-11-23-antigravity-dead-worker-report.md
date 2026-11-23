# Antigravity: report a dead worker, never act on it

Issue: #23. Status: implemented in antigravity 0.2.6.

## Problem

A background or foreground job records the pid of the companion process that runs it (the worker) and of agy. When the worker is killed before it records an end state, the job stays `running` forever: `status --wait` waits until its timeout and `result` refuses it.

## Rule

`status` and `result` only read: they never signal a process and never write the job file or `state.json`. The bridge never says a restart is safe for a job it did not see end.

## Design

- When a `queued` or `running` job's recorded worker is not alive, `status`, `status --wait`, `status --all` and `result` show the job as `unresolved`. The reason names the worker's pid and agy's pid (or says that none was recorded) and asks the user to check whether they, and any command agy started, still run. The state is computed for the output and never stored, so a worker that was alive after all shows its real state on the next read.
- "Not alive" means signal 0 gives `ESRCH`, or on Linux `/proc/<pid>/stat` shows the state `Z`. Any other answer, `EPERM` or an unreadable `/proc` included, means "alive or unknown" and shows the recorded state.
- `status --wait` returns at once on `unresolved`; `result` exits with the reason. The skills report `unresolved` instead of polling it, and the delegate skill never relaunches such a chunk.
- Before a job is shown as `unresolved`, its record is read again; only a job still active with the same worker pid is shown that way. The index's `updatedAt` is carried into the view; the stored status is kept.
- A job whose record is missing, cannot be read, or is not a job record (an object with the expected id and a status) is shown from its index entry with a note that names the job and the problem, never the file's content, whatever its state. `status --wait` returns with the note; `result` stops with it; the delegate skill escalates on it. A read resolves paths without creating the state folders or changing their modes.
- `cancel` is unchanged.

## Limits

- A reused pid makes a dead worker look alive, and the job shows as `running`. The skills' 10-wait rule reports such a job as stuck.
- The bridge does not stop orphaned processes, verify process identity by start time, check PID namespaces or process groups, or serialize concurrent writers of a job record. These were tried in #24 and left out: each round of review found another case in which the bridge could wrongly call a restart safe or signal a process that was not its own. Storing `unresolved` was left out too, because a status that writes can race with the worker and with `cancel`.

## Independent fixes in the same release

- `--json` output never carries a job's stored request (prompt, included files, packed transcript), and a task's summary is neutral until it has a result, also for index entries written by 0.2.5. Every write of `state.json` drops the request from all entries.
- A relative `PLUGIN_DATA` reaches the detached worker as an absolute path.
- Job files and `state.json` are written to a temporary file in the same folder and renamed into place.
