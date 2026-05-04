/**
 * Activity Generator
 *
 * Gathers fleet activity from multiple sources (GitHub PRs, Linear issues, retro highlights)
 * for weekly changelog generation. Provides structured data for dashboard consumption.
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import type { StateStore } from "../state/store.js";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const NEX_TEAM_ID = "117390e7-d572-441e-9228-e6ad9e0efea4";
const FLEET_REPOS = [
  "rapartlu/agent-orchestrator",
  "rapartlu/agent-reviewer",
  "rapartlu/agent-dashboard",
  "rapartlu/proxy",
  "rapartlu/fleet-signer",
  "rapartlu/agent-research-agent",
];

/**
 * Weekly PR from fleet repos.
 */
export interface WeeklyPR {
  number: number;
  title: string;
  author: string;
  repo: string;
  mergedAt: string; // ISO 8601
  url: string;
  agent?: string; // extracted agent name if available
}

/**
 * Closed Linear issue in NEX team.
 */
export interface WeeklyLinearIssue {
  id: string;
  identifier: string;
  title: string;
  closedAt: string; // ISO 8601
  author: string;
  url: string;
}

/**
 * Director highlight from retro synthesis.
 */
export interface DirectorHighlight {
  title: string;
  actionItems: string[];
  date: string; // ISO 8601
}

/**
 * Complete weekly activity report ready for dashboard.
 */
export interface WeeklyActivityReport {
  weekStart: string; // ISO 8601 (Monday)
  weekEnd: string; // ISO 8601 (Sunday)

  prs: WeeklyPR[];
  linearIssues: WeeklyLinearIssue[];
  highlights: DirectorHighlight[];

  // Summary metadata
  totalPRs: number;
  totalIssuesClosed: number;
  agentSummary: { [agent: string]: { prs: number; issues: number } };

  // For dashboard to decide if publishing
  hasMeaningfulContent: boolean;
}

/**
 * Get merged PRs from all fleet repos for the given week.
 */
export async function getWeeklyMergedPRs(daysBack = 7): Promise<WeeklyPR[]> {
  const weekAgo = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const allPRs: WeeklyPR[] = [];

  for (const repo of FLEET_REPOS) {
    try {
      const output = execSync(
        `gh pr list --repo ${repo} --state merged --json number,title,author,mergedAt,url --limit 50`,
        { encoding: "utf-8", timeout: 10000 }
      );

      const prs = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      for (const pr of prs) {
        const mergedAt = new Date(pr.mergedAt);
        if (mergedAt >= weekAgo) {
          allPRs.push({
            number: pr.number,
            title: pr.title,
            author: pr.author.login || pr.author.name || "unknown",
            repo,
            mergedAt: pr.mergedAt,
            url: pr.url,
          });
        }
      }
    } catch {
      // Fail open — repo query failure doesn't block others
    }
  }

  return allPRs;
}

/**
 * Get closed Linear issues from NEX team for the given week.
 */
