/**
 * Tests for submission queue Telegram commands (issue #1608 / #1611).
 *
 * Covers:
 *  - parseSubmissionId: integer-only matcher (ULIDs must NOT match)
 *  - buildSubmissionsList: empty + populated states
 *  - buildSubmissionShow: missing + present rows
 *  - tryHandleSubmissionApprove: matched/unmatched, status guards
 *  - tryHandleSubmissionReject: matched/unmatched, reason required, status guards
 *  - handleSubmitCommand (#1611): dry-run preview + live approve-and-ship flow
 *
 * Plus integration via handleCommand for routing:
 *  - /submissions, /submission-show, /submission-approve, /submission-reject
 *  - /submit <id> — approve + ship one-step command
 *  - Disambiguation: /approve <int> hits the submission queue while
 *    /approve <ULID> falls through to the borderline-task queue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import { handleCommand } from "./telegram.js";
import {
  buildSubmissionsList,
  buildSubmissionShow,
  handleSubmitCommand,
  parseSubmissionId,
  tryHandleSubmissionApprove,
  tryHandleSubmissionReject,
} from "./telegram-submission-commands.js";
import { SubmissionAgent } from "../orchestrator/submission-agent.js";
import type { OrchestratorConfig } from "../config/schema.js";

// ── shared mocks (same shape as telegram.test.ts) ─────────────────────────

const { execMock, execSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execSync: execSyncMock,
}));

vi.mock("../triggers/github.js", () => ({
  findExistingPRsForIssue: vi.fn().mockReturnValue([]),
  findBranchForIssue: vi.fn().mockReturnValue(null),
}));

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
  orchestrator_dir: "/tmp",
  base_dir: "/tmp",
  agents: {
    "agent-a": {
      dir: "agent-a",
      description: "Primary",
      capabilities: ["test"],
      owns_topics: ["test"],
      github: "owner/repo-a",
    },
  },
};

function seed(store: StateStore, partial: {
  title?: string;
  severity?: string;
  expected_payout_usd?: number | null;
  body?: string;
} = {}) {
  return store.addPendingSubmission({
    platform: "immunefi",
    program: "ipor",
    title: partial.title ?? "Reentrancy in withdraw()",
    severity: partial.severity ?? "high",
    body: partial.body ?? "## Summary\nA reentrancy guard is missing.",
    expected_payout_usd: partial.expected_payout_usd ?? 25_000,
    meta: { dryRun: true },
  });
}

// ── pure helpers ─────────────────────────────────────────────────────────

describe("parseSubmissionId", () => {
  it("returns the int for digit-only strings", () => {
    expect(parseSubmissionId("0")).toBe(0);
    expect(parseSubmissionId("7")).toBe(7);
    expect(parseSubmissionId("4242")).toBe(4242);
  });

  it("returns null for ULID-shaped short ids", () => {
    expect(parseSubmissionId("01KPFBW5")).toBeNull();
    expect(parseSubmissionId("01KPFBW500000000")).toBeNull();
  });

  it("returns null for empty / mixed / negative", () => {
    expect(parseSubmissionId(undefined)).toBeNull();
    expect(parseSubmissionId("")).toBeNull();
    expect(parseSubmissionId("12abc")).toBeNull();
    expect(parseSubmissionId("-3")).toBeNull();
    expect(parseSubmissionId("3.14")).toBeNull();
  });
});

// ── command builders ──────────────────────────────────────────────────────

describe("buildSubmissionsList", () => {
  let store: StateStore;
  beforeEach(() => { store = new StateStore(":memory:"); });
  afterEach(() => { store.close(); });

  it("returns the empty-state message when nothing is awaiting", () => {
    expect(buildSubmissionsList(store)).toContain("No submissions awaiting approval");
  });

  it("lists only awaiting-approval rows with id, platform/program, title", () => {
    const a = seed(store, { title: "Reentrancy A", expected_payout_usd: 5000 });
    seed(store, { title: "Reentrancy B" });
    // Approve one — it should drop out of the list
    store.approvePendingSubmission(a.id);

    const out = buildSubmissionsList(store);
    expect(out).toContain("Pending Submissions (1)");
    expect(out).toContain("Reentrancy B");
    expect(out).not.toContain("Reentrancy A");
    expect(out).toContain("immunefi/ipor");
  });
});

describe("buildSubmissionShow", () => {
  let store: StateStore;
  beforeEach(() => { store = new StateStore(":memory:"); });
  afterEach(() => { store.close(); });

  it("returns a not-found message for unknown ids", () => {
    expect(buildSubmissionShow(store, 999)).toContain("No pending submission with id");
  });

  it("renders the body and metadata for a present row", () => {
    const p = seed(store, { title: "Storage collision", body: "## Repro\nstep 1" });
    const out = buildSubmissionShow(store, p.id);
    expect(out).toContain(`Submission #${p.id}`);
    expect(out).toContain("Storage collision");
    expect(out).toContain("step 1");
    expect(out).toContain("immunefi/ipor");
  });
});

describe("tryHandleSubmissionApprove", () => {
  let store: StateStore;
  beforeEach(() => { store = new StateStore(":memory:"); });
  afterEach(() => { store.close(); });

  it("does not match non-numeric ids (caller falls through to task flow)", () => {
    expect(tryHandleSubmissionApprove(store, "01KPFBW5").matched).toBe(false);
    expect(tryHandleSubmissionApprove(store, undefined).matched).toBe(false);
  });

  it("approves an awaiting-approval submission and reports success", () => {
    const p = seed(store);
    const r = tryHandleSubmissionApprove(store, String(p.id));
    expect(r.matched).toBe(true);
    expect(r.reply).toContain("approved by operator");
    expect(store.getPendingSubmission(p.id)?.status).toBe("approved");
  });

  it("refuses to re-approve an already-approved submission", () => {
    const p = seed(store);
    store.approvePendingSubmission(p.id);
    const r = tryHandleSubmissionApprove(store, String(p.id));
    expect(r.matched).toBe(true);
    expect(r.reply).toContain("already");
    expect(r.reply).toContain("approved");
  });

  it("returns matched=true with a not-found error for unknown numeric ids", () => {
    const r = tryHandleSubmissionApprove(store, "999");
    expect(r.matched).toBe(true);
    expect(r.reply).toContain("No pending submission");
  });
});

describe("tryHandleSubmissionReject", () => {
  let store: StateStore;
  beforeEach(() => { store = new StateStore(":memory:"); });
  afterEach(() => { store.close(); });

  it("does not match non-numeric ids", () => {
    expect(tryHandleSubmissionReject(store, "01KPFBW5", "reason").matched).toBe(false);
  });

  it("requires a reason", () => {
    const p = seed(store);
    const r = tryHandleSubmissionReject(store, String(p.id), "");
    expect(r.matched).toBe(true);
    expect(r.reply).toMatch(/Usage:/);
    // Did NOT mutate the row
    expect(store.getPendingSubmission(p.id)?.status).toBe("awaiting-approval");
  });

  it("rejects an awaiting-approval submission with the supplied reason", () => {
    const p = seed(store);
    const r = tryHandleSubmissionReject(store, String(p.id), "severity inflated");
    expect(r.matched).toBe(true);
    expect(r.reply).toContain("rejected");
    expect(r.reply).toContain("severity inflated");
    const after = store.getPendingSubmission(p.id);
    expect(after?.status).toBe("rejected");
    expect(after?.rejection_reason).toBe("severity inflated");
  });
});

// ── handleCommand integration: routing + disambiguation ───────────────────

describe("handleCommand integration: submission queue", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    }));
  });

  afterEach(() => {
    store.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("/submissions returns the empty-state when there are no rows", async () => {
    const reply = await handleCommand("/submissions", {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });
    expect(reply).toContain("No submissions awaiting approval");
  });

  it("/submissions lists pending rows by id", async () => {
    const p = seed(store, { title: "Logic flaw in fees" });
    const reply = await handleCommand("/submissions", {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });
    expect(reply).toContain(`#${p.id}`);
    expect(reply).toContain("Logic flaw in fees");
  });

  it("/submission-show <id> renders the full body", async () => {
    const p = seed(store, { body: "## Repro\nspecific repro details here" });
    const reply = await handleCommand(`/submission-show ${p.id}`, {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });
    expect(reply).toContain(`Submission #${p.id}`);
    expect(reply).toContain("specific repro details here");
  });

  it("/submission-approve <id> transitions the row to approved", async () => {
    const p = seed(store);
    const reply = await handleCommand(`/submission-approve ${p.id}`, {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });
    expect(reply).toContain("approved by operator");
    expect(store.getPendingSubmission(p.id)?.status).toBe("approved");
  });

  it("/submission-reject <id> <reason> stores the reason", async () => {
    const p = seed(store);
    const reply = await handleCommand(
      `/submission-reject ${p.id} severity is medium not high`,
      {
        config,
        store,
        dispatcher: { dispatch: vi.fn() } as never,
      },
    );
    expect(reply).toContain("rejected");
    const after = store.getPendingSubmission(p.id);
    expect(after?.status).toBe("rejected");
    expect(after?.rejection_reason).toBe("severity is medium not high");
  });

  it("/approve with a numeric id hits the submission queue (disambiguation)", async () => {
    const p = seed(store);
    const reply = await handleCommand(`/approve ${p.id}`, {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });
    expect(reply).toContain("approved by operator");
    expect(store.getPendingSubmission(p.id)?.status).toBe("approved");
  });

  it("/reject with a numeric id + reason hits the submission queue", async () => {
    const p = seed(store);
    const reply = await handleCommand(`/reject ${p.id} body has injection markers`, {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });
    expect(reply).toContain("rejected");
    const after = store.getPendingSubmission(p.id);
    expect(after?.status).toBe("rejected");
    expect(after?.rejection_reason).toBe("body has injection markers");
  });

  it("/approve with a ULID-shaped id falls through to the task approval queue (no submission match)", async () => {
    // A real ULID won't match any approval queue entry either, but the
    // expected reply is the *task* "no entry found" message — proving the
    // submission handler did NOT swallow the command.
    const ulid = "01KPFBW5";
    const reply = await handleCommand(`/approve ${ulid}`, {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });
    expect(reply).toContain("No approval queue entry");
    expect(reply).toContain(ulid);
  });
});

// ── handleSubmitCommand (#1611) ───────────────────────────────────────────────

/**
 * Minimal stub for SubmissionAgent: only `submitApproved` needs to be
 * overrideable for these tests. Real adapter registration is tested
 * in submission-agent.test.ts.
 */
