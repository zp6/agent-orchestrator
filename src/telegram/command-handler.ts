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
 *   /queue [repo]          → shows PR merge queue entries, optionally filtered by repo
 *   /logs [n]    → last N supervisor decisions (default 10), newest first
 *   /supervisor [n]  → last N supervisor decisions with full detail (default 10)
 *   /agents      → per-agent stats: total/done/failed/avg quality score
 *
 * Usage:
 *   const handler = new TelegramCommandHandler(stateStore);
 *   const stop = handler.start();   // begins long-polling
 *   // later:
 *   stop();
 */

import { createLogger } from "../service/logger.js";
import type { ITelegramStateStore } from "../state/types.js";
import type { ConflictStatsProvider } from "../reviewer/supervisor.js";
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

type CommandName = "status" | "health" | "pause" | "resume" | "dispatch" | "prioritize" | "queue" | "logs" | "supervisor" | "agents" | "s";

const SUPPORTED_COMMANDS = new Set<CommandName>([
  "status",
  "health",
  "pause",
  "resume",
  "dispatch",
  "prioritize",
  "queue",
  "logs",
  "supervisor",
  "agents",
  "s",
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
  }
}

async function handleStatus(store: ITelegramStateStore): Promise<string> {
  const active = store.listTasks({ status: "in_progress" });
  const dispatched = store.listTasks({ status: "dispatched" });
  const pendingVerification = store.getUnverified(5);
  const recentDone = store.getRecentCompleted(3);
  const recentFailed = store.listTasks({ status: "failed", limit: 3 });
  const isPaused = store.getSystemFlag("paused") === "true";
  const pendingDispatch = store.getPendingDispatchRequests();

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
    lines.push(`*${s.agent_name}*${score}`);
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

// ── TelegramCommandHandler class ──────────────────────────────────────────

/**
 * Long-polls the Telegram Bot API for incoming operator commands and
 * dispatches them to the live state.db via the provided ITelegramStateStore.
 */
export class TelegramCommandHandler {
  private store: ITelegramStateStore;
  private pollIntervalMs: number;
  private conflictStatsProvider?: ConflictStatsProvider;

  constructor(
    store: ITelegramStateStore,
    opts: { pollIntervalMs?: number; conflictStatsProvider?: ConflictStatsProvider } = {},
  ) {
    this.store = store;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.conflictStatsProvider = opts.conflictStatsProvider;
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
              const reply = await executeCommand(cmd, this.store, config.botToken, this.conflictStatsProvider);
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
