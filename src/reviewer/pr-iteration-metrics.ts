/**
 * PR Iteration Metrics — surfaces patterns in multi-round PR review cycles.
 *
 * Answers three questions:
 *   1. How many PRs required one or more feedback rounds?
 *   2. Which agents are highest-iteration (most revision rounds before merge)?
 *   3. What review comment categories recur most (e.g. missing-closes-ref,
 *      logic, merge-conflict)?
 *
 * The module reads from the `pr_reviews` table via `IPRIterationStore`.
 * Data is written there by `PRReviewer` whenever it calls
 * `store.recordPRReviewDetails()` with extracted categories.
 */

import type { PRIterationReport, ReviewCategory } from "../state/types.js";

/**
 * Methods the iteration metrics module requires from the state store.
 * A subset of IPRIterationStore — kept narrow to ease testing.
 */
export interface PRIterationStorePort {
  getPRIterationReport(days?: number): PRIterationReport;
}

/**
 * Keyword-to-category mapping used by `categoriseReviewComment()`.
 *
 * Keys are lower-cased substrings to match against the review comment text.
 * Each key maps to a `ReviewCategory` label.  The first matching rule wins.
 */
const CATEGORY_RULES: Array<{ pattern: RegExp; category: ReviewCategory }> = [
  { pattern: /closes\s+#\d+|issue\s+ref|missing.*closes|no.*closes/i, category: "missing-closes-ref" },
  { pattern: /merge\s+conflict|conflicting|cannot.*merge|conflict.*branch/i, category: "merge-conflict" },
  { pattern: /credential|secret|token|api[_\s]key|password|inject|xss|sql\s*injection|unsafe/i, category: "security" },
  { pattern: /test.*missing|no.*test|coverage|spec.*needed|add.*test/i, category: "test-coverage" },
  { pattern: /schema.*break|break.*schema|breaking.*change|schema.*impact|downstream.*consumer/i, category: "schema-breaking" },
  { pattern: /feedback.*ceiling|revision.*round.*cap|too.*many.*round|escalat.*revision/i, category: "feedback-ceiling" },
  { pattern: /diff.*too.*large|diff.*exceed|oversized.*pr|large.*diff/i, category: "diff-too-large" },
  { pattern: /stale.*branch|behind.*main|rebase.*required|branch.*behind/i, category: "stale-branch" },
  { pattern: /logic.*error|incorrect.*behav|wrong.*algorithm|off.by.one|return.*wrong|null.*deref|undefined/i, category: "logic" },
  { pattern: /code.*quality|naming|readability|structure|clean.*up|refactor|style/i, category: "code-quality" },
];

/**
 * Extract zero or more review categories from a free-text review comment.
 *
 * Iterates through `CATEGORY_RULES` and collects every matching category
 * (deduped).  Returns `["other"]` when nothing matches and the comment is
 * non-empty, or an empty array for empty comments.
 */
export function categoriseReviewComment(comment: string): ReviewCategory[] {
  if (!comment.trim()) return [];

  const matched = new Set<ReviewCategory>();
  for (const { pattern, category } of CATEGORY_RULES) {
    if (pattern.test(comment)) {
      matched.add(category);
    }
  }

  return matched.size > 0 ? Array.from(matched) : ["other"];
}

/**
 * Format a `PRIterationReport` as a human-readable Markdown string.
 *
 * Suitable for Telegram messages, CLI output, or dashboard sections.
 */
export function formatIterationReport(report: PRIterationReport): string {
  const lines: string[] = [
    `**PR Iteration Report** (last ${report.window_days} days)`,
    `_Generated at ${report.generated_at}_`,
    "",
  ];

  // --- Top categories ---
  if (report.top_categories.length > 0) {
    lines.push("**Top review feedback categories:**");
    for (const { category, count } of report.top_categories.slice(0, 8)) {
      lines.push(`  • \`${category}\` — ${count} occurrence${count !== 1 ? "s" : ""}`);
    }
    lines.push("");
  } else {
    lines.push("_No categorised review comments in this window._");
    lines.push("");
  }

  // --- Agent iteration stats ---
  if (report.agent_stats.length > 0) {
    lines.push("**Agent iteration stats** (sorted by avg rounds ↓):");
    for (const s of report.agent_stats) {
      lines.push(
        `  • \`${s.agent_name}\` — ${s.total_prs} PR${s.total_prs !== 1 ? "s" : ""}, ` +
        `avg ${s.avg_rounds.toFixed(1)} round${parseFloat(s.avg_rounds.toFixed(1)) !== 1 ? "s" : ""}, ` +
        `max ${s.max_rounds}, multi-round: ${s.multi_round_prs}`,
      );
    }
    lines.push("");
  } else {
    lines.push("_No agent-linked PR reviews in this window._");
    lines.push("");
  }

  // --- Multi-round PRs ---
  if (report.multi_round_prs.length > 0) {
    lines.push(`**PRs with > 1 feedback round** (${report.multi_round_prs.length} total):`);
    for (const pr of report.multi_round_prs.slice(0, 10)) {
      const agent = pr.agent_name ? ` by \`${pr.agent_name}\`` : "";
      lines.push(
        `  • \`${pr.repo}#${pr.pr_number}\`${agent} — ` +
        `${pr.review_count} rounds, last: \`${pr.final_decision ?? "open"}\``,
      );
    }
    if (report.multi_round_prs.length > 10) {
      lines.push(`  _…and ${report.multi_round_prs.length - 10} more_`);
    }
  } else {
    lines.push("_No PRs required more than one review round in this window._");
  }

  return lines.join("\n");
}

/**
 * PR Iteration Metrics — lightweight wrapper around the store queries.
 *
 * Provides a single `buildReport()` method that the orchestrator, Telegram
 * command handler, or dashboard can call to retrieve iteration stats.
 */
export class PRIterationMetrics {
  constructor(private readonly store: PRIterationStorePort) {}

  /**
   * Build a full iteration report for the given look-back window.
   *
   * @param days - Number of days to look back (default: 30).
   */
  buildReport(days?: number): PRIterationReport {
    return this.store.getPRIterationReport(days);
  }

  /**
   * Build and format the report as Markdown.
   */
  buildFormattedReport(days?: number): string {
    return formatIterationReport(this.buildReport(days));
  }
}
