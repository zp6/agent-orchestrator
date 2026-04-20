/**
 * Reviewer Misrouting Digest — Daily Telegram Summary (issue #382)
 *
 * Generates a daily Telegram digest listing every task dispatched to the
 * reviewer agent in the last 24 hours that matched an implementation task
 * type (feature, fix, or cross-repo-followup). Each entry shows the task
 * title, dispatched agent, suggested correct agent (inferred from repo
 * ownership), and issue link.
 *
 * Operators can immediately see routing drift and tune dispatch policies.
 *
 * The digest fires once per day at the configured hour (default: 09:00 UTC).
 * The last-sent timestamp is persisted in `system_flags` so the digest
 * survives process restarts without resending.
 *
 * Usage (from the daemon):
 *
 *   import { MisroutingDigestScheduler } from './reviewer/misrouting-digest.js';
 *   const scheduler = new MisroutingDigestScheduler(store, notifier, config);
 *   // Call once per poll cycle:
 *   await scheduler.maybeFireDigest();
 */

import { createLogger } from "../service/logger.js";
import type { Notifier } from "../notify.js";
import type { ReviewerConfig } from "../config.js";
import type { Task } from "../state/types.js";
import { buildRepoOwnerMap, extractRepoFromSourceRef } from "./routing-violations.js";

const log = createLogger("misrouting-digest");

/** System-flag key storing the ISO date of the last misrouting digest send. */
export const FLAG_LAST_MISROUTING_DIGEST_SENT = "misrouting_digest_last_sent";

/** Lookback window for misrouted tasks: 24 hours. */
export const MISROUTING_LOOKBACK_HOURS = 24;

/** The reviewer agent names — tasks dispatched to these are checked. */
export const REVIEWER_AGENT_NAMES: ReadonlyArray<string> = [
  "claude-orchestrator-reviewer",
  "codex-orchestrator-reviewer",
];

/**
 * Task types considered "implementation" — these should not land on the reviewer.
 * The issue specifies: feature, fix, cross-repo-followup.
 * In the DB, task_type is "implementation" for both feature and fix.
 * We also detect cross-repo-followup via task title patterns.
 */
export const IMPLEMENTATION_TASK_TYPES: ReadonlyArray<string> = [
  "implementation",
];

/**
 * Title patterns that indicate cross-repo followup tasks.
 * These are implementation tasks created as follow-ups on foreign repos.
 */
export const CROSS_REPO_FOLLOWUP_PATTERNS: ReadonlyArray<RegExp> = [
  /cross-repo/i,
  /follow-?up/i,
];

/** A single entry in the misrouting digest. */
export interface MisroutingDigestEntry {
  /** Task ID (truncated for display). */
  task_id: string;
  /** Human-readable task title. */
  task_title: string;
  /** Agent that received the task. */
  dispatched_agent: string;
  /** Agent that should have received the task (inferred from repo ownership). */
  suggested_agent: string | null;
  /** GitHub issue link (e.g. "rapartlu/agent-orchestrator#123"). */
  issue_link: string | null;
  /** Detected category: "implementation" | "cross-repo-followup". */
  category: "implementation" | "cross-repo-followup";
}

/** The complete misrouting digest report. */
export interface MisroutingDigestReport {
  /** ISO timestamp when the report was generated. */
  generated_at: string;
  /** Number of hours looked back. */
  lookback_hours: number;
  /** Misrouted entries found. */
  entries: MisroutingDigestEntry[];
}

/**
 * Minimal store interface needed by the misrouting digest.
 * This keeps the module testable with a simple mock.
 */
export interface IMisroutingDigestStore {
  /** List tasks matching criteria. */
  listTasks(opts: { status?: string; agent_name?: string; limit?: number }): Task[];
  /** Get a system flag value. */
  getSystemFlag(key: string): string | null;
  /** Set a system flag value. */
  setSystemFlag(key: string, value: string): void;
}

/**
 * Classify whether a task is a misrouted implementation task on the reviewer.
 *
 * Returns the category if misrouted, or null if the task is fine.
 */
export function classifyMisroutedTask(task: Task): "implementation" | "cross-repo-followup" | null {
  // Check explicit task_type
  if (IMPLEMENTATION_TASK_TYPES.includes(task.task_type)) {
    // Check for cross-repo followup patterns in title
    for (const pattern of CROSS_REPO_FOLLOWUP_PATTERNS) {
      if (pattern.test(task.title)) {
        return "cross-repo-followup";
      }
    }
    return "implementation";
  }
  return null;
}

/**
 * Build a MisroutingDigestReport from the live database.
 *
 * Queries all tasks dispatched to reviewer agents in the lookback window
 * and filters for implementation-type tasks that should have gone elsewhere.
 */
