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
    return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return "";
  }
}

async function ghAsync(cmd: string): Promise<string> {
  const { exec } = await import("node:child_process");
  return new Promise((resolve) => {
    exec(cmd, { encoding: "utf-8", timeout: 10000 }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
  });
}

async function handleCommand(text: string, ctx: TelegramContext): Promise<string> {
  const cmd = text.trim().toLowerCase();

  // Summary — the main command
  if (cmd === "summary" || cmd === "/summary" || cmd === "s") {
    return await buildSummary(ctx);
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

  // Issues (parallel across repos)
  if (cmd === "issues" || cmd === "/issues") {
    const repos = [...new Set(Object.values(ctx.config.agents).map((a) => a.github).filter(Boolean))] as string[];
    const results = await Promise.all(repos.map(async (repo) => {
      const raw = await ghAsync(`gh issue list --repo ${repo} --state open --json number,title -L 5`);
      if (!raw) return "";
      const issues = JSON.parse(raw) as Array<{ number: number; title: string }>;
      if (issues.length === 0) return "";
      return `*${repo.split("/")[1]}*\n${issues.map((i) => `  #${i.number} ${i.title.slice(0, 45)}`).join("\n")}`;
    }));
    const lines = results.filter(Boolean).join("\n");
    return lines ? `📋 *Issues*\n\n${lines}` : "📋 No open issues";
  }

  // PRs (parallel across repos)
  if (cmd === "prs" || cmd === "/prs") {
    const repos = [...new Set(Object.values(ctx.config.agents).map((a) => a.github).filter(Boolean))] as string[];
    const results = await Promise.all(repos.map(async (repo) => {
      const raw = await ghAsync(`gh pr list --repo ${repo} --state open --json number,title,mergeable -L 5`);
      if (!raw) return "";
      const prs = JSON.parse(raw) as Array<{ number: number; title: string; mergeable: string }>;
      if (prs.length === 0) return "";
      return `*${repo.split("/")[1]}*\n${prs.map((pr) => {
        const icon = pr.mergeable === "MERGEABLE" ? "✅" : pr.mergeable === "CONFLICTING" ? "⚠️" : "❓";
        return `  ${icon} #${pr.number} ${pr.title.slice(0, 40)}`;
      }).join("\n")}`;
    }));
    const lines = results.filter(Boolean).join("\n");
    return lines ? `🔀 *PRs*\n\n${lines}` : "🔀 No open PRs";
  }

  // Dispatch (fire-and-forget — reply immediately, don't block polling)
  if (cmd.startsWith("dispatch ") || cmd.startsWith("/dispatch ")) {
    const parts = text.trim().split(/\s+/);
    const agentName = parts[1];
    const message = parts.slice(2).join(" ");
    if (!agentName || !message) return "Usage: dispatch <agent> <message>";
    if (!ctx.config.agents[agentName]) return `❌ Unknown agent. Available: ${Object.keys(ctx.config.agents).join(", ")}`;
    ctx.dispatcher.dispatch(message, { agentName, source: "manual", title: `[telegram] ${message.slice(0, 60)}` })
      .then((r) => sendReply(`✅ Task completed (${r.taskId})`))
      .catch((e) => sendReply(`❌ Task failed: ${e instanceof Error ? e.message : String(e)}`));
    return `📤 Dispatching to ${agentName}...`;
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

  // Default: treat as directive (fire-and-forget)
  ctx.dispatcher.dispatch(
    `Operator directive via Telegram: ${text}`,
    { agentName: Object.keys(ctx.config.agents)[0], source: "manual", title: `[telegram] ${text.slice(0, 60)}` },
  )
    .then((r) => sendReply(`✅ Directive completed (${r.taskId})`))
    .catch((e) => sendReply(`❌ Directive failed: ${e instanceof Error ? e.message : String(e)}`));
  return `📨 Forwarding as directive...`;
}

async function buildSummary(ctx: TelegramContext): Promise<string> {
  const agents = Object.keys(ctx.config.agents);
  const repos = [...new Set(Object.values(ctx.config.agents).map((a) => a.github).filter(Boolean))] as string[];

  // 1. Health — are all agents up?
  const healthChecks = await Promise.all(agents.map(async (name) => {
    const port = ctx.config.agents[name].docker?.port;
    if (!port) return { name, ok: false };
    try {
      const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) });
      return { name, ok: res.ok };
    } catch {
      return { name, ok: false };
    }
  }));
  const downAgents = healthChecks.filter((h) => !h.ok);
  const healthLine = downAgents.length === 0
    ? "🟢 All systems green"
    : `🔴 ${downAgents.length} agent(s) down: ${downAgents.map((h) => h.name).join(", ")}`;

  // 2. Shipped — recently merged PRs
  const mergedResults = await Promise.all(repos.map(async (repo) => {
    const raw = await ghAsync(`gh pr list --repo ${repo} --state merged --json number,title,mergedAt -L 10`);
    if (!raw) return [];
    try {
      const prs = JSON.parse(raw) as Array<{ number: number; title: string; mergedAt: string }>;
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      return prs
        .filter((pr) => new Date(pr.mergedAt).getTime() > cutoff)
        .map((pr) => ({ repo: repo.split("/")[1], ...pr }));
    } catch { return []; }
  }));
  const recentMerges = mergedResults.flat().sort((a, b) =>
    new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime(),
  );
  let shippedSection: string;
  if (recentMerges.length === 0) {
    shippedSection = "No merges in last 2h";
  } else {
    const shown = recentMerges.slice(0, 5);
    const lines = shown.map((pr) => `  • #${pr.number} ${pr.title.slice(0, 45)}`);
    if (recentMerges.length > 5) lines.push(`  ${recentMerges.length - 5} more...`);
    shippedSection = lines.join("\n");
  }

  // 3. Needs attention — stuck tasks, down agents, recent failures
  const attentionItems: string[] = [];
  const dispatched = ctx.store.listTasks({ status: "dispatched", limit: 10 });
  for (const t of dispatched) {
    const ageMin = (Date.now() - new Date(t.created_at).getTime()) / 60000;
    if (ageMin > 10) attentionItems.push(`Stuck: ${t.title?.slice(0, 40)} (${Math.round(ageMin)}m)`);
  }
  for (const h of downAgents) attentionItems.push(`${h.name} unreachable`);
  const failures = ctx.store.listTasks({ status: "failed", limit: 3 });
  for (const t of failures) {
    const ageH = (Date.now() - new Date(t.updated_at).getTime()) / 3600000;
    if (ageH < 2) attentionItems.push(`Failed: ${t.title?.slice(0, 40)}`);
  }
  const attentionSection = attentionItems.length === 0
    ? "Nothing — all clear"
    : attentionItems.map((i) => `  • ${i}`).join("\n");

  // 4. Working now
  const working = agents
    .filter((name) => ctx.store.hasActiveTask(name))
    .map((name) => {
      const tasks = ctx.store.listTasks({ agent_name: name, status: "dispatched", limit: 1 });
      const title = tasks[0]?.title?.slice(0, 35) || "?";
      return `  ${name.replace("claude-orchestrator-", "").replace("claude-", "")}: ${title}`;
    });
  const workingSection = working.length > 0 ? working.join("\n") : "  All idle";

  // 5. Stats
  const stats = ctx.store.getAgentStats();
  const totalDone = stats.reduce((s, a) => s + a.done, 0);
  const totalFailed = stats.reduce((s, a) => s + a.failed, 0);
  const successRate = totalDone + totalFailed > 0
    ? Math.round((totalDone / (totalDone + totalFailed)) * 100)
    : 0;
  const prCounts = await Promise.all(repos.map(async (repo) => {
    const raw = await ghAsync(`gh pr list --repo ${repo} --state open --json number -q length`);
    return parseInt(raw) || 0;
  }));
  const openPRs = prCounts.reduce((a, b) => a + b, 0);

  return `${healthLine}

🚀 *Shipped (last 2h)*
${shippedSection}

⚠️ *Needs attention*
${attentionSection}

🔄 *Working now*
${workingSection}

📊 ${totalDone} done | ${successRate}% success | ${openPRs} open PRs | ${recentMerges.length} merged (2h)`;
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
