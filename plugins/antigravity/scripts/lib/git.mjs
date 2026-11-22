import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
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

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  // lstat (not stat) so we see symlinks as symlinks instead of following them.
  // An untracked symlink to e.g. ~/.ssh/id_rsa would otherwise have its target
  // contents inlined into the review prompt.
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  }
  if (stat.isSymbolicLink()) {
    let target = "";
    try {
      target = fs.readlinkSync(absolutePath);
    } catch {
      target = "<unreadable>";
    }
    return `### ${relativePath}\n(skipped: symlink -> ${target}; symlink targets are never followed for untracked files)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (!stat.isFile()) {
    return `### ${relativePath}\n(skipped: not a regular file)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  // Open with O_NOFOLLOW so a TOCTOU swap to a symlink between lstat and
  // read still can't redirect the read off-tree.
  let fd;
  try {
    fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  }
  let buffer;
  try {
    buffer = fs.readFileSync(fd);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  } finally {
    fs.closeSync(fd);
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
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

/** Collects sections into a byte budget; once it is used up, later items are only named. */
function createEvidence(maxBytes) {
  const parts = [];
  const notShown = [];
  let left = maxBytes;
  let truncated = false;
  return {
    get left() {
      return truncated ? 0 : left;
    },
    add(text) {
      if (truncated) return false;
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes <= left) {
        parts.push(text);
        left -= bytes;
        return true;
      }
      parts.push(cutUtf8(text, left));
      left = 0;
      truncated = true;
      return false;
    },
    cut() {
      truncated = true;
    },
    skip(name) {
      truncated = true;
      notShown.push(name);
    },
    get truncated() {
      return truncated;
    },
    content() {
      if (!truncated) return parts.join("");
      const names = notShown.slice(0, NOT_SHOWN_NAME_LIMIT).join(", ");
      const extra = notShown.length > NOT_SHOWN_NAME_LIMIT ? ` and ${notShown.length - NOT_SHOWN_NAME_LIMIT} more` : "";
      return `${parts.join("")}\n\n(The evidence was cut at ${maxBytes} bytes; the rest of this change is not shown.${names ? ` Files not shown: ${names}${extra}.` : ""})`;
    }
  };
}

/** One diff per file, in evidence order; a change identical to one already shown (same blob hashes) is only named. */
function addDiffs(evidence, cwd, title, diffArgs, files) {
  evidence.add(`## ${title}\n\n`);
  if (!files.length) evidence.add("(none)\n\n");
  const seen = new Map();
  for (const file of orderFiles(files)) {
    if (evidence.truncated) {
      evidence.skip(file);
      continue;
    }
    const { text, more } = gitCapped(cwd, ["diff", ...diffArgs, "--", file], evidence.left);
    const key = text.match(/^index ([0-9a-f]+\.\.[0-9a-f]+)/m)?.[1];
    if (key && !more && seen.has(key) && !/^index [0-9a-f]+\.\.0+\b/m.test(text)) {
      evidence.add(`(${file}: identical to ${seen.get(key)}, not repeated)\n`);
      continue;
    }
    if (key && !seen.has(key)) seen.set(key, file);
    evidence.add(text.endsWith("\n") || !text ? text : `${text}\n`);
    if (more) evidence.cut();
  }
  evidence.add("\n");
}

function addUntracked(evidence, cwd, files) {
  evidence.add("## Untracked Files\n\n");
  if (!files.length) evidence.add("(none)\n");
  const seen = new Map();
  for (const file of orderFiles(files)) {
    // Stop reading once the budget is used: the rest are only named.
    if (evidence.truncated) {
      evidence.skip(file);
      continue;
    }
    const body = formatUntrackedFile(cwd, file);
    const hash = createHash("sha256").update(body.slice(body.indexOf("\n") + 1)).digest("hex");
    if (body.includes("\n```\n") && seen.has(hash)) {
      evidence.add(`### ${file}\n(identical to ${seen.get(hash)}, not repeated)\n\n`);
      continue;
    }
    if (!seen.has(hash)) seen.set(hash, file);
    evidence.add(`${body}\n\n`);
  }
}

function collectWorkingTreeContext(cwd, state, maxBytes) {
  const evidence = createEvidence(maxBytes);
  const status = gitCapped(cwd, ["status", "--short", "--untracked-files=all"], evidence.left);
  evidence.add(`${formatSection("Git Status", status.text)}\n`);
  if (status.more) evidence.cut();
  const diffArgs = ["--binary", "--no-ext-diff", "--submodule=diff"];
  addDiffs(evidence, cwd, "Staged Diff", ["--cached", ...diffArgs], listPaths(cwd, ["diff", "--cached", "--name-only"]));
  addDiffs(evidence, cwd, "Unstaged Diff", diffArgs, listPaths(cwd, ["diff", "--name-only"]));
  addUntracked(evidence, cwd, listPaths(cwd, ["ls-files", "--others", "--exclude-standard"]));
  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: evidence.content(),
    truncated: evidence.truncated,
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
  addDiffs(evidence, cwd, "Branch Diff", ["--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange], changedFiles);
  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: evidence.content(),
    truncated: evidence.truncated,
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
    inputMode: details.truncated ? "truncated-diff" : "inline-diff",
    collectionGuidance: buildCollectionGuidance(details.truncated, maxBytes),
    ...details
  };
}
