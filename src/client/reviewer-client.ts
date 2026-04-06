/**
 * ReviewerClient — delegates LLM-based review, verification, supervision,
 * and improvement detection to the reviewer agent pool.
 *
 * Instead of each orchestrator module (verifier, pr-reviewer, supervisor,
 * improvement-detector) independently creating LLM clients and managing
 * prompts, this client centralises all LLM calls and routes them through
 * the reviewer pool via `createLLMClient()`.
 *
 * This is the "equivalent IPC" layer described in issue #437: the
 * orchestrator daemon delegates quality decisions to the reviewer agent
 * rather than running its own parallel LLM logic.
 */
import { createLLMClient } from "./llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";

// ─── Shared types (re-exported so consumers don't need to reach into modules) ───

export interface VerificationResult {
  approved: boolean;
  score: number;
  notes: string;
  revision?: string;
}

export interface PRReviewResult {
  decision: "approve" | "request-changes" | "escalate";
  comment: string;
  reason: string;
  conflictEscalation?: boolean;
}

export interface SupervisorDecision {
  action: "dispatch" | "verify" | "redeploy" | "create-issue" | "follow-up" | "none";
  agentName?: string;
  message?: string;
  reason: string;
  rationale?: string;
}

export interface DetectedImprovement {
  title: string;
  description: string;
  affected_agents: string[];
  severity: "low" | "medium" | "high";
  evidence: Array<{ taskId: string; detail: string }>;
}

// ─── System prompts (moved from deleted/gutted local modules) ────────────────

const VERIFY_SYSTEM_PROMPT = `You are a quality reviewer for an AI agent orchestrator. Given a task description and the agent's response, assess the quality of the work.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Brief assessment of quality, completeness, correctness",
  "revision": "If not approved, specific guidance for improvement (omit if approved)"
}

Scoring guide:
- 0.9-1.0: Excellent — thorough, correct, well-structured
- 0.7-0.89: Good — meets requirements with minor gaps
- 0.5-0.69: Acceptable — partially addresses the task
- Below 0.5: Needs revision — incomplete or incorrect`;

const VERIFY_RESEARCH_SYSTEM_PROMPT = `You are a quality reviewer for research and feasibility analysis produced by an AI agent. Given a research question and the agent's analysis, assess the quality of the research.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Brief assessment of research quality",
  "revision": "If not approved, specific guidance for improvement (omit if approved)"
}

Evaluate research quality on:
- **Thoroughness**: Did the agent investigate the question fully, or leave obvious gaps?
- **Evidence**: Are claims backed by concrete examples, code references, or data?
- **Alternatives**: Were multiple approaches considered and compared?
- **Honesty**: Does the analysis acknowledge uncertainty, risks, and limitations?
- **Structure**: Is the response well-organized and easy to act on?
- **Actionability**: Could a decision-maker use this analysis to make an informed choice?

Scoring guide:
- 0.9-1.0: Excellent — comprehensive analysis with evidence, alternatives, and clear recommendation
- 0.7-0.89: Good — solid analysis with minor gaps in coverage or evidence
- 0.5-0.69: Acceptable — addresses the question but lacks depth or alternatives
- Below 0.5: Needs revision — superficial, missing key considerations, or not actionable`;

const PR_REVIEW_SYSTEM_PROMPT = `You are a code reviewer for a multi-agent system. Your job is to catch real bugs and security issues, NOT to enforce style preferences.

Decide ONE of:

1. **approve** — the code works, is safe, and achieves its goal. Approve even if you'd write it differently.
2. **request-changes** — there are BLOCKING issues only: bugs that will break at runtime, security vulnerabilities, data loss risks, or missing critical functionality. Style, naming, structure preferences, and "could be cleaner" observations are NOT blocking.
3. **escalate** — needs human review (security-sensitive, architectural, breaking changes, or genuinely uncertain)

IMPORTANT:
- Default to APPROVE. Most PRs that work correctly should be approved.
- Only request changes for issues that would cause real failures or security problems.
- Never block on: code style, naming conventions, missing comments/docs, "could use a helper function", edge cases that are unlikely in practice, or suggestions for follow-up work.
- If you have minor suggestions, include them in an approval comment — don't block the PR for them.

CRITICAL — when decision is "request-changes", the "comment" field MUST be a numbered markdown checklist.
Each item must be a concrete, self-contained action the agent can check off. No narrative prose.
Example format:
"1. Add \`Closes #N\` to the PR body\\n2. Guard \`parseInt\` against empty string input in \`src/foo.ts:42\`\\n3. Add unit test for the empty-array edge case in \`processItems()\`"

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "decision": "approve|request-changes|escalate",
  "comment": "Your review comment to post on the PR",
  "reason": "Brief internal reason for the decision"
}`;

