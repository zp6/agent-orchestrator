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
  number: number;
  title: string;
  ageDays: number;
  lastPushDays: number;
  reviewStatus: "approved" | "changes-requested" | "pending";
  mergeable: "yes" | "no" | "conflict" | "unknown";
  ciStatus: "passing" | "failing" | "pending" | "none";
  linkedIssue: string;
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

export function toPRRow(item: PRListItem, repo: string, now: Date = new Date()): PRRow {
  const createdAt = new Date(item.createdAt);
  const ageDays = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

  const updatedAt = item.updatedAt ? new Date(item.updatedAt) : createdAt;
  const lastPushDays = Math.floor((now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));

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

  return {
    repo,
    number: item.number,
    title: item.title,
    ageDays,
    lastPushDays,
    reviewStatus,
    mergeable,
    ciStatus: rollupCIStatus(item.statusCheckRollup),
    linkedIssue: extractLinkedIssue(item.body ?? ""),
  };
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

  listAll(opts: { stale?: boolean; conflicts?: boolean; ciFailed?: boolean; repo?: string } = {}): {
    rows: PRRow[];
    hasConflicts: boolean;
  } {
    const repos = opts.repo
      ? [opts.repo]
      : Object.values(this.config.agents)
          .filter((a) => a.github)
          .map((a) => a.github!)
          .filter((r, i, arr) => arr.indexOf(r) === i);

    const allRows: PRRow[] = [];

    for (const repo of repos) {
      const prs = this.fetchOpenPRs(repo);
      for (const pr of prs) {
        allRows.push(toPRRow(pr, repo));
      }
    }

    const hasConflicts = allRows.some((r) => r.mergeable === "conflict");

    let filtered = allRows;
    if (opts.stale) {
      filtered = filtered.filter((r) => r.ageDays >= 3);
    }
    if (opts.conflicts) {
      filtered = filtered.filter((r) => r.mergeable === "conflict");
    }
    if (opts.ciFailed) {
      filtered = filtered.filter((r) => r.ciStatus === "failing");
    }

    // Sort: conflicts first, then by age descending
    filtered.sort((a, b) => {
      if (a.mergeable === "conflict" && b.mergeable !== "conflict") return -1;
      if (b.mergeable === "conflict" && a.mergeable !== "conflict") return 1;
      return b.ageDays - a.ageDays;
    });

    return { rows: filtered, hasConflicts };
  }
}
