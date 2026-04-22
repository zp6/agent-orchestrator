/**
 * Telegram command handler — wires operator bot commands to live state.db.
 *
 * Commands handled:
 *   /status      → real-time counts from state.db (active, pending, recent)
 *   /health      → unified operator snapshot: connectivity checks + last-6h dispatch stats + per-agent quality (24h) + reconciliation status + open escalations
 *   /pause       → writes paused=true flag to system_flags
 *   /resume      → writes paused=false flag to system_flags
 *   /dispatch <agent> <instruction...>  → inserts dispatch_request row for orchestrator
 *   /prioritize <item>     → bumps priority on matching task row
 *   /ack|/dismiss|/resolve [target] → clears escalated task(s) back to pending
 *   /deescalate [target]   → alias for /resolve
 *   /queue [repo]          → shows PR merge queue entries, optionally filtered by repo
 *   /logs [n]    → last N supervisor decisions (default 10), newest first
 *   /supervisor [n]  → last N supervisor decisions with full detail (default 10)
 *   /agents      → per-agent stats: total/done/failed/avg quality score
 *   /sla [status|set|clear] → configure and monitor quality SLA thresholds
 *   /quality [tasks] → live per-agent quality health snapshot over the most recent tasks (default 20)
 *   /verification-calibration [days] → score histograms, low-conf approvals, and drift alerts
 *   /calibration         → verifier × score-bucket × task-type merge-rate table (highlights merge_rate < 0.70; flags n<30 cells)
 *   /token-stats [hours] → per-call-type LLM token usage (default: 720h = 30 days)
 *   /first-pass-rate [weeks] → first-pass rate widget: month-to-date rate, 30-day trend, and agent/task-type drill-down toward 80% goal
 *   /fpr [weeks]  → alias for /first-pass-rate
 *   /score <task-id> → display quality score and verification details for a task
 *   /backfill-scores [limit] → backfill quality_score for approved tasks with null scores (limit 1-20, default 5)
 *   /reconcile [hours] → cross-repo reconciliation status: last result per repo with outcome and timestamp (default: all time)
 *   /decisions [n] → last N routing decisions with chosen issue, skipped alternatives, and one-sentence rationale (default 5, max 10)
 *   /suppress <repo> <issue> → suppress Telegram storm alerts for a specific issue (e.g. /suppress rapartlu/agent-proxy 423)
 *   /review-queue          → list all tasks held for operator review (needs_operator_review) with score and risk tier
 *   /approve <task-id> [note] → approve a held task with operator override, bypassing the 0.60 floor
 *   /reject <task-id> [note]  → reject a held task from the operator review queue
 *   /routing-violations [n]   → list the last N agent-to-repo routing violations (default 10)
 *   /quality-health            → quality system health: bypass rate, sparkline, and bypassed task list
 *   /backfill-bypass-reasons   → backfill bypass_reason for historical sub-0.60 approved tasks (idempotent)
 *   /low-score [threshold] [limit] → approved tasks with quality score below threshold (default 0.75), with dimension breakdown
 *   /memory [expand <topic>|digest] → semantic task memory digest or full topic expansion
 *   /misrouting [hours]        → implementation tasks misrouted to reviewer in last N hours (default 24h, max 720h)
 *   /triage-health [agent]     → per-agent triage schema pass/fail rate, missing fields, revision count, and 7-day trend
 *
 * Usage:
 *   const handler = new TelegramCommandHandler(stateStore);
 *   const stop = handler.start();   // begins long-polling
 *   // later:
 *   stop();
 */

import { createLogger } from "../service/logger.js";
import type {
  ITelegramStateStore,
  Task,
  LlmTokenStats,
  ScoreCalibrationRow,
  VerificationStats,
  FirstPassRateWidget,
  QualityHealthReport,
  ReconciliationLastPerRepo,
} from "../state/types.js";
import type { ConflictStatsProvider } from "../reviewer/supervisor.js";
import { buildIssueAgeHeatmap, formatIssueAgeHeatmap } from "../reviewer/issue-age.js";
import type { CalibrationDriftProvider } from "../reviewer/calibration-drift.js";
import { CalibrationDriftMonitor } from "../reviewer/calibration-drift.js";
import { Verifier } from "../reviewer/verifier.js";
import {
  buildRoutingDecisions,
  formatDecisionsForTelegram,
} from "../supervisor-log.js";
import type { DuplicateDispatchSurgeDetector } from "../reviewer/duplicate-dispatch-surge-detector.js";
import {
  getQualitySystemHealthPayload,
  formatQualitySystemHealthPage,
} from "../reviewer/quality-system-health.js";
import {
  getLowScoreApprovedFeed,
  formatLowScoreFeedForTelegram,
  LOW_SCORE_FEED_THRESHOLD,
} from "../reviewer/low-score-feed.js";
import type { ISemanticMemoryStore } from "../state/types.js";
import {
  buildMemoryDigest,
  formatMemoryDigest,
} from "../reviewer/memory-digest.js";
import {
  buildMisroutingDigest,
  formatMisroutingDigest,
} from "../reviewer/misrouting-digest.js";
import {
  getTriageHealthPayload,
  formatTriageHealthForTelegram,
} from "../reviewer/triage-health.js";
import type { ReviewerConfig } from "../config.js";
export type { ConflictStatsProvider } from "../reviewer/supervisor.js";

const log = createLogger("telegram-commands");

// ── Telegram API types ────────────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

// ── Supported commands ────────────────────────────────────────────────────

type CommandName =
  | "status"
  | "health"
  | "pause"
  | "resume"
  | "dispatch"
  | "prioritize"
  | "ack"
  | "dismiss"
  | "resolve"
  | "deescalate"
  | "de-escalate"
  | "queue"
  | "logs"
  | "supervisor"
  | "agents"
  | "s"
  | "sla"
  | "quality"
  | "verification-calibration"
  | "calibration"
  | "token-stats"
  | "first-pass-rate"
  | "fpr"
  | "score"
  | "backfill-scores"
  | "reconcile"
  | "decisions"
  | "suppress"
  | "review-queue"
  | "approve"
  | "reject"
  | "routing-violations"
  | "quality-health"
  | "backfill-bypass-reasons"
  | "low-score"
  | "memory"
  | "misrouting"
  | "triage-health";

const SUPPORTED_COMMANDS = new Set<CommandName>([
  "status",
  "health",
  "pause",
  "resume",
  "dispatch",
  "prioritize",
  "ack",
  "dismiss",
  "resolve",
  "deescalate",
  "de-escalate",
  "queue",
  "logs",
  "supervisor",
  "agents",
  "s",
  "sla",
  "quality",
  "verification-calibration",
  "calibration",
  "token-stats",
  "first-pass-rate",
  "fpr",
  "score",
  "backfill-scores",
  "reconcile",
  "decisions",
  "suppress",
  "review-queue",
  "approve",
  "reject",
  "routing-violations",
  "quality-health",
  "backfill-bypass-reasons",
  "low-score",
  "memory",
  "misrouting",
  "triage-health",
]);

interface ParsedCommand {
  command: CommandName;
  args: string[];
  chatId: number;
  messageId: number;
}

// ── Config helpers ────────────────────────────────────────────────────────

function resolveConfig(): { botToken: string; chatId: string } | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

// ── Low-level Telegram API calls ──────────────────────────────────────────

