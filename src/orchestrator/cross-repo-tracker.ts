/**
 * CrossRepoTracker — detects when a task requires work on a peer repo and
 * creates a linked child issue on that repo before the task is marked done.
 *
 * Problem: some issues span multiple agent repos (e.g. reviewer + dashboard).
 * When agent A implements its half, the dashboard half goes untracked because
 * agent A can't write to the dashboard repo.  This module detects cross-repo
 * mentions in the dispatched task description and creates follow-up GitHub
 * issues on the correct peer repos.
 *
 * Detection strategy (conservative by design):
 *   1. Identify which repo the executing agent owns.
 *   2. Scan the task description for peer agent repos/names mentioned alongside
 *      action verbs that imply implementation work.
 *   3. For each unique peer repo detected, create a child issue and append
 *      "Created follow-up issue #N on [repo]" to the task result.
 *
 * Only fires for implementation tasks (not research) to avoid spurious issues
 * from research/summary dispatches that mention other repos in passing.
 */
import { execFileSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";
import { findExistingPRsForIssue, isIssueOpen } from "../triggers/github.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("cross-repo-tracker");

export interface CrossRepoFollowUp {
  repo: string;
  issueNumber: number;
  issueUrl: string;
}

/**
 * Action-verb phrases that strongly suggest implementation work is needed
 * (as opposed to merely referencing another repo for context).
 */
const IMPL_ACTION_PATTERNS: RegExp[] = [
  /\b(implement|add|create|build|wire|integrate|expose|emit|publish|consume|display|render|show|include|update|extend|support)\b/i,
  /\b(CLI command|dashboard command|orch\s+\w+|endpoint|API|route|flag|option)\b/i,
  /\b(should|needs? to|must|requires?)\b/i,
];

/**
 * Returns true if the text contains at least one implementation action verb.
 * Used to distinguish "X should also implement Y on dashboard" from
 * "see also: dashboard" (mere reference).
 */
function hasImplVerb(text: string): boolean {
  return IMPL_ACTION_PATTERNS.some((re) => re.test(text));
}

/**
 * Parse a GitHub source ref in the form `owner/repo#123`.
 * Returns undefined when the ref is missing or not a GitHub issue ref.
 */
function parseGithubIssueRef(sourceRef: string | undefined | null): { repo: string; issueNumber: number } | undefined {
  if (!sourceRef) return undefined;
  const hashIdx = sourceRef.lastIndexOf("#");
  if (hashIdx <= 0) return undefined;

  const repo = sourceRef.slice(0, hashIdx);
  const issueNumber = Number.parseInt(sourceRef.slice(hashIdx + 1), 10);
  if (!repo.includes("/") || !Number.isFinite(issueNumber)) return undefined;

  return { repo, issueNumber };
}

/**
 * Check whether an open PR already references the source issue with a closing
 * keyword. If so, the issue is already in the merge queue and filing a new
 * cross-repo follow-up would be stale.
 *
 * Returns the PR number when a qualifying open PR is found, otherwise null.
 * On any API error, fail open so we do not suppress real follow-ups because
 * of a transient CLI or network failure.
 */
function findOpenPRClosingSourceIssue(sourceRef: string | undefined | null): number | null {
  const parsed = parseGithubIssueRef(sourceRef);
  if (!parsed) return null;

  const closingPattern = new RegExp(
    `\\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\s+#${parsed.issueNumber}\\b`,
    "i",
  );

  try {
    const raw = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        parsed.repo,
        "--state",
        "open",
        "--json",
        "number,body",
        "-L",
        "100",
      ],
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();

    if (!raw) return null;

    const prs = JSON.parse(raw) as Array<{ number: number; body: string | null }>;
    const match = prs.find((pr) => closingPattern.test(pr.body ?? ""));
    return match?.number ?? null;
  } catch {
    return null;
  }
}

/**
 * Check whether the source issue is still open before creating follow-ups.
 * Returns false when GitHub reports the issue as closed. On any API error,
 * fail open so we do not suppress real follow-ups because of a transient CLI
 * or network failure.
 */
