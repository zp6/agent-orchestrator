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

// ── old_rank pre-submission validator (issue #399) ────────────────────────────

/**
 * A single `priority_reordering` entry that violated the old_rank rule.
 */
export interface OldRankViolation {
  /** The issue number from the priority_reordering entry. */
  issue: number;
  /** The numeric old_rank value that triggered the violation (never null here). */
  old_rank: number;
  /** Reason text from the entry (for diagnostics). */
  reason: string;
  /** Human-readable explanation of the specific violation. */
  violation: string;
}

/**
 * Result returned by `validateOldRankInPriorityReordering()`.
 */
export interface OldRankValidationResult {
  /**
   * True when no violations were detected.
   * False when at least one `priority_reordering` entry has an illegal numeric
   * `old_rank` for what appears to be a newly-added issue.
   */
  passed: boolean;
  /** All detected violations. Empty when `passed === true`. */
  violations: OldRankViolation[];
}

/**
 * Keywords in a `priority_reordering[*].reason` field that strongly indicate
 * the issue is newly added to the roadmap (i.e., had no prior rank and should
 * use `old_rank: null`).
 */
const NEW_ISSUE_REASON_KEYWORDS = [
  "newly added",
  "new to roadmap",
  "new to next",
  "new to planned",
  "new to ideas",
  "added to roadmap",
  "added to next",
  "added to planned",
  "added to ideas",
  "first time",
  "not previously",
  "wasn't in",
  "was not in",
  "no prior rank",
  "no previous rank",
  "no existing rank",
];

/**
 * Deterministic pre-submission validator for `priority_reordering` old_rank values.
 *
 * Scans any JSON text (typically a triage output block) for a
 * `priority_reordering` array and flags entries where `old_rank` is a number
 * (not null) but appears to refer to a newly-added issue:
 *
 *   - `old_rank === 0` — always invalid (roadmap ranks are 1-indexed)
 *   - `old_rank` is numeric AND the `reason` field contains keywords that
 *     indicate the issue is new to the backlog
 *
 * Callers should embed this in pre-dispatch validation and in the verifier's
 * triage schema compliance check.
 *
 * Returns `{ passed: true, violations: [] }` when:
 *   - The text contains no parseable `priority_reordering` array, OR
 *   - All entries have correct `old_rank` values.
 *
 * Fail-open: JSON parse errors produce `passed: true` so dispatch is never
 * blocked by a malformed-input false negative.
 *
 * @param jsonOrText - Raw text that may contain a JSON block with
 *                     `priority_reordering`.  Both bare JSON objects and
 *                     markdown-fenced blocks (```json ... ```) are supported.
 */
export function validateOldRankInPriorityReordering(
  jsonOrText: string,
): OldRankValidationResult {
  const violations: OldRankViolation[] = [];

  let parsed: unknown;
  try {
    // Strip markdown code fences if present, then try to extract the first
    // JSON object from the text.
    const stripped = jsonOrText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    // Find the first { … } JSON object in the text (handles prose wrapping JSON).
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { passed: true, violations: [] };

    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    // Unparseable — fail-open: do not block dispatch on bad input.
    return { passed: true, violations: [] };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("priority_reordering" in parsed)
  ) {
    return { passed: true, violations: [] };
  }

  const entries = (parsed as Record<string, unknown>)["priority_reordering"];
  if (!Array.isArray(entries)) return { passed: true, violations: [] };

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;

    const issueNum = typeof e["issue"] === "number" ? e["issue"] : null;
    const oldRank = e["old_rank"];
    const reason = typeof e["reason"] === "string" ? e["reason"] : "";

    // Skip entries where old_rank is null (correct for newly-added issues).
    if (oldRank === null) continue;
    if (typeof oldRank !== "number") continue;

    // Rule 1: old_rank === 0 is always invalid (ranks are 1-indexed).
    if (oldRank === 0) {
      violations.push({
        issue: issueNum ?? -1,
        old_rank: oldRank,
        reason,
        violation:
          `old_rank is 0 for issue #${issueNum ?? "?"}. ` +
          `Roadmap ranks are 1-indexed; newly-added issues must use old_rank: null.`,
      });
      continue;
    }

    // Rule 2: old_rank is a positive number but reason suggests the issue is new.
    const reasonLower = reason.toLowerCase();
    const isNewIssueByReason = NEW_ISSUE_REASON_KEYWORDS.some((kw) =>
      reasonLower.includes(kw),
    );
    if (isNewIssueByReason) {
      violations.push({
        issue: issueNum ?? -1,
        old_rank: oldRank,
        reason,
        violation:
          `old_rank is ${oldRank} for issue #${issueNum ?? "?"} but the reason ` +
          `("${reason}") indicates this issue is newly added. ` +
          `Newly-added roadmap items must use old_rank: null, not a number.`,
      });
    }
  }

  return { passed: violations.length === 0, violations };
}

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
  /**
   * Whether a prior triage submission (passed as `priorOutput` to
   * `buildTriageCoachingDirective`) passed the old_rank pre-submission
   * validator.
   *
   * - `null`  — no prior output was provided; not yet validated.
   * - `true`  — prior output had no old_rank violations.
   * - `false` — prior output contained at least one old_rank violation.
   *
   * Populated by `validateOldRankInPriorityReordering()` (issue #399).
   */
  validation_pre_check_passed: boolean | null;
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
 * @param priorOutput      Optional: text of the agent's most recent triage
 *                         submission.  When provided, `validateOldRankInPriorityReordering()`
 *                         is run on it and the result is stored in
 *                         `validation_pre_check_passed` (issue #399).
 */
export function buildTriageCoachingDirective(
  agentName: string,
  rollingScore: number,
  taskCount: number,
  missingFields: Array<{ field: string; count: number }>,
  threshold: number = TRIAGE_COACHING_THRESHOLD,
  priorOutput?: string | null,
): TriageCoachingDirective {
  const scoreStr = rollingScore.toFixed(2);
  const thresholdStr = threshold.toFixed(2);
  const allFields = TRIAGE_REQUIRED_FIELDS.join(", ");

  // Run the old_rank validator against the prior submission if available.
  let validationResult: OldRankValidationResult | null = null;
  if (priorOutput != null && priorOutput.trim().length > 0) {
    validationResult = validateOldRankInPriorityReordering(priorOutput);
  }
  const validationPreCheckPassed = validationResult?.passed ?? null;

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

  // Surface prior-output validation failures with specific details.
  if (validationResult && !validationResult.passed) {
    lines.push(
      ``,
      `⛔ Pre-submission validator FAILED on your last submission:`,
    );
    for (const v of validationResult.violations.slice(0, 3)) {
      lines.push(`  • ${v.violation}`);
    }
  }

  lines.push(
    ``,
    `Before submitting, run this pre-submission checklist:`,
    `  □ All four JSON schema fields present: ${allFields}`,
    `  □ For every entry in priority_reordering: if the issue was NOT previously`,
    `    ranked in the roadmap, set old_rank to null (never 0, never a number).`,
    `  □ Include "validation_pre_check_passed": true in your JSON output to confirm`,
    `    you ran these checks before opening the PR.`,
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
    validation_pre_check_passed: validationPreCheckPassed,
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
