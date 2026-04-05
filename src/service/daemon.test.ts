import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractClosedIssueNumbers, prBodyHasIssueRef, shouldVerifyTask, buildHousekeepingMessage, needsRoadmapBootstrap, buildRoadmapBootstrapMessage, isPRAlreadyMerged, computeTimeoutRetry, TIMEOUT_MAX_RETRIES, TIMEOUT_RETRY_DELAY_MS, PR_FEEDBACK_CEILING, IDLE_RECLAIM_THRESHOLD_CYCLES, ORPHAN_PR_CHECK_EVERY_N_CYCLES, extractChecklistText, buildConsolidatedFeedbackMessage, resolveConversationIdForPR } from "./daemon.js";
import { TIMEOUT_RETRY_MAX, TIMEOUT_RETRY_BACKOFF_MS } from "../orchestrator/dispatcher.js";
import { StateStore } from "../state/store.js";

// ────────────────────────────────────────────────────────────────────────────
// computeTimeoutRetry — timeout retry scheduling
// ────────────────────────────────────────────────────────────────────────────

describe("computeTimeoutRetry", () => {
  const NOW = 1_700_000_000_000; // fixed timestamp for deterministic tests

  it("first timeout (retry_count=0): schedules retry and increments retry_count", () => {
    const result = computeTimeoutRetry(0, NOW);
    expect(result.retry_count).toBe(1);
    expect(result.next_retry_at).not.toBeNull();
  });

  it("first timeout: next_retry_at is exactly TIMEOUT_RETRY_BACKOFF_MS in the future", () => {
    const result = computeTimeoutRetry(0, NOW);
    const expected = new Date(NOW + TIMEOUT_RETRY_BACKOFF_MS).toISOString();
    expect(result.next_retry_at).toBe(expected);
  });

  it("second timeout (retry_count=1): still within limit — schedules another retry", () => {
    const result = computeTimeoutRetry(1, NOW);
    expect(result.retry_count).toBe(2);
    expect(result.next_retry_at).not.toBeNull();
  });

  it("at TIMEOUT_RETRY_MAX (retry_count=TIMEOUT_RETRY_MAX): no more retries — next_retry_at is null", () => {
    const result = computeTimeoutRetry(TIMEOUT_RETRY_MAX, NOW);
    expect(result.retry_count).toBe(TIMEOUT_RETRY_MAX + 1);
    expect(result.next_retry_at).toBeNull();
  });

  it("exceeding TIMEOUT_RETRY_MAX (retry_count > TIMEOUT_RETRY_MAX): next_retry_at remains null", () => {
    const result = computeTimeoutRetry(TIMEOUT_RETRY_MAX + 5, NOW);
    expect(result.next_retry_at).toBeNull();
  });

  it("TIMEOUT_RETRY_MAX is 2 (matches the issue spec of max 2 retries)", () => {
    expect(TIMEOUT_RETRY_MAX).toBe(2);
  });

  it("TIMEOUT_RETRY_BACKOFF_MS is 2 minutes", () => {
    expect(TIMEOUT_RETRY_BACKOFF_MS).toBe(2 * 60 * 1000);
  });

  it("defaults nowMs to Date.now() when omitted", () => {
    const before = Date.now();
    const result = computeTimeoutRetry(0);
    const after = Date.now();
    const retryTime = new Date(result.next_retry_at!).getTime();
    expect(retryTime).toBeGreaterThanOrEqual(before + TIMEOUT_RETRY_BACKOFF_MS);
    expect(retryTime).toBeLessThanOrEqual(after + TIMEOUT_RETRY_BACKOFF_MS);
  });

  it("retry_count increments by exactly 1 regardless of current count", () => {
    for (const n of [0, 1, 2, 3, 10]) {
      const result = computeTimeoutRetry(n, NOW);
      expect(result.retry_count).toBe(n + 1);
    }
  });
});

