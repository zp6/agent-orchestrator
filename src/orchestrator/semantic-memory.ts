/**
 * Semantic Task Memory — FTS5-based knowledge store (issue #1011).
 *
 * Problem: agents repeatedly re-derive design decisions, error-handling patterns,
 * and implementation approaches that were already solved in prior tasks.  The
 * result is inconsistent quality, duplicate mistakes, and missed learnings from
 * the reviewer calibration loop.
 *
 * Solution: index every approved task into a SQLite FTS5 virtual table.  At
 * dispatch time, query for the top-3 most similar past successes (by title,
 * description, and reviewer notes) and inject them as a "Past Successes" block
 * so the agent starts from proven patterns rather than a blank slate.
 *
 * Implementation uses SQLite FTS5 (built-in, no extra dependencies) for
 * keyword-weighted similarity matching.  While this is not true semantic vector
 * search, FTS5 BM25 ranking is a practical and robust approximation for the
 * task-similarity problem given the codebase's constraint of no sqlite-vec.
 */

export interface SemanticMemoryMatch {
  /** Task ID of the past successful task. */
  taskId: string;
  /** Title of the past task. */
  title: string;
  /** Source ref (owner/repo#N) of the past task, if available. */
  sourceRef: string | null;
  /** Quality score from automated verification (0–1). */
  qualityScore: number;
  /** Distilled reviewer notes from verification. */
  reviewerNotes: string | null;
  /** Brief excerpt from the task result (first 400 chars). */
  resultExcerpt: string | null;
}

/**
 * Build a "Past Successes" context block to inject into a dispatch message.
 *
 * Returns an empty string when matches is null / empty (no relevant history
 * found), so callers can unconditionally append the return value.
 */
export function buildSemanticMemoryBlock(matches: SemanticMemoryMatch[] | null): string {
  if (!matches || matches.length === 0) return "";

  const items = matches
    .map((m, i) => {
      const header = `### ${i + 1}. ${m.title}`;
      const meta: string[] = [`- **Quality score:** ${m.qualityScore.toFixed(2)}`];
      if (m.sourceRef) meta.push(`- **Source:** ${m.sourceRef}`);
      if (m.reviewerNotes) meta.push(`- **Reviewer notes:** ${m.reviewerNotes}`);
      if (m.resultExcerpt) {
        meta.push(`- **Result excerpt:**\n  > ${m.resultExcerpt.replace(/\n/g, "\n  > ")}`);
      }
      return `${header}\n${meta.join("\n")}`;
    })
    .join("\n\n");

  return (
    `\n\n## Past Successes (semantic memory)\n\n` +
    `The following completed tasks are semantically similar to this one ` +
    `and were approved with high quality scores. ` +
    `Use their patterns, conventions, and reviewer feedback as a starting point.\n\n` +
    items +
    `\n\n` +
    `\u2139\ufe0f These are proven patterns from this codebase. Prefer them over ` +
    `re-deriving solutions from scratch unless the current task explicitly requires deviation.`
  );
}
