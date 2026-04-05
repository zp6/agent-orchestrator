import { createLogger } from "./logger.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { StateStore } from "../state/store.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import type { OrchestratorConfig } from "../config/schema.js";

const log = createLogger("telegram");

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    from?: { first_name?: string };
  };
}

interface TelegramContext {
  config: OrchestratorConfig;
  store: StateStore;
  dispatcher: Dispatcher;
}

let lastUpdateId = 0;
let botToken: string | null = null;
let chatId: string | null = null;
let pollingInterval: ReturnType<typeof setInterval> | null = null;

function loadConfig(): boolean {
  if (botToken) return true;
  try {
    const envPath = join(homedir(), ".claude-orchestrator", ".env");
    const content = readFileSync(envPath, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const [key, ...rest] = line.split("=");
      if (key && rest.length) vars[key.trim()] = rest.join("=").trim();
    }
    botToken = vars.TELEGRAM_BOT_TOKEN ?? null;
    chatId = vars.TELEGRAM_CHAT_ID ?? null;
    return !!(botToken && chatId);
  } catch {
    return false;
  }
}

async function sendReply(text: string): Promise<void> {
  if (!botToken || !chatId) return;
  // Telegram has a 4096 char limit — truncate if needed
  const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n\n...(truncated)" : text;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: truncated, parse_mode: "Markdown" }),
    });
  } catch (err) {
    // Retry without markdown if parse fails
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: truncated }),
      });
    } catch {
      log.error("Failed to send reply", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function gh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trim();
  } catch {
    return "";
  }
}

