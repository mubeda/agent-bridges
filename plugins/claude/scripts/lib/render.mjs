function severityRank(severity) {
  return { critical: 0, high: 1, medium: 2 }[severity] ?? 3;
}

function formatLineRange(finding) {
  if (!finding.line_start) return "";
  if (!finding.line_end || finding.line_end === finding.line_start) return `:${finding.line_start}`;
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Expected a top-level JSON object.";
  if (typeof data.verdict !== "string" || !data.verdict.trim()) return "Missing string `verdict`.";
  if (typeof data.summary !== "string" || !data.summary.trim()) return "Missing string `summary`.";
  if (!Array.isArray(data.findings)) return "Missing array `findings`.";
  if (!Array.isArray(data.next_steps)) return "Missing array `next_steps`.";
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;
  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map(normalizeReviewFinding),
    next_steps: data.next_steps.filter((step) => typeof step === "string" && step.trim()).map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  return Boolean(
    result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      (Object.hasOwn(result, "result") ||
        Object.hasOwn(result, "parseError") ||
        Object.hasOwn(result, "structuredOutput"))
  );
}

function escapeMarkdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function formatResumeCommand(job) {
  if (job?.invoke === "bg" && job.shortId) {
    return `claude attach ${job.shortId}`;
  }
  if (job?.claudeSessionId) {
    return `claude -r ${job.claudeSessionId}`;
  }
  return null;
}

function formatJobLine(job) {
  return [job.id, job.status || "unknown", job.kindLabel, job.title].filter(Boolean).join(" | ");
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Claude Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/claude:status ${job.id}`];
    if (job.status === "queued" || job.status === "running" || job.status === "blocked") {
      actions.push(`/claude:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.claudeSessionId ?? job.shortId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) lines.push(`  Summary: ${job.summary}`);
  if (job.phase) lines.push(`  Phase: ${job.phase}`);
  if (options.showElapsed && job.elapsed) lines.push(`  Elapsed: ${job.elapsed}`);
  if (options.showDuration && job.duration) lines.push(`  Duration: ${job.duration}`);
  if (job.claudeSessionId) lines.push(`  Claude session ID: ${job.claudeSessionId}`);
  if (job.shortId) lines.push(`  Claude background ID: ${job.shortId}`);
  const resumeCommand = formatResumeCommand(job);
  if (resumeCommand) lines.push(`  Resume in Claude: ${resumeCommand}`);
  if (job.waitingFor) {
    lines.push(`  Waiting for: ${job.waitingFor}`);
    if (job.shortId) lines.push(`  Attach: claude attach ${job.shortId}`);
  }
  if (job.worktree) {
    lines.push(`  Worktree: ${job.worktree}`);
  } else if (job.invoke === "bg") {
    lines.push("  Worktree: not reported; --bg sessions in a git repo may isolate under .claude/worktrees/.");
  }
  if (job.logFile && options.showLog) lines.push(`  Log: ${job.logFile}`);
  if ((job.status === "queued" || job.status === "running" || job.status === "blocked") && options.showCancelHint) {
    lines.push(`  Cancel: /claude:cancel ${job.id}`);
  }
  if (!["queued", "running"].includes(job.status) && options.showResultHint) {
    lines.push(`  Result: /claude:result ${job.id}`);
  }
  if (!["queued", "running"].includes(job.status) && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /claude:review --wait");
    lines.push("  Stricter review: /claude:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) lines.push(`    ${line}`);
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) return;
  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) lines.push(`- ${section}`);
}

export function renderSetupReport(report) {
  const lines = [
    "# Claude Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- claude: ${report.claude.detail}`,
    `- auth: ${report.auth.detail}`,
    `- bypass disclaimer: ${report.bypassDisclaimer.detail}`,
    "- review gate: not used (this plugin is not installed in Claude Code)",
    ""
  ];
  if (report.actionsTaken.length) {
    lines.push("Actions taken:", ...report.actionsTaken.map((action) => `- ${action}`), "");
  }
  if (report.nextSteps.length) {
    lines.push("Next steps:", ...report.nextSteps.map((step) => `- ${step}`));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Claude ${meta.reviewLabel}`,
      "",
      "Claude did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];
    if (parsedResult.rawOutput) lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);
    return `${lines.join("\n").trimEnd()}\n`;
  }
  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Claude ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Claude returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];
    if (parsedResult.rawOutput) lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    return `${lines.join("\n").trimEnd()}\n`;
  }
  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const lines = [
    `# Claude ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];
  if (!findings.length) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${formatLineRange(finding)})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) lines.push(`  Recommendation: ${finding.recommendation}`);
    }
  }
  if (data.next_steps.length) lines.push("", "Next steps:", ...data.next_steps.map((step) => `- ${step}`));
  appendReasoningSection(lines, meta.reasoningSummary);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [`# Claude ${meta.reviewLabel}`, "", `Target: ${meta.targetLabel}`, ""];
  lines.push(stdout || (result.status === 0 ? "Claude review completed without any stdout output." : "Claude review failed."));
  if (stderr) lines.push("", "stderr:", "", "```text", stderr, "```");
  appendReasoningSection(lines, meta.reasoningSummary);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  return `${String(parsedResult?.failureMessage ?? "").trim() || "Claude did not return a final message."}\n`;
}

export function renderStatusReport(report) {
  const lines = ["# Claude Status", ""];
  if (report.sessionRuntime?.label) lines.push(`Session runtime: ${report.sessionRuntime.label}`, "");
  if (report.running.length) {
    appendActiveJobsTable(lines, report.running);
    lines.push("", "Live details:");
    for (const job of report.running) pushJobDetails(lines, job, { showElapsed: true, showLog: true });
    lines.push("");
  }
  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, { showDuration: true, showLog: report.latestFinished.status === "failed" });
    lines.push("");
  }
  if (report.recent.length) {
    lines.push("Recent jobs:");
    for (const job of report.recent) pushJobDetails(lines, job, { showDuration: true, showLog: job.status === "failed" });
  } else if (!report.running.length && !report.latestFinished) {
    lines.push("No jobs recorded yet.");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Claude Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const resumeCommand = formatResumeCommand(storedJob ?? job);
  const sessionId = storedJob?.claudeSessionId ?? job.claudeSessionId ?? null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    return resumeCommand ? `${output}\nResume in Claude: ${resumeCommand}\n` : output;
  }
  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.claude?.stdout === "string" && storedJob.result.claude.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    return resumeCommand ? `${output}\nResume in Claude: ${resumeCommand}\n` : output;
  }
  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    return resumeCommand ? `${output}\nResume in Claude: ${resumeCommand}\n` : output;
  }
  const lines = [`# ${job.title ?? "Claude Result"}`, "", `Job: ${job.id}`, `Status: ${job.status}`];
  if (sessionId) lines.push(`Claude session ID: ${sessionId}`);
  if (job.shortId) lines.push(`Claude background ID: ${job.shortId}`);
  if (resumeCommand) lines.push(`Resume in Claude: ${resumeCommand}`);
  if (job.summary) lines.push(`Summary: ${job.summary}`);
  lines.push("", job.errorMessage ?? storedJob?.errorMessage ?? "No captured result payload was stored for this job.");
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# Claude Cancel", "", `Cancelled ${job.id}.`, ""];
  if (job.title) lines.push(`- Title: ${job.title}`);
  if (job.summary) lines.push(`- Summary: ${job.summary}`);
  lines.push("- Check `/claude:status` for the updated queue.");
  return `${lines.join("\n").trimEnd()}\n`;
}
