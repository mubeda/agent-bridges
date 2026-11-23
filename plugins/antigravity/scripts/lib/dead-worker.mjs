import fs from "node:fs";
import process from "node:process";

/**
 * True only when the worker pid is known to be gone: signal 0 gives ESRCH, or on Linux /proc/<pid>/stat shows a
 * zombie. Any other answer (EPERM, an unreadable /proc) is "alive or unknown". A reused pid reads as alive: accepted.
 */
export function workerGone(pid, { platform = process.platform, kill = process.kill, readFile = fs.readFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
  } catch (error) {
    return error?.code === "ESRCH";
  }
  if (platform !== "linux") return false;
  try {
    const stat = String(readFile(`/proc/${pid}/stat`, "utf8"));
    // The command name may hold spaces and parentheses: the state follows the last ")".
    return stat.slice(stat.lastIndexOf(")") + 2)[0] === "Z";
  } catch {
    return false;
  }
}

function describe(job) {
  const agy = Number.isSafeInteger(job.agyPid)
    ? `Its agy process (pid ${job.agyPid}) and any command it started may still be running.`
    : "No agy process was recorded for it, but one may have been started.";
  return `The companion process that ran this job (pid ${job.pid}) is no longer running, and the job recorded no result. ${agy} Check whether these processes still run and end them if they belong to this job. The bridge did not stop or remove anything.`;
}

/** The job as status and result show it when its worker is gone: computed for the output, never stored. */
export function unresolvedView(job) {
  return { ...job, status: "unresolved", phase: "unresolved", errorMessage: describe(job) };
}

const ACTIVE = new Set(["queued", "running"]);

function isJobRecord(record, id) {
  return Boolean(record) && typeof record === "object" && !Array.isArray(record) && record.id === id && typeof record.status === "string";
}

/**
 * The job as status and result show it, from read() calls only ({ job } or { note }): nothing is written. A missing,
 * unreadable or malformed record gives the index entry with a note that names no content. Only a queued or running
 * record is probed; when its worker is gone, the record is read again and shown as unresolved only if it is still
 * active with the same worker pid. The index's updatedAt is carried over; the stored status is kept.
 */
export function projectJob(indexed, read, gone = workerGone) {
  const take = () => {
    const answer = read();
    if (answer.note) return { note: answer.note };
    if (!isJobRecord(answer.job, indexed.id)) return { note: `Job ${indexed.id}'s record is not a valid job record; the index entry is shown.` };
    return { job: indexed.updatedAt ? { ...answer.job, updatedAt: indexed.updatedAt } : answer.job };
  };
  const first = take();
  if (first.note) return { job: indexed, note: first.note };
  if (!ACTIVE.has(first.job.status) || !gone(first.job.pid)) return { job: first.job, note: null };
  const again = take();
  if (again.note) return { job: indexed, note: again.note };
  const same = ACTIVE.has(again.job.status) && again.job.pid === first.job.pid;
  return { job: same ? unresolvedView(again.job) : again.job, note: null };
}
