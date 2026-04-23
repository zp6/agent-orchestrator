/**
 * DAG-Based Parallel Subtask Execution Runtime (issue #1085).
 *
 * Decomposes complex multi-agent tasks into a persistent dependency graph,
 * dispatches independent leaf nodes in parallel, and gates downstream nodes
 * on upstream completions — all without blocking the daemon poll cycle.
 *
 * Architecture:
 * - `dag_executions` table: one record per complex task, tracks overall status.
 * - `dag_nodes` table: one record per plan step, tracks per-node dispatch state.
 * - `advanceAll()`: called each daemon cycle; checks completions and dispatches
 *   newly-unblocked nodes (fire-and-forget so the daemon cycle is never blocked).
 * - `planAndInitialize()`: calls the LLM Planner, then persists the DAG and
 *   dispatches leaf nodes immediately.
 *
 * Node lifecycle:
 *   pending → dispatching → dispatched → done
 *                                      ↘ failed
 */

import type { Dispatcher } from "./dispatcher.js";
import type { StateStore, DagExecution, DagNode } from "../state/store.js";
import { Planner, type Plan } from "./planner.js";
import { generateId } from "../utils/ulid.js";
import { createLogger } from "../service/logger.js";

const MAX_PARALLEL_DISPATCHES = 4; // mirrors the Planner's own constraint

export class DagRuntime {
  private log = createLogger("dag-runtime");

