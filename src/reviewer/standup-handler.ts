/**
 * Standup issue handler — processes zero-action standup issues.
 *
 * When the orchestrator runs standup meetings, it creates GitHub issues with
 * synthesized action items. If a standup has 0 action items, the reviewer:
 * 1. Posts a lightweight acknowledgment comment (no PR)
 * 2. Optionally closes the issue if all referenced PRs are merged
 *
 * When synthesis fails (LLM error), the reviewer detects the failure sentinel
 * and retries fallback action-item generation (up to 2x) by querying open
 * GitHub issues directly. This ensures standup reports never ship with 0
 * action items unless there are genuinely no open issues.
 *
 * This prevents zero-action standups from creating noise in the PR queue.
 */

import { execSync } from "child_process";
import { createLogger } from "../service/logger.js";
import type { StandupSynthesisLabel, IStandupHealthStore } from "../state/types.js";
import type { Notifier } from "../notify.js";

export type { StandupSynthesisLabel };

const log = createLogger("standup-handler");

/** Sentinel text written by the orchestrator when synthesis LLM call fails. */
const SYNTHESIS_FAILURE_SENTINEL = "Synthesis failed";

/**
 * Threshold for auto-escalation: if more than this many fallback events occur
 * in a rolling 24h window, send a Telegram alert.
 */
const FALLBACK_ESCALATION_THRESHOLD = 2;

/**
 * GitHub label definitions for synthesis confidence badges.
 * Each label is created idempotently before being applied.
 */
const SYNTHESIS_LABEL_DEFS: Record<StandupSynthesisLabel, { color: string; description: string }> = {
  synthesized: {
    color: "0e8a16",
    description: "Standup synthesis succeeded — action items were generated",
  },
  "synthesis-fallback": {
    color: "e4e669",
    description: "Standup synthesis fell back — 0 action items after synthesis",
  },
  "empty-retry": {
    color: "d93f0b",
    description: "Standup synthesis still empty after retry — manual review suggested",
  },
};

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
 * Detects whether the standup issue's synthesis step failed.
 *
 * The orchestrator writes a canonical failure sentinel into the Synthesis
 * section when the LLM call fails (network error, timeout, rate limit, etc.).
 * This function checks for that sentinel so the reviewer can attempt recovery.
 */
export function isSynthesisFailed(issue: GitHubIssue): boolean {
  return issue.body.includes(SYNTHESIS_FAILURE_SENTINEL);
}

/**
 * Detect the synthesis confidence label for a standup issue.
 *
 * Rules (applied in order):
 * 1. If the issue has action items (count > 0) → `synthesized`
 * 2. If already labelled synthesis-fallback + still 0 items → `empty-retry`
 * 3. If synthesis sentinel present or 0 items → `synthesis-fallback`
 * 4. Otherwise → `synthesized`
 */
export function detectSynthesisLabel(issue: GitHubIssue): StandupSynthesisLabel {
  const actionItemCount = extractActionItemCount(issue);

  // Has real action items → success
  if (actionItemCount > 0) {
    return "synthesized";
  }

  // Check for a retry scenario: already labelled synthesis-fallback + still empty
  const alreadyFallback =
    issue.labels.includes("synthesis-fallback") || issue.labels.includes("empty-retry");
  if (alreadyFallback && actionItemCount === 0) {
    return "empty-retry";
  }

  // Synthesis failed (sentinel present) or genuinely 0 items
  if (isSynthesisFailed(issue) || actionItemCount === 0) {
    return "synthesis-fallback";
  }

  return "synthesized";
}

/**
 * Ensure a synthesis confidence label exists on GitHub and apply it to an issue.
 *
 * Creates the label in the repo if it doesn't exist yet (idempotent via --force).
 * Errors are swallowed and logged — label stamping is best-effort and should
 * never block the main standup handling flow.
 *
 * @param repo - Repository in owner/repo format
 * @param issueNumber - GitHub issue number to label
 * @param label - Synthesis confidence label to apply
 */