async function handleCommand(text: string, ctx: TelegramContext): Promise<string> {
  const cmd = text.trim().toLowerCase();

  // Summary — the main command
  if (cmd === "summary" || cmd === "/summary" || cmd === "s") {
    return buildSummary(ctx);
  }

  // Status — quick agent status
  if (cmd === "status" || cmd === "/status") {
    const agents = Object.keys(ctx.config.agents);
    const lines = agents.map((name) => {
      const busy = ctx.store.hasActiveTask(name);
      const tasks = ctx.store.listTasks({ agent_name: name, limit: 1 });
      const current = busy && tasks[0] ? `: ${tasks[0].title?.slice(0, 50)}` : "";
      return `${busy ? "🔵" : "⚪"} ${name}${busy ? current : " (idle)"}`;
    });
    return `📊 *Agents*\n\n${lines.join("\n")}`;
  }

  // Health
  if (cmd === "health" || cmd === "/health") {
    const agents = Object.keys(ctx.config.agents);
    const checks = await Promise.all(agents.map(async (name) => {
      const port = ctx.config.agents[name].docker?.port;
      if (!port) return `❓ ${name}: no port`;
      try {
        const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(5000) });
        return res.ok ? `✅ ${name}` : `❌ ${name} (${res.status})`;
      } catch {
        return `❌ ${name} (unreachable)`;
      }
    }));
    return `🏥 *Health*\n\n${checks.join("\n")}`;
  }

  // Issues
  if (cmd === "issues" || cmd === "/issues") {
    const repos = [...new Set(Object.values(ctx.config.agents).map((a) => a.github).filter(Boolean))] as string[];
    const lines: string[] = [];
    for (const repo of repos) {
      const raw = gh(`gh issue list --repo ${repo} --state open --json number,title -L 5`);
      if (!raw) continue;
      const issues = JSON.parse(raw) as Array<{ number: number; title: string }>;
      if (issues.length > 0) {
        lines.push(`*${repo.split("/")[1]}*`);
        for (const i of issues) lines.push(`  #${i.number} ${i.title.slice(0, 45)}`);
      }
    }
    return lines.length > 0 ? `📋 *Issues*\n\n${lines.join("\n")}` : "📋 No open issues";
  }

  // PRs
  if (cmd === "prs" || cmd === "/prs") {
    const repos = [...new Set(Object.values(ctx.config.agents).map((a) => a.github).filter(Boolean))] as string[];
    const lines: string[] = [];
    for (const repo of repos) {
      const raw = gh(`gh pr list --repo ${repo} --state open --json number,title,mergeable -L 5`);
      if (!raw) continue;
      const prs = JSON.parse(raw) as Array<{ number: number; title: string; mergeable: string }>;
      if (prs.length > 0) {
        lines.push(`*${repo.split("/")[1]}*`);
        for (const pr of prs) {
          const icon = pr.mergeable === "MERGEABLE" ? "✅" : pr.mergeable === "CONFLICTING" ? "⚠️" : "❓";
          lines.push(`  ${icon} #${pr.number} ${pr.title.slice(0, 40)}`);
        }
      }
    }
    return lines.length > 0 ? `🔀 *PRs*\n\n${lines.join("\n")}` : "🔀 No open PRs";
  }

  // Dispatch
  if (cmd.startsWith("dispatch ") || cmd.startsWith("/dispatch ")) {
    const parts = text.trim().split(/\s+/);
    const agentName = parts[1];
    const message = parts.slice(2).join(" ");
    if (!agentName || !message) return "Usage: dispatch <agent> <message>";
    if (!ctx.config.agents[agentName]) return `❌ Unknown agent. Available: ${Object.keys(ctx.config.agents).join(", ")}`;
    try {
      const result = await ctx.dispatcher.dispatch(message, { agentName, source: "manual", title: `[telegram] ${message.slice(0, 60)}` });
      return `✅ Dispatched to ${agentName} (${result.taskId})`;
    } catch (err) {
      return `❌ ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Help
  if (cmd === "help" || cmd === "/help" || cmd === "/start") {
    return `🤖 *Commands*

summary (or s) — what's happening
status — agent status
health — ping containers
issues — open issues
prs — open PRs
dispatch <agent> <msg> — send task
help — this message`;
  }

  // Default: treat as directive
  try {
    const result = await ctx.dispatcher.dispatch(
      `Operator directive via Telegram: ${text}`,
      { agentName: Object.keys(ctx.config.agents)[0], source: "manual", title: `[telegram] ${text.slice(0, 60)}` },
    );
    return `📨 Forwarded as directive (${result.taskId})`;
  } catch (err) {
    return `❌ ${err instanceof Error ? err.message : String(err)}`;
  }
}

function buildSummary(ctx: TelegramContext): string {
  const agents = Object.keys(ctx.config.agents);

  // Agent status
  const agentLines = agents.map((name) => {
    const busy = ctx.store.hasActiveTask(name);
    const tasks = ctx.store.listTasks({ agent_name: name, limit: 1 });
    const current = busy && tasks[0] ? tasks[0].title?.slice(0, 45) : null;
    return `${busy ? "🔵" : "⚪"} ${name}${current ? `: ${current}` : ""}`;
  });

  // Recent completions (last 5)
  const recent = ctx.store.listTasks({ status: "done", limit: 5 });
  const recentLines = recent.map((t) => {
    const score = t.quality_score !== null ? ` (${t.quality_score.toFixed(1)})` : "";
    const icon = t.verification_status === "approved" ? "✅" : t.verification_status === "rejected" ? "❌" : "⏳";
    return `${icon}${score} ${t.title?.slice(0, 45)}`;
  });

  // Recent failures (last 3)
  const failures = ctx.store.listTasks({ status: "failed", limit: 3 });
  const failLines = failures.length > 0
    ? failures.map((t) => `❌ ${t.title?.slice(0, 45)}`).join("\n")
    : "None";

  // Open PRs count
  const repos = [...new Set(Object.values(ctx.config.agents).map((a) => a.github).filter(Boolean))] as string[];
  let prCount = 0;
  for (const repo of repos) {
    const raw = gh(`gh pr list --repo ${repo} --state open --json number -q length`);
    prCount += parseInt(raw) || 0;
  }

  // Stats
  const stats = ctx.store.getAgentStats();
  const totalDone = stats.reduce((s, a) => s + a.done, 0);
  const totalFailed = stats.reduce((s, a) => s + a.failed, 0);
  const successRate = totalDone + totalFailed > 0
    ? Math.round((totalDone / (totalDone + totalFailed)) * 100)
    : 0;

  return `📋 *Summary*

*Agents*
${agentLines.join("\n")}

*Recent*
${recentLines.join("\n")}

*Failures*
${failLines}

*Stats*
Done: ${totalDone} | Failed: ${totalFailed} | Success: ${successRate}%
Open PRs: ${prCount}`;
}

/**
 * Start independent Telegram polling loop (every 3 seconds).
 * Runs in the background, independent of the daemon poll cycle.
 */
export function startTelegramPolling(ctx: TelegramContext): void {
  if (!loadConfig()) {
    log.info("Telegram not configured — skipping polling");
    return;
  }
  if (pollingInterval) return; // already running

  log.info("Telegram polling started (3s interval)");

  const poll = async () => {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=0&limit=10`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) return;

      const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
      if (!data.ok || !data.result.length) return;

      for (const update of data.result) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
        const msg = update.message;
        if (!msg?.text) continue;
        if (String(msg.chat.id) !== chatId) continue;

        log.info("Telegram command", { text: msg.text });
        const reply = await handleCommand(msg.text, ctx);
        await sendReply(reply);
      }
    } catch {
      // Silent — don't spam logs every 3 seconds
    }
  };

  // Poll immediately, then every 3 seconds
  poll();
  pollingInterval = setInterval(poll, 3000);
}

/**
 * Stop Telegram polling.
 */
export function stopTelegramPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

/**
 * Legacy: poll once (called from daemon cycle).
 * Kept for backward compatibility but startTelegramPolling is preferred.
 */
export async function pollTelegram(ctx: TelegramContext): Promise<void> {
  // If independent polling is running, skip the daemon-triggered poll
  if (pollingInterval) return;
  // Otherwise fall back to one-shot poll (shouldn't happen normally)
  if (!loadConfig()) return;
  startTelegramPolling(ctx);
}
