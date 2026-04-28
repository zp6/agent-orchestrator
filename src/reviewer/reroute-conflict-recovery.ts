/**
 * Conflict-recovery reroute metrics and alerts.
 *
 * This module powers the dashboard's reroute feed and emits Telegram alerts
 * when a specific agent's dispatch history shows an unusually high share of
 * conflict-recovery reroutes in a rolling window.
 */

import type { IStateStore, SupervisorDecisionRecord } from "../state/types.js";
import type { Notifier } from "../notify.js";
import { createLogger } from "../service/logger.js";
import {
  buildRoutingDecisions,
  classifyRoutingDecisionCategory,
  type RoutingDecisionCategory,
  type RoutingDecisionEntry,
} from "../supervisor-log.js";

const log = createLogger("reroute-conflict-recovery");

export const CONFLICT_RECOVERY_RATE_THRESHOLD = 0.2;
export const DEFAULT_REROUTE_WINDOW_HOURS = 24;
const DEFAULT_TIMELINE_LIMIT = 50;
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface AgentConflictRecoveryRate {
  agent_name: string;
  total_dispatches: number;
  conflict_recovered: number;
  conflict_recovery_rate: number;
  exceeds_threshold: boolean;
}

export interface RepoConflictRecoveryRate {
  repo: string;
  total_dispatches: number;
  conflict_recovered: number;
  conflict_recovery_rate: number;
  exceeds_threshold: boolean;
}

export interface ReroutesApiOptions {
  hours?: number;
  limit?: number;
  category?: RoutingDecisionCategory | "all";
}

export interface ReroutesApiPayload {
  generated_at: string;
  query: {
    hours: number;
    limit: number;
    category: RoutingDecisionCategory | "all";
  };
  timeline: RoutingDecisionEntry[];
  per_agent_conflict_recovery: AgentConflictRecoveryRate[];
  per_repo_conflict_recovery: RepoConflictRecoveryRate[];
}

export interface ConflictRecoveryAlertRow {
  agent_name: string;
  total_dispatches: number;
  conflict_recovered: number;
  conflict_recovery_rate: number;
  exceeds_threshold: boolean;
  top_repo?: RepoConflictRecoveryRate | null;
}

export interface ConflictRecoveryAlertPayload {
  generated_at: string;
  hours: number;
  threshold: number;
  agents: ConflictRecoveryAlertRow[];
}

