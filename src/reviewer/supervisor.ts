/**
 * Supervisor — strategic oversight of all agents and tasks.
 *
 * Migrated from rapartlu/claude-agent-orchestrator:src/orchestrator/supervisor.ts
 * Adaptations:
 *   - Uses createLLMClient() from ../client/llm-client (no proxy routing)
 *   - Accepts IStateStore interface instead of concrete StateStore
 *   - Config replaced with ReviewerConfig
 *   - All exported helpers (extractIssueRefs, isDecisionAlreadyResolved,
 *     isConcreteDispatch) preserved for orchestrator daemon consumption
 */

import { execSync } from "node:child_process";
import { createLLMClient } from "../client/llm-client.js";
import { createNotifier } from "../notify.js";
import { createLogger } from "../service/logger.js";
import type { ReviewerConfig } from "../config.js";
import type { IStateStore, Task, AgentHealth, SupervisorDecisionRecord } from "../state/types.js";
import type { ConflictStats } from "./pr-reviewer.js";
import {
  buildIssueAgeHeatmap,
  collectIssueAgeEscalations,
  formatIssueAgeHeatmap,
  hasRecentAgeDispatchDecision,
  hasRecentAgeNudge,
} from "./issue-age.js";

/**
 * Minimal interface for providing conflict stats to the supervisor.
 * Satisfied by `PRReviewer` (or any stub in tests).
 */
export interface ConflictStatsProvider {
  getConflictStats(): ConflictStats;
}

export interface SupervisorDecision {
  action: "dispatch" | "verify" | "redeploy" | "create-issue" | "follow-up" | "none";
  agentName?: string;
  taskId?: string;
  message?: string;
  reason: string;
}

const SYSTEM_PROMPT = `You are the orchestrator supervisor — the strategic brain of a multi-agent system. You review the current state of all agents and tasks, and decide what needs attention.

You have these capabilities:
- dispatch: send work to an agent
- verify: check quality of completed work
- redeploy: rebuild an agent's container with latest code
- create-issue: create a GitHub issue on an agent's repo
- follow-up: send a follow-up message to an agent about a previous task
- none: everything looks good, no action needed

Respond with ONLY a JSON array of decisions (no markdown, no code fences):
[
  {
    "action": "verify",
    "taskId": "01KNJDAK",
    "reason": "PR #522 was scored 0.8 and remains unverified in the queue"
  }
]

IMPORTANT PRIORITIES:
- Do NOT dispatch to agents that already have active (dispatched) tasks — they can only handle one task at a time
- Prefer dispatching PRODUCT WORK (features, content, user-facing improvements) over technical follow-ups
- Do NOT re-dispatch the same failed technical task more than once — if it failed twice, create an issue instead
- Do NOT follow up on tasks that are just internal tooling or testing infrastructure
- If an agent is idle, dispatch product-focused work from their open issues, not more tech debt fixes

CRITICAL — AGENT HEALTH AWARENESS:
- The "## Agent Health" section shows per-agent health status from recent dispatch history
- Agents with consecutive failures are UNHEALTHY — avoid dispatching to them unless no healthy alternative exists
- When multiple agents can handle a task, ALWAYS prefer healthy agents over unhealthy ones
- If an agent has 3+ consecutive failures, consider a "redeploy" action instead of dispatching more work
- "No dispatch history" means the agent has never been tracked — treat as healthy (new or recently deployed)

CRITICAL — IDLE AGENT DISPATCH RULES (strictly enforced):
- NEVER dispatch a vague "you are idle" or "check for work" message to an agent — these produce useless status reports that are immediately rejected
- When dispatching to an idle agent, you MUST either:
  (a) Reference a SPECIFIC open GitHub issue by number (e.g. "implement issue #42 from owner/repo"), OR
  (b) Define a CONCRETE artifact the agent must produce (e.g. "create file X", "open a PR for Y", "run command Z and report results")
- The open GitHub issues per agent are listed in the context under "## Open Issues". Pick one and dispatch it.
- If an agent is idle and has no open issues, prefer action "none" over a vague dispatch — do not invent busywork
- A dispatch message that will result in a pure status check or "system looks healthy" report is a quality failure and wastes a task slot
- For action "verify", you MUST include a "taskId" field using the exact task id shown in the context (the 8-character prefix is acceptable)
- For action "redeploy", you MUST include "agentName"
- For action "create-issue", you MUST include "agentName" and put the concrete issue request in "message"

You have memory of your recent decisions in "## Recent Supervisor Decisions". Use this to:
- Avoid repeating actions that have already been taken (especially failed ones)
- Track whether your dispatches produced results
- Identify patterns of repeated failures and escalate to issue creation instead

CONFLICT-AWARE DISPATCH (when "## Merge Conflict Stats" is present):
- Repos with high stale-branch-nudge counts are conflict-prone — their agents need to rebase more often
- When dispatching to an agent whose repo has stale-nudge or escalation counts > 0, include a reminder: "Before opening a PR, run: git fetch origin && git rebase origin/main"
- If conflict escalations are high for a repo (≥2 this period), consider creating an issue to investigate the root cause rather than continuing to dispatch direct work
- Cycles lost to conflicts are wasted — use the stats to prioritise rebasing and conflict prevention over new feature work

Be specific and actionable. Only suggest actions that address real gaps. Return [] if everything is on track.`;