function makeAgent(
  store: StateStore,
  submitOutcome: "ok" | "network-error" | "platform-rejected" | "no-adapter" = "ok",
): SubmissionAgent {
  const agent = new SubmissionAgent(store, []);
  // Override submitApproved with a controlled stub.
  agent.submitApproved = async (id: number) => {
    if (submitOutcome === "ok") {
      return {
        ok: true as const,
        submission: {
          id: 1,
          pending_id: id,
          platform: "immunefi",
          program: "ipor",
          title: "Reentrancy in withdraw()",
          severity: "high",
          platform_submission_id: "stub-sub-001",
          status_url: "https://bugs.example.invalid/ipor/001",
          expected_payout_usd: 25_000,
          actual_payout_usd: null,
          status: "submitted" as const,
          submitted_at: "2026-05-15T06:00:00.000Z",
          updated_at: "2026-05-15T06:00:00.000Z",
        },
      };
    }
    if (submitOutcome === "network-error") {
      return { ok: false as const, reason: "network-error" as const, detail: "timeout after 30s" };
    }
    if (submitOutcome === "platform-rejected") {
      return { ok: false as const, reason: "platform-rejected" as const, detail: "duplicate submission" };
    }
    // no-adapter
    return { ok: false as const, reason: "platform-rejected" as const, detail: "No adapter registered" };
  };
  return agent;
}

