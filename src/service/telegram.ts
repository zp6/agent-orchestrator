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
import { findBranchForIssue, findExistingPRsForIssue, type GitHubIssue } from "../triggers/github.js";
import { getProviderStates } from "../service/provider-state.js";
import { loadGoals, measureGoalProgress, formatGoalsForTelegram } from "../orchestrator/goals.js";
import { runTeamMeeting } from "../orchestrator/team-meeting.js";
import { buildCalibrationReport, formatCalibrationForTelegram } from "../orchestrator/verification-calibrator.js";
import { deescalateAllEscalatedTasks, deescalateEscalatedTask, normaliseSourceRef } from "../cli/commands/deescalate.js";
import type { DigestSchedulerState } from "../service/slack-digest.js";
import { isScheduledTimeReached, todayLocalDateString } from "../service/slack-digest.js";
import { daemonStaleness } from "../utils/daemon-staleness.js";
import type { MonologueEntry } from "../state/store.js";
import {
  buildSubmissionsList,
  buildSubmissionShow,
  parseSubmissionId,
  tryHandleSubmissionApprove,
  tryHandleSubmissionReject,
} from "./telegram-submission-commands.js";

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

interface ResolvedIssueRef {
  repo: string;
  issueNumber: number;
  sourceRef: string;
}

const DEESCALATE_COMMANDS = new Set(["ack", "/ack", "dismiss", "/dismiss", "resolve", "/resolve", "deescalate", "/deescalate"]);

async function resolveIssueRef(rawIssueRef: string, repos: string[]): Promise<ResolvedIssueRef | null> {
  const trimmed = rawIssueRef.trim();
  const fullRefMatch = trimmed.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (fullRefMatch) {
    const repo = fullRefMatch[1];
    const issueNumber = parseInt(fullRefMatch[2], 10);
    return { repo, issueNumber, sourceRef: `${repo}#${issueNumber}` };
  }

  const bareNumberMatch = trimmed.match(/^\d+$/);
  if (!bareNumberMatch) return null;

  const issueNumber = parseInt(trimmed, 10);
  for (const repo of repos) {
    const raw = await ghAsync(`gh issue view ${issueNumber} --repo ${repo} --json number -q .number`);
    if (raw && raw.trim() === String(issueNumber)) {
      return { repo, issueNumber, sourceRef: `${repo}#${issueNumber}` };
    }
  }
  return null;
}

