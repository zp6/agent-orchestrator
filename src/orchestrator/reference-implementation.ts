/**
 * Reference Implementation Hints — cross-repo feature consistency.
 *
 * Problem (issue #772): when the orchestrator dispatches a follow-up task for
 * a feature already partially implemented on another repo, the agent re-derives
 * the design from scratch, leading to quality score degradation across the
 * lineage (e.g. 0.88 → 0.72 → 0.68 for "unified secrets health").
 *
 * Solution: at dispatch time, find the highest-scoring completed task in the
 * same lineage group, extract the PR reference from its result, and inject a
 * "Reference Implementation" block so the agent starts from the known-good
 * pattern rather than re-inventing it.
 *
 * Only fires when:
 *   1. The task has a lineage_group_id (i.e. it is part of a cross-repo group).
 *   2. At least one peer task in the group is already done with quality_score >= 0.75.
 *   3. That peer task was for a *different* repo (same-repo hints are redundant).
 */

export interface ReferenceImplementation {
  /** Task ID of the reference implementation. */
  taskId: string;
  /** Source ref (owner/repo#N) of the reference task. */
  sourceRef: string | null;
  /** Quality score of the reference task (0–1). */
  qualityScore: number;
  /** PR URL or number extracted from the result text, if available. */
  prRef: string | null;
  /** Brief excerpt from the reference task's result. */
  resultExcerpt: string;
}

/**
 * Attempt to extract a GitHub PR URL or "owner/repo#N" ref from free-form
 * result text. Returns the first match found, or null.
 */
function extractPrRef(result: string): string | null {
  // Match full GitHub PR URLs: https://github.com/owner/repo/pull/123
  const urlMatch = result.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  if (urlMatch) return urlMatch[0];

  // Match shorthand "owner/repo#123" style references
  const shortMatch = result.match(/[\w.-]+\/[\w.-]+#\d+/);
  if (shortMatch) return shortMatch[0];

  // Match bare "PR #123" or "pull request #123"
  const prNumMatch = result.match(/\b(?:PR|pull request)\s+#(\d+)\b/i);
  if (prNumMatch) return prNumMatch[0];

  return null;
}

/**
 * Minimum quality score for a peer task to be used as a reference
 * implementation. Below this threshold the peer task is not considered
 * a reliable anchor.
 */
const MIN_REFERENCE_SCORE = 0.75;

/**
 * Find the best completed peer task in the same lineage group to use as a
 * reference implementation anchor.
 *
 * Returns null when:
 *  - The task has no lineage_group_id
 *  - No peer tasks meet the quality threshold
 *  - The lineage group has no tasks for different repos
 *
 * @param store   StateStore instance (passed in to avoid circular imports)
 * @param task    The task about to be dispatched
 * @param targetRepo  The repo the dispatched task will work on (e.g. "owner/agent-proxy")
 */
export function findBestReferenceImplementation(
  store: {
    getLineageGroup(lineageGroupId: string): Array<{
      id: string;
      source_ref: string | null;
      status: string;
      quality_score: number | null;
      result: string | null;
    }>;
  },
  task: {
    lineage_group_id: string | null;
    source_ref: string | null;
  },
  targetRepo: string | null,
): ReferenceImplementation | null {
  if (!task.lineage_group_id) return null;

  const siblings = store.getLineageGroup(task.lineage_group_id);

  // Filter to completed peer tasks on different repos with acceptable quality
  const candidates = siblings.filter((t) => {
    if (t.status !== "done") return false;
    if (t.quality_score === null || t.quality_score < MIN_REFERENCE_SCORE) return false;

    // Skip tasks for the same repo as the dispatch target to avoid circular hints
    if (targetRepo && t.source_ref) {
      const peerRepo = t.source_ref.split("#")[0];
      if (peerRepo === targetRepo) return false;
    }

    // Skip the task itself
    if (t.source_ref === task.source_ref) return false;

    return true;
  });

  if (candidates.length === 0) return null;

  // Pick highest quality score; break ties by most recent (last in array since
  // getLineageGroup orders by created_at ASC)
  const best = candidates.reduce((top, t) =>
    (t.quality_score ?? 0) > (top.quality_score ?? 0) ? t : top,
  );

  const result = best.result ?? "";
  const prRef = extractPrRef(result);
  const resultExcerpt = result.slice(0, 600) + (result.length > 600 ? "…" : "");

  return {
    taskId: best.id,
    sourceRef: best.source_ref,
    qualityScore: best.quality_score!,
    prRef,
    resultExcerpt,
  };
}

/**
 * Build a formatted "Reference Implementation" block to inject into a dispatch
 * message, anchoring the agent to the highest-scoring peer implementation.
 *
 * Returns an empty string when ref is null (no eligible peer found).
 */
export function buildReferenceImplementationBlock(ref: ReferenceImplementation | null): string {
  if (!ref) return "";

  const scoreLabel = `quality score: ${ref.qualityScore.toFixed(2)}`;
  const prLine = ref.prRef
    ? `**Reference PR:** ${ref.prRef}\n`
    : "";
  const sourceRefLine = ref.sourceRef
    ? `**Source:** ${ref.sourceRef} (${scoreLabel})\n`
    : `**Prior task:** ${ref.taskId} (${scoreLabel})\n`;

  const excerptBlock = ref.resultExcerpt
    ? `\n**Implementation summary from reference:**\n> ${ref.resultExcerpt.replace(/\n/g, "\n> ")}\n`
    : "";

  return (
    `\n\n## Reference Implementation (cross-repo consistency anchor)\n\n` +
    `A peer repo has already implemented this feature at high quality.\n` +
    `Use it as your primary design anchor to maintain consistency.\n\n` +
    sourceRefLine +
    prLine +
    excerptBlock +
    `\n` +
    `\u2139\ufe0f Study the reference implementation above before writing code. ` +
    `Match its architecture, naming conventions, and error-handling patterns ` +
    `unless the target repo has specific constraints that require deviation.`
  );
}
