/**
 * Monthly goals — ambitious targets that give the fleet direction.
 *
 * Goals live in goals.yaml (not code). The supervisor, roadmap proposer,
 * and priority scorer all consult goals to align work toward them.
 * Progress is tracked via key results and reported in Telegram/dashboard.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { StateStore } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("goals");

export interface KeyResult {
  description: string;
  /** Optional: SQL-measurable metric (e.g. "first_pass_rate >= 0.8"). */
  metric?: string;
  /** Manually or automatically marked complete. */
  done?: boolean;
}

export interface Goal {
  id: string;
  title: string;
  /** Concrete measurable target. */
  target: string;
  /** Which pool/agent/system owns progress toward this goal. */
  owner: string;
  key_results: KeyResult[];
}

export interface GoalsConfig {
  month: string;
  goals: Goal[];
}

/**
 * Load goals from goals.yaml. Checks:
 *   1. CWD/goals.yaml
 *   2. orchestrator_dir/goals.yaml
 *   3. ~/.claude-orchestrator/goals.yaml
 * Returns empty goals if file not found (goals are optional).
 */
export function loadGoals(orchestratorDir?: string): GoalsConfig {
  const paths = [
    resolve(process.cwd(), "goals.yaml"),
    orchestratorDir ? resolve(orchestratorDir, "goals.yaml") : null,
    resolve(process.env.HOME ?? "", ".claude-orchestrator", "goals.yaml"),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        const parsed = parseYaml(raw) as GoalsConfig;
        if (parsed?.goals?.length) {
          log.info("Loaded monthly goals", { path: p, month: parsed.month, count: parsed.goals.length });
          return parsed;
        }
      } catch (err) {
        log.warn("Failed to parse goals.yaml", { path: p, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { month: "", goals: [] };
}

/**
 * Measure progress on each goal by checking key results and store metrics.
 */
export function measureGoalProgress(goals: GoalsConfig, store: StateStore): GoalProgress[] {
  return goals.goals.map((goal) => {
    const krProgress = goal.key_results.map((kr) => {
      if (kr.done) return { ...kr, complete: true, value: null };

      // Try to evaluate metric from store if defined
      if (kr.metric) {
        const value = evaluateMetric(kr.metric, store);
        return { ...kr, complete: value !== null && value >= 1.0, value };
      }

      return { ...kr, complete: false, value: null };
    });

    const completedKRs = krProgress.filter((kr) => kr.complete).length;
    const totalKRs = krProgress.length;
    const progressPct = totalKRs > 0 ? Math.round((completedKRs / totalKRs) * 100) : 0;

    return {
      goal,
      keyResults: krProgress,
      completedKRs,
      totalKRs,
      progressPct,
    };
  });
}

export interface GoalProgress {
  goal: Goal;
  keyResults: Array<KeyResult & { complete: boolean; value: number | null }>;
  completedKRs: number;
  totalKRs: number;
  progressPct: number;
}

/**
 * Evaluate a simple metric expression against store data.
 * Supported: "first_pass_rate >= 0.8", "escalation_rate < 0.05",
 * "tasks_completed >= 50", "avg_quality_score >= 0.85"
 */
function evaluateMetric(metric: string, store: StateStore): number | null {
  try {
    const match = metric.match(/^(\w+)\s*(>=|<=|>|<|==)\s*([\d.]+)$/);
    if (!match) return null;

    const [, name, op, thresholdStr] = match;
    const threshold = parseFloat(thresholdStr);
    const stats = store.getAgentStats(168); // 7-day window

    let value: number | null = null;

    switch (name) {
      case "first_pass_rate": {
        const total = stats.reduce((s, a) => s + a.done + a.failed, 0);
        const done = stats.reduce((s, a) => s + a.done, 0);
        value = total > 0 ? done / total : null;
        break;
      }
      case "escalation_rate": {
        const tasks = store.getTasksByStatus("escalated").length;
        const total = stats.reduce((s, a) => s + a.total, 0);
        value = total > 0 ? tasks / total : 0;
        break;
      }
      case "tasks_completed": {
        value = stats.reduce((s, a) => s + a.done, 0);
        break;
      }
      case "avg_quality_score": {
        const scored = stats.filter((a) => a.avg_score !== null);
        value = scored.length > 0
          ? scored.reduce((s, a) => s + (a.avg_score ?? 0), 0) / scored.length
          : null;
        break;
      }
      default:
        return null;
    }

    if (value === null) return null;

    // Return as fraction of target (1.0 = met, >1.0 = exceeded)
    switch (op) {
      case ">=": return value / threshold;
      case ">": return value / threshold;
      case "<=": return value <= threshold ? 1.0 : threshold / value;
      case "<": return value < threshold ? 1.0 : threshold / value;
      case "==": return value === threshold ? 1.0 : 0;
      default: return null;
    }
  } catch {
    return null;
  }
}

/**
 * Format goals for Telegram display.
 */
export function formatGoalsForTelegram(progress: GoalProgress[]): string {
  if (progress.length === 0) return "";

  const lines: string[] = ["*Monthly Goals*"];

  for (const p of progress) {
    const bar = "█".repeat(Math.round(p.progressPct / 10)) +
      "░".repeat(10 - Math.round(p.progressPct / 10));
    const icon = p.progressPct >= 100 ? "✅" : p.progressPct >= 50 ? "🟡" : "🔴";

    lines.push(`  ${icon} ${p.goal.title}`);
    lines.push(`    ${bar} ${p.progressPct}% (${p.completedKRs}/${p.totalKRs} KRs)`);

    for (const kr of p.keyResults) {
      const krIcon = kr.complete ? "✓" : "○";
      lines.push(`    ${krIcon} ${kr.description}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build a goals context string for LLM prompts (supervisor, roadmap proposer).
 */
export function buildGoalsContext(progress: GoalProgress[]): string {
  if (progress.length === 0) return "";

  const lines: string[] = ["## Monthly Goals"];

  for (const p of progress) {
    lines.push(`\n### ${p.goal.title} (${p.progressPct}% complete)`);
    lines.push(`Target: ${p.goal.target}`);
    lines.push(`Owner: ${p.goal.owner}`);
    lines.push("Key results:");
    for (const kr of p.keyResults) {
      lines.push(`- [${kr.complete ? "x" : " "}] ${kr.description}`);
    }
  }

  return lines.join("\n");
}
