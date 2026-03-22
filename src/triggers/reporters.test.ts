import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Done" }],
      }),
    },
  }),
}));

import { execSync } from "node:child_process";
const mockExecSync = vi.mocked(execSync);

import { reportResult } from "./reporters.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";

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
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reportResult", () => {
  it("reports to GitHub via gh CLI", async () => {
    const task = makeTask({ source: "github", source_ref: "owner/repo#42", result: "Fixed" });
    await reportResult(config, task);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh issue comment 42 --repo owner/repo"),
      expect.any(Object),
    );
  });

  it("reports to Linear via proxy", async () => {
    const task = makeTask({ source: "linear", source_ref: "ENG-123", result: "Done" });
    await reportResult(config, task);
    expect(mockExecSync).not.toHaveBeenCalled(); // Uses proxy, not CLI
  });

  it("reports to Slack via proxy", async () => {
    const task = makeTask({ source: "slack", source_ref: "C123:123.456", result: "Checked" });
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
});
