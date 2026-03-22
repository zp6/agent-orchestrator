import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PromptLearner } from "./prompt-learner.js";
import { StateStore } from "../state/store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

describe("PromptLearner", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-learner-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("returns empty context when no tasks exist", () => {
    const learner = new PromptLearner(store);
    expect(learner.buildPlannerContext()).toBe("");
    expect(learner.buildRouterContext()).toBe("");
  });

  it("includes agent stats in planner context", () => {
    store.createTask({ title: "A", source: "manual", agent_name: "proxy" });
    const t = store.createTask({ title: "B", source: "manual", agent_name: "proxy" });
    store.updateTask(t.id, { status: "done" });

    const learner = new PromptLearner(store);
    const context = learner.buildPlannerContext();
    expect(context).toContain("proxy");
    expect(context).toContain("Agent Performance");
  });

  it("includes success rates in router context", () => {
    const t1 = store.createTask({ title: "A", source: "manual", agent_name: "agent-a" });
    store.updateTask(t1.id, { status: "done" });
    const t2 = store.createTask({ title: "B", source: "manual", agent_name: "agent-a" });
    store.updateTask(t2.id, { status: "failed" });

    const learner = new PromptLearner(store);
    const context = learner.buildRouterContext();
    expect(context).toContain("agent-a");
    expect(context).toContain("50%"); // 1 done / 2 total
  });

  it("includes quality scores when available", () => {
    const t = store.createTask({ title: "A", source: "manual", agent_name: "agent-a" });
    store.updateTask(t.id, { status: "done", quality_score: 0.85 });

    const learner = new PromptLearner(store);
    const context = learner.buildPlannerContext();
    expect(context).toContain("0.85");
  });
});
