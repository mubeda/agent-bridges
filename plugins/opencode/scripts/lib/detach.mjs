export function buildDetachedWorkerOptions({ execPath, scriptPath, cwd, jobId, workerCommand }) {
  return {
    file: execPath,
    args: [scriptPath, workerCommand, "--cwd", cwd, "--job-id", jobId],
    options: {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  };
}

export function mergeSpawnedPid(storedJob, pid) {
  return storedJob.status === "queued" ? { ...storedJob, pid } : storedJob;
}
