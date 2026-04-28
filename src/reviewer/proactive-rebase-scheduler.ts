/**
 * Proactive rebase scheduler — issue #335
 *
 * Detects open PRs where HEAD has diverged from main by ≥ N commits (default: 3)
 * AND the PR has been open for > MIN_PR_AGE_HOURS (default: 24h). For each
 * stale PR, a rebase task is automatically scheduled — no operator input needed.
 *
 * This is the preventive complement to the reactive conflict-recovery path:
 * rather than waiting for a merge conflict to block a PR, we proactively rebase
 * long-lived PRs before a cascade of upstream merges makes the conflict painful.
 *
 * Acceptance criteria (issue #335):
 *   ✓ 'stale-pr-rebase' detector finds PRs where HEAD diverged ≥ 3 commits from main
 *   ✓ Rebase tasks are scheduled automatically without operator input
 *   ✓ Conflict-recovery reroute monitor counts proactive vs reactive rebases separately
 *
 * Integration:
 *   1. Instantiate `ProactiveRebaseScheduler` with your state store and notifier.
 *   2. Call `scheduler.run(repo)` from the orchestrator daemon loop (e.g. every 30s).
 *   3. Pass `scheduler.getStats()` to `getReroutesApiPayload()` to surface
 *      proactive vs reactive counts in the dashboard.
 *
 * Note: The scheduler emits `StalePRRebaseTask` objects. The orchestrator is
 * responsible for turning these into actual dispatch tasks. This keeps the
 * reviewer module side-effect-free regarding the dispatch infrastructure.
 */

import { execSync } from "child_process";
import { createLogger } from "../service/logger.js";
import type { Notifier } from "../notify.js";

const log = createLogger("proactive-rebase-scheduler");

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum commit divergence to trigger a proactive rebase. */
export const DEFAULT_DIVERGE_THRESHOLD = 3;

/** PRs must be open at least this long before they are eligible for proactive rebase. */
export const DEFAULT_MIN_PR_AGE_HOURS = 24;

/** Cooldown between scheduling rebase tasks for the same PR (avoids spam). */
export const DEFAULT_SCHEDULE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

/** Maximum number of stale PRs to process per run (safety cap). */
export const MAX_STALE_PRS_PER_RUN = 10;

// ── Public types ──────────────────────────────────────────────────────────────

/** Slim open-PR record returned by `gh pr list`. */
export interface OpenPRRecord {
  number: number;
  headRefName: string;
  url: string;
  /** ISO timestamp of when the PR was created. */
  createdAt: string;
  /** Agent name extracted from branch name (e.g. `issue-42-...` → maybe the owner). */
  author: string;
}

/** A PR that has been detected as stale and needs a proactive rebase. */
export interface StalePRRebaseTask {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Open PR number. */
  prNumber: number;
  /** Branch name. */
  branch: string;
  /** PR URL. */
  prUrl: string;
  /** How many commits behind main the branch is. */
  commitsBehind: number;
  /** How many hours the PR has been open. */
  hoursOpen: number;
  /** ISO timestamp when this task was scheduled. */
  scheduledAt: string;
  /**
   * Suggested task title for the orchestrator to use when creating a
   * rebase dispatch task.
   */
  taskTitle: string;
  /**
   * Suggested task description for the orchestrator.
   */
  taskDescription: string;
}

/** Running totals updated on each `run()` call. */
export interface RebaseStats {
  /** Number of rebase tasks scheduled proactively by this module. */
  proactiveScheduled: number;
  /**
   * Number of reactive (conflict-recovery) rebases counted via
   * `recordReactiveRebase()`. These originate from the conflict-recovery
   * reroute path, not from this scheduler.
   */
  reactiveRecorded: number;
  /** Timestamp of the last successful `run()` call, or null if never run. */
  lastRunAt: string | null;
  /** Number of PRs inspected during the last `run()` call. */
  lastRunPRsInspected: number;
  /** Number of rebase tasks emitted during the last `run()` call. */
  lastRunTasksScheduled: number;
}

