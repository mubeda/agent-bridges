import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  getAgyAuthStatus,
  inferBackendFromBin,
  pickTaskRunBackend,
  resolveGeminiBackend,
  resumeTargetFromJob
} from "../plugins/gemini/scripts/lib/gemini.mjs";

test("inferBackendFromBin uses override then basename", () => {
  assert.equal(inferBackendFromBin("/usr/bin/custom", "agy"), "agy");
  assert.equal(inferBackendFromBin("C\\\\Tools\\\\agy.exe", null), "agy");
  assert.equal(inferBackendFromBin("/usr/bin/gemini", null), "gemini");
  assert.equal(inferBackendFromBin("/usr/bin/custom", null), "gemini");
});

test("prefers agy on PATH when no env", () => {
  const result = resolveGeminiBackend({
    env: {},
    whichBinary: (name) => (name === "agy" ? "/bin/agy" : name === "gemini" ? "/bin/gemini" : null)
  });
  assert.equal(result.backend, "agy");
  assert.equal(result.bin, "/bin/agy");
  assert.equal(result.available, true);
});

test("GEMINI_BIN wins", () => {
  const result = resolveGeminiBackend({
    env: { GEMINI_BIN: "/opt/gemini" },
    whichBinary: () => "/bin/agy"
  });
  assert.equal(result.bin, "/opt/gemini");
  assert.equal(result.backend, "gemini");
});

test("GEMINI_BACKEND=gemini skips agy", () => {
  const result = resolveGeminiBackend({
    env: { GEMINI_BACKEND: "gemini" },
    whichBinary: (name) => (name === "gemini" ? "/bin/gemini" : "/bin/agy")
  });
  assert.equal(result.backend, "gemini");
  assert.equal(result.bin, "/bin/gemini");
});

test("missing binaries include both install hints", () => {
  const result = resolveGeminiBackend({ env: {}, whichBinary: () => null });
  assert.equal(result.available, false);
  assert.match(result.detail, /agy/);
  assert.match(result.detail, /@google\/gemini-cli/);
});

test("getAgyAuthStatus loggedIn when antigravity-cli is a directory", () => {
  const home = "/tmp/home";
  const authDir = path.join(home, ".gemini", "antigravity-cli");
  const result = getAgyAuthStatus({
    home,
    existsSync: (p) => p === authDir,
    statSync: () => ({ isDirectory: () => true }),
    readdirSync: () => ["creds.json"]
  });
  assert.equal(result.loggedIn, true);
});

test("getAgyAuthStatus loggedIn false when antigravity-cli is missing", () => {
  const result = getAgyAuthStatus({
    home: "/tmp/home",
    existsSync: () => false
  });
  assert.equal(result.loggedIn, false);
});

test("getAgyAuthStatus loggedIn false when antigravity-cli is a file", () => {
  const home = "/tmp/home";
  const authDir = path.join(home, ".gemini", "antigravity-cli");
  const result = getAgyAuthStatus({
    home,
    existsSync: (p) => p === authDir,
    statSync: () => ({ isDirectory: () => false })
  });
  assert.equal(result.loggedIn, false);
});

test("pickTaskRunBackend prefers resume job backend over PATH preference", () => {
  assert.equal(
    pickTaskRunBackend({ resumeBackend: "gemini", requestBackend: "agy", resolvedBackend: "agy" }),
    "gemini"
  );
  assert.equal(
    pickTaskRunBackend({ resumeBackend: "agy", requestBackend: "gemini", resolvedBackend: "gemini" }),
    "agy"
  );
  assert.equal(
    pickTaskRunBackend({ resumeBackend: null, requestBackend: "agy", resolvedBackend: "gemini" }),
    "agy"
  );
  assert.equal(pickTaskRunBackend({ resumeBackend: null, requestBackend: null, resolvedBackend: "agy" }), "agy");
  assert.equal(pickTaskRunBackend({}), "gemini");
});

test("resumeTargetFromJob carries thread id and backend", () => {
  assert.deepEqual(resumeTargetFromJob({ threadId: "sess-1", backend: "gemini" }), {
    id: "sess-1",
    backend: "gemini"
  });
  assert.equal(resumeTargetFromJob({ threadId: null, backend: "agy" }), null);
  assert.equal(resumeTargetFromJob({ threadId: "sess-2" }).backend, null);
});
