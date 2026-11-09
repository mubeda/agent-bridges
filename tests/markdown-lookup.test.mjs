import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("review command documents PLUGIN_ROOT lookup", () => {
  const body = fs.readFileSync(path.join(root, "plugins/opencode/commands/review.md"), "utf8");
  assert.match(body, /PLUGIN_ROOT/);
  assert.doesNotMatch(body, /MAU_PLUGIN_ROOT/);
  assert.match(body, /opencode-companion\.mjs/);
});

test("plugin markdown has no MAU_PLUGIN_ROOT", () => {
  const files = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (/\.(md|mjs|json)$/.test(ent.name)) {
        files.push(full);
      }
    }
  }
  walk(path.join(root, "plugins"));
  for (const file of files) {
    const body = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(body, /MAU_PLUGIN_ROOT|MAU_PLUGIN_DATA/);
  }
});

for (const companion of ["opencode", "gemini", "cursor"]) {
  for (const command of ["review", "adversarial-review"]) {
    test(`${companion} ${command} command delegates background execution to the companion`, () => {
      const body = fs.readFileSync(
        path.join(root, `plugins/${companion}/commands/${command}.md`),
        "utf8"
      );
      assert.doesNotMatch(body, /run_in_background/);
    });
  }
}

test("codex review skill exists", () => {
  const body = fs.readFileSync(
    path.join(root, "plugins/opencode/skills/opencode-review/SKILL.md"),
    "utf8"
  );
  assert.match(body, /^name:\s*opencode-review/m);
  assert.match(body, /review/);
});

test("transfer command exists for companion plugins", () => {
  for (const name of ["opencode", "gemini", "cursor"]) {
    const body = fs.readFileSync(path.join(root, `plugins/${name}/commands/transfer.md`), "utf8");
    assert.match(body, /PLUGIN_ROOT/);
    assert.match(body, /transfer/);
  }
});

test("codex transfer skills exist", () => {
  assert.match(
    fs.readFileSync(path.join(root, "plugins/opencode/skills/opencode-transfer/SKILL.md"), "utf8"),
    /^name:\s*opencode-transfer/m
  );
  assert.match(
    fs.readFileSync(path.join(root, "plugins/gemini/skills/gemini-transfer/SKILL.md"), "utf8"),
    /^name:\s*gemini-transfer/m
  );
  assert.match(
    fs.readFileSync(path.join(root, "plugins/cursor/skills/cursor-transfer/SKILL.md"), "utf8"),
    /^name:\s*cursor-transfer/m
  );
});

test("rescue defaults to --write", () => {
  const body = fs.readFileSync(path.join(root, "plugins/opencode/commands/rescue.md"), "utf8");
  assert.match(body, /--write/);
});

test("claude rescue skill defaults to --write", () => {
  const body = fs.readFileSync(
    path.join(root, "plugins/claude/skills/claude-rescue/SKILL.md"),
    "utf8"
  );
  assert.match(body, /--write/);
});

test("claude transfer skill exists", () => {
  assert.match(
    fs.readFileSync(path.join(root, "plugins/claude/skills/claude-transfer/SKILL.md"), "utf8"),
    /^name:\s*claude-transfer/m
  );
});

test("claude skills document PLUGIN_ROOT lookup", () => {
  const body = fs.readFileSync(
    path.join(root, "plugins/claude/skills/claude-review/SKILL.md"),
    "utf8"
  );
  assert.match(body, /PLUGIN_ROOT/);
  assert.match(body, /claude-companion\.mjs/);
  assert.doesNotMatch(body, /MAU_PLUGIN_ROOT/);
});

test("cursor companion documentation has no inherited OpenCode instructions", () => {
  const setup = fs.readFileSync(path.join(root, "plugins/cursor/commands/setup.md"), "utf8");
  const rescue = fs.readFileSync(path.join(root, "plugins/cursor/commands/rescue.md"), "utf8");
  const transfer = fs.readFileSync(
    path.join(root, "plugins/cursor/skills/cursor-transfer/SKILL.md"),
    "utf8"
  );

  assert.match(setup, /https:\/\/cursor\.com\/docs\/cli\/installation/);
  assert.match(setup, /agent login|CURSOR_API_KEY/);
  assert.doesNotMatch(setup, /opencode-ai|opencode auth/);
  assert.doesNotMatch(rescue, /Skill\(opencode/);
  assert.match(rescue, /Skill\(cursor:rescue\)/);
  assert.match(transfer, /Claude, Codex, or Cursor/);
  assert.doesNotMatch(transfer, /Cursor, Codex, or Cursor Agent/);
});

test("Cursor documentation contains no obsolete permission or OpenCode commands", () => {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  }
  walk(path.join(root, "plugins/cursor"));
  for (const file of files) {
    const body = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(body, /dangerously-skip-permissions/i, file);
    assert.doesNotMatch(body, /opencode-ai|opencode auth|Skill\(opencode/i, file);
  }
});

test("delegate skills exist for all four companions", () => {
  for (const name of ["opencode", "gemini", "claude", "cursor"]) {
    const body = fs.readFileSync(
      path.join(root, `plugins/${name}/skills/${name}-delegate/SKILL.md`),
      "utf8"
    );
    assert.match(body, new RegExp(`^name:\\s*${name}-delegate`, "m"));
    assert.match(body, new RegExp(`${name}-companion\\.mjs`));
    assert.match(body, /PLUGIN_ROOT/);
    // claude --bg may isolate jobs in .claude/worktrees/, so its delegate runs --wait
    const launchFlags = name === "claude" ? "--wait --fresh --write" : "--background --fresh --write";
    assert.match(body, new RegExp(launchFlags));
    assert.match(body, /never commits/i);
    assert.match(body, /Never auto-trigger/);
  }
});

test("delegate command exists for Claude and Cursor host plugins", () => {
  for (const name of ["opencode", "gemini", "cursor"]) {
    const body = fs.readFileSync(path.join(root, `plugins/${name}/commands/delegate.md`), "utf8");
    assert.match(body, /^name:\s*delegate/m);
    assert.match(body, new RegExp(`${name}-delegate`));
  }
  assert.equal(fs.existsSync(path.join(root, "plugins/claude/commands")), false);
});

test("Cursor documentation only invokes implemented companion subcommands", () => {
  const script = fs.readFileSync(path.join(root, "plugins/cursor/scripts/cursor-companion.mjs"), "utf8");
  const implemented = new Set([...script.matchAll(/case "([^"]+)"/g)].map((match) => match[1]));
  const docs = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) docs.push(full);
    }
  }
  walk(path.join(root, "plugins/cursor/commands"));
  walk(path.join(root, "plugins/cursor/skills"));
  for (const file of docs) {
    const body = fs.readFileSync(file, "utf8");
    for (const match of body.matchAll(/cursor-companion\.mjs"\s+([a-z-]+)/g)) {
      assert.ok(implemented.has(match[1]), `${file} invokes missing subcommand ${match[1]}`);
    }
  }
});

