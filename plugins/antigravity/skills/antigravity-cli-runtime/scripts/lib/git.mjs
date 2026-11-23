import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isProbablyText, isWithin } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
// A review has no tools, so its prompt is all the evidence it gets: the diff and new files, up to this size.
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const NOT_SHOWN_NAME_LIMIT = 100;

// shell: false, so a ref such as `topic&docs` reaches git intact on Windows, where runCommand defaults to a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, shell: false, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, shell: false, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

/** An untracked file's contents as they are in the file, or the note that stands in for a file that is not read. */
function readUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  // lstat (not stat) so we see symlinks as symlinks instead of following them.
  // An untracked symlink to e.g. ~/.ssh/id_rsa would otherwise have its target
  // contents inlined into the review prompt.
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return { skipped: `(skipped: unreadable file)` };
  }
  if (stat.isSymbolicLink()) {
    let target = "";
    try {
      target = fs.readlinkSync(absolutePath);
    } catch {
      target = "<unreadable>";
    }
    return { skipped: `(skipped: symlink -> ${target}; symlink targets are never followed for untracked files)` };
  }
  if (stat.isDirectory()) {
    return { skipped: `(skipped: directory)` };
  }
  if (!stat.isFile()) {
    return { skipped: `(skipped: not a regular file)` };
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return { skipped: `(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)` };
  }

  // Open with O_NOFOLLOW so a TOCTOU swap to a symlink between lstat and
  // read still can't redirect the read off-tree.
  let fd;
  try {
    fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return { skipped: `(skipped: unreadable file)` };
  }
  let buffer;
  try {
    buffer = fs.readFileSync(fd);
  } catch {
    return { skipped: `(skipped: unreadable file)` };
  } finally {
    fs.closeSync(fd);
  }
  if (!isProbablyText(buffer)) {
    return { skipped: `(skipped: binary file)` };
  }

  return { text: buffer.toString("utf8") };
}

/** Cut a string to at most maxBytes of UTF-8 without splitting a character. */
function cutUtf8(text, maxBytes) {
  return Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8").replace(/\uFFFD$/, "");
}

/** Run git and keep at most `limit` bytes of its output; `more` says output was cut (git is stopped there). */
function gitCapped(cwd, args, limit) {
  const result = git(cwd, ["--literal-pathspecs", ...args], { maxBuffer: Math.max(0, limit) + 1 });
  const overflow = /** @type {NodeJS.ErrnoException} */ (result.error)?.code === "ENOBUFS";
  if (result.error && !overflow) throw result.error;
  if (!overflow && result.status !== 0) throw new Error(formatCommandFailure(result));
  const more = overflow || Buffer.byteLength(result.stdout, "utf8") > limit;
  return { text: more ? cutUtf8(result.stdout, limit) : result.stdout, more };
}

/**
 * Changed files with rename pairs kept: `-M --name-status -z` gives `R<score>\0old\0new` for a rename or copy
 * and `<status>\0path` otherwise. A rename's diff needs both paths, or git shows a full addition.
 */
function listChanges(cwd, args) {
  const fields = gitChecked(cwd, ["-c", "core.quotePath=false", ...args, "-M", "--name-status", "-z"]).stdout.split("\0");
  const changes = [];
  for (let index = 0; index < fields.length && fields[index]; ) {
    const status = fields[index];
    if (/^[RC]/.test(status)) {
      changes.push({ file: fields[index + 2], paths: [fields[index + 1], fields[index + 2]] });
      index += 3;
    } else {
      changes.push({ file: fields[index + 1], paths: [fields[index + 1]] });
      index += 2;
    }
  }
  return changes;
}

function listPaths(cwd, args) {
  return gitChecked(cwd, ["-c", "core.quotePath=false", ...args, "-z"]).stdout.split("\0").filter(Boolean);
}

