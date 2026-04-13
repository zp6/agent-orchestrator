/**
 * Telegram command handler — wires operator bot commands to live state.db.
 *
 * Commands handled:
 *   /status      → real-time counts from state.db (active, pending, recent)
 *   /health      → checks DB connectivity, GitHub API, Telegram bot token
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
 *   /verification-calibration [days] → score histograms, low-conf approvals, and drift alerts
 *   /calibration [days]  → alias for /verification-calibration
 *   /token-stats [hours] → per-call-type LLM token usage (default: 720h = 30 days)
 *
 * Usage:
 *   const handler = new TelegramCommandHandler(stateStore);
 *   const stop = handler.start();   // begins long-polling
 *   // later:
 *   stop();
 */

import { createLogger } from "../service/logger.js";
import type { ITelegramStateStore, Task, LlmTokenStats, VerificationStats } from "../state/types.js";
import type { ConflictStatsProvider } from "../reviewer/supervisor.js";
import { buildIssueAgeHeatmap, formatIssueAgeHeatmap } from "../reviewer/issue-age.js";
import type { CalibrationDriftProvider } from "../reviewer/calibration-drift.js";
import { CalibrationDriftMonitor } from "../reviewer/calibration-drift.js";
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
  | "verification-calibration"
  | "calibration"
  | "token-stats";

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
  "verification-calibration",
  "calibration",
  "token-stats",
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
): Promise<string> {
  switch (cmd.command) {
    case "status":
      return handleStatus(store);

    case "health":
      return handleHealth(store, botToken);

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

    case "verification-calibration":
    case "calibration": {
      const days = parseInt(cmd.args[0] ?? "30", 10);
      const windowDays = Number.isNaN(days) || days < 1 ? 30 : Math.min(days, 90);
      const provider: CalibrationDriftProvider = calibrationDriftProvider ?? new CalibrationDriftMonitor(store);
      const report = provider.buildReport({ windowDays });
      return provider.formatDistributionPage(report);
    }

    case "sla":
      return handleSLA(store, cmd.args);

    case "token-stats": {
      const hours = parseInt(cmd.args[0] ?? "720", 10);
      const windowHours = Number.isNaN(hours) || hours < 1 ? 720 : Math.min(hours, 8760);
      return handleTokenStats(store, windowHours);
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
): Promise<string> {
  const results: { label: string; ok: boolean; detail: string }[] = [];

  // 1. DB connectivity
  try {
    store.listTasks({ limit: 1 });
    results.push({ label: "SQLite state.db", ok: true, detail: "query succeeded" });
  } catch (err) {
    results.push({
      label: "SQLite state.db",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. GitHub API reachability
  try {
    const resp = await fetch("https://api.github.com", {
      headers: { "User-Agent": "claude-orchestrator-reviewer" },
      signal: AbortSignal.timeout(5000),
    });
    results.push({
      label: "GitHub API",
      ok: resp.ok || resp.status === 200,
      detail: `HTTP ${resp.status}`,
    });
  } catch (err) {
    results.push({
      label: "GitHub API",
      ok: false,
      detail: err instanceof Error ? err.message : "unreachable",
    });
  }

  // 3. Telegram bot token validity (getMe)
  try {
    const me = await telegramRequest<{ ok: boolean; result?: { username?: string } }>(
      botToken,
      "getMe",
    );
    results.push({
      label: "Telegram bot token",
      ok: me.ok,
      detail: me.result?.username ? `@${me.result.username}` : "valid",
    });
  } catch (err) {
    results.push({
      label: "Telegram bot token",
      ok: false,
      detail: err instanceof Error ? err.message : "invalid",
    });
  }

  const allOk = results.every((r) => r.ok);
  const lines = [
    `${allOk ? "✅" : "⚠️"} *Health Check*`,
    ``,
    ...results.map(
      (r) => `${r.ok ? "✅" : "❌"} *${r.label}*: ${r.detail}`,
    ),
  ];

  return lines.join("\n");
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

  constructor(
    store: ITelegramStateStore,
    opts: {
      pollIntervalMs?: number;
      conflictStatsProvider?: ConflictStatsProvider;
      calibrationDriftProvider?: CalibrationDriftProvider;
    } = {},
  ) {
    this.store = store;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.conflictStatsProvider = opts.conflictStatsProvider;
    this.calibrationDriftProvider = opts.calibrationDriftProvider;
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
              const reply = await executeCommand(cmd, this.store, config.botToken, this.conflictStatsProvider, this.calibrationDriftProvider);
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
