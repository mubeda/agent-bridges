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
