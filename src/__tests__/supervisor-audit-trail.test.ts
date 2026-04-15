import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { querySupervisorLog } from "../supervisor-log.js";
import { StateStore } from "../state/store.js";
import { Supervisor } from "../reviewer/supervisor.js";
import type { CalibrationDriftProvider } from "../reviewer/calibration-drift.js";
import type { Notifier } from "../notify.js";
import type { ReviewerConfig } from "../config.js";

const mockMessagesCreate = vi.hoisted(() => vi.fn());

vi.mock("../client/llm-client.js", () => ({
  createLLMClient: () => ({
    messages: {
      create: mockMessagesCreate,
    },
  }),
}));

const config: ReviewerConfig = {
  base_dir: "/tmp",
  orchestrator_dir: "/tmp",
  agents: {
    "claude-orchestrator-reviewer": {
      description: "Reviewer agent",
      dir: "reviewer",
    },
  },
};

let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "agent-reviewer-audit-"));
  mockMessagesCreate.mockReset();
});

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function makeStore(): StateStore {
  if (!tempDir) {
    throw new Error("temp dir not initialized");
  }
  return new StateStore(join(tempDir, "state.db"));
}

describe("Supervisor audit trail", () => {
  it("persists supervisor routing decisions during review", async () => {
    const store = makeStore();
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              action: "dispatch",
              agentName: "claude-orchestrator-reviewer",
              taskId: "01ABCDEF",
              message: "Implement issue #123",
              reason: "Routing issue #123 to claude-orchestrator-reviewer",
            },
          ]),
        },
      ],
    });

    const supervisor = new Supervisor(config, store);
    const decisions = await supervisor.review();

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("dispatch");

    const recent = querySupervisorLog(store, {
      limit: 10,
      agentName: "claude-orchestrator-reviewer",
      outcome: "dispatched",
    });

    expect(recent).toHaveLength(1);
    expect(recent[0].action).toBe("dispatch");
    expect(recent[0].outcome).toBe("dispatched");
    expect(recent[0].reason).toContain("Routing issue #123");
  });

  it("runs the calibration drift alert check during review", async () => {
    const store = makeStore();

    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
    });

    const send = vi.fn().mockResolvedValue(undefined);
    const checkAndAlert = vi.fn(async (notify: (text: string) => Promise<void>) => {
      await notify([
        `🚨 *Calibration Approval Mismatch Detected*`,
        ``,
        `2 approved tasks scored below 0.60 in the last 24h.`,
      ].join("\n"));
    });
    const calibrationDriftProvider: CalibrationDriftProvider = {
      buildReport: vi.fn(() => ({
        generated_at: new Date().toISOString(),
        window_days: 30,
        distributions: [],
        drift_alerts: [],
        approval_mismatch_alerts: [],
      })),
      formatDistributionPage: vi.fn(),
      checkAndAlert,
    };
    const notifier = {
      isConfigured: () => true,
      send,
      escalation: vi.fn(),
      taskRejected: vi.fn(),
      notifyOperator: vi.fn().mockResolvedValue(true),
      supervisorDecision: vi.fn(),
      healthRecovery: vi.fn(),
    } as unknown as Notifier;

    const supervisor = new Supervisor(config, store, {
      notifier,
      calibrationDriftProvider,
    });
    await supervisor.review();

    expect(checkAndAlert).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toContain("Calibration Approval Mismatch Detected");
    expect(send.mock.calls[0]?.[0]).toContain("2 approved tasks scored below 0.60 in the last 24h");
  });

  it("filters routing decisions by agent and outcome", () => {
    const store = makeStore();
    store.recordSupervisorDecision("dispatch", "Sent to the reviewer agent", {
      agentName: "claude-orchestrator-reviewer",
      taskId: "01ABCDEF",
      outcome: "dispatched",
      message: "Implement issue #123",
      issueRef: "#123",
    });
    store.recordSupervisorDecision("verify", "Waiting on verification", {
      taskId: "01FEDCBA",
      outcome: "queued",
    });

    const dispatched = querySupervisorLog(store, {
      outcome: "dispatched",
      agentName: "claude-orchestrator-reviewer",
      limit: 10,
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe("dispatch");
    expect(dispatched[0].outcome).toBe("dispatched");

    const queued = store.querySupervisorDecisions({ outcome: "queued" });
    expect(queued).toHaveLength(1);
    expect(queued[0].action).toBe("verify");
  });
});