function normalizeHours(hours: number | undefined): number {
  if (!Number.isFinite(hours) || (hours ?? 0) <= 0) return DEFAULT_REROUTE_WINDOW_HOURS;
  return Math.floor(hours ?? DEFAULT_REROUTE_WINDOW_HOURS);
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return DEFAULT_TIMELINE_LIMIT;
  return Math.min(Math.floor(limit ?? DEFAULT_TIMELINE_LIMIT), 1000);
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function extractRepoSlug(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/([\w.-]+\/[\w.-]+)#\d+/);
  return match ? match[1] : null;
}

function extractRepoFromDecision(decision: SupervisorDecisionRecord): string | null {
  return (
    extractRepoSlug(decision.issue_ref) ??
    extractRepoSlug(decision.message) ??
    extractRepoSlug(decision.reason) ??
    extractRepoSlug(decision.rationale)
  );
}

function isConflictRecoveryDecision(decision: SupervisorDecisionRecord): boolean {
  return classifyRoutingDecisionCategory(decision) === "conflict-re-dispatch";
}

function buildRows<T extends { total_dispatches: number; conflict_recovered: number }>(
  map: Map<string, T>,
): Array<T & { key: string; conflict_recovery_rate: number; exceeds_threshold: boolean }> {
  return Array.from(map.entries())
    .map(([key, row]) => {
      const conflict_recovery_rate = row.total_dispatches > 0 ? row.conflict_recovered / row.total_dispatches : 0;
      return {
        key,
        ...row,
        conflict_recovery_rate,
        exceeds_threshold: conflict_recovery_rate > CONFLICT_RECOVERY_RATE_THRESHOLD,
      };
    })
    .sort((a, b) => {
      const thresholdSort = Number(b.exceeds_threshold) - Number(a.exceeds_threshold);
      if (thresholdSort !== 0) return thresholdSort;
      return b.conflict_recovery_rate - a.conflict_recovery_rate || b.total_dispatches - a.total_dispatches || a.key.localeCompare(b.key);
    });
}

function groupConflictRecoveryRates(
  decisions: SupervisorDecisionRecord[],
): {
  perAgent: AgentConflictRecoveryRate[];
  perRepo: RepoConflictRecoveryRate[];
  agentRepoBreakdown: Map<string, Map<string, { total_dispatches: number; conflict_recovered: number }>>;
} {
  const agentMap = new Map<string, { total_dispatches: number; conflict_recovered: number }>();
  const repoMap = new Map<string, { total_dispatches: number; conflict_recovered: number }>();
  const agentRepoBreakdown = new Map<string, Map<string, { total_dispatches: number; conflict_recovered: number }>>();

  for (const decision of decisions) {
    if (decision.action !== "dispatch" && decision.action !== "follow-up") continue;

    const agentName = decision.agent_name ?? "unknown";
    const repo = extractRepoFromDecision(decision) ?? "(unknown)";

    const agentRow = agentMap.get(agentName) ?? { total_dispatches: 0, conflict_recovered: 0 };
    agentRow.total_dispatches += 1;
    if (isConflictRecoveryDecision(decision)) {
      agentRow.conflict_recovered += 1;
    }
    agentMap.set(agentName, agentRow);

    const repoRow = repoMap.get(repo) ?? { total_dispatches: 0, conflict_recovered: 0 };
    repoRow.total_dispatches += 1;
    if (isConflictRecoveryDecision(decision)) {
      repoRow.conflict_recovered += 1;
    }
    repoMap.set(repo, repoRow);

    const perAgentRepos =
      agentRepoBreakdown.get(agentName) ?? new Map<string, { total_dispatches: number; conflict_recovered: number }>();
    const agentRepoRow = perAgentRepos.get(repo) ?? { total_dispatches: 0, conflict_recovered: 0 };
    agentRepoRow.total_dispatches += 1;
    if (isConflictRecoveryDecision(decision)) {
      agentRepoRow.conflict_recovered += 1;
    }
    perAgentRepos.set(repo, agentRepoRow);
    agentRepoBreakdown.set(agentName, perAgentRepos);
  }

  const perAgent = buildRows(agentMap).map(({ key: agent_name, ...row }) => ({
    agent_name,
    total_dispatches: row.total_dispatches,
    conflict_recovered: row.conflict_recovered,
    conflict_recovery_rate: row.conflict_recovery_rate,
    exceeds_threshold: row.exceeds_threshold,
  }));

  const perRepo = buildRows(repoMap).map(({ key: repo, ...row }) => ({
    repo,
    total_dispatches: row.total_dispatches,
    conflict_recovered: row.conflict_recovered,
    conflict_recovery_rate: row.conflict_recovery_rate,
    exceeds_threshold: row.exceeds_threshold,
  }));

  return { perAgent, perRepo, agentRepoBreakdown };
}

/**
 * Build the reroutes payload for the dashboard.
 */
export function getReroutesApiPayload(
  store: IStateStore,
  opts: ReroutesApiOptions = {},
): ReroutesApiPayload {
  const hours = normalizeHours(opts.hours);
  const limit = normalizeLimit(opts.limit);
  const category = opts.category ?? "all";
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const decisions = store.querySupervisorDecisions({
    action: "dispatch",
    since,
    limit: 1000,
  });

  const timeline = buildRoutingDecisions(
    decisions,
    limit,
    category === "all" ? {} : { category },
  );

  const { perAgent, perRepo } = groupConflictRecoveryRates(decisions);

  return {
    generated_at: new Date().toISOString(),
    query: {
      hours,
      limit,
      category,
    },
    timeline,
    per_agent_conflict_recovery: perAgent,
    per_repo_conflict_recovery: perRepo,
  };
}

export function formatConflictRecoveryAlert(
  summary: ConflictRecoveryAlertPayload,
): string {
  const active = summary.agents.filter((agent) => agent.exceeds_threshold);
  const lines: string[] = [
    `🚨 *High conflict recovery rate*`,
    ``,
    `*Window:* last ${summary.hours}h`,
    `*Threshold:* > ${(summary.threshold * 100).toFixed(0)}% of dispatches`,
    ``,
  ];

  if (active.length === 0) {
    lines.push("No agents currently exceed the conflict recovery threshold.");
    return lines.join("\n");
  }

  for (const agent of active) {
    lines.push(
      `*${agent.agent_name}*: ${agent.conflict_recovered}/${agent.total_dispatches} dispatches recovered (${formatPct(agent.conflict_recovery_rate)})`,
    );
    if (agent.top_repo) {
      lines.push(
        `  Top repo: \`${agent.top_repo.repo}\` ${agent.top_repo.conflict_recovered}/${agent.top_repo.total_dispatches} (${formatPct(agent.top_repo.conflict_recovery_rate)})`,
      );
    }
  }

  return lines.join("\n");
}

export class ConflictRecoveryAlertMonitor {
  private lastAlertedAt = new Map<string, number>();

  constructor(
    private readonly store: IStateStore,
    private readonly notifier?: Notifier,
    private readonly opts: { hours?: number; threshold?: number; cooldownMs?: number } = {},
  ) {}

  async checkAndAlert(nowMs: number = Date.now()): Promise<boolean> {
    const hours = normalizeHours(this.opts.hours);
    const threshold = this.opts.threshold ?? CONFLICT_RECOVERY_RATE_THRESHOLD;
    const cooldownMs = this.opts.cooldownMs ?? ALERT_COOLDOWN_MS;
    const since = new Date(nowMs - hours * 60 * 60 * 1000).toISOString();

    const decisions = this.store.querySupervisorDecisions({
      action: "dispatch",
      since,
      limit: 1000,
    });
    const grouped = groupConflictRecoveryRates(decisions);
    const payload = getReroutesApiPayload(this.store, { hours, limit: 1000, category: "all" });

    const due = payload.per_agent_conflict_recovery.filter(
      (row) => row.total_dispatches > 0 && row.conflict_recovery_rate > threshold,
    );

    if (due.length === 0) return false;
    if (!this.notifier || !this.notifier.isConfigured()) {
      log.warn("Telegram notifier not configured - conflict recovery alert not routed", {
        hours,
        threshold,
        agents: due.map((row) => row.agent_name),
      });
      return false;
    }

    const active: ConflictRecoveryAlertRow[] = [];
    for (const row of due) {
      const last = this.lastAlertedAt.get(row.agent_name);
      if (last !== undefined && nowMs - last < cooldownMs) continue;

      const repoRows = grouped.agentRepoBreakdown.get(row.agent_name);
      const topRepo = repoRows
        ? Array.from(repoRows.entries())
            .map(([repo, counts]) => ({
              repo,
              total_dispatches: counts.total_dispatches,
              conflict_recovered: counts.conflict_recovered,
              conflict_recovery_rate:
                counts.total_dispatches > 0 ? counts.conflict_recovered / counts.total_dispatches : 0,
              exceeds_threshold:
                counts.total_dispatches > 0 &&
                counts.conflict_recovered / counts.total_dispatches > CONFLICT_RECOVERY_RATE_THRESHOLD,
            }))
            .sort((a, b) => b.conflict_recovery_rate - a.conflict_recovery_rate || b.total_dispatches - a.total_dispatches)
            .find((repo) => repo.conflict_recovered > 0) ?? null
        : null;

      active.push({ ...row, top_repo: topRepo });
    }

    if (active.length === 0) return false;

    const message = formatConflictRecoveryAlert({
      generated_at: new Date(nowMs).toISOString(),
      hours,
      threshold,
      agents: active,
    });

    try {
      // NOISE SUPPRESSION (#564): Conflict recovery is operational monitoring.
      // Operator should query /conflicts or /reroute-health if interested; no push notifications.
      for (const row of active) {
        this.lastAlertedAt.set(row.agent_name, nowMs);
      }
      log.info("Conflict recovery alert prepared (not sending to Telegram per #564)", {
        hours,
        threshold,
        agents: active.map((row) => row.agent_name),
      });
      return true;
    } catch (err) {
      log.error("Failed to send conflict recovery alert", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
