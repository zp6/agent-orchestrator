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
import { createLLMClient, getLLMModel } from "./llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";
import { extractJSON } from "../utils/json-extract.js";
import { cacheableSystemPrompt, cacheableSplitPrompt } from "../utils/prompt-cache.js";

// ─── Shared types (re-exported so consumers don't need to reach into modules) ───

export interface VerificationResult {
  approved: boolean;
  score: number;
  notes: string;
  revision?: string;
  /** Per-dimension score breakdown — keys vary by task type.
   *  Implementation: correctness, completeness, test_coverage, code_quality
   *  Research: thoroughness, evidence, alternatives, honesty
   *  Facilitation: decision_quality, format_selection, participant_selection, clarity */
  dimensions?: Record<string, number>;
  /**
   * Provenance of the score value.
   *
   * - `'llm'`              — score was parsed from the reviewer LLM response
   * - `'default_fallback'` — score is a hardcoded default (parse error, JSON
   *                          truncation, or unrecognised format); auto-approval
   *                          MUST be blocked for this provenance
   */
  score_source?: "llm" | "default_fallback";
}

export interface PRReviewResult {
  decision: "approve" | "request-changes" | "escalate" | "error";
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
  /** LLM-assigned confidence score (0–1) for dispatch/follow-up decisions. */
  confidence?: number;
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
  "revision": "If not approved, specific guidance for improvement (omit if approved)",
  "dimensions": {
    "correctness": 0.0-1.0 (does the solution work and achieve the goal?),
    "completeness": 0.0-1.0 (does it fully address all requirements?),
    "test_coverage": 0.0-1.0 (are tests passing and coverage adequate?),
    "code_quality": 0.0-1.0 (is the code maintainable and well-structured?)
  }
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
  "revision": "If not approved, specific guidance for improvement (omit if approved)",
  "dimensions": {
    "thoroughness": 0.0-1.0 (did the agent investigate fully, or leave gaps?),
    "evidence": 0.0-1.0 (are claims backed by concrete examples and data?),
    "alternatives": 0.0-1.0 (were multiple approaches considered and compared?),
    "honesty": 0.0-1.0 (acknowledged uncertainty, risks, and limitations?)
  }
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

const VERIFY_FACILITATION_SYSTEM_PROMPT = `You are a quality reviewer for meeting facilitation decisions produced by an AI agent. The agent evaluates meeting requests, decides whether to run/skip/defer meetings, selects formats and participants, and synthesises outcomes.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Brief assessment of facilitation quality",
  "revision": "If not approved, specific guidance for improvement (omit if approved)",
  "dimensions": {
    "decision_quality": 0.0-1.0 (was the run/skip/defer decision well-reasoned?),
    "format_selection": 0.0-1.0 (was the chosen format appropriate for the topic?),
    "participant_selection": 0.0-1.0 (were the right agents included?),
    "clarity": 0.0-1.0 (is the outcome clear and actionable?)
  }
}

Evaluate facilitation quality on:
- **Decision quality**: Was the run/skip/defer decision appropriate? Skipping a vague topic is CORRECT. Deferring when the cap is reached is CORRECT. These are good facilitation, not failures.
- **Format selection**: If a meeting was run, was the format appropriate for the topic?
- **Participant selection**: Were the right agents included (not too many, not too few)?
- **Clarity**: Is the output clear? Does it state the decision, reasoning, and next steps?
- **Efficiency**: Did the facilitator avoid unnecessary work? A well-reasoned "skip" is better than running a pointless meeting.

Scoring guide:
- 0.9-1.0: Excellent — clear decision with solid reasoning, appropriate format/participants
- 0.7-0.89: Good — reasonable decision, minor gaps in reasoning or participant selection
- 0.5-0.69: Acceptable — decision made but reasoning is thin or format choice is questionable
- Below 0.5: Needs revision — no clear decision, wrong format, or missing key participants

IMPORTANT: A "skip" or "defer" decision is NOT automatically low quality. Evaluate the REASONING, not the outcome.`;

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
    "rationale": "Issue #2 was opened 3 days ago and has no linked PR yet. The agent completed the work in task 01ABC but the branch was never pushed, blocking the PR review cycle. A successful result is the branch pushed and a PR created that closes #2.",
    "confidence": 0.85
  }
]

For "dispatch" and "follow-up" actions, ALWAYS include a "rationale" field that explains:
1. Why this issue/task was selected (recency, failure count, user impact, priority)
2. What prior work is relevant (previous attempts, related tasks, dependencies)
3. What a successful result looks like (expected deliverable, acceptance criteria)