export async function getWeeklyClosedLinearIssues(daysBack = 7): Promise<WeeklyLinearIssue[]> {
  const envPath = join(homedir(), ".claude-orchestrator", ".env");
  let apiKey = "";

  try {
    const envContent = readFileSync(envPath, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      if (line.startsWith("LINEAR_API_KEY=")) {
        apiKey = line.split("=")[1];
        break;
      }
    }
  } catch {
    return [];
  }

  if (!apiKey || apiKey.includes("...")) {
    return [];
  }

  const weekAgo = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const query = `
    query {
      team(id: "${NEX_TEAM_ID}") {
        issues(first: 50, filter: {state: {type: {eq: "Completed"}}}) {
          nodes {
            id
            identifier
            title
            closedAt
            creator { name }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      return [];
    }

    const json = (await response.json()) as {
      data?: { team?: { issues?: { nodes?: Array<{ id: string; identifier: string; title: string; closedAt: string; creator: { name: string } }> } } };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      return [];
    }

    const issues = json.data?.team?.issues?.nodes ?? [];
    return issues
      .filter((issue) => new Date(issue.closedAt) >= new Date(weekAgo))
      .map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        closedAt: issue.closedAt,
        author: issue.creator?.name || "unknown",
        url: `https://linear.app/nexus/issue/${issue.identifier}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Get Director highlights from recent retrospective meetings.
 */
export function getDirectorHighlights(store: StateStore, daysBack = 7): DirectorHighlight[] {
  const weekAgo = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  try {
    const meetings = store.getMeetings(20);
    const highlights: DirectorHighlight[] = [];

    for (const meeting of meetings) {
      if (meeting.type !== "retrospective") continue;
      const meetingDate = new Date(meeting.date);
      if (meetingDate < weekAgo) break; // sorted DESC, so no point continuing

      try {
        const synthesis = typeof meeting.synthesis === "string" ? JSON.parse(meeting.synthesis) : meeting.synthesis;
        const actionItems = Array.isArray(synthesis?.action_items) ? synthesis.action_items : [];

        if (synthesis?.summary || actionItems.length > 0) {
          highlights.push({
            title: synthesis?.summary || "Retrospective insights",
            actionItems: actionItems.map((item: { description?: string; owner?: string } | string) =>
              typeof item === "string" ? item : item.description || ""
            ),
            date: meeting.date,
          });
        }
      } catch {
        // Skip malformed synthesis
      }
    }

    return highlights;
  } catch {
    return [];
  }
}

/**
 * Generate complete weekly activity report combining all sources.
 */
export async function generateWeeklyActivityReport(store: StateStore, daysBack = 7): Promise<WeeklyActivityReport> {
  const now = new Date();
  const weekEnd = new Date(now.getTime() - now.getDay() * 24 * 60 * 60 * 1000); // Sunday
  const weekStart = new Date(weekEnd.getTime() - 6 * 24 * 60 * 60 * 1000); // Monday

  // Gather in parallel
  const [prs, linearIssues, highlights] = await Promise.all([
    getWeeklyMergedPRs(daysBack),
    getWeeklyClosedLinearIssues(daysBack),
    Promise.resolve(getDirectorHighlights(store, daysBack)),
  ]);

  // Aggregate agent summary
  const agentSummary: { [agent: string]: { prs: number; issues: number } } = {};

  for (const pr of prs) {
    const agent = pr.agent || "unattributed";
    if (!agentSummary[agent]) {
      agentSummary[agent] = { prs: 0, issues: 0 };
    }
    agentSummary[agent].prs++;
  }

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    prs,
    linearIssues,
    highlights,
    totalPRs: prs.length,
    totalIssuesClosed: linearIssues.length,
    agentSummary,
    hasMeaningfulContent: prs.length + linearIssues.length > 0,
  };
}

/**
 * Format activity report as markdown for publication.
 */
export function formatActivityReportAsMarkdown(report: WeeklyActivityReport): string {
  const lines: string[] = [];

  lines.push(`## Week of ${report.weekStart.split("T")[0]}`);
  lines.push("");

  if (report.prs.length > 0) {
    lines.push(`### Shipped PRs (${report.prs.length})`);
    for (const pr of report.prs) {
      lines.push(`- [${pr.repo}] ${pr.title} (@${pr.author})`);
    }
    lines.push("");
  }

  if (report.linearIssues.length > 0) {
    lines.push(`### Closed Issues (${report.linearIssues.length})`);
    for (const issue of report.linearIssues) {
      lines.push(`- [${issue.identifier}] ${issue.title}`);
    }
    lines.push("");
  }

  if (report.highlights.length > 0) {
    lines.push("### Director Highlights");
    for (const highlight of report.highlights) {
      lines.push(`- **${highlight.title}**`);
      for (const item of highlight.actionItems) {
        if (item) {
          lines.push(`  - ${item}`);
        }
      }
    }
    lines.push("");
  }

  if (Object.keys(report.agentSummary).length > 0) {
    lines.push("### Agent Activity");
    for (const [agent, counts] of Object.entries(report.agentSummary)) {
      if (counts.prs > 0) {
        lines.push(`- **${agent}**: ${counts.prs} PR${counts.prs !== 1 ? "s" : ""}`);
      }
    }
  }

  return lines.join("\n");
}
