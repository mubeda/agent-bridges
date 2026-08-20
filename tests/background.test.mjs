import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildDetachedWorkerOptions,
  mergeSpawnedPid
} from "../plugins/opencode/scripts/lib/detach.mjs";

test("detached worker spawn options isolate the child", () => {
  const built = buildDetachedWorkerOptions({
    execPath: "node",
    scriptPath: "scripts/opencode-companion.mjs",
    cwd: "/tmp/repo",
    jobId: "review-1",
    workerCommand: "review-worker"
  });

  assert.deepEqual(built.args, [
    "scripts/opencode-companion.mjs",
    "review-worker",
    "--cwd",
    "/tmp/repo",
    "--job-id",
    "review-1"
  ]);
  assert.equal(built.options.detached, true);
  assert.equal(built.options.stdio, "ignore");
  assert.equal(built.options.windowsHide, true);
});

test("spawned pid is added while a job is still queued", () => {
  assert.deepEqual(mergeSpawnedPid({ status: "queued", pid: null }, 123), {
    status: "queued",
    pid: 123
  });
});

test("spawned pid does not revert a completed job to queued", () => {
  assert.deepEqual(mergeSpawnedPid({ status: "completed", phase: "completed", pid: null }, 123), {
    status: "completed",
    phase: "completed",
    pid: null
  });
});

for (const companion of ["opencode", "gemini"]) {
  test(`${companion} review background mode dispatches a review worker`, () => {
    const source = fs.readFileSync(
      new URL(`../plugins/${companion}/scripts/${companion}-companion.mjs`, import.meta.url),
      "utf8"
    );

    assert.match(source, /enqueueBackgroundTask\(cwd, job, request, "review-worker"\)/);
    assert.match(source, /async function handleReviewWorker\(argv\)/);
    assert.match(source, /case "review-worker":/);
    assert.match(source, /mergeSpawnedPid\(storedAfterSpawn, child\.pid\)/);
  });

  test(`${companion} checks CLI availability before enqueueing a background review`, () => {
    const source = fs.readFileSync(
      new URL(`../plugins/${companion}/scripts/${companion}-companion.mjs`, import.meta.url),
      "utf8"
    );
    const functionStart = source.indexOf("async function handleReviewCommand(argv, config)");
    const functionEnd = source.indexOf("async function handleReview(", functionStart);
    assert.notEqual(functionStart, -1, "handleReviewCommand source should be present");
    assert.notEqual(functionEnd, -1, "handleReview source should follow handleReviewCommand");

    const functionBody = source.slice(functionStart, functionEnd);
    const availabilityHelper =
      companion === "opencode" ? "ensureOpencodeAvailable(cwd)" : "ensureGeminiAvailable(cwd)";
    const availabilityIndex = functionBody.indexOf(availabilityHelper);
    const enqueueIndex = functionBody.indexOf("enqueueBackgroundTask(");

    assert.notEqual(availabilityIndex, -1);
    assert.notEqual(enqueueIndex, -1);
    assert.ok(availabilityIndex < enqueueIndex);
  });
}
