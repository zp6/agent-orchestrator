/**
 * Cascade cap enforcer — gates dispatch of new follow-up tasks when the
 * per-trigger follow-up cap is exceeded.
 *
 * Prevents unbounded task spawning by checking the cascade depth before
 * allowing a new dispatch and optionally alerting the operator via Telegram
 * when the cap is exceeded.
 *
 * This is the integration point between the DispatchCascadeAnalyzer
 * and the dispatcher/supervisor.
 *
 * Issue #984: Dispatch cascade explorer in dashboard.
 */

import { DispatchCascadeAnalyzer } from "./dispatch-cascade-analyzer.js";
import type { Task, StateStore } from "../state/store.js";
import { createLogger } from "./logger.js";

const log = createLogger("cascade-cap-enforcer");

/** Function type for sending notifications (e.g., Telegram alerts). */
export type NotifyFn = (message: string) => Promise<void>;

export interface CascadeCapEnforcerOptions {
  /**
   * Maximum depth of cross-repo follow-ups allowed from a single trigger.
   * Default: 2 (e.g., PR review → implementation → follow-up, no deeper).
   */
  maxCrossRepoFollowupDepth?: number;
  /**
   * Whether to alert on Telegram when a cascade cap is exceeded.
   * Default: true.
   */
  alertOnCapExceeded?: boolean;
}

/**
 * Enforcer that prevents task dispatch when cascade caps are exceeded.
 */
export class CascadeCapEnforcer {
  private analyzer: DispatchCascadeAnalyzer;
  private alertOnCapExceeded: boolean;

  constructor(
    store: StateStore,
    private notifyFn: NotifyFn | undefined,
    opts: CascadeCapEnforcerOptions = {},
  ) {
    this.analyzer = new DispatchCascadeAnalyzer(store, {
      maxCrossRepoFollowupDepth: opts.maxCrossRepoFollowupDepth,
    });
    this.alertOnCapExceeded = opts.alertOnCapExceeded !== false;
  }

  /**
   * Check if a new dispatch should be allowed for a given task.
   *
   * @param task              The task that would spawn a child task
   * @param isFollowUp        Whether this is a cross-repo follow-up dispatch
   * @returns                 Decision with reason
   */
  canDispatch(task: Task, isFollowUp: boolean): { allowed: boolean; reason?: string } {
    // Only check caps for cross-repo follow-up tasks
    if (!isFollowUp) {
      return { allowed: true };
    }

    // Check if the cascade cap allows another follow-up
    const cascadeResult = this.analyzer.canDispatchFollowUp(task.id);

    if (!cascadeResult.allowed) {
      const cascade = this.analyzer.analyzeCascade(task.id);

      // Alert operator if configured
      if (this.alertOnCapExceeded && cascade && this.notifyFn) {
        this.alertCapExceeded(cascade).catch((err) => {
          log.error("Failed to send cascade cap alert", { error: String(err) });
        });
      }

      log.warn("Dispatch blocked by cascade cap", {
        task_id: task.id.slice(0, 8),
        reason: cascadeResult.reason,
      });

      return {
        allowed: false,
        reason: cascadeResult.reason || "Dispatch cascade cap exceeded",
      };
    }

    return { allowed: true };
  }

  /**
   * Private helper to send a Telegram alert when cap is exceeded.
   */
  private async alertCapExceeded(cascade: ReturnType<DispatchCascadeAnalyzer["analyzeCascade"]>): Promise<void> {
    if (!this.notifyFn || !cascade) return;

    const message = this.analyzer.formatCapExceededAlert(cascade);
    await this.notifyFn(message);

    log.info("Cascade cap exceeded alert sent", {
      root_task_id: cascade.root_task_id.slice(0, 8),
      followup_count: cascade.cross_repo_followup_count,
    });
  }
}

/** Export for use in supervisor/dispatcher */
export function createCascadeCapEnforcer(
  store: StateStore,
  notifyFn: NotifyFn | undefined,
  opts?: CascadeCapEnforcerOptions,
): CascadeCapEnforcer {
  return new CascadeCapEnforcer(store, notifyFn, opts);
}
