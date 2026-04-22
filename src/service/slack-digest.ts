/**
 * Scheduled daily Slack digest (issue #339).
 *
 * Builds a fleet summary from the state store and POSTs it to a configured
 * Slack incoming webhook URL.  The daemon calls `maybePostDailyDigest()` every
 * poll cycle; it fires at most once per calendar day at the operator-configured
 * wall-clock time (default 09:00 local).
 */

import { execSync } from "node:child_process";
import type { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLogger } from "./logger.js";

const log = createLogger("slack-digest");

// ─────────────────────────────────────────────────────────────────────────────
// Data types
// ─────────────────────────────────────────────────────────────────────────────

export interface DigestData {
  windowDays: number;
  generatedAt: string;
  fleet: {
    tasksCompleted: number;
    tasksFailed: number;
    tasksEscalated: number;
    mergedPRs: number;
    avgQualityScore: number | null;
  };
  agents: Array<{
    agentName: string;
    repo: string;
    tasksCompleted: number;
    tasksFailed: number;
    mergedPRs: number;
    avgQualityScore: number | null;
  }>;
  /** Research agent implementation task misroutes in the digest window. */
  researchMisroutes?: {
    count: number;
    avgQualityScore: number | null;
    examples: Array<{ title: string; qualityScore: number | null }>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an "HH:MM" schedule string into total minutes since midnight.
 * Returns 9 * 60 (= 09:00) on any parse error.
 */
export function parseScheduleMinutes(schedule: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(schedule.trim());
  if (!match) return 9 * 60;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return 9 * 60;
  return h * 60 + m;
}

/**
 * Return true if the current local time is at or past the scheduled minute
 * of day.  The daemon calls this every 5 minutes, so the digest fires within
 * one poll interval of the scheduled time.
 */
export function isScheduledTimeReached(schedule: string, now: Date = new Date()): boolean {
  const scheduledMinutes = parseScheduleMinutes(schedule);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return currentMinutes >= scheduledMinutes;
}

/**
 * Return today's date as a "YYYY-MM-DD" string (local time) so the daemon
 * can detect when a new calendar day starts and re-arm the digest.
 */
export function todayLocalDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data collection
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch the number of PRs merged in the last N days for a given repo. */
function fetchMergedPRCount(repo: string, days: number): number {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const output = execSync(
      `gh pr list --repo ${repo} --state merged --limit 200 --json number,mergedAt ` +
        `--jq '[.[] | select(.mergedAt >= "${since}")] | length'`,
      { timeout: 8000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const n = parseInt(output, 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/**
 * Build the digest data from the state store and config.
 * `days` controls the look-back window (default 1 = last 24 hours).
 */
export function buildDigestData(
  store: StateStore,
  config: OrchestratorConfig,
  days = 1,
): DigestData {
  const windowedMetrics = store.getWindowedAgentMetrics(days);
  const healthSummaries = store.getAgentHealthSummary();

  // Build agent → repo map from config
  const agentRepos = new Map<string, string>();
  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.github) agentRepos.set(name, agent.github);
  }

  const agentNames = new Set(Object.keys(config.agents));
  const rows = windowedMetrics
    .filter((m) => agentNames.has(m.agent_name))
    .map((m) => ({
      agentName: m.agent_name,
      repo: agentRepos.get(m.agent_name) ?? "",
      tasksCompleted: m.done,
      tasksFailed: m.failed,
      mergedPRs: 0,
      avgQualityScore: m.avg_quality_score,
    }));

  // Fetch merged PR counts (uses gh CLI; gracefully returns 0 on auth failure)
  for (const row of rows) {
    if (row.repo) {
      row.mergedPRs = fetchMergedPRCount(row.repo, days);
    }
  }

  // Escalated tasks in the window
  const escalatedCount = store
    .listTasks({ status: "escalated" })
    .filter((t) => {
      if (!t.updated_at) return false;
      const updated = new Date(t.updated_at).getTime();
      return updated >= Date.now() - days * 24 * 60 * 60 * 1000;
    }).length;

  const totalDone = rows.reduce((s, r) => s + r.tasksCompleted, 0);
  const totalFailed = rows.reduce((s, r) => s + r.tasksFailed, 0);
  const totalMerged = rows.reduce((s, r) => s + r.mergedPRs, 0);
  const qualityScores = rows
    .map((r) => r.avgQualityScore)
    .filter((s): s is number => s !== null);
  const avgQuality =
    qualityScores.length > 0
      ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
      : null;

  void healthSummaries; // available for future enrichment

  // Research agent implementation task misroutes (issue #1077)
  let researchMisroutes: DigestData["researchMisroutes"];
  try {
    const misrouteResult = store.getResearchAgentImplMisroutes("claude-research-agent", days);
    if (misrouteResult.count > 0) {
      const scoredTasks = misrouteResult.tasks.filter((t) => t.qualityScore !== null);
      const avgQs =
        scoredTasks.length > 0
          ? scoredTasks.reduce((sum, t) => sum + (t.qualityScore as number), 0) / scoredTasks.length
          : null;
      researchMisroutes = {
        count: misrouteResult.count,
        avgQualityScore: avgQs,
        examples: misrouteResult.tasks.slice(0, 3).map((t) => ({
          title: t.title,
          qualityScore: t.qualityScore,
        })),
      };
    }
  } catch {
    // Non-fatal — misroute data is supplementary
  }

  return {
    windowDays: days,
    generatedAt: new Date().toISOString(),
    fleet: {
      tasksCompleted: totalDone,
      tasksFailed: totalFailed,
      tasksEscalated: escalatedCount,
      mergedPRs: totalMerged,
      avgQualityScore: avgQuality,
    },
    agents: rows,
    ...(researchMisroutes ? { researchMisroutes } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slack formatting
// ─────────────────────────────────────────────────────────────────────────────

function fmtScore(score: number | null): string {
  if (score === null) return "—";
  return score.toFixed(2);
}

/**
 * Format a DigestData payload as a Slack message object (text + attachments).
 * Uses the legacy "text + attachment" format for maximum compatibility across
 * Slack plan types (Block Kit attachments require a paid plan in some contexts).
 */
export function formatSlackDigest(data: DigestData): object {
  const label = data.windowDays === 1 ? "last 24 hours" : `last ${data.windowDays} days`;
  const { fleet } = data;

  const qualityStr = fmtScore(fleet.avgQualityScore);
  const failedStr = fleet.tasksFailed > 0 ? `:warning: ${fleet.tasksFailed} failed` : "0 failed";
  const escalatedStr = fleet.tasksEscalated > 0 ? `  :rotating_light: ${fleet.tasksEscalated} escalated` : "";

  const headerLine =
    `:bar_chart: *Fleet Digest — ${label}*\n` +
    `${fleet.tasksCompleted} tasks completed  ·  ${fleet.mergedPRs} PRs merged  ·  ` +
    `${failedStr}${escalatedStr}  ·  quality ${qualityStr}`;

  // Per-agent rows
  const agentLines = data.agents
    .filter((a) => a.tasksCompleted + a.tasksFailed > 0)
    .map(
      (a) =>
        `• *${a.agentName}*: ${a.tasksCompleted} done, ${a.mergedPRs} PRs` +
        (a.tasksFailed > 0 ? `, ${a.tasksFailed} failed` : "") +
        (a.avgQualityScore !== null ? `, quality ${fmtScore(a.avgQualityScore)}` : ""),
    );

  const agentSection =
    agentLines.length > 0 ? agentLines.join("\n") : "_No agent activity in this window._";

  // Build misrouting alert attachment if research agent received implementation tasks
  const attachments: object[] = [
    {
      color: fleet.tasksFailed > 0 || fleet.tasksEscalated > 0 ? "warning" : "good",
      text: agentSection,
      footer: `claude-agent-orchestrator  ·  ${new Date(data.generatedAt).toLocaleString()}`,
    },
  ];

  if (data.researchMisroutes && data.researchMisroutes.count > 0) {
    const mr = data.researchMisroutes;
    const avgStr = mr.avgQualityScore !== null ? fmtScore(mr.avgQualityScore) : "—";
    const exampleLines = mr.examples
      .map((e) => `  › ${e.title}${e.qualityScore !== null ? ` (quality: ${fmtScore(e.qualityScore)})` : ""}`)
      .join("\n");
    attachments.push({
      color: "danger",
      title: `:warning: Research Agent Misrouting — ${mr.count} implementation task${mr.count === 1 ? "" : "s"} in ${label}`,
      text:
        `*claude-research-agent* received ${mr.count} implementation task${mr.count === 1 ? "" : "s"} (avg quality: ${avgStr}).\n` +
        `These should be rerouted to implementation agents. Recent examples:\n${exampleLines}\n` +
        `Run \`orch routing-mismatches --actual claude-research-agent\` or check \`/misrouting\` for details.`,
      footer: "Research agent misroute alert  ·  issue #1077",
    });
  }

  return {
    text: headerLine,
    attachments,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Posting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST the digest payload to the Slack incoming webhook.
 * Throws on HTTP errors so the caller can log/retry.
 */
export async function postToSlackWebhook(webhookUrl: string, payload: object): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Slack webhook returned ${res.status}: ${body}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon integration — single entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State held by the daemon across poll cycles.  Kept outside the Daemon class
 * so it can be imported and tested independently.
 */
export interface DigestSchedulerState {
  /** The local date ("YYYY-MM-DD") on which the digest was last sent. null = never. */
  lastDigestDate: string | null;
}

/**
 * Check whether the configured daily digest should fire on this poll cycle,
 * and if so, build the payload and POST it to Slack.
 *
 * Safe to call every poll cycle — it is a no-op when:
 *  - No `dashboard.digest.slack_webhook` is configured
 *  - The digest has already been sent today
 *  - The current time is before the scheduled window
 */
export async function maybePostDailyDigest(
  state: DigestSchedulerState,
  store: StateStore,
  config: OrchestratorConfig,
  now: Date = new Date(),
): Promise<void> {
  const digestConfig = config.dashboard?.digest;
  if (!digestConfig?.slack_webhook) return;

  const schedule = digestConfig.schedule ?? "09:00";
  const today = todayLocalDateString(now);

  // Already sent today
  if (state.lastDigestDate === today) return;

  // Not yet the scheduled time
  if (!isScheduledTimeReached(schedule, now)) return;

  // Mark as sent before awaiting so concurrent cycles don't double-post
  state.lastDigestDate = today;

  try {
    const data = buildDigestData(store, config, 1);
    const payload = formatSlackDigest(data);
    await postToSlackWebhook(digestConfig.slack_webhook, payload);
    log.info("Daily Slack digest sent", { schedule, date: today, tasksCompleted: data.fleet.tasksCompleted });
  } catch (err) {
    // Don't reset lastDigestDate — one attempt per day is enough even on failure.
    // The operator will see the missing digest and can run `orch digest` manually.
    log.error("Failed to send daily Slack digest", { error: String(err) });
  }
}
