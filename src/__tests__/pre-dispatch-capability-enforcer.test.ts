import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PreDispatchCapabilityEnforcer,
  shouldBlock,
  findAuthorshipKeyword,
  extractRepoFromRef,
  REVIEWER_AGENT_NAME,
  AUTHORSHIP_KEYWORDS,
} from "../reviewer/pre-dispatch-capability-enforcer.js";
import type { PreDispatchCheckRequest } from "../reviewer/pre-dispatch-capability-enforcer.js";
import { REVIEWER_REPO } from "../reviewer/capability-check.js";
import type { ReviewerConfig } from "../config.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const baseConfig: ReviewerConfig = {
  base_dir: "/tmp",
  orchestrator_dir: "/tmp/agent-orchestrator",
  agents: {
    "claude-agent-orchestrator": {
      description: "Orchestrator agent",
      github: "rapartlu/agent-orchestrator",
      dir: "agent-orchestrator",
    },
    "claude-orchestrator-dashboard": {
      description: "Dashboard agent",
      github: "rapartlu/agent-dashboard",
      dir: "agent-dashboard",
    },
    "claude-orchestrator-reviewer": {
      description: "Reviewer agent",
      github: "rapartlu/agent-reviewer",
      dir: "agent-reviewer",
    },
  },
};

function makeRequest(overrides: Partial<PreDispatchCheckRequest> = {}): PreDispatchCheckRequest {
  return {
    task_title: "Implement new feature",
    task_type: "implementation",
    source_ref: "rapartlu/agent-orchestrator#965",
    target_agent: REVIEWER_AGENT_NAME,
    ...overrides,
  };
}

// ── extractRepoFromRef ───────────────────────────────────────────────────