Also include a "confidence" field (number 0–1) indicating how confident you are that this dispatch will succeed:
- 0.9–1.0: high confidence (clear issue, idle agent, no prior failures)
- 0.6–0.8: moderate confidence (some uncertainty — e.g. prior failures on similar tasks)
- 0.0–0.5: low confidence (speculative dispatch, vague requirements, or risky agent assignment)

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

ANTI-NAVEL-GAZING RULE (mandatory — check before every dispatch cycle):
You will see a "## External Impact (7 days)" section showing what fraction of recent work advanced OKR-1 (external-oss-impact).
- If OKR-1 external-impact ratio is BELOW 30% over the last 7 days: REFUSE to dispatch new internal work (housekeeping, refactoring, tooling, CI fixes, self-optimization, infrastructure monitoring). Instead, find and dispatch OKR-1 issues — the external-oss-impact goal must move.
- If external-impact ratio is 30% or above: internal work is permitted at a rate of at most 1 internal dispatch per 2 OKR-advancing dispatches in this cycle.
- If "## External Impact" shows the Director has set internal_dispatch_paused=true: treat ALL housekeeping and infrastructure dispatches as blocked regardless of ratio. Only OKR-tagged work may be dispatched.
- "Internal work" includes any task whose net effect is zero external user impact: housekeeping, backlog-triage, dependency updates, CI fixes, code refactoring, self-monitoring improvements, internal tooling, and infrastructure health checks.
- When you refuse internal work due to this rule, include a "navel_gazing_risk" note in your reason field so the operator can see the gate was applied.

Be specific and actionable. Only suggest actions that address real gaps. Return [] if everything is on track.`;

/**
 * Build the improvement detection system prompt dynamically from config.
 * Lists all agents (one per pool) so the LLM knows about the full fleet.
 */
function buildImprovementSystemPrompt(config: OrchestratorConfig): string {
  const seenPools = new Set<string>();
  const agentLines = Object.entries(config.agents)
    .filter(([, a]) => {
      if (!a.github && !a.description) return false;
      const key = a.pool ?? "none";
      if (seenPools.has(key)) return false;
      seenPools.add(key);
      return true;
    })
    .map(([name, a]) => `- ${name}: ${a.description}`)
    .join("\n");

  return `You are a product improvement analyst for a multi-agent system. Each agent is a product with users. Analyze recent task results and suggest improvements that make agents more useful, not just more technically polished.

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
${agentLines}

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
}

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

const DEFAULT_LLM_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes — keeps sequential verification under DEADLOCK threshold
const PR_REVIEW_LLM_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes — same budget; hung calls skip and retry next cycle

// ─── ReviewerClient ──────────────────────────────────────────────────────────

export class ReviewerClient {
  private log = createLogger("reviewer-client");

  constructor(private config: OrchestratorConfig) {}

  /**
   * Resolve the verification system prompt and user-prompt for a task type.
   *
   * Resolution order:
   *   1. `task_types.<type>` entry in agents.yaml (fully configurable)
   *   2. Built-in defaults for "implementation", "research", "facilitation"
   *   3. Generic implementation prompt for unknown types
   *
   * This lets new non-coding task types (planning, coordination, etc.) be
   * added via agents.yaml without any changes to this file.
   */
  private resolveVerificationPrompts(taskType: string, task: Task): {
    systemPrompt: string;
    userPrompt: string;
  } {
    // 1. Config-defined task type overrides built-ins
    const customDef = this.config.task_types?.[taskType];
    if (customDef) {
      const descHeader = customDef.prompt_header ?? "Task";
      const resultHeader = customDef.result_header ?? "Agent Response";
      return {
        systemPrompt: customDef.verification_prompt,
        userPrompt: `## ${descHeader}\n${task.description ?? task.title}\n\n## ${resultHeader} (${task.agent_name})\n${task.result ?? "(no result)"}`,
      };
    }

    // 2. Built-in defaults for known types
    if (taskType === "research") {
      return {
        systemPrompt: VERIFY_RESEARCH_SYSTEM_PROMPT,
        userPrompt: `## Research Question\n${task.description ?? task.title}\n\n## Agent Analysis (${task.agent_name})\n${task.result ?? "(no result)"}`,
      };
    }
    if (taskType === "facilitation") {
      return {
        systemPrompt: VERIFY_FACILITATION_SYSTEM_PROMPT,
        userPrompt: `## Meeting Request\n${task.description ?? task.title}\n\n## Facilitator Response (${task.agent_name})\n${task.result ?? "(no result)"}`,
      };
    }

    // 3. Generic fallback (implementation + unknown types)
    return {
      systemPrompt: VERIFY_SYSTEM_PROMPT,
      userPrompt: `## Task\n${task.description ?? task.title}\n\n## Agent Response (${task.agent_name})\n${task.result ?? "(no result)"}`,
    };
  }