const SUPERVISOR_SYSTEM_PROMPT = `You are the orchestrator supervisor — the strategic brain of a multi-agent system. You review the current state of all agents and tasks, and decide what needs attention.

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
    "reason": "Branch created but not pushed to remote",
    "rationale": "Issue #2 was opened 3 days ago and has no linked PR yet. The agent completed the work in task 01ABC but the branch was never pushed, blocking the PR review cycle. A successful result is the branch pushed and a PR created that closes #2."
  }
]

For "dispatch" and "follow-up" actions, ALWAYS include a "rationale" field that explains:
1. Why this issue/task was selected (recency, failure count, user impact, priority)
2. What prior work is relevant (previous attempts, related tasks, dependencies)
3. What a successful result looks like (expected deliverable, acceptance criteria)

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

You may see a "## Recent Research Findings" section containing approved research from the research agent. Use these findings to:
- Inform routing decisions (e.g. a research finding about scaling patterns may affect which agent gets scaling work)
- Prioritize implementation of gaps identified by research (issues filed from research are labelled "research-implementation")
- Avoid dispatching research on topics already covered by recent findings

Be specific and actionable. Only suggest actions that address real gaps. Return [] if everything is on track.`;

const IMPROVEMENT_SYSTEM_PROMPT = `You are a product improvement analyst for a multi-agent system. Each agent is a product with users. Analyze recent task results and suggest improvements that make agents more useful, not just more technically polished.

PRIORITIZE (in order):
1. **New product features** — endpoints, commands, content, or capabilities that make the agent more useful or interesting to users
2. **Content and data gaps** — missing knowledge, incomplete databases, or areas where the agent's domain expertise could be deeper
3. **User experience** — making existing features more discoverable, interactive, or enjoyable
4. **Integration opportunities** — ways agents could connect with external services or each other to create more value

AVOID suggesting:
- Internal tooling, test infrastructure, or refactoring that doesn't directly enable a user-facing feature
- Process improvements to the orchestrator itself (those are filed separately)
- Generic "add error handling" or "improve documentation" unless tied to a specific user-facing gap

Each agent has a specific product identity:
- claude-agent-orchestrator: The orchestrator control plane — should suggest improvements to autonomous oversight, routing accuracy, PR review quality, or supervisor intelligence
- claude-proxy: Developer tool for running Claude Code — should suggest UX improvements, dashboards, or developer productivity features

Respond with ONLY a JSON array (no markdown, no code fences):
[
  {
    "title": "Short improvement title",
    "description": "What to build, why users would want it, and specific acceptance criteria",
    "affected_agents": ["agent-name"],
    "severity": "low|medium|high"
  }
]

If no improvements are detected, return an empty array: []
Be specific and product-focused. Every suggestion should answer: "what can a user do after this that they couldn't before?"`;

// ─── Utility: enforce checklist format on request-changes comments ───────────

/**
 * Ensure a request-changes comment is a numbered markdown checklist.
 * When the LLM ignores the system prompt and returns narrative prose, this
 * converts it into numbered items so agents receive a concrete, checkable
 * list rather than open-ended text.
 */
export function enforceChecklist(comment: string): string {
  const trimmed = comment.trim();
  if (!trimmed) return trimmed;

  // Already has numbered checklist items (e.g. "1. …" or "1) …")
  if (/^\d+[.)]\s/m.test(trimmed)) return trimmed;

  // Split on newlines or sentence boundaries, filter blanks, re-number
  const lines = trimmed
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 1) {
    // Single paragraph — split on ". " sentence boundaries
    const sentences = trimmed
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length > 1) {
      return sentences.map((s, i) => `${i + 1}. ${s}`).join("\n");
    }
    // Single sentence — wrap as item 1
    return `1. ${trimmed}`;
  }

  return lines.map((line, i) => {
    // Strip existing bullet markers (-, *, •) before re-numbering
    const stripped = line.replace(/^[-*•]\s*/, "");
    return `${i + 1}. ${stripped}`;
  }).join("\n");
}

// ─── Default timeouts ────────────────────────────────────────────────────────

const DEFAULT_LLM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PR_REVIEW_LLM_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — PR reviews need more time

// ─── ReviewerClient ──────────────────────────────────────────────────────────

export class ReviewerClient {
  private log = createLogger("reviewer-client");

  constructor(private config: OrchestratorConfig) {}

