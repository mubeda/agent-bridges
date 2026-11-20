import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getGeminiAuthStatus } from "../plugins/gemini/scripts/lib/gemini.mjs";

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-auth-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".gemini"));
  fs.writeFileSync(path.join(home, ".gemini", "oauth_creds.json"), "{}");
  fs.writeFileSync(path.join(home, ".gemini", "google_accounts.json"), JSON.stringify({ active: "someone@example.com" }));
  return home;
}

test("cached OAuth credentials alone are not a sign-in: headless gemini also needs a selected auth method", (t) => {
  const home = makeHome(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-ws-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const status = getGeminiAuthStatus(cwd, { env: {}, home });
  assert.equal(status.loggedIn, false);
  assert.match(status.detail, /auth method/i);
  // Setup output never carries the account email.
  assert.doesNotMatch(JSON.stringify(status), /someone@example\.com/);

  for (const settings of [{ security: { auth: { selectedType: "oauth-personal" } } }, { selectedAuthType: "oauth-personal" }]) {
    fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify(settings));
    const selected = getGeminiAuthStatus(cwd, { env: {}, home });
    assert.equal(selected.loggedIn, true, JSON.stringify(settings));
    assert.doesNotMatch(JSON.stringify(selected), /someone@example\.com/);
  }
  fs.rmSync(path.join(home, ".gemini", "settings.json"));
  assert.equal(getGeminiAuthStatus(cwd, { env: { GOOGLE_GENAI_USE_GCA: "true" }, home }).loggedIn, true);
  fs.mkdirSync(path.join(cwd, ".gemini"));
  fs.writeFileSync(path.join(cwd, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
  assert.equal(getGeminiAuthStatus(cwd, { env: {}, home }).loggedIn, true);
});

test("leftover OAuth credentials do not hide an API key in ~/.gemini/.env", (t) => {
  const home = makeHome(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-ws-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, ".gemini", ".env"), "GEMINI_API_KEY=x\n");
  const status = getGeminiAuthStatus(cwd, { env: {}, home });
  assert.equal(status.loggedIn, true);
  assert.equal(status.source, "dotenv");
});
