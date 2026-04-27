/**
 * Tests for the enriched /review-queue task context card — issue #299.
 *
 * Covers:
 *   - parseDimensionsFromNotes: standard and alternate labels, missing data
 *   - extractPrUrl: pull URL derivation from source_ref
 *   - buildRiskSummary: priority order (quality_explanation → dims → fallback)
 *   - formatRichTaskCard: full card output structure
 *   - handleReviewQueue enriched output via runTelegramCommand
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseDimensionsFromNotes,
  extractPrUrl,
  buildRiskSummary,
  formatRichTaskCard,
} from "../telegram/command-handler.js";
import { TelegramCommandHandler } from "../telegram/command-handler.js";
import type {
  Task,
  IStateStore,
  AgentHealth,
  DispatchRequest,
  MergeQueueEntry,
  QualityHealthReport,
  SupervisorDecisionQuery,
  SupervisorDecisionRecord,
} from "../state/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const NOW = "2026-04-18T12:00:00.000Z";

const DIMENSION_NOTES = `## Quality Dimensions Breakdown
- **Correctness**: 40/100 ✗ (logic, no bugs)
- **Completeness**: 50/100 ✗ (requirements met)
- **Test Coverage**: 35/100 ✗ (edge cases covered)
- **Code Quality**: 45/100 ✗ (clarity, documentation)`;

const RESEARCH_DIMENSION_NOTES = `## Quality Dimensions Breakdown
- **Correctness**: 70/100 ✗ (claims technically sound)
- **Completeness**: 80/100 ✓ (all aspects of question addressed)
- **Evidence Coverage**: 60/100 ✗ (findings validated, evidence comprehensive)
- **Schema Compliance**: 55/100 ✗ (all 5 required sections present and substantive)`;

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "01HZXTEST00000000000000000",
    title: "Fix the auth bug in login flow",
    description: null,
    status: "done",
    agent_name: "claude-agent-a",
    task_type: "implementation",
    source: null,
    source_ref: null,
    result: null,
    verification_status: "needs_operator_review",
    quality_score: 0.44,
    verification_notes: null,
    quality_explanation: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeStore(tasks: Task[]): IStateStore {
  const systemFlags = new Map<string, string>();
  const decisions: SupervisorDecisionRecord[] = [];

  return {
    getTask: (id: string) => tasks.find((t) => t.id === id) ?? null,
    updateTask: (id: string, updates) => {
      const task = tasks.find((t) => t.id === id);
      if (task) Object.assign(task, updates);
    },
    hasActiveTask: () => false,
    listTasks: ({ status, agent_name, limit }) =>
      tasks
        .filter((t) => {
          if (status && t.status !== status) return false;
          if (agent_name && t.agent_name !== agent_name) return false;
          return true;
        })
        .slice(0, limit ?? 100),
    getRecentCompleted: () => [],
    getUnverified: () => [],
    getAgentStats: () => [],
    getAgentHealthBatch: () => [] as AgentHealth[],
    getRecentSupervisorDecisions: () => [],
    querySupervisorDecisions: (_opts: SupervisorDecisionQuery) => decisions,
    pruneOldSupervisorDecisions: () => 0,
    recordSupervisorDecision: () => undefined,
    queuePRForMerge: (_repo: string, prNumber: number, branch: string): MergeQueueEntry => ({
      repo: "repo",
      pr_number: prNumber,
      branch,
      status: "queued",
      position: 1,
      created_at: NOW,
    }),
    getMergeQueue: () => [],
    isPRInMergeQueue: () => false,
    markQueuedPRMerging: () => undefined,
    markQueuedPRMerged: () => undefined,
    markQueuedPRFailed: () => undefined,
    removeFromMergeQueue: () => undefined,
    recordPRReview: () => undefined,
    getSystemFlag: (key: string) => systemFlags.get(key) ?? null,
    setSystemFlag: (key: string, value: string) => { systemFlags.set(key, value); },
    createDispatchRequest: (agentName: string, message: string): DispatchRequest => ({
      id: `dispatch-${agentName}`,
      agent_name: agentName,
      message,
      status: "pending",
      created_at: NOW,
    }),
    getPendingDispatchRequests: () => [],
    prioritizeTask: () => false,
    insertVerificationResult: () => undefined,
    getVerificationStats: () => null,
    getLatestVerificationRecord: () => null,
    getQualityHealthReport: () => ({
      generated_at: NOW,
      window_tasks: 20,
      threshold: 0.75,
      total_task_count: 0,
      scored_task_count: 0,
      null_score_count: 0,
      below_threshold_count: 0,
      system_avg_score: null,
      per_agent: [],
    }) as QualityHealthReport,
    getTasksInOperatorReview: () => tasks.filter((t) => t.verification_status === "needs_operator_review"),
    operatorOverride: (taskId: string, decision: "approve" | "reject", operatorNote: string) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task || task.verification_status !== "needs_operator_review") return false;
      const label = decision === "approve" ? "APPROVED" : "REJECTED";
      const overrideNote = `[operator-override: ${label}] ${operatorNote}`;
      task.verification_status = decision === "approve" ? "approved" : "rejected";
      task.verification_notes = task.verification_notes
        ? `${overrideNote}\n\n${task.verification_notes}`
        : overrideNote;
      return true;
    },
  };
}

async function runTelegramCommand(store: IStateStore, text: string): Promise<string> {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "42";

  let messageText = "";
  let delivered = false;
  let resolveSent: (() => void) | undefined;
  const sent = new Promise<void>((resolve) => { resolveSent = resolve; });

  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(url);
    if (endpoint.includes("/getUpdates")) {
      if (delivered) {
        await sent;
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      delivered = true;
      return new Response(
        JSON.stringify({
          ok: true,
          result: [{ update_id: 1, message: { message_id: 1, chat: { id: 42 }, text } }],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (endpoint.includes("/sendMessage")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      messageText = body.text ?? "";
      resolveSent?.();
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      headers: { "Content-Type": "application/json" },
    });
  });

  const handler = new TelegramCommandHandler(store as unknown as Parameters<typeof TelegramCommandHandler>[0]);
  const stop = handler.start();

  await sent;
  stop();
  fetchSpy.mockRestore();

  process.env.TELEGRAM_BOT_TOKEN = savedToken;
  process.env.TELEGRAM_CHAT_ID = savedChat;

  return messageText;
}

// ── parseDimensionsFromNotes ────────────────────────────────────────────────

describe("parseDimensionsFromNotes", () => {
  it("returns null for null notes", () => {
    expect(parseDimensionsFromNotes(null)).toBeNull();
  });

  it("returns null for undefined notes", () => {
    expect(parseDimensionsFromNotes(undefined)).toBeNull();
  });

  it("returns null when no dimension scores are present", () => {
    expect(parseDimensionsFromNotes("[HELD FOR OPERATOR REVIEW]")).toBeNull();
  });

  it("parses all four standard dimensions correctly", () => {
    const dims = parseDimensionsFromNotes(DIMENSION_NOTES);
    expect(dims).not.toBeNull();
    expect(dims!.correctness).toBeCloseTo(0.40);
    expect(dims!.completeness).toBeCloseTo(0.50);
    expect(dims!.test_coverage).toBeCloseTo(0.35);
    expect(dims!.code_quality).toBeCloseTo(0.45);
  });

  it("parses research task labels (Evidence Coverage, Schema Compliance)", () => {
    const dims = parseDimensionsFromNotes(RESEARCH_DIMENSION_NOTES);
    expect(dims).not.toBeNull();
    expect(dims!.correctness).toBeCloseTo(0.70);
    expect(dims!.completeness).toBeCloseTo(0.80);
    expect(dims!.test_coverage).toBeCloseTo(0.60);  // Evidence Coverage → test_coverage
    expect(dims!.code_quality).toBeCloseTo(0.55);   // Schema Compliance → code_quality
  });

  it("returns null for missing dimensions when only partial data present", () => {
    const partial = `## Quality Dimensions Breakdown
- **Correctness**: 60/100 ✓ (logic, no bugs)`;
    const dims = parseDimensionsFromNotes(partial);
    expect(dims).not.toBeNull();
    expect(dims!.correctness).toBeCloseTo(0.60);
    expect(dims!.completeness).toBeNull();
    expect(dims!.test_coverage).toBeNull();
    expect(dims!.code_quality).toBeNull();
  });

  it("handles 100/100 correctly", () => {
    const full = `- **Correctness**: 100/100 ✓ (logic, no bugs)`;
    const dims = parseDimensionsFromNotes(full);
    expect(dims!.correctness).toBeCloseTo(1.0);
  });
});

// ── extractPrUrl ───────────────────────────────────────────────────────────

describe("extractPrUrl", () => {
  it("returns null when source_ref is null", () => {
    const task = makeTask({ source_ref: null });
    expect(extractPrUrl(task)).toBeNull();
  });

  it("returns null for issue-style source_ref", () => {
    const task = makeTask({ source_ref: "rapartlu/agent-reviewer#299" });
    expect(extractPrUrl(task)).toBeNull();
  });

  it("returns full GitHub PR URL for pull-style source_ref", () => {
    const task = makeTask({ source_ref: "rapartlu/agent-reviewer/pull/305" });
    expect(extractPrUrl(task)).toBe("https://github.com/rapartlu/agent-reviewer/pull/305");
  });

  it("handles repos with hyphens and dots in name", () => {
    const task = makeTask({ source_ref: "my-org/my.repo/pull/42" });
    expect(extractPrUrl(task)).toBe("https://github.com/my-org/my.repo/pull/42");
  });
});

// ── buildRiskSummary ───────────────────────────────────────────────────────

describe("buildRiskSummary", () => {
  it("uses quality_explanation first sentence when available", () => {
    const task = makeTask({
      quality_explanation:
        "Test coverage was thin, missing edge cases for the retry path. The correctness was acceptable.",
    });
    const summary = buildRiskSummary(task);
    expect(summary).toContain("Test coverage was thin");
    // Should only be the first sentence
    expect(summary).not.toContain("The correctness was acceptable");
  });

  it("truncates quality_explanation to 150 chars", () => {
    const task = makeTask({
      quality_explanation: "A".repeat(200),
    });
    const summary = buildRiskSummary(task);
    expect(summary.length).toBeLessThanOrEqual(150);
  });

  it("derives summary from dimensions when no quality_explanation", () => {
    const task = makeTask({
      quality_score: 0.44,
      verification_notes: DIMENSION_NOTES,
      quality_explanation: null,
    });
    const summary = buildRiskSummary(task);
    // Should mention the weakest dimension (test coverage = 0.35)
    expect(summary).toContain("test coverage");
    expect(summary).toContain("35/100");
  });

  it("falls back to generic critical message when score < 0.50 and no dims", () => {
    const task = makeTask({
      quality_score: 0.44,
      verification_notes: null,
      quality_explanation: null,
    });
    const summary = buildRiskSummary(task);
    expect(summary).toContain("Critical");
    expect(summary).toContain("0.50");
  });

  it("falls back to floor message when score ≥ 0.50 and no dims", () => {
    const task = makeTask({
      quality_score: 0.55,
      verification_notes: null,
      quality_explanation: null,
    });
    const summary = buildRiskSummary(task);
    expect(summary).toContain("0.60");
    expect(summary).toContain("0.55");
  });
});

// ── formatRichTaskCard ─────────────────────────────────────────────────────

describe("formatRichTaskCard", () => {
  it("includes task title in the card header", () => {
    const task = makeTask({ title: "Fix the auth bug in login flow" });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("Fix the auth bug in login flow");
  });

  it("includes short task ID", () => {
    const task = makeTask({ id: "01HZXTEST00000000000000000" });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("01HZXTES");
  });

  it("includes agent name", () => {
    const task = makeTask({ agent_name: "claude-orchestrator-reviewer" });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("claude-orchestrator-reviewer");
  });

  it("includes quality score", () => {
    const task = makeTask({ quality_score: 0.44 });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("0.44");
  });

  it("includes PR link when source_ref is a pull URL", () => {
    const task = makeTask({ source_ref: "rapartlu/agent-reviewer/pull/305" });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("https://github.com/rapartlu/agent-reviewer/pull/305");
  });

  it("shows source_ref label when ref is not a PR URL", () => {
    const task = makeTask({ source_ref: "rapartlu/agent-reviewer#299" });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("rapartlu/agent-reviewer#299");
  });

  it("includes per-dimension breakdown when verification_notes has dimensions", () => {
    const task = makeTask({ verification_notes: DIMENSION_NOTES });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("Correctness");
    expect(card).toContain("40/100");
    expect(card).toContain("Completeness");
    expect(card).toContain("50/100");
    expect(card).toContain("Test coverage");
    expect(card).toContain("35/100");
    expect(card).toContain("Code quality");
    expect(card).toContain("45/100");
  });

  it("shows ✓ for dimensions at or above 0.80, ✗ below", () => {
    const notes = `- **Correctness**: 85/100 ✓ (logic)
- **Completeness**: 70/100 ✗ (requirements)`;
    const task = makeTask({ verification_notes: notes });
    const card = formatRichTaskCard(task).join("\n");
    // Correctness 0.85 → ✓
    expect(card).toMatch(/✓.*Correctness/);
    // Completeness 0.70 → ✗
    expect(card).toMatch(/✗.*Completeness/);
  });

  it("includes risk summary", () => {
    const task = makeTask({
      quality_explanation: "The implementation missed core edge cases in the retry logic.",
    });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("missed core edge cases");
  });

  it("includes /approve and /reject action hints with short ID", () => {
    const task = makeTask({ id: "01HZXTEST00000000000000000" });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("/approve 01HZXTES");
    expect(card).toContain("/reject 01HZXTES");
  });

  it("shows 🔴 critical badge for score < 0.50", () => {
    const task = makeTask({ quality_score: 0.48 });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("🔴 critical");
  });

  it("shows 🟡 low badge for score 0.50–0.59", () => {
    const task = makeTask({ quality_score: 0.55 });
    const card = formatRichTaskCard(task).join("\n");
    expect(card).toContain("🟡 low");
  });
});

// ── /review-queue enriched output (integration) ────────────────────────────

describe("/review-queue enriched output — issue #299", () => {
  function makeHeldTask(overrides: Partial<Task> = {}): Task {
    return makeTask({
      id: "01KPRICH000000000000000001",
      title: "Implement OAuth token refresh",
      agent_name: "claude-orchestrator-dashboard",
      quality_score: 0.44,
      verification_notes: DIMENSION_NOTES,
      quality_explanation:
        "Test coverage was thin, missing the refresh-token expiry edge case.",
      source_ref: "rapartlu/agent-dashboard/pull/369",
      verification_status: "needs_operator_review",
      ...overrides,
    });
  }

  it("includes PR link in the review queue output", async () => {
    const task = makeHeldTask();
    const store = makeStore([task]);
    const reply = await runTelegramCommand(store, "/review-queue");
    expect(reply).toContain("https://github.com/rapartlu/agent-dashboard/pull/369");
  });

  it("includes per-dimension breakdown in the review queue output", async () => {
    const task = makeHeldTask();
    const store = makeStore([task]);
    const reply = await runTelegramCommand(store, "/review-queue");
    expect(reply).toContain("Correctness");
    expect(reply).toContain("40/100");
    expect(reply).toContain("Test coverage");
    expect(reply).toContain("35/100");
  });

  it("includes risk summary derived from quality_explanation", async () => {
    const task = makeHeldTask();
    const store = makeStore([task]);
    const reply = await runTelegramCommand(store, "/review-queue");
    expect(reply).toContain("Test coverage was thin");
  });

  it("shows approve/reject hints per task with short ID", async () => {
    const task = makeHeldTask();
    const store = makeStore([task]);
    const reply = await runTelegramCommand(store, "/review-queue");
    // Short ID is first 8 chars of "01KPRICH000000000000000001"
    expect(reply).toContain("/approve 01KPRICH");
    expect(reply).toContain("/reject 01KPRICH");
  });

  it("includes task title in each card", async () => {
    const task = makeHeldTask();
    const store = makeStore([task]);
    const reply = await runTelegramCommand(store, "/review-queue");
    expect(reply).toContain("Implement OAuth token refresh");
  });

  it("includes agent name in each card", async () => {
    const task = makeHeldTask();
    const store = makeStore([task]);
    const reply = await runTelegramCommand(store, "/review-queue");
    expect(reply).toContain("claude-orchestrator-dashboard");
  });

  it("includes quality score in each card", async () => {
    const task = makeHeldTask();
    const store = makeStore([task]);
    const reply = await runTelegramCommand(store, "/review-queue");
    expect(reply).toContain("0.44");
  });

  it("shows derived risk summary when no quality_explanation present", async () => {
    const task = makeHeldTask({
      quality_explanation: null,
      verification_notes: DIMENSION_NOTES,
    });
    const store = makeStore([task]);
    const reply = await runTelegramCommand(store, "/review-queue");
    // Should mention weakest dimension (test coverage = 0.35)
    expect(reply).toContain("test coverage");
  });

  it("provides complete context for approval decision without GitHub or dashboard", async () => {
    const task = makeHeldTask();
    const store = makeStore([task]);
    const reply = await runTelegramCommand(store, "/review-queue");

    // All decision-relevant fields must be present in one message
    expect(reply).toContain("Implement OAuth token refresh");        // what was built
    expect(reply).toContain("https://github.com");                  // PR link
    expect(reply).toContain("Correctness");                         // which dimensions failed
    expect(reply).toContain("Test coverage was thin");              // why it failed
    expect(reply).toContain("/approve");                            // action hint
    expect(reply).toContain("/reject");                             // action hint
  });
});