  /**
   * Verify a completed task's quality.
   * Sends the task description + result to the reviewer pool for assessment.
   */
  async verifyTask(task: Task): Promise<VerificationResult> {
    const client = createLLMClient(this.config);

    const isResearch = task.task_type === "research";
    const prompt = isResearch
      ? `## Research Question\n${task.description ?? task.title}\n\n## Agent Analysis (${task.agent_name})\n${task.result ?? "(no result)"}`
      : `## Task\n${task.description ?? task.title}\n\n## Agent Response (${task.agent_name})\n${task.result ?? "(no result)"}`;

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), DEFAULT_LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          system: isResearch ? VERIFY_RESEARCH_SYSTEM_PROMPT : VERIFY_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        }, { signal: abortController.signal });
      } finally {
        clearTimeout(timer);
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      return this.parseVerificationResponse(text);
    } catch (err) {
      this.log.error("Verification LLM call failed", {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Review a PR diff.
   * Sends PR metadata + diff to the reviewer pool for code review.
   */
  async reviewPRDiff(prompt: string): Promise<PRReviewResult> {
    const client = createLLMClient(this.config);

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), PR_REVIEW_LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 2048,
          system: PR_REVIEW_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        }, { signal: abortController.signal });
      } finally {
        clearTimeout(timer);
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      return this.parsePRReviewResponse(text);
    } catch (err) {
      this.log.error("PR review LLM call failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Run the supervisor review cycle.
   * Sends the current system context to the reviewer pool for strategic analysis.
   */
  async supervisorReview(context: string): Promise<SupervisorDecision[]> {
    const client = createLLMClient(this.config);

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), DEFAULT_LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: SUPERVISOR_SYSTEM_PROMPT,
          messages: [{ role: "user", content: context }],
        }, { signal: abortController.signal });
      } finally {
        clearTimeout(timer);
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      return this.parseSupervisorResponse(text);
    } catch (err) {
      this.log.error("Supervisor review LLM call failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Analyze recent tasks for cross-cutting product improvements.
   * Sends task summaries to the reviewer pool for analysis.
   */
  async analyzeImprovements(tasks: Task[]): Promise<DetectedImprovement[]> {
    const implTasks = tasks.filter((t) => t.task_type !== "research");
    if (implTasks.length === 0) return [];

    const client = createLLMClient(this.config);

    const taskSummaries = implTasks.map((t) => ({
      id: t.id.slice(0, 8),
      agent: t.agent_name,
      title: t.title,
      status: t.status,
      source: t.source,
      quality_score: t.quality_score,
      verification: t.verification_status,
      result_preview: t.result?.slice(0, 200),
    }));

    const prompt = `Analyze these ${implTasks.length} recent tasks and identify cross-cutting improvements:\n\n${JSON.stringify(taskSummaries, null, 2)}`;

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), DEFAULT_LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: IMPROVEMENT_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        }, { signal: abortController.signal });
      } finally {
        clearTimeout(timer);
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      return this.parseImprovementResponse(text, implTasks);
    } catch {
      return [];
    }
  }

  // ─── Response parsers ──────────────────────────────────────────────────────

  private parseVerificationResponse(text: string): VerificationResult {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      return {
        approved: Boolean(parsed.approved),
        score: Math.min(Math.max(Number(parsed.score) || 0, 0), 1),
        notes: String(parsed.notes ?? ""),
        revision: parsed.revision ? String(parsed.revision) : undefined,
      };
    } catch {
      return { approved: false, score: 0, notes: "Failed to parse verification response" };
    }
  }

  private parsePRReviewResponse(text: string): PRReviewResult {
    // Try multiple extraction strategies to handle varied LLM output formats.
    // Claude often wraps JSON in explanation text or adds trailing commentary.
    const strategies = [
      // 1. Strip code fences and parse directly
      () => JSON.parse(text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim()),
      // 2. Extract first JSON object containing "decision" from anywhere
      () => {
        const match = text.match(/\{[\s\S]*?"decision"[\s\S]*?\}/);
        if (!match) throw new Error("No JSON object found");
        return JSON.parse(match[0]);
      },
      // 3. Find JSON between code fences specifically
      () => {
        const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (!match) throw new Error("No code fence found");
        return JSON.parse(match[1].trim());
      },
    ];

    for (const strategy of strategies) {
      try {
        const parsed = strategy();
        const decision = ["approve", "request-changes", "escalate"].includes(parsed.decision)
          ? parsed.decision as PRReviewResult["decision"]
          : "escalate";
        const comment = String(parsed.comment ?? "");
        return {
          decision,
          comment: decision === "request-changes" ? enforceChecklist(comment) : comment,
          reason: String(parsed.reason ?? ""),
        };
      } catch {
        continue;
      }
    }

    return { decision: "escalate", comment: "Could not parse review — escalating to human.", reason: "Parse failure" };
  }

  private parseSupervisorResponse(text: string): SupervisorDecision[] {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
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
          rationale: d.rationale ? String(d.rationale) : undefined,
        }));
    } catch {
      return [];
    }
  }

  private parseImprovementResponse(text: string, tasks: Task[]): DetectedImprovement[] {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      const agentNames = new Set(Object.keys(this.config.agents));

      return parsed
        .filter((item: Record<string, unknown>) =>
          item.title && item.description && Array.isArray(item.affected_agents),
        )
        .map((item: Record<string, unknown>) => ({
          title: String(item.title),
          description: String(item.description),
          affected_agents: (item.affected_agents as string[]).filter((a) => agentNames.has(a)),
          severity: (["low", "medium", "high"].includes(String(item.severity)) ? String(item.severity) : "medium") as "low" | "medium" | "high",
          evidence: tasks
            .filter((t) => (item.affected_agents as string[]).includes(t.agent_name ?? ""))
            .slice(0, 3)
            .map((t) => ({ taskId: t.id, detail: t.title })),
        }))
        .filter((imp) => imp.affected_agents.length > 0);
    } catch {
      return [];
    }
  }
}
