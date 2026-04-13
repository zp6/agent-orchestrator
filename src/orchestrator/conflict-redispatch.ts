/**
 * Conflict re-dispatch context injection.
 *
 * When a PR is auto-closed due to persistent merge conflicts (conflict_close_threshold
 * reached), the orchestrator re-dispatches the linked issue so the agent can start
 * fresh from main. This module builds the enriched re-dispatch message that includes:
 *   1. The original issue spec (title + body fetched from GitHub)
 *   2. The raw git conflict diff (files changed + key hunks from the closed PR)
 *   3. A structured resolution prompt explaining what to avoid
 *
 * These three components address the root cause of low quality scores on conflict
 * recovery tasks: agents receiving a bare "start over" message had no context about
 * what they were originally building, what conflicted, or why the old approach failed.
 *
 * Acceptance criteria (issue #810): conflict re-dispatch tasks achieve ≥0.75 average
 * quality score over 10 consecutive re-dispatches; the task body includes a
 * `## Conflict Context` section with the conflicting hunks and the rebased branch.
 */

import { execSync } from "node:child_process";
import { createLogger } from "../service/logger.js";

const log = createLogger("conflict-redispatch");

/** Max diff lines included in the Conflict Context section (prevents bloat). */
const MAX_DIFF_LINES = 120;

/** Max issue body characters to embed (avoids extremely long task messages). */
const MAX_ISSUE_BODY_CHARS = 2000;

export interface IssueRef {
  title: string;
  body: string;
}

/**
 * Fetch the title and body of a GitHub issue.
 * Returns empty strings on failure (non-fatal — the re-dispatch still proceeds).
 */
export function fetchIssueRef(repo: string, issueNum: number): IssueRef {
  try {
    const raw = execSync(
      `gh issue view ${issueNum} --repo ${repo} --json title,body`,
      { encoding: "utf-8", timeout: 15000 },
    );
    const parsed = JSON.parse(raw) as { title?: string; body?: string };
    return {
      title: parsed.title?.trim() ?? "",
      body: parsed.body?.trim() ?? "",
    };
  } catch (err) {
    log.warn("Failed to fetch issue ref for conflict re-dispatch", {
      repo,
      issueNum,
      error: String(err),
    });
    return { title: "", body: "" };
  }
}

/**
 * Extract a bounded excerpt of diff hunks from a unified diff string.
 *
 * The excerpt is limited to MAX_DIFF_LINES lines and includes:
 *   - All file-header lines (`diff --git`, `---`, `+++`)
 *   - Hunk headers (`@@...@@`)
 *   - Added/removed/context lines up to the cap
 *
 * Returns an empty string when prDiff is empty.
 */
