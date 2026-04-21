/**
 * Per-agent quality coaching directives for housekeeping/triage prompts (issue #245).
 *
 * ## Problem
 *
 * claude-orchestrator-dashboard scored 0.72 on two consecutive triage tasks
 * (one rejected, one marginal approval).  The verifier enforces a deterministic
 * schema check that requires four fields in the JSON output block:
 *
 *   - duplicates_checked
 *   - stale_issues
 *   - priority_reordering
 *   - outcome_summary
 *
 * Missing ANY one of these drops the schema_compliance score to 0.75 — below
 * the 0.80 threshold — and a revision is dispatched.  The schema is documented,
 * but the agent keeps missing the same fields across cycles because the dispatch
 * prompt doesn't surface the recent failure pattern.
 *
 * ## Solution
 *
 * When an agent's rolling triage quality score drops below 0.80 (configurable),
 * inject a short, agent-specific coaching snippet into the housekeeping dispatch
 * prompt.  For example:
 *
 *   > ⚠️ Coaching note for claude-orchestrator-dashboard:
 *   > Your last triage scored 0.72 (below the 0.80 threshold).
 *   > The rejected submission was missing: priority_reordering.
 *   > Before submitting, confirm all four schema fields are present:
 *   > duplicates_checked, stale_issues, priority_reordering, outcome_summary.
 *
 * After this change, repeat rejections on the same agent for the same schema gap
 * should drop to zero.
 *
 * ## Architecture
 *
 * `TriageCoachingProvider` — minimal interface following the existing provider
 * pattern (ConflictStatsProvider, QualitySLAProvider, etc.).  The Supervisor
 * consumes it as an optional dependency injected at construction time.
 *
 * `buildTriageCoachingDirective()` — pure function, easy to unit-test.
 *
 * `formatTriageCoachingSection()` — formats directives as supervisor context
 * lines, injected into `buildContext()` output.
 *
 * `injectTriageCoachingIntoPrompt()` — the call site for housekeeping dispatch:
 * appends the coaching snippet to the dispatch message when the provider
 * reports a below-threshold agent.
 *
 * Acceptance criteria (issue #245):
 *   ✓ Rolling triage score computed per agent over last N housekeeping tasks
 *   ✓ Coaching snippet injected into housekeeping dispatch prompt when score < 0.80
 *   ✓ Snippet names the specific missing fields from recent rejections
 *   ✓ Supervisor context includes a "## Triage Coaching Directives" section
 *   ✓ No snippet injected when agent score ≥ 0.80 (healthy agents unaffected)
 */

import type { IStateStore } from "../state/types.js";
import { TRIAGE_REQUIRED_FIELDS } from "./verifier.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Default rolling triage score threshold below which coaching is injected.
 * Matches TRIAGE_SCHEMA_COMPLIANCE_THRESHOLD in verifier.ts.
 */
export const TRIAGE_COACHING_THRESHOLD = 0.80;

/**
 * Default window: number of most-recent housekeeping tasks to include in the
 * rolling average.  Small enough to be responsive; large enough to avoid
 * coaching on a single fluke.
 */
export const TRIAGE_COACHING_WINDOW = 10;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Per-agent triage quality stats needed to decide whether to inject coaching.
 */
export interface AgentTriageStats {
  /** The agent whose triage quality is being assessed. */
  agent_name: string;
  /** Number of housekeeping tasks in the window (may be 0). */
  task_count: number;
  /** Rolling average quality_score across those tasks (null if no scored tasks). */
  rolling_avg_score: number | null;
  /**
   * Fields that were missing across recent rejected triage tasks.
   * Ordered by occurrence count descending so the most-missed field appears first.
   */
  missing_fields: Array<{ field: string; count: number }>;
}

/**
 * Coaching directive generated for one agent whose triage quality is below
 * the configured threshold.
 */
export interface TriageCoachingDirective {
  /** Agent receiving the coaching. */
  agent_name: string;
  /** Rolling triage quality score that triggered coaching (0–1). */
  rolling_triage_score: number;
  /** Number of housekeeping tasks in the rolling window. */
  task_count: number;
  /**
   * Most-missed schema fields, ordered by frequency.
   * Empty when the agent's score is low for reasons other than schema gaps
   * (e.g. shallow reasoning).
   */
  missing_fields: Array<{ field: string; count: number }>;
  /**
   * The short coaching snippet to inject into the housekeeping dispatch prompt.
   * Plain text, suitable for appending directly to the task description.
   */
  directive: string;
}

