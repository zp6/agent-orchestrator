/**
 * MultiRepoCoordinator — coordinates linked PRs across multiple repos for
 * features that span the orchestrator, dashboard, proxy, or other peer agents.
 *
 * Problem: cross-repo-tracker.ts creates orphan follow-up issues that often
 * get dispatched to the wrong agent, ignored, or arrive days later.
 *
 * Solution: When the dispatcher detects that a completed task requires changes
 * in multiple repos, this module:
 *   1. Creates a coordination group (parent) with child tasks per repo
 *   2. Child task descriptions include cross-repo context + sibling references
 *   3. After all children create PRs, links them with cross-repo references
 *   4. Merges PRs in dependency order (library/API first, consumer second)
 *   5. Rolls back the first merged PR if the second fails review
 *
 * This replaces the "create an orphan issue and hope" approach with
 * synchronous, auditable, ordered multi-repo delivery.
 *
 * Integration point: `checkAndAdvanceCoordination()` is called from the
 * dispatcher after each child task completes.
 */
import { execFileSync } from "node:child_process";
import { ulid } from "ulid";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("multi-repo-coordinator");

// ── Public interfaces ─────────────────────────────────────────────────────────

/**
 * Describes what changes are needed in a single repo as part of a coordinated
 * multi-repo change.
 */
export interface MultiRepoChangeSet {
  /** Full GitHub repo slug, e.g. "rapartlu/agent-dashboard" */
  repo: string;
  /** Agent that owns this repo, e.g. "claude-orchestrator-dashboard" */
  agentName: string;
  /**
   * Human-readable description of what changes this repo needs.
   * Extracted from the parent task description.
   */
  description: string;
  /**
   * Merge order: 1 = must merge first (API/library provider),
   * 2 = merge second (consumer), etc.
   */
  mergeOrder: number;
}

export type CoordinationStatus =
  | "pending"        // group created, child tasks not yet dispatched
  | "in_progress"    // child tasks dispatched; waiting for PRs
  | "ready_to_merge" // all PRs open; awaiting ordered merge
  | "merging"        // merge sequence in progress
  | "merged"         // all PRs merged successfully
  | "rolled_back"    // first PR reverted because a later PR failed review
  | "failed";        // unrecoverable error