export function extractConflictHunks(prDiff: string, maxLines = MAX_DIFF_LINES): string {
  if (!prDiff.trim()) return "";

  const lines = prDiff.split("\n");
  const kept: string[] = [];
  let contentLines = 0;
  let truncated = false;

  for (const line of lines) {
    // Always keep diff/file-header and hunk-header lines (they are metadata)
    const isHeader =
      line.startsWith("diff --git ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("@@ ");

    if (isHeader) {
      kept.push(line);
      continue;
    }

    if (contentLines >= maxLines) {
      truncated = true;
      break;
    }

    kept.push(line);
    contentLines++;
  }

  let result = kept.join("\n").trim();
  if (truncated) {
    result += `\n… (diff truncated at ${maxLines} lines)`;
  }
  return result;
}

/**
 * List file paths touched by a PR diff (for the summary bullet list).
 * Returns an empty array when prDiff is empty or parsing fails.
 */
export function listChangedFiles(prDiff: string): string[] {
  const files: string[] = [];
  for (const line of prDiff.split("\n")) {
    // Match: "+++ b/src/foo/bar.ts" → "src/foo/bar.ts"
    if (line.startsWith("+++ b/")) {
      files.push(line.slice(6).trim());
    }
  }
  return [...new Set(files)]; // deduplicate
}

export interface ConflictRedispatchParams {
  repo: string;
  prNumber: number;
  prBranch: string;
  issueNum: number;
  /** PR diff (output of `gh pr diff`). May be empty — handled gracefully. */
  prDiff?: string;
  /** Pre-fetched issue ref (skips the GitHub fetch when already available). */
  issueRef?: IssueRef;
}

/**
 * Build the enriched message body for a conflict recovery re-dispatch.
 *
 * The returned string is suitable as the `message` argument to `dispatcher.dispatch()`.
 * It contains:
 *   - Preamble explaining why this task exists
 *   - The original issue spec embedded verbatim
 *   - A `## Conflict Context` section with the conflicting branch, changed files,
 *     and a diff excerpt for reference
 *   - A structured resolution guide
 */
export function buildConflictRedispatchMessage(params: ConflictRedispatchParams): string {
  const { repo, prNumber, prBranch, issueNum, prDiff = "", issueRef: preloadedRef } = params;

  // Fetch the original issue spec (or use pre-loaded value)
  const issueRef = preloadedRef ?? fetchIssueRef(repo, issueNum);
  const issueTitle = issueRef.title;
  const issueBodyRaw = issueRef.body;

  // Truncate the issue body so the message stays manageable
  const issueBodyTruncated =
    issueBodyRaw.length > MAX_ISSUE_BODY_CHARS
      ? issueBodyRaw.slice(0, MAX_ISSUE_BODY_CHARS) + "\n… (truncated)"
      : issueBodyRaw;

  // Extract diff info
  const conflictHunks = extractConflictHunks(prDiff);
  const changedFiles = listChangedFiles(prDiff);

  // ── Preamble ──────────────────────────────────────────────────────────────
  const lines: string[] = [
    `Issue #${issueNum} on ${repo} needs to be re-implemented from scratch.`,
    ``,
    `The previous PR #${prNumber} (branch \`${prBranch}\`) was **auto-closed** because it`,
    `had persistent merge conflicts that could not be resolved automatically after`,
    `repeated rebase attempts. Please start fresh from the latest \`main\` branch.`,
    ``,
  ];

  // ── Original issue spec ───────────────────────────────────────────────────
  if (issueTitle || issueBodyTruncated) {
    lines.push(`## Original Issue Spec`);
    lines.push(``);
    if (issueTitle) {
      lines.push(`**Title:** ${issueTitle}`);
      lines.push(``);
    }
    if (issueBodyTruncated) {
      lines.push(issueBodyTruncated);
      lines.push(``);
    }
  }

  // ── Conflict Context section ──────────────────────────────────────────────
  lines.push(`## Conflict Context`);
  lines.push(``);
  lines.push(`**Conflicting branch that was closed:** \`${prBranch}\``);
  lines.push(`**Closed PR:** #${prNumber} on \`${repo}\``);
  lines.push(``);

  if (changedFiles.length > 0) {
    lines.push(`**Files the old implementation touched (likely conflict zones):**`);
    for (const f of changedFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push(``);
  }

  if (conflictHunks) {
    lines.push(
      `**Diff from the closed PR (for reference — understand what was attempted, but do NOT copy or cherry-pick):**`,
    );
    lines.push(``);
    lines.push("```diff");
    lines.push(conflictHunks);
    lines.push("```");
    lines.push(``);
  } else {
    lines.push(
      `*(Diff not available — the PR was already closed before the diff could be captured.)*`,
    );
    lines.push(``);
  }

  // ── Resolution guide ──────────────────────────────────────────────────────
  lines.push(`## Resolution Approach`);
  lines.push(``);
  lines.push(`1. Start from a **clean \`main\`** — do NOT branch from \`${prBranch}\`:`);
  lines.push(`   \`\`\`bash`);
  lines.push(`   git checkout main && git pull origin main`);
  lines.push(`   git checkout -b issue-${issueNum}-description`);
  lines.push(`   \`\`\``);
  lines.push(``);
  lines.push(
    `2. Review the files listed above. They likely have changes merged into \`main\``,
  );
  lines.push(`   since the old branch was created — read the current versions before editing.`);
  lines.push(``);
  lines.push(`3. Implement the issue spec **from scratch**, integrating cleanly with current \`main\`.`);
  lines.push(`   Do not cherry-pick or reapply hunks from the closed PR.`);
  lines.push(``);
  lines.push(
    `4. Open a new PR with \`Closes #${issueNum}\` in the body once your implementation is ready.`,
  );

  return lines.join("\n");
}
