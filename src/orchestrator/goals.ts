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
import { cacheableSystemPrompt } from "../utils/prompt-cache.js";

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
    // Handle "== true" as a boolean check
    const boolMatch = metric.match(/^(\w+)\s*==\s*true$/);
    if (boolMatch) {
      const boolValue = evaluateMetricValue(boolMatch[1], store);
      return boolValue !== null && boolValue > 0 ? 1.0 : 0;
    }

    const match = metric.match(/^(\w+)\s*(>=|<=|>|<|==)\s*([\d.]+)$/);
    if (!match) return null;

    const [, name, op, thresholdStr] = match;
    const threshold = parseFloat(thresholdStr);
    const value = evaluateMetricValue(name, store);

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
 * Resolve a metric name to its current value from store data.
 * Add new metric names here as goals evolve.
 */
function evaluateMetricValue(name: string, store: StateStore): number | null {
  const stats = store.getAgentStats(168); // 7-day window
  const totalDone = stats.reduce((s, a) => s + a.done, 0);
  const totalFailed = stats.reduce((s, a) => s + a.failed, 0);
  const totalAll = totalDone + totalFailed;

  switch (name) {
    // Original metrics
    case "first_pass_rate":
      return totalAll > 0 ? totalDone / totalAll : null;
    case "escalation_rate": {
      const escalated = store.getTasksByStatus("escalated").length;
      const total = stats.reduce((s, a) => s + a.total, 0);
      return total > 0 ? escalated / total : 0;
    }
    case "tasks_completed":
      return totalDone;
    case "avg_quality_score": {
      const scored = stats.filter((a) => a.avg_score !== null);
      return scored.length > 0
        ? scored.reduce((s, a) => s + (a.avg_score ?? 0), 0) / scored.length
        : null;
    }

    // Scale/throughput metrics
    case "weekly_tasks_completed":
      return totalDone;
    case "failure_rate":
      return totalAll > 0 ? totalFailed / totalAll : null;
    case "first_pass_verification_rate":
      return totalAll > 0 ? totalDone / totalAll : null;
    case "active_agents": {
      try {
        // Count agents with at least one task in the last 7 days
        return stats.filter((a) => a.total > 0).length;
      } catch { return null; }
    }

    // Meeting facilitator metrics
    case "meeting_facilitator_deployed": {
      try {
        const { execSync } = require("node:child_process") as typeof import("node:child_process");
        const count = execSync("gh api repos/rapartlu/meeting-facilitator-agent/contents/src --jq length 2>/dev/null || echo 0", { encoding: "utf-8", timeout: 10_000 }).trim();
        return parseInt(count) > 0 ? 1 : 0;
      } catch { return 0; }
    }
    case "meetings_facilitated": {
      try {
        // Count meeting_outcome signals with decision="proceed" written by
        // the facilitator-agent. These land in the shared signals store via
        // `orch signals write`. The meetings table only contains standup and
        // bluesky runs (orchestrator-owned), so it would always return 0 for
        // facilitated meetings. Signals have a 168h TTL; count all unexpired
        // ones to approximate "this period's" facilitated runs.
        const outcomes = store.readSignals({ signal_type: "meeting_outcome" });
        return outcomes.filter((s) => {
          try {
            const v = JSON.parse(s.value as string) as { decision?: string };
            return v.decision === "proceed";
          } catch { return false; }
        }).length;
      } catch { return 0; }
    }

    default:
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
      system: cacheableSystemPrompt(GOAL_REFRESH_SYSTEM_PROMPT),
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

// ── Stalled OKR detection (anti-navel-gazing, issue #1258) ───────────────────

export interface StalledOKR {
  goal: Goal;
  /** How many days since any external-advancing task was recorded for this goal. */
  days_stalled: number;
  /** Whether the fleet has been below the external-impact threshold for 48h+. */
  should_pause_internal: boolean;
}

/**
 * Detect OKRs that have not advanced in `staleDays` days.
 *
 * Currently checks OKR-1 (external-oss-impact): if the external-impact ratio
 * is below 30% for more than `staleDays`, the OKR is considered stalled.
 * This triggers a P0 issue and (after 48h) sets `internal_dispatch_paused`.
 *
 * @param goals - Loaded GoalsConfig.
 * @param store - StateStore for querying task history.
 * @param staleDays - Number of days of zero external-advancing work before flagging (default 3).
 */
export function detectStalledOKRs(
  goals: GoalsConfig,
  store: StateStore,
  staleDays = 3,
): StalledOKR[] {
  const stalled: StalledOKR[] = [];

  for (const goal of goals.goals) {
    // Only check the external-oss-impact goal (OKR-1) — the others are
    // scale/cost/delivery goals that don't gate internal work.
    if (goal.id !== "external-oss-impact") continue;

    // Check if external-advancing ratio is below threshold over staleDays window
    const ratio = store.getExternalImpactRatio(staleDays);
    if (ratio.total === 0 || ratio.ratio >= ratio.threshold) continue;

    // Also check the 2-day window for the "pause internal" escalation
    const ratio48h = store.getExternalImpactRatio(2);
    const shouldPause = ratio48h.total > 0 && ratio48h.ratio < ratio48h.threshold;

    stalled.push({
      goal,
      days_stalled: staleDays,
      should_pause_internal: shouldPause,
    });

    log.warn("Stalled OKR detected", {
      goal: goal.id,
      days: staleDays,
      ratio: ratio.ratio.toFixed(2),
      threshold: ratio.threshold,
      external_advancing: ratio.external_advancing,
      total: ratio.total,
      should_pause_internal: shouldPause,
    });
  }

  return stalled;
}

export function findGoalsPath(orchestratorDir?: string): string | null {
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