export interface CoordinationGroup {
  id: string;
  /** Task ID of the originating (parent) task that detected the multi-repo need */
  parentTaskId: string;
  /** Original GitHub issue ref, e.g. "rapartlu/agent-orchestrator#612" */
  parentSourceRef: string | null;
  /** Per-repo change sets in merge order */
  changeSets: MultiRepoChangeSet[];
  /** repo → child task ID */
  childTaskIds: Record<string, string>;
  /** repo → open PR number (populated when child task creates a PR) */
  childPRNumbers: Record<string, number>;
  /** repo → open PR URL */
  childPRUrls: Record<string, string>;
  status: CoordinationStatus;
  createdAt: string;
  updatedAt: string;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Action-verb patterns that imply implementation work is needed in the
 * mentioned repo (not just a passing reference).
 */
const IMPL_VERB_PATTERNS: RegExp[] = [
  /\b(implement|add|create|build|wire|integrate|expose|emit|publish|consume|display|render|show|include|update|extend|support)\b/i,
  /\b(CLI command|dashboard command|orch\s+\w+|endpoint|API|route|flag|option)\b/i,
  /\b(should|needs? to|must|requires?)\b/i,
];

function hasImplVerb(text: string): boolean {
  return IMPL_VERB_PATTERNS.some((re) => re.test(text));
}

/**
 * Repos that should be treated as "providers" (merge first).
 * Repos not matching these patterns are treated as consumers (merge later).
 */
const PROVIDER_REPO_KEYWORDS = [
  "orchestrator",
  "orchestrator-core",
  "core",
  "api",
  "proxy",
  "lib",
  "sdk",
];

/**
 * Detect which peer repos require changes based on the task description.
 * Returns a list of change sets in dependency order (providers first).
 *
 * This is conservative by design: only fires when action verbs are present
 * near the mention, and only for non-research tasks.
 */
export function detectMultiRepoChangeSets(
  task: Task,
  agentName: string,
  config: OrchestratorConfig,
): MultiRepoChangeSet[] {
  // Only detect cross-repo requirements for genuine implementation tasks.
  // Skip research, facilitation, housekeeping, revisions, and coordinated
  // changes — these mention other repos in their descriptions/results
  // without actually needing cross-repo code changes, causing cascade spam.
  if (task.task_type === "research" || task.task_type === "facilitation") return [];

  const title = task.title?.toLowerCase() ?? "";
  if (
    title.includes("[housekeeping]") ||
    title.includes("[revision]") ||
    title.startsWith("[meeting") ||
    title.includes("coordinated change") ||
    title.includes("backlog triage") ||
    title.includes("bootstrap roadmap")
  ) {
    return [];
  }

  // Only run for tasks with a GitHub source — manual/internal tasks shouldn't
  // trigger cross-repo coordination.
  if (task.source !== "github") return [];

  const ownerAgent = config.agents[agentName];
  const ownedRepo = ownerAgent?.github;

  const description = `${task.title} ${task.description ?? ""}`;
  const descLower = description.toLowerCase();

  const detected: MultiRepoChangeSet[] = [];
  const seenRepos = new Set<string>();

  for (const [candidateName, candidateAgent] of Object.entries(config.agents)) {
    const peerRepo = candidateAgent.github;
    if (!peerRepo) continue;
    if (peerRepo === ownedRepo) continue;
    if (seenRepos.has(peerRepo)) continue;

    // Tier 1: exact repo / agent name match
    const tier1Tokens = [
      peerRepo.toLowerCase(),
      peerRepo.split("/")[1]?.toLowerCase() ?? "",
      candidateName.toLowerCase(),
    ].filter(Boolean);
    const tier1Match = tier1Tokens.find((t) => descLower.includes(t));

    // Tier 2: owns_topics keywords (word-boundary, no hyphenated compounds)
    const ownedTopics = (candidateAgent.owns_topics ?? []).filter((t) => t.length >= 5);
    const tier2Match =
      !tier1Match &&
      ownedTopics.find((t) => {
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?<![a-zA-Z-])${escaped}(?![a-zA-Z-])`, "i").test(description);
      });

    const matchedToken = tier1Match ?? tier2Match;
    if (!matchedToken) continue;

    // Check for action verb in surrounding context
    const tokenIdx = descLower.indexOf(matchedToken.toLowerCase());
    const contextWindow = description.slice(
      Math.max(0, tokenIdx - 200),
      Math.min(description.length, tokenIdx + 400),
    );
    if (!hasImplVerb(contextWindow)) continue;

    seenRepos.add(peerRepo);
    detected.push({
      repo: peerRepo,
      agentName: candidateName,
      description: extractContextForRepo(description, matchedToken),
      mergeOrder: 0, // assigned after sorting
    });
  }

  if (detected.length === 0) return [];

  // Sort: providers first (orchestrator/core/api/proxy), consumers later
  const ordered = determineMergeOrder(detected);
  return ordered;
}

/**
 * Determine merge order for a list of change sets using repo name heuristics.
 *
 * Ordering rules (highest priority first):
 * 1. Repos with "orchestrator", "core", "api", "proxy", "lib", "sdk" in the
 *    repo name → providers → merge first
 * 2. Repos with "dashboard", "ui", "frontend", "consumer" → consumers → merge last
 * 3. Tie-break alphabetically for determinism
 *
 * Returns a new array with `mergeOrder` assigned (1-indexed).
 */
export function determineMergeOrder(changeSets: MultiRepoChangeSet[]): MultiRepoChangeSet[] {
  function providerScore(repo: string): number {
    const lower = repo.toLowerCase();
    for (const kw of PROVIDER_REPO_KEYWORDS) {
      if (lower.includes(kw)) return 1; // provider
    }
    return 2; // consumer
  }

  const sorted = [...changeSets].sort((a, b) => {
    const sa = providerScore(a.repo);
    const sb = providerScore(b.repo);
    if (sa !== sb) return sa - sb;
    return a.repo.localeCompare(b.repo);
  });

  return sorted.map((cs, i) => ({ ...cs, mergeOrder: i + 1 }));
}

// ── Coordination group lifecycle ──────────────────────────────────────────────

/**
 * Create a coordination group record and the child tasks for each peer repo.
 *
 * Returns the created group. Child tasks are created in "pending" state so the
 * daemon's dispatch loop picks them up in the next cycle.
 */
export function createCoordinationGroup(
  parentTask: Task,
  changeSets: MultiRepoChangeSet[],
  store: StateStore,
): CoordinationGroup {
  const groupId = ulid();
  const now = new Date().toISOString();
  const childTaskIds: Record<string, string> = {};

  // Create a child task per repo
  for (const cs of changeSets) {
    const childDescription = buildChildTaskDescription(
      parentTask,
      cs,
      changeSets.filter((x) => x.repo !== cs.repo),
      groupId,
    );

    const childTask = store.createTask({
      title: buildChildTaskTitle(parentTask, cs),
      description: childDescription,
      source: parentTask.source,
      source_ref: parentTask.source_ref ?? undefined,
      agent_name: cs.agentName,
      task_type: "implementation",
      parent_task_id: parentTask.id,
      lineage_group_id: parentTask.lineage_group_id ?? parentTask.id,
    });

    childTaskIds[cs.repo] = childTask.id;

    log.info("Created coordination child task", {
      groupId,
      repo: cs.repo,
      agentName: cs.agentName,
      childTaskId: childTask.id,
      mergeOrder: cs.mergeOrder,
    });
  }

  const group: CoordinationGroup = {
    id: groupId,
    parentTaskId: parentTask.id,
    parentSourceRef: parentTask.source_ref,
    changeSets,
    childTaskIds,
    childPRNumbers: {},
    childPRUrls: {},
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  store.createCoordinationGroup(group);
  log.info("Coordination group created", {
    groupId,
    parentTaskId: parentTask.id,
    repos: changeSets.map((cs) => cs.repo),
  });

  return group;
}

/**
 * Called after each child task completes. Updates the coordination group and,
 * when all children are done, links their PRs and triggers ordered merge.
 *
 * This is the main integration point for the dispatcher to call.
 */
export async function checkAndAdvanceCoordination(
  childTaskId: string,
  store: StateStore,
  config: OrchestratorConfig,
): Promise<void> {
  const group = store.getCoordinationGroupByChildTaskId(childTaskId);
  if (!group) return;

  if (group.status === "merged" || group.status === "rolled_back" || group.status === "failed") {
    return; // terminal state — nothing to do
  }

  // Pull current state of all child tasks
  const childTaskList = Object.entries(group.childTaskIds).map(([repo, taskId]) => ({
    repo,
    taskId,
    task: store.getTask(taskId),
  }));

  // Update PR numbers from any newly completed child tasks
  let updatedPRNumbers = { ...group.childPRNumbers };
  let updatedPRUrls = { ...group.childPRUrls };
  for (const { repo, task } of childTaskList) {
    if (task?.status === "done" && task.result && !updatedPRNumbers[repo]) {
      const pr = extractPRFromTaskResult(task.result, repo);
      if (pr) {
        updatedPRNumbers[repo] = pr.number;
        updatedPRUrls[repo] = pr.url;
        log.info("Found PR for coordination child task", {
          groupId: group.id,
          repo,
          prNumber: pr.number,
          prUrl: pr.url,
        });
      }
    }
  }

  // Persist PR number updates
  if (Object.keys(updatedPRNumbers).length > Object.keys(group.childPRNumbers).length) {
    store.updateCoordinationGroup(group.id, {
      childPRNumbers: updatedPRNumbers,
      childPRUrls: updatedPRUrls,
    });
  }

  // Check if all children are done
  const allDone = childTaskList.every((c) => c.task?.status === "done" || c.task?.status === "failed");
  const anyFailed = childTaskList.some((c) => c.task?.status === "failed");

  if (!allDone) {
    // Still waiting — update status to in_progress if not already
    if (group.status === "pending") {
      store.updateCoordinationGroup(group.id, { status: "in_progress" });
    }
    return;
  }

  if (anyFailed) {
    log.warn("Coordination group has failed child tasks; marking failed", {
      groupId: group.id,
      failedRepos: childTaskList.filter((c) => c.task?.status === "failed").map((c) => c.repo),
    });
    store.updateCoordinationGroup(group.id, { status: "failed" });
    return;
  }

  // All children done — check if we have PR info for all repos
  const changeSetsInOrder = (group.changeSets as MultiRepoChangeSet[]).sort(
    (a, b) => a.mergeOrder - b.mergeOrder,
  );
  const allHavePRs = changeSetsInOrder.every((cs) => updatedPRNumbers[cs.repo]);

  if (!allHavePRs) {
    // Some tasks completed without creating a PR (research-only result?)
    // Still try to advance with whatever PRs we have.
    log.warn("Some coordination child tasks have no detected PR; proceeding with available PRs", {
      groupId: group.id,
      missingPRRepos: changeSetsInOrder.filter((cs) => !updatedPRNumbers[cs.repo]).map((cs) => cs.repo),
    });
  }

  // Add cross-repo references to all PRs that we know about
  const freshGroup = store.getCoordinationGroup(group.id)!;
  await addCrossRepoPRReferences(freshGroup, config);

  // Advance to ready_to_merge — the daemon's merge queue will handle ordered merge
  store.updateCoordinationGroup(group.id, { status: "ready_to_merge" });
  log.info("Coordination group ready to merge", {
    groupId: group.id,
    prUrls: Object.values(updatedPRUrls),
    mergeOrder: changeSetsInOrder.map((cs) => cs.repo),
  });
}

// ── PR cross-referencing ──────────────────────────────────────────────────────

/**
 * Add cross-repo PR references to each PR in the coordination group.
 * Appends a "Part of coordinated change" section to each PR body.
 *
 * Idempotent: checks if the marker is already present before editing.
 */
async function addCrossRepoPRReferences(
  group: CoordinationGroup | { id: string; changeSets: unknown[]; childPRNumbers: Record<string, number>; childPRUrls: Record<string, string> },
  _config: OrchestratorConfig,
): Promise<void> {
  const changeSetsInOrder = (group.changeSets as MultiRepoChangeSet[]).sort(
    (a, b) => a.mergeOrder - b.mergeOrder,
  );

  for (const cs of changeSetsInOrder) {
    const prNumber = group.childPRNumbers[cs.repo];
    if (!prNumber) continue;

    // Build the cross-reference block
    const siblings = changeSetsInOrder.filter((s) => s.repo !== cs.repo);
    const siblingLines = siblings.map((s) => {
      const sibPR = group.childPRNumbers[s.repo];
      const sibURL = group.childPRUrls[s.repo];
      const ref = sibPR ? sibURL ?? `${s.repo}#${sibPR}` : s.repo;
      const order = s.mergeOrder < cs.mergeOrder ? "merge before this" : "merge after this";
      return `- ${ref} (${order})`;
    });

    const mergeNote =
      cs.mergeOrder === 1
        ? `Merge this PR **first** (order ${cs.mergeOrder} of ${changeSetsInOrder.length}).`
        : `Merge this PR **after** the repos listed above (order ${cs.mergeOrder} of ${changeSetsInOrder.length}).`;

    const crossRefBlock =
      `\n\n---\n` +
      `<!-- multi-repo-coordinator:${group.id} -->\n` +
      `## 🔗 Coordinated multi-repo change\n\n` +
      `This PR is part of a coordinated change across multiple repos.\n\n` +
      `${mergeNote}\n\n` +
      (siblingLines.length > 0 ? `**Linked PRs:**\n${siblingLines.join("\n")}\n` : "");

    try {
      // Get current PR body to check idempotency
      const currentBodyRaw = execFileSync(
        "gh",
        ["pr", "view", String(prNumber), "--repo", cs.repo, "--json", "body", "-q", ".body"],
        { encoding: "utf-8", timeout: 15_000 },
      ).trim();

      if (currentBodyRaw.includes(`multi-repo-coordinator:${group.id}`)) {
        log.debug("Cross-repo reference already present, skipping", {
          repo: cs.repo,
          prNumber,
          groupId: group.id,
        });
        continue;
      }

      const newBody = currentBodyRaw + crossRefBlock;

      execFileSync(
        "gh",
        ["pr", "edit", String(prNumber), "--repo", cs.repo, "--body", newBody],
        { encoding: "utf-8", timeout: 15_000 },
      );

      log.info("Added cross-repo references to PR", {
        repo: cs.repo,
        prNumber,
        groupId: group.id,
        siblingCount: siblings.length,
      });
    } catch (err) {
      // Non-fatal: cross-referencing is best-effort
      log.error("Failed to add cross-repo PR reference", {
        repo: cs.repo,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Ordered merge ─────────────────────────────────────────────────────────────

/**
 * Execute the coordinated merge in dependency order.
 *
 * Called by the daemon when it detects a coordination group in "ready_to_merge"
 * status. Merges each PR in sequence, verifying success before proceeding.
 * If a PR fails to merge, calls rollbackCoordinatedChange() for any already-
 * merged PRs.
 */
export async function executeCoordinatedMerge(
  groupId: string,
  store: StateStore,
  _config: OrchestratorConfig,
): Promise<{ success: boolean; mergedRepos: string[]; failedRepo?: string }> {
  const group = store.getCoordinationGroup(groupId);
  if (!group) {
    log.error("Coordination group not found for merge", { groupId });
    return { success: false, mergedRepos: [] };
  }

  store.updateCoordinationGroup(groupId, { status: "merging" });

  const changeSetsInOrder = (group.changeSets as MultiRepoChangeSet[]).sort(
    (a, b) => a.mergeOrder - b.mergeOrder,
  );
  const mergedRepos: string[] = [];

  for (const cs of changeSetsInOrder) {
    const prNumber = group.childPRNumbers[cs.repo];
    if (!prNumber) {
      log.warn("No PR number for repo in coordination group; skipping merge", {
        groupId,
        repo: cs.repo,
      });
      continue;
    }

    try {
      log.info("Merging PR in coordination order", {
        groupId,
        repo: cs.repo,
        prNumber,
        mergeOrder: cs.mergeOrder,
        totalRepos: changeSetsInOrder.length,
      });

      execFileSync(
        "gh",
        ["pr", "merge", String(prNumber), "--repo", cs.repo, "--squash", "--auto"],
        { encoding: "utf-8", timeout: 30_000 },
      );

      mergedRepos.push(cs.repo);
      log.info("PR merged successfully", { groupId, repo: cs.repo, prNumber });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Failed to merge PR in coordination group", {
        groupId,
        repo: cs.repo,
        prNumber,
        error: errMsg,
        alreadyMerged: mergedRepos,
      });

      // Rollback any already-merged PRs
      if (mergedRepos.length > 0) {
        log.warn("Initiating rollback for already-merged repos", {
          groupId,
          reposToRollback: mergedRepos,
        });
        await rollbackCoordinatedChange(groupId, mergedRepos, store, _config);
      } else {
        store.updateCoordinationGroup(groupId, { status: "failed" });
      }

      return { success: false, mergedRepos, failedRepo: cs.repo };
    }
  }

  store.updateCoordinationGroup(groupId, { status: "merged" });
  log.info("All PRs in coordination group merged successfully", {
    groupId,
    mergedRepos,
  });

  return { success: true, mergedRepos };
}

/**
 * Roll back already-merged PRs when a later PR in the coordination chain
 * fails. Creates revert PRs on each affected repo.
 */
export async function rollbackCoordinatedChange(
  groupId: string,
  reposToRollback: string[],
  store: StateStore,
  _config: OrchestratorConfig,
): Promise<void> {
  const group = store.getCoordinationGroup(groupId);
  if (!group) return;

  // Rollback in reverse merge order
  const toRollback = [...reposToRollback].reverse();

  for (const repo of toRollback) {
    const prNumber = group.childPRNumbers[repo];
    if (!prNumber) continue;

    try {
      log.info("Creating revert PR for rolled-back coordination change", {
        groupId,
        repo,
        originalPRNumber: prNumber,
      });

      execFileSync(
        "gh",
        ["pr", "revert", String(prNumber), "--repo", repo],
        { encoding: "utf-8", timeout: 30_000 },
      );

      log.info("Revert PR created successfully", { groupId, repo, originalPRNumber: prNumber });
    } catch (err) {
      // Revert failure is critical — operator must intervene
      log.error("CRITICAL: Failed to create revert PR for coordination rollback", {
        groupId,
        repo,
        originalPRNumber: prNumber,
        error: err instanceof Error ? err.message : String(err),
        manualAction: `Run: gh pr revert ${prNumber} --repo ${repo}`,
      });
    }
  }

  store.updateCoordinationGroup(groupId, { status: "rolled_back" });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a child task title for a peer repo.
 */
function buildChildTaskTitle(parentTask: Task, cs: MultiRepoChangeSet): string {
  const parentIssueNum = parentTask.source_ref?.match(/#(\d+)$/)?.[1];
  const shortRepo = cs.repo.split("/")[1] ?? cs.repo;
  return parentIssueNum
    ? `[${shortRepo}] Coordinated change from #${parentIssueNum}: ${parentTask.title.slice(0, 50)}`
    : `[${shortRepo}] Coordinated change: ${parentTask.title.slice(0, 60)}`;
}

/**
 * Build a child task description for a peer repo, including cross-repo context
 * and references to sibling tasks.
 */
function buildChildTaskDescription(
  parentTask: Task,
  cs: MultiRepoChangeSet,
  siblings: MultiRepoChangeSet[],
  coordinationGroupId: string,
): string {
  const parentRef = parentTask.source_ref
    ? `Part of coordinated change originating from: ${parentTask.source_ref}`
    : `Part of coordinated change originating from task \`${parentTask.id}\``;

  const siblingNote =
    siblings.length > 0
      ? `\n\n**Sibling repos in this coordinated change (merge in order):**\n` +
        siblings
          .sort((a, b) => a.mergeOrder - b.mergeOrder)
          .map((s) => `- \`${s.repo}\` (order ${s.mergeOrder})`)
          .join("\n")
      : "";

  const mergeOrderNote =
    `\n\n**Your merge order: ${cs.mergeOrder} of ${siblings.length + 1}**\n` +
    (cs.mergeOrder === 1
      ? "Merge your PR first — other repos depend on your changes."
      : `Wait for repos with lower merge order numbers to merge first.`);

  const crossRefNote =
    `\n\n**After opening your PR**, add this line to the PR body:\n` +
    `\`Part of coordinated change: ${coordinationGroupId}\`\n` +
    `The orchestrator will automatically link the PRs.`;

  return (
    `${parentRef}\n\n` +
    `**What to implement in \`${cs.repo}\`:**\n${cs.description}\n` +
    `${siblingNote}` +
    `${mergeOrderNote}` +
    `${crossRefNote}\n\n` +
    `**Original task context:**\n> ${parentTask.title}\n` +
    (parentTask.description
      ? `>\n> ${parentTask.description.split("\n").slice(0, 10).join("\n> ")}\n`
      : "")
  );
}

/**
 * Extract a snippet of text from the task description that is relevant to the
 * given peer repo mention.
 */
function extractContextForRepo(description: string, matchedToken: string, maxLen = 500): string {
  const lower = description.toLowerCase();
  const idx = lower.indexOf(matchedToken.toLowerCase());
  if (idx === -1) return description.slice(0, maxLen);

  const sentenceBreak = /[.!?\n]/;
  let start = 0;
  let end = description.length;

  // Walk back to sentence start
  for (let i = idx; i >= 0; i--) {
    if (sentenceBreak.test(description[i]!) && i < idx - 1) {
      start = i + 1;
      break;
    }
  }

  // Walk forward to end of next sentence
  let sentences = 0;
  for (let i = idx + matchedToken.length; i < description.length; i++) {
    if (sentenceBreak.test(description[i]!)) {
      sentences++;
      if (sentences >= 2) {
        end = i + 1;
        break;
      }
    }
  }

  const excerpt = description.slice(start, end).trim();
  return excerpt.length > maxLen ? excerpt.slice(0, maxLen) + "…" : excerpt;
}

/**
 * Parse a PR URL or "repo#N" reference from a task result string.
 * Agents typically include the PR URL in their response.
 */
export function extractPRFromTaskResult(
  result: string,
  repo: string,
): { number: number; url: string } | null {
  if (!result) return null;

  // Match full PR URL: https://github.com/owner/repo/pull/N
  const repoPath = repo.replace(/\//g, "\\/");
  const urlPattern = new RegExp(
    `https://github\\.com/${repoPath}/pull/(\\d+)`,
    "i",
  );
  const urlMatch = result.match(urlPattern);
  if (urlMatch) {
    return {
      number: parseInt(urlMatch[1]!, 10),
      url: urlMatch[0],
    };
  }

  // Fallback: match "PR #N" near repo mention
  const prShortPattern = /\bPR\s*#(\d+)\b/i;
  const shortMatch = result.match(prShortPattern);
  if (shortMatch && result.toLowerCase().includes(repo.split("/")[1]?.toLowerCase() ?? "")) {
    const num = parseInt(shortMatch[1]!, 10);
    return {
      number: num,
      url: `https://github.com/${repo}/pull/${num}`,
    };
  }

  return null;
}
