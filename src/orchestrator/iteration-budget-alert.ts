/**
 * Iteration budget alert (issue #763).
 *
 * Checks for GitHub issues whose cumulative revision count has exceeded the
 * configured ceiling and fires a Telegram alert via notifyOperator().
 *
 * Default ceiling: 3 revision rounds per issue.
 *
 * The check is intentionally lightweight — it reads only from state.db so
 * it can run on every improvement cycle without incurring LLM costs.
 */

import type { StateStore } from "../state/store.js";
import { notifyOperator } from "../service/notify.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("iteration-budget-alert");

/**
 * Default revision ceiling before an alert fires.
 * Configurable via `runIterationBudgetAlerts()` opts.
 */
export const DEFAULT_REVISION_CEILING = 3;

/**
 * Look-back window for the budget check (calendar days).
 */
export const BUDGET_ALERT_WINDOW_DAYS = 30;

export interface IterationBudgetAlertOpts {
  /** Max revision rounds before alerting (default: 3). */
  ceiling?: number;
  /** Look-back window in days (default: 30). */
  windowDays?: number;
}

/**
 * Run the iteration budget check and fire Telegram alerts for issues that
 * have exceeded the configured revision ceiling.
 *
 * Rate-limiting is handled by notifyOperator() (one alert per source_ref
 * per 15 minutes by default), so calling this on every daemon cycle is safe.
 *
 * @param store - StateStore instance.
 * @param opts  - Optional ceiling/window overrides.
 */
export async function runIterationBudgetAlerts(
  store: StateStore,
  opts: IterationBudgetAlertOpts = {},
): Promise<void> {
  const ceiling = opts.ceiling ?? DEFAULT_REVISION_CEILING;
  const windowDays = opts.windowDays ?? BUDGET_ALERT_WINDOW_DAYS;

  let overBudget: Array<{
    source_ref: string;
    total_revisions: number;
    agent_name: string | null;
    last_updated_at: string;
  }>;

  try {
    overBudget = store.getOverBudgetIssues(ceiling, windowDays);
  } catch (err) {
    log.warn("Failed to query over-budget issues", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (overBudget.length === 0) return;

  log.info("Over-budget issues detected", {
    count: overBudget.length,
    ceiling,
  });

  for (const issue of overBudget) {
    const agent = issue.agent_name ?? "unknown agent";
    const url = sourceRefToUrl(issue.source_ref);

    const title = `Revision budget exceeded: ${issue.source_ref}`;
    const body = [
      `Issue *${issue.source_ref}* has accumulated *${issue.total_revisions}* revision rounds`,
      `(ceiling: ${ceiling}, assigned to: ${agent}).`,
      url ? `\nView: ${url}` : "",
      `\nLast updated: ${issue.last_updated_at.split("T")[0]}`,
    ]
      .filter(Boolean)
      .join(" ");

    await notifyOperator(title, body, "warning", `iteration-budget:${issue.source_ref}`);

    log.info("Iteration budget alert sent", {
      source_ref: issue.source_ref,
      total_revisions: issue.total_revisions,
      ceiling,
    });
  }
}

/**
 * Convert a source_ref ("owner/repo#42") to a GitHub URL.
 * Returns null when the format is not recognised.
 */
export function sourceRefToUrl(sourceRef: string): string | null {
  const match = sourceRef.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (!match) return null;
  return `https://github.com/${match[1]}/issues/${match[2]}`;
}