/** Regex to detect issue references like #42 or owner/repo#42 */
const ISSUE_REF_RE = /#\d+/;
const TASK_REF_RE = /\b(?:task(?::|\s+id\s*:?\s*|\s+)?|\[task:)([0-9A-Z]{8,26})\]?/gi;

/**
 * Extract all unique issue/PR numbers referenced in a text string.
 */
export function extractIssueRefs(text: string): number[] {
  const refs = new Set<number>();
  for (const match of text.matchAll(/#(\d+)/g)) {
    refs.add(parseInt(match[1], 10));
  }
  return [...refs];
}

/**
 * Extract the first task id or task-id prefix referenced in free text.
 */
export function extractTaskRef(text: string): string | undefined {
  if (!text) return undefined;
  const match = TASK_REF_RE.exec(text);
  TASK_REF_RE.lastIndex = 0;
  return match?.[1];
}

/**
 * Check whether a supervisor decision's referenced issues/PRs are already
 * resolved (closed or merged).
 *
 * Returns `true` only if at least one #N reference was found AND every
 * reference that could be resolved via `gh` was non-OPEN.
 *
 * Returns `false` if any ref is still OPEN, or if the state is unknown
 * (safe default — don't skip work we're uncertain about).
 *
 * Exported for unit testing.
 */
export function isDecisionAlreadyResolved(
  message: string,
  reason: string,
  agentGithub: string,
): boolean {
  const refs = extractIssueRefs(`${message} ${reason}`);
  if (refs.length === 0) return false;

  let checkedAny = false;

  for (const num of refs) {
    try {
      let state: string | null = null;

      try {
        state = execSync(
          `gh issue view ${num} --repo ${agentGithub} --json state --jq '.state'`,
          { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
        )
          .trim()
          .toUpperCase();
      } catch {
        try {
          state = execSync(
            `gh pr view ${num} --repo ${agentGithub} --json state --jq '.state'`,
            { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
          )
            .trim()
            .toUpperCase();
        } catch {
          continue;
        }
      }

      if (!state) continue;
      checkedAny = true;

      if (state === "OPEN") {
        return false;
      }
    } catch {
      return false;
    }
  }

  return checkedAny;
}

/** Concrete artifact keywords that indicate a real deliverable */
const ARTIFACT_KEYWORDS = [
  "create file",
  "open a pr",
  "open pr",
  "push branch",
  "push your branch",
  "push the branch",
  "push to ",
  "write ",
  "implement ",
  "add ",
  "fix ",
  "update ",
  "run command",
  "produce ",
  "generate ",
];

/**
 * Returns true if a supervisor dispatch message contains a specific issue
 * reference (#N) or a concrete artifact keyword — i.e. it is actionable.
 */
export function isConcreteDispatch(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  if (ISSUE_REF_RE.test(message)) return true;
  return ARTIFACT_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Format agent health records into human-readable lines for supervisor context.
 *
 * Agents with consecutive_failures > 0 are flagged; healthy agents show last
 * success time; agents with no dispatch history are noted as such.
 *
 * Exported for unit testing.
 */
export function formatAgentHealthSection(
  agentNames: string[],
  healthRecords: AgentHealth[],
): string[] {
  const healthMap = new Map(healthRecords.map((h) => [h.agent_name, h]));
  const lines: string[] = [];

  for (const name of agentNames) {
    const health = healthMap.get(name);
    if (!health) {
      lines.push(`- ${name}: healthy (no dispatch history)`);
      continue;
    }

    if (health.consecutive_failures > 0) {
      const ago = health.last_error_at ? formatTimeAgo(health.last_error_at) : "unknown";
      const errSnippet = health.last_error_message
        ? ` — ${health.last_error_message.slice(0, 80)}`
        : "";
      lines.push(
        `- ${name}: ${health.consecutive_failures} consecutive failure(s) (last error: ${ago}${errSnippet})`,
      );
    } else {
      const ago = health.last_success_at ? formatTimeAgo(health.last_success_at) : "unknown";
      lines.push(`- ${name}: healthy (last success: ${ago})`);
    }
  }

  return lines;
}

/**
 * Format an ISO timestamp as a human-readable relative time (e.g. "2m ago", "1h ago").
 * Exported for unit testing.
 */
export function formatTimeAgo(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const diffMs = now - then;

  if (Number.isNaN(diffMs) || diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format a `ConflictStats` snapshot into human-readable supervisor context lines.
 *
 * Returns an empty array when there are no conflict events (no section needed).
 * Exported for unit testing.
 */
export function formatConflictStatsSection(stats: ConflictStats): string[] {
  const totalEvents =
    stats.totalConflictEscalations +
    stats.totalAutoClosedConflictPRs +
    stats.totalStaleBranchNudges;

  if (totalEvents === 0) return [];

  const lines: string[] = [
    `- Conflict escalations (unresolvable): ${stats.totalConflictEscalations}`,
    `- PRs auto-closed due to conflicts: ${stats.totalAutoClosedConflictPRs}`,
    `- Stale-branch nudges issued: ${stats.totalStaleBranchNudges}`,
  ];

  const cycleCost =
    stats.totalConflictEscalations + stats.totalAutoClosedConflictPRs;
  if (cycleCost > 0) {
    lines.push(`- ⚠️  Estimated cycles lost to merge conflicts: ${cycleCost}`);
  }

  const conflictRepos = Object.entries(stats.perRepo)
    .filter(([, v]) => v.escalations > 0 || v.staleNudges > 0)
    .sort((a, b) => (b[1].escalations + b[1].staleNudges) - (a[1].escalations + a[1].staleNudges));

  if (conflictRepos.length > 0) {
    lines.push(`- Conflict-prone repos:`);
    for (const [repo, counts] of conflictRepos) {
      const parts: string[] = [];
      if (counts.escalations > 0) parts.push(`${counts.escalations} escalation(s)`);
      if (counts.autoCloses > 0) parts.push(`${counts.autoCloses} auto-close(s)`);
      if (counts.staleNudges > 0) parts.push(`${counts.staleNudges} stale-nudge(s)`);
      lines.push(`    • ${repo}: ${parts.join(", ")}`);
    }
  }

  return lines;
}

export class Supervisor {
  private log = createLogger("supervisor");
  private conflictStatsProvider?: ConflictStatsProvider;
  private notifier = createNotifier();

  constructor(
    private config: ReviewerConfig,
    private store: IStateStore,
    opts: { conflictStatsProvider?: ConflictStatsProvider } = {},
  ) {
    this.conflictStatsProvider = opts.conflictStatsProvider;
  }

  async review(): Promise<SupervisorDecision[]> {
    const ageEscalations = await this.applyAgeEscalations();
    const context = this.buildContext();
    const client = createLLMClient();

    const LLM_TIMEOUT_MS = 5 * 60 * 1000;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create(
          {
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: context }],
          },
          { signal: abortController.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text : ""))
        .join("");

      const decisions = this.parseDecisions(text);
      const validated = this.filterVagueDispatches(decisions);
      const merged = this.mergeDecisions(ageEscalations, validated);
      this.persistDecisions(merged);

      const dropped = decisions.length - validated.length;
      if (dropped > 0) {
        this.log.warn("Supervisor: dropped vague idle-agent dispatches", { dropped });
      }

      this.log.info("Supervisor review complete", {
        decisions: merged.length,
        actions: merged.map((d) => d.action),
      });
      return merged;
    } catch (err) {
      this.log.error("Supervisor review failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.persistDecisions(ageEscalations);
      return ageEscalations;
    }
  }

  private mergeDecisions(base: SupervisorDecision[], extra: SupervisorDecision[]): SupervisorDecision[] {
    const seen = new Set<string>();
    const merged: SupervisorDecision[] = [];

    for (const decision of [...base, ...extra]) {
      const key = [
        decision.action,
        decision.agentName ?? "",
        decision.taskId ?? "",
        decision.message ?? "",
        decision.reason,
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(decision);
    }

    return merged;
  }

  private persistDecisions(decisions: SupervisorDecision[]): void {
    for (const decision of decisions) {
      const reasoning = [decision.reason, decision.message ?? ""].join(" ").trim();
      const issueRef = extractIssueRefs(reasoning).at(0);
      const outcome =
        decision.action === "none"
          ? "none"
          : decision.action === "age-nudge"
            ? "notified"
            : decision.action === "dispatch" || decision.action === "follow-up"
              ? "dispatched"
              : decision.action === "verify"
                ? "queued"
                : decision.action === "redeploy"
                  ? "queued"
                  : decision.action === "create-issue"
                    ? "queued"
                    : "pending";

      this.store.recordSupervisorDecision(decision.action, decision.reason, {
        agentName: decision.agentName,
        taskId: decision.taskId,
        outcome,
        message: decision.message,
        issueRef: issueRef ? `#${issueRef}` : undefined,
      });
    }
  }

  private async applyAgeEscalations(): Promise<SupervisorDecision[]> {
    const nowMs = Date.now();
    const tasks = this.store.listTasks({ limit: 500 });
    const recentDecisions = this.store.querySupervisorDecisions({ limit: 100 });
    const candidates = collectIssueAgeEscalations(tasks, recentDecisions, nowMs);
    const decisions: SupervisorDecision[] = [];

    for (const candidate of candidates) {
      const task = tasks.find((entry) => entry.id === candidate.taskId);
      if (!task) continue;

      if (candidate.shouldNudge && !hasRecentAgeNudge(task, recentDecisions, nowMs)) {
        const issueLabel = candidate.issueRef ?? task.id.slice(0, 8);
        const subject = `Issue age escalation: ${issueLabel}`;
        const body = [
          `Task \`${task.id.slice(0, 8)}\` has been open for ${candidate.ageDays}d without a dispatch attempt.`,
          ``,
          `*Task:* ${task.title}`,
          `*Agent:* ${task.agent_name ?? "unassigned"}`,
          `*Bucket:* ${candidate.bucket}`,
          `*Age:* ${candidate.ageDays}d`,
          `*Dispatch attempts:* ${candidate.dispatchAttempts}`,
        ].join("\n");

        if (this.notifier.isConfigured()) {
          await this.notifier.notifyOperator(subject, body, "medium");
          this.store.recordSupervisorDecision(
            "age-nudge",
            `Telegram nudge sent for ${issueLabel} after ${candidate.ageDays}d without dispatch attempt`,
            {
              taskId: task.id,
              issueRef: candidate.issueRef ?? undefined,
              outcome: "notified",
              message: candidate.title,
            },
          );
        } else {
          this.log.warn("Age escalation nudge skipped: Telegram not configured", {
            taskId: task.id,
            issueRef: candidate.issueRef,
          });
        }
      }

      if (candidate.shouldForceDispatch && !hasRecentAgeDispatchDecision(task, recentDecisions, nowMs)) {
        if (!task.agent_name) {
          this.log.warn("Age escalation dispatch skipped: task has no agent target", {
            taskId: task.id,
            issueRef: candidate.issueRef,
          });
          continue;
        }

        decisions.push({
          action: "dispatch",
          agentName: task.agent_name,
          taskId: task.id,
          message: `Implement issue ${candidate.issueRef ?? task.id.slice(0, 8)}: ${task.title}`,
          reason: "dispatched due to age escalation",
        });
      }
    }

    return decisions;
  }

  /**
   * Filter out dispatch/follow-up decisions that target idle agents but don't
   * include a specific issue reference or concrete artifact.
   */
  private filterVagueDispatches(decisions: SupervisorDecision[]): SupervisorDecision[] {
    return decisions.filter((d) => {
      if (d.action === "verify") {
        const taskId = d.taskId ?? extractTaskRef(`${d.message ?? ""} ${d.reason}`);
        if (!taskId) {
          this.log.warn("Dropping verify decision without task target", {
            reason: d.reason,
            message: d.message?.slice(0, 120),
          });
          return false;
        }
        d.taskId = taskId;
        return true;
      }

      if (d.action === "redeploy") {
        if (!d.agentName) {
          this.log.warn("Dropping redeploy decision without agentName", { reason: d.reason });
          return false;
        }
        return true;
      }

      if (d.action === "create-issue") {
        if (!d.agentName || !d.message) {
          this.log.warn("Dropping create-issue decision missing agentName or message", {
            agentName: d.agentName,
            reason: d.reason,
          });
          return false;
        }
        return true;
      }

      if (d.action !== "dispatch" && d.action !== "follow-up") return true;
      if (!d.agentName || !d.message) return true;

      const isIdle = !this.store.hasActiveTask(d.agentName);
      if (!isIdle) return true;

      const concrete = isConcreteDispatch(d.message);
      if (!concrete) {
        this.log.warn("Dropping vague idle-agent dispatch", {
          agentName: d.agentName,
          reason: d.reason,
          message: d.message.slice(0, 120),
        });
      }
      return concrete;
    });
  }

  private buildContext(): string {
    const sections: string[] = [];

    // Prior supervisor decisions (memory across cycles)
    const priorDecisions = this.store.getRecentSupervisorDecisions(10);
    if (priorDecisions.length > 0) {
      const lines = priorDecisions
        .map((d: SupervisorDecisionRecord) => {
          const agentPart = d.agent_name ? ` → ${d.agent_name}` : "";
          const taskPart = d.task_id ? ` [task:${d.task_id.slice(0, 8)}]` : "";
          return `- [${d.created_at.slice(0, 16)}] ${d.action}${agentPart}: ${d.reason} (outcome: ${d.outcome}${taskPart})`;
        })
        .join("\n");
      sections.push(`## Recent Supervisor Decisions\n${lines}`);
    }

    // Agent registry
    const agents = Object.entries(this.config.agents)
      .map(
        ([name, a]) =>
          `- ${name}: ${a.description}${a.github ? ` (${a.github})` : ""}`,
      )
      .join("\n");
    sections.push(`## Agents\n${agents}`);

    // Open GitHub issues per agent
    const openIssues = this.fetchOpenIssues();
    if (openIssues.length > 0) {
      sections.push(`## Open Issues\n${openIssues.join("\n")}`);
    }

    const heatmap = buildIssueAgeHeatmap(
      this.store.listTasks({ limit: 500 }),
      this.store.querySupervisorDecisions({ limit: 100 }),
    );
    if (heatmap.total > 0) {
      sections.push(`## Issue Age Heatmap\n${formatIssueAgeHeatmap(heatmap).join("\n")}`);
    }

    // Recent completed tasks
    const recent = this.store.getRecentCompleted(10);
    if (recent.length > 0) {
      const taskLines = recent.map((t) => this.formatTask(t)).join("\n");
      sections.push(`## Recent Completed Tasks\n${taskLines}`);
    }

    // Unverified tasks
    const unverified = this.store.getUnverified(10);
    if (unverified.length > 0) {
      const lines = unverified
        .map((t) => `- ${t.id.slice(0, 8)} (${t.agent_name}): ${t.title}`)
        .join("\n");
      sections.push(`## Unverified Tasks (${unverified.length})\n${lines}`);
    }

    // Failed tasks
    const failed = this.store.listTasks({ status: "failed", limit: 5 });
    if (failed.length > 0) {
      const lines = failed
        .map(
          (t) =>
            `- ${t.id.slice(0, 8)} (${t.agent_name}): ${t.title}\n  Error: ${t.result?.slice(0, 100)}`,
        )
        .join("\n");
      sections.push(`## Recent Failures\n${lines}`);
    }

    // Agent load
    const loadLines: string[] = [];
    for (const name of Object.keys(this.config.agents)) {
      const active = this.store.listTasks({ status: "dispatched", agent_name: name, limit: 10 });
      loadLines.push(`- ${name}: ${active.length} active task(s)`);
    }
    sections.push(`## Agent Load\n${loadLines.join("\n")}`);

    // Agent health (from orchestrator's agent_health table)
    const agentNames = Object.keys(this.config.agents);
    const healthRecords = this.store.getAgentHealthBatch(agentNames);
    const healthLines = formatAgentHealthSection(agentNames, healthRecords);
    if (healthLines.length > 0) {
      sections.push(`## Agent Health\n${healthLines.join("\n")}`);
    }

    // Agent stats
    const stats = this.store.getAgentStats();
    if (stats.length > 0) {
      const lines = stats
        .map((s) => {
          const rate = s.total > 0 ? ((s.done / s.total) * 100).toFixed(0) : "N/A";
          return `- ${s.agent_name}: ${s.done}/${s.total} done (${rate}%), ${s.failed} failed`;
        })
        .join("\n");
      sections.push(`## Agent Performance\n${lines}`);
    }

    // Merge conflict stats (from PRReviewer, when wired via ConflictStatsProvider)
    if (this.conflictStatsProvider) {
      const conflictStats = this.conflictStatsProvider.getConflictStats();
      const conflictLines = formatConflictStatsSection(conflictStats);
      if (conflictLines.length > 0) {
        sections.push(`## Merge Conflict Stats\n${conflictLines.join("\n")}`);
      }
    }

    return sections.join("\n\n");
  }

  /**
   * Fetch up to 10 open GitHub issues per agent (agents with a github config).
   * Failures are silently ignored.
   */
  private fetchOpenIssues(): string[] {
    const lines: string[] = [];
    for (const [name, agent] of Object.entries(this.config.agents)) {
      if (!agent.github) continue;
      try {
        const raw = execSync(
          `gh issue list --repo ${agent.github} --state open --json number,title -L 10`,
          { encoding: "utf-8", timeout: 10000 },
        ).trim();
        if (!raw) continue;
        const issues = JSON.parse(raw) as Array<{ number: number; title: string }>;
        for (const issue of issues) {
          lines.push(`- ${name} (${agent.github}): #${issue.number} ${issue.title}`);
        }
      } catch {
        // gh not available or repo not accessible — skip silently
      }
    }
    return lines;
  }

  private formatTask(t: Task): string {
    const typeTag = t.task_type === "research" ? " [research]" : "";
    const verified = t.verification_status
      ? ` [${t.verification_status}${t.quality_score ? ` ${t.quality_score.toFixed(1)}` : ""}]`
      : " [unverified]";
    const result = t.result ? `\n  Result: ${t.result.slice(0, 150)}` : "";
    return `- ${t.id.slice(0, 8)} (${t.agent_name}) ${t.status}${typeTag}${verified}: ${t.title}${result}`;
  }

  private parseDecisions(text: string): SupervisorDecision[] {
    const cleaned = text
      .replace(/```(?:json)?\s*/g, "")
      .replace(/```/g, "")
      .trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((d: Record<string, unknown>) => d.action && d.reason)
        .map((d: Record<string, unknown>) => ({
          action: String(d.action) as SupervisorDecision["action"],
          agentName: d.agentName ? String(d.agentName) : undefined,
          taskId: d.taskId ? String(d.taskId) : extractTaskRef(`${String(d.message ?? "")} ${String(d.reason ?? "")}`),
          message: d.message ? String(d.message) : undefined,
          reason: String(d.reason),
        }));
    } catch {
      return [];
    }
  }
}