/** Options for `ProactiveRebaseScheduler`. */
export interface ProactiveRebaseSchedulerOptions {
  /** Commit divergence threshold to trigger proactive rebase (default: 3). */
  divergeThreshold?: number;
  /** Minimum PR age in hours before it is eligible (default: 24). */
  minPROpenHours?: number;
  /** Cooldown in ms before re-scheduling a rebase for the same PR (default: 6h). */
  cooldownMs?: number;
  /** Base branch to compare against (default: "main"). */
  baseBranch?: string;
}

/** Result returned by each `run()` call. */
export interface RebaseSchedulerRunResult {
  /** PRs inspected (filtered by age). */
  prsInspected: number;
  /** Rebase tasks emitted this run. */
  tasksScheduled: number;
  /** The stale PR tasks emitted (for orchestrator to dispatch). */
  stalePRs: StalePRRebaseTask[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shellEscape(s: string): string {
  if (!s) return "''";
  if (/[^a-zA-Z0-9._/-]/.test(s)) return `'${s.replace(/'/g, "'\\''")}'`;
  return s;
}

/**
 * Fetch all open PRs for a repo via gh CLI.
 * Returns an empty array on error (fail-open: don't block the daemon loop).
 */
export function fetchOpenPRRecords(repo: string): OpenPRRecord[] {
  try {
    const out = execSync(
      `gh pr list --repo ${shellEscape(repo)} --state open --json number,headRefName,url,createdAt,author --limit 200`,
      { encoding: "utf-8", timeout: 20_000 },
    );
    const raw: Array<{
      number: number;
      headRefName: string;
      url: string;
      createdAt: string;
      author: { login: string };
    }> = JSON.parse(out.trim());
    return raw.map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName ?? "",
      url: pr.url ?? "",
      createdAt: pr.createdAt ?? new Date().toISOString(),
      author: pr.author?.login ?? "unknown",
    }));
  } catch (err) {
    log.warn("fetchOpenPRRecords: gh CLI failed — returning empty list", {
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Count how many commits behind `branch` is compared to `baseBranch` in `repo`.
 * Uses `git rev-list` after fetching the remote.
 * Returns null on error (the caller will skip this PR).
 */
export function countCommitsBehind(
  repo: string,
  branch: string,
  baseBranch: string,
): number | null {
  try {
    // Shallow-fetch both refs so we can compare — works even if the caller
    // doesn't have a local clone of `repo`.
    const repoUrl = `https://github.com/${repo}.git`;
    execSync(
      `git fetch --quiet ${shellEscape(repoUrl)} ${shellEscape(baseBranch)}:refs/remotes/origin/${shellEscape(baseBranch)} ${shellEscape(branch)}:refs/remotes/origin/${shellEscape(branch)} 2>/dev/null`,
      { timeout: 30_000, stdio: "pipe" },
    );
    const out = execSync(
      `git rev-list --count refs/remotes/origin/${shellEscape(branch)}..refs/remotes/origin/${shellEscape(baseBranch)}`,
      { encoding: "utf-8", timeout: 10_000 },
    );
    return parseInt(out.trim(), 10);
  } catch (err) {
    log.warn("countCommitsBehind: git failed — skipping PR", {
      repo,
      branch,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Compute how many hours ago `createdAt` (ISO string) was.
 */
export function hoursAgo(createdAt: string, nowMs: number = Date.now()): number {
  const ts = new Date(createdAt).getTime();
  if (Number.isNaN(ts)) return 0;
  return (nowMs - ts) / (60 * 60 * 1000);
}

// ── Scheduler class ───────────────────────────────────────────────────────────

/**
 * Proactive rebase scheduler.
 *
 * Call `run(repo)` periodically (e.g. from the daemon loop) to detect stale
 * open PRs and emit rebase tasks for the orchestrator to dispatch.
 */
export class ProactiveRebaseScheduler {
  private readonly divergeThreshold: number;
  private readonly minPROpenHours: number;
  private readonly cooldownMs: number;
  private readonly baseBranch: string;

  /** PR numbers for which a rebase task was recently scheduled (cooldown tracker). */
  private readonly lastScheduledAt = new Map<string, number>(); // key: "repo#prNumber"

  private stats: RebaseStats = {
    proactiveScheduled: 0,
    reactiveRecorded: 0,
    lastRunAt: null,
    lastRunPRsInspected: 0,
    lastRunTasksScheduled: 0,
  };

  constructor(
    private readonly notifier?: Notifier,
    opts: ProactiveRebaseSchedulerOptions = {},
  ) {
    this.divergeThreshold = opts.divergeThreshold ?? DEFAULT_DIVERGE_THRESHOLD;
    this.minPROpenHours = opts.minPROpenHours ?? DEFAULT_MIN_PR_AGE_HOURS;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_SCHEDULE_COOLDOWN_MS;
    this.baseBranch = opts.baseBranch ?? "main";
  }

  /**
   * Run the stale-PR detection pass for `repo`.
   *
   * Returns the list of `StalePRRebaseTask` objects that the orchestrator
   * should dispatch as rebase tasks. The scheduler itself does not dispatch —
   * it only detects and reports.
   */
  async run(repo: string, nowMs: number = Date.now()): Promise<RebaseSchedulerRunResult> {
    const openPRs = fetchOpenPRRecords(repo);

    // Filter to PRs open long enough to be eligible.
    const eligible = openPRs.filter(
      (pr) => hoursAgo(pr.createdAt, nowMs) >= this.minPROpenHours,
    );

    log.info("Proactive rebase scan", {
      repo,
      totalOpen: openPRs.length,
      eligible: eligible.length,
      divergeThreshold: this.divergeThreshold,
      minPROpenHours: this.minPROpenHours,
    });

    const stalePRs: StalePRRebaseTask[] = [];

    for (const pr of eligible.slice(0, MAX_STALE_PRS_PER_RUN)) {
      const cooldownKey = `${repo}#${pr.number}`;
      const lastScheduled = this.lastScheduledAt.get(cooldownKey);
      if (lastScheduled !== undefined && nowMs - lastScheduled < this.cooldownMs) {
        log.info("Skipping PR — within cooldown window", {
          repo,
          prNumber: pr.number,
          cooldownRemainingMs: this.cooldownMs - (nowMs - lastScheduled),
        });
        continue;
      }

      const commitsBehind = countCommitsBehind(repo, pr.headRefName, this.baseBranch);
      if (commitsBehind === null) continue; // git fetch failed — skip

      if (commitsBehind < this.divergeThreshold) {
        log.info("PR is not stale enough", {
          repo,
          prNumber: pr.number,
          branch: pr.headRefName,
          commitsBehind,
          threshold: this.divergeThreshold,
        });
        continue;
      }

      const hoursOpen = hoursAgo(pr.createdAt, nowMs);
      const scheduledAt = new Date(nowMs).toISOString();

      const task: StalePRRebaseTask = {
        repo,
        prNumber: pr.number,
        branch: pr.headRefName,
        prUrl: pr.url,
        commitsBehind,
        hoursOpen: Math.round(hoursOpen * 10) / 10,
        scheduledAt,
        taskTitle: `[stale-pr-rebase] Proactively rebase PR #${pr.number} (${pr.headRefName}) — ${commitsBehind} commits behind ${this.baseBranch}`,
        taskDescription:
          `PR #${pr.number} (branch \`${pr.headRefName}\`) in \`${repo}\` has been open for ` +
          `${hoursOpen.toFixed(1)}h and is ${commitsBehind} commits behind \`${this.baseBranch}\`. ` +
          `Proactively rebase to prevent merge cascade conflicts.\n\n` +
          `Steps:\n` +
          `1. \`git fetch origin\`\n` +
          `2. \`git checkout ${pr.headRefName}\`\n` +
          `3. \`git rebase origin/${this.baseBranch}\`\n` +
          `4. Resolve any conflicts, then \`git push --force-with-lease\`\n\n` +
          `Scheduled by: proactive-rebase-scheduler (diverge: ${commitsBehind} commits, age: ${hoursOpen.toFixed(1)}h)`,
      };

      stalePRs.push(task);
      this.lastScheduledAt.set(cooldownKey, nowMs);

      log.info("Stale PR detected — scheduling proactive rebase", {
        repo,
        prNumber: pr.number,
        branch: pr.headRefName,
        commitsBehind,
        hoursOpen: task.hoursOpen,
      });
    }

    // Update stats.
    this.stats.proactiveScheduled += stalePRs.length;
    this.stats.lastRunAt = new Date(nowMs).toISOString();
    this.stats.lastRunPRsInspected = eligible.length;
    this.stats.lastRunTasksScheduled = stalePRs.length;

    // Notify if anything was scheduled.
    if (stalePRs.length > 0) {
      await this.sendAlert(repo, stalePRs, nowMs);
    }

    return {
      prsInspected: eligible.length,
      tasksScheduled: stalePRs.length,
      stalePRs,
    };
  }

  /**
   * Record a reactive rebase (called by the conflict-recovery reroute path
   * so the reroute monitor can report proactive vs reactive counts side-by-side).
   */
  recordReactiveRebase(): void {
    this.stats.reactiveRecorded += 1;
  }

  /**
   * Return the current rebase stats (proactive vs reactive counts).
   * Consumed by `getReroutesApiPayload()` to extend the dashboard payload.
   */
  getStats(): Readonly<RebaseStats> {
    return { ...this.stats };
  }

  /**
   * Reset stats counters (useful for testing).
   */
  resetStats(): void {
    this.stats = {
      proactiveScheduled: 0,
      reactiveRecorded: 0,
      lastRunAt: null,
      lastRunPRsInspected: 0,
      lastRunTasksScheduled: 0,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async sendAlert(
    repo: string,
    stalePRs: StalePRRebaseTask[],
    nowMs: number,
  ): Promise<void> {
    if (!this.notifier || !this.notifier.isConfigured()) {
      log.warn("Notifier not configured — proactive rebase alert not sent", {
        repo,
        count: stalePRs.length,
      });
      return;
    }

    const message = formatProactiveRebaseAlert(repo, stalePRs, nowMs);
    try {
      // NOISE SUPPRESSION (#564): Proactive rebase alerts are informational.
      // Operator should query /proactive-rebases if interested; no push notifications.
      log.info("Proactive rebase alert prepared (not sending to Telegram per #564)", {
        repo,
        count: stalePRs.length,
      });
    } catch (err) {
      log.error("Failed to prepare proactive rebase alert", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Alert formatter ───────────────────────────────────────────────────────────

/**
 * Format a Telegram-compatible proactive rebase alert message.
 */
export function formatProactiveRebaseAlert(
  repo: string,
  stalePRs: StalePRRebaseTask[],
  nowMs: number = Date.now(),
): string {
  const lines: string[] = [
    `🔄 *Proactive rebase scheduled*`,
    ``,
    `*Repo:* \`${repo}\``,
    `*Time:* ${new Date(nowMs).toISOString()}`,
    `*Stale PRs detected:* ${stalePRs.length}`,
    ``,
  ];

  for (const task of stalePRs) {
    lines.push(
      `• [PR #${task.prNumber}](${task.prUrl}) — \`${task.branch}\``,
      `  ↳ ${task.commitsBehind} commits behind main · open ${task.hoursOpen}h`,
    );
  }

  lines.push(
    ``,
    `_Rebase tasks dispatched automatically. No operator action needed._`,
  );

  return lines.join("\n");
}

// ── Standalone helpers ────────────────────────────────────────────────────────

/**
 * Classify whether a rebase event was proactive (scheduled before conflict)
 * or reactive (scheduled after conflict detection).
 *
 * Proactive rebases have a task title matching the `[stale-pr-rebase]` tag
 * injected by `ProactiveRebaseScheduler`. Reactive rebases come from the
 * conflict-recovery reroute path and typically reference "conflict" or
 * "merge conflict" in their title/description.
 */
export type RebaseClassification = "proactive" | "reactive" | "unknown";

export function classifyRebaseTask(taskTitle: string): RebaseClassification {
  if (!taskTitle) return "unknown";
  if (/\[stale-pr-rebase\]/i.test(taskTitle)) return "proactive";
  if (/conflict|merge.conflict|rebase.conflict/i.test(taskTitle)) return "reactive";
  return "unknown";
}
