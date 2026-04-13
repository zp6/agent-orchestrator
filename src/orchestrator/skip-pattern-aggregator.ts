/**
 * Skip Pattern Aggregator (issue #787)
 *
 * Aggregates dispatch skip reasons from supervisor_decisions over a rolling
 * 7-day window and auto-creates GitHub issues when any single reason accounts
 * for more than SYSTEMIC_SKIP_THRESHOLD dispatches.  Deduplication ensures
 * only one open issue exists per active blocker.
 *
 * Called daily from the daemon loop.  Operators can also query the top skip
 * blockers using `orch skip-blockers`.
 *
 * When a new blocker issue is created, a Telegram alert is sent to the operator
 * so systemic dispatch blockers are surfaced in real-time rather than only at
 * the next standup (issue #795).
 */

import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, SkipPatternRow } from "../state/store.js";
import { IssueCreator } from "./issue-creator.js";
import { createLogger } from "../service/logger.js";
import { notifyOperator } from "../service/notify.js";

const log = createLogger("skip-pattern-aggregator");

/** Number of skips in 7 days that triggers auto-issue creation. */
export const SYSTEMIC_SKIP_THRESHOLD = 5;

/** Rolling window in days for pattern aggregation. */
export const SKIP_PATTERN_WINDOW_DAYS = 7;

/**
 * Derive a stable dedup key from a skip reason.
 * Lower-cases and normalises whitespace so minor phrasing differences collapse
 * to the same key.
 */
export function normaliseReasonKey(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 _\-:]/g, "")
    .trim()
    .slice(0, 120);
}

/**
 * Format the GitHub issue body for a systemic skip blocker.
 */
function formatBlockerIssueBody(
  row: SkipPatternRow,
  windowDays: number,
  orchestratorRepo: string,
): string {
  const agentList = row.affected_agents.length > 0
    ? row.affected_agents.map((a) => `- ${a}`).join("\n")
    : "- (unknown — no agent_name recorded)";

  const issueList = row.sample_issue_refs.length > 0
    ? row.sample_issue_refs.map((r) => `- ${r}`).join("\n")
    : "- (no issue refs recorded for these skips)";

  return `## Systemic Dispatch Skip Blocker

**Skip reason:** \`${row.reason}\`
**Skip count (last ${windowDays}d):** ${row.skip_count}
**First seen:** ${row.first_seen}
**Last seen:** ${row.last_seen}

### Affected agents

${agentList}

### Sample affected issue refs

${issueList}

### What this means

This skip reason has appeared **${row.skip_count} times in ${windowDays} days**, which exceeds the systemic-blocker threshold of ${SYSTEMIC_SKIP_THRESHOLD}.  The orchestrator dispatch loop is repeatedly encountering this condition and choosing not to dispatch — this likely indicates a configuration issue, missing capability, or environment problem that needs to be resolved to unblock normal dispatch flow.

### Suggested actions

1. Check the orchestrator logs for the full context around each skip decision.
2. Run \`orch decisions --outcome skipped --reason "${row.reason.slice(0, 60)}"\` to see individual decisions.
3. Fix the underlying condition so future dispatches proceed normally.
4. Close this issue once the blocker is resolved — the orchestrator will stop creating new issues for this reason once the 7-day rate drops below ${SYSTEMIC_SKIP_THRESHOLD}.

---
*Auto-created by the claude-agent-orchestrator skip-pattern aggregator.*
*Source repo: ${orchestratorRepo}*`;
}

/**
 * Run the skip-pattern aggregation check for one repo configuration.
 * Creates GitHub issues for any blockers above the threshold that don't
 * already have an open issue.
 *
 * Fires a Telegram alert for each new blocker issue created so operators
 * are notified in real-time (issue #795).
 *
 * Returns the number of new issues created.
 */
export async function runSkipPatternCheck(
  config: OrchestratorConfig,
  store: StateStore,
  orchestratorRepo = "rapartlu/agent-orchestrator",
): Promise<number> {
  const patterns = store.getSkipPatterns(SKIP_PATTERN_WINDOW_DAYS);
  const activeKeys = store.getActiveSkipPatternIssueKeys();
  const issueCreator = new IssueCreator(config);

  let created = 0;

  for (const row of patterns) {
    if (row.skip_count < SYSTEMIC_SKIP_THRESHOLD) {
      // Remaining rows are sorted by count desc — all below threshold, stop
      break;
    }

    const key = normaliseReasonKey(row.reason);

    if (activeKeys.has(key)) {
      log.info("Skip pattern already has active issue, skipping creation", {
        reason: row.reason,
        key,
        skip_count: row.skip_count,
      });
      continue;
    }

    const title = `[Orchestrator] Systemic skip blocker: ${row.reason.slice(0, 80)}`;
    const body = formatBlockerIssueBody(row, SKIP_PATTERN_WINDOW_DAYS, orchestratorRepo);

    // Dedup against existing open issues using title similarity
    if (issueCreator.isDuplicate(orchestratorRepo, title)) {
      log.info("Skip pattern issue already exists (title match), skipping creation", {
        reason: row.reason,
      });
      continue;
    }

    try {
      const issue = issueCreator.createIssue(
        orchestratorRepo,
        title,
        body,
        ["orchestrator", "dispatch-skip"],
      );

      store.recordSkipPatternIssue({
        reason_key: key,
        issue_number: issue.number,
        issue_url: issue.url,
        repo: orchestratorRepo,
      });

      log.info("Created skip-pattern blocker issue", {
        reason: row.reason,
        skip_count: row.skip_count,
        issue_number: issue.number,
        issue_url: issue.url,
      });

      // Alert the operator via Telegram so they know immediately — don't
      // wait until the next standup.  Rate-limit key is per-reason so each
      // unique blocker gets exactly one alert regardless of how many daemon
      // loops pass before the issue is resolved (issue #795).
      await notifyOperator(
        "Systemic skip pattern detected",
        `Reason: ${row.reason}\n` +
          `Affected: ${row.skip_count} skips in the last ${SKIP_PATTERN_WINDOW_DAYS}d\n` +
          `Issue #${issue.number} created: ${issue.url}`,
        "warning",
        `skip-blocker-${key}`,
      );

      created++;
    } catch (err) {
      log.warn("Failed to create skip-pattern blocker issue", {
        reason: row.reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return created;
}
