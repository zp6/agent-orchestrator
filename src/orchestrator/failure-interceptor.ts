/**
 * Predictive Failure Interception — pre-dispatch similarity scoring (issue #1086).
 *
 * Before every dispatch, score the incoming task title against recent failed
 * tasks using token-overlap Jaccard similarity (same lightweight approach as
 * antibody-filter.ts).  When similarity exceeds a configurable threshold, the
 * top-3 failure post-mortems are extracted and injected into the dispatch
 * prompt as "Lessons from Similar Failed Tasks".
 *
 * This prevents agents from re-learning the same failure patterns from scratch
 * across repeated attempts on similar issues.
 */

import type { StateStore } from "../state/store.js";

/** Minimum similarity score [0, 1] to trigger lesson injection. */
export const FAILURE_INTERCEPTION_THRESHOLD = 0.6;

/** Score above which we also send a Telegram alert (high confidence). */
export const FAILURE_INTERCEPTION_ALERT_THRESHOLD = 0.75;

/** Maximum matched failed tasks to extract lessons from. */
const MAX_LESSONS = 3;

// ── Token helpers (mirrors antibody-filter.ts pattern) ───────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
  "this", "that", "it", "its", "as", "if", "not", "no", "so", "do",
  "does", "did", "will", "would", "can", "could", "should", "may", "might",
  "has", "have", "had", "we", "i", "you", "they", "he", "she",
  "add", "fix", "new", "update", "via", "per", "into", "use",
]);

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s/-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface FailedTaskCandidate {
  id: string;
  title: string;
  result: string | null;
  agent: string;
  similarity: number;
}

export interface InterceptionResult {
  /** Whether the task crossed the similarity threshold and lessons were injected. */
  intercepted: boolean;
  /** Top Jaccard similarity score across all candidates (0–1). */
  similarity_score: number;
  /**
   * Final risk score used by the dispatcher.  This folds in the similarity
   * score plus a light agent-history adjustment so candidate routes can be
   * ranked against each other.
   */
  risk_score: number;
  /** Top-3 failure post-mortems formatted as text strings. */
  lessons: string[];
  /** True when similarity >= threshold (recommend higher-tier model). */
  suggest_model_upgrade: boolean;
  /** IDs of the matched failed tasks. */
  matched_task_ids: string[];
}

// ── FailureInterceptor ────────────────────────────────────────────────────────

export class FailureInterceptor {
  private readonly threshold: number;

  constructor(
    private readonly store: StateStore,
    threshold = FAILURE_INTERCEPTION_THRESHOLD,
  ) {
    this.threshold = threshold;
  }

  /**
   * Score the incoming task against recently failed tasks.
   *
   * @param taskTitle  Title of the incoming task (primary signal).
   * @param taskType   Task type used for agent-history adjustment.
   * @param agent      Target agent used to bias the risk score by historical success rate.
   */
  check(taskTitle: string, taskType: string, agent: string): InterceptionResult {
    const recentFailed = this.store.getRecentFailedTasksForSimilarity(14, 50);
    if (recentFailed.length === 0) {
      return this.emptyResult();
    }

    const taskTokens = tokenise(taskTitle);

    // Score every candidate
    const scored: FailedTaskCandidate[] = recentFailed.map((f) => ({
      ...f,
      similarity: jaccardSimilarity(taskTokens, tokenise(f.title)),
    }));

    // Sort descending, take top matches above threshold
    scored.sort((a, b) => b.similarity - a.similarity);
    const matches = scored.filter((c) => c.similarity >= this.threshold).slice(0, MAX_LESSONS);
    const riskScore = this.computeRiskScore(scored[0]?.similarity ?? 0, taskType, agent);

    if (matches.length === 0) {
      return {
        intercepted: false,
        similarity_score: scored[0]?.similarity ?? 0,
        risk_score: riskScore,
        lessons: [],
        suggest_model_upgrade: false,
        matched_task_ids: [],
      };
    }

    const topScore = matches[0].similarity;
    const adjustedRisk = this.computeRiskScore(topScore, taskType, agent);
    const lessons = matches.map((m) => this.extractLesson(m));

    return {
      intercepted: true,
      similarity_score: topScore,
      risk_score: adjustedRisk,
      lessons,
      suggest_model_upgrade: adjustedRisk >= FAILURE_INTERCEPTION_ALERT_THRESHOLD,
      matched_task_ids: matches.map((m) => m.id),
    };
  }

  /**
   * Format the lessons block to prepend to the dispatch prompt.
   * Returns an empty string when there are no lessons.
   */
  buildLessonsContext(lessons: string[]): string {
    if (lessons.length === 0) return "";

    const items = lessons
      .map((lesson, i) => `${i + 1}. ⚠️ Past failure: ${lesson}`)
      .join("\n\n");

    return (
      `\n\n## Lessons from Similar Failed Tasks\n\n` +
      `The following tasks previously failed with similar scope. ` +
      `Study these failure patterns and ensure your implementation avoids the same pitfalls:\n\n` +
      items +
      `\n\n` +
      `ℹ️ These failure patterns were automatically detected via task similarity scoring. ` +
      `Address each lesson explicitly in your implementation.`
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private extractLesson(candidate: FailedTaskCandidate): string {
    const title = candidate.title.slice(0, 120);
    const resultHint = candidate.result
      ? ` — "${candidate.result.replace(/\n/g, " ").slice(0, 200)}"`
      : "";
    const agentHint = candidate.agent ? ` (agent: ${candidate.agent})` : "";
    const score = Math.round(candidate.similarity * 100);
    return `[${score}% similar] "${title}"${agentHint}${resultHint}`;
  }

  private emptyResult(): InterceptionResult {
    return {
      intercepted: false,
      similarity_score: 0,
      risk_score: 0,
      lessons: [],
      suggest_model_upgrade: false,
      matched_task_ids: [],
    };
  }

  private computeRiskScore(similarityScore: number, taskType: string, agent: string): number {
    const history = this.store.getTaskTypeSuccessRates(taskType, [agent])[0];
    const agentPenalty = history?.success_rate === null || history?.success_rate === undefined
      ? 0.15
      : Math.max(0, 1 - history.success_rate);
    return Math.min(1, similarityScore * 0.8 + agentPenalty * 0.2);
  }
}