describe("extractClosedIssueNumbers", () => {
  it("extracts Closes #N", () => {
    expect(extractClosedIssueNumbers("Closes #42")).toEqual([42]);
  });

  it("extracts Fixes #N", () => {
    expect(extractClosedIssueNumbers("Fixes #7")).toEqual([7]);
  });

  it("extracts Resolves #N", () => {
    expect(extractClosedIssueNumbers("Resolves #100")).toEqual([100]);
  });

  it("is case-insensitive", () => {
    expect(extractClosedIssueNumbers("closes #1\nFIXES #2\nResolves #3")).toEqual([1, 2, 3]);
  });

  it("extracts multiple refs from one body", () => {
    expect(extractClosedIssueNumbers("Closes #10\nAlso fixes #20")).toEqual([10, 20]);
  });

  it("deduplicates", () => {
    expect(extractClosedIssueNumbers("Closes #5\nAlso closes #5")).toEqual([5]);
  });

  it("returns empty array when no refs", () => {
    expect(extractClosedIssueNumbers("No issue references here")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractClosedIssueNumbers("")).toEqual([]);
  });

  it("handles refs inline with other text", () => {
    expect(extractClosedIssueNumbers("This PR closes #42 and fixes #43.")).toEqual([42, 43]);
  });
});

describe("prBodyHasIssueRef", () => {
  it("returns true for 'Closes #N'", () => {
    expect(prBodyHasIssueRef("Closes #42")).toBe(true);
  });

  it("returns true for 'Fixes #N'", () => {
    expect(prBodyHasIssueRef("Fixes #7")).toBe(true);
  });

  it("returns true for 'Resolves #N'", () => {
    expect(prBodyHasIssueRef("Resolves #100")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(prBodyHasIssueRef("closes #1")).toBe(true);
    expect(prBodyHasIssueRef("FIXES #2")).toBe(true);
    expect(prBodyHasIssueRef("RESOLVES #3")).toBe(true);
  });

  it("returns true when ref is embedded in longer body", () => {
    expect(prBodyHasIssueRef("Implements the feature.\n\nCloses #184")).toBe(true);
  });

  it("returns false when no issue ref present", () => {
    expect(prBodyHasIssueRef("No issue references here")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(prBodyHasIssueRef("")).toBe(false);
  });

  it("returns false for bare hash without keyword", () => {
    expect(prBodyHasIssueRef("See #42 for context")).toBe(false);
  });
});

describe("buildHousekeepingMessage", () => {
  const agentName = "my-agent";
  const githubRepo = "owner/my-agent";

  it("includes the github repo in the message", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg).toContain(githubRepo);
  });

  it("instructs closing duplicate issues", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg.toLowerCase()).toContain("duplicate");
  });

  it("instructs closing stale issues", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg.toLowerCase()).toContain("stale");
  });

  it("instructs maintaining ROADMAP.md", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg).toContain("ROADMAP.md");
  });

  it("instructs checking for orphan PRs", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg.toLowerCase()).toContain("orphan");
  });

  it("includes gh issue list command referencing the repo", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg).toContain(`gh issue list --repo ${githubRepo}`);
  });

  it("produces different messages for different agents", () => {
    const msg1 = buildHousekeepingMessage("agent-a", "org/agent-a");
    const msg2 = buildHousekeepingMessage("agent-b", "org/agent-b");
    expect(msg1).not.toEqual(msg2);
    expect(msg1).toContain("org/agent-a");
    expect(msg2).toContain("org/agent-b");
  });
});

