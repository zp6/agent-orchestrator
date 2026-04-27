import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../state/store.js";
import {
  canonicalizeAgentVariantName,
  getAgentVariantFamily,
} from "../state/agent-variant.js";

function makeTmpStore(): StateStore {
  const tmpFile = path.join(os.tmpdir(), `test-agent-variant-${Date.now()}-${Math.random()}.db`);
  return new StateStore(tmpFile);
}

function insertTask(store: StateStore, task: {
  id: string;
  title: string;
  status: string;
  agent_name: string;
}): void {
  const db = (store as unknown as { db: Database.Database }).db;
  db.prepare(
    `INSERT INTO tasks (id, title, status, agent_name, task_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'implementation', datetime('now'), datetime('now'))`,
  ).run(task.id, task.title, task.status, task.agent_name);
}

describe("agent variant helpers", () => {
  it("canonicalizes known provider-prefixed agent names", () => {
    expect(canonicalizeAgentVariantName("claude-orchestrator-reviewer")).toBe("orchestrator-reviewer");
    expect(canonicalizeAgentVariantName("codex-proxy")).toBe("proxy");
    expect(canonicalizeAgentVariantName("grok-orchestrator-reviewer")).toBe("orchestrator-reviewer");
    expect(canonicalizeAgentVariantName("deepseek-orchestrator-reviewer")).toBe("orchestrator-reviewer");
    expect(canonicalizeAgentVariantName("gemini-orchestrator-reviewer")).toBe("orchestrator-reviewer");
  });

  it("leaves non-variant names unchanged", () => {
    expect(canonicalizeAgentVariantName("meeting-facilitator-agent")).toBe("meeting-facilitator-agent");
  });

  it("returns the full sibling family for variant-prefixed agents", () => {
    expect(getAgentVariantFamily("claude-orchestrator-reviewer")).toEqual([
      "claude-orchestrator-reviewer",
      "codex-orchestrator-reviewer",
      "grok-orchestrator-reviewer",
      "deepseek-orchestrator-reviewer",
      "gemini-orchestrator-reviewer",
    ]);
  });

  it("returns only the original name for non-variant agents", () => {
    expect(getAgentVariantFamily("meeting-facilitator-agent")).toEqual(["meeting-facilitator-agent"]);
  });
});

describe("StateStore.hasActiveTask", () => {
  let store: StateStore;

  beforeEach(() => {
    store = makeTmpStore();
  });

  it("treats sibling variants as the same inflight family", () => {
    insertTask(store, {
      id: "task-1",
      title: "Review PR",
      status: "dispatched",
      agent_name: "claude-orchestrator-reviewer",
    });

    expect(store.hasActiveTask("codex-orchestrator-reviewer")).toBe(true);
    expect(store.hasActiveTask("grok-orchestrator-reviewer")).toBe(true);
  });

  it("does not match unrelated agents", () => {
    insertTask(store, {
      id: "task-2",
      title: "Review PR",
      status: "dispatched",
      agent_name: "claude-orchestrator-reviewer",
    });

    expect(store.hasActiveTask("meeting-facilitator-agent")).toBe(false);
    expect(store.hasActiveTask("claude-orchestrator-dashboard")).toBe(false);
  });

  it("ignores non-dispatched sibling tasks", () => {
    insertTask(store, {
      id: "task-3",
      title: "Review PR",
      status: "in_progress",
      agent_name: "claude-orchestrator-reviewer",
    });

    expect(store.hasActiveTask("codex-orchestrator-reviewer")).toBe(false);
  });
});