async function fetchIssueDetails(repo: string, issueNumber: number): Promise<(GitHubIssue & { state: string }) | null> {
  const raw = await ghAsync(`gh issue view ${issueNumber} --repo ${repo} --json number,title,body,url,state,labels`);
  if (!raw) return null;
  try {
    const issue = JSON.parse(raw) as {
      number: number;
      title: string;
      body: string | null;
      url: string;
      state: string;
      labels?: Array<{ name?: string }>;
    };
    return {
      repo,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      url: issue.url,
      state: issue.state,
      labels: (issue.labels ?? []).map((label) => label.name).filter((name): name is string => !!name),
      created_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function formatEscalatedTaskList(tasks: Array<{ source_ref: string | null; agent_name: string | null; title: string }>): string {
  return tasks.slice(0, 5).map((task) => {
    const ref = task.source_ref ?? task.title;
    const agent = task.agent_name ?? "unassigned";
    return `${ref} (${agent})`;
  }).join(", ");
}

function formatEscalatedTaskDetails(tasks: Array<{
  id: string;
  source_ref: string | null;
  agent_name: string | null;
  title: string;
  updated_at: string;
}>): string {
  const lines = tasks.map((task) => {
    const ref = task.source_ref ?? "no ref";
    const agent = task.agent_name ?? "unassigned";
    const ageHours = Math.round((Date.now() - new Date(task.updated_at).getTime()) / 3_600_000);
    const ageStr = ageHours < 1 ? "<1h ago" : `${ageHours}h ago`;
    return `  • ${task.id.slice(0, 8)} ${task.title.slice(0, 60)} — ${agent} — ${ref} — ${ageStr}`;
  });

  return `⚠️ *Escalated Tasks (${tasks.length})*\n\n${lines.join("\n")}\n\nUse \`deescalate <source_ref>\` or \`deescalate all\` to unblock.`;
}

function formatMonologueEntries(entries: MonologueEntry[]): string {
  if (entries.length === 0) {
    return "No monologue entries found.";
  }

  const lines = entries.map((entry) => {
    const ts = new Date(entry.created_at).toISOString().replace("T", " ").slice(0, 19);
    const shortTask = entry.task_id ? entry.task_id.slice(0, 8) : "no-task";
    return (
      `• ${ts} · ${entry.agent_name} · ${entry.kind} · \`${shortTask}\`\n` +
      `  ${entry.prose.replace(/\n/g, "\n  ")}`
    );
  });

  return `🗣️ *Monologue Feed*\n\n${lines.join("\n\n")}`;
}

async function handleTelegramEscalatedList(ctx: TelegramContext): Promise<string> {
  const escalated = ctx.store.findAllEscalatedTasks();
  if (escalated.length === 0) {
    return "No escalated tasks found.";
  }
  return formatEscalatedTaskDetails(escalated);
}

async function handleTelegramDeescalation(
  text: string,
  ctx: TelegramContext,
  repos: string[],
  command: string,
): Promise<string> {
  const parts = text.trim().split(/\s+/);
  const rawTarget = parts.slice(1).join(" ").trim();
  const reason = `Telegram ${command.replace(/^\//, "")} command`;

  if (!rawTarget) {
    const escalated = ctx.store.findAllEscalatedTasks();
    if (escalated.length === 0) {
      return "No escalated tasks found.";
    }
    if (escalated.length > 1) {
      return `Multiple escalations are active: ${formatEscalatedTaskList(escalated)}. Use "${command.replace(/^\//, "")} <source_ref>" or "${command.replace(/^\//, "")} all".`;
    }

    if (!escalated[0].source_ref) {
      return `❌ The active escalation does not have a source_ref. Use "${command.replace(/^\//, "")} all" or specify a source_ref explicitly.`;
    }

    try {
      const task = deescalateEscalatedTask(ctx.store, escalated[0].source_ref, reason);
      return `✅ De-escalated ${task.source_ref ?? task.title} (${task.id.slice(0, 8)})`;
    } catch (err) {
      return err instanceof Error ? `❌ ${err.message}` : `❌ ${String(err)}`;
    }
  }

  if (rawTarget.toLowerCase() === "all") {
    try {
      const count = deescalateAllEscalatedTasks(ctx.store, reason);
      return `✅ De-escalated ${count} task(s).`;
    } catch (err) {
      return err instanceof Error ? `❌ ${err.message}` : `❌ ${String(err)}`;
    }
  }

  const issueLike = /^\d+$/.test(rawTarget) || /^[\w.-]+\/[\w.-]+#\d+$/.test(rawTarget);
  const resolved = issueLike ? await resolveIssueRef(rawTarget, repos) : null;
  if (issueLike && !resolved) {
    return `❌ Could not resolve issue "${rawTarget}" in configured repos.`;
  }
  const sourceRef = resolved?.sourceRef ?? normaliseSourceRef(rawTarget);

  try {
    const task = deescalateEscalatedTask(ctx.store, sourceRef, reason);
    return `✅ De-escalated ${task.source_ref ?? sourceRef} (${task.id.slice(0, 8)})`;
  } catch (err) {
    return err instanceof Error ? `❌ ${err.message}` : `❌ ${String(err)}`;
  }
}

function buildGitHubIssueDispatchMessage(agentName: string, issue: GitHubIssue): string {
  let message = `GitHub Issue #${issue.number}: ${issue.title}${issue.labels.length > 0 ? `\nLabels: ${issue.labels.join(", ")}` : ""}\n\n${issue.body}\n\nURL: ${issue.url}`;

  const openPR = findExistingPRsForIssue(issue.repo, issue.number).find((pr) => pr.state === "open");
  if (openPR) {
    message += `\n\n⚠️ This issue already has an open ${openPR.isDraft ? "draft " : ""}PR: #${openPR.number} (${openPR.url}). Do NOT create a new branch or open another PR. Instead, review the existing PR, make any needed fixes, and push to its branch.`;
    message += `\n\n---\nWhen done: commit your changes and push to the existing PR branch. Do NOT run \`gh pr create\`.`;
    return message;
  }

  const existingBranch = findBranchForIssue(issue.repo, issue.number);
  if (existingBranch) {
    message += `\n\n⚠️ A branch for this issue already exists: \`${existingBranch}\`. Do NOT create a new branch. Check out this branch, continue the work, and open a PR when ready.`;
    message += `\n\n---\nWhen done: push to branch \`${existingBranch}\` and open a PR with \`gh pr create --head ${existingBranch} --title "[${agentName}] <title>" --body "Closes #${issue.number}"\`.`;
    return message;
  }

  message += `\n\n---\nWhen done: create a branch, commit, push, and open a PR with \`gh pr create --title "[${agentName}] <title>" --body "Closes #${issue.number}"\`. The "Closes #${issue.number}" is required so the issue auto-closes on merge.`;
  return message;
}

export async function handleCommand(text: string, ctx: TelegramContext): Promise<string> {
  const cmd = text.trim().toLowerCase();
  const repos = [...new Set(Object.values(ctx.config.agents).map((a) => a.github).filter(Boolean))] as string[];

  if (DEESCALATE_COMMANDS.has(cmd.split(/\s+/)[0])) {
    return await handleTelegramDeescalation(text, ctx, repos, cmd.split(/\s+/)[0]);
  }

  if (cmd === "escalated" || cmd === "/escalated") {
    return await handleTelegramEscalatedList(ctx);
  }

  if (cmd === "monologue" || cmd === "/monologue" || cmd.startsWith("monologue ") || cmd.startsWith("/monologue ")) {
    const parts = text.trim().split(/\s+/).slice(1);
    let agentFilter: string | undefined;
    let limit = 10;
    for (const part of parts) {
      if (/^\d+$/.test(part)) {
        limit = Math.min(Math.max(parseInt(part, 10), 1), 25);
      } else if (!agentFilter) {
        agentFilter = part;
      }
    }

    const entries = ctx.store.getMonologue({
      agent_name: agentFilter,
      limit,
    }).reverse();
    if (entries.length === 0) {
      return agentFilter
        ? `No monologue entries found for ${agentFilter}.`
        : "No monologue entries found.";
    }
    return formatMonologueEntries(entries);
  }

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
        const res = await fetch(`http://localhost:${port}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(5000),
        });
        return res.ok ? `✅ ${name}` : `❌ ${name} (${res.status})`;
      } catch {
        return `❌ ${name} (unreachable)`;
      }
    }));

    // Daemon staleness check
    const staleness = daemonStaleness();
    let stalenessLine: string;
    if (staleness.error) {
      stalenessLine = `❓ Staleness: unable to determine`;
    } else if (staleness.commitsBehind === 0) {
      stalenessLine = `✅ Up to date (\`${staleness.currentHash}\`)`;
    } else {
      const icon = staleness.isStale ? "⚠️" : "ℹ️";
      stalenessLine = `${icon} ${staleness.commitsBehind} commit${staleness.commitsBehind === 1 ? "" : "s"} behind origin/main (\`${staleness.currentHash}\`)`;
    }

    return `🏥 *Health*\n\n${checks.join("\n")}\n\n📦 *Daemon version*\n${stalenessLine}`;
  }

  // Guard Health (PR guard surge suppression metrics, issue #1163)
  if (cmd === "guard-health" || cmd === "/guard-health") {
    try {
      const res = await fetch("http://localhost:3472/guard-health", { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return `❌ Failed to fetch guard metrics (${res.status})`;
      }
      const data = (await res.json()) as {
        metrics: { total_hits: number; leaked_hits: number; active_suppressions: number; suppressions: Array<{ repo: string; issue_number: number; minutes_remaining: number }> };
      };
      const { metrics } = data;
      const suppressionsList = metrics.suppressions
        .map((s) => `  \`${s.repo}#${s.issue_number}\` (${s.minutes_remaining}m remaining)`)
        .slice(0, 5)
        .join("\n");
      const suppText = metrics.active_suppressions > 5 ? `${suppressionsList}\n  ... and ${metrics.active_suppressions - 5} more` : suppressionsList;
      const leakAlert = metrics.leaked_hits > 0 ? ` ⚠️ *LEAKED: ${metrics.leaked_hits} hits after suppression*` : "";
      return (
        `🛡️ *Guard Health* (24h)\n\n` +
        `📊 Total hits: ${metrics.total_hits}\n` +
        `🚫 Leaked hits: ${metrics.leaked_hits}${leakAlert ? " — potential suppression failure" : ""}\n` +
        `🔒 Active suppressions: ${metrics.active_suppressions}\n` +
        (suppText ? `\n*Active:*\n${suppText}` : "")
      );
    } catch (err) {
      return `❌ Guard health check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Issues (parallel across repos)
  if (cmd === "issues" || cmd === "/issues") {
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

  // Issue status — pre-dispatch inspection by issue number
  // Matches: "issue 123", "issue status 123", "/issue 123", "/issue status 123"
  {
    const issueStatusMatch = text.trim().match(/^\/?\s*issue\s+(?:status\s+)?(\d+)\s*$/i);
    if (issueStatusMatch) {
      const issueNumber = parseInt(issueStatusMatch[1], 10);
      // Try each repo to find the issue
      let foundRepo: string | null = null;
      for (const repo of repos) {
        const raw = await ghAsync(`gh issue view ${issueNumber} --repo ${repo} --json number -q .number`);
        if (raw && raw.trim() === String(issueNumber)) {
          foundRepo = repo;
          break;
        }
      }
      if (!foundRepo) return `❌ Issue #${issueNumber} not found in any configured repo.`;
      const { getIssueStatus, formatIssueStatusTelegram } = await import("../cli/commands/issue-status.js");
      const result = await getIssueStatus(foundRepo, issueNumber, ctx.store);
      return formatIssueStatusTelegram(result);
    }
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

    const client = new AgentClient(ctx.config, ctx.store);
    client.emitMonologue(
      agentName,
      null,
      "plan",
      "I am opening a direct chat session and will answer the operator's request now.",
    );

    // Send "thinking..." then edit with response
    const thinkingId = await sendReply(`💭 ${agentName} is thinking...`);

    client.send(agentName, message, { conversationId })
      .then(async (response) => {
        client.emitMonologue(
          agentName,
          null,
          "reflection",
          "I have finished the direct chat response and am handing the answer back.",
        );
        const reply = response.content.slice(0, 3900);
        if (thinkingId) {
          await editMessage(thinkingId, `🤖 *${agentName}*\n\n${reply}`);
        } else {
          await sendReply(`�� *${agentName}*\n\n${reply}`);
        }
      })
      .catch(async (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        client.emitMonologue(
          agentName,
          null,
          "escalation",
          "The direct chat request failed, so I am logging the blocker and surfacing the error.",
        );
        if (thinkingId) {
          await editMessage(thinkingId, `❌ ${agentName} error: ${errMsg.slice(0, 200)}`);
        } else {
          await sendReply(`❌ ${agentName} error: ${errMsg.slice(0, 200)}`);
        }
      });

    return ""; // Don't send another reply — "thinking..." is already sent
  }

  // Team meetings (fire-and-forget — takes a few minutes)
  if (cmd === "meeting" || cmd === "/meeting" || cmd === "standup" || cmd === "/standup") {
    runTeamMeeting(ctx.config, ctx.store, { type: "standup" })
      .then((summary) => {
        const responded = summary.rounds[0]?.entries.filter((p) => p.response).length ?? 0;
        sendReply(`✅ Standup complete — ${summary.rounds.length} rounds, ${summary.actionItems.length} actions, ${responded} agents`);
      })
      .catch((e) => sendReply(`❌ Standup failed: ${e instanceof Error ? e.message : String(e)}`));
    return "🤝 Starting standup — querying all agents...";
  }

  if (cmd === "bluesky" || cmd === "/bluesky") {
    runTeamMeeting(ctx.config, ctx.store, { type: "bluesky" })
      .then((summary) => {
        const responded = summary.rounds[0]?.entries.filter((p) => p.response).length ?? 0;
        sendReply(`✅ Blue sky complete — ${summary.rounds.length} rounds, ${summary.actionItems.length} ideas, ${responded} agents`);
      })
      .catch((e) => sendReply(`❌ Blue sky failed: ${e instanceof Error ? e.message : String(e)}`));
    return "🚀 Starting blue sky session — 3 rounds of creative thinking...";
  }

  // Standup quality trend digest (issue #591)
  // Usage: standup-quality [agent] [days]
  //   agent — filter to a single agent name (optional, default: all)
  //   days  — rolling window in days (optional, default: 30)
  if (cmd === "standup-quality" || cmd === "/standup-quality" || cmd.startsWith("standup-quality ") || cmd.startsWith("/standup-quality ")) {
    const parts = text.trim().split(/\s+/).slice(1);
    let agentFilter: string | null = null;
    let days = 30;
    // Parse positional args: first non-numeric = agent, first numeric = days
    for (const part of parts) {
      if (/^\d+$/.test(part)) {
        days = Math.min(Math.max(parseInt(part, 10), 1), 90);
      } else {
        agentFilter = part;
      }
    }
    const trends = ctx.store.getStandupQualityTrend(agentFilter, days);
    if (trends.length === 0) {
      return agentFilter
        ? `📊 No standup quality data for *${agentFilter}* in the last ${days} days.`
        : `📊 No standup quality data recorded in the last ${days} days.`;
    }
    const lines: string[] = [`📊 *Standup Quality — last ${days} days*\n`];
    for (const t of trends) {
      const spark = t.scores.map((s) => {
        if (s >= 0.9) return "█";
        if (s >= 0.7) return "▆";
        if (s >= 0.5) return "▄";
        return "▂";
      }).join("");
      const avgStr = t.avg_score !== null ? t.avg_score.toFixed(2) : "n/a";
      const latestStr = t.latest_score !== null ? t.latest_score.toFixed(2) : "n/a";
      const trendIcon = { improving: "📈", stable: "➡️", declining: "📉", insufficient_data: "❓" }[t.trend];
      const streakFlag = t.low_streak ? " ⚠️ *LOW STREAK* (last 3 < 0.70)" : "";
      lines.push(
        `*${t.agent_name}*\n` +
        `${spark}\n` +
        `avg: ${avgStr} · latest: ${latestStr} · ${trendIcon} ${t.trend}${streakFlag}`,
      );
    }
    return lines.join("\n\n");
  }

  // Verification calibration report
  if (cmd === "calibrate" || cmd === "/calibrate") {
    const report = buildCalibrationReport(ctx.store);
    return formatCalibrationForTelegram(report) || "No calibration data yet.";
  }

  // Request an ad-hoc meeting
  if (cmd.startsWith("request-meeting ") || cmd.startsWith("/request-meeting ")) {
    const parts = text.trim().split(/\s+/).slice(1);
    let format: string | undefined;
    let topic: string;
    if (parts[0] === "--format" && parts[1]) {
      format = parts[1];
      topic = parts.slice(2).join(" ");
    } else {
      topic = parts.join(" ");
    }
    if (!topic) return "Usage: request-meeting [--format rfc|retrospective|design-review|triage|incident-postmortem|investigation-spike] <topic>";
    const validFormats = ["rfc", "retrospective", "design-review", "triage", "incident-postmortem", "investigation-spike"];
    if (format && !validFormats.includes(format)) {
      return `❌ Unknown format "${format}". Available: ${validFormats.join(", ")}`;
    }
    ctx.store.writeSignal({
      agent: "operator",
      signal_type: "meeting_request",
      key: topic.slice(0, 50).replace(/\s+/g, "-").toLowerCase(),
      value: JSON.stringify({ topic, suggestedFormat: format, urgency: "normal" }),
      confidence: 0.9,
      ttl_hours: 168,
    });
    return `✅ Meeting request filed: "${topic}"${format ? ` (suggested format: ${format})` : ""}\nThe facilitator will evaluate and schedule it.`;
  }

  // List pending meeting requests
  if (cmd === "meetings" || cmd === "/meetings") {
    const signals = ctx.store.readSignals({ signal_type: "meeting_request", limit: 10 });
    if (signals.length === 0) return "No pending meeting requests.";
    const lines = signals.map((s) => {
      const val = s.value ? JSON.parse(s.value) : {};
      return `• ${val.topic ?? s.key} (from ${s.agent}${val.suggestedFormat ? `, format: ${val.suggestedFormat}` : ""})`;
    });
    return `*Pending Meeting Requests (${signals.length}):*\n${lines.join("\n")}`;
  }

  // Reset PR escalation
  if (cmd.startsWith("reset-pr ") || cmd.startsWith("/reset-pr ")) {
    const ref = text.trim().split(/\s+/)[1];
    if (!ref) return "Usage: reset-pr owner/repo#123";
    const match = ref.match(/^(.+?)#(\d+)$/);
    if (!match) return "Usage: reset-pr owner/repo#123";
    const count = ctx.store.clearPRReviewEscalation(match[1], parseInt(match[2], 10));
    return count > 0
      ? `✅ Cleared escalation for ${ref} — reviewer will re-review next cycle`
      : `⚠️ No escalated review found for ${ref}`;
  }

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

  if (cmd.startsWith("reassign ") || cmd.startsWith("/reassign ")) {
    const parts = text.trim().split(/\s+/);
    const rawIssueRef = parts[1];
    const agentName = parts[2];
    if (!rawIssueRef || !agentName) return "Usage: /reassign <issue-id|owner/repo#N> <agent-name>";
    if (!ctx.config.agents[agentName]) return `❌ Unknown agent. Available: ${Object.keys(ctx.config.agents).join(", ")}`;

    const resolved = await resolveIssueRef(rawIssueRef, repos);
    if (!resolved) return `❌ Could not resolve issue "${rawIssueRef}" in configured repos.`;

    const issue = await fetchIssueDetails(resolved.repo, resolved.issueNumber);
    if (!issue) return `❌ Failed to load ${resolved.sourceRef} from GitHub.`;
    if (issue.state.toLowerCase() !== "open") return `❌ ${resolved.sourceRef} is ${issue.state.toLowerCase()}, not open.`;

    ctx.store.clearFailureHistoryForSourceRef("github", resolved.sourceRef);
    ctx.store.removeProcessedTrigger("github", resolved.sourceRef);

    const latestTask = ctx.store.findAllTasksBySourceRef(resolved.sourceRef)[0];
    if (latestTask) {
      ctx.store.addLog({
        task_id: latestTask.id,
        direction: "system",
        content: `Operator reassigned via Telegram to ${agentName}; failure history cleared.`,
      });
    }

    const message = buildGitHubIssueDispatchMessage(agentName, issue);
    ctx.dispatcher.dispatch(message, {
      agentName,
      source: "github",
      sourceRef: resolved.sourceRef,
      title: `[${issue.repo}#${issue.number}] ${issue.title}`,
    })
      .then((r) => sendReply(`✅ Reassigned ${resolved.sourceRef} to ${agentName} (${r.taskId})`))
      .catch((e) => sendReply(`❌ Reassign failed for ${resolved.sourceRef}: ${e instanceof Error ? e.message : String(e)}`));
    return `🔀 Reassigning ${resolved.sourceRef} to ${agentName} now...`;
  }

  if (cmd.startsWith("prioritize ") || cmd.startsWith("/prioritize ")) {
    const parts = text.trim().split(/\s+/);
    const rawIssueRef = parts[1];
    if (!rawIssueRef) return "Usage: /prioritize <issue-id|owner/repo#N>";

    const resolved = await resolveIssueRef(rawIssueRef, repos);
    if (!resolved) return `❌ Could not resolve issue "${rawIssueRef}" in configured repos.`;

    const issue = await fetchIssueDetails(resolved.repo, resolved.issueNumber);
    if (!issue) return `❌ Failed to load ${resolved.sourceRef} from GitHub.`;
    if (issue.state.toLowerCase() !== "open") return `❌ ${resolved.sourceRef} is ${issue.state.toLowerCase()}, not open.`;

    ctx.store.boostSourceRefPriority("github", resolved.sourceRef);
    ctx.store.removeProcessedTrigger("github", resolved.sourceRef);

    const latestTask = ctx.store.findAllTasksBySourceRef(resolved.sourceRef)[0];
    if (latestTask) {
      ctx.store.addLog({
        task_id: latestTask.id,
        direction: "system",
        content: "Operator priority boost via Telegram.",
      });
    }

    return `⚡ Prioritized ${resolved.sourceRef} for the next daemon cycle.`;
  }

  // Antibodies — failure immunity panel
  if (cmd === "antibodies" || cmd === "/antibodies") {
    return buildAntibodiesPanel(ctx);
  }

  // Approval queue — list pending borderline tasks awaiting operator decision
  if (cmd === "queue" || cmd === "/queue") {
    const entries = ctx.store.getPendingApprovalQueue(15);
    if (entries.length === 0) {
      return "✅ No tasks awaiting operator approval.";
    }
    const lines = entries.map((e) => {
      const shortId = e.task_id.slice(0, 8);
      const pct = (e.score * 100).toFixed(0);
      const agent = (e.agent_name ?? "?").replace("claude-orchestrator-", "").replace("claude-", "");
      return `  • \`${shortId}\` ${e.title.slice(0, 50)} — ${pct}% — ${agent}`;
    });
    return (
      `⏳ *Pending Approvals (${entries.length})*\n\n${lines.join("\n")}\n\n` +
      `Use \`/approve <id>\` to force-approve or \`/reject <id>\` to confirm rejection.`
    );
  }

  // ── Submission queue (issue #1608, layer 3 of #1512) ────────────────────
  // Telegram-side surface for the pending_submissions table. Mirrors
  // `orch submission ...` so the operator can approve/reject from their
  // phone without SSH'ing into the host.
  //
  // Per CLAUDE.md operator-comms discipline, external-platform submissions
  // are an explicit Telegram-signal class (irreversible commitments needing
  // operator sign-off). The pinger in submission-pinger.ts pages the
  // operator once when a row lands; these handlers let them respond.

  if (cmd === "submissions" || cmd === "/submissions") {
    return buildSubmissionsList(ctx.store);
  }

  if (cmd.startsWith("submission-show ") || cmd.startsWith("/submission-show ")) {
    const arg = text.trim().split(/\s+/)[1];
    const id = parseSubmissionId(arg);
    if (id == null) {
      return "Usage: /submission-show <id>\nExample: /submission-show 7";
    }
    return buildSubmissionShow(ctx.store, id);
  }

  if (cmd.startsWith("submission-approve ") || cmd.startsWith("/submission-approve ")) {
    const arg = text.trim().split(/\s+/)[1];
    if (parseSubmissionId(arg) == null) {
      return "Usage: /submission-approve <id>\nExample: /submission-approve 7";
    }
    const r = tryHandleSubmissionApprove(ctx.store, arg);
    return r.reply;
  }

  if (cmd.startsWith("submission-reject ") || cmd.startsWith("/submission-reject ")) {
    const parts = text.trim().split(/\s+/);
    const arg = parts[1];
    const reason = parts.slice(2).join(" ");
    if (parseSubmissionId(arg) == null) {
      return "Usage: /submission-reject <id> <reason>\nExample: /submission-reject 7 \"severity inflated\"";
    }
    const r = tryHandleSubmissionReject(ctx.store, arg, reason);
    return r.reply;
  }

  // /approve <taskId> [reason] — operator force-approves a borderline-rejected task
  if (cmd.startsWith("approve ") || cmd.startsWith("/approve ")) {
    const parts = text.trim().split(/\s+/);
    const shortId = parts[1];
    const reason = parts.slice(2).join(" ");

    if (!shortId) return "Usage: /approve <task-id> [reason]\nExample: /approve 01KPFBW5\nExample: /approve 01KPFBW5 \"Prototype only, not production\"";

    // Disambiguation: integer-only arg = pending_submission id, ULID arg =
    // borderline-task id. ULIDs always contain alpha chars (Crockford base32),
    // so /^\d+$/ unambiguously means the operator wants the submission queue.
    const submissionMatch = tryHandleSubmissionApprove(ctx.store, shortId);
    if (submissionMatch.matched) return submissionMatch.reply;

    const entry = ctx.store.getApprovalQueueEntryByShortId(shortId);
    if (!entry) {
      return (
        `❌ No approval queue entry found for \`${shortId}\`.\n` +
        `Use \`/queue\` to see pending items.`
      );
    }
    if (entry.status !== "pending") {
      return `⚠️ Task \`${shortId}\` is already *${entry.status}*.`;
    }

    // Threshold for requiring a reason: default 0.40 (40%)
    const VERY_LOW_SCORE_THRESHOLD = 0.40;

    // Check if score is very low and no reason provided
    if (entry.score < VERY_LOW_SCORE_THRESHOLD && !reason) {
      const scoreStr = (entry.score * 100).toFixed(0);
      return (
        `⚠️ Task score is very low (${scoreStr}%). Provide a reason:\n` +
        `/approve ${shortId} <reason>\n\n` +
        `Example: /approve ${shortId} "Prototype only, not production"`
      );
    }

    // Score provenance guard (reviewer#485): warn the operator when the score
    // came from a parse-error default rather than the reviewer LLM.
    // Operator can still approve but must provide a reason — the score is not
    // meaningful and they are taking explicit responsibility.
    const task = ctx.store.getTask(entry.task_id);
    const hasProvenanceGuard = task?.verification_notes?.includes("[Score provenance guard]") ?? false;
    if (hasProvenanceGuard && !reason) {
      return (
        `⚠️ This task's score is a parse-error default — the reviewer could not assess it properly.\n` +
        `Approve only if you have reviewed the work directly. Provide a reason:\n` +
        `/approve ${shortId} <reason>\n\n` +
        `Example: /approve ${shortId} "Reviewed PR manually, work is correct"`
      );
    }

    // Force-approve: mark task as approved and resolve queue entry
    ctx.store.updateTask(entry.task_id, { verification_status: "approved" });
    ctx.store.resolveApprovalQueueEntry(entry.id, "approved", "operator", reason || undefined);

    const scoreStr = (entry.score * 100).toFixed(0);
    const reasonSuffix = reason ? ` with reason: "${reason}"` : "";
    ctx.store.addLog({
      task_id: entry.task_id,
      direction: "system",
      content: `Operator force-approved via Telegram (score ${scoreStr}%, bypassing quality threshold)${reasonSuffix}.`,
    });

    return (
      `✅ Task \`${shortId}\` force-approved by operator.\n` +
      `*Title:* ${entry.title.slice(0, 80)}\n` +
      `*Score:* ${scoreStr}% (quality gate bypassed)` +
      (reason ? `\n*Reason:* ${reason}` : "")
    );
  }

  // /reject <taskId> — operator confirms rejection of a borderline task
  if (cmd.startsWith("reject ") || cmd.startsWith("/reject ")) {
    const parts = text.trim().split(/\s+/);
    const shortId = parts[1];
    if (!shortId) return "Usage: /reject <task-id>\nExample: /reject 01KPFBW5";

    // Disambiguation: integer-only arg → submission queue. /reject of a
    // submission requires a reason (audit trail). Falls through to the
    // existing task path for ULID short-ids.
    const submissionReason = parts.slice(2).join(" ");
    const submissionMatch = tryHandleSubmissionReject(ctx.store, shortId, submissionReason);
    if (submissionMatch.matched) return submissionMatch.reply;

    const entry = ctx.store.getApprovalQueueEntryByShortId(shortId);
    if (!entry) {
      return (
        `❌ No approval queue entry found for \`${shortId}\`.\n` +
        `Use \`/queue\` to see pending items.`
      );
    }
    if (entry.status !== "pending") {
      return `⚠️ Task \`${shortId}\` is already *${entry.status}*.`;
    }

    ctx.store.resolveApprovalQueueEntry(entry.id, "rejected", "operator");
    ctx.store.addLog({
      task_id: entry.task_id,
      direction: "system",
      content: "Operator confirmed rejection via Telegram.",
    });

    const scoreStr = (entry.score * 100).toFixed(0);
    return (
      `❌ Task \`${shortId}\` rejected by operator.\n` +
      `*Title:* ${entry.title.slice(0, 80)}\n` +
      `*Score:* ${scoreStr}%`
    );
  }

  // Help
  // Config — show reload history and current config snapshot
  if (cmd === "config" || cmd === "/config") {
    return buildConfigStatus(ctx);
  }

  if (cmd === "help" || cmd === "/help" || cmd === "/start") {
    return `🤖 *Commands*

s — executive summary
stats — detailed metrics
status — agent status
health — ping containers
issues — open issues
prs — open PRs
queue — pending operator approvals
/approve <id> — force-approve borderline task (or submission, if numeric id)
/reject <id> — confirm task rejection (or submission, if numeric id)
/submissions — pending crypto-submission approvals (#1608)
/submission-show <id> — full submission body
/submission-approve <id> — approve a submission for shipping
/submission-reject <id> <reason> — reject a submission
antibodies — failure immunity panel
config — config reload history & status
chat <agent> <msg> — talk to agent (persistent)
newchat <agent> — reset conversation
issue <N> — pre-dispatch issue inspection
issue <idea> — create issue from rough idea
dispatch <agent> <msg> — send task
/monologue [agent] — recent prose monologue entries
/reassign <issue> <agent> — reroute issue now
/prioritize <issue> — move issue to front next cycle
/pause <task-id> — pause an in-flight task
/resume <task-id> — resume a paused task
/redirect <task-id> <agent> — redirect task to different agent
/inject <task-id> <text> — inject directive into task context
/controls — list recent operator controls
ack|dismiss|resolve <ref|all> — de-escalate an active alert or task
escalated — list active escalations
deescalate <ref|all> — unblock escalated tasks
/security-exemptions [repo] — list security FP exemptions
/security-exempt <repo> <file> <pattern> <reason> — add FP exemption
/security-unexempt <repo> <file> <pattern> — remove FP exemption
help — this message`;
  }

  // /pause <task-id> — pause an in-flight task
  if (cmd.startsWith("pause ") || cmd.startsWith("/pause ")) {
    const parts = text.trim().split(/\s+/);
    const taskId = parts[1];
    if (!taskId) return "Usage: /pause <task-id>";
    const task = ctx.store.getTask(taskId);
    if (!task) return `❌ Task \`${taskId}\` not found.`;
    const from = (ctx as TelegramContext & { _from?: string })._from ?? "operator";
    ctx.store.addOperatorControl({ task_id: taskId, control_type: "pause", operator: from });
    return `✅ Task \`${taskId}\` paused — will be skipped until resumed`;
  }

  // /resume <task-id> — resume a paused task
  if (cmd.startsWith("resume ") || cmd.startsWith("/resume ")) {
    const parts = text.trim().split(/\s+/);
    const taskId = parts[1];
    if (!taskId) return "Usage: /resume <task-id>";
    const task = ctx.store.getTask(taskId);
    if (!task) return `❌ Task \`${taskId}\` not found.`;
    const from = (ctx as TelegramContext & { _from?: string })._from ?? "operator";
    ctx.store.addOperatorControl({ task_id: taskId, control_type: "resume", operator: from });
    return `✅ Task \`${taskId}\` resumed — queued for dispatch`;
  }

  // /redirect <task-id> <agent-name> — redirect task to a different agent
  if (cmd.startsWith("redirect ") || cmd.startsWith("/redirect ")) {
    const parts = text.trim().split(/\s+/);
    const taskId = parts[1];
    const agentName = parts[2];
    if (!taskId || !agentName) return "Usage: /redirect <task-id> <agent-name>";
    const task = ctx.store.getTask(taskId);
    if (!task) return `❌ Task \`${taskId}\` not found.`;
    if (!ctx.config.agents[agentName]) return `❌ Unknown agent. Available: ${Object.keys(ctx.config.agents).join(", ")}`;
    const from = (ctx as TelegramContext & { _from?: string })._from ?? "operator";
    ctx.store.addOperatorControl({ task_id: taskId, control_type: "redirect", value: agentName, operator: from });
    return `✅ Task \`${taskId}\` redirected to \`${agentName}\``;
  }

  // /inject <task-id> <directive text...> — inject additional context into a task
  if (cmd.startsWith("inject ") || cmd.startsWith("/inject ")) {
    const parts = text.trim().split(/\s+/);
    const taskId = parts[1];
    const directive = parts.slice(2).join(" ");
    if (!taskId || !directive) return "Usage: /inject <task-id> <directive text...>";
    const task = ctx.store.getTask(taskId);
    if (!task) return `❌ Task \`${taskId}\` not found.`;
    const from = (ctx as TelegramContext & { _from?: string })._from ?? "operator";
    ctx.store.addOperatorControl({ task_id: taskId, control_type: "inject", value: directive, operator: from });
    return `✅ Directive injected into task \`${taskId}\``;
  }

  // /controls — list recent operator controls (last 10)
  if (cmd === "controls" || cmd === "/controls") {
    const controls = ctx.store.getOperatorControls(10);
    if (controls.length === 0) return "🎛 No operator controls recorded yet.";
    const lines = controls.map((c) => {
      const shortId = c.task_id.slice(0, 8);
      const typeLabel = c.control_type === "redirect" && c.value
        ? `redirect→${c.value}`
        : c.control_type;
      const statusIcon = c.status === "applied" ? "✅" : c.status === "failed" ? "❌" : "⏳";
      const ts = c.applied_at
        ? new Date(c.applied_at).toISOString().slice(0, 16).replace("T", " ")
        : new Date(c.created_at).toISOString().slice(0, 16).replace("T", " ");
      return `  • ${statusIcon} ${shortId} | ${typeLabel} | ${c.status} | ${ts}`;
    });
    return `🎛 *Operator Controls* (last 10)\n\n${lines.join("\n")}`;
  }

  // Monologue — agent prose narrative logs (issue #1383)
  if (cmd === "monologue" || cmd === "/monologue" || cmd.startsWith("monologue ") || cmd.startsWith("/monologue ")) {
    const parts = text.trim().split(/\s+/).slice(1);
    const agentFilter = parts[0] || null;
    const limit = 10;

    const entries = ctx.store.getMonologue({
      agent_name: agentFilter ?? undefined,
      limit,
    });

    if (entries.length === 0) {
      return agentFilter
        ? `🎙 No monologue entries for *${agentFilter}*.`
        : "🎙 No monologue entries yet.";
    }

    const kindIcons: Record<string, string> = {
      plan: "📋", observation: "👁", decision: "⚖️",
      execution: "⚙️", reflection: "💭", escalation: "🚨",
    };

    const lines = [...entries].reverse().map((e) => {
      const ts = e.created_at.slice(11, 16); // HH:MM
      const icon = kindIcons[e.kind] ?? "•";
      const task = e.task_id ? ` [${e.task_id.slice(0, 8)}]` : "";
      const prose = e.prose.replace(/\n/g, " ").slice(0, 140);
      return `${icon} *${ts}* ${e.agent_name}${task}\n  ${prose}${e.prose.length > 140 ? "…" : ""}`;
    });

    const header = agentFilter
      ? `🎙 *Monologue — ${agentFilter}* (last ${entries.length})`
      : `🎙 *Monologue — fleet* (last ${entries.length})`;

    return `${header}\n\n${lines.join("\n\n")}`;
  }

  // /security-exemptions [repo] — list active FP exemptions (issue #1612)
  if (
    cmd === "security-exemptions" ||
    cmd === "/security-exemptions" ||
    cmd.startsWith("security-exemptions ") ||
    cmd.startsWith("/security-exemptions ")
  ) {
    const repoFilter = text.trim().split(/\s+/)[1] || undefined;
    const exemptions = ctx.store.listSecurityFpExemptions(repoFilter);
    if (exemptions.length === 0) {
      return repoFilter
        ? `🛡️ No security FP exemptions for \`${repoFilter}\`.`
        : "🛡️ No security FP exemptions registered.\n\nUse `/security-exempt <owner/repo> <file-path> <pattern-name> <reason>` to add one.";
    }
    const lines = exemptions.slice(0, 20).map((e) => {
      const ts = e.created_at.slice(0, 10);
      const repo = e.repo === "*" ? "*(all repos)*" : `\`${e.repo}\``;
      const filePath = e.file_path === "*" ? "*(all files)*" : `\`${e.file_path}\``;
      return `• ${repo} / ${filePath}\n  Pattern: \`${e.pattern_name}\`\n  _${e.reason}_ (${ts})`;
    });
    if (exemptions.length > 20) lines.push(`…+${exemptions.length - 20} more`);
    const heading = repoFilter
      ? `🛡️ *Security FP Exemptions — ${repoFilter}* (${exemptions.length})`
      : `🛡️ *Security FP Exemptions* (${exemptions.length})`;
    return `${heading}\n\n${lines.join("\n\n")}`;
  }

  // /security-exempt <owner/repo> <file-path> <pattern-name> <reason...>
  if (cmd.startsWith("security-exempt ") || cmd.startsWith("/security-exempt ")) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 5) {
      return (
        "Usage: `/security-exempt <owner/repo> <file-path> <pattern-name> <reason...>`\n\n" +
        "Example:\n`/security-exempt rapartlu/agent-proxy docker-compose.generated.yml " +
        "\"Docker Compose env_file referencing plaintext .env\" Intentional non-secret env_file`"
      );
    }
    const [, repo, filePath, patternName, ...reasonParts] = parts;
    const reason = reasonParts.join(" ");
    ctx.store.addSecurityFpExemption({ repo, file_path: filePath, pattern_name: patternName, reason });
    return (
      `✅ Security FP exemption registered:\n` +
      `*Repo:* \`${repo}\`\n` +
      `*File:* \`${filePath}\`\n` +
      `*Pattern:* \`${patternName}\`\n` +
      `*Reason:* ${reason}\n\n` +
      `Future scan cycles will skip this finding automatically.`
    );
  }

  // /security-unexempt <owner/repo> <file-path> <pattern-name>
  if (cmd.startsWith("security-unexempt ") || cmd.startsWith("/security-unexempt ")) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 4) {
      return "Usage: `/security-unexempt <owner/repo> <file-path> <pattern-name>`";
    }
    const [, repo, filePath, patternName] = parts;
    const removed = ctx.store.removeSecurityFpExemption(repo, filePath, patternName);
    return removed
      ? `✅ Security FP exemption removed for:\n\`${repo}\` / \`${filePath}\` / \`${patternName}\`\n\nThe scanner will resume flagging this triple.`
      : `⚠️ No exemption found for:\n\`${repo}\` / \`${filePath}\` / \`${patternName}\``;
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

${buildTokenStats(ctx)}

${buildGoalsSummary(ctx)}`;
}

/**
 * Build the /config Telegram response: recent reload history and a compact
 * snapshot of the live config.
 */
function buildConfigStatus(ctx: TelegramContext): string {
  const reloads = ctx.store.getRecentConfigReloads(5);

  // Recent reload history
  const historyLines: string[] = [];
  if (reloads.length === 0) {
    historyLines.push("  No reload history recorded yet.");
  } else {
    for (const r of reloads) {
      const ts = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 16);
      const icon = r.success ? "✅" : "❌";
      const trigger = r.triggered_by === "startup" ? "startup" : r.triggered_by;
      if (!r.success) {
        const errs = r.errors_json ? (JSON.parse(r.errors_json) as string[]).slice(0, 2).join("; ") : "validation failed";
        historyLines.push(`  ${icon} ${ts} [${trigger}] — ${errs}`);
      } else if (r.change_count === 0) {
        historyLines.push(`  ${icon} ${ts} [${trigger}] — no changes`);
      } else {
        const paths = r.changes_json ? (JSON.parse(r.changes_json) as string[]).join(", ") : `${r.change_count} change(s)`;
        historyLines.push(`  ${icon} ${ts} [${trigger}] — ${paths}`);
      }
    }
  }

  // Compact config snapshot
  const agentCount = Object.keys(ctx.config.agents).length;
  const verificationOn = ctx.config.verification?.enabled !== false;
  const providerNames = Object.keys(ctx.config.providers ?? {});
  const providerStr = providerNames.length > 0 ? providerNames.join(", ") : "claude (default)";
  const timeoutSec = Math.round((ctx.config.proxy.timeout_ms ?? 120000) / 1000);

  const configLines = [
    `  Agents: ${agentCount}`,
    `  Verification: ${verificationOn ? "enabled" : "disabled"}`,
    `  Providers: ${providerStr}`,
    `  Proxy timeout: ${timeoutSec}s`,
  ];

  return `🔧 *Config Status*

*Recent Reloads*
${historyLines.join("\n")}

*Live Config*
${configLines.join("\n")}`;
}

function buildTokenStats(ctx: TelegramContext): string {
  const providerUsage = ctx.store.getTokenUsageByProvider(24);
  if (providerUsage.length === 0) return "";

  const providerStates = getProviderStates();
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

    // Overall status icon — exhausted providers get a special indicator
    const provState = providerStates.get(usage.provider);
    const dayLimit = limits?.daily ?? prov?.daily_token_limit;
    const pct = dayLimit ? Math.round((usage.total / dayLimit) * 100) : null;
    const icon = provState?.exhausted
      ? "⛔"
      : pct !== null && pct >= 80 ? "🔴" : pct !== null && pct >= 50 ? "🟡" : "🟢";
    const exhaustedStr = provState?.exhausted
      ? ` RATE LIMITED${provState.resetAt ? ` (resets ${provState.resetAt.toLocaleTimeString()})` : ""}`
      : "";

    lines.push(`  ${icon} ${usage.provider}: ${windows.join(" | ")}${exhaustedStr}`);
    // Show cache stats — helps explain why Claude input tokens are low
    const cacheTotal = usage.cache_read_tokens + usage.cache_creation_tokens;
    const cacheStr = cacheTotal > 0
      ? ` | cache: ${Math.round(usage.cache_read_tokens / 1000)}K read, ${Math.round(usage.cache_creation_tokens / 1000)}K create`
      : "";
    lines.push(`    ${usage.request_count} requests${cacheStr}`);
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

function buildGoalsSummary(ctx: TelegramContext): string {
  const goals = loadGoals(ctx.config.orchestrator_dir);
  if (goals.goals.length === 0) return "";
  const progress = measureGoalProgress(goals, ctx.store);
  return formatGoalsForTelegram(progress);
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
      const res = await fetch(`http://localhost:${port}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
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

  // Pending operator controls
  const pendingControls = ctx.store.getPendingOperatorControls();
  const controlsLine = pendingControls.length > 0
    ? ` | 🎛 ${pendingControls.length} pending control(s)`
    : "";

  return `${healthLine}

🚀 *Shipped (last 2h)*
${shippedSection}

⚠️ *Needs attention*
${attentionSection}

🔄 *Working now*
${workingSection}

📊 ${totalDone} done | ${successRate}% success | ${openPRs} open PRs | ${recentMerges.length} merged (2h)${controlsLine}`;
}

/**
 * Build the /antibodies Telegram response: a concise operator panel showing
 * self-learned failure immunity — the last 10 PR review decisions from the
 * antibody log, plus a per-decision-type summary.
 *
 * Operators use this to see what patterns the system has learned to approve,
 * flag for changes, or escalate — without having to query the database directly.
 */
function buildAntibodiesPanel(ctx: TelegramContext): string {
  const entries = ctx.store.getAntibodyEntries({ limit: 10 });
  const stats = ctx.store.getAntibodyStats();

  if (entries.length === 0) {
    return "🧬 *Antibody Log*\n\nNo entries recorded yet. Entries appear after the first PR review cycle.";
  }

  // Stats summary line
  const statParts = stats.map((s) => {
    const icon = s.decision === "approve" ? "✅" : s.decision === "request-changes" ? "⚠️" : "🔴";
    return `${icon} ${s.decision}: ${s.count}`;
  });

  // Recent entries (compact one-line each)
  const lines: string[] = [];
  for (const e of entries) {
    const ts = e.timestamp.slice(0, 10);
    const repo = e.repo.split("/")[1] ?? e.repo;
    const icon = e.decision === "approve" ? "✅" : e.decision === "request-changes" ? "⚠️" : "🔴";
    const outcome = e.outcome === "clean" ? " ✓" : e.outcome === "regression" ? " ✗" : "";
    const reason = e.reason ? ` — ${e.reason.slice(0, 50)}` : "";
    lines.push(`  ${icon}${outcome} ${ts} ${repo}#${e.pr_number}${reason}`);
  }

  return `🧬 *Antibody Log*

*Summary*
  ${statParts.join(" | ")}

*Recent decisions (newest first)*
${lines.join("\n")}

_Run \`orch antibodies\` for full panel with diff shapes and filters._`;
}

/**
 * Check whether the configured daily guard health digest should fire on this poll cycle,
 * and if so, fetch metrics and send a Telegram message.
 * Similar to Slack's maybePostDailyDigest but for guard health metrics.
 * Safe to call every poll cycle — it is a no-op when:
 *  - Telegram is not configured
 *  - The digest has already been sent today
 *  - The current time is before the scheduled window
 *
 * Issue #1163.
 */
export async function maybePostDailyGuardDigest(
  state: DigestSchedulerState,
  store: StateStore,
  schedule = "09:00",
  now = new Date(),
): Promise<void> {
  if (!chatId) return; // Telegram not configured

  const today = todayLocalDateString(now);

  // Already sent today
  if (state.lastDigestDate === today) return;

  // Not yet the scheduled time
  if (!isScheduledTimeReached(schedule, now)) return;

  // Mark as sent before awaiting so concurrent cycles don't double-post
  state.lastDigestDate = today;

  try {
    const res = await fetch("http://localhost:3472/guard-health", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      log.warn("Failed to fetch guard health metrics for digest", { status: res.status });
      return;
    }

    const data = (await res.json()) as {
      metrics: {
        total_hits: number;
        leaked_hits: number;
        active_suppressions: number;
        suppressions: Array<{ repo: string; issue_number: number; minutes_remaining: number }>;
      };
    };
    const { metrics } = data;

    const suppressionsList = metrics.suppressions
      .map((s) => `\`${s.repo}#${s.issue_number}\` (${s.minutes_remaining}m)`)
      .slice(0, 5)
      .join(", ");

    const suppText = metrics.active_suppressions > 0 ? `Active: ${suppressionsList}${metrics.active_suppressions > 5 ? ` ... +${metrics.active_suppressions - 5} more` : ""}` : "None";

    let alert = `🛡️ *Daily Guard Health* (24h)\n\n` + `📊 Total hits: ${metrics.total_hits}\n` + `🚫 Leaked hits: ${metrics.leaked_hits}\n` + `🔒 Active suppressions: ${metrics.active_suppressions}\n` + `${suppText}`;

    // Add warning if leaks detected
    if (metrics.leaked_hits > 0) {
      alert += `\n\n⚠️ *Warning:* Leaked hits detected — suppression may be failing. Run \`/guard-health\` for details.`;
    }

    sendTelegramAlert(alert);
    log.info("Daily guard health digest sent", { date: today, totalHits: metrics.total_hits, leakedHits: metrics.leaked_hits });
  } catch (err) {
    // Don't reset lastDigestDate — one attempt per day is enough even on failure.
    log.error("Failed to send daily guard health digest", { error: String(err) });
  }
}

/**
 * Check whether the configured daily persistent-anomalies digest should fire
 * on this poll cycle, and if so, fetch the anomaly feed and send a Telegram
 * message. Fires only when total > 0 (silent when clean).
 *
 * Safe to call every poll cycle — it is a no-op when:
 *  - Telegram is not configured
 *  - The digest has already been sent today
 *  - The current time is before the scheduled window
 *  - No anomalies were detected in the 24h window
 *
 * Issue #1207.
 */
export async function maybePostDailyAnomaliesDigest(
  state: DigestSchedulerState,
  _store: unknown,
  schedule = "09:00",
  now = new Date(),
): Promise<void> {
  if (!chatId) return; // Telegram not configured

  const today = todayLocalDateString(now);

  // Already sent today
  if (state.lastDigestDate === today) return;

  // Not yet the scheduled time
  if (!isScheduledTimeReached(schedule, now)) return;

  // Mark as sent before awaiting so concurrent cycles don't double-post
  state.lastDigestDate = today;

  try {
    const res = await fetch("http://localhost:3472/api/persistent-anomalies?days=1&min_cycles=1", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn("Failed to fetch persistent anomalies for digest", { status: res.status });
      return;
    }

    const data = (await res.json()) as {
      total: number;
      anomalies: Array<{
        task_id: string;
        agent: string;
        anomaly_type: string;
        cycle_count: number;
        last_seen: string;
      }>;
    };

    // Don't post if no anomalies — keeps digest channel clean
    if (data.total === 0) return;

    const lines = data.anomalies.slice(0, 10).map(
      (a) => `• \`${a.task_id.slice(-10)}\` ${a.agent} — ${a.anomaly_type} (${a.cycle_count}x)`,
    );
    if (data.total > 10) lines.push(`… +${data.total - 10} more`);

    const alert =
      `🔍 *Persistent Anomalies (24h)* — ${data.total} detected\n\n` +
      lines.join("\n") +
      `\n\n_Run \`orch anomalies --days 1\` for full panel._`;

    sendTelegramAlert(alert);
    log.info("Daily persistent anomalies digest sent", { date: today, total: data.total });
  } catch (err) {
    // Don't reset lastDigestDate — one attempt per day is enough even on failure.
    log.error("Failed to send daily anomalies digest", { error: String(err) });
  }
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

/**
 * Send a proactive alert to the Telegram operator chat.
 *
 * Fire-and-forget: errors are swallowed so callers never crash.
 * Intended for daemon-generated notifications (e.g. dispatch flood-gate
 * first-fire alerts) rather than interactive command responses.
 *
 * @param text  Markdown-compatible message text (max ~4000 chars)
 */
export function sendTelegramAlert(text: string): void {
  if (!loadConfig()) return;
  sendReply(text).catch(() => {
    // Intentionally swallowed — alert delivery is best-effort
  });
}