  constructor(
    private store: StateStore,
    private dispatcher: Dispatcher,
    private planner: Planner,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Use the LLM Planner to decompose `taskDescription` into a DAG.
   * If the planner decides the task is single-agent, returns null (caller should
   * dispatch directly).  Otherwise persists the DAG and dispatches leaf nodes.
   *
   * @returns dag_id if a multi-agent DAG was created, null otherwise.
   */
  async planAndInitialize(parentTaskId: string, taskDescription: string): Promise<string | null> {
    let plan: Plan;
    try {
      plan = await this.planner.plan(taskDescription);
    } catch (err) {
      this.log.warn("Planner failed; skipping DAG creation", {
        parentTaskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (!plan.is_multi_agent || plan.steps.length <= 1) {
      this.log.info("Task does not require multi-agent DAG", { parentTaskId, steps: plan.steps.length });
      return null;
    }

    return this.initializeFromPlan(parentTaskId, plan);
  }

  /**
   * Persist a DAG execution from an already-built Plan and dispatch leaf nodes.
   * Called by `planAndInitialize` or directly by operators/supervisor when they
   * have a pre-built plan.
   *
   * @returns the dag_id of the newly-created execution.
   */
  async initializeFromPlan(parentTaskId: string, plan: Plan): Promise<string> {
    const dagId = generateId();

    this.store.createDagExecution({
      id: dagId,
      parent_task_id: parentTaskId,
      plan_json: JSON.stringify(plan),
      status: "running",
    });

    for (const step of plan.steps) {
      this.store.createDagNode({
        id: generateId(),
        dag_id: dagId,
        step_id: step.id,
        task_id: null,
        agent_name: step.agent,
        instruction: step.task,
        depends_on_json: JSON.stringify(step.depends_on),
        status: "pending",
        result: null,
      });
    }

    this.log.info("DAG execution initialized", {
      dagId,
      parentTaskId,
      steps: plan.steps.length,
    });

    // Mark parent task as "planning" so the normal dispatcher skips it
    this.store.updateTask(parentTaskId, { status: "planning" });

    // Immediately dispatch leaf nodes (no-dependency nodes)
    await this.advanceDag(dagId);

    return dagId;
  }

  /**
   * Advance all running DAG executions.
   *
   * Called once per daemon poll cycle (Batch 2, alongside dispatchTriggers).
   * Each individual advance is catch-wrapped so one broken DAG doesn't halt others.
   */
  async advanceAll(): Promise<void> {
    let dags: DagExecution[];
    try {
      dags = this.store.getPendingDagExecutions();
    } catch {
      // Table may not exist on older deployments — fail silently.
      return;
    }

    if (dags.length === 0) return;

    this.log.debug(`Advancing ${dags.length} running DAG execution(s)`);

    for (const dag of dags) {
      try {
        await this.advanceDag(dag.id);
      } catch (err) {
        this.log.error("Error advancing DAG", {
          dagId: dag.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Internal execution logic ───────────────────────────────────────────────

  /**
   * Advance a single DAG through one cycle:
   * 1. Sync node statuses from their backing tasks.
   * 2. Fail-fast if any node failed.
   * 3. Dispatch newly-unblocked nodes (fire-and-forget).
   * 4. Aggregate & complete if all nodes are done.
   */
  async advanceDag(dagId: string): Promise<void> {
    const dag = this.store.getDagExecution(dagId);
    if (!dag || dag.status !== "running") return;

    const nodes = this.store.getDagNodes(dagId);

    // ── Phase 1: sync node statuses from their backing tasks ─────────────────
    const completedStepIds = new Set<string>();
    let anyFailed = false;
    let failedStepId: string | undefined;

    for (const node of nodes) {
      if (node.status === "done") {
        completedStepIds.add(node.step_id);
        continue;
      }
      if (node.status === "failed") {
        anyFailed = true;
        failedStepId ??= node.step_id;
        continue;
      }
      if (node.status === "dispatched" && node.task_id) {
        const task = this.store.getTask(node.task_id);
        if (!task) continue;

        if (task.status === "done") {
          this.store.updateDagNode(node.id, {
            status: "done",
            result: task.result ?? null,
          });
          completedStepIds.add(node.step_id);
          this.log.info("DAG node completed", {
            dagId, stepId: node.step_id, taskId: node.task_id,
          });
        } else if (task.status === "failed" || task.status === "escalated") {
          this.store.updateDagNode(node.id, { status: "failed" });
          anyFailed = true;
          failedStepId ??= node.step_id;
          this.log.warn("DAG node task failed", {
            dagId, stepId: node.step_id, taskId: node.task_id, taskStatus: task.status,
          });
        }
      }
    }

    // ── Phase 2: fail-fast on node failure ───────────────────────────────────
    if (anyFailed) {
      this.store.updateDagExecution(dagId, { status: "failed" });
      this.store.updateTask(dag.parent_task_id, {
        status: "failed",
        result: `DAG execution failed at step: ${failedStepId}`,
      });
      this.log.warn("DAG execution marked failed", { dagId, failedStepId });
      return;
    }

    // ── Phase 3: dispatch newly-unblocked nodes ───────────────────────────────
    // Refresh nodes so completedStepIds is up to date after phase-1 updates.
    const freshNodes = this.store.getDagNodes(dagId);
    const freshCompleted = new Set(
      freshNodes.filter((n) => n.status === "done").map((n) => n.step_id),
    );

    const readyNodes = freshNodes.filter((node) => {
      if (node.status !== "pending") return false;
      const deps: string[] = JSON.parse(node.depends_on_json);
      return deps.every((depId) => freshCompleted.has(depId));
    });

    const toDispatch = readyNodes.slice(0, MAX_PARALLEL_DISPATCHES);

    if (toDispatch.length > 0) {
      this.log.info("DAG: dispatching unblocked nodes", {
        dagId,
        count: toDispatch.length,
        stepIds: toDispatch.map((n) => n.step_id),
        totalNodes: freshNodes.length,
        doneNodes: freshCompleted.size,
      });

      for (const node of toDispatch) {
        const message = this.buildNodeMessage(node, freshNodes);

        // Mark "dispatching" synchronously — prevents re-dispatch on the next
        // cycle if the Promise hasn't resolved yet.
        this.store.updateDagNode(node.id, { status: "dispatching" });

        // Fire-and-forget: don't block the daemon cycle on agent I/O.
        void this.dispatcher.dispatch(message, {
          agentName: node.agent_name ?? undefined,
          parentTaskId: dag.parent_task_id,
          stepId: node.step_id,
          source: "manual",
          title: `[DAG ${dagId.slice(0, 8)}/${node.step_id}] ${node.instruction.slice(0, 60)}`,
        }).then((result) => {
          this.store.updateDagNode(node.id, {
            status: "dispatched",
            task_id: result.taskId,
            agent_name: result.agentName,
          });
          this.log.info("DAG node dispatched", {
            dagId, stepId: node.step_id, taskId: result.taskId, agentName: result.agentName,
          });
        }).catch((err) => {
          this.log.error("DAG node dispatch failed", {
            dagId, stepId: node.step_id,
            error: err instanceof Error ? err.message : String(err),
          });
          this.store.updateDagNode(node.id, { status: "failed" });
        });
      }
      return; // Let the cycle run; check results next cycle.
    }

    // ── Phase 4: check for completion ─────────────────────────────────────────
    const allDone = freshNodes.every((n) => n.status === "done");
    const anyInFlight = freshNodes.some((n) =>
      n.status === "pending" || n.status === "dispatching" || n.status === "dispatched",
    );

    if (allDone) {
      const aggregated = freshNodes
        .map((n) => `## ${n.step_id} (${n.agent_name ?? "unknown"}):\n${n.result ?? "(no result)"}`)
        .join("\n\n---\n\n");

      this.store.updateDagExecution(dagId, { status: "done" });
      this.store.updateTask(dag.parent_task_id, {
        status: "done",
        result: aggregated,
      });
      this.log.info("DAG execution completed", { dagId, nodeCount: freshNodes.length });
    } else if (!anyInFlight) {
      // All nodes settled but we have failures (handled above). Shouldn't happen,
      // but log for debuggability.
      this.log.warn("DAG in unexpected settled state (no in-flight, not all done)", {
        dagId,
        statuses: freshNodes.map((n) => ({ stepId: n.step_id, status: n.status })),
      });
    }
    // Otherwise: nodes are still in flight — wait for the next cycle.
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Build the dispatch message for a node, injecting context from completed
   * dependency nodes so downstream agents have the full picture.
   *
   * Mirrors the pattern from `PlanExecutor.buildStepMessage()`.
   */
  private buildNodeMessage(node: DagNode, allNodes: DagNode[]): string {
    const deps: string[] = JSON.parse(node.depends_on_json);
    if (deps.length === 0) return node.instruction;

    const contextParts = deps
      .map((depStepId) => {
        const depNode = allNodes.find((n) => n.step_id === depStepId);
        if (!depNode?.result) return null;
        return `## Context from ${depStepId} (${depNode.agent_name ?? "unknown"}):\n${depNode.result}`;
      })
      .filter((p): p is string => p !== null);

    if (contextParts.length === 0) return node.instruction;

    return `${contextParts.join("\n\n")}\n\n---\n\nYour task: ${node.instruction}`;
  }
}