describe("handleSubmitCommand", () => {
  let store: StateStore;
  const savedFlag = process.env.SUBMISSION_AGENT_ENABLED;

  beforeEach(() => {
    store = new StateStore(":memory:");
    delete process.env.SUBMISSION_AGENT_ENABLED;
  });

  afterEach(() => {
    store.close();
    if (savedFlag !== undefined) process.env.SUBMISSION_AGENT_ENABLED = savedFlag;
    else delete process.env.SUBMISSION_AGENT_ENABLED;
  });

  // ── argument parsing ────────────────────────────────────────────────────

  it("returns usage for missing id", async () => {
    const { reply } = await handleSubmitCommand(store, makeAgent(store), undefined);
    expect(reply).toMatch(/Usage:.*\/submit/i);
  });

  it("returns usage for a ULID-shaped id", async () => {
    const { reply } = await handleSubmitCommand(store, makeAgent(store), "01KPFBW5");
    expect(reply).toMatch(/Usage:.*\/submit/i);
  });

  // ── dry-run (flag off) ──────────────────────────────────────────────────

  it("dry-run: shows preview when SUBMISSION_AGENT_ENABLED is not set", async () => {
    const p = seed(store, { title: "Overflow in fee accumulator" });
    const { reply } = await handleSubmitCommand(store, makeAgent(store), String(p.id));
    expect(reply).toContain("Dry run");
    expect(reply).toContain("SUBMISSION_AGENT_ENABLED");
    expect(reply).toContain("Overflow in fee accumulator");
    expect(reply).toContain("immunefi/ipor");
    // Must not mutate state
    expect(store.getPendingSubmission(p.id)?.status).toBe("awaiting-approval");
  });

  it("dry-run: not-found returns a clear error (no state change)", async () => {
    const { reply } = await handleSubmitCommand(store, makeAgent(store), "999");
    expect(reply).toContain("No pending submission");
    // Nothing was approved
    expect(store.getPendingSubmission(999)).toBeNull();
  });

  it("dry-run: shows status note when submission is not awaiting-approval", async () => {
    const p = seed(store);
    store.approvePendingSubmission(p.id); // status → approved
    const { reply } = await handleSubmitCommand(store, makeAgent(store), String(p.id));
    expect(reply).toContain("Dry run");
    expect(reply).toMatch(/status.*approved/i);
    // Still approved — dry-run did not change anything
    expect(store.getPendingSubmission(p.id)?.status).toBe("approved");
  });

  // ── live mode (flag on) ─────────────────────────────────────────────────

  it("live: not-found returns a clear error", async () => {
    process.env.SUBMISSION_AGENT_ENABLED = "true";
    const { reply } = await handleSubmitCommand(store, makeAgent(store), "999");
    expect(reply).toContain("No pending submission");
  });

  it("live: approves awaiting-approval submission then ships it", async () => {
    process.env.SUBMISSION_AGENT_ENABLED = "true";
    const p = seed(store, { title: "Reentrancy in withdraw()" });
    const agent = makeAgent(store, "ok");
    const { reply } = await handleSubmitCommand(store, agent, String(p.id));
    expect(reply).toContain("approved + shipped");
    expect(reply).toContain("immunefi/ipor");
    expect(reply).toContain("bugs.example.invalid/ipor/001");
    // Row was approved (then consumed by agent.submitApproved in a real impl;
    // our stub doesn't update the store, so check it reached approved)
    expect(store.getPendingSubmission(p.id)?.status).toBe("approved");
  });

  it("live: skips approve step when submission is already approved", async () => {
    process.env.SUBMISSION_AGENT_ENABLED = "true";
    const p = seed(store);
    store.approvePendingSubmission(p.id); // pre-approved via /submission-approve
    const agent = makeAgent(store, "ok");
    const { reply } = await handleSubmitCommand(store, agent, String(p.id));
    expect(reply).toContain("approved + shipped");
    // Still approved (stub doesn't consume; real agent would mark consumed)
    expect(store.getPendingSubmission(p.id)?.status).toBe("approved");
  });

  it("live: errors when submission is rejected", async () => {
    process.env.SUBMISSION_AGENT_ENABLED = "true";
    const p = seed(store);
    store.rejectPendingSubmission(p.id, "severity inflated");
    const { reply } = await handleSubmitCommand(store, makeAgent(store, "ok"), String(p.id));
    expect(reply).toContain("rejected");
    expect(reply).toContain("cannot approve-and-ship");
  });

  it("live: errors when submission is consumed", async () => {
    process.env.SUBMISSION_AGENT_ENABLED = "true";
    const p = seed(store);
    store.approvePendingSubmission(p.id);
    store.markPendingSubmissionConsumed(p.id);
    const { reply } = await handleSubmitCommand(store, makeAgent(store, "ok"), String(p.id));
    expect(reply).toContain("consumed");
    expect(reply).toContain("cannot approve-and-ship");
  });

  it("live: shows approve success + ship failure when network errors", async () => {
    process.env.SUBMISSION_AGENT_ENABLED = "true";
    const p = seed(store);
    const agent = makeAgent(store, "network-error");
    const { reply } = await handleSubmitCommand(store, agent, String(p.id));
    expect(reply).toContain("approved");
    expect(reply).toContain("Ship failed");
    expect(reply).toContain("network-error");
    expect(reply).toContain("timeout after 30s");
  });

  it("live: shows approve success + ship failure on platform rejection", async () => {
    process.env.SUBMISSION_AGENT_ENABLED = "true";
    const p = seed(store);
    const agent = makeAgent(store, "platform-rejected");
    const { reply } = await handleSubmitCommand(store, agent, String(p.id));
    expect(reply).toContain("approved");
    expect(reply).toContain("Ship failed");
    expect(reply).toContain("duplicate submission");
  });
});

// ── /submit handleCommand integration ────────────────────────────────────────

describe("handleCommand integration: /submit", () => {
  let store: StateStore;
  const savedFlag = process.env.SUBMISSION_AGENT_ENABLED;

  beforeEach(() => {
    store = new StateStore(":memory:");
    delete process.env.SUBMISSION_AGENT_ENABLED;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    }));
  });

  afterEach(() => {
    store.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    if (savedFlag !== undefined) process.env.SUBMISSION_AGENT_ENABLED = savedFlag;
    else delete process.env.SUBMISSION_AGENT_ENABLED;
  });

  it("/submit <id> returns dry-run preview when flag is off", async () => {
    const p = seed(store, { title: "Flash loan price manipulation" });
    const reply = await handleCommand(`/submit ${p.id}`, {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });
    expect(reply).toContain("Dry run");
    expect(reply).toContain("Flash loan price manipulation");
    // No state mutation
    expect(store.getPendingSubmission(p.id)?.status).toBe("awaiting-approval");
  });

  it("/submit returns usage for missing id", async () => {
    const reply = await handleCommand("/submit", {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });
    expect(reply).toMatch(/Usage:.*\/submit/i);
  });
});