async function telegramRequest<T>(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "unknown");
    throw new Error(`Telegram ${method} failed ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
): Promise<void> {
  await telegramRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

async function getUpdates(
  botToken: string,
  offset: number,
  timeoutSecs: number,
): Promise<TelegramUpdate[]> {
  const resp = await telegramRequest<TelegramGetUpdatesResponse>(
    botToken,
    "getUpdates",
    { offset, timeout: timeoutSecs, allowed_updates: ["message"] },
  );
  return resp.result;
}

// ── Command parsing ───────────────────────────────────────────────────────

function parseCommand(update: TelegramUpdate): ParsedCommand | null {
  const msg = update.message;
  if (!msg?.text) return null;

  const text = msg.text.trim();
  if (!text.startsWith("/")) return null;

  // Strip @BotName suffix (group chats)
  const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
  const cmdBase = (rawCmd?.split("@")[0] ?? "").toLowerCase() as CommandName;

  if (!SUPPORTED_COMMANDS.has(cmdBase)) return null;

  return {
    command: cmdBase,
    args: rest,
    chatId: msg.chat.id,
    messageId: msg.message_id,
  };
}

// ── Command execution ─────────────────────────────────────────────────────

async function executeCommand(
  cmd: ParsedCommand,
  store: ITelegramStateStore,
  botToken: string,
  conflictStatsProvider?: ConflictStatsProvider,
  calibrationDriftProvider?: CalibrationDriftProvider,
  verifier?: Verifier,
  dashboardUrl?: string,
  surgeDetector?: DuplicateDispatchSurgeDetector,
  reviewerConfig?: ReviewerConfig,
): Promise<string> {
  switch (cmd.command) {
    case "status":
      return handleStatus(store);

    case "health":
      return handleHealth(store, botToken, dashboardUrl);

    case "pause": {
      store.setSystemFlag("paused", "true");
      return "⏸ *Paused* — orchestrator poll loop will halt on next cycle. Send /resume to restart.";
    }

    case "resume": {
      store.setSystemFlag("paused", "false");
      return "▶️ *Resumed* — orchestrator poll loop re-enabled.";
    }

    case "dispatch": {
      const [agentName, ...msgParts] = cmd.args;
      if (!agentName) {
        return "⚠️ Usage: `/dispatch <agent-name> <instruction...>`";
      }
      const message = msgParts.join(" ").trim();
      if (!message) {
        return "⚠️ Usage: `/dispatch <agent-name> <instruction...>`\nExample: `/dispatch my-agent fix the failing tests in src/`";
      }
      const req = store.createDispatchRequest(agentName, message);
      return [
        `🚀 *Dispatch request created*`,
        ``,
        `Agent: \`${agentName}\``,
        `Instruction: ${message}`,
        `Request ID: \`${req.id}\``,
        `Status: ${req.status}`,
        ``,
        `The orchestrator will pick this up on its next poll cycle.`,
      ].join("\n");
    }

    case "prioritize": {
      const item = cmd.args.join(" ").trim();
      if (!item) {
        return "⚠️ Usage: `/prioritize <task-id-or-title>`";
      }
      const updated = store.prioritizeTask(item);
      if (updated) {
        return `✅ *Prioritized* — task matching \`${item}\` moved to priority 100.`;
      }
      return `❌ No task found matching \`${item}\`. Use an ID prefix or a word from the title.`;
    }

    case "ack":
    case "dismiss":
    case "resolve":
    case "deescalate":
    case "de-escalate":
      return handleDeescalation(store, cmd.command, cmd.args.join(" ").trim());

    case "queue": {
      const repo = cmd.args[0]?.trim() || undefined;
      return handleQueue(store, repo);
    }

    case "logs": {
      const n = parseInt(cmd.args[0] ?? "10", 10);
      const limit = Number.isNaN(n) || n < 1 ? 10 : Math.min(n, 50);
      return handleLogs(store, limit);
    }

    case "supervisor": {
      const n = parseInt(cmd.args[0] ?? "10", 10);
      const limit = Number.isNaN(n) || n < 1 ? 10 : Math.min(n, 50);
      return handleSupervisorLog(store, limit);
    }

    case "agents":
      return handleAgents(store);

    case "s":
      return handleWeeklySummary(store, conflictStatsProvider);

    case "verification-calibration": {
      const days = parseInt(cmd.args[0] ?? "30", 10);
      const windowDays = Number.isNaN(days) || days < 1 ? 30 : Math.min(days, 90);
      const provider: CalibrationDriftProvider = calibrationDriftProvider ?? new CalibrationDriftMonitor(store);
      const report = provider.buildReport({ windowDays });
      return provider.formatDistributionPage(report);
    }

    case "calibration":
      return handleCalibrationTable(store);

    case "sla":
      return handleSLA(store, cmd.args);

    case "quality": {
      // /quality tasks [limit] → per-task quality score listing
      if (cmd.args[0] === "tasks") {
        const n = parseInt(cmd.args[1] ?? "20", 10);
        const limit = Number.isNaN(n) || n < 1 ? 20 : Math.min(n, 50);
        return handleQualityTasks(store, limit);
      }
      const tasks = parseInt(cmd.args[0] ?? "20", 10);
      const windowTasks = Number.isNaN(tasks) || tasks < 1 ? 20 : Math.min(tasks, 100);
      return handleQuality(store, windowTasks);
    }

    case "token-stats": {
      const hours = parseInt(cmd.args[0] ?? "720", 10);
      const windowHours = Number.isNaN(hours) || hours < 1 ? 720 : Math.min(hours, 8760);
      return handleTokenStats(store, windowHours);
    }

    case "first-pass-rate":
    case "fpr": {
      const weeks = parseInt(cmd.args[0] ?? "4", 10);
      const weeksBack = Number.isNaN(weeks) || weeks < 1 ? 4 : Math.min(weeks, 12);
      return handleFirstPassRate(store, weeksBack);
    }

    case "score": {
      const taskId = cmd.args[0]?.trim();
      if (!taskId) {
        return "⚠️ Usage: `/score <task-id>`\nExample: `/score 01KP63B3` or `/score 01KP63B3XXXXXXXXXXXX`";
      }
      return handleScore(store, taskId);
    }

    case "backfill-scores": {
      const limitStr = cmd.args[0]?.trim();
      const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 5, 1), 20) : 5;
      return handleBackfillScores(store, verifier, limit);
    }

    case "reconcile": {
      const hoursStr = cmd.args[0]?.trim();
      const sinceHours = hoursStr ? Math.min(Math.max(parseInt(hoursStr, 10) || 0, 0), 720) : undefined;
      return handleReconcile(store, sinceHours || undefined);
    }

    case "decisions": {
      const n = parseInt(cmd.args[0] ?? "5", 10);
      const limit = Number.isNaN(n) || n < 1 ? 5 : Math.min(n, 10);
      return handleDecisions(store, limit);
    }

    case "suppress": {
      // /suppress <repo> <issue>
      // e.g. /suppress rapartlu/agent-proxy 423
      const [repo, issueArg] = cmd.args;
      if (!repo || !issueArg) {
        return [
          "⚠️ Usage: `/suppress <repo> <issue>`",
          "Example: `/suppress rapartlu/agent-proxy 423`",
          "",
          "Silences storm alerts for the given issue until the reviewer restarts.",
          "Use `/suppress <repo> <issue>` again to re-check suppression status.",
        ].join("\n");
      }
      if (!surgeDetector) {
        return "⚠️ Surge detector not available — cannot suppress.";
      }
      surgeDetector.suppress(repo, issueArg);
      const normRef = issueArg.startsWith("#") ? issueArg : `#${issueArg}`;
      return [
        `🔕 *Suppressed* — storm alerts for issue ${normRef} in \`${repo}\` silenced.`,
        ``,
        `No further dispatch-storm Telegram messages will be sent for this issue until the reviewer restarts.`,
      ].join("\n");
    }

    case "review-queue":
      return handleReviewQueue(store);

    case "approve": {
      const [taskId, ...noteParts] = cmd.args;
      if (!taskId) {
        return "⚠️ Usage: `/approve <task-id> [note]`\nExample: `/approve 01KP63B3 Reviewed manually — acceptable for this context`";
      }
      const note = noteParts.join(" ").trim() || "Approved by operator via Telegram";
      return handleOperatorOverride(store, taskId, "approve", note);
    }

    case "reject": {
      const [taskId, ...noteParts] = cmd.args;
      if (!taskId) {
        return "⚠️ Usage: `/reject <task-id> [note]`\nExample: `/reject 01KP63B3 Needs complete rewrite`";
      }
      const note = noteParts.join(" ").trim() || "Rejected by operator via Telegram";
      return handleOperatorOverride(store, taskId, "reject", note);
    }

    case "routing-violations": {
      const limitStr = cmd.args[0]?.trim();
      const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 10, 1), 50) : 10;
      return handleRoutingViolations(store, limit);
    }

    case "quality-health":
      return handleQualitySystemHealth(store, dashboardUrl);

    case "backfill-bypass-reasons":
      return handleBackfillBypassReasons(store);

    case "low-score": {
      // /low-score [threshold] [limit]
      // threshold: score ceiling (default 0.75), limit: max entries (default 10)
      const thresholdArg = cmd.args[0]?.trim();
      const limitArg = cmd.args[1]?.trim();

      const threshold = thresholdArg
        ? Math.min(Math.max(parseFloat(thresholdArg) || LOW_SCORE_FEED_THRESHOLD, 0.01), 1.0)
        : LOW_SCORE_FEED_THRESHOLD;

      const limit = limitArg
        ? Math.min(Math.max(parseInt(limitArg, 10) || 50, 1), 100)
        : 50;

      return handleLowScoreFeed(store, threshold, limit, dashboardUrl);
    }

    case "memory": {
      // /memory expand <topic>  — show full indexed entries for a topic
      // /memory                 — show a fresh digest snapshot
      const [subCommand, ...topicParts] = cmd.args;

      if (!subCommand || subCommand.toLowerCase() === "digest") {
        // Render a fresh digest on demand
        return handleMemoryDigest(store);
      }

      if (subCommand.toLowerCase() === "expand") {
        const topic = topicParts.join(" ").trim();
        if (!topic) {
          return [
            `⚠️ *Usage:* \`/memory expand <topic>\``,
            ``,
            `Example: \`/memory expand authentication\``,
          ].join("\n");
        }
        return handleMemoryExpand(store, topic);
      }

      // Treat any unrecognised subcommand as a topic expand
      const fallbackTopic = [subCommand, ...topicParts].join(" ").trim();
      return handleMemoryExpand(store, fallbackTopic);
    }

    case "misrouting": {
      const hoursStr = cmd.args[0]?.trim();
      const lookbackHours = hoursStr
        ? Math.min(Math.max(parseInt(hoursStr, 10) || 24, 1), 720)
        : 24;
      return handleMisrouting(store, lookbackHours, reviewerConfig);
    }

    case "triage-health": {
      // /triage-health [agent]
      // When an agent name is supplied, show that agent's detail only.
      const agentArg = cmd.args.join(" ").trim() || undefined;
      return handleTriageHealth(store, agentArg);
    }
  }
}

async function handleStatus(store: ITelegramStateStore): Promise<string> {
  const active = store.listTasks({ status: "in_progress" });
  const dispatched = store.listTasks({ status: "dispatched" });
  const escalated = store.listTasks({ status: "escalated", limit: 100 });
  const pendingVerification = store.getUnverified(5);
  const recentDone = store.getRecentCompleted(3);
  const recentFailed = store.listTasks({ status: "failed", limit: 3 });
  const isPaused = store.getSystemFlag("paused") === "true";
  const pendingDispatch = store.getPendingDispatchRequests();
  const heatmap = buildIssueAgeHeatmap(store.listTasks({ limit: 500 }));

  const lines: string[] = [
    `📊 *System Status*`,
    ``,
    `🔄 Active tasks: ${active.length + dispatched.length}`,
  ];

  if (active.length > 0 || dispatched.length > 0) {
    for (const t of [...active, ...dispatched].slice(0, 5)) {
      lines.push(`  • \`${t.id.slice(0, 8)}\` ${t.title.slice(0, 40)} _(${t.agent_name ?? "unassigned"})_`);
    }
  }

  lines.push(``, `🚨 Escalated tasks: ${escalated.length}`);
  if (escalated.length > 0) {
    for (const t of escalated.slice(0, 5)) {
      lines.push(`  • \`${t.id.slice(0, 8)}\` ${t.title.slice(0, 40)} _(${t.agent_name ?? "unassigned"})_`);
    }
  }

  if (heatmap.total > 0) {
    lines.push(``, ...formatIssueAgeHeatmap(heatmap));
    const stale = heatmap.buckets.find((bucket) => bucket.bucket === "30d+");
    if (stale && stale.tasks.length > 0) {
      lines.push(`  *Oldest:*`);
      for (const task of stale.tasks.slice(0, 5)) {
        const issueRef = task.issueRef ? ` · ${task.issueRef}` : "";
        lines.push(`    • \`${task.taskId.slice(0, 8)}\` ${task.title.slice(0, 36)}${issueRef}`);
      }
    }
  }

  lines.push(``, `🔍 Pending verification: ${pendingVerification.length}`);

  if (recentDone.length > 0) {
    lines.push(``, `✅ Recently completed:`);
    for (const t of recentDone) {
      const score = t.quality_score != null ? ` · ${(t.quality_score * 100).toFixed(0)}%` : "";
      lines.push(`  • \`${t.id.slice(0, 8)}\` ${t.title.slice(0, 40)}${score}`);
    }
  }

  if (recentFailed.length > 0) {
    lines.push(``, `❌ Recent failures: ${recentFailed.length}`);
    for (const t of recentFailed) {
      lines.push(`  • \`${t.id.slice(0, 8)}\` ${t.title.slice(0, 40)}`);
    }
  }

  if (pendingDispatch.length > 0) {
    lines.push(``, `📬 Queued dispatch requests: ${pendingDispatch.length}`);
  }

  lines.push(``, isPaused ? `⏸ Poll loop: *PAUSED*` : `▶️ Poll loop: *running*`);

  return lines.join("\n");
}

function getEscalatedTasks(store: ITelegramStateStore): Task[] {
  return store.listTasks({ status: "escalated", limit: 100 });
}

function matchesTaskTarget(task: Task, rawTarget: string): boolean {
  const target = rawTarget.trim().toLowerCase();
  if (!target || target === "all") return true;

  const taskId = task.id.toLowerCase();
  if (taskId.startsWith(target)) return true;

  const title = task.title.toLowerCase();
  if (title.includes(target)) return true;

  const sourceRef = task.source_ref?.toLowerCase();
  if (sourceRef) {
    if (sourceRef === target || sourceRef.includes(target)) return true;
  }

  const source = task.source?.toLowerCase();
  if (source && source.includes(target)) return true;

  const needle = target.startsWith("#") ? target : `#${target}`;
  const haystacks = [task.description, task.result].filter((value): value is string => typeof value === "string");
  if (haystacks.some((value) => value.toLowerCase().includes(target))) return true;

  if (task.source_ref?.toLowerCase().includes(needle)) return true;
  return task.title.toLowerCase().includes(needle);
}

function summarizeTask(task: Task): string {
  const sourceRef = task.source_ref ? ` · ${task.source_ref}` : "";
  const agent = task.agent_name ? ` (${task.agent_name})` : "";
  return `\`${task.id.slice(0, 8)}\`${agent} ${task.title.slice(0, 48)}${sourceRef}`;
}

function handleDeescalation(
  store: ITelegramStateStore,
  command: "ack" | "dismiss" | "resolve" | "deescalate" | "de-escalate",
  targetRaw: string,
): string {
  const target = targetRaw.trim() || "all";
  const escalated = getEscalatedTasks(store);
  const matched =
    target.toLowerCase() === "all"
      ? escalated
      : escalated.filter((task) => matchesTaskTarget(task, target));

  if (matched.length === 0) {
    return target.toLowerCase() === "all"
      ? "ℹ️ No escalated tasks are currently active."
      : `ℹ️ No escalated tasks matched \`${target}\`.`;
  }

  for (const task of matched) {
    store.updateTask(task.id, { status: "pending" });
  }

  const reason = `Telegram /${command} de-escalated ${matched.length} task(s)${target.toLowerCase() === "all" ? "" : ` for ${target}`}`;
  store.recordSupervisorDecision(command, reason, {
    taskId: matched.length === 1 ? matched[0].id : undefined,
    outcome: "de-escalated",
    message: target.toLowerCase() === "all" ? "all escalated tasks" : target,
  });

  const preview = matched.slice(0, 5).map((task) => `  • ${summarizeTask(task)}`).join("\n");
  const more = matched.length > 5 ? `\n  • ...and ${matched.length - 5} more` : "";

  return [
    `✅ *De-escalated* ${matched.length} task${matched.length === 1 ? "" : "s"}`,
    ``,
    `Returned to *pending* queue.`,
    `Target: \`${target}\``,
    ``,
    preview + more,
  ].join("\n");
}

