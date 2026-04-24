/**
 * Pattern risk signal consumer (issue #1149).
 *
 * The daemon writes `pattern_risk` rows to state.db on verification failure
 * whenever it detects a recurring quality risk (e.g. an agent failing the same
 * dimension repeatedly, or consecutive low scores).  Before this module, those
 * signals were orphaned — no code ever read them.
 *
 * This consumer:
 *   1. Reads `pattern_risk` signals via `IPatternRiskStore`.
 *   2. Aggregates them per agent into `AgentPatternRiskSummary` objects.
 *   3. Exposes `buildRiskContext()` which returns a formatted string suitable
 *      for injection into the improvement detector's LLM prompt, giving the
 *      model concrete evidence of systemic quality gaps alongside the normal
 *      task-history context.
 *
 * Usage (inside ImprovementDetector.analyze()):
 *
 *   const consumer = new PatternRiskConsumer(store);
 *   const riskCtx  = consumer.buildRiskContext();
 *   // Append riskCtx to the LLM prompt only when non-empty.
 */

import { createLogger } from "../service/logger.js";
import type { IPatternRiskStore, AgentPatternRiskSummary } from "../state/types.js";

const log = createLogger("pattern-risk-consumer");

/** Default look-back window used when no override is supplied. */
const DEFAULT_WINDOW_HOURS = 48;

export class PatternRiskConsumer {
  constructor(private readonly store: IPatternRiskStore) {}

  /**
   * Return aggregated per-agent risk summaries from the `pattern_risk` table.
   *
   * @param windowHours - Look-back window in hours.  Default: 48.
   */
  getSummaries(windowHours = DEFAULT_WINDOW_HOURS): AgentPatternRiskSummary[] {
    try {
      return this.store.getAgentPatternRiskSummaries(windowHours);
    } catch (err) {
      // The table may not exist yet on older deployments where the daemon
      // hasn't run the migration.  Fail gracefully so the improvement
      // detector can still run on task-history data alone.
      log.warn("Failed to read pattern_risk summaries — table may not exist yet", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Build a formatted risk-context string for injection into an LLM prompt.
   *
   * Returns an empty string when there are no signals in the look-back window
   * so callers can cheaply check `if (riskCtx)` before appending.
   *
   * @param windowHours - Look-back window in hours.  Default: 48.
   */
  buildRiskContext(windowHours = DEFAULT_WINDOW_HOURS): string {
    const summaries = this.getSummaries(windowHours);
    if (summaries.length === 0) return "";

    const lines: string[] = [
      `\n## Pattern Risk Signals (last ${windowHours}h)\n`,
      "The daemon detected the following recurring quality risk patterns on verification failure.",
      "Use these as additional evidence when suggesting improvements — prioritise agents with high mean_risk_score.\n",
    ];

    for (const s of summaries) {
      lines.push(
        `- **${s.agent_id}**: mean_risk_score=${s.mean_risk_score.toFixed(2)}, ` +
          `latest=${s.latest_risk_score.toFixed(2)}, ` +
          `signals=${s.signal_count}, ` +
          `patterns=[${s.pattern_types.join(", ")}]`,
      );
      if (s.top_detail) {
        lines.push(`  → ${s.top_detail}`);
      }
    }

    return lines.join("\n");
  }
}
