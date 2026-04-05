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
import { createLogger } from "../service/logger.js";
import type { ReviewerConfig } from "../config.js";
import type { IStateStore, Task, SupervisorDecisionRecord } from "../state/types.js";

export interface SupervisorDecision {
  action: "dispatch" | "verify" | "redeploy" | "create-issue" | "follow-up" | "none";
  agentName?: string;
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
    "action": "follow-up",
    "agentName": "claude-proxy",
    "message": "Your previous task on issue #2 is done but the branch wasn't pushed. Please push branch issue-2-expand-claude-md to origin.",
    "reason": "Branch created but not pushed to remote"
  }
]

IMPORTANT PRIORITIES:
- Do NOT dispatch to agents that already have active (dispatched) tasks — they can only handle one task at a time
- Prefer dispatching PRODUCT WORK (features, content, user-facing improvements) over technical follow-ups
- Do NOT re-dispatch the same failed technical task more than once — if it failed twice, create an issue instead
- Do NOT follow up on tasks that are just internal tooling or testing infrastructure
- If an agent is idle, dispatch product-focused work from their open issues, not more tech debt fixes

CRITICAL — IDLE AGENT DISPATCH RULES (strictly enforced):
- NEVER dispatch a vague "you are idle" or "check for work" message to an agent — these produce useless status reports that are immediately rejected
- When dispatching to an idle agent, you MUST either:
  (a) Reference a SPECIFIC open GitHub issue by number (e.g. "implement issue #42 from owner/repo"), OR
  (b) Define a CONCRETE artifact the agent must produce (e.g. "create file X", "open a PR for Y", "run command Z and report results")
- The open GitHub issues per agent are listed in the context under "## Open Issues". Pick one and dispatch it.
- If an agent is idle and has no open issues, prefer action "none" over a vague dispatch — do not invent busywork
- A dispatch message that will result in a pure status check or "system looks healthy" report is a quality failure and wastes a task slot

You have memory of your recent decisions in "## Recent Supervisor Decisions". Use this to:
- Avoid repeating actions that have already been taken (especially failed ones)
- Track whether your dispatches produced results
- Identify patterns of repeated failures and escalate to issue creation instead

Be specific and actionable. Only suggest actions that address real gaps. Return [] if everything is on track.`;

/** Regex to detect issue references like #42 or owner/repo#42 */
const ISSUE_REF_RE = /#\d+/;

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

export class Supervisor {
  private log = createLogger("supervisor");

  constructor(
    private config: ReviewerConfig,
    private store: IStateStore,
  ) {}

  async review(): Promise<SupervisorDecision[]> {
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

      const dropped = decisions.length - validated.length;
      if (dropped > 0) {
        this.log.warn("Supervisor: dropped vague idle-agent dispatches", { dropped });
      }

      this.log.info("Supervisor review complete", {
        decisions: validated.length,
        actions: validated.map((d) => d.action),
      });
      return validated;
    } catch (err) {
      this.log.error("Supervisor review failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Filter out dispatch/follow-up decisions that target idle agents but don't
   * include a specific issue reference or concrete artifact.
   */
  private filterVagueDispatches(decisions: SupervisorDecision[]): SupervisorDecision[] {
    return decisions.filter((d) => {
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
          message: d.message ? String(d.message) : undefined,
          reason: String(d.reason),
        }));
    } catch {
      return [];
    }
  }
}