/**
 * Minimal interface for providing triage coaching directives to the Supervisor.
 *
 * Satisfied by `TriageCoachingAdvisor` (concrete class below, backed by
 * `IStateStore`) or any stub in tests.
 */
export interface TriageCoachingProvider {
  /**
   * Return coaching directives for agents whose rolling triage score falls
   * below the configured threshold.  Returns an empty array when all agents
   * are healthy.
   *
   * @param agentNames  All agent names to check (from config).
   */
  getTriageCoachingDirectives(agentNames: string[]): TriageCoachingDirective[];
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Build the short coaching snippet text for one agent.
 *
 * The text is intentionally terse: operators and downstream dispatch messages
 * need only the score, the threshold gap, and the specific missing fields.
 *
 * @param agentName        Agent name for the heading.
 * @param rollingScore     Current rolling triage score (e.g. 0.72).
 * @param taskCount        Number of tasks in the rolling window.
 * @param missingFields    Fields missed in recent rejections, desc by count.
 * @param threshold        Threshold that was not met (default 0.80).
 */
export function buildTriageCoachingDirective(
  agentName: string,
  rollingScore: number,
  taskCount: number,
  missingFields: Array<{ field: string; count: number }>,
  threshold: number = TRIAGE_COACHING_THRESHOLD,
): TriageCoachingDirective {
  const scoreStr = rollingScore.toFixed(2);
  const thresholdStr = threshold.toFixed(2);
  const allFields = TRIAGE_REQUIRED_FIELDS.join(", ");

  const lines: string[] = [
    `⚠️ Coaching note for ${agentName}:`,
    `Your rolling triage score is ${scoreStr} (below the ${thresholdStr} threshold, ${taskCount} task${taskCount === 1 ? "" : "s"} in window).`,
  ];

  if (missingFields.length > 0) {
    const topMissed = missingFields.slice(0, 3).map((f) => f.field);
    const plural = topMissed.length === 1 ? "field was" : "fields were";
    lines.push(
      `Recent rejections missed the following schema ${plural}: ${topMissed.join(", ")}.`,
    );
  }

  lines.push(
    `Before submitting, confirm all four JSON schema fields are present: ${allFields}.`,
    ``,
    `Common mistake — priority_reordering: when an issue is newly added to the roadmap`,
    `(no prior rank), set old_rank to null, not 0 and not omit the field entirely.`,
    `Correct example:`,
    `  { "issue": 42, "old_rank": null, "new_rank": 3, "reason": "new high-priority feature added to Next Up" }`,
    ``,
    `See the triage output schema in the task description for the exact required structure.`,
  );

  return {
    agent_name: agentName,
    rolling_triage_score: rollingScore,
    task_count: taskCount,
    missing_fields: missingFields,
    directive: lines.join("\n"),
  };
}

/**
 * Format a list of triage coaching directives as supervisor context lines.
 *
 * Returns an empty array when there are no below-threshold agents, so the
 * caller can guard with `if (lines.length > 0)` before adding a section.
 *
 * Example output:
 *   - claude-orchestrator-dashboard (score 0.72, 3 tasks): missing priority_reordering (2×), outcome_summary (1×)
 *   > ⚠️ Coaching note for claude-orchestrator-dashboard:
 *   > Your rolling triage score is 0.72 ...
 */
export function formatTriageCoachingSection(
  directives: TriageCoachingDirective[],
): string[] {
  if (directives.length === 0) return [];

  const lines: string[] = [];
  for (const d of directives) {
    const scoreStr = d.rolling_triage_score.toFixed(2);
    const fieldSummary =
      d.missing_fields.length > 0
        ? ` | missing: ${d.missing_fields.map((f) => `${f.field}(${f.count}×)`).join(", ")}`
        : "";
    lines.push(`- ${d.agent_name} (triage score ${scoreStr}, ${d.task_count} tasks${fieldSummary})`);
    // Indent the directive text for readability inside the context block.
    for (const directiveLine of d.directive.split("\n")) {
      lines.push(`  ${directiveLine}`);
    }
  }
  return lines;
}

/**
 * Inject a triage coaching snippet into a housekeeping dispatch message.
 *
 * If the provider has a directive for `agentName`, appends it to the prompt.
 * Otherwise returns the prompt unchanged — healthy agents are unaffected.
 *
 * This is the call site for the dispatcher: before sending a housekeeping task
 * to an agent, call this to augment the prompt with any relevant coaching.
 *
 * @param prompt      The original dispatch prompt / task description.
 * @param agentName   The agent the task will be sent to.
 * @param provider    TriageCoachingProvider (or null to skip injection).
 */
export function injectTriageCoachingIntoPrompt(
  prompt: string,
  agentName: string,
  provider: TriageCoachingProvider | null | undefined,
): string {
  if (!provider) return prompt;

  const directives = provider.getTriageCoachingDirectives([agentName]);
  const directive = directives.find((d) => d.agent_name === agentName);
  if (!directive) return prompt;

  // Append after a blank line so the coaching is clearly separated from the task.
  return `${prompt}\n\n---\n${directive.directive}`;
}

// ── Concrete provider ─────────────────────────────────────────────────────────

/**
 * Concrete `TriageCoachingProvider` backed by the live `IStateStore`.
 *
 * Queries recent housekeeping tasks to compute per-agent rolling triage
 * scores and identify recurring missing-field patterns.
 */
export class TriageCoachingAdvisor implements TriageCoachingProvider {
  constructor(
    private readonly store: IStateStore,
    private readonly threshold: number = TRIAGE_COACHING_THRESHOLD,
    private readonly windowTasks: number = TRIAGE_COACHING_WINDOW,
  ) {}

