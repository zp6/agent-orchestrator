import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlanExecutor } from "./executor.js";
import type { Plan } from "./planner.js";
import type { Dispatcher } from "./dispatcher.js";
import { StateStore } from "../state/store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function mockResponse(content: string) {
  return {
    content,
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 100, output_tokens: 50 },
    stop_reason: "end_turn",
  };
}

describe("PlanExecutor", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-exec-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("executes a linear pipeline", async () => {
    const plan: Plan = {
      id: "plan-1",
      original_task: "test",
      is_multi_agent: true,
      steps: [
        { id: "step-1", agent: "agent-a", task: "Do A", depends_on: [] },
        { id: "step-2", agent: "agent-b", task: "Do B with A's output", depends_on: ["step-1"] },
      ],
    };

    const parentTask = store.createTask({ title: "Parent", source: "manual" });

    const dispatched: string[] = [];
    const mockDispatcher = {
      dispatch: vi.fn().mockImplementation(async (message: string, opts: any) => {
        dispatched.push(opts.agentName);
        return {
          taskId: `task-${opts.agentName}`,
          agentName: opts.agentName,
          response: mockResponse(`Result from ${opts.agentName}`),
        };
      }),
    } as unknown as Dispatcher;

    const executor = new PlanExecutor(mockDispatcher, store);
    const result = await executor.execute(plan, parentTask.id);

    expect(result.status).toBe("done");
    expect(result.stepResults).toHaveLength(2);
    expect(dispatched).toEqual(["agent-a", "agent-b"]);

    // Step 2 should have received context from step 1
    const step2Call = mockDispatcher.dispatch.mock.calls[1];
    expect(step2Call[0]).toContain("Context from step-1");
    expect(step2Call[0]).toContain("Result from agent-a");
  });

  it("executes parallel fan-out", async () => {
    const plan: Plan = {
      id: "plan-2",
      original_task: "test",
      is_multi_agent: true,
      steps: [
        { id: "step-1", agent: "agent-a", task: "Do A", depends_on: [] },
        { id: "step-2", agent: "agent-b", task: "Do B", depends_on: [] },
        { id: "step-3", agent: "agent-c", task: "Combine", depends_on: ["step-1", "step-2"] },
      ],
    };

    const parentTask = store.createTask({ title: "Parent", source: "manual" });

    const mockDispatcher = {
      dispatch: vi.fn().mockImplementation(async (_msg: string, opts: any) => ({
        taskId: `task-${opts.agentName}`,
        agentName: opts.agentName,
        response: mockResponse(`Result from ${opts.agentName}`),
      })),
    } as unknown as Dispatcher;

    const executor = new PlanExecutor(mockDispatcher, store);
    const result = await executor.execute(plan, parentTask.id);

    expect(result.status).toBe("done");
    expect(result.stepResults).toHaveLength(3);

    // Step 3 should have context from both step 1 and 2
    const step3Call = mockDispatcher.dispatch.mock.calls[2];
    expect(step3Call[0]).toContain("Context from step-1");
    expect(step3Call[0]).toContain("Context from step-2");
  });

  it("fails fast on step failure", async () => {
    const plan: Plan = {
      id: "plan-3",
      original_task: "test",
      is_multi_agent: true,
      steps: [
        { id: "step-1", agent: "agent-a", task: "Do A", depends_on: [] },
        { id: "step-2", agent: "agent-b", task: "Do B", depends_on: ["step-1"] },
      ],
    };

    const parentTask = store.createTask({ title: "Parent", source: "manual" });

    const mockDispatcher = {
      dispatch: vi.fn().mockRejectedValue(new Error("Agent unreachable")),
    } as unknown as Dispatcher;

    const executor = new PlanExecutor(mockDispatcher, store);
    const result = await executor.execute(plan, parentTask.id);

    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("step-1");

    // Parent task should be marked failed
    const updatedParent = store.getTask(parentTask.id);
    expect(updatedParent?.status).toBe("failed");
  });

  it("creates sub-tasks linked to parent", async () => {
    const plan: Plan = {
      id: "plan-4",
      original_task: "test",
      is_multi_agent: true,
      parallel: [
        { id: "step-1", agent: "agent-a", task: "Do A", depends_on: [] },
      ],
      sequential: [],
      steps: [
        { id: "step-1", agent: "agent-a", task: "Do A", depends_on: [] },
      ],
    };

    const parentTask = store.createTask({ title: "Parent", source: "manual" });

    const mockDispatcher = {
      dispatch: vi.fn().mockImplementation(async (_msg: string, opts: any) => {
        const child = store.createTask({
          title: opts.title,
          description: _msg,
          source: "manual",
          agent_name: opts.agentName,
          parent_task_id: opts.parentTaskId,
          step_id: opts.stepId,
        });
        return {
          taskId: child.id,
          agentName: opts.agentName,
          response: mockResponse("Done"),
        };
      }),
    } as unknown as Dispatcher;

    const executor = new PlanExecutor(mockDispatcher, store);
    await executor.execute(plan, parentTask.id);

    const subTasks = store.getSubTasks(parentTask.id);
    expect(subTasks).toHaveLength(1);
    expect(subTasks[0].step_id).toBe("step-1");
    expect(subTasks[0].agent_name).toBe("agent-a");
    expect(subTasks[0].parent_task_id).toBe(parentTask.id);
    expect(mockDispatcher.dispatch.mock.calls[0][1]).toMatchObject({
      parentTaskId: parentTask.id,
      stepId: "step-1",
    });
  });

  it("passes no context to steps without dependencies", async () => {
    const plan: Plan = {
      id: "plan-5",
      original_task: "test",
      is_multi_agent: false,
      steps: [
        { id: "step-1", agent: "agent-a", task: "Do A standalone", depends_on: [] },
      ],
    };

    const parentTask = store.createTask({ title: "Parent", source: "manual" });

    const mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({
        taskId: "sub-1",
        agentName: "agent-a",
        response: mockResponse("Done"),
      }),
    } as unknown as Dispatcher;

    const executor = new PlanExecutor(mockDispatcher, store);
    await executor.execute(plan, parentTask.id);

    // The message should just be the task, no context prefix
    expect(mockDispatcher.dispatch.mock.calls[0][0]).toBe("Do A standalone");
  });
});
