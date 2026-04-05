import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
const mockExecSync = vi.mocked(execSync);

import { reportResult } from "./reporters.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, Task } from "../state/store.js";

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {},
};

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "test-id", title: "Test", description: null, source: "manual",
    source_ref: null, status: "done", agent_name: "test", conversation_id: null,
    result: "Task completed", parent_task_id: null, step_id: null, plan: null,
    task_type: "github_issue", verification_status: null, quality_score: null,
    verification_notes: null, retry_count: 0, next_retry_at: null, reported: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeStore(overrides?: Partial<StateStore>): StateStore {
  return {
    markReported: vi.fn(),
    ...overrides,
  } as unknown as StateStore;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reportResult", () => {
  it("reports to GitHub via gh CLI", async () => {
    mockExecSync.mockReturnValue("" as ReturnType<typeof execSync>);
    const task = makeTask({ source: "github", source_ref: "owner/repo#42", result: "Fixed" });
    await reportResult(config, task);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh issue comment 42 --repo owner/repo"),
      expect.any(Object),
    );
  });

  it("does not report for linear source (agent handles it)", async () => {
    const task = makeTask({ source: "linear", source_ref: "ENG-123", result: "Done" });
    await reportResult(config, task);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("does not report for slack source (agent handles it)", async () => {
    const task = makeTask({ source: "slack", source_ref: "check:123", result: "Checked" });
    await reportResult(config, task);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("skips when no source_ref", async () => {
    const task = makeTask({ source: "manual", source_ref: null });
    await reportResult(config, task);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("skips when no result", async () => {
    const task = makeTask({ source: "github", source_ref: "owner/repo#1", result: null });
    await reportResult(config, task);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  describe("DB-level dedup via reported flag", () => {
    it("skips posting when task.reported is 1", async () => {
      const task = makeTask({ source: "github", source_ref: "owner/repo#42", result: "Done", reported: 1 });
      await reportResult(config, task);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("calls markReported after successful post", async () => {
      mockExecSync.mockReturnValue("" as ReturnType<typeof execSync>);
      const store = makeStore();
      const task = makeTask({ source: "github", source_ref: "owner/repo#42", result: "Done", reported: 0 });
      await reportResult(config, task, store);
      expect(store.markReported).toHaveBeenCalledWith("test-id");
    });

    it("does not call markReported when comment already exists", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("gh api")) {
          return "**[test] Orchestrator Result:**\n\nPrevious result" as ReturnType<typeof execSync>;
        }
        return "" as ReturnType<typeof execSync>;
      });
      const store = makeStore();
      const task = makeTask({ source: "github", source_ref: "owner/repo#42", result: "Done", agent_name: "test" });
      await reportResult(config, task, store);
      expect(store.markReported).not.toHaveBeenCalled();
    });
  });

  describe("comment dedup", () => {
    it("skips posting when result comment already exists", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("gh api")) {
          return "**[test-agent] Orchestrator Result:**\n\nPrevious result" as ReturnType<typeof execSync>;
        }
        return "" as ReturnType<typeof execSync>;
      });
      const task = makeTask({ source: "github", source_ref: "owner/repo#42", result: "New result", agent_name: "test-agent" });
      await reportResult(config, task);
      // Only the dedup check call, no comment posting
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("gh api"),
        expect.any(Object),
      );
    });

    it("posts comment when no existing result comment", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("gh api")) return "Some other comment" as ReturnType<typeof execSync>;
        return "" as ReturnType<typeof execSync>;
      });
      const task = makeTask({ source: "github", source_ref: "owner/repo#42", result: "Done", agent_name: "test-agent" });
      await reportResult(config, task);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
      expect(mockExecSync).toHaveBeenLastCalledWith(
        expect.stringContaining("gh issue comment"),
        expect.any(Object),
      );
    });

    it("fails closed when dedup check errors (skips post to prevent duplicates)", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("gh api")) throw new Error("API error");
        return "" as ReturnType<typeof execSync>;
      });
      const task = makeTask({ source: "github", source_ref: "owner/repo#42", result: "Done" });
      await reportResult(config, task);
      // Only the failed API check, no comment posting (fail-closed)
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      expect(mockExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining("gh issue comment"),
        expect.any(Object),
      );
    });
  });
});