async function handleHealth(
  store: ITelegramStateStore,
  botToken: string,
  dashboardUrl?: string,
): Promise<string> {
  const sections: string[] = [];

  // ── Section 1: Connectivity ───────────────────────────────────────────────
  const connResults: { label: string; ok: boolean; detail: string }[] = [];

  try {
    store.listTasks({ limit: 1 });
    connResults.push({ label: "SQLite state.db", ok: true, detail: "query succeeded" });
  } catch (err) {
    connResults.push({
      label: "SQLite state.db",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const resp = await fetch("https://api.github.com", {
      headers: { "User-Agent": "claude-orchestrator-reviewer" },
      signal: AbortSignal.timeout(5000),
    });
    connResults.push({
      label: "GitHub API",
      ok: resp.ok || resp.status === 200,
      detail: `HTTP ${resp.status}`,
    });
  } catch (err) {
    connResults.push({
      label: "GitHub API",
      ok: false,
      detail: err instanceof Error ? err.message : "unreachable",
    });
  }

  try {
    const me = await telegramRequest<{ ok: boolean; result?: { username?: string } }>(
      botToken,
      "getMe",
    );
    connResults.push({
      label: "Telegram bot token",
      ok: me.ok,
      detail: me.result?.username ? `@${me.result.username}` : "valid",
    });
  } catch (err) {
    connResults.push({
      label: "Telegram bot token",
      ok: false,
      detail: err instanceof Error ? err.message : "invalid",
    });
  }

  const connAllOk = connResults.every((r) => r.ok);
  sections.push(
    [
      `*📡 Connectivity* ${connAllOk ? "✅" : "⚠️"}`,
      ...connResults.map((r) => `${r.ok ? "✅" : "❌"} ${r.label}: ${r.detail}`),
    ].join("\n"),
  );

  // ── Section 2: Dispatch stats (last 6h) ───────────────────────────────────
  try {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const recentDecisions = store.querySupervisorDecisions({ limit: 500, since: sixHoursAgo });

    let dispatched = 0;
    let skipped = 0;
    let blocked = 0;

    for (const d of recentDecisions) {
      if (d.outcome === "dispatched" || d.action === "dispatch" || d.action === "follow-up") {
        dispatched++;
      } else if (d.outcome === "blocked") {
        blocked++;
      } else if (d.outcome === "skipped" || d.action === "none") {
        skipped++;
      }
    }

    const total = dispatched + skipped + blocked;
    const skipBlockRate =
      total > 0 ? Math.round(((skipped + blocked) / total) * 100) : 0;

    const dispatchLines = [
      `*📊 Dispatch — last 6h*`,
      `Dispatched: ${dispatched}  |  Skipped: ${skipped}  |  Blocked: ${blocked}`,
      `Skip/block rate: ${skipBlockRate}%`,
    ];
    if (dashboardUrl) {
      dispatchLines.push(`[→ Dispatch health panel](${dashboardUrl}/dispatch)`);
    }
    sections.push(dispatchLines.join("\n"));
  } catch {
    sections.push(`*📊 Dispatch — last 6h*\n_unavailable_`);
  }

  // ── Section 3: Per-agent quality (last 24h) ───────────────────────────────
  try {
    const accuracyStats = store.getRoutingAccuracyStats(1);
    const qualityLines = [`*🎯 Quality — last 24h*`];

    if (accuracyStats.length === 0) {
      qualityLines.push(`_No scored tasks in window_`);
    } else {
      for (const s of accuracyStats.slice(0, 6)) {
        const score =
          s.avg_quality_score != null
            ? s.avg_quality_score.toFixed(2)
            : "n/a";
        const trend =
          s.avg_quality_score != null && s.avg_quality_score >= 0.8
            ? "✅"
            : s.avg_quality_score != null && s.avg_quality_score >= 0.7
              ? "⚠️"
              : "❌";
        qualityLines.push(
          `${trend} \`${s.agent_name}\`: ${score} (${s.total_routed} tasks)`,
        );
      }
    }

    if (dashboardUrl) {
      qualityLines.push(`[→ Quality dashboard](${dashboardUrl}/quality)`);
    }
    sections.push(qualityLines.join("\n"));
  } catch {
    sections.push(`*🎯 Quality — last 24h*\n_unavailable_`);
  }

  // ── Section 4: Reconciliation ─────────────────────────────────────────────
  try {
    const reconcEvents = store.getLastReconciliationPerRepo();
    const reconcLines = [`*🔄 Reconciliation*`];

    if (reconcEvents.length === 0) {
      reconcLines.push(`_No reconciliation events recorded_`);
    } else {
      for (const ev of reconcEvents.slice(0, 5)) {
        const icon =
          ev.status === "success"
            ? "✅"
            : ev.status === "partial"
              ? "⚠️"
              : "❌";
        const age = formatAge(ev.created_at);
        const repoShort = ev.repo.replace(/^[^/]+\//, "");
        reconcLines.push(`${icon} \`${repoShort}\`: ${ev.status} (${age})`);
      }
    }

    if (dashboardUrl) {
      reconcLines.push(`[→ Reconciliation log](${dashboardUrl}/reconcile)`);
    }
    sections.push(reconcLines.join("\n"));
  } catch {
    sections.push(`*🔄 Reconciliation*\n_unavailable_`);
  }

  // ── Section 5: Open escalations ───────────────────────────────────────────
  try {
    const escalated = store.listTasks({ status: "escalated", limit: 5 });
    const escLines = [`*🚨 Escalations*`];

    if (escalated.length === 0) {
      escLines.push(`✅ None`);
    } else {
      escLines.push(`${escalated.length} open — run /ack, /resolve, or /status for details`);
      for (const t of escalated.slice(0, 3)) {
        const title = t.title.length > 50 ? t.title.slice(0, 47) + "…" : t.title;
        escLines.push(`  • \`${t.id.slice(0, 8)}\` ${title}`);
      }
      if (escalated.length > 3) {
        escLines.push(`  • _…and ${escalated.length - 3} more_`);
      }
    }

    if (dashboardUrl) {
      escLines.push(`[→ Escalations](${dashboardUrl}/escalations)`);
    }
    sections.push(escLines.join("\n"));
  } catch {
    sections.push(`*🚨 Escalations*\n_unavailable_`);
  }

  // ── Header ────────────────────────────────────────────────────────────────
  const now = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const overallOk = connAllOk;
  const header = `${overallOk ? "🏥" : "⚠️"} *System Health* — ${now}`;

  return [header, "", ...sections].join("\n\n");
}

/** Format an ISO-8601 timestamp as a human-readable age string (e.g. "2h ago"). */
function formatAge(isoTs: string): string {
  const diffMs = Date.now() - new Date(isoTs).getTime();
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function handleQueue(store: ITelegramStateStore, repo?: string): string {
  const entries = store.getMergeQueue(repo);

  if (entries.length === 0) {
    const scope = repo ? `\`${repo}\`` : "any repo";
    return `📭 *Merge Queue* — no entries for ${scope}.`;
  }

  // Group entries by repo
  const byRepo = new Map<string, typeof entries>();
  for (const entry of entries) {
    const list = byRepo.get(entry.repo) ?? [];
    list.push(entry);
    byRepo.set(entry.repo, list);
  }

  const STATUS_ICON: Record<string, string> = {
    queued: "🕐",
    merging: "🔀",
    merged: "✅",
    failed: "❌",
    skipped: "⏭",
  };

  const lines: string[] = [`🔢 *Merge Queue*`, ``];

  for (const [repoName, repoEntries] of byRepo) {
    lines.push(`*${repoName}* (${repoEntries.length} entr${repoEntries.length === 1 ? "y" : "ies"})`);
    for (const e of repoEntries) {
      const icon = STATUS_ICON[e.status] ?? "❓";
      const enqueued = e.enqueued_at ?? e.created_at ?? "unknown";
      // Format ISO timestamp to a shorter human-readable form: "2026-04-05 14:32"
      const enqueuedShort = enqueued.replace("T", " ").slice(0, 16);
      const posLabel = e.status === "queued" || e.status === "merging" ? ` · pos ${e.position}` : "";
      lines.push(
        `  ${icon} *PR #${e.pr_number}* \`${e.branch}\`${posLabel} · ${e.status} · enqueued ${enqueuedShort}`,
      );
      if (e.error) {
        lines.push(`    ⚠️ ${e.error}`);
      }
    }
    lines.push(``);
  }

  // Trim trailing blank line
  if (lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
}

async function handleLogs(store: ITelegramStateStore, limit: number): Promise<string> {
  const decisions = store.getRecentSupervisorDecisions(limit);

  if (decisions.length === 0) {
    return "📋 *Supervisor Logs*\n\nNo decisions recorded yet.";
  }

  const lines: string[] = [`📋 *Supervisor Logs* (last ${decisions.length})`, ``];

  for (const d of decisions) {
    const ts = d.created_at ? new Date(d.created_at).toISOString().replace("T", " ").slice(0, 19) : "—";
    const agent = d.agent_name ? ` · \`${d.agent_name}\`` : "";
    lines.push(`*${d.action}*${agent}`);
    lines.push(`  Outcome: ${d.outcome}`);
    lines.push(`  Reason: ${d.reason.slice(0, 120)}${d.reason.length > 120 ? "…" : ""}`);
    lines.push(`  _${ts}_`);
    lines.push(``);
  }

  return lines.join("\n").trimEnd();
}

/**
 * /decisions [N] — last N routing decisions with chosen issue, skipped
 * alternatives, and one-sentence rationale (default 5, max 10).
 */
function handleDecisions(store: ITelegramStateStore, limit: number): string {
  const raw = store.getRecentSupervisorDecisions(Math.min(limit * 10, 100));
  const entries = buildRoutingDecisions(raw, limit);
  return formatDecisionsForTelegram(entries);
}

function handleSupervisorLog(store: ITelegramStateStore, limit: number): string {
  const decisions = store.getRecentSupervisorDecisions(limit);

  if (decisions.length === 0) {
    return "🤖 *Supervisor Decision Log*\n\nNo decisions recorded yet.";
  }

  const ACTION_ICON: Record<string, string> = {
    dispatch: "🚀",
    verify: "🔍",
    redeploy: "🔄",
    "create-issue": "📝",
    "follow-up": "↩️",
    none: "⏸",
  };

  const lines: string[] = [`🤖 *Supervisor Decision Log* (last ${decisions.length})`, ``];

  for (const d of decisions) {
    const ts = d.created_at
      ? new Date(d.created_at).toISOString().replace("T", " ").slice(0, 16)
      : "—";
    const icon = ACTION_ICON[d.action] ?? "🤖";
    const agent = d.agent_name ? ` → \`${d.agent_name}\`` : "";
    const issueRef = d.issue_ref ? ` · ${d.issue_ref}` : "";
    lines.push(`${icon} *${d.action}*${agent}${issueRef}`);
    lines.push(`  _${ts}_ · outcome: ${d.outcome}`);
    lines.push(`  ${d.reason.slice(0, 150)}${d.reason.length > 150 ? "…" : ""}`);
    if (d.message) {
      lines.push(`  💬 ${d.message.slice(0, 100)}${d.message.length > 100 ? "…" : ""}`);
    }
    lines.push(``);
  }

  return lines.join("\n").trimEnd();
}

async function handleAgents(store: ITelegramStateStore): Promise<string> {
  const stats = store.getAgentStats();

  if (stats.length === 0) {
    return "🤖 *Agent Stats*\n\nNo agents have recorded tasks yet.";
  }

  const lines: string[] = [`🤖 *Agent Stats*`, ``];

  for (const s of stats) {
    const score =
      s.avg_score != null
        ? ` · score ${(s.avg_score * 100).toFixed(0)}%`
        : "";
    const failRate =
      s.total > 0
        ? ` (${((s.failed / s.total) * 100).toFixed(0)}% fail rate)`
        : "";

    // First-pass rate from verification_results (all-time)
    const vStats: VerificationStats | null = store.getVerificationStats(s.agent_name);
    let firstPassStr = "";
    if (vStats !== null && vStats.first_pass_rate !== null) {
      const fpr = (vStats.first_pass_rate * 100).toFixed(0);
      const warn = vStats.first_pass_rate < 0.70 ? " ⚠️" : "";
      firstPassStr = ` · first-pass ${fpr}%${warn}`;
    }

    lines.push(`*${s.agent_name}*${score}${firstPassStr}`);
    lines.push(`  Total: ${s.total} · Done: ${s.done} · Failed: ${s.failed}${failRate}`);
    lines.push(``);
  }

  return lines.join("\n").trimEnd();
}

/**
 * Build the weekly summary message (the /s command).
 *
 * Covers the past 7 days: task completion stats, quality scores, and —
 * when a ConflictStatsProvider is wired — a merge-conflict cost section
 * showing how many cycles were lost to unresolvable conflicts or stale branches.
 */
function handleWeeklySummary(
  store: ITelegramStateStore,
  conflictStatsProvider?: ConflictStatsProvider,
): string {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Grab a generous slice of recent completions and filter to the last 7 days
  const allRecent = store.getRecentCompleted(200);
  const weekTasks = allRecent.filter((t) => {
    const updated = new Date(t.updated_at);
    return updated >= sevenDaysAgo;
  });

  const done = weekTasks.filter((t) => t.status === "done").length;
  const failed = weekTasks.filter((t) => t.status === "failed").length;
  const total = weekTasks.length;

  const scores = weekTasks
    .map((t) => t.quality_score)
    .filter((s): s is number => typeof s === "number" && s > 0);
  const avgScore =
    scores.length > 0
      ? (scores.reduce((a, b) => a + b, 0) / scores.length) * 100
      : null;

  // Per-agent breakdown
  const agentStats = store.getAgentStats();

  const lines: string[] = [
    `📆 *Weekly Summary* (past 7 days)`,
    ``,
    `✅ Tasks completed: ${done}`,
    `❌ Tasks failed: ${failed}`,
    `📊 Total tasks: ${total}`,
  ];

  if (avgScore !== null) {
    lines.push(`⭐ Avg quality score: ${avgScore.toFixed(0)}%`);
  }

  if (agentStats.length > 0) {
    lines.push(``, `*Per-agent (all time)*`);
    for (const s of agentStats) {
      const score =
        s.avg_score != null ? ` · score ${(s.avg_score * 100).toFixed(0)}%` : "";
      lines.push(
        `  • \`${s.agent_name}\`: ${s.done}/${s.total} done${score}`,
      );
    }
  }

  // First-pass rates section (7d) — data from verification_results table (issue #120)
  const sevenDaysAgoIso = sevenDaysAgo.toISOString();
  const fpRates: Array<{ agent_id: string; rate: number }> = [];
  for (const s of agentStats) {
    const vStats: VerificationStats | null = store.getVerificationStats(
      s.agent_name,
      sevenDaysAgoIso,
    );
    if (vStats !== null && vStats.first_pass_rate !== null) {
      fpRates.push({ agent_id: s.agent_name, rate: vStats.first_pass_rate });
    }
  }
  if (fpRates.length > 0) {
    lines.push(``, `*First-pass rates (7d)*`);
    for (const fp of fpRates) {
      const pct = (fp.rate * 100).toFixed(0);
      const warn = fp.rate < 0.70 ? " ⚠️" : "";
      lines.push(`  • \`${fp.agent_id}\`: ${pct}%${warn}`);
    }
  }

  // Conflict cost section (issue #44) — only shown when PRReviewer is wired
  if (conflictStatsProvider) {
    const stats = conflictStatsProvider.getConflictStats();
    const cycleCost = stats.totalConflictEscalations + stats.totalAutoClosedConflictPRs;
    const totalEvents =
      stats.totalConflictEscalations +
      stats.totalAutoClosedConflictPRs +
      stats.totalStaleBranchNudges;

    if (totalEvents > 0) {
      lines.push(``, `*Merge Conflict Cost*`);

      if (cycleCost > 0) {
        lines.push(`⚠️ ${cycleCost} cycle${cycleCost === 1 ? "" : "s"} lost to merge conflicts this period`);
      }
      if (stats.totalConflictEscalations > 0) {
        lines.push(`  🚨 Conflict escalations (manual fix needed): ${stats.totalConflictEscalations}`);
      }
      if (stats.totalAutoClosedConflictPRs > 0) {
        lines.push(`  🗑️  PRs auto-closed (persistent conflicts): ${stats.totalAutoClosedConflictPRs}`);
      }
      if (stats.totalStaleBranchNudges > 0) {
        lines.push(`  📢 Stale-branch nudges issued: ${stats.totalStaleBranchNudges}`);
      }

      const conflictRepos = Object.entries(stats.perRepo)
        .filter(([, v]) => v.escalations > 0 || v.staleNudges > 0)
        .sort(
          (a, b) =>
            b[1].escalations + b[1].staleNudges - (a[1].escalations + a[1].staleNudges),
        );

      if (conflictRepos.length > 0) {
        lines.push(`  Conflict-prone repos this period:`);
        for (const [repo, counts] of conflictRepos) {
          const parts: string[] = [];
          if (counts.escalations > 0) parts.push(`${counts.escalations} escalation(s)`);
          if (counts.autoCloses > 0) parts.push(`${counts.autoCloses} auto-close(s)`);
          if (counts.staleNudges > 0) parts.push(`${counts.staleNudges} stale-nudge(s)`);
          lines.push(`    • \`${repo}\`: ${parts.join(", ")}`);
        }
      }
    } else {
      lines.push(``, `✨ No merge conflicts this period`);
    }
  }

  return lines.join("\n");
}

function handleSLA(store: ITelegramStateStore, args: string[]): string {
  const subcommand = args[0]?.toLowerCase().trim() || "status";

  if (subcommand === "status" || subcommand === "") {
    const thresholds = store.getSLAThresholds();
    if (thresholds.length === 0) {
      return [
        `🎯 *Quality SLA Thresholds*`,
        ``,
        `No SLA thresholds configured.`,
        ``,
        `Usage:`,
        `  \`/sla set <agent> <min-score> <window>\` — configure threshold`,
        `  \`/sla set claude-agent 0.75 5\` — alerts if agent's last 5 tasks avg < 0.75`,
        `  \`/sla clear <agent>\` — remove threshold`,
      ].join("\n");
    }

    // Check for breaches
    const breaches = (store as any).getAgentSLABreaches?.() ?? [];
    const lines: string[] = [
      `🎯 *Quality SLA Thresholds*`,
      ``,
      `*Configured:*`,
    ];

    for (const t of thresholds) {
      const isBreach = breaches.some((b: any) => b.agent_name === t.agent_name);
      const icon = isBreach ? `⚠️ ` : `✅ `;
      lines.push(`${icon}\`${t.agent_name}\`: min avg ${t.min_avg_score.toFixed(2)} over last ${t.window_tasks} tasks`);
    }

    if (breaches.length > 0) {
      lines.push(``, `*Current Breaches:*`);
      for (const b of breaches) {
        lines.push(`  🚨 \`${b.agent_name}\`: avg ${b.avg_score.toFixed(2)} < ${b.threshold_min.toFixed(2)}`);
      }
    } else {
      lines.push(``, `✨ All agents within SLA.`);
    }

    return lines.join("\n");
  }

  if (subcommand === "set") {
    const agentName = args[1]?.trim();
    const minScoreStr = args[2]?.trim();
    const windowStr = args[3]?.trim();

    if (!agentName || !minScoreStr || !windowStr) {
      return `⚠️ Usage: \`/sla set <agent> <min-score> <window>\`\nExample: \`/sla set my-agent 0.75 5\``;
    }

    const minScore = parseFloat(minScoreStr);
    const window = parseInt(windowStr, 10);

    if (Number.isNaN(minScore) || minScore < 0 || minScore > 1) {
      return `❌ min-score must be 0.0–1.0, got \`${minScoreStr}\``;
    }
    if (Number.isNaN(window) || window < 1 || window > 100) {
      return `❌ window must be 1–100 tasks, got \`${windowStr}\``;
    }

    store.setSLAThreshold(agentName, minScore, window);
    return [
      `✅ *SLA threshold set*`,
      ``,
      `Agent: \`${agentName}\``,
      `Threshold: avg quality ≥ ${minScore.toFixed(2)} over last ${window} tasks`,
      ``,
      `Breach alerts will fire in the next supervisor cycle if this threshold is violated.`,
    ].join("\n");
  }

  if (subcommand === "clear") {
    const agentName = args[1]?.trim();
    if (!agentName) {
      return `⚠️ Usage: \`/sla clear <agent>\``;
    }

    const thresholds = store.getSLAThresholds();
    const filtered = thresholds.filter((t) => t.agent_name !== agentName);
    if (filtered.length === thresholds.length) {
      return `❌ No SLA threshold found for \`${agentName}\``;
    }

    // Re-save without this agent's threshold
    store.setSystemFlag("quality_sla_thresholds", JSON.stringify(filtered));
    return `✅ *SLA threshold cleared* for \`${agentName}\`.`;
  }

  return `❌ Unknown SLA subcommand. Use \`/sla\`, \`/sla set <agent> <score> <window>\`, or \`/sla clear <agent>\`.`;
}

function handleQuality(store: ITelegramStateStore, windowTasks: number): string {
  const report: QualityHealthReport = store.getQualityHealthReport(windowTasks);

  const lines: string[] = [
    `📈 *Quality Health* (last ${report.window_tasks} tasks per agent)`,
    ``,
    report.system_avg_score !== null
      ? `System avg: ${(report.system_avg_score * 100).toFixed(0)}% · ${report.scored_task_count} scored / ${report.total_task_count} total`
      : `System avg: n/a · ${report.total_task_count} total tasks`,
    `Null scores: ${report.null_score_count} (${report.total_task_count > 0 ? ((report.null_score_count / report.total_task_count) * 100).toFixed(0) : "0"}%)`,
    `Below threshold (< ${(report.threshold * 100).toFixed(0)}%): ${report.below_threshold_count}${report.scored_task_count > 0 ? ` (${((report.below_threshold_count / report.scored_task_count) * 100).toFixed(0)}% of scored)` : ""}`,
    ``,
  ];

  if (report.per_agent.length === 0) {
    lines.push("No quality scores recorded yet.");
    return lines.join("\n");
  }

  const agentCol = Math.max(10, ...report.per_agent.map((row) => row.agent_name.length));
  const tasksCol = Math.max(5, ...report.per_agent.map((row) => String(row.task_count).length));
  const avgCol = 5;
  const nullCol = 5;
  const belowCol = 5;

  const pad = (value: string, width: number): string => value.padEnd(width, " ");
  const pct = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);
  const trend = (row: QualityHealthReport["per_agent"][number]): string => {
    if (!row.trending_downward || row.trend_delta === null) return "•";
    return `↘ ${(row.trend_delta * 100).toFixed(0)}%`;
  };

  lines.push(`\`${pad("Agent", agentCol)}  ${pad("Tasks", tasksCol)}  ${pad("Avg", avgCol)}  ${pad("Null", nullCol)}  ${pad("Below", belowCol)}  Trend\``);
  for (const row of report.per_agent) {
    lines.push(
      `\`${pad(row.agent_name, agentCol)}  ${pad(String(row.task_count), tasksCol)}  ${pad(pct(row.rolling_avg_score), avgCol)}  ${pad(`${(row.null_score_rate * 100).toFixed(0)}%`, nullCol)}  ${pad(row.below_threshold_rate === null ? "n/a" : `${(row.below_threshold_rate * 100).toFixed(0)}%`, belowCol)}  ${trend(row)}\``,
    );
  }

  const downward = report.per_agent.filter((row) => row.trending_downward);
  if (downward.length > 0) {
    lines.push(``);
    lines.push(`*Trending downward:*`);
    for (const row of downward) {
      const delta = row.trend_delta ?? 0;
      const recent = row.recent_avg_score !== null ? `${(row.recent_avg_score * 100).toFixed(0)}%` : "n/a";
      const previous = row.previous_avg_score !== null ? `${(row.previous_avg_score * 100).toFixed(0)}%` : "n/a";
      lines.push(`  • \`${row.agent_name}\`: ${previous} → ${recent} (${delta > 0 ? "+" : ""}${(delta * 100).toFixed(0)}%)`);
    }
  }

  return lines.join("\n");
}

// ── /quality tasks handler ────────────────────────────────────────────────

/**
 * Per-task quality score listing.
 * Shows individual tasks with their quality_score, verification_status,
 * agent, and a truncated title — giving operators visibility into
 * quality trends at the task level (issue #212).
 */
function handleQualityTasks(store: ITelegramStateStore, limit: number): string {
  const tasks = store.getRecentVerifiedTasks(limit);

  const nullCount = store.getApprovedTasksWithNullScoresCount();

  const lines: string[] = [
    `📋 *Per-Task Quality Scores* (latest ${limit})`,
    ``,
  ];

  if (nullCount > 0) {
    lines.push(`⚠️ ${nullCount} approved task(s) still missing quality\_score — will be backfilled next cycle.`);
    lines.push(``);
  }

  if (tasks.length === 0) {
    lines.push("No verified tasks with quality scores yet.");
    return lines.join("\n");
  }

  for (const task of tasks) {
    const score = task.quality_score !== null && task.quality_score !== undefined
      ? `${(task.quality_score * 100).toFixed(0)}%`
      : "n/a";
    const status = task.verification_status === "approved" ? "✅" : "❌";
    const agent = task.agent_name ?? "unknown";
    const shortId = task.id.slice(0, 8);
    const title = task.title.length > 50 ? task.title.slice(0, 47) + "..." : task.title;

    // Bypass badge for sub-0.60 approved tasks.
    const isSubFloorApproved =
      task.verification_status === "approved" &&
      task.quality_score !== null &&
      task.quality_score !== undefined &&
      task.quality_score < 0.60;
    const bypassBadge = isSubFloorApproved && task.bypass_reason
      ? ` ${task.bypass_reason === "operator_override" ? "🔓" : "🏚️"}`
      : "";

    lines.push(`${status} \`${shortId}\` ${score}${bypassBadge} · \`${agent}\` · ${title}`);
  }

  // Summary stats
  const scores = tasks
    .map((t) => t.quality_score)
    .filter((s): s is number => typeof s === "number");
  if (scores.length > 0) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    lines.push(``);
    lines.push(`*Summary:* avg ${(avg * 100).toFixed(0)}% · min ${(min * 100).toFixed(0)}% · max ${(max * 100).toFixed(0)}% · ${scores.length} scored`);
  }

  return lines.join("\n");
}

// ── /calibration handler ─────────────────────────────────────────────────

const CALIBRATION_MERGE_RATE_ALERT = 0.70;
const CALIBRATION_MIN_SAMPLE = 30;

/**
 * Renders a compact merge-rate table grouped by verifier and task type.
 *
 * Format per row:
 *   *agent / task_type*
 *     0.5: ~43% (n=8)  0.6: 71% ⚠️ (n=45)  0.7: 85% (n=32)
 *
 * Legend:
 *   ⚠️  merge_rate < 0.70 (calibration alert threshold)
 *   ~   n < 30 (insufficient data — rate shown for reference only)
 */
function handleCalibrationTable(store: ITelegramStateStore): string {
  // Prefer getCalibrationTable() (no min-sample filter) when available;
  // fall back to getCalibrationData() (min 3 records) on older store versions.
  const storeAsAny = store as unknown as Record<string, unknown>;
  const rows: ScoreCalibrationRow[] =
    typeof storeAsAny.getCalibrationTable === "function"
      ? (storeAsAny.getCalibrationTable as () => ScoreCalibrationRow[])()
      : store.getCalibrationData();

  if (rows.length === 0) {
    return [
      "📊 *Calibration Table*",
      "",
      "No outcome data recorded yet\\. Merge\\/rejection events will populate this table\\.",
      "_(Use /verification\\-calibration for score distribution histograms)_",
    ].join("\n");
  }

  // Collect all score buckets present in the data (sorted ascending).
  const allBuckets = [...new Set(rows.map((r) => r.score_bucket))].sort((a, b) => a - b);

  // Group rows by (agent_name, task_type).
  const groupMap = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.agent_name}\x00${row.task_type}`;
    const list = groupMap.get(key) ?? [];
    list.push(row);
    groupMap.set(key, list);
  }

  const lines: string[] = [];
  lines.push("📊 *Calibration Table* — verifier × score\\-bucket → merge rate");
  lines.push(
    `_⚠️ = merge\\_rate < ${(CALIBRATION_MERGE_RATE_ALERT * 100).toFixed(0)}% \\| ~ = n<${CALIBRATION_MIN_SAMPLE} \\(insufficient\\)_`,
  );
  lines.push(
    `_Buckets: ${allBuckets.map((b) => b.toFixed(1)).join(", ")}_`,
  );

  // Tally alerts for the footer.
  let alertCells = 0;
  let insufficientCells = 0;

  for (const [key, cellRows] of groupMap) {
    const [agentName, taskType] = key.split("\x00");
    lines.push("");
    lines.push(`*${agentName}* / ${taskType}`);

    const bucketParts: string[] = [];
    for (const bucket of allBuckets) {
      const cell = cellRows.find((r) => r.score_bucket === bucket);
      if (!cell) continue; // bucket not present for this agent/task combination

      const bucketLabel = bucket.toFixed(1);
      if (cell.total_count < CALIBRATION_MIN_SAMPLE) {
        // Insufficient data — show tilde-prefixed rate for reference.
        const ratePct = (cell.actual_merge_rate * 100).toFixed(0);
        bucketParts.push(`  ${bucketLabel}: ~${ratePct}% (n=${cell.total_count})`);
        insufficientCells++;
      } else {
        const ratePct = (cell.actual_merge_rate * 100).toFixed(0);
        const alert = cell.actual_merge_rate < CALIBRATION_MERGE_RATE_ALERT ? " ⚠️" : "";
        if (alert) alertCells++;
        bucketParts.push(`  ${bucketLabel}: ${ratePct}%${alert} (n=${cell.total_count})`);
      }
    }
    lines.push(bucketParts.join("\n"));
  }

  lines.push("");
  const summaryParts: string[] = [];
  if (alertCells > 0)
    summaryParts.push(`⚠️ ${alertCells} bucket${alertCells === 1 ? "" : "s"} below ${(CALIBRATION_MERGE_RATE_ALERT * 100).toFixed(0)}% merge rate`);
  if (insufficientCells > 0)
    summaryParts.push(`~ ${insufficientCells} bucket${insufficientCells === 1 ? "" : "s"} with insufficient data \\(n<${CALIBRATION_MIN_SAMPLE}\\)`);
  if (summaryParts.length > 0) {
    lines.push(summaryParts.join(" \\| "));
  } else {
    lines.push("✅ All buckets have sufficient data and are within threshold\\.");
  }

  return lines.join("\n");
}

// ── /token-stats handler ──────────────────────────────────────────────────

function handleTokenStats(store: ITelegramStateStore, sinceHours: number): string {
  const rows: LlmTokenStats[] = store.getTokenStats(sinceHours);

  const windowDesc =
    sinceHours >= 720
      ? `${Math.round(sinceHours / 720)} month(s)`
      : sinceHours >= 24
        ? `${Math.round(sinceHours / 24)} day(s)`
        : `${sinceHours}h`;

  if (rows.length === 0) {
    return `📊 *Token Stats* (last ${windowDesc})\n\nNo LLM call events recorded yet.`;
  }

  const totalInput = rows.reduce((s, r) => s + r.total_input_tokens, 0);
  const totalOutput = rows.reduce((s, r) => s + r.total_output_tokens, 0);
  const totalCacheRead = rows.reduce((s, r) => s + r.total_cache_read_tokens, 0);
  const totalCalls = rows.reduce((s, r) => s + r.call_count, 0);
  const cacheHitRate = totalInput > 0 ? ((totalCacheRead / totalInput) * 100).toFixed(1) : "0.0";

  const header = [
    `📊 *Token Stats* (last ${windowDesc})`,
    ``,
    `*Fleet totals* — ${totalCalls} calls`,
    `  Input:       ${totalInput.toLocaleString()} tokens`,
    `  Output:      ${totalOutput.toLocaleString()} tokens`,
    `  Cache reads: ${totalCacheRead.toLocaleString()} tokens (${cacheHitRate}% of input)`,
    ``,
    `*By call type:*`,
  ];

  const lines: string[] = [];
  for (const r of rows) {
    const avgMs = r.avg_duration_ms !== null ? `${Math.round(r.avg_duration_ms)}ms` : "n/a";
    const cacheRead = r.total_cache_read_tokens > 0 ? ` cache: ${r.total_cache_read_tokens.toLocaleString()}` : "";
    lines.push(
      `\`${r.call_type}\` — ${r.call_count} calls`,
      `  in: ${r.total_input_tokens.toLocaleString()}  out: ${r.total_output_tokens.toLocaleString()}${cacheRead}  avg: ${avgMs}`,
    );
  }

  return [...header, ...lines].join("\n");
}

