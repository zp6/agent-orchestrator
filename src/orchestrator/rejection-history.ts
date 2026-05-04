/**
 * Builds a structured rejection history block from prior task attempts.
 * Injected into retry dispatch prompts so agents avoid repeating failed approaches.
 */

import { detectScopeDecline } from "./scope-decline-detector.js";

export interface PriorAttempt {
  id: string;
  result: string | null;
  verification_status: string | null;
  quality_score: number | null;
  verification_notes: string | null;
  created_at: string;
}

/**
 * Build a formatted "Prior Attempts" block from an array of prior attempts.
 * Returns an empty string when there are no rejected or noteworthy attempts.
 *
 * Only includes attempts that have been rejected or failed — successful
 * attempts without issues are omitted to keep the prompt focused on what
 * went wrong.
 *
 * Scope-decline attempts (issue #1433) are surfaced as a distinct
 * `### Scope decline` section so a downstream supervisor or reviewer
 * agent can see that the prior failure was a routing problem, not a
 * quality problem with the work itself.
 */
export function buildRejectionHistoryBlock(attempts: PriorAttempt[]): string {
  // Filter to only rejected/failed attempts that have useful feedback
  const relevant = attempts.filter(
    (a) =>
      a.verification_status === "rejected" ||
      (a.verification_notes && a.quality_score !== null && a.quality_score < 0.7),
  );

  if (relevant.length === 0) return "";

  const sections = relevant.map((attempt, index) => {
    const score =
      attempt.quality_score !== null
        ? `quality score: ${attempt.quality_score.toFixed(2)}`
        : "quality score: N/A";
    const status = attempt.verification_status ?? "unknown";
    const result = attempt.result
      ? attempt.result.slice(0, 500) + (attempt.result.length > 500 ? "..." : "")
      : "(no result recorded)";
    const notes = attempt.verification_notes ?? "(no rejection notes)";

    // If the prior attempt's result body shows a scope-decline signal,
    // flag it distinctly so the next agent (and any reviewer reading
    // this block) understands the prior failure was a routing problem,
    // not a quality problem.
    const scope = detectScopeDecline(attempt.result);
    if (scope.declined) {
      return (
        `### Scope decline — Attempt ${index + 1} (signal: ${scope.signal})\n` +
        `The previous agent declined this task on scope grounds. The\n` +
        `failure was a routing problem, not a quality problem.\n\n` +
        `**Result:** ${result}\n` +
        `**Rejection notes:** ${notes}`
      );
    }

    return (
      `### Attempt ${index + 1} (${score}, status: ${status})\n` +
      `**Result:** ${result}\n` +
      `**Rejection notes:** ${notes}`
    );
  });

  return (
    `\n\n## Prior Attempts (DO NOT repeat these approaches)\n\n` +
    sections.join("\n\n") +
    `\n\n` +
    `\u26a0\ufe0f You MUST take a different approach than the attempts above. Address the specific rejection feedback.`
  );
}
