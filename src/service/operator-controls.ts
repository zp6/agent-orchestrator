import type { StateStore } from "../state/store.js";
import { createLogger } from "./logger.js";

const log = createLogger("operator-controls");

/**
 * Applies pending operator control directives (pause/resume/redirect/inject/merge)
 * at the start of each daemon cycle, before other work is dispatched.
 */
export class OperatorControlProcessor {
  constructor(private store: StateStore) {}

  async applyPendingControls(): Promise<number> {
    const pending = this.store.getPendingOperatorControls();
    if (pending.length === 0) return 0;

    let applied = 0;

    for (const control of pending) {
      try {
        const task = this.store.getTask(control.task_id);
        if (!task) {
          this.store.markOperatorControlFailed(control.id, "task not found");
          log.warn("Operator control failed: task not found", { controlId: control.id, taskId: control.task_id });
          continue;
        }

        switch (control.control_type) {
          case "pause":
            this.store.pauseTask(control.task_id);
            this.store.addLog({
              task_id: control.task_id,
              direction: "system",
              content: `Operator paused task via ${control.operator ?? "cli"}.`,
            });
            break;

          case "resume":
            this.store.resumeTask(control.task_id);
            this.store.addLog({
              task_id: control.task_id,
              direction: "system",
              content: `Operator resumed task via ${control.operator ?? "cli"}.`,
            });
            break;

          case "redirect": {
            const newAgent = control.value;
            if (!newAgent) {
              this.store.markOperatorControlFailed(control.id, "redirect requires a target agent name");
              continue;
            }
            this.store.redirectTask(control.task_id, newAgent);
            this.store.addLog({
              task_id: control.task_id,
              direction: "system",
              content: `Operator redirected task to ${newAgent} via ${control.operator ?? "cli"}.`,
            });
            break;
          }

          case "inject": {
            const directive = control.value;
            if (!directive) {
              this.store.markOperatorControlFailed(control.id, "inject requires directive text");
              continue;
            }
            this.store.injectTaskDirective(control.task_id, directive);
            this.store.addLog({
              task_id: control.task_id,
              direction: "system",
              content: `Operator injected directive via ${control.operator ?? "cli"}: ${directive.slice(0, 200)}`,
            });
            break;
          }

          case "merge": {
            const targetTaskId = control.value;
            const mergeNote = targetTaskId
              ? `merged into ${targetTaskId}`
              : "merged (no target specified)";
            this.store.injectTaskDirective(control.task_id, `[Operator merge] This task was ${mergeNote}.`);
            this.store.updateTaskStatus(control.task_id, "superseded");
            this.store.addLog({
              task_id: control.task_id,
              direction: "system",
              content: `Operator merged task: ${mergeNote} via ${control.operator ?? "cli"}.`,
            });
            break;
          }

          default:
            this.store.markOperatorControlFailed(control.id, `unknown control_type: ${(control as { control_type: string }).control_type}`);
            continue;
        }

        this.store.markOperatorControlApplied(control.id);
        applied++;

        log.info("Operator control applied", {
          controlId: control.id,
          controlType: control.control_type,
          taskId: control.task_id,
          operator: control.operator,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.store.markOperatorControlFailed(control.id, reason);
        log.error("Operator control failed with error", {
          controlId: control.id,
          taskId: control.task_id,
          error: reason,
        });
      }
    }

    return applied;
  }
}