export function buildMisroutingDigest(
  store: IMisroutingDigestStore,
  config: ReviewerConfig,
  opts: { lookbackHours?: number } = {},
): MisroutingDigestReport {
  const lookbackHours = opts.lookbackHours ?? MISROUTING_LOOKBACK_HOURS;
  const cutoff = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();
  const repoOwnerMap = buildRepoOwnerMap(config.agents);

  const entries: MisroutingDigestEntry[] = [];

  for (const agentName of REVIEWER_AGENT_NAMES) {
    // Fetch recent tasks assigned to this reviewer agent
    const tasks = store.listTasks({ agent_name: agentName, limit: 200 });

    for (const task of tasks) {
      // Only consider tasks created within the lookback window
      if (task.created_at < cutoff) continue;

      const category = classifyMisroutedTask(task);
      if (!category) continue;

      // Determine suggested agent from repo ownership
      const repo = extractRepoFromSourceRef(task.source_ref);
      const suggestedAgent = repo ? (repoOwnerMap.get(repo) ?? null) : null;

      entries.push({
        task_id: task.id,
        task_title: task.title,
        dispatched_agent: agentName,
        suggested_agent: suggestedAgent,
        issue_link: task.source_ref ?? null,
        category,
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    lookback_hours: lookbackHours,
    entries,
  };
}

/**
 * Format a MisroutingDigestReport as a Telegram Markdown message.
 */
export function formatMisroutingDigest(report: MisroutingDigestReport): string {
  const lines: string[] = [
    `🔀 *Reviewer Misrouting Digest*`,
    `_${new Date(report.generated_at).toUTCString()}_`,
    ``,
  ];

  if (report.entries.length === 0) {
    lines.push(`✅ No implementation tasks landed on the reviewer in the last ${report.lookback_hours}h.`);
    lines.push(``);
    lines.push(`_Routing policies are working correctly._`);
    return lines.join("\n");
  }

  lines.push(
    `⚠️ *${report.entries.length} implementation task${report.entries.length !== 1 ? "s" : ""} dispatched to reviewer in the last ${report.lookback_hours}h:*`,
  );
  lines.push(``);

  for (let i = 0; i < report.entries.length; i++) {
    const entry = report.entries[i];
    const taskIdShort = entry.task_id.slice(0, 8);
    const categoryLabel = entry.category === "cross-repo-followup" ? "cross-repo" : "impl";

    lines.push(`${i + 1}. \\[${categoryLabel}\\] *${escapeMarkdown(entry.task_title.slice(0, 80))}*`);
    lines.push(`   Task: \`${taskIdShort}\` → Agent: \`${entry.dispatched_agent}\``);

    if (entry.suggested_agent) {
      lines.push(`   ✳️ Suggested: \`${entry.suggested_agent}\``);
    }

    if (entry.issue_link) {
      lines.push(`   🔗 ${entry.issue_link}`);
    }

    lines.push(``);
  }

  lines.push(`_Review dispatch policies if misrouting persists._`);

  return lines.join("\n");
}

/**
 * Escape special Markdown characters in task titles to prevent Telegram parse errors.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

/**
 * Manages the daily misrouting digest schedule.
 *
 * Default: fires once per day at 09:00 UTC (matching issue acceptance criteria).
 */
export class MisroutingDigestScheduler {
  private store: IMisroutingDigestStore;
  private notifier: Notifier;
  private config: ReviewerConfig;
  /** Hour of day (UTC) at which to fire the digest. */
  private digestHourUtc: number;

  constructor(
    store: IMisroutingDigestStore,
    notifier: Notifier,
    config: ReviewerConfig,
    opts: { digestHourUtc?: number } = {},
  ) {
    this.store = store;
    this.notifier = notifier;
    this.config = config;
    this.digestHourUtc = opts.digestHourUtc ?? 9;
  }

  /**
   * Called once per daemon poll cycle. Fires the digest if:
   *  - The current UTC hour matches `digestHourUtc`, and
   *  - The digest has not already been sent today (calendar date in UTC).
   *
   * @returns true if the digest was sent, false if skipped.
   */
  async maybeFireDigest(): Promise<boolean> {
    const now = new Date();
    const currentHourUtc = now.getUTCHours();
    if (currentHourUtc !== this.digestHourUtc) return false;

    const todayUtc = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const lastSent = this.store.getSystemFlag(FLAG_LAST_MISROUTING_DIGEST_SENT);

    // Already sent today
    if (lastSent && lastSent >= todayUtc) return false;

    try {
      const report = buildMisroutingDigest(this.store, this.config);
      const message = formatMisroutingDigest(report);
      await this.notifier.send(message);

      this.store.setSystemFlag(FLAG_LAST_MISROUTING_DIGEST_SENT, todayUtc);
      log.info("Misrouting digest sent", {
        entries: report.entries.length,
        lookbackHours: report.lookback_hours,
      });
      return true;
    } catch (err) {
      log.error("Failed to send misrouting digest", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