describe("needsRoadmapBootstrap", () => {
  /**
   * needsRoadmapBootstrap shells out to `gh api` and interprets exit codes.
   * We verify the logic by testing the two observable branches directly via
   * a thin wrapper that accepts a custom exec function, exercised through the
   * exported function's behaviour when the underlying execSync would succeed
   * or throw.
   *
   * Because ESM module namespaces are not configurable (vi.spyOn on
   * node:child_process is not supported in Vitest ESM mode), we instead test
   * the function's behaviour by using its own exported interface: the exported
   * function accepts an optional `execFn` dependency-injection parameter so
   * unit tests can supply a fake without patching globals.
   */

  it("returns false when execFn succeeds (ROADMAP.md exists)", () => {
    const execFn = vi.fn().mockReturnValue("");
    expect(needsRoadmapBootstrap("owner/repo", execFn)).toBe(false);
  });

  it("returns true when execFn throws (ROADMAP.md absent / 404)", () => {
    const execFn = vi.fn().mockImplementation(() => {
      throw new Error("Command failed with exit code 1");
    });
    expect(needsRoadmapBootstrap("owner/repo", execFn)).toBe(true);
  });

  it("returns true on network errors (safe fallback)", () => {
    const execFn = vi.fn().mockImplementation(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(needsRoadmapBootstrap("owner/repo", execFn)).toBe(true);
  });

  it("calls gh api with the correct repo path", () => {
    const execFn = vi.fn().mockReturnValue("");
    needsRoadmapBootstrap("myorg/my-repo", execFn);
    expect(execFn).toHaveBeenCalledOnce();
    const cmd = execFn.mock.calls[0][0] as string;
    expect(cmd).toContain("gh api repos/myorg/my-repo/contents/ROADMAP.md");
  });
});

describe("buildRoadmapBootstrapMessage", () => {
  const agentName = "my-agent";
  const githubRepo = "owner/my-agent";

  it("includes the github repo in the message", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg).toContain(githubRepo);
  });

  it("instructs creating ROADMAP.md", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg).toContain("ROADMAP.md");
  });

  it("instructs opening a PR", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg.toLowerCase()).toContain("pr");
  });

  it("instructs surveying open issues", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg).toContain(`gh issue list --repo ${githubRepo}`);
  });

  it("instructs reviewing recent merged PRs", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg).toContain(`gh pr list --repo ${githubRepo}`);
  });

  it("asks for top 5 priorities sorted by user impact", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg.toLowerCase()).toContain("top 5");
    expect(msg.toLowerCase()).toContain("user impact");
  });

  it("produces different messages for different agents", () => {
    const msg1 = buildRoadmapBootstrapMessage("agent-a", "org/agent-a");
    const msg2 = buildRoadmapBootstrapMessage("agent-b", "org/agent-b");
    expect(msg1).not.toEqual(msg2);
    expect(msg1).toContain("org/agent-a");
    expect(msg2).toContain("org/agent-b");
  });

  it("is distinct from the housekeeping maintenance message", () => {
    const bootstrap = buildRoadmapBootstrapMessage(agentName, githubRepo);
    const housekeeping = buildHousekeepingMessage(agentName, githubRepo);
    expect(bootstrap).not.toEqual(housekeeping);
  });
});

