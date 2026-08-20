import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "CLAUDE_COMPANION_TRANSCRIPT_PATH";
export const PACKED_TRANSCRIPT_LIMIT = 100000;

export function claudeProjectDirName(workspaceRoot) {
  // Claude replaces every non-alphanumeric (including `.`) with `-`.
  return path.resolve(workspaceRoot).replace(/[^a-zA-Z0-9]/g, "-");
}

function cursorProjectDirName(workspaceRoot) {
  return path
    .resolve(workspaceRoot)
    .replace(/\\/g, "/")
    .replace(/:/g, "")
    .replace(/\//g, "-");
}

function resolveUserPath(cwd, value, home) {
  const raw = String(value);
  if (raw === "~") {
    return home;
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(home, raw.slice(2));
  }
  return ensureAbsolutePath(cwd, raw);
}

function getMtimeMs(filePath, options) {
  if (typeof options.nowMtime === "function") {
    return options.nowMtime(filePath);
  }
  return fs.statSync(filePath).mtimeMs;
}

function newestFile(files, options) {
  if (files.length === 0) {
    return null;
  }
  let best = files[0];
  let bestMtime = getMtimeMs(best, options);
  for (let i = 1; i < files.length; i += 1) {
    const candidate = files[i];
    const mtime = getMtimeMs(candidate, options);
    if (mtime >= bestMtime) {
      best = candidate;
      bestMtime = mtime;
    }
  }
  return best;
}

function listTopLevelJsonl(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(dir, entry.name));
}

function listFilesRecursive(dir, predicate) {
  const out = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && predicate(entry.name, full)) {
        out.push(full);
      }
    }
  }
  return out;
}

function normalizePathForCompare(value) {
  let normalized;
  try {
    normalized = path.resolve(value).replace(/\\/g, "/");
  } catch {
    normalized = String(value).replace(/\\/g, "/");
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function codexSessionMatchesCwd(filePath, cwd) {
  try {
    const firstLine = fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0];
    if (!firstLine) {
      return false;
    }
    const parsed = JSON.parse(firstLine);
    const sessionCwd = parsed?.payload?.cwd ?? parsed?.cwd;
    if (!sessionCwd) {
      return false;
    }
    return normalizePathForCompare(sessionCwd) === normalizePathForCompare(cwd);
  } catch {
    return false;
  }
}

function findClaudeFiles(cwd, home) {
  const dir = path.join(home, ".claude", "projects", claudeProjectDirName(cwd));
  return listTopLevelJsonl(dir);
}

function findCodexFiles(cwd, home, env) {
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const sessionsDir = path.join(codexHome, "sessions");
  const files = listFilesRecursive(
    sessionsDir,
    (name) => name.startsWith("rollout-") && name.endsWith(".jsonl")
  );
  const matching = files.filter((filePath) => codexSessionMatchesCwd(filePath, cwd));
  return matching.length > 0 ? matching : files;
}

function findCursorFiles(cwd, home) {
  const dir = path.join(
    home,
    ".cursor",
    "projects",
    cursorProjectDirName(cwd),
    "agent-transcripts"
  );
  return listFilesRecursive(dir, (name) => name.endsWith(".jsonl"));
}

function requireJsonlPath(sourcePath) {
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Transfer source must be a JSONL file: ${sourcePath}`);
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Transfer source not found: ${sourcePath}`);
  }
  return sourcePath;
}

export function resolveTransferSource(cwd, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();

  const explicit = options.source || env[TRANSCRIPT_PATH_ENV];
  if (explicit) {
    const sourcePath = requireJsonlPath(resolveUserPath(cwd, explicit, home));
    return { path: sourcePath, host: "explicit" };
  }

  const claudeFiles = findClaudeFiles(cwd, home);
  const codexFiles = findCodexFiles(cwd, home, env);
  const cursorFiles = findCursorFiles(cwd, home);

  let selected = null;
  let host = null;
  if (codexFiles.length > 0) {
    selected = newestFile(codexFiles, options);
    host = "codex";
  } else if (cursorFiles.length > 0) {
    selected = newestFile(cursorFiles, options);
    host = "cursor";
  } else if (claudeFiles.length > 0) {
    selected = newestFile(claudeFiles, options);
    host = "claude";
  }

  if (!selected) {
    const searched = [
      path.join(home, ".claude", "projects", claudeProjectDirName(cwd)),
      path.join(env.CODEX_HOME || path.join(home, ".codex"), "sessions"),
      path.join(home, ".cursor", "projects", cursorProjectDirName(cwd), "agent-transcripts")
    ];
    throw new Error(
      `Could not auto-detect a transcript for ${cwd}. Searched:\n- ${searched.join("\n- ")}\nRetry with --source <path-to-jsonl>.`
    );
  }

  return { path: selected, host };
}