const COMPANIONS = ["opencode", "gemini", "claude", "cursor"];
const THIN_SKILLS = ["adversarial-review", "cancel", "result", "review", "setup", "status", "transfer"];

function readSkill(name, skill) {
  return fs.readFileSync(path.join(root, `plugins/${name}/skills/${name}-${skill}/SKILL.md`), "utf8");
}

test("delegate skills require a clean worktree and cancel blocked jobs before restarting", () => {
  for (const name of COMPANIONS) {
    const body = readSkill(name, "delegate");
    assert.match(body, /Preflight: run `git status --short`/, name);
    assert.match(body, new RegExp(`${name}-companion\\.mjs" cancel <job-id>`), name);
  }
});

test("delegate polling uses the companion wait instead of non-portable shell utilities", () => {
  for (const name of ["opencode", "gemini", "cursor"]) {
    const body = readSkill(name, "delegate");
    assert.doesNotMatch(body, /timeout 600/, name);
    assert.match(body, /status <job-id> --wait --timeout-ms 600000 --json/, name);
  }
});

test("claude delegate does not treat output as a liveness signal or call launches background jobs", () => {
  const body = readSkill("claude", "delegate");
  assert.doesNotMatch(body, /fresh background job/);
  assert.doesNotMatch(body, /new output OR worktree changed/);
  assert.match(body, /3 consecutive ticks/);
});

test("rescue surfaces pass task text as one argument after -- and report failures", () => {
  for (const name of COMPANIONS) {
    for (const skill of ["cli-runtime", "rescue"]) {
      const body = readSkill(name, skill);
      assert.doesNotMatch(body, /task "<raw arguments>"/, `${name}-${skill}`);
      assert.match(body, new RegExp(`${name}-companion\\.mjs" task <flags> -- "<task text>"`), `${name}-${skill}`);
    }
    assert.doesNotMatch(readSkill(name, "rescue"), /return nothing/, name);
    assert.match(readSkill(name, "rescue"), new RegExp(`${name}-setup`), name);
  }
});

test("thin skills do not paste raw user arguments into the shell command", () => {
  for (const name of COMPANIONS) {
    for (const skill of THIN_SKILLS) {
      const body = readSkill(name, skill);
      assert.doesNotMatch(body, /\.mjs" [a-z-]+ \$ARGUMENTS/, `${name}-${skill}`);
      assert.match(body, /`\$ARGUMENTS`/, `${name}-${skill}`);
      assert.match(body, /\.mjs" [a-z-]+ <arguments>/, `${name}-${skill}`);
    }
  }
});

test("user-invocable skill descriptions state when to use them", () => {
  for (const name of COMPANIONS) {
    for (const skill of [...THIN_SKILLS, "rescue", "delegate"]) {
      const description = readSkill(name, skill).match(/^description:\s*(.*)$/m)?.[1] ?? "";
      assert.match(description, /Use (ONLY )?when/, `${name}-${skill}`);
    }
  }
});

test("skills carry no host-specific or contradictory backend wording", () => {
  for (const name of ["opencode", "gemini"]) {
    for (const skill of ["cli-runtime", "prompting"]) {
      const body = readSkill(name, skill);
      assert.doesNotMatch(body, /Claude-side|Claude Code/, `${name}-${skill}`);
    }
  }
  assert.doesNotMatch(readSkill("cursor", "prompting"), /--bg/);
  assert.doesNotMatch(readSkill("gemini", "prompting"), /no `--effort` flag/);
  assert.doesNotMatch(readSkill("opencode", "delegate"), /workspace-write sandbox/);
  assert.match(readSkill("gemini", "cli-runtime"), /agy --continue/);
});

test("plugin-root lookup names the Codex and Claude plugin caches", () => {
  for (const name of COMPANIONS) {
    assert.match(readSkill(name, "review"), /~\/\.codex\/plugins\/cache/, name);
  }
});