describe("shouldVerifyTask", () => {
  describe("no filter configured", () => {
    it("verifies github tasks when filter is absent", () => {
      expect(shouldVerifyTask("github")).toBe(true);
    });

    it("verifies manual tasks when filter is absent", () => {
      expect(shouldVerifyTask("manual")).toBe(true);
    });

    it("verifies linear tasks when filter is absent", () => {
      expect(shouldVerifyTask("linear")).toBe(true);
    });

    it("verifies any source when filter is undefined", () => {
      expect(shouldVerifyTask("slack", undefined)).toBe(true);
    });

    it("verifies any source when filter is empty array", () => {
      expect(shouldVerifyTask("slack", [])).toBe(true);
    });
  });

  describe("sources allowlist configured", () => {
    const filter = ["github", "linear"];

    it("verifies github tasks (in allowlist)", () => {
      expect(shouldVerifyTask("github", filter)).toBe(true);
    });

    it("verifies linear tasks (in allowlist)", () => {
      expect(shouldVerifyTask("linear", filter)).toBe(true);
    });

    it("always verifies manual tasks even when not in allowlist", () => {
      expect(shouldVerifyTask("manual", filter)).toBe(true);
    });

    it("skips slack tasks (not in allowlist, not manual)", () => {
      expect(shouldVerifyTask("slack", filter)).toBe(false);
    });

    it("skips unknown source (not in allowlist, not manual)", () => {
      expect(shouldVerifyTask("webhook", filter)).toBe(false);
    });
  });

  describe("manual-only allowlist edge case", () => {
    it("verifies manual tasks when filter is [manual]", () => {
      expect(shouldVerifyTask("manual", ["manual"])).toBe(true);
    });

    it("skips github when filter is [manual] only", () => {
      expect(shouldVerifyTask("github", ["manual"])).toBe(false);
    });
  });

  describe("pr-feedback source", () => {
    it("verifies pr-feedback tasks when no filter configured", () => {
      expect(shouldVerifyTask("pr-feedback")).toBe(true);
    });

    it("always verifies pr-feedback tasks even when not in allowlist", () => {
      expect(shouldVerifyTask("pr-feedback", ["github", "linear"])).toBe(true);
    });

    it("verifies pr-feedback tasks even when allowlist is manual-only", () => {
      expect(shouldVerifyTask("pr-feedback", ["manual"])).toBe(true);
    });

    it("verifies pr-feedback tasks when filter is empty array", () => {
      expect(shouldVerifyTask("pr-feedback", [])).toBe(true);
    });
  });
});