// ── /first-pass-rate handler ──────────────────────────────────────────────

/**
 * Format the first-pass rate widget as a Telegram message.
 *
 * Sections:
 *  1. Header with current-month rate and goal progress bar
 *  2. 30-day (4-week) rolling trend — one line per week
 *  3. Drill-down: per-(agent, task_type) laggard panel
 *
 * @param store     - State store that implements `getFirstPassRateWidget`.
 * @param weeksBack - How many weeks of trend data to display.
 */
function handleFirstPassRate(store: ITelegramStateStore, weeksBack: number): string {
  const widget: FirstPassRateWidget = store.getFirstPassRateWidget(weeksBack);

  const lines: string[] = [];

  // ── Header ─────────────────────────────────────────────────────────────
  const goalPct = (widget.goal * 100).toFixed(0);
  lines.push(`📈 *First-Pass Verification Rate*`);
  lines.push(``);

  const monthLabel = new Date(widget.month_start).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  if (widget.current_month_rate === null) {
    lines.push(`📅 *${monthLabel}:* No data yet`);
    lines.push(`🎯 Goal: ${goalPct}%`);
  } else {
    const ratePct = (widget.current_month_rate * 100).toFixed(1);
    const goalMet = widget.goal_met === true;
    const statusIcon = goalMet ? "✅" : "⚠️";

    // ASCII progress bar (20 chars wide)
    const filled = Math.round(widget.current_month_rate * 20);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    const goalPos = Math.round(widget.goal * 20);
    // Mark goal position in bar label
    const barWithGoal = bar.slice(0, goalPos) + "|" + bar.slice(goalPos + 1);

    lines.push(`📅 *${monthLabel}* (${widget.current_month_total} verifications)`);
    lines.push(`${statusIcon} Rate: *${ratePct}%* (goal: ${goalPct}%)`);
    lines.push(`\`[${barWithGoal}]\``);
    if (!goalMet) {
      const gap = ((widget.goal - widget.current_month_rate) * 100).toFixed(1);
      lines.push(`⬆️ ${gap}pp below goal`);
    }
  }

  // ── Weekly trend ─────────────────────────────────────────────────────
  lines.push(``);
  lines.push(`*Rolling Trend (${weeksBack}w)*`);

  if (widget.weekly_trend.every((p) => p.total === 0)) {
    lines.push(`  No verification data in this window.`);
  } else {
    for (const point of widget.weekly_trend) {
      const weekLabel = point.week_start; // YYYY-MM-DD
      if (point.total === 0) {
        lines.push(`  ${weekLabel}: — (no data)`);
      } else {
        const pct = ((point.rate ?? 0) * 100).toFixed(0);
        const warn = (point.rate ?? 0) < widget.goal ? " ⚠️" : " ✅";
        lines.push(`  ${weekLabel}: *${pct}%* (${point.first_pass_count}/${point.total})${warn}`);
      }
    }
  }

  // ── Drill-down ───────────────────────────────────────────────────────
  if (widget.drill_down.length > 0) {
    lines.push(``);
    lines.push(`*Drill-down (this month)*`);

    // Sort: lowest rate first (laggards at top)
    const sorted = [...widget.drill_down].sort((a, b) => {
      const ra = a.rate ?? 1;
      const rb = b.rate ?? 1;
      return ra - rb;
    });

    for (const row of sorted) {
      if (row.total === 0) continue;
      const pct = ((row.rate ?? 0) * 100).toFixed(0);
      const warn = (row.rate ?? 0) < widget.goal ? " ⚠️" : "";
      lines.push(
        `  \`${row.agent_id}\` [${row.task_type}]: *${pct}%* (${row.first_pass_count}/${row.total})${warn}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Handle the `/score <task-id>` command.
 *
 * Looks up a task by its full ULID or by a short prefix (minimum 8 chars).
 * Returns a formatted summary of:
 *   - Overall quality score and verification status
 *   - Agent name and task type
 *   - Source reference (PR/issue link when available)
 *   - Whether the hard-block threshold (< 0.50) was evaluated
 *   - Natural-language quality explanation (when score < 0.80)
 *   - Verification notes excerpt, which may include per-dimension breakdown
 *
 * Handles unknown IDs and tasks that have not yet been verified.
 */
function handleScore(store: ITelegramStateStore, rawId: string): string {
  // Try exact lookup first; fall back to prefix scan for short IDs.
  let task = store.getTask(rawId);

  if (!task && rawId.length >= 8) {
    // Prefix search: scan recent tasks and match by ID prefix.
    const allTasks = store.listTasks({ limit: 500 });
    task = allTasks.find((t) => t.id.startsWith(rawId)) ?? null;
  }

  if (!task) {
    return [
      `❓ *Task not found*`,
      ``,
      `No task with ID \`${rawId}\` found in state.db.`,
      `Try a longer prefix or paste the full ULID.`,
    ].join("\n");
  }

  // Fetch the latest verification record for hard-block metadata.
  const verRecord = store.getLatestVerificationRecord(task.id);

  // ── Header ──────────────────────────────────────────────────────────────
  const lines: string[] = [
    `🔍 *Task Score*`,
    ``,
    `*Title:* ${task.title.slice(0, 100)}`,
    `*ID:* \`${task.id}\``,
    `*Agent:* ${task.agent_name ? `\`${task.agent_name}\`` : "_unassigned_"}`,
    `*Type:* ${task.task_type}`,
  ];

  if (task.source_ref) {
    lines.push(`*Ref:* \`${task.source_ref}\``);
  }

  lines.push(``);

  // ── Verification status ─────────────────────────────────────────────────
  const vs = task.verification_status;
  const qs = task.quality_score;

  if (!vs && qs == null) {
    lines.push(`📋 *Verification:* not yet verified`);
  } else {
    // "hard_rejected" is not a VerificationStatus in this repo's type — hard blocks
    // are stored as verification_status = "rejected" with blocked_reason = "hard_block_sub50"
    // in the verification_results table.  We detect hard blocks via verRecord below.
    const isHardBlock = verRecord?.blocked_reason === "hard_block_sub50";

    const statusIcon =
      vs === "approved" ? "✅" :
      vs === "rejected" && isHardBlock ? "⛔" :
      vs === "rejected" ? "❌" :
      vs === "pending" ? "⏳" :
      "❓";

    const statusLabel =
      vs === "rejected" && isHardBlock ? "rejected (hard block)" : (vs ?? "unknown");

    lines.push(`${statusIcon} *Verification:* ${statusLabel}`);

    if (qs != null) {
      const pct = (qs * 100).toFixed(0);
      const scoreBar = buildScoreBar(qs);
      lines.push(`📊 *Score:* ${qs.toFixed(2)} (${pct}%) ${scoreBar}`);
    }

    // Hard-block indicator (already captured in isHardBlock above).
    if (isHardBlock) {
      lines.push(`🚧 *Hard-block:* triggered — score below 0.50 unconditional rejection threshold`);
    }

    // Bypass reason badge — shown when a sub-0.60 task was approved despite the floor.
    const bypassReason = task.bypass_reason ?? verRecord?.bypass_reason ?? null;
    if (bypassReason) {
      const bypassIcon = bypassReason === "operator_override" ? "🔓" : "🏚️";
      lines.push(`${bypassIcon} *Bypass:* \`${bypassReason}\``);
    }
  }

  // ── Quality explanation (natural language, sub-0.80) ────────────────────
  if (task.quality_explanation) {
    lines.push(``, `*Quality explanation:*`);
    lines.push(task.quality_explanation.slice(0, 400));
  }

  // ── Verification notes excerpt (may contain dimension breakdown) ─────────
  if (task.verification_notes) {
    const notes = task.verification_notes.trim();
    const hasDimensions = notes.includes("Quality Dimensions") || notes.includes("Correctness");
    if (hasDimensions) {
      // Extract and display only the dimension breakdown section.
      const dimStart = notes.indexOf("## Quality Dimensions");
      const excerpt =
        dimStart >= 0
          ? notes.slice(dimStart, dimStart + 500).trim()
          : notes.slice(0, 500).trim();
      lines.push(``, `*Dimensions:*`);
      lines.push(`\`\`\``);
      // Strip markdown bold markers for cleaner Telegram display.
      lines.push(excerpt.replace(/\*\*/g, "").slice(0, 450));
      lines.push(`\`\`\``);
    } else if (notes.length > 0) {
      lines.push(``, `*Notes:* ${notes.slice(0, 300)}`);
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push(``, `_Use the dashboard for full detail: /tasks/${task.id}_`);

  return lines.join("\n");
}

/**
 * Build a compact ASCII progress bar for a score value (0–1).
 * Returns something like: ▓▓▓▓▓▓░░░░ (10 chars)
 */
function buildScoreBar(score: number): string {
  const filled = Math.round(score * 10);
  const empty = 10 - filled;
  return "▓".repeat(filled) + "░".repeat(empty);
}

/**
 * Handle the /backfill-scores command.
 * Queries for approved tasks with null quality_score and retroactively scores them.
 *
 * This command is useful for backfilling scores on approved tasks that never got
 * quality_score populated (typically due to historical bugs or missing integration points).
 *
 * If a Verifier is provided, runs verification immediately. Otherwise, informs operator
 * that verification will be picked up by the next daemon cycle.
 *
 * Usage: `/backfill-scores [limit]`
 * - limit: optional batch size (1-20, default 5)
 */
async function handleBackfillScores(
  store: ITelegramStateStore,
  verifier: Verifier | undefined,
  limit: number,
): Promise<string> {
  // Cover both approved AND rejected tasks with null scores (issue #229).
  const unscorredCount = store.getVerifiedTasksWithNullScoresCount();

  if (unscorredCount === 0) {
    return [
      `✅ *No backfill needed*`,
      ``,
      `All verified tasks (approved and rejected) have quality scores. Dashboard quality trend charts are current.`,
    ].join("\n");
  }

  const tasksToBackfill = store.getVerifiedTasksWithNullScores(limit);

  if (tasksToBackfill.length === 0) {
    return [
      `ℹ️ *No tasks in this batch*`,
      ``,
      `Found ${unscorredCount} verified tasks needing scores, but none were returned in query.`,
    ].join("\n");
  }

  // If no verifier is available, just identify tasks and let daemon handle it
  if (!verifier) {
    const lines: string[] = [
      `🔄 *Backfill Scores — Queued for Verification*`,
      ``,
      `*Found: ${unscorredCount} tasks total | Showing: ${tasksToBackfill.length} in this batch*`,
      ``,
      `**Tasks identified for backfill:**`,
    ];

    for (const task of tasksToBackfill) {
      const ref = task.source_ref ? ` (\`${task.source_ref}\`)` : "";
      lines.push(`  • \`${task.id.slice(0, 8)}\` — ${task.title.slice(0, 60)}${ref}`);
    }

    lines.push(
      ``,
      `**Status:** Orchestrator daemon will score these tasks on its next verification cycle.`,
      `Once scored, dashboard quality trends will reflect the backfilled data.`,
    );

    return lines.join("\n");
  }

  // Verifier is available — run verification immediately
  const results = {
    successful: 0,
    failed: 0,
    errors: [] as string[],
  };

  for (const task of tasksToBackfill) {
    try {
      const verResult = await verifier.verify(task.id);

      // Preserve existing rejection for already-rejected tasks — we only need
      // to fill in the numeric score, not reconsider the decision.
      const alreadyRejected = task.verification_status === "rejected";
      const effectiveStatus: "approved" | "rejected" = alreadyRejected
        ? "rejected"
        : verResult.approved
          ? "approved"
          : "rejected";

      // Update task with verification results
      store.updateTask(task.id, {
        verification_status: effectiveStatus,
        quality_score: verResult.score,
        verification_notes: verResult.notes,
        quality_explanation: verResult.explanation ?? null,
      });

      // Insert to verification_results audit log
      store.insertVerificationResult({
        task_id: task.id,
        score: verResult.score,
        first_pass: 1, // Backfill is always first (and only) pass
        rejection_reason: effectiveStatus !== "approved" ? (verResult.revision ?? null) : null,
        blocked_reason:
          verResult.blockedReason === "hard_block_sub50"
            ? "hard_block_sub50"
            : verResult.blockedReason === "low_score_sub60"
              ? "low_score_sub60"
              : null,
        approval_rationale: verResult.approvalRationale ?? null,
        threshold: 0.80, // Standard threshold
        agent_id: task.agent_name ?? "unknown",
        timestamp: new Date().toISOString(),
      });

      results.successful++;
    } catch (err) {
      results.failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      results.errors.push(`${task.id.slice(0, 8)}: ${errMsg}`);
      log.error("Backfill verification failed", { taskId: task.id, error: errMsg });
    }
  }

  const lines: string[] = [
    `✅ *Backfill Scores — Complete*`,
    ``,
    `*Batch: ${tasksToBackfill.length} | Total remaining: ${unscorredCount - results.successful}*`,
    ``,
    `**Results:**`,
    `  ✓ Scored: ${results.successful}`,
  ];

  if (results.failed > 0) {
    lines.push(`  ✗ Failed: ${results.failed}`);
    if (results.errors.length > 0) {
      lines.push(``, `**Errors:**`);
      for (const err of results.errors.slice(0, 5)) {
        lines.push(`  • ${err}`);
      }
      if (results.errors.length > 5) {
        lines.push(`  • ... and ${results.errors.length - 5} more`);
      }
    }
  }

  lines.push(
    ``,
    `**Persistence:** Scores saved to \`verification_results\` audit log.`,
    `Dashboard quality trends will now reflect backfilled data.`,
  );

  return lines.join("\n");
}

// ── Reconciliation feed handler ───────────────────────────────────────────

function statusEmoji(status: string): string {
  if (status === "success") return "✅";
  if (status === "partial") return "🟡";
  if (status === "failed") return "❌";
  if (status === "escalated") return "🚨";
  return "❓";
}

async function handleReconcile(
  store: ITelegramStateStore,
  sinceHours?: number,
): Promise<string> {
  const rows: ReconciliationLastPerRepo[] = store.getLastReconciliationPerRepo();

  const headerParts = ["🔄 *Cross-Repo Reconciliation Status*"];
  if (sinceHours != null) {
    headerParts.push(`_(last ${sinceHours}h)_`);
  }
  const lines: string[] = [headerParts.join(" "), ``];

  if (rows.length === 0) {
    lines.push(`_No reconciliation events recorded yet._`);
    lines.push(``, `The reconciliation events table exists but is empty.`);
    lines.push(`Events are written by the dashboard agent when it runs a reconciliation cycle.`);
    return lines.join("\n");
  }

  // Filter by sinceHours if requested
  const filtered =
    sinceHours != null
      ? rows.filter((r) => {
          const cutoff = new Date(Date.now() - sinceHours * 3600_000).toISOString();
          return r.created_at >= cutoff;
        })
      : rows;

  if (filtered.length === 0) {
    lines.push(`_No reconciliation events in the last ${sinceHours}h._`);
    const lastRow = rows[0];
    if (lastRow) {
      const ago = formatAgo(lastRow.created_at);
      lines.push(``, `Last event: ${statusEmoji(lastRow.status)} \`${lastRow.repo}\` — ${ago}`);
    }
    return lines.join("\n");
  }

  for (const row of filtered) {
    const emoji = statusEmoji(row.status);
    const ago = formatAgo(row.created_at);
    const repoShort = row.repo.length > 30 ? `...${row.repo.slice(-28)}` : row.repo;
    lines.push(`${emoji} \`${repoShort}\``);
    lines.push(`   Status: *${row.status.toUpperCase()}* · ${ago}`);
    if (row.triggered_by) {
      lines.push(`   Triggered by: ${row.triggered_by}`);
    }
    if (row.columns_fixed.length > 0) {
      const colList = row.columns_fixed.slice(0, 4).join(", ");
      const extra = row.columns_fixed.length > 4 ? ` +${row.columns_fixed.length - 4} more` : "";
      lines.push(`   Cols fixed: \`${colList}${extra}\``);
    }
    lines.push(``);
  }

  const degraded = filtered.filter((r) => r.status === "failed" || r.status === "escalated");
  if (degraded.length > 0) {
    lines.push(`⚠️ *${degraded.length} repo(s) have failed/escalated reconciliation.*`);
    lines.push(`Check the dashboard reconciliation view for details.`);
  } else {
    lines.push(`✅ All repos reconciled successfully.`);
  }

  lines.push(``, `_Use \`/reconcile <hours>\` to filter by time window (e.g. \`/reconcile 1\` for last hour)._`);

  return lines.join("\n");
}

/** Format a ISO-8601 timestamp as a human-readable "Xm ago" or "Xh ago" string. */
function formatAgo(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Operator review queue handlers ───────────────────────────────────────

/** Risk tier badge for the /review-queue display. */
function riskTier(score: number | null | undefined): string {
  if (score == null) return "❓ unknown";
  if (score < 0.50) return "🔴 critical";
  return "🟡 low";
}

/**
 * Parse per-dimension scores from a verification_notes string.
 *
 * The verifier writes notes in this format:
 *   ## Quality Dimensions Breakdown
 *   - **Correctness**: 40/100 ✗ (logic, no bugs)
 *   - **Completeness**: 50/100 ✗ (requirements met)
 *   - **Test Coverage**: 35/100 ✗ (edge cases covered)
 *   - **Code Quality**: 45/100 ✗ (clarity, documentation)
 *
 * Research/housekeeping tasks use alternate labels ("Evidence Coverage",
 * "Schema Compliance") which are also extracted and returned under their
 * canonical keys.
 *
 * Returns null when the notes string contains no recognisable dimension data.
 */
export interface ParsedDimensions {
  correctness: number | null;
  completeness: number | null;
  test_coverage: number | null;
  code_quality: number | null;
}

export function parseDimensionsFromNotes(notes: string | null | undefined): ParsedDimensions | null {
  if (!notes) return null;

  // Match any bolded label followed by a score like "40/100"
  const pattern = /\*\*([\w\s]+)\*\*:\s+(\d+)\/100/g;
  const found = new Map<string, number>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(notes)) !== null) {
    const label = match[1]!.trim().toLowerCase();
    const score = parseInt(match[2]!, 10) / 100;
    found.set(label, score);
  }

  if (found.size === 0) return null;

  return {
    correctness: found.get("correctness") ?? null,
    completeness: found.get("completeness") ?? null,
    // Both "test coverage" and "evidence coverage" map to test_coverage
    test_coverage: found.get("test coverage") ?? found.get("evidence coverage") ?? null,
    // Both "code quality" and "schema compliance" map to code_quality
    code_quality: found.get("code quality") ?? found.get("schema compliance") ?? null,
  };
}

