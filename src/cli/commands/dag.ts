/**
 * CLI commands for DAG-based parallel subtask execution (issue #1085).
 *
 * Commands:
 *   orch dag list            — list recent DAG executions with progress
 *   orch dag show <id>       — show detailed node status for a DAG execution
 *   orch dag nodes <dag-id>  — list all nodes for a specific DAG with instructions
 */

import type { Command } from "commander";
import { StateStore } from "../../state/store.js";

export function registerDagCommand(program: Command): void {
  const dag = program
    .command("dag")
    .description("DAG parallel subtask execution management");

  // ── dag list ──────────────────────────────────────────────────────────────
  dag
    .command("list")
    .description("List recent DAG executions with progress summary")
    .option("-n, --limit <n>", "Max rows to show", "20")
    .option("--json", "Machine-readable JSON output")
    .action((opts) => {
      const store = new StateStore();
      let rows: ReturnType<typeof store.listDagExecutions>;
      try {
        rows = store.listDagExecutions(Number(opts.limit));
      } catch {
        console.error("DAG tables not found — no DAG executions recorded yet.");
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log("No DAG executions found.");
        return;
      }

      console.log(`\n${"ID".padEnd(12)} ${"STATUS".padEnd(10)} ${"PROGRESS".padEnd(12)} ${"PARENT TASK".padEnd(28)} CREATED`);
      console.log("─".repeat(90));

      for (const row of rows) {
        const progress = row.node_count > 0 ? `${row.done_count}/${row.node_count}` : "0/0";
        const statusIcon = row.status === "done" ? "✓" : row.status === "failed" ? "✗" : "⟳";
        console.log(
          `${(statusIcon + " " + row.id.slice(0, 8)).padEnd(12)} ` +
          `${row.status.padEnd(10)} ` +
          `${progress.padEnd(12)} ` +
          `${row.parent_task_id.slice(0, 26).padEnd(28)} ` +
          `${row.created_at.slice(0, 19)}`,
        );
      }
      console.log(`\n${rows.length} DAG execution(s) shown.`);
    });

  // ── dag show <id> ─────────────────────────────────────────────────────────
  dag
    .command("show <id>")
    .description("Show detailed node status for a DAG execution (prefix matching supported)")
    .option("--json", "Machine-readable JSON output")
    .action((id: string, opts) => {
      const store = new StateStore();
      try {
        const all = store.listDagExecutions(100);
        const match = all.find((e) => e.id === id || e.id.startsWith(id));
        if (!match) {
          console.error(`DAG execution not found: ${id}`);
          process.exit(1);
        }
        const exec = store.getDagExecution(match.id)!;
        const nodes = store.getDagNodes(match.id);

        if (opts.json) {
          console.log(JSON.stringify({ execution: exec, nodes }, null, 2));
          return;
        }

        console.log(`\nDAG Execution: ${exec.id}`);
        console.log(`  Status:      ${exec.status}`);
        console.log(`  Parent task: ${exec.parent_task_id}`);
        console.log(`  Created:     ${exec.created_at}`);
        console.log(`  Updated:     ${exec.updated_at}`);
        console.log(`\nNodes (${nodes.length}):`);
        console.log(`${"STEP".padEnd(22)} ${"STATUS".padEnd(12)} ${"AGENT".padEnd(28)} TASK ID`);
        console.log("─".repeat(90));

        for (const node of nodes) {
          const deps: string[] = JSON.parse(node.depends_on_json);
          const depStr = deps.length > 0 ? ` → [${deps.join(", ")}]` : "";
          const icon = node.status === "done" ? "✓" : node.status === "failed" ? "✗" : node.status === "dispatched" ? "⟳" : "·";
          console.log(
            `${(icon + " " + node.step_id).slice(0, 21).padEnd(22)} ` +
            `${node.status.padEnd(12)} ` +
            `${(node.agent_name ?? "—").slice(0, 26).padEnd(28)} ` +
            `${node.task_id?.slice(0, 12) ?? "—"}${depStr}`,
          );
        }
      } catch {
        console.error("DAG tables not found — no DAG executions recorded yet.");
      }
    });

  // ── dag nodes <dag-id> ────────────────────────────────────────────────────
  dag
    .command("nodes <dagId>")
    .description("List all nodes for a DAG execution with full instructions and results")
    .option("--json", "Machine-readable JSON output")
    .action((dagId: string, opts) => {
      const store = new StateStore();
      try {
        const all = store.listDagExecutions(100);
        const match = all.find((e) => e.id === dagId || e.id.startsWith(dagId));
        if (!match) {
          console.error(`DAG execution not found: ${dagId}`);
          process.exit(1);
        }
        const nodes = store.getDagNodes(match.id);

        if (opts.json) {
          console.log(JSON.stringify(nodes, null, 2));
          return;
        }

        for (const node of nodes) {
          const deps: string[] = JSON.parse(node.depends_on_json);
          console.log(`\n── Step: ${node.step_id} [${node.status}] ──`);
          console.log(`   Agent:       ${node.agent_name ?? "—"}`);
          console.log(`   Task ID:     ${node.task_id ?? "—"}`);
          console.log(`   Depends on:  ${deps.length > 0 ? deps.join(", ") : "(none)"}`);
          console.log(`   Instruction: ${node.instruction.slice(0, 120)}${node.instruction.length > 120 ? "…" : ""}`);
          if (node.result) {
            const preview = node.result.slice(0, 200);
            console.log(`   Result:      ${preview}${node.result.length > 200 ? "…" : ""}`);
          }
        }
      } catch {
        console.error("DAG tables not found — no DAG executions recorded yet.");
      }
    });
}