/** Most useful first: source, then tests, then generated or vendored files; shallower paths before deeper copies. */
function evidenceRank(file) {
  if (/(^|\/)(dist|build|out|generated|vendor|node_modules)\//.test(file) || /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.min\.[^/]+$/.test(file)) return 2;
  if (/(^|\/)(tests?|__tests__|specs?|fixtures)\//.test(file) || /\.(test|spec)\.[^/]+$/.test(file)) return 1;
  return 0;
}

function orderFiles(files) {
  return [...files].sort((a, b) => evidenceRank(a) - evidenceRank(b) || a.split("/").length - b.split("/").length || a.localeCompare(b));
}

function capNames(label, files) {
  const names = files.slice(0, NOT_SHOWN_NAME_LIMIT).join(", ").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const extra = files.length > NOT_SHOWN_NAME_LIMIT ? ` and ${files.length - NOT_SHOWN_NAME_LIMIT} more` : "";
  return names ? ` ${label}: ${names}${extra}.` : "";
}

/**
 * The files a cut notice names, each list capped: those shown only in part (the cut fell inside one, or one of
 * its diffs was shown and another left out), then those left out entirely. Control characters are escaped, so a
 * file name cannot add a line.
 */
export function formatNotShown(notShown, partlyShown = []) {
  return capNames("Files shown only in part", partlyShown) + capNames("Files not shown", notShown);
}

/**
 * What follows `Incomplete review: ` (a task's `Incomplete task: `) in a result, by cause: the budget cut the evidence, the prompt only named
 * some files as skipped, or both. A skipped file is named once, under its own cause: as not shown, or as shown
 * only in part when another part of the same path was shown (a staged deletion of a file left untracked).
 */
export function formatIncomplete(evidence, { cutLabel = "the evidence was cut", rest = "the rest of this change was not reviewed" } = {}) {
  const skipped = new Set(evidence.filesSkipped ?? []);
  const partly = new Set(evidence.filesPartlyShown ?? []);
  const reasons = "(too large, binary, a link or unreadable)";
  const whole = [...skipped].filter((file) => !partly.has(file));
  const copies = [...skipped].filter((file) => partly.has(file));
  const copyLabel = `shown only in part, the untracked copy skipped ${reasons}`;
  if (!evidence.truncated) {
    return (capNames(`some files were not shown ${reasons}`, whole) + capNames(`${whole.length ? "Files" : "some files were"} ${copyLabel}`, copies)).trimStart();
  }
  const cut = (files) => (files ?? []).filter((file) => !skipped.has(file));
  return `${cutLabel} at ${evidence.maxBytes} bytes, so ${rest}.${formatNotShown(cut(evidence.filesNotShown), cut(evidence.filesPartlyShown))}${capNames(`Files not shown for another reason ${reasons}`, whole)}${capNames(`Files ${copyLabel}`, copies)}`;
}

/** Collects sections into a byte budget; once it is used up, later items are only named. */
function createEvidence(maxBytes, rest = "the rest of this change is not shown") {
  const parts = [];
  // Sets: a file that is both staged and unstaged is named once, and never as both shown in part and not shown.
  const shown = new Set();
  const partlyShown = new Set();
  const notShown = new Set();
  const skipped = new Set();
  let left = maxBytes;
  let truncated = false;
  return {
    get left() {
      return truncated ? 0 : left;
    },
    /**
     * Adds evidence. With a file name, the text is that file's content and decides how the file is recorded:
     * shown when all of it fits, shown only in part when some of it fits, not shown when none does. `more` says
     * the text was already cut while it was read. Headings, fences and blank lines go through `format`.
     */
    add(text, file, more = false) {
      if (truncated) {
        if (file !== undefined) this.skip(file);
        return;
      }
      const bytes = Buffer.byteLength(text, "utf8");
      const whole = bytes <= left && !more;
      const piece = bytes <= left ? text : cutUtf8(text, left);
      parts.push(piece);
      left = Math.max(0, left - bytes);
      if (!whole) truncated = true;
      if (file === undefined) return;
      if (!whole && !piece) return this.skip(file);
      shown.add(file);
      if (!whole) partlyShown.add(file);
    },
    /** A reference to another file is one unit: shown when all of it fits, otherwise left out and the file skipped. */
    unit(text, file) {
      if (truncated || Buffer.byteLength(text, "utf8") > left) return this.skip(file);
      this.add(text, file);
    },
    /** Headings and separators use the budget, but one that does not fit is not a cut of the change. */
    format(text) {
      if (truncated) return;
      const bytes = Buffer.byteLength(text, "utf8");
      parts.push(bytes <= left ? text : cutUtf8(text, left));
      left = Math.max(0, left - bytes);
    },
    /** A file the prompt only names (too large, binary, a symlink): its contents are not shown, whatever the budget. */
    omit(name) {
      // A path with another part already shown (a staged deletion of a file left untracked) is shown only in part.
      (shown.has(name) ? partlyShown : notShown).add(name);
      skipped.add(name);
    },
    cut() {
      truncated = true;
    },
    skip(name) {
      truncated = true;
      (shown.has(name) ? partlyShown : notShown).add(name);
    },
    get notShown() {
      return [...notShown];
    },
    get partlyShown() {
      return [...partlyShown];
    },
    /** The part of `notShown` that the prompt names as skipped, whatever the budget. */
    get skipped() {
      return [...skipped];
    },
    get truncated() {
      return truncated;
    },
    content() {
      if (!truncated) return parts.join("");
      return `${parts.join("")}\n\n(The evidence was cut at ${maxBytes} bytes; ${rest}.${formatNotShown([...notShown], [...partlyShown])})`;
    }
  };
}

/**
 * One diff per file, in evidence order. A change whose header (blob hashes and any mode, rename or copy
 * lines) equals one already shown is only named; a different mode change keeps its own diff.
 */
function addDiffs(evidence, cwd, title, diffArgs, changes) {
  evidence.format(`## ${title}\n\n`);
  if (!changes.length) evidence.format("(none)\n\n");
  const byFile = new Map(changes.map((change) => [change.file, change]));
  const seen = new Map();
  for (const file of orderFiles([...byFile.keys()])) {
    // `left` is 0 once the evidence is cut, and also when the last file used exactly the rest of the budget.
    if (!evidence.left) {
      evidence.skip(file);
      continue;
    }
    const { text, more } = gitCapped(cwd, ["diff", "-M", ...diffArgs, "--", ...byFile.get(file).paths], evidence.left);
    const header = text.split("\n").slice(1).filter((line) => /^(index|old mode|new mode|new file mode|deleted file mode|similarity index|rename from|rename to|copy from|copy to) /.test(line));
    const key = header.some((line) => line.startsWith("index ")) ? header.join("\n") : null;
    const deletion = /^index [0-9a-f]+\.\.0+\b/m.test(text);
    if (key && !more && !deletion && seen.has(key)) {
      evidence.unit(`(${file}: identical to ${seen.get(key)}, not repeated)`, file);
      evidence.format("\n");
      continue;
    }
    if (key && !seen.has(key)) seen.set(key, file);
    evidence.add(text, file, more);
    if (text && !text.endsWith("\n")) evidence.format("\n");
  }
  evidence.format("\n");
}

function addUntracked(evidence, cwd, files) {
  evidence.format("## Untracked Files\n\n");
  if (!files.length) evidence.format("(none)\n");
  const seen = new Map();
  for (const file of orderFiles(files)) {
    // Stop reading once the budget is used: the rest are only named.
    if (!evidence.left) {
      evidence.skip(file);
      continue;
    }
    const { skipped, text } = readUntrackedFile(cwd, file);
    const heading = `### ${file}\n`;
    if (skipped) {
      evidence.add(`${heading}${skipped}`);
      evidence.format("\n\n");
      evidence.omit(file);
      continue;
    }
    const hash = createHash("sha256").update(text).digest("hex");
    if (seen.has(hash)) {
      evidence.unit(`${heading}(identical to ${seen.get(hash)}, not repeated)`, file);
      evidence.format("\n\n");
      continue;
    }
    seen.set(hash, file);
    // Only the contents, untrimmed, count as the file being shown; the heading and the fences do not.
    evidence.format(`${heading}\`\`\`\n`);
    evidence.add(text, file);
    evidence.format(`${text.endsWith("\n") ? "" : "\n"}\`\`\`\n\n`);
  }
}

function collectWorkingTreeContext(cwd, state, maxBytes) {
  const evidence = createEvidence(maxBytes);
  const status = gitCapped(cwd, ["status", "--short", "--untracked-files=all"], evidence.left);
  evidence.add(`${formatSection("Git Status", status.text)}\n`);
  if (status.more) evidence.cut();
  const diffArgs = ["--binary", "--no-ext-diff", "--submodule=diff"];
  addDiffs(evidence, cwd, "Staged Diff", ["--cached", ...diffArgs], listChanges(cwd, ["diff", "--cached"]));
  addDiffs(evidence, cwd, "Unstaged Diff", diffArgs, listChanges(cwd, ["diff"]));
  addUntracked(evidence, cwd, listPaths(cwd, ["ls-files", "--others", "--exclude-standard"]));
  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: evidence.content(),
    truncated: evidence.truncated,
    notShown: evidence.notShown,
    partlyShown: evidence.partlyShown,
    skipped: evidence.skipped,
    changedFiles: listUniqueFiles(state.staged, state.unstaged, state.untracked)
  };
}

function collectBranchContext(cwd, baseRef, maxBytes) {
  const comparison = buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = listPaths(cwd, ["diff", "--name-only", comparison.commitRange]);
  const evidence = createEvidence(maxBytes);
  for (const [title, args] of [["Commit Log", ["log", "--oneline", "--decorate", comparison.commitRange]], ["Diff Stat", ["diff", "--stat", comparison.commitRange]]]) {
    const { text, more } = gitCapped(cwd, args, evidence.left);
    evidence.add(`${formatSection(title, text)}\n`);
    if (more) evidence.cut();
  }
  addDiffs(evidence, cwd, "Branch Diff", ["--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange], listChanges(cwd, ["diff", comparison.commitRange]));
  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: evidence.content(),
    truncated: evidence.truncated,
    notShown: evidence.notShown,
    partlyShown: evidence.partlyShown,
    skipped: evidence.skipped,
    changedFiles,
    comparison
  };
}

function buildCollectionGuidance(truncated, maxBytes) {
  const base = "You have no tools in this review: you cannot read files, list folders, search or run commands. Answer only from the repository context below.";
  return truncated
    ? `${base} The change is larger than ${maxBytes} bytes, so the context was cut; say in the summary that the rest was not reviewed.`
    : base;
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  // The budget is enforced while collecting: git output and untracked files are read only up to it.
  const details = target.mode === "working-tree"
    ? collectWorkingTreeContext(repoRoot, getWorkingTreeState(repoRoot), maxBytes)
    : collectBranchContext(repoRoot, target.baseRef, maxBytes);
  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    maxBytes,
    inputMode: details.truncated ? "truncated-diff" : "inline-diff",
    collectionGuidance: buildCollectionGuidance(details.truncated, maxBytes),
    ...details
  };
}

/**
 * The real path of the file an open descriptor holds. On Linux, the kernel's own record of it; elsewhere, the
 * real path of `real` now, accepted only when it is the same file (device and inode) as the descriptor.
 */
function openedRealPath(fd, real, platform) {
  if (platform === "linux") return fs.readlinkSync(`/proc/self/fd/${fd}`);
  // Accepted window (see the ACP transport note): a folder swapped between this realpath and the open goes unseen; only a hostile local process could do it, and it already has the user's file access.
  const now = fs.realpathSync.native(real);
  // BigInt: an inode past 2^53 would round to another file's as a Number.
  const opened = fs.fstatSync(fd, { bigint: true });
  const named = fs.statSync(now, { bigint: true });
  if (opened.dev !== named.dev || opened.ino !== named.ino) throw Object.assign(new Error("changed while it was opened"), { code: "ECHANGED" });
  return now;
}

/**
 * A read-only task's --include files, under the review's budget. Each entry is { name, real }: the caller has
 * already checked that `real` (links resolved) is a regular file inside `options.root`, the workspace's real
 * path. A folder on the way can still be swapped for a link before the open, so the opened file is checked
 * again before a byte is read, and anything outside the workspace fails the whole run.
 */
export function collectIncludedFiles(files, options = {}) {
  const platform = options.platform ?? process.platform;
  const maxBytes = normalizeMaxInlineDiffBytes(options.maxBytes);
  const evidence = createEvidence(maxBytes, "the rest of the included files is not shown");
  evidence.format("## Included Files\n\n");
  for (const { name, real } of files) {
    if (!evidence.left) {
      evidence.skip(name);
      continue;
    }
    const heading = `### ${name}\n`;
    let read;
    try {
      // O_NOFOLLOW: a swap of the checked file for a link before this open cannot redirect the read.
      // O_NONBLOCK: a FIFO swapped in after the check must not block the open; fstat below rejects it.
      const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
      try {
        let opened;
        try {
          opened = openedRealPath(fd, real, platform);
        } catch (error) {
          throw Object.assign(new Error(`--include ${name} could not be confirmed inside the workspace after it was opened (${error.code ?? error.message}), so nothing was run.`), { refused: true });
        }
        if (!isWithin(opened, options.root)) {
          throw Object.assign(new Error(`--include ${name} is outside the workspace (${options.root}) once opened: a folder on its path changed after the check, so nothing was run.`), { refused: true });
        }
        if (!fs.fstatSync(fd).isFile()) throw new Error("not a regular file");
        // At most one byte past the budget: enough to know the file did not fit, never a huge file whole.
        // A read can return fewer bytes than asked, so read until the buffer is full or the file ends.
        const buffer = Buffer.alloc(evidence.left + 1);
        let length = 0;
        for (let count; length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, length)) > 0; ) length += count;
        read = { buffer: buffer.subarray(0, length), more: length > evidence.left };
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error?.refused) throw error;
      read = { skipped: "(skipped: unreadable file)" };
    }
    if (!read.skipped && !isProbablyText(read.buffer)) read = { skipped: "(skipped: binary file)" };
    if (read.skipped) {
      evidence.add(`${heading}${read.skipped}`);
      evidence.format("\n\n");
      evidence.omit(name);
      continue;
    }
    const text = read.buffer.toString("utf8");
    evidence.format(`${heading}\`\`\`\n`);
    evidence.add(text, name, read.more);
    evidence.format(`${text.endsWith("\n") ? "" : "\n"}\`\`\`\n\n`);
  }
  return {
    content: evidence.content(),
    truncated: evidence.truncated,
    notShown: evidence.notShown,
    partlyShown: evidence.partlyShown,
    skipped: evidence.skipped,
    maxBytes
  };
}