  /**
   * Verify a completed task's quality.
   * Sends the task description + result to the reviewer pool for assessment.
   */
  async verifyTask(task: Task): Promise<VerificationResult> {
    const { client, model } = createLLMClient(this.config, "verifier");

    const taskType = task.task_type ?? "implementation";
    const { systemPrompt, userPrompt: prompt } = this.resolveVerificationPrompts(taskType, task);

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), DEFAULT_LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create({
          model: getLLMModel(this.config, "verifier") ?? model,
          max_tokens: 1024,
          system: cacheableSystemPrompt(systemPrompt),
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
    const { client, model } = createLLMClient(this.config, "reviewer");

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), PR_REVIEW_LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create({
          model: getLLMModel(this.config, "reviewer") ?? model,
          max_tokens: 2048,
          system: cacheableSystemPrompt(PR_REVIEW_SYSTEM_PROMPT),
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
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error("PR review LLM call failed — returning error decision", { error: msg });
      return { decision: "error", comment: `Review LLM call failed: ${msg}`, reason: msg };
    }
  }

  /**
   * Run the supervisor review cycle.
   * Sends the current system context to the reviewer pool for strategic analysis.
   */
  async supervisorReview(context: string): Promise<SupervisorDecision[]> {
    const { client, model } = createLLMClient(this.config, "supervisor");

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), DEFAULT_LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create({
          model: getLLMModel(this.config, "supervisor") ?? model,
          max_tokens: 4096,
          system: cacheableSystemPrompt(SUPERVISOR_SYSTEM_PROMPT),
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

    const { client, model } = createLLMClient(this.config, "improvement");

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
          model: getLLMModel(this.config, "improvement") ?? model,
          max_tokens: 4096,
          system: cacheableSystemPrompt(buildImprovementSystemPrompt(this.config)),
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
    // Minimum quality floor: a score of exactly 0 from the LLM is almost
    // always a malformed response (parse error, JSON truncation, or the
    // reviewer hallucinating a 0-100 scale value of "0" instead of "0.0–1.0").
    // Approving such a response silently corrupts quality metrics and bypasses
    // every downstream threshold gate.  We hard-block any approval where the
    // parsed score does not exceed this floor, and emit a warning for observability.
    const SCORE_ZERO_FLOOR = 0.01;
    const minConfiguredScore = this.config.verification?.min_score ?? 0.7;

    const parsed = extractJSON<Record<string, unknown>>(text, "score");
    if (parsed && typeof parsed.score !== "undefined") {
      const score = Math.min(Math.max(Number(parsed.score) || 0, 0), 1);
      const looksApproved = Boolean(parsed.approved);

      // Hard floor: refuse approval when score is effectively zero regardless
      // of what the LLM's approved field says.
      const approved = looksApproved && score >= SCORE_ZERO_FLOOR;

      if (looksApproved && !approved) {
        this.log.warn("Score-0 silent approval blocked — LLM said approved=true but score is effectively zero; overriding to rejected", {
          rawScore: parsed.score,
          floor: SCORE_ZERO_FLOOR,
        });
      }

      // Secondary floor: warn (but don't hard-block here) when approved=true
      // but score is below the configured minimum.  Hard enforcement happens
      // in verifyAndReviseTask via the min_score config gate, but we log early
      // so operators can correlate reviewer-client warnings with verification
      // outcome records without waiting for the daemon-level gate to fire.
      if (approved && score < minConfiguredScore) {
        this.log.warn("Verification approved below configured min_score — may be rejected by quality gate", {
          score,
          minConfiguredScore,
        });
      }

      const result: VerificationResult = {
        approved,
        score,
        notes: String(parsed.notes ?? ""),
        revision: parsed.revision ? String(parsed.revision) : undefined,
        score_source: "llm",
      };

      // Extract per-dimension scores if present
      if (parsed.dimensions && typeof parsed.dimensions === "object") {
        const dims = parsed.dimensions as Record<string, unknown>;
        const dimensions: Record<string, number> = {};
        // Extract all numeric dimension scores — covers implementation, research,
        // facilitation, and any future task type dimensions without hardcoding keys.
        for (const key of Object.keys(dims)) {
          const val = dims[key];
          if (typeof val === "number") {
            dimensions[key] = Math.min(Math.max(val, 0), 1);
          }
        }
        if (Object.keys(dimensions).length > 0) {
          result.dimensions = dimensions as VerificationResult["dimensions"];
        }
      }

      return result;
    }

    // Fallback: extract score from plain text like "Score: 0.8"
    const scoreMatch = text.match(/score[:\s=]+([0-9.]+)/i);
    if (scoreMatch) {
      const score = parseFloat(scoreMatch[1]);
      const approvedMatch = text.match(/approved[:\s=]+(true|false)/i);
      return {
        approved: approvedMatch ? approvedMatch[1].toLowerCase() === "true" : score >= 0.7,
        score: Math.min(Math.max(score, 0), 1),
        notes: text.slice(0, 200),
        score_source: "default_fallback",
      };
    }

    return { approved: false, score: 0, notes: "Failed to parse verification response", score_source: "default_fallback" };
  }

  private parsePRReviewResponse(text: string): PRReviewResult {
    const parsed = extractJSON<Record<string, unknown>>(text, "decision");
    if (parsed && parsed.decision) {
      const decision = ["approve", "request-changes", "escalate"].includes(parsed.decision as string)
        ? parsed.decision as PRReviewResult["decision"]
        : "escalate";
      const comment = String(parsed.comment ?? "");
      return {
        decision,
        comment: decision === "request-changes" ? enforceChecklist(comment) : comment,
        reason: String(parsed.reason ?? ""),
      };
    }

    this.log.warn("PR review parse failed — will retry next cycle", { textLength: text.length, preview: text.slice(0, 200) });
    return { decision: "error", comment: "Could not parse review response — will retry next cycle.", reason: "Parse failure" };
  }

  private parseSupervisorResponse(text: string): SupervisorDecision[] {
    try {
      const parsed = extractJSON<Array<Record<string, unknown>>>(text);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((d: Record<string, unknown>) => d.action && d.reason)
        .map((d: Record<string, unknown>) => ({
          action: String(d.action) as SupervisorDecision["action"],
          agentName: d.agentName ? String(d.agentName) : undefined,
          message: d.message ? String(d.message) : undefined,
          reason: String(d.reason),
          rationale: d.rationale ? String(d.rationale) : undefined,
          confidence: typeof d.confidence === "number" && d.confidence >= 0 && d.confidence <= 1
            ? d.confidence
            : undefined,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Generate a one-sentence risk summary for an operator deciding whether to
   * manually approve a task that failed automated verification.
   *
   * The sentence explains the key failure mode in plain language so the
   * operator can make an informed decision from Telegram alone.
   * Falls back to `result.notes` on any error (the LLM call is best-effort).
   */
  async generateRiskSummary(task: Task, result: VerificationResult): Promise<string> {
    const dimText = result.dimensions && Object.keys(result.dimensions).length > 0
      ? Object.entries(result.dimensions)
          .map(([k, v]) => `${k.replace(/_/g, " ")}: ${(v * 100).toFixed(0)}%`)
          .join(", ")
      : "no dimension data";

    const systemPrompt =
      "You are a quality reviewer for an AI agent orchestrator. " +
      "Write exactly ONE sentence summarising the key risk or failure mode for an operator " +
      "considering whether to manually approve a task that failed automated verification. " +
      "Be specific and actionable — name the concrete gap, not just 'quality is low'. " +
      "Output only the sentence, no JSON, no preamble, no markdown.";

    const userPrompt =
      `Task: ${task.title}\n` +
      `Description: ${(task.description ?? task.title).slice(0, 400)}\n` +
      `Score: ${(result.score * 100).toFixed(0)}%\n` +
      `Dimensions: ${dimText}\n` +
      `Reviewer notes: ${result.notes.slice(0, 300)}\n\n` +
      "In one sentence, what is the key risk an operator should know when deciding whether to approve this task?";

    try {
      const { client, model } = createLLMClient(this.config, "verifier");
      const response = await client.messages.create({
        model: getLLMModel(this.config, "verifier") ?? model,
        max_tokens: 150,
        system: cacheableSystemPrompt(systemPrompt),
        messages: [{ role: "user", content: userPrompt }],
      });
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("")
        .trim();
      return text || result.notes.slice(0, 200);
    } catch {
      return result.notes.slice(0, 200);
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