/**
 * Extract a GitHub PR URL from a task's source_ref.
 *
 * Accepted formats:
 *   - "owner/repo/pull/NNN"   → https://github.com/owner/repo/pull/NNN
 *   - "owner/repo#NNN"        → null (issue ref, not a PR)
 *   - null / undefined        → null
 */
export function extractPrUrl(task: Task): string | null {
  const ref = task.source_ref;
  if (!ref) return null;

  // Pattern: owner/repo/pull/NNN
  const pullMatch = /^([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(ref);
  if (pullMatch) {
    return `https://github.com/${pullMatch[1]}/pull/${pullMatch[2]}`;
  }

  return null;
}

/**
 * Build a one-sentence risk summary for a held task.
 *
 * Priority:
 *   1. First sentence of task.quality_explanation (generated by the LLM verifier)
 *   2. Derived summary from score + weakest dimension
 *   3. Generic fallback based on score tier
 */
export function buildRiskSummary(task: Task): string {
  // 1. Use quality_explanation if available (LLM-generated during verification)
  if (task.quality_explanation) {
    // Take the first sentence only (up to 150 chars)
    const firstSentence = task.quality_explanation.split(/(?<=[.!?])\s+/)[0] ?? task.quality_explanation;
    return firstSentence.slice(0, 150);
  }

  // 2. Derive from dimensions in verification_notes
  const dims = parseDimensionsFromNotes(task.verification_notes);
  if (dims) {
    const entries = [
      { name: "correctness", score: dims.correctness },
      { name: "completeness", score: dims.completeness },
      { name: "test coverage", score: dims.test_coverage },
      { name: "code quality", score: dims.code_quality },
    ].filter((e): e is { name: string; score: number } => e.score !== null);

    if (entries.length > 0) {
      const weakest = entries.reduce((a, b) => (a.score <= b.score ? a : b));
      const overall = task.quality_score != null ? `Score ${task.quality_score.toFixed(2)}` : "Low score";
      return `${overall} — ${weakest.name} is the weakest dimension (${(weakest.score * 100).toFixed(0)}/100).`;
    }
  }

  // 3. Generic fallback
  const score = task.quality_score ?? 0;
  if (score < 0.50) {
    return "Critical quality failure: score below 0.50 unconditional rejection threshold.";
  }
  return `Score ${score.toFixed(2)} is below the 0.60 quality floor — requires operator judgement.`;
}

/**
 * Format a single held task as a rich context card for the /review-queue display.
 *
 * Includes: task title, short ID, score + risk tier, agent, PR link (when
 * available), per-dimension score breakdown, and a one-sentence risk summary.
 * This gives operators enough context to approve or reject without opening
 * the dashboard or GitHub.
 */
export function formatRichTaskCard(task: Task): string[] {
  const lines: string[] = [];
  const shortId = task.id.slice(0, 8);
  const score = task.quality_score != null ? task.quality_score.toFixed(2) : "n/a";
  const tier = riskTier(task.quality_score);
  const agent = task.agent_name ?? "unassigned";

  // ── Header line ────────────────────────────────────────────────────────
  lines.push(`${tier} \`${shortId}\` — *${task.title.slice(0, 60)}*`);
  lines.push(`  Score: ${score} · Agent: \`${agent}\``);

  // ── PR link (when derivable from source_ref) ────────────────────────
  const prUrl = extractPrUrl(task);
  if (prUrl) {
    lines.push(`  PR: ${prUrl}`);
  } else if (task.source_ref) {
    lines.push(`  Ref: \`${task.source_ref}\``);
  }

  // ── Per-dimension score breakdown ───────────────────────────────────
  const dims = parseDimensionsFromNotes(task.verification_notes);
  if (dims) {
    const fmt = (v: number | null) => v != null ? `${(v * 100).toFixed(0)}/100` : "n/a";
    const dim = (label: string, v: number | null) => {
      const bar = v != null ? (v >= 0.80 ? "✓" : "✗") : "?";
      return `${bar} ${label}: ${fmt(v)}`;
    };
    lines.push(`  \`\`\``);
    lines.push(`  ${dim("Correctness", dims.correctness)}`);
    lines.push(`  ${dim("Completeness", dims.completeness)}`);
    lines.push(`  ${dim("Test coverage", dims.test_coverage)}`);
    lines.push(`  ${dim("Code quality", dims.code_quality)}`);
    lines.push(`  \`\`\``);
  }

  // ── Risk summary ────────────────────────────────────────────────────
  const summary = buildRiskSummary(task);
  lines.push(`  ⚠️ _${summary}_`);

  // ── Action hints ────────────────────────────────────────────────────
  lines.push(`  → \`/approve ${shortId}\` or \`/reject ${shortId}\``);

  return lines;
}

function handleReviewQueue(store: ITelegramStateStore): string {
  const tasks = store.getTasksInOperatorReview();

  if (tasks.length === 0) {
    return [
      `✅ *Operator Review Queue — Empty*`,
      ``,
      `No tasks are currently held for operator review.`,
      `Tasks scoring below 0.60 will appear here when held by the quality floor.`,
    ].join("\n");
  }

  const lines: string[] = [
    `🔍 *Operator Review Queue — ${tasks.length} task${tasks.length === 1 ? "" : "s"} pending*`,
    ``,
    `Use \`/approve <id> [note]\` or \`/reject <id> [note]\` to act.`,
    ``,
  ];

  for (const task of tasks) {
    lines.push(...formatRichTaskCard(task));
    lines.push(``);
  }

  const criticalCount = tasks.filter((t) => (t.quality_score ?? 0) < 0.50).length;
  const lowCount = tasks.length - criticalCount;

  lines.push(`_${criticalCount} critical (< 0.50) · ${lowCount} low (0.50–0.59)_`);

  return lines.join("\n");
}

function handleOperatorOverride(
  store: ITelegramStateStore,
  taskIdPrefix: string,
  decision: "approve" | "reject",
  note: string,
): string {
  // Support short ID prefix lookup: find the full task ID
  const tasks = store.getTasksInOperatorReview();
  const match = tasks.find(
    (t) => t.id === taskIdPrefix || t.id.startsWith(taskIdPrefix),
  );

  if (!match) {
    // Check if a task exists at all (not just in review queue)
    return [
      `❌ No held task found matching \`${taskIdPrefix}\`.`,
      ``,
      `Only tasks in \`needs_operator_review\` status can be acted on.`,
      `Run \`/review-queue\` to see current held tasks.`,
    ].join("\n");
  }

  const applied = store.operatorOverride(match.id, decision, note);
  if (!applied) {
    return `❌ Could not apply override to task \`${match.id.slice(0, 8)}\`. Task may no longer be in review queue.`;
  }

  const emoji = decision === "approve" ? "✅" : "🚫";
  const label = decision === "approve" ? "Approved" : "Rejected";
  const score = match.quality_score != null ? match.quality_score.toFixed(2) : "n/a";

  return [
    `${emoji} *Operator Override — ${label}*`,
    ``,
    `Task: \`${match.id.slice(0, 8)}\` — ${match.title.slice(0, 50)}`,
    `Score: ${score} · Agent: ${match.agent_name ?? "unassigned"}`,
    `Note: _${note}_`,
    ``,
    decision === "approve"
      ? `Task is now marked as *approved* and will be treated as complete.`
      : `Task is now marked as *rejected* and will require re-work.`,
  ].join("\n");
}

// ── Routing violations handler (issue #293) ─────────────────────────────

function handleRoutingViolations(store: ITelegramStateStore, limit: number): string {
  const violations = store.getRoutingViolations(limit);

  if (violations.length === 0) {
    return [
      `✅ *Routing Violations — None*`,
      ``,
      `No agent-to-repo routing violations detected.`,
      `Violations are recorded when a task is dispatched to an agent`,
      `that does not own the target repository.`,
    ].join("\n");
  }

  const lines: string[] = [
    `🚨 *Routing Violations — ${violations.length} recorded*`,
    ``,
  ];

  for (const v of violations.slice(0, limit)) {
    const shortId = v.task_id.slice(0, 8);
    const title = (v.task_title ?? "—").slice(0, 40);
    const detected = formatAgo(v.detected_at);

    lines.push(`❌ \`${shortId}\` — ${title}`);
    lines.push(`  Agent: \`${v.agent_name}\` → Repo: \`${v.target_repo}\``);
    lines.push(`  Expected: \`${v.expected_agent ?? "unknown"}\` · ${detected}`);
    lines.push(``);
  }

  return lines.join("\n");
}

// ── Misrouting digest handler (issue #387) ───────────────────────────────

function handleMisrouting(
  store: ITelegramStateStore,
  lookbackHours: number,
  reviewerConfig?: ReviewerConfig,
): string {
  if (!reviewerConfig) {
    return [
      `⚠️ *Misrouting Digest — Unavailable*`,
      ``,
      `Reviewer config is not available in this session.`,
      `Please ensure the command handler is initialised with a \`reviewerConfig\`.`,
    ].join("\n");
  }
  const report = buildMisroutingDigest(store, reviewerConfig, { lookbackHours });
  return formatMisroutingDigest(report);
}

// ── Triage health handler (issue #409) ───────────────────────────────────────

/**
 * Handle the `/triage-health [agent]` command.
 *
 * Shows per-agent triage schema pass/fail rates, most commonly missing fields,
 * revision counts, and a 7-day trend so operators can answer "is coaching working?"
 */
function handleTriageHealth(
  store: ITelegramStateStore,
  agentName?: string,
): string {
  const report = getTriageHealthPayload(store, agentName);
  return formatTriageHealthForTelegram(report, agentName);
}

// ── Quality system health handler (issue #304) ────────────────────────────

function handleQualitySystemHealth(
  store: ITelegramStateStore,
  dashboardUrl?: string,
): string {
  const payload = getQualitySystemHealthPayload(store);
  const page = formatQualitySystemHealthPage(payload);
  if (dashboardUrl) {
    return `${page}\n\n[View dashboard](${dashboardUrl}/quality-system-health)`;
  }
  return page;
}

// ── Low-score approved feed handler (issue #278) ─────────────────────────────

/**
 * Handle the `/low-score [threshold] [limit]` command.
 *
 * Lists approved tasks with quality scores below `threshold` (default 0.75),
 * showing the score, per-dimension breakdown, and agent so operators can
 * audit risky approvals before they cause downstream issues.
 *
 * Usage:
 *   /low-score             — threshold 0.75, up to 10 tasks shown
 *   /low-score 0.65        — threshold 0.65
 *   /low-score 0.75 20     — threshold 0.75, show up to 20 tasks
 */
function handleLowScoreFeed(
  store: ITelegramStateStore,
  threshold: number,
  limit: number,
  dashboardUrl?: string,
): string {
  const feed = getLowScoreApprovedFeed(store, { threshold, limit });
  return formatLowScoreFeedForTelegram(feed, 10, dashboardUrl);
}

// ── Bypass reason backfill handler (issue #295) ─────────────────────────

/**
 * Handle the /backfill-bypass-reasons command.
 * Backfills bypass_reason for historical sub-0.60 approved tasks.
 *
 * Logic:
 * - Tasks with `[operator-override: ...]` in verification_notes → 'operator_override'
 * - Remaining sub-0.60 approved tasks with null bypass_reason → 'floor_not_enforced'
 * - Similarly backfills verification_results by joining on task_id
 *
 * Idempotent: safe to run multiple times — only updates rows with NULL bypass_reason.
 *
 * Usage: `/backfill-bypass-reasons`
 */
function handleBackfillBypassReasons(store: ITelegramStateStore): string {
  // Check if the store has the backfill method
  const storeAny = store as unknown as Record<string, unknown>;
  if (typeof storeAny.backfillBypassReasons !== "function") {
    return [
      `⚠️ *Backfill Bypass Reasons — Not Available*`,
      ``,
      `The connected StateStore does not support \`backfillBypassReasons()\`.`,
      `This command requires the reviewer's own StateStore (not the orchestrator's).`,
    ].join("\n");
  }

  const result = (storeAny.backfillBypassReasons as () => { tasks_updated: number; verification_results_updated: number })();

  if (result.tasks_updated === 0 && result.verification_results_updated === 0) {
    return [
      `✅ *Backfill Bypass Reasons — No Action Needed*`,
      ``,
      `All sub-0.60 approved tasks already have a \`bypass_reason\` set.`,
      `Nothing to backfill.`,
    ].join("\n");
  }

  const lines: string[] = [
    `✅ *Backfill Bypass Reasons — Complete*`,
    ``,
    `📋 **Tasks updated:** ${result.tasks_updated}`,
    `📋 **Verification results updated:** ${result.verification_results_updated}`,
    ``,
    `Bypass reasons classified:`,
    `  🔓 \`operator_override\` — tasks with \`[operator-override: ...]\` notes`,
    `  🏚️ \`floor_not_enforced\` — remaining sub-0.60 approved tasks`,
    ``,
    `This backfill is idempotent — safe to run again.`,
  ];

  return lines.join("\n");
}

// ── Semantic Task Memory handlers (issue #369) ────────────────────────────

/**
 * Handle `/memory` (no args) or `/memory digest` — render a fresh digest snapshot.
 *
 * Calls buildMemoryDigest() so operators get an on-demand view without waiting
 * for the next scheduled 09:00 UTC send.
 */
function handleMemoryDigest(store: ITelegramStateStore): string {
  const memoryStore = store as unknown as ISemanticMemoryStore;
  if (
    typeof memoryStore.getTopMemoryTopics !== "function" ||
    typeof memoryStore.getRepeatedAttemptTopics !== "function" ||
    typeof memoryStore.getLowConfidenceTopics !== "function"
  ) {
    return [
      `⚠️ *Semantic Memory — Not Available*`,
      ``,
      `The connected StateStore does not support semantic task memory queries.`,
      `This command requires the reviewer's own StateStore.`,
    ].join("\n");
  }

  const report = buildMemoryDigest(memoryStore);
  return formatMemoryDigest(report);
}

/**
 * Handle `/memory expand <topic>` — return all indexed entries for a topic.
 *
 * Uses FTS5 for fuzzy matching when no exact topic entry exists.
 */
function handleMemoryExpand(store: ITelegramStateStore, topic: string): string {
  const memoryStore = store as unknown as ISemanticMemoryStore;
  if (typeof memoryStore.expandMemoryTopic !== "function") {
    return [
      `⚠️ *Semantic Memory — Not Available*`,
      ``,
      `The connected StateStore does not support \`expandMemoryTopic()\`.`,
    ].join("\n");
  }

  const entries = memoryStore.expandMemoryTopic(topic, 15);

  if (entries.length === 0) {
    return [
      `🔍 *Memory Expand: \`${topic}\`*`,
      ``,
      `No entries found matching that topic.`,
      ``,
      `_Use \`/memory\` to see the digest and discover available topics._`,
    ].join("\n");
  }

  const lines: string[] = [
    `🧠 *Memory Expand: \`${topic}\`* (${entries.length} entr${entries.length !== 1 ? "ies" : "y"})`,
    ``,
  ];

  for (const e of entries) {
    const outcomeIcon = e.outcome === "success" ? "✅" : e.outcome === "failure" ? "❌" : "🟡";
    const pct = (e.confidence * 100).toFixed(0);
    const date = e.recorded_at.slice(0, 10);
    lines.push(
      `${outcomeIcon} \`${e.task_id.slice(0, 8)}\` — ${pct}% confidence · ${e.outcome} · ${date}`,
    );
  }

  return lines.join("\n");
}

// ── TelegramCommandHandler class ──────────────────────────────────────────

/**
 * Long-polls the Telegram Bot API for incoming operator commands and
 * dispatches them to the live state.db via the provided ITelegramStateStore.
 */
export class TelegramCommandHandler {
  private store: ITelegramStateStore;
  private pollIntervalMs: number;
  private conflictStatsProvider?: ConflictStatsProvider;
  private calibrationDriftProvider?: CalibrationDriftProvider;
  private verifier?: Verifier;
  /** Optional base URL of the operator dashboard (e.g. "https://dashboard.example.com").
   *  When provided, /health includes clickable drill-down links for each panel. */
  private dashboardUrl?: string;
  /**
   * Optional surge detector instance.  When provided, the `/suppress` command
   * can silence storm alerts for specific issues in the current session.
   */
  private surgeDetector?: DuplicateDispatchSurgeDetector;
  /**
   * Optional reviewer config — required for `/misrouting` to work.
   * When omitted, `/misrouting` returns a "not available" message.
   */
  private reviewerConfig?: ReviewerConfig;

  constructor(
    store: ITelegramStateStore,
    opts: {
      pollIntervalMs?: number;
      conflictStatsProvider?: ConflictStatsProvider;
      calibrationDriftProvider?: CalibrationDriftProvider;
      verifier?: Verifier;
      /** Base URL of the operator dashboard, used to generate drill-down links in /health. */
      dashboardUrl?: string;
      /**
       * Surge detector instance — required for `/suppress` to work.
       * When omitted, `/suppress` returns a "not available" message.
       */
      surgeDetector?: DuplicateDispatchSurgeDetector;
      /**
       * Reviewer config — required for `/misrouting` to work.
       * When omitted, `/misrouting` returns a "not available" message.
       */
      reviewerConfig?: ReviewerConfig;
    } = {},
  ) {
    this.store = store;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.conflictStatsProvider = opts.conflictStatsProvider;
    this.calibrationDriftProvider = opts.calibrationDriftProvider;
    this.verifier = opts.verifier;
    this.dashboardUrl = opts.dashboardUrl ?? process.env.DASHBOARD_URL;
    this.surgeDetector = opts.surgeDetector;
    this.reviewerConfig = opts.reviewerConfig;
  }

  /**
   * Start the long-polling loop. Returns a `stop()` function.
   * If Telegram credentials are not configured, logs a warning and returns a no-op.
   */
  start(): () => void {
    const config = resolveConfig();
    if (!config) {
      log.warn("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing) — command handler disabled");
      return () => undefined;
    }

    log.info("Telegram command handler started");
    let running = true;
    let offset = 0;

    const poll = async (): Promise<void> => {
      while (running) {
        try {
          const updates = await getUpdates(config.botToken, offset, 30);
          for (const update of updates) {
            offset = update.update_id + 1;

            // Security: only process messages from the configured chat ID
            if (String(update.message?.chat?.id) !== config.chatId) continue;

            const cmd = parseCommand(update);
            if (!cmd) continue;

            log.info("Received Telegram command", { command: cmd.command, args: cmd.args });

            try {
              const reply = await executeCommand(cmd, this.store, config.botToken, this.conflictStatsProvider, this.calibrationDriftProvider, this.verifier, this.dashboardUrl, this.surgeDetector, this.reviewerConfig);
              await sendMessage(config.botToken, cmd.chatId, reply);
            } catch (err) {
              log.error("Error executing command", {
                command: cmd.command,
                error: err instanceof Error ? err.message : String(err),
              });
              try {
                await sendMessage(
                  config.botToken,
                  cmd.chatId,
                  `❌ Error executing \`/${cmd.command}\`: ${err instanceof Error ? err.message : String(err)}`,
                );
              } catch {
                // swallow reply error
              }
            }
          }
        } catch (err) {
          if (running) {
            log.error("Telegram poll error", {
              error: err instanceof Error ? err.message : String(err),
            });
            // Back off briefly on error
            await new Promise((r) => setTimeout(r, this.pollIntervalMs * 5));
          }
        }
      }
    };

    // Fire and forget the polling loop
    void poll();

    return () => {
      running = false;
      log.info("Telegram command handler stopped");
    };
  }
}
