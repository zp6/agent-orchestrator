import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Verifier } from "./verifier.js";
import { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

const mockCreate = vi.fn();

vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: { create: mockCreate },
  }),
}));

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {},
};

describe("Verifier", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dbPath = join(tmpdir(), `orch-verify-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("approves high-quality work", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: true, score: 0.9, notes: "Excellent work" }) }],
    });

    const task = store.createTask({ title: "Test", description: "Do something", source: "manual", agent_name: "test" });
    store.updateTask(task.id, { status: "done", result: "I did the thing" });

    const verifier = new Verifier(config, store);
    const result = await verifier.verify(task.id);

    expect(result.approved).toBe(true);
    expect(result.score).toBe(0.9);

    const updated = store.getTask(task.id);
    expect(updated?.verification_status).toBe("approved");
    expect(updated?.quality_score).toBe(0.9);
  });

  it("rejects low-quality work with revision suggestion", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: false, score: 0.3, notes: "Incomplete", revision: "Add error handling" }) }],
    });

    const task = store.createTask({ title: "Test", description: "Do something", source: "manual", agent_name: "test" });
    store.updateTask(task.id, { status: "done", result: "Partial result" });

    const verifier = new Verifier(config, store);
    const result = await verifier.verify(task.id);

    expect(result.approved).toBe(false);
    expect(result.revision).toBe("Add error handling");

    const updated = store.getTask(task.id);
    expect(updated?.verification_status).toBe("rejected");
  });

  it("handles malformed verification response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json" }],
    });

    const task = store.createTask({ title: "Test", description: "Do something", source: "manual", agent_name: "test" });
    store.updateTask(task.id, { status: "done", result: "Result" });

    const verifier = new Verifier(config, store);
    const result = await verifier.verify(task.id);

    expect(result.approved).toBe(false);
    expect(result.score).toBe(0);
  });

  it("throws for non-existent task", async () => {
    const verifier = new Verifier(config, store);
    await expect(verifier.verify("nonexistent")).rejects.toThrow("Task not found");
  });

  it("throws for non-done task", async () => {
    const task = store.createTask({ title: "Test", source: "manual" });

    const verifier = new Verifier(config, store);
    await expect(verifier.verify(task.id)).rejects.toThrow("not done");
  });
});