function extractText(content) {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") {
      continue;
    }
    if (typeof block.text === "string") {
      const typ = block.type;
      if (
        !typ ||
        typ === "text" ||
        typ === "input_text" ||
        typ === "output_text" ||
        typ === "input_text_delta" ||
        typ === "output_text_delta"
      ) {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n");
}

function pushMessage(messages, role, text) {
  const cleaned = String(text ?? "").trim();
  if (!cleaned) {
    return;
  }
  const normalized = String(role || "").toLowerCase();
  if (normalized !== "user" && normalized !== "assistant") {
    return;
  }
  messages.push({ role: normalized, text: cleaned });
}

function parseClaudeLine(parsed, messages) {
  const type = parsed.type;
  if (type && type !== "user" && type !== "assistant" && type !== "message") {
    return;
  }
  const message = parsed.message && typeof parsed.message === "object" ? parsed.message : parsed;
  const role = message.role || parsed.role || type;
  pushMessage(messages, role, extractText(message.content ?? parsed.content));
}

function parseCodexLine(parsed, messages) {
  if (parsed.type !== "response_item" && parsed.type !== "item") {
    return;
  }
  const payload = parsed.payload ?? parsed.item ?? parsed.response_item ?? parsed;
  if (!payload || typeof payload !== "object") {
    return;
  }
  if (payload.type && payload.type !== "message") {
    return;
  }
  pushMessage(messages, payload.role, extractText(payload.content));
}

function parseCursorLine(parsed, messages) {
  if (!parsed.role) {
    return;
  }
  const message = parsed.message;
  const content =
    message && typeof message === "object" ? message.content ?? message.text : parsed.content;
  pushMessage(messages, parsed.role, extractText(content));
}

export function parseTranscriptJsonl(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    if (parsed.type === "response_item" || parsed.type === "item" || parsed.payload?.cwd) {
      parseCodexLine(parsed, messages);
      continue;
    }
    if (parsed.type === "user" || parsed.type === "assistant" || parsed.message?.role) {
      parseClaudeLine(parsed, messages);
      continue;
    }
    if (parsed.role && parsed.message != null) {
      parseCursorLine(parsed, messages);
      continue;
    }
    parseClaudeLine(parsed, messages);
    parseCodexLine(parsed, messages);
    parseCursorLine(parsed, messages);
  }
  return messages;
}

function formatRole(role) {
  if (!role) {
    return "Unknown";
  }
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

/**
 * Drop oldest messages so the packed "Role: text" form stays within `limit`.
 * Mirrors packTranscript selection (including truncating a single oversized tail).
 */
export function capTranscriptMessages(messages, limit = PACKED_TRANSCRIPT_LIMIT) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const selected = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const text = String(message?.text ?? "");
    const block = `${formatRole(message?.role)}: ${text}`;
    if (selected.length === 0 && block.length > limit) {
      const prefix = `${formatRole(message?.role)}: `;
      const maxText = Math.max(0, limit - prefix.length);
      return [{ role: message.role, text: text.slice(text.length - maxText) }];
    }
    const separator = selected.length > 0 ? 1 : 0;
    if (size + separator + block.length > limit) {
      break;
    }
    selected.unshift(message);
    size += separator + block.length;
  }
  return selected;
}

export function packTranscript(messages, limit = PACKED_TRANSCRIPT_LIMIT) {
  const blocks = messages.map((message) => `${formatRole(message.role)}: ${message.text}`);
  if (blocks.length === 0) {
    return "";
  }

  const selected = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (selected.length === 0 && block.length > limit) {
      return block.slice(block.length - limit);
    }
    const separator = selected.length > 0 ? 1 : 0;
    if (size + separator + block.length > limit) {
      break;
    }
    selected.unshift(block);
    size += separator + block.length;
  }
  return selected.join("\n");
}
