/**
 * Standup issue handler — processes zero-action standup issues.
 *
 * When the orchestrator runs standup meetings, it creates GitHub issues with
 * synthesized action items. If a standup has 0 action items, the reviewer:
 * 1. Posts a lightweight acknowledgment comment (no PR)
 * 2. Optionally closes the issue if all referenced PRs are merged
 *
 * This prevents zero-action standups from creating noise in the PR queue.
 */

import { execSync } from "child_process";
import { createLogger } from "../service/logger.js";

const log = createLogger("standup-handler");

/**
 * GitHub issue metadata needed for standup processing.
 */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}

/**
 * Detects if a GitHub issue is a standup meeting issue.
 *
 * Checks for:
 * - Label "standup" (primary indicator)
 * - Title containing "[📋 Standup]" or "[🚀 Blue Sky]" pattern
 * - Body containing "### Action Items" section (meeting format)
 */
export function isStandupIssue(issue: GitHubIssue): boolean {
  // Check for standup or team-meeting labels
  if (issue.labels.includes("standup") || issue.labels.includes("team-meeting")) {
    return true;
  }

  // Check for standup title pattern
  if (issue.title.includes("[📋 Standup]") || issue.title.includes("[🚀 Blue Sky]")) {
    return true;
  }

  // Check for meeting body format
  if (issue.body.includes("### Action Items")) {
    return true;
  }

  return false;
}

/**
 * Extracts the number of action items from a standup issue.
 *
 * Tries multiple detection methods:
 * 1. Count from issue title (e.g., "— 0 action items")
 * 2. Count lines starting with "- [" in Action Items section
 * 3. Check for "No action items." text
 *
 * Returns 0 if no items found or parsing fails.
 */