function isSourceIssueOpen(sourceRef: string | undefined | null): boolean {
  const parsed = parseGithubIssueRef(sourceRef);
  if (!parsed) return true;

  try {
    const raw = execFileSync(
      "gh",
      [
        "issue",
        "view",
        String(parsed.issueNumber),
        "--repo",
        parsed.repo,
        "--json",
        "state",
        "-q",
        ".state",
      ],
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();

    return raw.toUpperCase() === "OPEN";
  } catch {
    return true;
  }
}

/**
 * Extract the sentence(s) from `text` that mention `needle`, giving ±1
 * sentence of context.  Used to build a meaningful child issue body.
 */
function extractMentionContext(text: string, needle: string, maxLen = 600): string {
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const idx = lowerText.indexOf(lowerNeedle);
  if (idx === -1) return "";

  // Walk outwards to sentence boundaries
  const sentenceBreak = /[.!?\n]/;
  let start = idx;
  let end = idx + needle.length;

  // Find sentence start
  for (let i = idx; i >= 0; i--) {
    if (sentenceBreak.test(text[i]!) && i < idx - 1) {
      start = i + 1;
      break;
    }
    if (i === 0) start = 0;
  }

  // Find sentence end (include 1 more sentence)
  let sentencesFound = 0;
  for (let i = idx + needle.length; i < text.length; i++) {
    if (sentenceBreak.test(text[i]!)) {
      sentencesFound++;
      if (sentencesFound >= 2) {
        end = i + 1;
        break;
      }
    }
    if (i === text.length - 1) end = text.length;
  }

  const excerpt = text.slice(start, end).trim();
  return excerpt.length > maxLen ? excerpt.slice(0, maxLen) + "…" : excerpt;
}

/**
 * Build a child issue body that references the parent task and provides
 * enough context for the downstream agent to act.
 */
function buildChildIssueBody(
  task: Task,
  peerRepo: string,
  mentionContext: string,
  parentIssueRef?: string,
): string {
  const parentRef = parentIssueRef
    ? `Follows from: ${parentIssueRef}\n`
    : `Follows from task \`${task.id}\` (${task.title})\n`;

  const excerptBlock = mentionContext
    ? `\n**Relevant context from parent task:**\n> ${mentionContext.replace(/\n/g, "\n> ")}\n`
    : "";

  return (
    `${parentRef}` +
    `This is a cross-repo follow-up automatically created by the orchestrator.\n` +
    `The parent task required changes to \`${peerRepo}\` that could not be implemented by the assigned agent.\n` +
    `${excerptBlock}\n` +
    `Please implement the \`${peerRepo}\` portion and close this issue with a PR.\n`
  );
}

/**
 * Parse a GitHub source ref like `owner/repo#42`.
 *
 * Returns null for non-GitHub refs so we only run the guard when the parent
 * task actually originated from GitHub.
 */
function parseGitHubSourceRef(
  sourceRef: string | null | undefined,
): { repo: string; issueNumber: number } | null {
  if (!sourceRef) return null;

  const match = sourceRef.match(/^(.+)#(\d+)$/);
  if (!match) return null;

  const repo = match[1]!;
  if (!repo.includes("/")) return null;

  return { repo, issueNumber: Number(match[2]) };
}

/**
 * Return true when we should skip creating follow-ups because the parent
 * GitHub issue is no longer a live dispatch target.
 *
 * We fail open on lookup errors, but if GitHub tells us the issue is closed or
 * already linked in a PR body, we stop before creating any follow-up issues.
 */
function shouldSkipFollowUps(task: Task): boolean {
  const sourceIssue = parseGitHubSourceRef(task.source_ref);
  if (!sourceIssue) return false;

  const linkedPRs = findExistingPRsForIssue(sourceIssue.repo, sourceIssue.issueNumber);
  const linkedPR = linkedPRs.find((pr) => pr.state === "open" || pr.state === "merged");
  if (linkedPR) {
    log.info("Skipped cross-repo follow-up; source issue is already linked in a PR", {
      sourceRef: task.source_ref,
      repo: sourceIssue.repo,
      issueNumber: sourceIssue.issueNumber,
      linkedPR: linkedPR.number,
      linkedPRState: linkedPR.state,
      linkedPRUrl: linkedPR.url,
    });
    return true;
  }

  if (!isIssueOpen(sourceIssue.repo, sourceIssue.issueNumber)) {
    log.info("Skipped cross-repo follow-up; source issue is closed", {
      sourceRef: task.source_ref,
      repo: sourceIssue.repo,
      issueNumber: sourceIssue.issueNumber,
    });
    return true;
  }

  return false;
}

/**
 * Safely run `gh issue create` and parse the result URL.
 * Returns null on error (fail-open: don't block the parent task).
 */
function ghCreateIssue(
  repo: string,
  title: string,
  body: string,
): CrossRepoFollowUp | null {
  try {
    const url = execFileSync("gh", [
      "issue", "create",
      "--repo", repo,
      "--title", title,
      "--body", body,
      "--label", "orchestrator",
    ], { encoding: "utf-8", timeout: 30_000 }).trim();

    const match = url.match(/\/issues\/(\d+)$/);
    const number = match ? parseInt(match[1]!, 10) : 0;
    return { repo, issueNumber: number, issueUrl: url };
  } catch (err) {
    log.error("Failed to create cross-repo child issue", {
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check whether an open issue with a very similar title already exists on the
 * target repo.  Uses simple substring matching on the core subject to avoid
 * creating duplicates across multiple daemon cycles.
 */
function isDuplicateIssue(repo: string, title: string): boolean {
  try {
    const raw = execFileSync("gh", [
      "issue", "list",
      "--repo", repo,
      "--state", "open",
      "--json", "title",
      "-L", "200",
    ], { encoding: "utf-8", timeout: 15_000 }).trim();
    if (!raw) return false;
    const issues = JSON.parse(raw) as { title: string }[];
    const titleLower = title.toLowerCase();
    return issues.some((i) => {
      const t = i.title.toLowerCase();
      // Duplicate if 60% of the words in the new title appear in an existing title
      const words = titleLower.split(/\s+/).filter((w) => w.length > 3);
      if (words.length === 0) return false;
      const overlap = words.filter((w) => t.includes(w)).length;
      return overlap / words.length >= 0.6;
    });
  } catch {
    return false; // fail-open
  }
}

/**
 * Detect peer repos mentioned in the task description and create follow-up
 * issues on those repos.
 *
 * Returns an array of created follow-ups (empty array if none needed or all
 * creations failed).  This function never throws — all errors are logged and
 * the function returns a partial result.
 *
 * @param onAvoided  Optional callback invoked when a follow-up is **skipped
 *   because an open PR already closes the source issue** (AC#3: improvement
 *   detector can track this as a positive efficiency metric).  Not called for
 *   the closed-source-issue path since that is not an avoidance — no follow-up
 *   would have been useful in that case.
 */
export function detectAndCreateFollowUps(
  task: Task,
  agentName: string,
  config: OrchestratorConfig,
  onAvoided?: () => void,
): CrossRepoFollowUp[] {
  // Only fire for implementation tasks — research tasks mention many repos
  // in passing and should not trigger issue creation.
  if (task.task_type === "research") return [];

  // Before creating any follow-ups, ensure the parent issue is still a live
  // GitHub target. If the issue is already closed or linked in a PR, creating
  // a fresh cross-repo issue would be stale and redundant.
  if (shouldSkipFollowUps(task)) return [];

  // Only fire for tasks that completed successfully (status "done").
  // Called right after the store update, so caller ensures this.

  if (!isSourceIssueOpen(task.source_ref)) {
    log.info("Skipping cross-repo follow-ups: source issue is closed", {
      taskId: task.id,
      agentName,
      sourceRef: task.source_ref,
    });
    return [];
  }

  const blockingPRNumber = findOpenPRClosingSourceIssue(task.source_ref);
  if (blockingPRNumber !== null) {
    const sourceIssue = parseGithubIssueRef(task.source_ref);
    log.info(`skipped cross-repo follow-up for #${sourceIssue?.issueNumber ?? "?"} — already linked in PR #${blockingPRNumber}`, {
      taskId: task.id,
      agentName,
      sourceRef: task.source_ref,
      blockingPRNumber,
    });
    // Notify the caller so it can increment the "follow_ups_avoided" metric
    // (acceptance criterion #3: improvement detector tracks this as positive).
    onAvoided?.();
    return [];
  }

  const description = `${task.title} ${task.description ?? ""}`;
  const descLower = description.toLowerCase();

  // Find the repo owned by the current agent
  const ownerAgent = config.agents[agentName];
  const ownedRepo = ownerAgent?.github; // e.g. "rapartlu/agent-orchestrator"

  const created: CrossRepoFollowUp[] = [];
  const seenRepos = new Set<string>();

  for (const [candidateName, candidateAgent] of Object.entries(config.agents)) {
    const peerRepo = candidateAgent.github;
    if (!peerRepo) continue; // agent has no owned GitHub repo
    if (peerRepo === ownedRepo) continue; // skip own repo
    if (seenRepos.has(peerRepo)) continue; // already processed this repo

    // Build tiered search tokens.
    // Tier 1 (high confidence) — exact repo / agent name:
    const tier1Tokens: string[] = [
      peerRepo.toLowerCase(), // "rapartlu/agent-dashboard"
      peerRepo.split("/")[1]?.toLowerCase() ?? "", // "agent-dashboard"
      candidateName.toLowerCase(), // "claude-orchestrator-dashboard"
    ].filter(Boolean);

    // Tier 2 (lower confidence) — distinctive owns_topics keywords.
    // Must be >= 5 chars (excludes short words like "cli", "ui") and must match
    // on a word boundary to prevent "orchestrator" from matching inside
    // "claude-orchestrator-dashboard".
    const ownedTopics = (candidateAgent.owns_topics ?? []).filter(
      (t) => t.length >= 5,
    );

    // Try tier 1 first (substring match is fine for full repo/agent names)
    const tier1Match = tier1Tokens.find((token) => descLower.includes(token));

    // Try tier 2 only when tier 1 didn't match.
    // Use a strict boundary pattern that does NOT match inside hyphenated
    // compound words (e.g. "orchestrator" must not fire on "claude-orchestrator-dashboard").
    // The lookbehind/lookahead exclude letters and hyphens so the topic must
    // stand alone as a full word, not as part of a compound identifier.
    const tier2Match =
      !tier1Match &&
      ownedTopics.find((t) => {
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(?<![a-zA-Z-])${escaped}(?![a-zA-Z-])`, "i");
        return re.test(description);
      });

    const matchedToken = tier1Match ?? tier2Match;
    if (!matchedToken) continue;

    // Narrow the match to the surrounding context to check for action verbs
    const tokenIdx = descLower.indexOf(matchedToken.toLowerCase());
    const contextWindow = description.slice(
      Math.max(0, tokenIdx - 200),
      Math.min(description.length, tokenIdx + 400),
    );

    if (!hasImplVerb(contextWindow)) {
      log.debug("Skipping cross-repo mention (no action verb nearby)", {
        peerRepo,
        matchedToken,
      });
      continue;
    }

    seenRepos.add(peerRepo);

    // Build issue title
    const parentIssueRef = task.source_ref ?? undefined;
    const parentIssueNum = parentIssueRef?.match(/#(\d+)$/)?.[1];
    const shortAgentName =
      candidateName.replace(/^(claude|codex)-/, "") // strip provider prefix
        .replace(/-/g, " ");

    const issueTitle = parentIssueNum
      ? `[${shortAgentName}] Follow-up from #${parentIssueNum}: ${task.title.slice(0, 60)}`
      : `[${shortAgentName}] Cross-repo follow-up: ${task.title.slice(0, 60)}`;

    // Dedup check
    if (isDuplicateIssue(peerRepo, issueTitle)) {
      log.info("Skipping cross-repo child issue (duplicate detected)", {
        peerRepo,
        issueTitle,
      });
      continue;
    }

    const mentionContext = extractMentionContext(description, matchedToken);
    const issueBody = buildChildIssueBody(task, peerRepo, mentionContext, parentIssueRef);

    log.info("Creating cross-repo child issue", { peerRepo, issueTitle, agentName });

    const followUp = ghCreateIssue(peerRepo, issueTitle, issueBody);
    if (followUp) {
      created.push(followUp);
      log.info("Cross-repo child issue created", {
        repo: peerRepo,
        issueNumber: followUp.issueNumber,
        url: followUp.issueUrl,
      });
    }
  }

  return created;
}

/**
 * Format a list of cross-repo follow-ups into a human-readable appendix
 * that gets appended to the task result.
 *
 * Each line matches the acceptance-criteria format:
 *   "Created follow-up issue #N on [repo]"
 */
export function formatFollowUpNote(followUps: CrossRepoFollowUp[]): string {
  if (followUps.length === 0) return "";
  const lines = followUps.map(
    (f) => `Created follow-up issue #${f.issueNumber} on ${f.repo}: ${f.issueUrl}`,
  );
  return `\n\n---\n**Cross-repo follow-ups:**\n${lines.join("\n")}`;
}
