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

for (const companion of ["opencode", "gemini", "cursor", "antigravity"]) {
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
  for (const name of ["opencode", "gemini", "cursor", "antigravity"]) {
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

test("delegate skills exist for all five companions", () => {
  for (const name of ["opencode", "gemini", "claude", "cursor", "antigravity"]) {
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
  for (const name of ["opencode", "gemini", "cursor", "antigravity"]) {
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

const COMPANIONS = ["opencode", "gemini", "claude", "cursor", "antigravity"];
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
  for (const name of ["opencode", "gemini", "cursor", "antigravity"]) {
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

test("rescue surfaces pipe task text on stdin and report failures", () => {
  for (const name of COMPANIONS) {
    for (const skill of ["cli-runtime", "rescue", "delegate"]) {
      const body = readSkill(name, skill);
      assert.doesNotMatch(body, /task "<raw arguments>"/, `${name}-${skill}`);
      // argv is readable by other local users, so task text never goes in it.
      assert.doesNotMatch(body, /-- "<task text>"/, `${name}-${skill}`);
      assert.doesNotMatch(body, /"\$\(cat <</, `${name}-${skill}`);
      assert.match(body, new RegExp(`${name}-companion\\.mjs" task [^\\n]*<<\x27(TASK_TEXT|CHUNK_PROMPT)\x27`), `${name}-${skill}`);
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
      // adversarial-review splits flags from focus text, which goes on stdin
      assert.match(body, skill === "adversarial-review" ? /\.mjs" adversarial-review <flags>/ : /\.mjs" [a-z-]+ <arguments>/, `${name}-${skill}`);
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

test("antigravity commands use the antigravity namespace and forward effort", () => {
  const base = path.join(root, "plugins/antigravity");
  const rescue = fs.readFileSync(path.join(base, "commands/rescue.md"), "utf8");
  assert.match(rescue, /antigravity:antigravity-rescue/);
  assert.match(rescue, /Skill\(antigravity:rescue\)/);
  const delegate = fs.readFileSync(path.join(base, "commands/delegate.md"), "utf8");
  assert.match(delegate, /antigravity:antigravity-delegate/);
  for (const file of ["commands/rescue.md", "agents/antigravity-rescue.md", "skills/antigravity-rescue/SKILL.md"]) {
    const body = fs.readFileSync(path.join(base, file), "utf8");
    assert.match(body, /--effort/, file);
    assert.match(body, /--model/, file);
    assert.match(body, /--write/, file);
  }
});

test("antigravity skills resolve the companion in the documented order", () => {
  const skillsDir = path.join(root, "plugins/antigravity/skills");
  const names = fs.readdirSync(skillsDir).filter((name) => name !== "antigravity-prompting");
  assert.equal(names.length, 10);
  for (const name of names) {
    const body = fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
    const start = body.indexOf("Resolve `<plugin-root>`");
    assert.ok(start >= 0, name);
    const block = body.slice(start).split(/\r?\n/);
    const entries = block.filter((line) => /^\d+\. /.test(line)).slice(0, 6);
    assert.match(entries[0], /^1\. `\$CLAUDE_PLUGIN_ROOT`/, name);
    assert.match(entries[1], /^2\. `\$PLUGIN_ROOT`/, name);
    assert.match(entries[2], /the folder that holds this SKILL\.md/, name);
    assert.match(entries[2], /<this skill's folder>\/\.\.\/antigravity-cli-runtime/, name);
    assert.match(entries[3], /~\/\.cursor\/plugins\/local\/antigravity/, name);
    assert.match(entries[4], /~\/\.config\/opencode\/plugins\/antigravity/, name);
    assert.match(entries[5], /plugin cache/, name);
    const stop = block.find((line) => line.startsWith("If none exist,"));
    assert.ok(stop, name);
    assert.match(stop, /antigravity-cli-runtime/, name);
  }
});

test("plugin-root lookup names the Codex and Claude plugin caches", () => {
  for (const name of COMPANIONS) {
    assert.match(readSkill(name, "review"), /~\/\.codex\/plugins\/cache/, name);
  }
});

test("antigravity markdown never names the Cursor binary", () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  })(path.join(root, "plugins/antigravity"));
  for (const file of files) {
    const body = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(body, /`agent` CLI|agent login|agent status/, file);
  }
});

test("rescue agents and commands pipe task text on stdin", () => {
  for (const name of COMPANIONS) {
    for (const rel of [`agents/${name}-rescue.md`, "commands/rescue.md"]) {
      const file = path.join(root, `plugins/${name}`, rel);
      if (!fs.existsSync(file)) continue;
      const body = fs.readFileSync(file, "utf8");
      if (!/companion\.mjs" task\b/.test(body)) continue;
      assert.match(body, /<<'TASK_TEXT'/, `${name} ${rel}`);
      assert.match(body, /never as an argument/, `${name} ${rel}`);
    }
  }
});

test("adversarial-review focus text and rescue agents never go in argv", () => {
  for (const name of COMPANIONS) {
    const docs = [readSkill(name, "adversarial-review")];
    const command = path.join(root, `plugins/${name}/commands/adversarial-review.md`);
    if (fs.existsSync(command)) docs.push(fs.readFileSync(command, "utf8"));
    for (const body of docs) {
      assert.doesNotMatch(body, /adversarial-review "\$ARGUMENTS"/, name);
      assert.doesNotMatch(body, /focus text last, as one quoted argument/, name);
      assert.match(body, /adversarial-review <flags> --focus-stdin <<'FOCUS_TEXT'/, name);
    }
    const agent = fs.readFileSync(path.join(root, `plugins/${name}/agents/${name}-rescue.md`), "utf8");
    assert.doesNotMatch(agent, /then `--`, then the task text/, name);
  }
});

test("every companion reads adversarial focus from stdin only with --focus-stdin", () => {
  for (const name of COMPANIONS) {
    const source = fs.readFileSync(path.join(root, `plugins/${name}/scripts/${name}-companion.mjs`), "utf8");
    assert.match(source, /"focus-stdin"/, name);
    assert.match(source, /options\["focus-stdin"\]/, name);
  }
});