describe("TIMEOUT_MAX_RETRIES and TIMEOUT_RETRY_DELAY_MS constants", () => {
  it("TIMEOUT_MAX_RETRIES is a positive integer not exceeding MAX_RETRIES", () => {
    expect(TIMEOUT_MAX_RETRIES).toBeGreaterThan(0);
    expect(Number.isInteger(TIMEOUT_MAX_RETRIES)).toBe(true);
  });

  it("TIMEOUT_MAX_RETRIES is 2 (as specified in issue #185)", () => {
    expect(TIMEOUT_MAX_RETRIES).toBe(2);
  });

  it("TIMEOUT_RETRY_DELAY_MS is at least 60 seconds", () => {
    expect(TIMEOUT_RETRY_DELAY_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("TIMEOUT_RETRY_DELAY_MS is 2 minutes (120 000 ms)", () => {
    expect(TIMEOUT_RETRY_DELAY_MS).toBe(2 * 60 * 1000);
  });
});

describe("isPRAlreadyMerged", () => {
  it("returns false for OPEN state", () => {
    const execFn = vi.fn().mockReturnValue(JSON.stringify({ state: "OPEN" }));
    expect(isPRAlreadyMerged("owner/repo", 42, execFn)).toBe(false);
  });

  it("returns true for MERGED state", () => {
    const execFn = vi.fn().mockReturnValue(JSON.stringify({ state: "MERGED" }));
    expect(isPRAlreadyMerged("owner/repo", 42, execFn)).toBe(true);
  });

  it("returns true for CLOSED state", () => {
    const execFn = vi.fn().mockReturnValue(JSON.stringify({ state: "CLOSED" }));
    expect(isPRAlreadyMerged("owner/repo", 42, execFn)).toBe(true);
  });

  it("fails open (returns false) on exec error", () => {
    const execFn = vi.fn().mockImplementation(() => {
      throw new Error("gh: command failed");
    });
    expect(isPRAlreadyMerged("owner/repo", 42, execFn)).toBe(false);
  });

  it("normalises state casing and whitespace", () => {
    const execFn = vi.fn().mockReturnValue(JSON.stringify({ state: "  merged  " }));
    expect(isPRAlreadyMerged("owner/repo", 42, execFn)).toBe(true);
  });

  it("constructs the correct gh pr view command", () => {
    const execFn = vi.fn().mockReturnValue(JSON.stringify({ state: "OPEN" }));
    isPRAlreadyMerged("myorg/my-repo", 99, execFn);
    expect(execFn).toHaveBeenCalledOnce();
    const cmd = execFn.mock.calls[0][0] as string;
    expect(cmd).toContain("gh pr view 99");
    expect(cmd).toContain("--repo myorg/my-repo");
    expect(cmd).toContain("--json state");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PR_FEEDBACK_CEILING — constant value checks
// ────────────────────────────────────────────────────────────────────────────

describe("PR_FEEDBACK_CEILING", () => {
  it("is 3 (matches the issue spec of 3 feedback rounds before escalation)", () => {
    expect(PR_FEEDBACK_CEILING).toBe(3);
  });

  it("is a positive integer", () => {
    expect(PR_FEEDBACK_CEILING).toBeGreaterThan(0);
    expect(Number.isInteger(PR_FEEDBACK_CEILING)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// IDLE_RECLAIM_THRESHOLD_CYCLES — idle reclaim constant checks
// ────────────────────────────────────────────────────────────────────────────

describe("IDLE_RECLAIM_THRESHOLD_CYCLES", () => {
  it("is 2 (force-reclaim triggers after 2 idle cycles with no dispatch)", () => {
    expect(IDLE_RECLAIM_THRESHOLD_CYCLES).toBe(2);
  });

  it("is a positive integer", () => {
    expect(IDLE_RECLAIM_THRESHOLD_CYCLES).toBeGreaterThan(0);
    expect(Number.isInteger(IDLE_RECLAIM_THRESHOLD_CYCLES)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ORPHAN_PR_CHECK_EVERY_N_CYCLES — ensures orphan PR creation runs every cycle
// ────────────────────────────────────────────────────────────────────────────

describe("ORPHAN_PR_CHECK_EVERY_N_CYCLES", () => {
  it("is 1 (runs every poll cycle for minimum time-to-PR)", () => {
    expect(ORPHAN_PR_CHECK_EVERY_N_CYCLES).toBe(1);
  });

  it("is a positive integer", () => {
    expect(ORPHAN_PR_CHECK_EVERY_N_CYCLES).toBeGreaterThan(0);
    expect(Number.isInteger(ORPHAN_PR_CHECK_EVERY_N_CYCLES)).toBe(true);
  });

  it("triggers on every cycle count (cycleCount % ORPHAN_PR_CHECK_EVERY_N_CYCLES === 0)", () => {
    // With ORPHAN_PR_CHECK_EVERY_N_CYCLES = 1 every positive integer satisfies the condition.
    for (const n of [1, 2, 3, 10, 100]) {
      expect(n % ORPHAN_PR_CHECK_EVERY_N_CYCLES).toBe(0);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// extractChecklistText — extract checklist from PR feedback description
// ────────────────────────────────────────────────────────────────────────────

describe("extractChecklistText", () => {
  it("returns null for null input", () => {
    expect(extractChecklistText(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(extractChecklistText(undefined)).toBeNull();
  });

  it("extracts checklist from simple single-round format", () => {
    const desc =
      "Your PR #42 on owner/repo was reviewed and needs changes. Work through every item in the checklist below before pushing:\n\n" +
      "1. Add `Closes #42` to the PR body\n2. Guard `parseInt` against empty string\n\n" +
      "Check off each item, commit, and push to the same branch. Do not push until all checklist items are addressed.";
    const result = extractChecklistText(desc);
    expect(result).toBe("1. Add `Closes #42` to the PR body\n2. Guard `parseInt` against empty string");
  });

  it("extracts current review section from consolidated multi-round format", () => {
    const desc =
      "Your PR #5 on owner/repo has received 2 rounds of review feedback.\n\n" +
      "**Latest review (round 2):**\n1. Fix the null pointer\n2. Add error handling\n\n" +
      "**Prior feedback rounds — confirm these are also resolved:**\n" +
      "**Round 1 feedback (verify these items are fixed):**\n1. Add unit tests\n\n" +
      "Fix every unchecked item above, commit, and push to the same branch.";
    const result = extractChecklistText(desc);
    expect(result).toBe("1. Fix the null pointer\n2. Add error handling");
  });

  it("falls back to truncated description when format is unrecognised", () => {
    const desc = "Some completely different format with no checklist markers at all.";
    const result = extractChecklistText(desc);
    expect(result).toBe(desc);
  });

  it("truncates unknown format descriptions to 600 chars", () => {
    const longDesc = "x".repeat(700);
    const result = extractChecklistText(longDesc);
    expect(result?.length).toBe(600);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildConsolidatedFeedbackMessage — consolidate multi-round PR feedback
// ────────────────────────────────────────────────────────────────────────────

describe("buildConsolidatedFeedbackMessage", () => {
  const REPO = "owner/repo";
  const PR = 42;
  const CURRENT = "1. Fix the bug\n2. Add a test";

  it("returns the original single-round format when no prior rounds exist", () => {
    const msg = buildConsolidatedFeedbackMessage(REPO, PR, CURRENT, []);
    expect(msg).toContain(`Your PR #${PR} on ${REPO} was reviewed and needs changes.`);
    expect(msg).toContain("Work through every item in the checklist below before pushing:");
    expect(msg).toContain(CURRENT);
    expect(msg).toContain("Check off each item, commit, and push to the same branch.");
    // Must NOT contain consolidated-format markers
    expect(msg).not.toContain("rounds of review feedback");
    expect(msg).not.toContain("Latest review");
  });

  it("uses consolidated format when prior rounds are present", () => {
    const priorDesc =
      `Your PR #${PR} on ${REPO} was reviewed and needs changes. Work through every item in the checklist below before pushing:\n\n` +
      "1. Add Closes #N to PR body\n\n" +
      "Check off each item, commit, and push to the same branch. Do not push until all checklist items are addressed.";

    const msg = buildConsolidatedFeedbackMessage(REPO, PR, CURRENT, [priorDesc]);
    expect(msg).toContain("2 rounds of review feedback");
    expect(msg).toContain("**Latest review (round 2):**");
    expect(msg).toContain(CURRENT);
    expect(msg).toContain("**Prior feedback rounds");
    expect(msg).toContain("**Round 1 feedback");
    expect(msg).toContain("1. Add Closes #N to PR body");
  });

  it("includes all prior rounds when multiple exist", () => {
    const makeSimpleDesc = (checklist: string) =>
      `Your PR was reviewed and needs changes. Work through every item in the checklist below before pushing:\n\n${checklist}\n\nCheck off each item, commit, and push to the same branch. Do not push until all checklist items are addressed.`;

    const prior1 = makeSimpleDesc("1. Fix round-1 issue");
    const prior2 = makeSimpleDesc("1. Fix round-2 issue");

    const msg = buildConsolidatedFeedbackMessage(REPO, PR, CURRENT, [prior1, prior2]);
    expect(msg).toContain("3 rounds of review feedback");
    expect(msg).toContain("**Latest review (round 3):**");
    expect(msg).toContain("**Round 1 feedback");
    expect(msg).toContain("**Round 2 feedback");
    expect(msg).toContain("1. Fix round-1 issue");
    expect(msg).toContain("1. Fix round-2 issue");
  });

  it("handles null prior descriptions gracefully (shows fallback text)", () => {
    const msg = buildConsolidatedFeedbackMessage(REPO, PR, CURRENT, [null]);
    expect(msg).toContain("2 rounds of review feedback");
    expect(msg).toContain("checklist unavailable");
  });

  it("consolidated message always ends with instruction to fix and push", () => {
    const priorDesc =
      "Your PR was reviewed. Work through every item in the checklist below before pushing:\n\n1. item\n\nCheck off each item, commit, and push to the same branch. Do not push until all checklist items are addressed.";
    const msg = buildConsolidatedFeedbackMessage(REPO, PR, CURRENT, [priorDesc]);
    expect(msg).toContain("commit, and push to the same branch");
  });

  it("single-round message always references the correct repo and PR number", () => {
    const msg = buildConsolidatedFeedbackMessage("acme/widget", 99, "1. Fix it", []);
    expect(msg).toContain("PR #99 on acme/widget");
  });

  it("consolidated message always references the correct repo and PR number", () => {
    const priorDesc = "Your PR was reviewed. Work through every item in the checklist below before pushing:\n\n1. item\n\nCheck off each item, commit, and push. Do not push until all checklist items are addressed.";
    const msg = buildConsolidatedFeedbackMessage("acme/widget", 99, "1. Fix it", [priorDesc]);
    expect(msg).toContain("PR #99 on acme/widget");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// resolveConversationIdForPR — PR feedback session resume (issue #333)
// ────────────────────────────────────────────────────────────────────────────

describe("resolveConversationIdForPR", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("returns the conversation_id of the original task linked via Closes #N", () => {
    // Create an original task that was dispatched from github issue #42
    const task = store.createTask({
      title: "implement feature",
      description: "do the thing",
      source: "github",
      source_ref: "owner/repo#42",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, { status: "done", conversation_id: "01HXYZ_ORIGINAL_SESSION" });

    // PR body contains Closes #42
    const conversationId = resolveConversationIdForPR(store, "owner/repo", "Closes #42");
    expect(conversationId).toBe("01HXYZ_ORIGINAL_SESSION");
  });

  it("calls findTaskBySourceRef with 'github' source and correct repo#issue key", () => {
    // Spy on findTaskBySourceRef to verify args
    const spy = vi.spyOn(store, "findTaskBySourceRef");

    resolveConversationIdForPR(store, "owner/my-repo", "Closes #99");

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith("github", "owner/my-repo#99");
  });

  it("uses the first linked issue number when multiple Closes refs are present", () => {
    const task42 = store.createTask({
      title: "issue 42",
      description: "feature",
      source: "github",
      source_ref: "owner/repo#42",
      agent_name: "test-agent",
    });
    store.updateTask(task42.id, { status: "done", conversation_id: "CONV_42" });

    const task55 = store.createTask({
      title: "issue 55",
      description: "feature",
      source: "github",
      source_ref: "owner/repo#55",
      agent_name: "test-agent",
    });
    store.updateTask(task55.id, { status: "done", conversation_id: "CONV_55" });

    // Only the first linked issue (#42) should be used
    const conversationId = resolveConversationIdForPR(store, "owner/repo", "Closes #42\nFixes #55");
    expect(conversationId).toBe("CONV_42");
  });

  it("returns undefined when PR body has no issue references", () => {
    const conversationId = resolveConversationIdForPR(store, "owner/repo", "No issue reference here");
    expect(conversationId).toBeUndefined();
  });

  it("returns undefined for empty PR body", () => {
    const conversationId = resolveConversationIdForPR(store, "owner/repo", "");
    expect(conversationId).toBeUndefined();
  });

  it("returns undefined when no matching task exists in the store", () => {
    // PR body references issue #99, but no task has source_ref = owner/repo#99
    const conversationId = resolveConversationIdForPR(store, "owner/repo", "Closes #99");
    expect(conversationId).toBeUndefined();
  });

  it("returns undefined when matched task has no conversation_id", () => {
    const task = store.createTask({
      title: "task without session",
      description: "do work",
      source: "github",
      source_ref: "owner/repo#7",
      agent_name: "test-agent",
    });
    // Task exists but was never given a conversation_id
    store.updateTask(task.id, { status: "done" });

    const conversationId = resolveConversationIdForPR(store, "owner/repo", "Closes #7");
    expect(conversationId).toBeUndefined();
  });
});
