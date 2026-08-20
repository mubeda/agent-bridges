import { formatResumeCommand } from "./render.mjs";

export function buildHandoffPrompt(packed) {
  const body = String(packed ?? "").trimEnd();
  const instruction =
    "Continue this work in this repository. Do not re-ask for the earlier context.";
  if (!body) {
    return instruction;
  }
  return `${body}\n\n${instruction}`;
}

export function formatTransferResult({ backend, threadId }) {
  const sessionId = threadId;
  return {
    sessionId,
    resumeCommand: formatResumeCommand(backend ?? "gemini", threadId)
  };
}
