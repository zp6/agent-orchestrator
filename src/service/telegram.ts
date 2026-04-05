import { createLogger } from "./logger.js";
import { notifyOperator } from "./notify.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    log.error("Failed to send reply", { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleCommand(text: string, ctx: TelegramContext): Promise<string> {
  const cmd = text.trim().toLowerCase();
  const args = text.trim().split(/\s+/).slice(1).join(" ");

  // Status
  if (cmd === "status" || cmd === "/status") {
    const tasks = ctx.store.listTasks({ limit: 5 });
    const active = tasks.filter((t) => t.status === "dispatched" || t.status === "in_progress");
    const agents = Object.keys(ctx.config.agents);
    const agentStatus = agents.map((name) => {
      const busy = ctx.store.hasActiveTask(name);
      return `  ${busy ? "🔵" : "⚪"} ${name}${busy ? " (working)" : " (idle)"}`;
    }).join("\n");

    return `📊 *Status*\n\nAgents:\n${agentStatus}\n\nActive tasks: ${active.length}\nRecent tasks: ${tasks.slice(0, 3).map((t) => `  ${t.status === "done" ? "✅" : t.status === "failed" ? "❌" : "🔵"} ${t.title?.slice(0, 60)}`).join("\n")}`;
  }

  // Health
  if (cmd === "health" || cmd === "/health") {
    const agents = Object.keys(ctx.config.agents);
    const checks = await Promise.all(agents.map(async (name) => {
      const agent = ctx.config.agents[name];
      const port = agent.docker?.port;
      if (!port) return `  ❓ ${name}: no port configured`;
      try {
        const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(5000) });
        return res.ok ? `  ✅ ${name} (port ${port})` : `  ❌ ${name} (port ${port}): ${res.status}`;
      } catch {
        return `  ❌ ${name} (port ${port}): unreachable`;
      }
    }));
    return `🏥 *Health*\n\n${checks.join("\n")}`;
  }

  // Issues
  if (cmd === "issues" || cmd === "/issues") {
    const repos = Object.values(ctx.config.agents)
      .map((a) => a.github)
      .filter(Boolean) as string[];
    const uniqueRepos = [...new Set(repos)];
    const lines: string[] = [];
    for (const repo of uniqueRepos) {
      try {
        const { execSync } = await import("node:child_process");
        const raw = execSync(`gh issue list --repo ${repo} --state open --json number,title -L 5`, { encoding: "utf-8", timeout: 15000 });
        const issues = JSON.parse(raw) as Array<{ number: number; title: string }>;
        if (issues.length > 0) {
          lines.push(`*${repo}*`);
          for (const i of issues) lines.push(`  #${i.number} ${i.title.slice(0, 50)}`);
        }
      } catch { /* skip */ }
    }
    return lines.length > 0 ? `📋 *Open Issues*\n\n${lines.join("\n")}` : "📋 No open issues across repos";
  }

  // PRs
  if (cmd === "prs" || cmd === "/prs") {
    const repos = Object.values(ctx.config.agents)
      .map((a) => a.github)
      .filter(Boolean) as string[];
    const uniqueRepos = [...new Set(repos)];
    const lines: string[] = [];
    for (const repo of uniqueRepos) {
      try {
        const { execSync } = await import("node:child_process");
        const raw = execSync(`gh pr list --repo ${repo} --state open --json number,title -L 5`, { encoding: "utf-8", timeout: 15000 });
        const prs = JSON.parse(raw) as Array<{ number: number; title: string }>;
        if (prs.length > 0) {
          lines.push(`*${repo}*`);
          for (const pr of prs) lines.push(`  #${pr.number} ${pr.title.slice(0, 50)}`);
        }
      } catch { /* skip */ }
    }
    return lines.length > 0 ? `🔀 *Open PRs*\n\n${lines.join("\n")}` : "🔀 No open PRs";
  }

  // Dispatch to specific agent
  if (cmd.startsWith("dispatch ") || cmd.startsWith("/dispatch ")) {
    const parts = text.trim().split(/\s+/);
    const agentName = parts[1];
    const message = parts.slice(2).join(" ");
    if (!agentName || !message) return "Usage: `dispatch <agent> <message>`";
    if (!ctx.config.agents[agentName]) {
      return `❌ Unknown agent: ${agentName}\nAvailable: ${Object.keys(ctx.config.agents).join(", ")}`;
    }
    try {
      const result = await ctx.dispatcher.dispatch(message, { agentName, source: "manual", title: `[telegram] ${message.slice(0, 60)}` });
      return `✅ Dispatched to ${agentName}\nTask ID: ${result.taskId}`;
    } catch (err) {
      return `❌ Dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Ask any agent
  if (cmd.startsWith("ask ") || cmd.startsWith("/ask ")) {
    const parts = text.trim().split(/\s+/);
    const agentName = parts[1];
    const message = parts.slice(2).join(" ");
    if (!agentName || !message) return "Usage: `ask <agent> <question>`";
    if (!ctx.config.agents[agentName]) {
      return `❌ Unknown agent: ${agentName}\nAvailable: ${Object.keys(ctx.config.agents).join(", ")}`;
    }
    try {
      const result = await ctx.dispatcher.dispatch(message, { agentName, source: "manual", title: `[telegram-ask] ${message.slice(0, 60)}` });
      return `✅ Asked ${agentName}: "${message.slice(0, 80)}"\nTask ID: ${result.taskId}\nI'll send the response when it completes.`;
    } catch (err) {
      return `❌ Ask failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Help
  if (cmd === "help" || cmd === "/help" || cmd === "/start") {
    return `🤖 *Orchestrator Commands*\n
\`status\` — agent status + recent tasks
\`health\` — ping all agent containers
\`issues\` — open issues across all repos
\`prs\` — open PRs across all repos
\`dispatch <agent> <message>\` — send task to agent
\`ask <agent> <question>\` — ask agent a question
\`help\` — this message

Or just send free text — it will be forwarded to the supervisor as an operator directive.`;
  }

  // Free text → forward to supervisor as directive
  try {
    const result = await ctx.dispatcher.dispatch(
      `Operator directive via Telegram: ${text}`,
      { agentName: Object.keys(ctx.config.agents)[0], source: "manual", title: `[telegram-directive] ${text.slice(0, 60)}` },
    );
    return `📨 Forwarded to supervisor as directive\nTask ID: ${result.taskId}`;
  } catch (err) {
    return `❌ Failed to forward: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Poll Telegram for new messages and process commands.
 * Call this from the daemon poll cycle.
 */
export async function pollTelegram(ctx: TelegramContext): Promise<void> {
  if (!loadConfig()) return;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=0&limit=10`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return;

    const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
    if (!data.ok || !data.result.length) return;

    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);

      const msg = update.message;
      if (!msg?.text) continue;

      // Security: only process messages from configured chat ID
      if (String(msg.chat.id) !== chatId) {
        log.warn("Ignoring message from unknown chat", { chatId: msg.chat.id });
        continue;
      }

      log.info("Telegram command received", { text: msg.text, from: msg.from?.first_name });

      const reply = await handleCommand(msg.text, ctx);
      await sendReply(reply);
    }
  } catch (err) {
    // Don't log on every cycle if Telegram is just slow
    log.error("Telegram poll error", { error: err instanceof Error ? err.message : String(err) });
  }
}
