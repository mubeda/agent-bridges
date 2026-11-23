# Antigravity: report a dead worker, never act on it

Issue: #23. Status: implemented in antigravity 0.2.6.

## Problem

A background or foreground job records the pid of the companion process that runs it (the worker) and of agy. When the worker is killed before it records an end state, the job stays `running` forever: `status --wait` waits until its timeout and `result` refuses it.

## Rule

`status` and `result` never signal any process, and the bridge never says a restart is safe for a job it did not see end.

## Design

- When a `queued` or `running` job's recorded worker is not alive, `status`, `status --wait`, `status --all` and `result` record the job as `unresolved`. The reason names the worker's pid and agy's pid (or says that none was recorded) and tells the user to check whether they, and any command agy started, still run. Nothing is signalled or removed, and no restart is advised.
- "Not alive" means signal 0 gives `ESRCH`, or on Linux `/proc/<pid>/stat` shows the state `Z`. Any other answer, `EPERM` or an unreadable `/proc` included, means "alive or unknown" and changes nothing.
- `unresolved` is written only over the record that was read: the job file is read again right before the write, and any change skips it. A worker that was alive after all records its end state over `unresolved`, because its writes merge onto whatever is stored.
- `status --wait` returns at once on `unresolved`; `result` exits with the reason. The skills report `unresolved` instead of polling it, and the delegate skill never relaunches such a chunk.
- `cancel` is unchanged: it signals the recorded pids as before, and also accepts an `unresolved` job.

## Limits

- A reused pid makes a dead worker look alive, and the job stays `running`. The skills' 10-wait rule reports such a job as stuck.
- The bridge does not stop orphaned processes, verify process identity by start time, check PID namespaces or process groups, or serialize concurrent writers of a job record. These were tried in #24 and left out: each round of review found another case in which the bridge could wrongly call a restart safe or signal a process that was not its own.

## Independent fixes in the same release

- `--json` output never carries a job's stored request (prompt, included files, packed transcript), and a task's summary is neutral until it has a result, also for index entries written by 0.2.5. The index no longer stores the request.
- A relative `PLUGIN_DATA` reaches the detached worker as an absolute path.
- Job files and `state.json` are written to a temporary file in the same folder and renamed into place.
- An unreadable job file: `status --all` skips it with a note, `status <id>` reports the index entry with a note, and `result` and `cancel` stop with the read error and leave the file alone.