export function applyGitHubSynthesisLabel(
  repo: string,
  issueNumber: number,
  label: StandupSynthesisLabel,
): void {
  const def = SYNTHESIS_LABEL_DEFS[label];

  try {
    // Ensure the label exists in the repo (idempotent via --force flag)
    try {
      execSync(
        `gh label create ${shellEscape(label)} --repo ${shellEscape(repo)} --color ${def.color} --description ${shellEscape(def.description)} --force`,
        { encoding: "utf-8", timeout: 15000 },
      );
    } catch {
      // Label may already exist without --force support on older gh versions — ignore
    }

    // Apply the label to the issue
    execSync(
      `gh issue edit ${issueNumber} --repo ${shellEscape(repo)} --add-label ${shellEscape(label)}`,
      { encoding: "utf-8", timeout: 15000 },
    );

    log.info("Applied synthesis confidence label to standup issue", {
      repo,
      issueNumber,
      label,
    });
  } catch (err) {
    log.warn("Failed to apply synthesis label — continuing without badge", {
      repo,
      issueNumber,
      label,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Check the rolling 24h fallback count and auto-escalate to Telegram if needed.
 *
 * Escalates when more than `FALLBACK_ESCALATION_THRESHOLD` (2) synthesis
 * fallbacks are recorded within the last 24 hours.
 *
 * @param store - State store implementing IStandupHealthStore
 * @param notifier - Telegram notifier
 */
export async function checkAndEscalateFallbackThreshold(
  store: IStandupHealthStore,
  notifier: Notifier,
): Promise<void> {
  try {
    const health = store.getStandupHealth(1); // 1-day window for escalation check
    if (health.should_escalate) {
      // NOISE SUPPRESSION (#564): Standup synthesis fallback is an operational metric.
      // Operator should query /standup-quality if interested; no push notifications.
      log.warn("Standup synthesis fallback threshold exceeded (not sending to Telegram per #564)", {
        fallback_count_24h: health.fallback_count_24h,
        threshold: FALLBACK_ESCALATION_THRESHOLD,
      });
    }
  } catch (err) {
    log.warn("Failed to check standup fallback threshold", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fetch open issues from a GitHub repo using gh CLI.
 *
 * Returns an array of `{ number, title }` objects, or an empty array on error.
 * Errors are silenced so callers can treat missing data as "no issues".
 */
function fetchOpenGitHubIssues(
  repo: string,
  limit = 10,
): Array<{ number: number; title: string }> {
  try {
    const output = execSync(
      `gh issue list --repo ${shellEscape(repo)} --state open --limit ${limit} --json number,title`,
      { encoding: "utf-8", timeout: 15000 },
    );
    const parsed = JSON.parse(output.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Generate a minimal action-item list from open GitHub issues.
 *
 * Queries each repo in `repos` for its open issues and converts them into
 * action items that ask the team to review/triage them. Returns an empty
 * array when there are genuinely no open issues across all repos.
 *
 * @param repos - List of repos (owner/repo) to query
 * @param issuesPerRepo - Max issues to pull from each repo (default: 5)
 * @param maxTotal - Hard cap on total action items returned (default: 10)
 */
export function generateFallbackActionItems(
  repos: string[],
  issuesPerRepo = 5,
  maxTotal = 10,
): Array<{ priority: string; description: string; owner: string }> {
  const items: Array<{ priority: string; description: string; owner: string }> = [];

  for (const repo of repos) {
    if (items.length >= maxTotal) break;

    const issues = fetchOpenGitHubIssues(repo, issuesPerRepo);

    for (const issue of issues) {
      if (items.length >= maxTotal) break;
      items.push({
        priority: "MEDIUM",
        description: `[${repo}] Triage open issue #${issue.number}: ${issue.title}`,
        owner: "orchestrator",
      });
    }
  }

  return items;
}

/**
 * Attempt to rescue a failed synthesis by generating fallback action items.
 *
 * When the orchestrator's synthesis LLM call fails, standup issues are created
 * with 0 action items. This function retries the fallback up to `maxRetries`
 * times (default: 2), querying open GitHub issues directly and posting a
 * supplementary comment so the standup is never completely empty.
 *
 * Returns `true` if fallback items were successfully posted, `false` when
 * there are genuinely no open issues (acceptable empty standup) or all
 * retry attempts failed.
 *
 * @param repo - Repository in owner/repo format (for the comment target)
 * @param issueNumber - Standup issue number to comment on
 * @param fallbackRepos - Repos to query for open issues (defaults to [repo])
 * @param maxRetries - How many attempts to make (default: 2)
 */
export async function postFallbackActionItems(
  repo: string,
  issueNumber: number,
  fallbackRepos?: string[],
  maxRetries = 2,
): Promise<boolean> {
  const repos = fallbackRepos && fallbackRepos.length > 0 ? fallbackRepos : [repo];
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const items = generateFallbackActionItems(repos);

      if (items.length === 0) {
        log.info("No open issues found across repos — fallback has no items to generate", {
          repo,
          issueNumber,
          repos,
          attempt,
        });
        return false; // Genuinely empty — acceptable standup
      }

      const lines: string[] = [
        "**[orchestrator] Synthesis fallback — action items recovered from open issues** ⚠️",
        "",
        "_The original synthesis step failed. The following action items were generated from open GitHub issues as a fallback to ensure this standup is not empty:_",
        "",
        "### Fallback Action Items",
        "",
      ];

      for (const item of items) {
        lines.push(`- [${item.priority}] ${item.description} (owner: ${item.owner})`);
      }

      lines.push("");
      lines.push(
        `_${items.length} action item(s) recovered from ${repos.length} repo(s). Attempt ${attempt}/${maxRetries}._`,
      );

      const comment = lines.join("\n");

      execSync(
        `gh issue comment ${issueNumber} --repo ${shellEscape(repo)} --body ${shellEscape(comment)}`,
        { encoding: "utf-8", timeout: 30000 },
      );

      log.info("Posted fallback action items derived from open issues", {
        repo,
        issueNumber,
        itemCount: items.length,
        repos,
        attempt,
      });

      return true;
    } catch (err) {
      lastError = err;
      log.warn("Fallback action item attempt failed, will retry if attempts remain", {
        repo,
        issueNumber,
        attempt,
        maxRetries,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.error("All fallback action item attempts exhausted", {
    repo,
    issueNumber,
    maxRetries,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });

  return false;
}

/**
 * Posts an acknowledgment comment on a standup issue and optionally closes it.
 *
 * @param repo - Repository in owner/repo format
 * @param issueNumber - GitHub issue number
 * @param issue - Issue metadata (for synthesis extraction)
 * @param autoClose - Whether to close the issue if all referenced PRs are merged
 * @param fallbackRepos - Additional repos to query when synthesis fails (for fallback items)
 * @param store - Optional state store for recording synthesis health events
 * @param notifier - Optional Telegram notifier for fallback escalation alerts
 */
export async function handleZeroActionStandup(
  repo: string,
  issueNumber: number,
  issue: GitHubIssue,
  autoClose = true,
  fallbackRepos?: string[],
  store?: IStandupHealthStore,
  notifier?: Notifier,
): Promise<void> {
  try {
    // Build and post acknowledgment comment
    const comment = buildStandupAcknowledgmentComment(issue);

    execSync(
      `gh issue comment ${issueNumber} --repo ${shellEscape(repo)} --body ${shellEscape(comment)}`,
      { encoding: "utf-8", timeout: 30000 },
    );

    const actionItemCount = extractActionItemCount(issue);

    log.info("Posted standup acknowledgment comment", {
      repo,
      issueNumber,
      actionItems: actionItemCount,
    });

    // Detect synthesis confidence label and stamp it on the issue
    const synthesisLabel = detectSynthesisLabel(issue);
    applyGitHubSynthesisLabel(repo, issueNumber, synthesisLabel);

    // Record synthesis health event in the store (for sparkline + escalation tracking)
    if (store) {
      store.recordStandupSynthesisEvent(repo, issueNumber, synthesisLabel, Math.max(0, actionItemCount));

      // Check if we've exceeded the fallback threshold and escalate if needed
      if (notifier && synthesisLabel !== "synthesized") {
        await checkAndEscalateFallbackThreshold(store, notifier);
      }
    }

    // If synthesis failed, attempt to recover action items from open issues.
    // This ensures standup reports never ship empty solely because of an LLM
    // failure — the fallback retries up to 2x before giving up.
    if (isSynthesisFailed(issue)) {
      log.warn("Synthesis failure detected in standup — attempting fallback action item recovery", {
        repo,
        issueNumber,
      });
      await postFallbackActionItems(repo, issueNumber, fallbackRepos);
    }

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