  getTriageCoachingDirectives(agentNames: string[]): TriageCoachingDirective[] {
    const directives: TriageCoachingDirective[] = [];

    for (const agentName of agentNames) {
      const stats = this.getAgentTriageStats(agentName);
      if (
        stats.rolling_avg_score !== null &&
        stats.rolling_avg_score < this.threshold &&
        stats.task_count > 0
      ) {
        directives.push(
          buildTriageCoachingDirective(
            agentName,
            stats.rolling_avg_score,
            stats.task_count,
            stats.missing_fields,
            this.threshold,
          ),
        );
      }
    }

    return directives;
  }

  /**
   * Compute triage-specific quality stats for one agent.
   *
   * Queries the last `windowTasks` housekeeping tasks for the agent that have
   * a non-null quality_score, then inspects rejected tasks for missing-field
   * patterns by scanning their `result` text for verifier rejection messages.
   */
  private getAgentTriageStats(agentName: string): AgentTriageStats {
    // Fetch recent housekeeping tasks for this agent.
    const tasks = this.store
      .listTasks({ agent_name: agentName, limit: this.windowTasks * 2 })
      .filter((t) => t.task_type === "housekeeping")
      .slice(0, this.windowTasks);

    const scoredTasks = tasks.filter(
      (t): t is typeof t & { quality_score: number } =>
        typeof t.quality_score === "number",
    );

    const rollingAvgScore =
      scoredTasks.length > 0
        ? scoredTasks.reduce((sum, t) => sum + t.quality_score, 0) / scoredTasks.length
        : null;

    // Detect missing fields from rejected/low-scored triage tasks.
    // The verifier's rejection message includes the list of missing fields when
    // schema compliance fails, e.g.:
    //   "TRIAGE SCHEMA VIOLATION: Missing required fields: priority_reordering"
    const missingFieldCounts: Map<string, number> = new Map();

    const rejectedTasks = tasks.filter(
      (t) =>
        t.verification_status === "rejected" ||
        (typeof t.quality_score === "number" && t.quality_score < this.threshold),
    );

    for (const task of rejectedTasks) {
      const text = [task.result, task.description].join(" ").toLowerCase();
      for (const field of TRIAGE_REQUIRED_FIELDS) {
        if (text.includes(`missing`) && text.includes(field.toLowerCase())) {
          missingFieldCounts.set(field, (missingFieldCounts.get(field) ?? 0) + 1);
        }
      }
    }

    const missingFields = Array.from(missingFieldCounts.entries())
      .map(([field, count]) => ({ field, count }))
      .sort((a, b) => b.count - a.count);

    return {
      agent_name: agentName,
      task_count: tasks.length,
      rolling_avg_score: rollingAvgScore,
      missing_fields: missingFields,
    };
  }
}