describe("extractRepoFromRef", () => {
  it("extracts repo from a valid source_ref", () => {
    expect(extractRepoFromRef("rapartlu/agent-orchestrator#965")).toBe("rapartlu/agent-orchestrator");
  });

  it("returns null for missing hash", () => {
    expect(extractRepoFromRef("rapartlu/agent-orchestrator")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(extractRepoFromRef(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(extractRepoFromRef(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractRepoFromRef("")).toBeNull();
  });

  it("handles hash at start (invalid)", () => {
    expect(extractRepoFromRef("#123")).toBeNull();
  });
});

// ── findAuthorshipKeyword ────────────────────────────────────────────────

describe("findAuthorshipKeyword", () => {
  it.each(AUTHORSHIP_KEYWORDS as string[])("detects keyword '%s' in title", (kw) => {
    const title = `Please ${kw} the feature in agent-orchestrator`;
    expect(findAuthorshipKeyword(title)).toBe(kw);
  });

  it("returns null when no keyword is present", () => {
    expect(findAuthorshipKeyword("Review open PRs for quality")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(findAuthorshipKeyword("IMPLEMENT feature")).toBe("implement");
    expect(findAuthorshipKeyword("Build the thing")).toBe("build");
    expect(findAuthorshipKeyword("WRITE the code")).toBe("write");
  });

  it("detects 'create pr' as a multi-word keyword", () => {
    expect(findAuthorshipKeyword("create pr for issue #330")).toBe("create pr");
  });

  it("returns null for empty title", () => {
    expect(findAuthorshipKeyword("")).toBeNull();
  });
});

// ── shouldBlock ──────────────────────────────────────────────────────────

describe("shouldBlock", () => {
  // ── Not targeting reviewer → always allow ───────────────────────────

  it("does not block when target_agent is not the reviewer", () => {
    const result = shouldBlock(makeRequest({ target_agent: "claude-agent-orchestrator" }));
    expect(result.block).toBe(false);
  });

  // ── Authorship keywords → block ──────────────────────────────────────

  it.each(AUTHORSHIP_KEYWORDS as string[])("blocks reviewer task with keyword '%s' in title", (kw) => {
    const result = shouldBlock(
      makeRequest({
        task_title: `${kw} authentication module`,
        task_type: "implementation",
        source_ref: "rapartlu/agent-orchestrator#100",
      }),
    );
    expect(result.block).toBe(true);
    if (result.block) {
      expect(result.keyword).toBe(kw);
    }
  });

  // ── task_type = "implementation" (no keyword) → block ────────────────

  it("blocks reviewer when task_type is 'implementation' even without keyword in title", () => {
    const result = shouldBlock(
      makeRequest({
        task_title: "Fix the state store module for orchestrator",
        task_type: "implementation",
        source_ref: "rapartlu/agent-orchestrator#50",
      }),
    );
    expect(result.block).toBe(true);
  });

  // ── Own-repo exception ───────────────────────────────────────────────

  it("does not block when source_ref targets the reviewer's own repo", () => {
    const result = shouldBlock(
      makeRequest({
        task_title: "implement capability check endpoint",
        task_type: "implementation",
        source_ref: `${REVIEWER_REPO}#330`,
      }),
    );
    expect(result.block).toBe(false);
  });

  it("does not block reviewer-scoped work (no keyword, non-implementation type)", () => {
    const result = shouldBlock(
      makeRequest({
        task_title: "Triage open issues for agent-reviewer",
        task_type: "housekeeping",
        source_ref: "rapartlu/agent-orchestrator#200",
      }),
    );
    expect(result.block).toBe(false);
  });

  // ── Review-type task with authorship keyword in title ────────────────

  it("blocks a review-typed task that has 'build' in title and targets foreign repo", () => {
    // Edge case: orchestrator may incorrectly label something "review" but
    // the title reveals it's actually authorship work.
    const result = shouldBlock(
      makeRequest({
        task_title: "build the routing module for dashboard",
        task_type: "review",
        source_ref: "rapartlu/agent-dashboard#424",
      }),
    );
    expect(result.block).toBe(true);
  });
});

// ── PreDispatchCapabilityEnforcer ────────────────────────────────────────

describe("PreDispatchCapabilityEnforcer", () => {
  let notifier: {
    isConfigured: ReturnType<typeof vi.fn>;
    notifyOperator: ReturnType<typeof vi.fn>;
  };
  let enforcer: PreDispatchCapabilityEnforcer;

  beforeEach(() => {
    notifier = {
      isConfigured: vi.fn(() => true),
      notifyOperator: vi.fn(() => Promise.resolve()),
    };
    enforcer = new PreDispatchCapabilityEnforcer(
      baseConfig,
      notifier as unknown as import("../notify.js").Notifier,
    );
  });

  // ── Allowed paths ────────────────────────────────────────────────────

  it("allows tasks targeting a different agent (not reviewer)", async () => {
    const result = await enforcer.check(
      makeRequest({ target_agent: "claude-agent-orchestrator" }),
    );
    expect(result.allowed).toBe(true);
    expect(result.alert_sent).toBe(false);
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
  });

  it("allows reviewer-type tasks on the reviewer agent", async () => {
    const result = await enforcer.check({
      task_title: "Review open PRs and score quality",
      task_type: "review",
      source_ref: "rapartlu/agent-orchestrator#200",
      target_agent: REVIEWER_AGENT_NAME,
    });
    expect(result.allowed).toBe(true);
    expect(result.alert_sent).toBe(false);
  });

  it("allows implementation tasks targeting the reviewer's own repo", async () => {
    const result = await enforcer.check({
      task_title: "implement pre-dispatch capability enforcer",
      task_type: "implementation",
      source_ref: `${REVIEWER_REPO}#330`,
      target_agent: REVIEWER_AGENT_NAME,
    });
    expect(result.allowed).toBe(true);
    expect(result.alert_sent).toBe(false);
  });

  // ── Blocked paths ────────────────────────────────────────────────────

  it("blocks an implementation task on the reviewer targeting agent-orchestrator", async () => {
    const result = await enforcer.check(
      makeRequest({
        task_title: "Implement ULID collision fix for state store",
        task_type: "implementation",
        source_ref: "rapartlu/agent-orchestrator#965",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reroute_to).toBe("claude-agent-orchestrator");
    expect(result.matched_keyword).toBe("implement");
    expect(result.reason).toContain("implementation-ineligible");
    expect(result.alert_sent).toBe(true);
  });

  it("blocks a task with 'build' keyword targeting agent-dashboard", async () => {
    const result = await enforcer.check({
      task_title: "build the dashboard capability matrix view",
      task_type: "feature",
      source_ref: "rapartlu/agent-dashboard#424",
      target_agent: REVIEWER_AGENT_NAME,
    });
    expect(result.allowed).toBe(false);
    expect(result.reroute_to).toBe("claude-orchestrator-dashboard");
    expect(result.matched_keyword).toBe("build");
    expect(result.alert_sent).toBe(true);
  });

  it("blocks a task with 'write' keyword even without source_ref", async () => {
    const result = await enforcer.check({
      task_title: "write integration tests for dashboard panel",
      task_type: "implementation",
      source_ref: undefined,
      target_agent: REVIEWER_AGENT_NAME,
    });
    expect(result.allowed).toBe(false);
    // No repo match → reroute_to undefined, but enforcement still fires
    expect(result.reroute_to).toBeUndefined();
    expect(result.alert_sent).toBe(true);
  });

  it("blocks a task with 'create pr' keyword", async () => {
    const result = await enforcer.check({
      task_title: "create PR for issue #977 in orchestrator",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#977",
      target_agent: REVIEWER_AGENT_NAME,
    });
    expect(result.allowed).toBe(false);
    expect(result.matched_keyword).toBe("create pr");
  });

  // ── Telegram alerting ────────────────────────────────────────────────

  it("sends a Telegram alert when enforcement fires", async () => {
    const result = await enforcer.check(
      makeRequest({
        task_title: "implement auth module",
        task_type: "implementation",
        source_ref: "rapartlu/agent-orchestrator#123",
      }),
    );
    // #564 noise suppression: notifyOperator is never called, but alert_sent is still
    // set to true (sendRerouteAlert logged the alert and returned normally).
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
    expect(result.alert_sent).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it("alert body contains original routing and corrected routing", async () => {
    const result = await enforcer.check(
      makeRequest({
        task_title: "build new feature X",
        task_type: "implementation",
        source_ref: "rapartlu/agent-dashboard#400",
      }),
    );
    // #564 noise suppression: alert is logged (not dispatched), routing decision intact.
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
    expect(result.allowed).toBe(false);
    expect(result.reroute_to).toBe("claude-orchestrator-dashboard");
  });

  it("does not send alert when notifier is absent", async () => {
    const enforcerNoNotifier = new PreDispatchCapabilityEnforcer(baseConfig);
    const result = await enforcerNoNotifier.check(
      makeRequest({
        task_title: "implement feature X",
        task_type: "implementation",
        source_ref: "rapartlu/agent-orchestrator#100",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.alert_sent).toBe(false);
  });

  it("does not send alert when notifier is not configured", async () => {
    notifier.isConfigured.mockReturnValue(false);
    const result = await enforcer.check(
      makeRequest({
        task_title: "implement something",
        task_type: "implementation",
        source_ref: "rapartlu/agent-orchestrator#100",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.alert_sent).toBe(false);
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
  });

  // ── Notifier failure resilience ──────────────────────────────────────

  it("still returns result when Telegram alert throws", async () => {
    notifier.notifyOperator.mockRejectedValue(new Error("Telegram timeout"));
    const result = await enforcer.check(
      makeRequest({
        task_title: "implement fallback logic",
        task_type: "implementation",
        source_ref: "rapartlu/agent-orchestrator#500",
      }),
    );
    // #564 noise suppression: notifyOperator is never called so it never throws.
    // sendRerouteAlert returns normally → alert_sent = true; routing decision correct.
    expect(result.allowed).toBe(false);
    expect(result.alert_sent).toBe(true);
    expect(result.reroute_to).toBe("claude-agent-orchestrator");
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
  });

  // ── The four tasks from the issue evidence ───────────────────────────

  it("would have blocked task 01KPHX1B: supervisor Monthly goal at 0%", async () => {
    // This task contained [supervisor] and likely asked the reviewer to create
    // or implement something — simulating with a "build" keyword variation.
    const result = await enforcer.check({
      task_title: "[supervisor] Monthly goal 'parallel subtask execution' is at 0% and #977 is the most direct",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#977",
      target_agent: REVIEWER_AGENT_NAME,
    });
    expect(result.allowed).toBe(false);
  });

  it("allows issue #330 own-repo work (routing boundary enforcement implementation)", async () => {
    const result = await enforcer.check({
      task_title: "[claude-orchestrator-reviewer] Reviewer agent routing boundary enforcement",
      task_type: "implementation",
      source_ref: `${REVIEWER_REPO}#330`,
      target_agent: REVIEWER_AGENT_NAME,
    });
    expect(result.allowed).toBe(true);
  });
});
