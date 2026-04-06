/**
 * Supervisor — the strategic brain of the multi-agent system.
 *
 * LLM calls are delegated to the ReviewerClient (reviewer agent pool).
 * This module handles context building, decision filtering, and utility
 * functions for the daemon's supervisor cycle.
 */
import { execSync } from "node:child_process";
import { ReviewerClient } from "../client/reviewer-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, Task, SupervisorDecisionRecord } from "../state/store.js";
import { createLogger } from "../service/logger.js";
import { cachedGetIssueState, liveValidateForDispatch } from "../triggers/issue-state-bridge.js";

export type { SupervisorDecision } from "../client/reviewer-client.js";
import type { SupervisorDecision } from "../client/reviewer-client.js";

/** Regex to detect issue references like #42 or owner/repo#42 */
const ISSUE_REF_RE = /#\d+/;

/**
 * Extract all unique issue/PR numbers referenced in a text string.
 * Matches patterns like #42, issue #42, PR #42, owner/repo#42.
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
 * resolved (closed or merged).  Returns `true` only if:
 *   - At least one #N reference was found in the message/reason, AND
 *   - Every reference that could be resolved via `gh` was non-OPEN.
 *
 * Returns `false` if any ref is still OPEN, or if we can't determine the
 * state (safe default — don't skip work we're uncertain about).
 *
 * Exported for unit testing; call it directly rather than creating an instance.
 */
