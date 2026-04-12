/**
 * Issue age monitoring — nudge operators and force-dispatch issues
 * that have been open too long without progress.
 *
 * - 14 days: Telegram nudge to operator
 * - 30 days: Auto-boost priority so next dispatch cycle picks it up
 */
import { execSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";
import { notifyOperator } from "../service/notify.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("issue-age-monitor");

const NUDGE_AGE_DAYS = 14;
const BOOST_AGE_DAYS = 30;

interface AgedIssue {
  repo: string;
  number: number;
  title: string;
  ageDays: number;
  url: string;
}

/**
 * Check all repos for issues older than thresholds.
 * Returns counts of nudged and boosted issues.
 */
export function checkAgedIssues(
  config: OrchestratorConfig,
  store: StateStore,
): { nudged: AgedIssue[]; boosted: AgedIssue[] } {
  const repos = new Set<string>();
  for (const agent of Object.values(config.agents)) {
    if (agent.github) repos.add(agent.github);
  }

  const nudged: AgedIssue[] = [];
  const boosted: AgedIssue[] = [];
  const now = Date.now();

  for (const repo of repos) {
    let issues: Array<{ number: number; title: string; created_at: string; html_url: string }>;
    try {
      const output = execSync(
        `gh api "repos/${repo}/issues?state=open&per_page=50&sort=created&direction=asc" --jq '[.[] | select(.pull_request == null) | {number, title, created_at, html_url}]'`,
        { encoding: "utf-8", timeout: 15000 },
      );
      issues = JSON.parse(output.trim() || "[]");
    } catch {
      continue;
    }

    for (const issue of issues) {
      const ageMs = now - new Date(issue.created_at).getTime();
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

      if (ageDays >= BOOST_AGE_DAYS) {
        // Force-boost priority so next dispatch picks it up
        const sourceRef = `${repo}#${issue.number}`;
        store.boostSourceRefPriority("github", sourceRef);
        boosted.push({ repo, number: issue.number, title: issue.title, ageDays, url: issue.html_url });
        log.info("Boosted aged issue priority", { repo, issue: issue.number, ageDays });
      } else if (ageDays >= NUDGE_AGE_DAYS) {
        nudged.push({ repo, number: issue.number, title: issue.title, ageDays, url: issue.html_url });
      }
    }
  }

  // Send Telegram nudge for aged issues
  if (nudged.length > 0 || boosted.length > 0) {
    const lines: string[] = [];
    if (boosted.length > 0) {
      lines.push(`*${boosted.length} issue(s) force-boosted (${BOOST_AGE_DAYS}+ days):*`);
      for (const i of boosted) {
        lines.push(`  ${i.repo}#${i.number}: ${i.title.slice(0, 50)} (${i.ageDays}d)`);
      }
    }
    if (nudged.length > 0) {
      lines.push(`*${nudged.length} issue(s) aging (${NUDGE_AGE_DAYS}+ days):*`);
      for (const i of nudged.slice(0, 5)) {
        lines.push(`  ${i.repo}#${i.number}: ${i.title.slice(0, 50)} (${i.ageDays}d)`);
      }
      if (nudged.length > 5) lines.push(`  ...and ${nudged.length - 5} more`);
    }

    notifyOperator(
      "Aged issues report",
      lines.join("\n"),
      "warning",
      `aged-issues:${new Date().toISOString().slice(0, 10)}`,
    ).catch(() => {});
  }

  return { nudged, boosted };
}
