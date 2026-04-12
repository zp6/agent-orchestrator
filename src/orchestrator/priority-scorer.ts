/**
 * Issue priority scoring — rank issues by importance so the most
 * valuable work gets dispatched first.
 *
 * Pure heuristics, no LLM call. Runs on every dispatch cycle.
 * Score range: 0–1. Higher = dispatch first.
 */
import type { StateStore } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("priority-scorer");

export interface PriorityScore {
  score: number;
  reasons: string[];
}

interface IssueMetadata {
  number: number;
  title: string;
  labels: string[];
  createdAt?: string;
  author?: string;
  repo: string;
}

// ── Label weights ───────────────────────────────────────────────────────────

const LABEL_WEIGHTS: Record<string, number> = {
  "P1-high": 0.3,
  "critical": 0.3,
  "bug": 0.2,
  "P2-medium": 0.1,
  "enhancement": 0.05,
  "roadmap-proposal": 0.1,
  "P3-low": -0.1,
  "team-meeting": -0.2,
  "wontfix": -0.3,
};

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Score an issue's priority based on metadata and task history.
 */
export function scoreIssuePriority(
  issue: IssueMetadata,
  store: StateStore,
): PriorityScore {
  let score = 0.4; // baseline
  const reasons: string[] = [];

  // 1. Label-based priority
  for (const label of issue.labels) {
    const weight = LABEL_WEIGHTS[label];
    if (weight) {
      score += weight;
      reasons.push(`label:${label} (${weight > 0 ? "+" : ""}${weight})`);
    }
  }

  // 2. Age boost — older issues gradually increase in priority
  // Prevents starvation: after 14 days, even P3 issues bubble up
  const ageMs = issue.createdAt ? Date.now() - new Date(issue.createdAt).getTime() : 0;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const ageBoost = Math.min(ageDays * 0.015, 0.25); // cap at +0.25
  if (ageBoost > 0.05) {
    score += ageBoost;
    reasons.push(`age:${ageDays.toFixed(0)}d (+${ageBoost.toFixed(2)})`);
  }

  // 3. Stuck issue boost — revision count indicates difficulty, needs attention
  const sourceRef = `${issue.repo}#${issue.number}`;
  const tasks = store.findAllTasksBySourceRef(sourceRef);
  const maxRevisions = Math.max(0, ...tasks.map((t) => t.revision_count ?? 0));
  if (maxRevisions >= 2) {
    score += 0.15;
    reasons.push(`stuck:${maxRevisions} revisions (+0.15)`);
  }

  // 4. Previously failed — needs fresh attempt
  const failedTasks = tasks.filter((t) => t.status === "failed");
  if (failedTasks.length > 0 && failedTasks.length <= 2) {
    score += 0.05;
    reasons.push(`retry-eligible (+0.05)`);
  }

  // 5. Title keyword signals
  const title = issue.title.toLowerCase();
  if (title.includes("security") || title.includes("vulnerability")) {
    score += 0.2;
    reasons.push("security (+0.2)");
  }
  if (title.includes("broken") || title.includes("crash") || title.includes("deadlock")) {
    score += 0.15;
    reasons.push("severity-keyword (+0.15)");
  }

  // Clamp to 0–1
  score = Math.max(0, Math.min(1, score));

  return { score, reasons };
}

/**
 * Sort issues by priority score (highest first).
 * Returns the issues in dispatch order with scores attached.
 */
export function rankIssues(
  issues: IssueMetadata[],
  store: StateStore,
): Array<IssueMetadata & { priority: PriorityScore }> {
  const scored = issues.map((issue) => ({
    ...issue,
    priority: scoreIssuePriority(issue, store),
  }));

  scored.sort((a, b) => b.priority.score - a.priority.score);

  if (scored.length > 0) {
    log.info("Issues ranked by priority", {
      top3: scored.slice(0, 3).map((s) => ({
        ref: `${s.repo}#${s.number}`,
        score: s.priority.score.toFixed(2),
        reasons: s.priority.reasons,
      })),
    });
  }

  return scored;
}
