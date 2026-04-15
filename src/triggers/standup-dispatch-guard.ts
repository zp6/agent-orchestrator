import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../service/logger.js";

const execFileAsync = promisify(execFile);

const log = createLogger("standup-dispatch-guard");

export interface StandupDispatchDecision {
  skip: boolean;
  reason: string;
  actionItemCount: number;
  synthesisFailed: boolean;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}

/**
 * Fast, zero-I/O pre-filter for standup-shaped tasks.
 */
export function looksLikeStandupTask(title: string, sourceRef?: string | null): boolean {
  if (/standup/i.test(title)) return true;
  if (/\[📋 Standup\]/i.test(title)) return true;
  if (/\[🚀 Blue Sky\]/i.test(title)) return true;
  if (sourceRef?.startsWith("standup:")) return true;
  return false;
}

/**
 * Extract a GitHub issue number from a standup task reference.
 */
export function extractStandupIssueNumber(sourceRef: string | null | undefined): number | null {
  if (!sourceRef) return null;

  const standupMatch = sourceRef.match(/^standup:(\d+)$/);
  if (standupMatch) return parseInt(standupMatch[1], 10);

  const ghIssueMatch = sourceRef.match(/github-issue:[^#]+#(\d+)$/);
  if (ghIssueMatch) return parseInt(ghIssueMatch[1], 10);

  const bareMatch = sourceRef.match(/^#(\d+)$/);
  if (bareMatch) return parseInt(bareMatch[1], 10);

  const repoMatch = sourceRef.match(/#(\d+)$/);
  if (repoMatch) return parseInt(repoMatch[1], 10);

  return null;
}

/**
 * Determine whether a standup issue should be skipped and handled locally.
 *
 * This fails open on any GitHub CLI or parsing error.
 */
export async function shouldSkipStandupDispatch(
  repo: string,
  issueNumber: number,
): Promise<StandupDispatchDecision> {
  const startTime = Date.now();

  try {
    const issue = await fetchGitHubIssue(repo, issueNumber);
    if (!issue) {
      return {
        skip: false,
        reason: `Could not fetch issue #${issueNumber} from ${repo} — proceeding with dispatch`,
        actionItemCount: -1,
        synthesisFailed: false,
      };
    }

    if (!isStandupIssue(issue)) {
      return {
        skip: false,
        reason: `Issue #${issueNumber} is not a standup issue — proceeding with dispatch`,
        actionItemCount: -1,
        synthesisFailed: false,
      };
    }

    const actionItemCount = extractActionItemCount(issue);
    const synthesisFailed = isSynthesisFailed(issue);

    if (actionItemCount > 0) {
      return {
        skip: false,
        reason: `Standup #${issueNumber} has ${actionItemCount} action items — dispatching to agent`,
        actionItemCount,
        synthesisFailed,
      };
    }

    if (actionItemCount === -1) {
      return {
        skip: false,
        reason: `Could not determine action item count for standup #${issueNumber} — dispatching to be safe`,
        actionItemCount,
        synthesisFailed,
      };
    }

    const elapsed = Date.now() - startTime;
    log.info("Zero-action standup detected at dispatch time — handling without agent", {
      repo,
      issueNumber,
      elapsedMs: elapsed,
      synthesisFailed,
    });

    return {
      skip: true,
      reason: `Standup #${issueNumber} has 0 action items — auto-handled without agent dispatch (${elapsed}ms)`,
      actionItemCount: 0,
      synthesisFailed,
    };
  } catch (err) {
    log.warn("Standup dispatch guard failed — falling back to dispatch", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      skip: false,
      reason: `Guard error: ${err instanceof Error ? err.message : String(err)} — proceeding with dispatch`,
      actionItemCount: -1,
      synthesisFailed: false,
    };
  }
}

async function fetchGitHubIssue(repo: string, issueNumber: number): Promise<GitHubIssue | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "view", String(issueNumber), "--repo", repo, "--json", "number,title,body,labels,state"],
      { encoding: "utf-8", timeout: 15000 },
    );
    const raw = JSON.parse(stdout.trim()) as {
      number: number;
      title: string;
      body: string | null;
      labels: Array<{ name: string } | string>;
      state: "open" | "closed";
    };
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      labels: raw.labels.map((label) => (typeof label === "string" ? label : label.name)),
      state: raw.state,
    };
  } catch {
    return null;
  }
}

function isStandupIssue(issue: GitHubIssue): boolean {
  if (issue.labels.includes("standup") || issue.labels.includes("team-meeting")) {
    return true;
  }
  if (issue.title.includes("[📋 Standup]") || issue.title.includes("[🚀 Blue Sky]")) {
    return true;
  }
  return issue.body.includes("### Action Items");
}

function extractActionItemCount(issue: GitHubIssue): number {
  const titleMatch = issue.title.match(/—\s*(\d+)\s*action items/i);
  if (titleMatch) {
    return parseInt(titleMatch[1], 10);
  }

  const actionItemsMatch = issue.body.match(/### Action Items\n([\s\S]*?)(?:\n###|$)/);
  if (actionItemsMatch) {
    const section = actionItemsMatch[1];
    if (section.includes("No action items")) return 0;
    // Match multiple list formats: - [x], - [ ], - Item, * [x], * Item
    const items = section.match(/^[-*] (\[.\] )?\S/gm);
    if (items) return items.length;
  }

  return -1;
}

function isSynthesisFailed(issue: GitHubIssue): boolean {
  return issue.body.includes("Synthesis failed");
}