export function isDecisionAlreadyResolved(
  message: string,
  reason: string,
  agentGithub: string,
): boolean {
  const refs = extractIssueRefs(`${message} ${reason}`);
  if (refs.length === 0) return false; // No specific refs — can't confirm resolved

  let checkedAny = false;

  for (const num of refs) {
    try {
      // First, try the issue state cache (issue #458) — this avoids redundant
      // GitHub API calls when the same issue is checked multiple times within
      // the 60s TTL window.
      try {
        const cached = cachedGetIssueState(agentGithub, num);
        checkedAny = true;
        if (cached.state === "open" && !cached.hasMergedPR) {
          return false; // Issue is still open and unresolved
        }
        // Closed or has merged PR — continue checking other refs
        continue;
      } catch {
        // Cache fetch failed (e.g. gh not available) — fall through to direct check
      }

      // Fallback: direct gh CLI check for PRs (which share the number namespace
      // but are not tracked by the issue cache).
      let state: string | null = null;

      try {
        state = execSync(
          `gh issue view ${num} --repo ${agentGithub} --json state --jq '.state'`,
          { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
        ).trim().toUpperCase();
      } catch {
        // #N might be a PR, not an issue — try the pr command
        try {
          state = execSync(
            `gh pr view ${num} --repo ${agentGithub} --json state --jq '.state'`,
            { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
          ).trim().toUpperCase();
        } catch {
          // Can't resolve this ref — skip it (don't count as checked)
          continue;
        }
      }

      if (!state) continue;
      checkedAny = true;

      if (state === "OPEN") {
        return false; // At least one ref is still open — don't skip
      }
      // CLOSED / MERGED / any other non-OPEN state counts as resolved
    } catch {
      return false; // Unexpected error — safe default: don't skip
    }
  }

  // Only signal "resolved" if we successfully verified at least one ref
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

/** Result of the hard gate: decisions split into passed and blocked */
export interface GateResult {
  passed: SupervisorDecision[];
  blocked: Array<{ decision: SupervisorDecision; skipReason: string }>;
}

export class Supervisor {
  private log = createLogger("supervisor");
  private reviewerClient: ReviewerClient;

  constructor(
    private config: OrchestratorConfig,
    private store: StateStore,
    reviewerClient?: ReviewerClient,
  ) {
    this.reviewerClient = reviewerClient ?? new ReviewerClient(config);
  }

  /**
   * Hard gate: block dispatch to already-resolved issues (issue #507).
   *
   * For every dispatch/follow-up decision that references a GitHub issue,
   * performs a **live** (cache-bypassing) GitHub check.  If any referenced
   * issue is closed, has a merged PR, or already has an open PR, the
   * decision is blocked and a skip reason is returned.
   *
   * This runs at the supervisor decision layer — the authoritative point
   * before any dispatch is committed — so no resolved issue can leak
   * through to the dispatcher regardless of cache staleness.
   */
  gateResolvedIssues(decisions: SupervisorDecision[]): GateResult {
    const passed: SupervisorDecision[] = [];
    const blocked: GateResult["blocked"] = [];

    for (const d of decisions) {
      // Only gate dispatch/follow-up actions — others pass through
      if (d.action !== "dispatch" && d.action !== "follow-up") {
        passed.push(d);
        continue;
      }

      const agentGithub = d.agentName
        ? this.config.agents[d.agentName]?.github
        : undefined;

      if (!agentGithub) {
        // No GitHub repo configured — can't validate, let it through
        passed.push(d);
        continue;
      }

      const issueRefs = extractIssueRefs(`${d.message ?? ""} ${d.reason ?? ""}`);
      if (issueRefs.length === 0) {
        // No issue refs to validate — let it through
        passed.push(d);
        continue;
      }

      let skipReason: string | null = null;

      for (const issueNum of issueRefs) {
        try {
          skipReason = liveValidateForDispatch(agentGithub, issueNum);
          if (skipReason) {
            this.log.warn("Supervisor hard gate: dispatch blocked", {
              agentName: d.agentName,
              issueNum,
              skipReason,
              reason: d.reason,
            });
            break;
          }
        } catch (err) {
          // GitHub API error — log but don't block (safe default)
          this.log.warn("Supervisor hard gate: GitHub check failed, allowing dispatch", {
            agentName: d.agentName,
            issueNum,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (skipReason) {
        blocked.push({ decision: d, skipReason });
      } else {
        passed.push(d);
      }
    }

    if (blocked.length > 0) {
      this.log.info("Supervisor hard gate summary", {
        total: decisions.length,
        passed: passed.length,
        blocked: blocked.length,
        blockedReasons: blocked.map((b) => b.skipReason),
      });
    }

    return { passed, blocked };
  }

  async review(): Promise<SupervisorDecision[]> {
    const context = this.buildContext();

    const decisions = await this.reviewerClient.supervisorReview(context);
    const validated = this.filterVagueDispatches(decisions);

    const dropped = decisions.length - validated.length;
    if (dropped > 0) {
      this.log.warn("Supervisor: dropped vague idle-agent dispatches", { dropped });
    }

    this.log.info("Supervisor review complete", { decisions: validated.length, actions: validated.map((d) => d.action) });
    return validated;
  }

  /**
   * Filter out dispatch/follow-up decisions that target idle agents but don't
   * include a specific issue reference or concrete artifact. These produce
   * status-report responses that score near 0 in verification.
   */
  private filterVagueDispatches(decisions: SupervisorDecision[]): SupervisorDecision[] {
    return decisions.filter((d) => {
      if (d.action !== "dispatch" && d.action !== "follow-up") return true;
      if (!d.agentName || !d.message) return true;

      // Only enforce on agents that are idle (no active tasks)
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
          const issuePart = d.issue_refs.length > 0 ? ` [issues: ${d.issue_refs.join(", ")}]` : "";
          const gatePart = d.hard_gates.length > 0 ? ` [gates: ${d.hard_gates.join("; ")}]` : "";
          return `- [${d.created_at.slice(0, 16)}] ${d.action}${agentPart}: ${d.reason} (outcome: ${d.outcome}${taskPart})${issuePart}${gatePart}`;
        })
        .join("\n");
      sections.push(`## Recent Supervisor Decisions\n${lines}`);
    }

    // Agent registry
    const agents = Object.entries(this.config.agents)
      .map(([name, a]) => `- ${name}: ${a.description}${a.github ? ` (${a.github})` : ""}`)
      .join("\n");
    sections.push(`## Agents\n${agents}`);

    // Open GitHub issues per agent (so the supervisor can pick specific ones to dispatch)
    const openIssues = this.fetchOpenIssues();
    if (openIssues.length > 0) {
      sections.push(`## Open Issues\n${openIssues.join("\n")}`);
    }

    // Recent tasks
    const recent = this.store.getRecentCompleted(10);
    if (recent.length > 0) {
      const taskLines = recent.map((t) => this.formatTask(t)).join("\n");
      sections.push(`## Recent Completed Tasks\n${taskLines}`);
    }

    // Research findings — approved research with full results so the supervisor
    // can make informed decisions based on what the research agent discovered
    // (issue #428).
    const researchFindings = this.store.getApprovedResearchFindings(5);
    if (researchFindings.length > 0) {
      const lines = researchFindings.map((t) => {
        const linked = this.store.isResearchLinked(t.id) ? " → implementation issues filed" : " → not yet linked to implementation";
        const score = t.quality_score ? ` [score: ${t.quality_score.toFixed(1)}]` : "";
        // Include up to 500 chars of findings (much more than the 150-char
        // truncation in formatTask) so the supervisor has enough context.
        const findings = t.result ? `\n  Findings: ${t.result.slice(0, 500)}` : "";
        return `- ${t.id.slice(0, 8)} (${t.agent_name})${score}: ${t.title}${linked}${findings}`;
      }).join("\n");
      sections.push(`## Recent Research Findings\n${lines}`);
    }

    // Unverified tasks
    const unverified = this.store.getUnverified(10);
    if (unverified.length > 0) {
      const lines = unverified.map((t) => `- ${t.id.slice(0, 8)} (${t.agent_name}): ${t.title}`).join("\n");
      sections.push(`## Unverified Tasks (${unverified.length})\n${lines}`);
    }

    // Failed tasks
    const failed = this.store.listTasks({ status: "failed", limit: 5 });
    if (failed.length > 0) {
      const lines = failed.map((t) => `- ${t.id.slice(0, 8)} (${t.agent_name}): ${t.title}\n  Error: ${t.result?.slice(0, 100)}`).join("\n");
      sections.push(`## Recent Failures\n${lines}`);
    }

    // Agent load (active dispatched tasks)
    const loadLines: string[] = [];
    for (const name of Object.keys(this.config.agents)) {
      const active = this.store.listTasks({ status: "dispatched", agent_name: name, limit: 10 });
      loadLines.push(`- ${name}: ${active.length} active task(s)`);
    }
    sections.push(`## Agent Load\n${loadLines.join("\n")}`);

    // Agent stats
    const stats = this.store.getAgentStats();
    if (stats.length > 0) {
      const lines = stats.map((s) => {
        const rate = s.total > 0 ? ((s.done / s.total) * 100).toFixed(0) : "N/A";
        return `- ${s.agent_name}: ${s.done}/${s.total} done (${rate}%), ${s.failed} failed`;
      }).join("\n");
      sections.push(`## Agent Performance\n${lines}`);
    }

    return sections.join("\n\n");
  }

  /**
   * Fetch up to 10 open GitHub issues per agent (agents with a github config).
   * Returns formatted lines like: `- agent-name (owner/repo): #42 Issue title`
   *
   * Failures are silently ignored — the supervisor still works without this data.
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
    const verified = t.verification_status ? ` [${t.verification_status}${t.quality_score ? ` ${t.quality_score.toFixed(1)}` : ""}]` : " [unverified]";
    const result = t.result ? `\n  Result: ${t.result.slice(0, 150)}` : "";
    return `- ${t.id.slice(0, 8)} (${t.agent_name}) ${t.status}${typeTag}${verified}: ${t.title}${result}`;
  }
}
