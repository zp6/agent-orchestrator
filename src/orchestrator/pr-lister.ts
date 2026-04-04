import { execFileSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";

export interface StatusCheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PRListItem {
  number: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null;
  headRefName: string;
  body: string;
  statusCheckRollup: StatusCheck[] | null;
}

export interface PRRow {
  repo: string;
  /** Agent name from config (e.g. "cheese-hater"), or empty string if unknown. */
  agent: string;
  number: number;
  title: string;
  ageDays: number;
  staleDays: number;
  reviewStatus: "approved" | "changes-requested" | "pending";
  mergeable: "yes" | "no" | "conflict" | "unknown";
  ciStatus: "passing" | "failing" | "pending" | "none";
  linkedIssue: string;
  /**
   * Primary merge-readiness signal: the highest-priority blocker, or "ready"
   * when all signals are green.
   *
   * Priority (highest → lowest):
   *   conflict > ci-failing > changes-requested > needs-review > stale > ready
   */
  mergeReady: "ready" | "conflict" | "ci-failing" | "changes-requested" | "needs-review" | "stale";
}

export function rollupCIStatus(checks: StatusCheck[] | null | undefined): PRRow["ciStatus"] {
  if (!checks || checks.length === 0) return "none";
  const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"]);
  const IN_PROGRESS = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"]);
  let anyPending = false;
  for (const check of checks) {
    if (check.conclusion && FAILING.has(check.conclusion.toUpperCase())) return "failing";
    if (!check.conclusion || IN_PROGRESS.has(check.status?.toUpperCase() ?? "")) {
      anyPending = true;
    }
  }
  if (anyPending) return "pending";
  return "passing";
}

export function extractLinkedIssue(body: string): string {
  const match = body?.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  return match ? `#${match[1]}` : "—";
}

export function formatAge(days: number): string {
  if (days < 1) return "< 1d";
  if (days === 1) return "1d";
  return `${days}d`;
}

export function formatStaleDays(days: number): string {
  if (days < 1) return "< 1d";
  if (days === 1) return "1d";
  if (days > 7) return `>${days}d`;
  return `${days}d`;
}

/**
 * Compute the primary merge-readiness blocker for a PR row.
 * Returns "ready" only when all signals are green.
 */
export function computeMergeReady(row: Omit<PRRow, "mergeReady" | "agent">): PRRow["mergeReady"] {
  if (row.mergeable === "conflict") return "conflict";
  if (row.ciStatus === "failing") return "ci-failing";
  if (row.reviewStatus === "changes-requested") return "changes-requested";
  if (row.reviewStatus === "pending") return "needs-review";
  if (row.staleDays >= 7) return "stale";
  return "ready";
}

export function toPRRow(item: PRListItem, repo: string, now: Date = new Date(), agentName = ""): PRRow {
  const createdAt = new Date(item.createdAt);
  const ageDays = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

  // staleDays: days since last push/update (updatedAt), falls back to createdAt
  const updatedAt = item.updatedAt ? new Date(item.updatedAt) : createdAt;
  const staleDays = Math.floor((now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));

  let reviewStatus: PRRow["reviewStatus"];
  if (item.reviewDecision === "APPROVED") {
    reviewStatus = "approved";
  } else if (item.reviewDecision === "CHANGES_REQUESTED") {
    reviewStatus = "changes-requested";
  } else {
    reviewStatus = "pending";
  }

  let mergeable: PRRow["mergeable"];
  if (item.mergeable === "MERGEABLE") {
    mergeable = "yes";
  } else if (item.mergeable === "CONFLICTING") {
    mergeable = "conflict";
  } else {
    mergeable = "unknown";
  }

  const ciStatus = rollupCIStatus(item.statusCheckRollup);
  const partial = {
    repo,
    agent: agentName,
    number: item.number,
    title: item.title,
    ageDays,
    staleDays,
    reviewStatus,
    mergeable,
    ciStatus,
    linkedIssue: extractLinkedIssue(item.body ?? ""),
  };
  return { ...partial, mergeReady: computeMergeReady(partial) };
}

export class PRLister {
  constructor(private config: OrchestratorConfig) {}

  fetchOpenPRs(repo: string): PRListItem[] {
    try {
      const output = execFileSync(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--json",
          "number,title,createdAt,updatedAt,mergeable,reviewDecision,headRefName,body,statusCheckRollup",
        ],
        { encoding: "utf-8", timeout: 30000 },
      );
      return JSON.parse(output) as PRListItem[];
    } catch {
      return [];
    }
  }

  /** Build a map of github-repo → agent-name for fast lookup. */
  private buildRepoToAgentMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [name, agent] of Object.entries(this.config.agents)) {
      if (agent.github) {
        // If multiple agents share a repo, last one wins (rare edge case)
        map.set(agent.github, name);
      }
    }
    return map;
  }

  listAll(
    opts: {
      stale?: boolean;
      staleDays?: number;
      conflicts?: boolean;
      conflict?: boolean;
      ciFailed?: boolean;
      repo?: string;
      /** Filter by agent name (e.g. "cheese-hater") */
      agent?: string;
    } = {},
  ): {
    rows: PRRow[];
    hasConflicts: boolean;
  } {
    const repoToAgent = this.buildRepoToAgentMap();

    // When filtering by agent name, derive the repo from config.
    // If the agent exists but has no github, return empty immediately.
    let repos: string[];
    if (opts.repo) {
      repos = [opts.repo];
    } else if (opts.agent !== undefined) {
      const agentRepo = this.config.agents[opts.agent]?.github;
      repos = agentRepo ? [agentRepo] : [];
    } else {
      repos = Object.values(this.config.agents)
        .filter((a) => a.github)
        .map((a) => a.github!)
        .filter((r, i, arr) => arr.indexOf(r) === i);
    }

    const allRows: PRRow[] = [];

    for (const repo of repos) {
      const agentName = repoToAgent.get(repo) ?? "";
      const prs = this.fetchOpenPRs(repo);
      for (const pr of prs) {
        allRows.push(toPRRow(pr, repo, new Date(), agentName));
      }
    }

    const hasConflicts = allRows.some((r) => r.mergeable === "conflict");

    let filtered = allRows;
    if (opts.stale) {
      filtered = filtered.filter((r) => r.staleDays >= 3);
    }
    if (opts.staleDays !== undefined) {
      filtered = filtered.filter((r) => r.staleDays >= opts.staleDays!);
    }
    if (opts.conflicts || opts.conflict) {
      filtered = filtered.filter((r) => r.mergeable === "conflict");
    }
    if (opts.ciFailed) {
      filtered = filtered.filter((r) => r.ciStatus === "failing");
    }

    // Sort: conflicts first, then by staleness descending
    filtered.sort((a, b) => {
      if (a.mergeable === "conflict" && b.mergeable !== "conflict") return -1;
      if (b.mergeable === "conflict" && a.mergeable !== "conflict") return 1;
      return b.staleDays - a.staleDays;
    });

    return { rows: filtered, hasConflicts };
  }
}
