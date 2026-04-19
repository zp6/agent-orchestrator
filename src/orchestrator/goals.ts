/**
 * Monthly goals — ambitious targets that give the fleet direction.
 *
 * Goals live in goals.yaml (not code). The supervisor, roadmap proposer,
 * and priority scorer all consult goals to align work toward them.
 * Progress is tracked via key results and reported in Telegram/dashboard.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLLMClient, getLLMModel } from "../client/llm-client.js";
import { extractJSON } from "../utils/json-extract.js";
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

// ── Auto-update: mark completed KRs ─────────────────────────────────────────

/**
 * Scan key results with metrics and mark them `done: true` in goals.yaml
 * when the metric is met. Returns the number of KRs newly marked done.
 */
export function autoMarkCompletedKeyResults(
  store: StateStore,
  orchestratorDir?: string,
): number {
  const goalsPath = findGoalsPath(orchestratorDir);
  if (!goalsPath) return 0;

  const raw = readFileSync(goalsPath, "utf-8");
  const goals = parseYaml(raw) as GoalsConfig;
  if (!goals?.goals?.length) return 0;

  let marked = 0;
  for (const goal of goals.goals) {
    for (const kr of goal.key_results) {
      if (kr.done) continue;
      if (!kr.metric) continue;

      const value = evaluateMetric(kr.metric, store);
      if (value !== null && value >= 1.0) {
        kr.done = true;
        marked++;
        log.info("Auto-marked key result as done", {
          goal: goal.id,
          kr: kr.description,
          metric: kr.metric,
          value,
        });
      }
    }
  }

  if (marked > 0) {
    writeFileSync(goalsPath, stringifyYaml(goals, { lineWidth: 120 }));
    log.info("Updated goals.yaml with completed key results", { marked, path: goalsPath });
  }

  return marked;
}

// ── Goal refresh: propose new goals when current ones are stale ──────────────

/** Threshold: when this % of KRs are done, propose a refresh. */
const REFRESH_THRESHOLD_PCT = 75;
const GOAL_REFRESH_LLM_TIMEOUT_MS = 120_000;

/**
 * Check if goals need refreshing (most KRs done or month has passed).
 * If so, generate new goals via LLM and write them as a PR branch.
 * Returns true if a refresh was proposed.
 */
export async function maybeRefreshGoals(
  config: OrchestratorConfig,
  store: StateStore,
): Promise<boolean> {
  const goalsPath = findGoalsPath(config.orchestrator_dir);
  if (!goalsPath) return false;

  const goals = loadGoals(config.orchestrator_dir);
  if (!goals.goals.length) return false;

  const progress = measureGoalProgress(goals, store);
  const totalKRs = progress.reduce((s, p) => s + p.totalKRs, 0);
  const doneKRs = progress.reduce((s, p) => s + p.completedKRs, 0);
  const pctDone = totalKRs > 0 ? Math.round((doneKRs / totalKRs) * 100) : 0;

  // Check if month has rolled over
  const currentMonth = new Date().toISOString().slice(0, 7); // "2026-04"
  const goalsMonth = goals.month;
  const monthPassed = goalsMonth && goalsMonth < currentMonth;

  if (pctDone < REFRESH_THRESHOLD_PCT && !monthPassed) {
    log.debug("Goals not ready for refresh", { pctDone, threshold: REFRESH_THRESHOLD_PCT, goalsMonth, currentMonth });
    return false;
  }

  log.info("Goals ready for refresh", { pctDone, monthPassed, goalsMonth, currentMonth });

  try {
    const newGoals = await generateRefreshedGoals(config, store, goals, progress);
    if (!newGoals || !newGoals.goals?.length) return false;

    // Write to goals.yaml directly — the config watcher or next cycle will pick it up
    writeFileSync(goalsPath, stringifyYaml(newGoals, { lineWidth: 120 }));
    log.info("Refreshed goals.yaml", {
      oldMonth: goalsMonth,
      newMonth: newGoals.month,
      goalCount: newGoals.goals.length,
    });
    return true;
  } catch (err) {
    log.warn("Goal refresh failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

const GOAL_REFRESH_SYSTEM_PROMPT = `You are a strategic planner for an autonomous AI agent fleet. You will be given the current monthly goals, their progress, and recent system performance data.

Your job: propose the NEXT month's goals. Rules:
- Keep 3-5 goals (focused > scattered)
- Carry forward incomplete goals that are still relevant (with updated KRs if needed)
- Replace completed or irrelevant goals with new ambitious targets
- Each goal needs 2-4 concrete, measurable key results
- KRs should have a "metric" field when possible (e.g. "first_pass_rate >= 0.85")
- Be ambitious but grounded in what the system can realistically achieve
- Owner should be "orchestrator", "system", "reviewer", or a specific agent pool

Respond with ONLY valid YAML (no code fences):

month: "YYYY-MM"

goals:
  - id: "short-id"
    title: "Goal title"
    target: "Measurable target"
    owner: orchestrator
    key_results:
      - description: "KR description"
        metric: "metric_name >= 0.8"
      - description: "Another KR"`;

async function generateRefreshedGoals(
  config: OrchestratorConfig,
  store: StateStore,
  currentGoals: GoalsConfig,
  progress: GoalProgress[],
): Promise<GoalsConfig | null> {
  const { client, model } = createLLMClient(config, "supervisor");

  const stats = store.getAgentStats(168);
  const totalDone = stats.reduce((s, a) => s + a.done, 0);
  const totalFailed = stats.reduce((s, a) => s + a.failed, 0);
  const nextMonth = getNextMonth();

  const context = `## Current Goals (${currentGoals.month})
${buildGoalsContext(progress)}

## 7-Day Performance
- Tasks completed: ${totalDone}, failed: ${totalFailed}
- Success rate: ${totalDone + totalFailed > 0 ? Math.round((totalDone / (totalDone + totalFailed)) * 100) : 0}%
- Agents: ${Object.keys(config.agents).length}

## What's shipped recently
The system now has: immune system with auto-learning patterns, multi-repo coordination, time-based meeting schedule, proxy health auto-heal, conflict escalation persistence, standup dispatch guard, capability pre-flight checks.

## Next month target: ${nextMonth}

Propose goals for ${nextMonth}. Carry forward any incomplete goals that are still relevant.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOAL_REFRESH_LLM_TIMEOUT_MS);

  try {
    const response = await client.messages.create({
      model: getLLMModel(config, "supervisor") ?? model,
      max_tokens: 2048,
      system: GOAL_REFRESH_SYSTEM_PROMPT,
      messages: [{ role: "user", content: context }],
    }, { signal: controller.signal });

    clearTimeout(timer);

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => "text" in b ? b.text : "")
      .join("");

    // Try parsing as YAML first (requested format), fall back to JSON
    try {
      const parsed = parseYaml(text) as GoalsConfig;
      if (parsed?.goals?.length) return parsed;
    } catch { /* fall through to JSON */ }

    const parsed = extractJSON<GoalsConfig>(text);
    if (parsed?.goals?.length) return parsed;

    log.warn("Could not parse goal refresh response", { preview: text.slice(0, 200) });
    return null;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function getNextMonth(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return next.toISOString().slice(0, 7);
}

function findGoalsPath(orchestratorDir?: string): string | null {
  const paths = [
    resolve(process.cwd(), "goals.yaml"),
    orchestratorDir ? resolve(orchestratorDir, "goals.yaml") : null,
    resolve(process.env.HOME ?? "", ".claude-orchestrator", "goals.yaml"),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}
