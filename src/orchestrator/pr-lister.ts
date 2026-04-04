import { execFileSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";

export interface PRListItem {
  number: number;
  title: string;
  createdAt: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null;
  headRefName: string;
  body: string;
}

export interface PRRow {
  repo: string;
  number: number;
  title: string;
  ageDays: number;
  reviewStatus: "approved" | "changes-requested" | "pending";
  mergeable: "yes" | "no" | "conflict" | "unknown";
  linkedIssue: string;
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
    reviewStatus,
    mergeable,
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
          "number,title,createdAt,mergeable,reviewDecision,headRefName,body",
        ],
        { encoding: "utf-8", timeout: 30000 },
      );
      return JSON.parse(output) as PRListItem[];
    } catch {
      return [];
    }
  }

  listAll(opts: { stale?: boolean; conflicts?: boolean; repo?: string } = {}): {
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

    // Sort: conflicts first, then by age descending
    filtered.sort((a, b) => {
      if (a.mergeable === "conflict" && b.mergeable !== "conflict") return -1;
      if (b.mergeable === "conflict" && a.mergeable !== "conflict") return 1;
      return b.ageDays - a.ageDays;
    });

    return { rows: filtered, hasConflicts };
  }
}
