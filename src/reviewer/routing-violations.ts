/**
 * Routing violation detector — identifies and alerts when tasks are dispatched
 * to agents that do not own the target repository (issue #293).
 *
 * The detector scans recently completed/in-progress tasks and checks whether
 * the dispatched agent's configured `github` field matches the repo extracted
 * from the task's `source_ref`. When they diverge, a routing violation is
 * recorded in state.db and a Telegram alert fires.
 *
 * Usage (from the daemon or verifier):
 *
 *   const detector = new RoutingViolationDetector(store, config, notifier);
 *   await detector.scan();  // run once per daemon cycle
 */

import { createLogger } from "../service/logger.js";
import type { ReviewerConfig, AgentConfig } from "../config.js";
import type { ITelegramStateStore, Task, RoutingViolation } from "../state/types.js";
import type { Notifier } from "../notify.js";

const log = createLogger("routing-violations");

/**
 * Extract the GitHub repo slug (owner/repo) from a source_ref like "owner/repo#123".
 * Returns null if the source_ref doesn't match the expected pattern.
 */
export function extractRepoFromSourceRef(sourceRef: string | null | undefined): string | null {
  if (!sourceRef) return null;
  const match = sourceRef.match(/^([^#]+)#\d+$/);
  return match ? match[1] : null;
}

/**
 * Build a map of repo slug -> agent name from the config.
 * An agent "owns" a repo if its `github` field matches the repo slug.
 */
export function buildRepoOwnerMap(agents: Record<string, AgentConfig>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [agentName, agentConf] of Object.entries(agents)) {
    if (agentConf.github) {
      map.set(agentConf.github, agentName);
    }
  }
  return map;
}

/**
 * Check whether a task represents a routing violation.
 *
 * A violation occurs when:
 *   1. The task has both an agent_name and a source_ref with a parseable repo
 *   2. The dispatched agent's configured github repo does NOT match the target repo
 *   3. There IS a known owner for the target repo (avoids false positives for
 *      repos not in the config)
 */
export function detectViolation(
  task: Task,
  repoOwnerMap: Map<string, string>,
  agents: Record<string, AgentConfig>,
): RoutingViolation | null {
  if (!task.agent_name || !task.source_ref) return null;

  const targetRepo = extractRepoFromSourceRef(task.source_ref);
  if (!targetRepo) return null;

  // Look up who should own this repo
  const expectedAgent = repoOwnerMap.get(targetRepo);
  if (!expectedAgent) return null; // repo not in config — can't determine violation

  // Check if the dispatched agent owns this repo
  const agentConf = agents[task.agent_name];
  if (agentConf?.github === targetRepo) return null; // correct routing

  return {
    task_id: task.id,
    agent_name: task.agent_name,
    target_repo: targetRepo,
    expected_agent: expectedAgent,
    dispatched_at: task.created_at,
    detected_at: new Date().toISOString(),
    task_title: task.title,
  };
}

export interface RoutingViolationDetectorOptions {
  /** Max tasks to scan per cycle. Default: 50. */
  scanLimit?: number;
}

/**
 * Scans recent tasks for agent-to-repo routing violations.
 *
 * Designed to be called once per daemon cycle. It:
 *   1. Fetches recent dispatched/in_progress/done tasks
 *   2. Checks each against the repo ownership map
 *   3. Records new violations to state.db (dedup by task_id)
 *   4. Fires a Telegram alert for each new violation
 */
export class RoutingViolationDetector {
  private readonly repoOwnerMap: Map<string, string>;
  private readonly scanLimit: number;

  constructor(
    private readonly store: ITelegramStateStore,
    private readonly config: ReviewerConfig,
    private readonly notifier?: Notifier,
    opts: RoutingViolationDetectorOptions = {},
  ) {
    this.repoOwnerMap = buildRepoOwnerMap(config.agents);
    this.scanLimit = opts.scanLimit ?? 50;
  }

  /**
   * Scan recent tasks and record/alert on any new routing violations.
   * Returns the list of newly detected violations (empty if none).
   */
  async scan(): Promise<RoutingViolation[]> {
    // Get recent tasks that could be mis-routed.
    const candidates = [
      ...this.store.listTasks({ status: "dispatched", limit: this.scanLimit }),
      ...this.store.listTasks({ status: "in_progress", limit: this.scanLimit }),
      ...this.store.listTasks({ status: "done", limit: this.scanLimit }),
    ];

    // Dedup: get existing violations to avoid re-recording
    const existing = this.store.getRoutingViolations(200);
    const existingTaskIds = new Set(existing.map((v) => v.task_id));

    const newViolations: RoutingViolation[] = [];

    for (const task of candidates) {
      if (existingTaskIds.has(task.id)) continue;

      const violation = detectViolation(task, this.repoOwnerMap, this.config.agents);
      if (!violation) continue;

      try {
        this.store.recordRoutingViolation(violation);
        newViolations.push(violation);
        existingTaskIds.add(task.id); // prevent double-recording within the same scan

        log.warn("Routing violation detected", {
          taskId: task.id,
          agent: violation.agent_name,
          targetRepo: violation.target_repo,
          expectedAgent: violation.expected_agent,
        });
      } catch (err) {
        log.error("Failed to record routing violation", {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fire Telegram alerts for new violations
    if (newViolations.length > 0 && this.notifier?.isConfigured()) {
      await this.alertViolations(newViolations);
    }

    if (newViolations.length > 0) {
      log.info("Routing violation scan complete", {
        scanned: candidates.length,
        newViolations: newViolations.length,
      });
    }

    return newViolations;
  }

  /**
   * Fire a consolidated Telegram alert for new routing violations.
   */
  private async alertViolations(violations: RoutingViolation[]): Promise<void> {
    if (!this.notifier) return;

    const lines: string[] = [
      `\u26a0\ufe0f *Routing violation${violations.length > 1 ? "s" : ""} detected* (${violations.length})`,
      ``,
    ];

    for (const v of violations.slice(0, 5)) {
      const shortId = v.task_id.slice(0, 8);
      const title = (v.task_title ?? "").slice(0, 45);
      lines.push(`\u274c \`${shortId}\` — ${title}`);
      lines.push(`  Agent: \`${v.agent_name}\` \u2192 Repo: \`${v.target_repo}\``);
      lines.push(`  Expected: \`${v.expected_agent ?? "unknown"}\``);
      lines.push(``);
    }

    if (violations.length > 5) {
      lines.push(`_...and ${violations.length - 5} more. Run \`/routing-violations\` for the full list._`);
    }

    lines.push(`_Run \`/routing-violations\` to see the full feed._`);

    try {
      await this.notifier.notifyOperator(
        "Agent-to-repo routing violation",
        lines.join("\n"),
        "high",
      );
    } catch (err) {
      log.error("Failed to send routing violation Telegram alert", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Format routing violations for CLI/API display.
 */
export function formatViolationsForDisplay(violations: RoutingViolation[]): string {
  if (violations.length === 0) {
    return "No routing violations detected.";
  }

  const lines: string[] = [
    `Routing Violations (${violations.length}):`,
    `${"─".repeat(80)}`,
    `${"Task ID".padEnd(12)} ${"Agent".padEnd(28)} ${"Target Repo".padEnd(30)} ${"Expected Agent".padEnd(28)} ${"Dispatched"}`,
    `${"─".repeat(80)}`,
  ];

  for (const v of violations) {
    const shortId = v.task_id.slice(0, 10);
    const agent = v.agent_name.slice(0, 26);
    const repo = v.target_repo.slice(0, 28);
    const expected = (v.expected_agent ?? "unknown").slice(0, 26);
    const dispatched = v.dispatched_at.replace("T", " ").slice(0, 19);
    lines.push(
      `${shortId.padEnd(12)} ${agent.padEnd(28)} ${repo.padEnd(30)} ${expected.padEnd(28)} ${dispatched}`,
    );
  }

  return lines.join("\n");
}