export function extractActionItemCount(issue: GitHubIssue): number {
  // Try to extract from title: "— N action items"
  const titleMatch = issue.title.match(/—\s*(\d+)\s*action items/i);
  if (titleMatch) {
    return parseInt(titleMatch[1], 10);
  }

  // Try to count from body: Action Items section
  const actionItemsMatch = issue.body.match(/### Action Items\n([\s\S]*?)(?:\n###|$)/);
  if (actionItemsMatch) {
    const section = actionItemsMatch[1];

    // Check for explicit "No action items"
    if (section.includes("No action items")) {
      return 0;
    }

    // Count bullet points (- [PRIORITY])
    const items = section.match(/^- \[/gm);
    if (items) {
      return items.length;
    }
  }

  // If we can't determine, assume non-zero to be safe
  return -1;
}

/**
 * Extracts PR references from an issue body.
 *
 * Finds all #N pattern references to GitHub issues/PRs.
 * Returns array of PR numbers.
 */
export function extractPRReferences(body: string): number[] {
  const matches = body.matchAll(/#(\d+)/g);
  const prNumbers = new Set<number>();

  for (const match of matches) {
    prNumbers.add(parseInt(match[1], 10));
  }

  return Array.from(prNumbers).sort((a, b) => a - b);
}

/**
 * Builds an acknowledgment comment for a zero-action standup.
 *
 * Extracts synthesis and blockers from the standup issue and formats
 * them into a brief acknowledgment that won't trigger PR creation.
 */
export function buildStandupAcknowledgmentComment(issue: GitHubIssue): string {
  const lines: string[] = [
    "**[orchestrator] Standup acknowledged** 📋",
    "",
    "This standup has no action items. The following synthesis and blockers have been noted:",
    "",
  ];

  // Extract synthesis section
  const synthesisMatch = issue.body.match(/### Synthesis\n([\s\S]*?)(?:\n###|$)/);
  if (synthesisMatch) {
    const synthesis = synthesisMatch[1].trim();
    // Truncate long syntheses to 500 chars
    if (synthesis.length > 500) {
      lines.push(`**Synthesis:** ${synthesis.substring(0, 497)}...`);
    } else {
      lines.push(`**Synthesis:** ${synthesis}`);
    }
    lines.push("");
  }

  // Extract blockers if present
  const blockersMatch = issue.body.match(/## Blockers?[\n\r]+([\s\S]*?)(?:\n##|$)/);
  if (blockersMatch) {
    const blockers = blockersMatch[1].trim();
    if (blockers && !blockers.includes("No blockers")) {
      lines.push("**Blockers:**");
      lines.push(blockers);
      lines.push("");
    }
  }

  // Extract goal adjustments if present
  const goalsMatch = issue.body.match(/### Goal Adjustments\n([\s\S]*?)(?:\n###|$)/);
  if (goalsMatch) {
    const goals = goalsMatch[1].trim();
    if (goals && !goals.includes("No adjustments")) {
      lines.push("**Goal Adjustments:**");
      lines.push(goals);
      lines.push("");
    }
  }

  lines.push("No PR will be created for this standup since there are no action items to track.");

  return lines.join("\n");
}

/**
 * Posts an acknowledgment comment on a standup issue and optionally closes it.
 *
 * @param repo - Repository in owner/repo format
 * @param issueNumber - GitHub issue number
 * @param issue - Issue metadata (for synthesis extraction)
 * @param autoClose - Whether to close the issue if all referenced PRs are merged
 */
export async function handleZeroActionStandup(
  repo: string,
  issueNumber: number,
  issue: GitHubIssue,
  autoClose = true,
): Promise<void> {
  try {
    // Build and post acknowledgment comment
    const comment = buildStandupAcknowledgmentComment(issue);

    execSync(
      `gh issue comment ${issueNumber} --repo ${shellEscape(repo)} --body ${shellEscape(comment)}`,
      { encoding: "utf-8", timeout: 30000 },
    );

    log.info("Posted standup acknowledgment comment", {
      repo,
      issueNumber,
      actionItems: extractActionItemCount(issue),
    });

    // Optionally close if all referenced PRs are merged
    if (autoClose) {
      await closeResolvedStandup(repo, issueNumber, issue);
    }
  } catch (err) {
    log.error("Failed to handle zero-action standup", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Closes a standup issue if all referenced PRs are merged.
 *
 * Extracts PR references from issue body and checks merge status.
 * Only closes if:
 * - Issue is currently open
 * - All referenced PRs exist and are merged
 * - At least one PR is referenced
 */
export async function closeResolvedStandup(
  repo: string,
  issueNumber: number,
  issue: GitHubIssue,
): Promise<void> {
  if (issue.state === "closed") {
    log.info("Standup issue already closed", { repo, issueNumber });
    return;
  }

  const prNumbers = extractPRReferences(issue.body);

  if (prNumbers.length === 0) {
    log.info("No PR references found in standup, skipping auto-close", {
      repo,
      issueNumber,
    });
    return;
  }

  try {
    // Check if all referenced PRs are merged
    let allMerged = true;
    const prStatuses: Record<number, string> = {};

    for (const prNum of prNumbers) {
      try {
        const output = execSync(
          `gh pr view ${prNum} --repo ${shellEscape(repo)} --json state,merged --jq '.merged'`,
          { encoding: "utf-8", timeout: 10000 },
        ).trim();

        const isMerged = output === "true";
        prStatuses[prNum] = isMerged ? "merged" : "open";

        if (!isMerged) {
          allMerged = false;
        }
      } catch {
        // PR might not exist or be accessible
        prStatuses[prNum] = "inaccessible";
        allMerged = false;
      }
    }

    if (allMerged) {
      // Post closing comment
      const closingComment =
        "**[orchestrator] Resolving standup** — All referenced PRs have been merged. ✅";

      execSync(
        `gh issue comment ${issueNumber} --repo ${shellEscape(repo)} --body ${shellEscape(closingComment)}`,
        { encoding: "utf-8", timeout: 30000 },
      );

      // Close the issue
      execSync(`gh issue close ${issueNumber} --repo ${shellEscape(repo)}`, {
        encoding: "utf-8",
        timeout: 30000,
      });

      log.info("Closed resolved standup issue", {
        repo,
        issueNumber,
        referencedPRs: prNumbers,
      });
    } else {
      log.info("Not all referenced PRs merged, keeping standup open", {
        repo,
        issueNumber,
        prStatuses,
      });
    }
  } catch (err) {
    log.warn("Failed to check/close resolved standup", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    // Don't throw — allow the acknowledgment comment to stand even if closure fails
  }
}

/**
 * Escape a string for safe use in shell commands.
 */
function shellEscape(s: string): string {
  if (!s) return "''";
  // If string contains special characters, wrap in single quotes and escape any single quotes
  if (/[^a-zA-Z0-9._/-]/.test(s)) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  return s;
}
