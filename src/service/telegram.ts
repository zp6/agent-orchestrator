import { createLogger } from "./logger.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { StateStore } from "../state/store.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { AgentClient } from "../client/agent-client.js";
import { ulid } from "ulid";

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
  agentClient?: AgentClient;
}

let lastUpdateId = 0;
let botToken: string | null = null;
let chatId: string | null = null;

/** Persistent conversation IDs per agent for the chat command. */
const chatConversations = new Map<string, string>();
let pollingInterval: ReturnType<typeof setInterval> | null = null;

const CHAT_PERSIST_PATH = join(homedir(), ".claude-orchestrator", "telegram-chats.json");

function loadChatConversations(): void {
  try {
    const data = JSON.parse(readFileSync(CHAT_PERSIST_PATH, "utf-8")) as Record<string, string>;
    for (const [k, v] of Object.entries(data)) chatConversations.set(k, v);
  } catch { /* no file yet */ }
}

function saveChatConversations(): void {
  import("node:fs/promises").then(({ writeFile }) =>
    writeFile(CHAT_PERSIST_PATH, JSON.stringify(Object.fromEntries(chatConversations))).catch(() => {}),
  );
}

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

async function sendReply(text: string): Promise<number | null> {
  if (!botToken || !chatId) return null;
  const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n\n...(truncated)" : text;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: truncated, parse_mode: "Markdown" }),
    });
    const data = await res.json() as { ok: boolean; result?: { message_id: number } };
    return data.result?.message_id ?? null;
  } catch {
    // Retry without markdown
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: truncated }),
      });
      const data = await res.json() as { ok: boolean; result?: { message_id: number } };
      return data.result?.message_id ?? null;
    } catch (err) {
      log.error("Failed to send reply", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}

async function editMessage(messageId: number, text: string): Promise<void> {
  if (!botToken || !chatId) return;
  const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n\n...(truncated)" : text;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: truncated }),
    });
  } catch { /* best effort */ }
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

  // Stats — detailed progression metrics
  if (cmd === "stats" || cmd === "/stats") {
    return await buildStats(ctx);
  }

  // Issue creation — rough idea → agent fleshes out and creates GitHub issue
  if (cmd.startsWith("issue ") || cmd.startsWith("/issue ")) {
    const rest = text.trim().slice(text.trim().indexOf(" ") + 1);
    if (!rest) return "Usage: issue <rough description>\nExample: issue add retry logic for failed PR merges";

    // Determine target repo from keywords or default to orchestrator
    const repos = Object.entries(ctx.config.agents)
      .filter(([, a]) => a.github)
      .map(([name, a]) => ({ name, repo: a.github! }));
    const lowerRest = rest.toLowerCase();
    let target = repos.find((r) => r.repo.includes("orchestrator"))!; // default
    for (const r of repos) {
      const repoShort = r.repo.split("/")[1].toLowerCase();
      if (lowerRest.includes(repoShort) || lowerRest.includes(r.name.replace("claude-", ""))) {
        target = r;
        break;
      }
    }

    // Dispatch to the target agent to create a detailed issue
    const prompt = `Create a GitHub issue on ${target.repo} based on this idea from the operator:

"${rest}"

Steps:
1. Think about what this feature/fix needs — scope it properly
2. Write a clear title prefixed with [${target.name}]
3. Write a detailed body with: Problem, Solution, Key files to modify
4. Create it: gh issue create --repo ${target.repo} --label orchestrator --title "..." --body "..."
5. Reply with the issue URL`;

    ctx.dispatcher.dispatch(prompt, {
      agentName: target.name,
      source: "manual",
      title: `[telegram-issue] ${rest.slice(0, 50)}`,
    })
      .then((r) => {
        // Extract issue URL from the result if present
        const urlMatch = r.response?.content?.match(/https:\/\/github\.com\/[^\s)]+\/issues\/\d+/);
        if (urlMatch) {
          sendReply(`✅ Issue created: ${urlMatch[0]}`);
        } else {
          sendReply(`✅ Issue task completed (${r.taskId})`);
        }
      })
      .catch((e) => sendReply(`❌ Issue creation failed: ${e instanceof Error ? e.message : String(e)}`));

    return `📝 Creating issue on ${target.repo}...`;
  }

  // New chat — reset conversation with an agent
  if (cmd.startsWith("newchat ") || cmd.startsWith("/newchat ")) {
    const agentName = text.trim().split(/\s+/)[1];
    if (!agentName) return "Usage: newchat <agent>";
    chatConversations.delete(agentName);
    saveChatConversations();
    return `🔄 Conversation with ${agentName} reset. Next chat message starts fresh.`;
  }

  // Chat — persistent conversation with an agent
  if (cmd.startsWith("chat ") || cmd.startsWith("/chat ")) {
    const parts = text.trim().split(/\s+/);
    const agentName = parts[1];
    const message = parts.slice(2).join(" ");
    if (!agentName || !message) return "Usage: chat <agent> <message>\nExample: chat claude-proxy what issues are you working on?";
    if (!ctx.config.agents[agentName]) return `❌ Unknown agent. Available: ${Object.keys(ctx.config.agents).join(", ")}`;

    // Get or create a persistent conversation_id for this agent
    if (!chatConversations.has(agentName)) {
      chatConversations.set(agentName, `telegram-chat-${agentName}-${ulid()}`);
      saveChatConversations();
    }
    const conversationId = chatConversations.get(agentName)!;

    const client = ctx.agentClient ?? new AgentClient(ctx.config);

    // Send "thinking..." then edit with response
    const thinkingId = await sendReply(`💭 ${agentName} is thinking...`);

    client.send(agentName, message, { conversationId })
      .then(async (response) => {
        const reply = response.content.slice(0, 3900);
        if (thinkingId) {
          await editMessage(thinkingId, `🤖 *${agentName}*\n\n${reply}`);
        } else {
          await sendReply(`�� *${agentName}*\n\n${reply}`);
        }
      })
      .catch(async (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (thinkingId) {
          await editMessage(thinkingId, `❌ ${agentName} error: ${errMsg.slice(0, 200)}`);
        } else {
          await sendReply(`❌ ${agentName} error: ${errMsg.slice(0, 200)}`);
        }
      });

    return ""; // Don't send another reply — "thinking..." is already sent
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

s — executive summary
stats — detailed metrics
status — agent status
health — ping containers
issues — open issues
prs — open PRs
chat <agent> <msg> — talk to agent (persistent)
newchat <agent> — reset conversation
issue <idea> — create issue from rough idea
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

async function buildStats(ctx: TelegramContext): Promise<string> {
  const repos = [...new Set(Object.values(ctx.config.agents).map((a) => a.github).filter(Boolean))] as string[];

  // Per-agent stats (last 24h)
  const agentStats = ctx.store.getAgentStats(24);
  const agentLines = agentStats.map((a) => {
    const rate = a.done + a.failed > 0 ? Math.round((a.done / (a.done + a.failed)) * 100) : 0;
    const score = a.avg_score !== null ? ` | avg ${a.avg_score.toFixed(1)}` : "";
    const name = a.agent_name.replace("claude-orchestrator-", "").replace("claude-", "");
    return `  ${name}: ${a.done}✅ ${a.failed}❌ ${rate}%${score}`;
  });

  // Merged PRs by time window (parallel)
  const mergedResults = await Promise.all(repos.map(async (repo) => {
    const raw = await ghAsync(`gh pr list --repo ${repo} --state merged --json mergedAt -L 50`);
    if (!raw) return [];
    try {
      return (JSON.parse(raw) as Array<{ mergedAt: string }>).map((pr) => new Date(pr.mergedAt).getTime());
    } catch { return []; }
  }));
  const allMergedTimes = mergedResults.flat();
  const now = Date.now();
  const merged1h = allMergedTimes.filter((t) => now - t < 3600000).length;
  const merged6h = allMergedTimes.filter((t) => now - t < 6 * 3600000).length;
  const merged24h = allMergedTimes.filter((t) => now - t < 24 * 3600000).length;

  // Closed issues by time window (parallel)
  const closedResults = await Promise.all(repos.map(async (repo) => {
    const raw = await ghAsync(`gh issue list --repo ${repo} --state closed --json closedAt -L 50`);
    if (!raw) return [];
    try {
      return (JSON.parse(raw) as Array<{ closedAt: string }>).map((i) => new Date(i.closedAt).getTime());
    } catch { return []; }
  }));
  const allClosedTimes = closedResults.flat();
  const closed1h = allClosedTimes.filter((t) => now - t < 3600000).length;
  const closed6h = allClosedTimes.filter((t) => now - t < 6 * 3600000).length;
  const closed24h = allClosedTimes.filter((t) => now - t < 24 * 3600000).length;

  // Open issues/PRs count
  const [openIssueResults, openPRResults] = await Promise.all([
    Promise.all(repos.map((r) => ghAsync(`gh issue list --repo ${r} --state open --json number -q length`))),
    Promise.all(repos.map((r) => ghAsync(`gh pr list --repo ${r} --state open --json number -q length`))),
  ]);
  const openIssues = openIssueResults.reduce((s, r) => s + (parseInt(r) || 0), 0);
  const openPRs = openPRResults.reduce((s, r) => s + (parseInt(r) || 0), 0);

  // Task totals
  const totalDone = agentStats.reduce((s, a) => s + a.done, 0);
  const totalFailed = agentStats.reduce((s, a) => s + a.failed, 0);
  const totalTotal = agentStats.reduce((s, a) => s + a.total, 0);
  const successRate = totalDone + totalFailed > 0
    ? Math.round((totalDone / (totalDone + totalFailed)) * 100)
    : 0;

  // Throughput per hour
  const mergesPerHour = merged6h > 0 ? (merged6h / 6).toFixed(1) : "0";

  // WIP — what's actively being worked on
  const agents = Object.keys(ctx.config.agents);
  const wipLines: string[] = [];
  for (const name of agents) {
    const active = ctx.store.listTasks({ agent_name: name, status: "dispatched", limit: 1 });
    if (active.length > 0) {
      const shortName = name.replace("claude-orchestrator-", "").replace("claude-", "");
      const ageMin = Math.round((now - new Date(active[0].created_at).getTime()) / 60000);
      wipLines.push(`  ${shortName}: ${active[0].title?.slice(0, 35)} (${ageMin}m)`);
    }
  }

  // Pending verification
  const unverified = ctx.store.getUnverified(20);

  return `📊 *Stats*

*Backlog*
  ${openIssues} open issues → ${openPRs} open PRs → ready to merge

*WIP*
${wipLines.length > 0 ? wipLines.join("\n") : "  All agents idle"}

*Progression (merged PRs)*
  Last 1h: ${merged1h} | 6h: ${merged6h} | 24h: ${merged24h}
  Rate: ~${mergesPerHour}/hour

*Issues closed*
  Last 1h: ${closed1h} | 6h: ${closed6h} | 24h: ${closed24h}

*Verification*
  ${unverified.length} pending | ${totalDone} done (24h) | ${successRate}% success

${buildPoolStats(ctx, agentStats)}

${buildTokenStats(ctx)}`;
}

function buildTokenStats(ctx: TelegramContext): string {
  const providerUsage = ctx.store.getTokenUsageByProvider(24);
  if (providerUsage.length === 0) return "";

  const providers = ctx.config.providers ?? {};
  const lines: string[] = ["*Token Usage*"];

  for (const usage of providerUsage) {
    const prov = providers[usage.provider];
    const limits = prov?.limits;
    const totalK = Math.round(usage.total / 1000);

    // Show usage against each limit window
    const windows: string[] = [];
    if (limits?.hourly) {
      const hourUsage = ctx.store.getTokenUsageByProvider(1).find((u) => u.provider === usage.provider);
      const hourTotal = hourUsage?.total ?? 0;
      const hourPct = Math.round((hourTotal / limits.hourly) * 100);
      windows.push(`${Math.round(hourTotal / 1000)}K/${Math.round(limits.hourly / 1000)}K/h (${hourPct}%)`);
    }
    if (limits?.daily) {
      const dayPct = Math.round((usage.total / limits.daily) * 100);
      windows.push(`${totalK}K/${Math.round(limits.daily / 1000)}K/d (${dayPct}%)`);
    }
    if (limits?.weekly) {
      const weekUsage = ctx.store.getTokenUsageByProvider(168).find((u) => u.provider === usage.provider);
      const weekTotal = weekUsage?.total ?? 0;
      const weekPct = Math.round((weekTotal / limits.weekly) * 100);
      windows.push(`${Math.round(weekTotal / 1000)}K/${Math.round(limits.weekly / 1000)}K/w (${weekPct}%)`);
    }

    // Overall status icon based on highest usage %
    const dayLimit = limits?.daily ?? prov?.daily_token_limit;
    const pct = dayLimit ? Math.round((usage.total / dayLimit) * 100) : null;
    const icon = pct !== null && pct >= 80 ? "🔴" : pct !== null && pct >= 50 ? "🟡" : "🟢";

    lines.push(`  ${icon} ${usage.provider}: ${windows.join(" | ")}`);
    lines.push(`    ${usage.request_count} requests`);
  }

  // Per-agent top consumers
  const agentUsage = ctx.store.getTokenUsageByAgent(24);
  if (agentUsage.length > 0) {
    lines.push("  Top agents:");
    for (const a of agentUsage.slice(0, 5)) {
      const name = a.agent_name.replace("claude-", "").replace("codex-", "⚡");
      lines.push(`    ${name}: ${Math.round(a.total / 1000)}K (${a.provider})`);
    }
  }

  return lines.join("\n");
}

function buildPoolStats(
  ctx: TelegramContext,
  agentStats: Array<{ agent_name: string; total: number; done: number; failed: number; avg_score: number | null }>,
): string {
  // Find pools
  const pools = new Map<string, string[]>();
  for (const [name, agent] of Object.entries(ctx.config.agents)) {
    if (agent.pool) {
      const members = pools.get(agent.pool) ?? [];
      members.push(name);
      pools.set(agent.pool, members);
    }
  }

  if (pools.size === 0) return "";

  const lines: string[] = ["*Pool Distribution*"];
  for (const [poolName, members] of pools) {
    const memberStats = members.map((name) => {
      const s = agentStats.find((a) => a.agent_name === name);
      return { name, total: s?.total ?? 0, done: s?.done ?? 0, failed: s?.failed ?? 0 };
    });
    const poolTotal = memberStats.reduce((s, m) => s + m.total, 0);
    if (poolTotal === 0) {
      lines.push(`  ${poolName}: no tasks yet`);
      continue;
    }

    lines.push(`  ${poolName} (${members.length} instances, ${poolTotal} tasks):`);
    for (const m of memberStats) {
      const pct = poolTotal > 0 ? Math.round((m.total / poolTotal) * 100) : 0;
      const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
      const shortName = m.name.replace("claude-orchestrator-", "").replace("claude-", "");
      lines.push(`    ${shortName}: ${bar} ${pct}% (${m.total})`);
    }
  }

  return lines.join("\n");
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
  // Stuck issues (revision loops)
  const stuckIssues = ctx.store.getStuckIssues(2);
  for (const issue of stuckIssues) {
    attentionItems.push(`🔁 Stuck: ${issue.source_ref} (${issue.revision_count} revisions)`);
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

  loadChatConversations();
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
        if (reply) await sendReply(reply);
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
