/**
 * Task verifier — assesses quality of completed agent tasks.
 *
 * Migrated from rapartlu/claude-agent-orchestrator:src/orchestrator/verifier.ts
 * Adaptations:
 *   - Uses createLLMClient() from ../client/llm-client (no proxy routing)
 *   - Accepts IStateStore interface instead of concrete StateStore
 *   - Removed Dispatcher dependency — revision re-dispatch is handled by the
 *     orchestrator daemon, not the reviewer itself
 *   - Config is ReviewerConfig (simpler shape, no proxy/docker fields)
 *   - Accepts optional Notifier for second-pass escalation alerts
 */

import { createLLMClient } from "../client/llm-client.js";
import { createLogger } from "../service/logger.js";
import type {
  IStateStore,
  IVerificationResultStore,
  SubtaskRollupPolicy,
  SubtaskRollupResult,
  SubtaskChildSummary,
} from "../state/types.js";
import type { Notifier } from "../notify.js";

/**
 * Per-dimension quality scores for verification results.
 * When a task is rejected, these scores break down which aspects failed.
 * Each dimension is 0.0–1.0, with agents able to target their revisions
 * to specific problem areas.
 */
export interface QualityDimensions {
  /** Logic correctness, no bugs or logical errors. */
  correctness: number;
  /** All requirements and acceptance criteria addressed. */
  completeness: number;
  /** Sufficient test coverage, edge cases handled. */
  test_coverage: number;
  /** Code clarity, maintainability, documentation. */
  code_quality: number;
}

export interface VerificationResult {
  approved: boolean;
  score: number;
  notes: string;
  revision?: string;
  /**
   * Natural-language explanation for why the score fell below 0.80.
   * One to three sentences surfacing which acceptance criteria were missing,
   * what gaps were found, or what made the work hard to verify.
   * Populated only when score < 0.80; undefined otherwise.
   */
  explanation?: string;
  /**
   * Per-dimension quality breakdown.
   * Populated when the LLM provides dimension scores in its response.
   * Allows agents to understand exactly which aspects of their work need improvement.
   */
  dimensions?: QualityDimensions;
  /**
   * Present when a borderline score (0.70–0.79) triggered an automatic
   * second-pass review. The orchestrator can use this to detect disagreements.
   */
  secondPass?: {
    score: number;
    notes: string;
    /** True when both passes agreed on the approval decision. */
    agreed: boolean;
    /** Dimensions from second-pass review (when available). */
    dimensions?: QualityDimensions;
  };
}

/**
 * Minimum score required to approve a task.
 * Also recorded as the `threshold` field in `verification_results`.
 */
const APPROVAL_THRESHOLD = 0.80;

/**
 * Score range that triggers automatic second-pass review.
 * Tasks with a first-pass score in [BORDERLINE_LOW, BORDERLINE_HIGH] are
 * independently evaluated a second time before approval is finalised.
 */
const BORDERLINE_LOW = 0.70;
const BORDERLINE_HIGH = 0.79;

const SYSTEM_PROMPT = `You are a quality reviewer for an AI agent orchestrator. Given a task description and the agent's response, assess the quality of the work.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Brief assessment of quality, completeness, correctness",
  "revision": "If not approved, specific guidance for improvement (omit if approved)",
  "explanation": "REQUIRED when score < 0.80: 1-3 sentences explaining what drove the low score — e.g. which acceptance criteria were unmet, what gaps were found, or why the work was hard to verify. Omit entirely when score >= 0.80.",
  "dimensions": {
    "correctness": 0.0-1.0,
    "completeness": 0.0-1.0,
    "test_coverage": 0.0-1.0,
    "code_quality": 0.0-1.0
  }
}

Scoring guide:
- 0.9-1.0: Excellent — thorough, correct, well-structured
- 0.7-0.89: Good — meets requirements with minor gaps
- 0.5-0.69: Acceptable — partially addresses the task
- Below 0.5: Needs revision — incomplete or incorrect

Dimension guide:
- **correctness**: Does the code work correctly with no logic errors? Is it sound?
- **completeness**: Are all requirements and acceptance criteria addressed?
- **test_coverage**: Are edge cases covered? Is test coverage sufficient?
- **code_quality**: Is the code clear, maintainable, and well-documented?`;

const RESEARCH_SYSTEM_PROMPT = `You are a quality reviewer for research and feasibility analysis produced by an AI agent. Given a research question and the agent's analysis, assess the quality of the research.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Brief assessment of research quality",
  "revision": "If not approved, specific guidance for improvement (omit if approved)",
  "explanation": "REQUIRED when score < 0.80: 1-3 sentences explaining what drove the low score — e.g. which research dimensions were thin, what evidence was missing, or why the analysis was hard to act on. Omit entirely when score >= 0.80.",
  "dimensions": {
    "correctness": 0.0-1.0,
    "completeness": 0.0-1.0,
    "test_coverage": 0.0-1.0,
    "code_quality": 0.0-1.0
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
- Below 0.5: Needs revision — superficial, missing key considerations, or not actionable

Dimension guide (for research tasks):
- **correctness**: Are the claims technically sound and factually accurate?
- **completeness**: Does the analysis address all relevant aspects of the question?
- **test_coverage**: Were the findings validated or stress-tested? (Or "evidence coverage" — was evidence gathered comprehensively?)
- **code_quality**: (Not applicable to research — rate as the analysis clarity/organization instead)`;

/**
 * System prompt for the second-pass reviewer.
 * Deliberately more sceptical — it knows a first reviewer already approved
 * with a borderline score and is asked to independently validate.
 */
const SECOND_PASS_SYSTEM_PROMPT = `You are a senior quality auditor performing an independent second-pass review.
A first reviewer already assessed this task and gave a borderline approval score (0.70–0.79).
Your job is to independently evaluate the work WITHOUT being anchored to that score.

Be thorough and critical. A borderline score means the work probably has real gaps.
Ask yourself: "Would I be comfortable merging/shipping this as-is?"

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Independent assessment — be specific about what is missing or wrong",
  "revision": "If not approved, concrete guidance for what needs to change (omit if approved)",
  "explanation": "REQUIRED when score < 0.80: 1-3 sentences explaining what drove the low score — which criteria were unmet, what gaps were found, or what made the work hard to verify. Omit entirely when score >= 0.80.",
  "dimensions": {
    "correctness": 0.0-1.0,
    "completeness": 0.0-1.0,
    "test_coverage": 0.0-1.0,
    "code_quality": 0.0-1.0
  }
}

Scoring guide:
- 0.9-1.0: Excellent — thorough, correct, well-structured
- 0.7-0.89: Good — meets requirements with minor gaps
- 0.5-0.69: Acceptable — partially addresses the task
- Below 0.5: Needs revision — incomplete or incorrect

Dimension guide:
- **correctness**: Does the code work correctly with no logic errors? Is it sound?
- **completeness**: Are all requirements and acceptance criteria addressed?
- **test_coverage**: Are edge cases covered? Is test coverage sufficient?
- **code_quality**: Is the code clear, maintainable, and well-documented?`;

export class Verifier {
  private log = createLogger("verifier");

  constructor(
    private store: IStateStore,
    private notifier?: Notifier,
    private verificationResultStore?: IVerificationResultStore,
  ) {}

  /**
   * Format quality dimensions as a human-readable breakdown for revision messages.
   * Returns a multi-line string showing per-dimension scores and status indicators.
   */
  private formatDimensionsBreakdown(dimensions: QualityDimensions): string {
    const threshold = 0.8;
    const formatScore = (d: number) => `${(d * 100).toFixed(0)}/100`;
    const indicator = (d: number) => (d >= threshold ? "✓" : "✗");

    return [
      "## Quality Dimensions Breakdown",
      `- **Correctness**: ${formatScore(dimensions.correctness)} ${indicator(dimensions.correctness)} (logic, no bugs)`,
      `- **Completeness**: ${formatScore(dimensions.completeness)} ${indicator(dimensions.completeness)} (requirements met)`,
      `- **Test Coverage**: ${formatScore(dimensions.test_coverage)} ${indicator(dimensions.test_coverage)} (edge cases covered)`,
      `- **Code Quality**: ${formatScore(dimensions.code_quality)} ${indicator(dimensions.code_quality)} (clarity, documentation)`,
    ].join("\n");
  }

  /**
   * Record a verification result to the `verification_results` table.
   * Fire-and-forget — errors are swallowed so instrumentation never interrupts
   * the main verification flow.
   */
  private recordVerificationResult(
    taskId: string,
    agentId: string,
    score: number,
    approved: boolean,
    rejectionReason?: string,
  ): void {
    // Prefer the explicitly-wired store; fall back to a runtime check on the
    // main store (the reviewer's own StateStore implements IVerificationResultStore).
    const vStore =
      this.verificationResultStore ??
      (typeof (this.store as unknown as IVerificationResultStore).insertVerificationResult ===
      "function"
        ? (this.store as unknown as IVerificationResultStore)
        : undefined);

    if (!vStore) return;

    try {
      vStore.insertVerificationResult({
        task_id: taskId,
        score,
        first_pass: approved ? 1 : 0,
        rejection_reason: approved ? null : (rejectionReason ?? null),
        threshold: APPROVAL_THRESHOLD,
        agent_id: agentId,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // Never let instrumentation interrupt the main flow.
      this.log.warn("Failed to record verification result", { taskId, err });
    }
  }

  async verify(taskId: string): Promise<VerificationResult> {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== "done") {
      throw new Error(`Task ${taskId} is not done (status: ${task.status})`);
    }

    this.store.updateTask(taskId, { verification_status: "pending" });

    const client = createLLMClient();

    const isResearch = task.task_type === "research";
    const prompt = isResearch
      ? `## Research Question\n${task.description ?? task.title}\n\n## Agent Analysis (${task.agent_name})\n${task.result ?? "(no result)"}`
      : `## Task\n${task.description ?? task.title}\n\n## Agent Response (${task.agent_name})\n${task.result ?? "(no result)"}`;

    const LLM_TIMEOUT_MS = 5 * 60 * 1000;

    // ── First pass ──────────────────────────────────────────────────────────
    const firstPassResult = await this.runLLMPass(
      client,
      isResearch ? RESEARCH_SYSTEM_PROMPT : SYSTEM_PROMPT,
      prompt,
      LLM_TIMEOUT_MS,
      taskId,
      "first-pass",
    );

    // ── Borderline second-pass guard ────────────────────────────────────────
    const isBorderline =
      firstPassResult.score >= BORDERLINE_LOW && firstPassResult.score <= BORDERLINE_HIGH;

    if (isBorderline) {
      this.log.info("Borderline score — triggering second-pass review", {
        taskId,
        firstPassScore: firstPassResult.score,
        agent: task.agent_name,
      });

      const secondPassResult = await this.runLLMPass(
        client,
        SECOND_PASS_SYSTEM_PROMPT,
        prompt,
        LLM_TIMEOUT_MS,
        taskId,
        "second-pass",
      );

      const agreed = firstPassResult.approved === secondPassResult.approved;

      // Conservative final decision: if either pass rejects, reject overall.
      const finalApproved = firstPassResult.approved && secondPassResult.approved;

      const combinedNotes = [
        `[First pass — score ${(firstPassResult.score * 100).toFixed(0)}%] ${firstPassResult.notes}`,
        `[Second pass — score ${(secondPassResult.score * 100).toFixed(0)}%] ${secondPassResult.notes}`,
        agreed
          ? `[Agreement: both passes ${finalApproved ? "approved" : "rejected"}]`
          : `[Disagreement: passes diverged — conservative decision: ${finalApproved ? "approved" : "rejected"}]`,
      ].join("\n");

      // Escalate to Telegram when passes disagree.
      if (!agreed && this.notifier) {
        const body = [
          `Task \`${taskId.slice(0, 12)}\` scored *${(firstPassResult.score * 100).toFixed(0)}%* on first pass — borderline range triggered second review.`,
          ``,
          `*First pass:* ${firstPassResult.approved ? "✅ approved" : "❌ rejected"} (${(firstPassResult.score * 100).toFixed(0)}%)`,
          `*Second pass:* ${secondPassResult.approved ? "✅ approved" : "❌ rejected"} (${(secondPassResult.score * 100).toFixed(0)}%)`,
          `*Agent:* \`${task.agent_name ?? "unknown"}\``,
          `*Conservative outcome:* ${finalApproved ? "approved" : "rejected"}`,
        ].join("\n");

        await this.notifier.notifyOperator(
          "Borderline review disagreement",
          body,
          "medium",
        );
      }

      // Prefer the second-pass explanation when available; fall back to first pass.
      // Borderline scores (0.70–0.79) are always sub-0.80, so we always expect one.
      const finalExplanation =
        secondPassResult.explanation ?? firstPassResult.explanation;

      // When not approved, enrich the revision guidance with the explanation so
      // agents know what specifically drove the low score.
      const baseRevision = secondPassResult.revision ?? firstPassResult.revision;
      const usedDimensions = secondPassResult.dimensions ?? firstPassResult.dimensions;
      const dimensionsBreakdown =
        !finalApproved && usedDimensions
          ? `\n\n${this.formatDimensionsBreakdown(usedDimensions)}`
          : "";
      const enrichedRevision =
        !finalApproved && baseRevision && finalExplanation
          ? `${finalExplanation}${dimensionsBreakdown}\n\n${baseRevision}`
          : baseRevision;

      const finalResult: VerificationResult = {
        approved: finalApproved,
        score: firstPassResult.score,
        notes: combinedNotes,
        revision: finalApproved ? undefined : enrichedRevision,
        explanation: finalExplanation,
        dimensions: usedDimensions,
        secondPass: {
          score: secondPassResult.score,
          notes: secondPassResult.notes,
          agreed,
          dimensions: secondPassResult.dimensions,
        },
      };

      this.log.info("Second-pass review complete", {
        taskId,
        firstPassApproved: firstPassResult.approved,
        secondPassApproved: secondPassResult.approved,
        agreed,
        finalApproved,
        agent: task.agent_name,
        ...(finalExplanation && { explanation: finalExplanation }),
      });

      this.store.updateTask(taskId, {
        verification_status: finalApproved ? "approved" : "rejected",
        quality_score: firstPassResult.score,
        verification_notes: combinedNotes,
        quality_explanation: finalExplanation ?? null,
      });

      this.recordVerificationResult(
        taskId,
        task.agent_name ?? "unknown",
        firstPassResult.score,
        finalApproved,
        finalApproved ? undefined : (finalExplanation ?? finalResult.revision),
      );

      return finalResult;
    }

    // ── Standard (non-borderline) result ────────────────────────────────────
    this.log.info("Verification complete", {
      taskId,
      approved: firstPassResult.approved,
      score: firstPassResult.score,
      agent: task.agent_name,
      ...(firstPassResult.explanation && { explanation: firstPassResult.explanation }),
    });

    // Enrich revision with explanation and dimension breakdown so agents understand the low score.
    const dimensionsBreakdown =
      !firstPassResult.approved && firstPassResult.dimensions
        ? `\n\n${this.formatDimensionsBreakdown(firstPassResult.dimensions)}`
        : "";
    const enrichedRevision =
      !firstPassResult.approved &&
      firstPassResult.revision &&
      firstPassResult.explanation
        ? `${firstPassResult.explanation}${dimensionsBreakdown}\n\n${firstPassResult.revision}`
        : firstPassResult.revision;

    this.store.updateTask(taskId, {
      verification_status: firstPassResult.approved ? "approved" : "rejected",
      quality_score: firstPassResult.score,
      verification_notes: firstPassResult.notes,
      quality_explanation: firstPassResult.explanation ?? null,
    });

    this.recordVerificationResult(
      taskId,
      task.agent_name ?? "unknown",
      firstPassResult.score,
      firstPassResult.approved,
      firstPassResult.approved ? undefined : (firstPassResult.explanation ?? firstPassResult.revision),
    );

    return { ...firstPassResult, revision: enrichedRevision };
  }

  /**
   * Compute a parent task's rolled-up quality score from its children.
   *
   * Does NOT call the LLM — this is a pure aggregation over already-verified
   * child scores. Call this after children have been individually verified via
   * `verify()`. The orchestrator daemon should call `verify()` on each child
   * first, then call `rollupChildScores()` on the parent.
   *
   * Three rollup policies are supported (set via `task.rollup_policy`):
   *
   * - **`strict`**   — parent score = min(child scores). One failing child
   *                    fails the parent. `failingChildIds` contains only the
   *                    failing subtasks so the daemon can re-dispatch them
   *                    individually rather than re-running the whole parent.
   *
   * - **`majority`** — parent score = mean(child scores). Passes when ≥50%
   *                    of children have score ≥ 0.80.
   *
   * - **`weighted`** — parent score = weighted mean by `subtask_complexity_hint`
   *                    (0–1). Falls back to equal weights when hints are absent.
   *
   * Children with status `failed` or `escalated` that have no quality_score
   * are treated as score 0.0 and flagged as failing. Children still in-flight
   * (pending / dispatched / in_progress) contribute a score of 0.0 and set
   * `partialCompletion = true` in the result — the orchestrator should wait
   * for all children before acting on the rollup.
   *
   * The parent task record is updated in state.db with the rolled-up score
   * and verification_status.
   *
   * @throws {Error} if the parent task does not exist.
   */
  rollupChildScores(parentTaskId: string): SubtaskRollupResult {
    const parent = this.store.getTask(parentTaskId);
    if (!parent) {
      throw new Error(`Parent task not found: ${parentTaskId}`);
    }

    const children = this.store.getChildTasks(parentTaskId);

    const terminalStatuses = new Set(["done", "failed", "escalated"]);
    const inFlightStatuses = new Set(["pending", "planning", "dispatched", "in_progress"]);

    let completedCount = 0;
    let pendingCount = 0;

    const childSummaries: SubtaskChildSummary[] = children.map((child) => {
      const isTerminal = terminalStatuses.has(child.status);
      const isInFlight = inFlightStatuses.has(child.status);

      if (isTerminal) completedCount++;
      else if (isInFlight) pendingCount++;

      // failed/escalated children always contribute 0.0 to the rollup score,
      // even if they have a stored quality_score (that score may pre-date the failure).
      // In-flight children with no score also get 0.0 (conservative).
      const isFailedTerminal = child.status === "failed" || child.status === "escalated";
      const effectiveScore = isFailedTerminal ? 0.0 : (child.quality_score ?? 0.0);
      const weight = child.subtask_complexity_hint ?? 1.0;
      const failing =
        effectiveScore < APPROVAL_THRESHOLD ||
        child.status === "failed" ||
        child.status === "escalated";

      return {
        id: child.id,
        agent_name: child.agent_name ?? null,
        status: child.status,
        quality_score: child.quality_score ?? null,
        verification_status: child.verification_status ?? null,
        weight,
        failing,
      };
    });

    const partialCompletion = pendingCount > 0;

    // Determine policy — default to majority if not set
    const policy: SubtaskRollupPolicy = parent.rollup_policy ?? "majority";

    let parentScore: number;
    const scores = childSummaries.map((c) => c.quality_score ?? 0.0);
    const weights = childSummaries.map((c) => c.weight);

    if (childSummaries.length === 0) {
      // No children: treat parent as unscored
      parentScore = 0.0;
    } else if (policy === "strict") {
      parentScore = Math.min(...scores);
    } else if (policy === "majority") {
      const sum = scores.reduce((a, b) => a + b, 0);
      parentScore = sum / scores.length;
    } else {
      // weighted
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      if (totalWeight === 0) {
        // All weights are zero — fall back to simple mean
        const sum = scores.reduce((a, b) => a + b, 0);
        parentScore = scores.length > 0 ? sum / scores.length : 0.0;
      } else {
        const weightedSum = scores.reduce((acc, score, i) => acc + score * weights[i], 0);
        parentScore = weightedSum / totalWeight;
      }
    }

    const failingChildIds = childSummaries.filter((c) => c.failing).map((c) => c.id);

    // Majority policy: pass when ≥50% of children individually pass
    let approved: boolean;
    if (policy === "majority") {
      const passingCount = childSummaries.filter(
        (c) => (c.quality_score ?? 0) >= APPROVAL_THRESHOLD,
      ).length;
      approved = childSummaries.length > 0 && passingCount / childSummaries.length >= 0.5;
    } else {
      approved = parentScore >= APPROVAL_THRESHOLD;
    }

    // When partial: conservatively mark as not approved until all children finish
    if (partialCompletion) {
      approved = false;
    }

    const rollupNotes = [
      `[Subtask rollup — policy: ${policy}]`,
      `Children: ${children.length} total, ${completedCount} completed, ${pendingCount} pending`,
      `Parent score: ${(parentScore * 100).toFixed(0)}% (${approved ? "approved" : "rejected"})`,
      failingChildIds.length > 0
        ? `Failing children (${failingChildIds.length}): ${failingChildIds.map((id) => id.slice(0, 12)).join(", ")}`
        : "All children passing",
    ].join("\n");

    this.log.info("Subtask rollup complete", {
      parentTaskId,
      policy,
      parentScore,
      approved,
      completedCount,
      pendingCount,
      failingChildIds,
    });

    this.store.updateTask(parentTaskId, {
      quality_score: parentScore,
      verification_status: partialCompletion ? "pending" : approved ? "approved" : "rejected",
      verification_notes: rollupNotes,
    });

    return {
      parentScore,
      approved,
      policy,
      children: childSummaries,
      failingChildIds,
      completedCount,
      pendingCount,
      partialCompletion,
    };
  }

  /**
   * Verify a task and optionally signal that revision is needed.
   *
   * Unlike the orchestrator version, this does NOT re-dispatch the revision —
   * that is the daemon's responsibility. It returns the result with
   * `result.revision` populated when changes are needed, and sets
   * `verification_status = "rejected"` so the daemon can pick it up.
   *
   * If the agent is busy (has an active task), `verification_status` is reset
   * to null so the daemon retries on the next cycle.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async verifyAndRevise(taskId: string, _maxRevisions?: number): Promise<VerificationResult> {
    const result = await this.verify(taskId);

    if (result.approved || !result.revision) {
      return result;
    }

    // Capacity guard: if the agent is already busy, defer by resetting status.
    const task = this.store.getTask(taskId)!;
    if (task.agent_name && this.store.hasActiveTask(task.agent_name)) {
      this.log.info("Revision deferred: agent busy, will retry next cycle", {
        taskId,
        agentName: task.agent_name,
      });
      this.store.updateTask(taskId, { verification_status: null });
    }

    return result;
  }

  /**
   * Run a single LLM verification pass.
   * Extracted to avoid duplicating timeout/parse logic between first and second passes.
   */
  private async runLLMPass(
    client: ReturnType<typeof createLLMClient>,
    systemPrompt: string,
    userPrompt: string,
    timeoutMs: number,
    taskId: string,
    passLabel: string,
  ): Promise<VerificationResult> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    const callStart = Date.now();
    try {
      let response;
      try {
        response = await client.messages.create(
          {
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          },
          { signal: abortController.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.usage) {
        this.store.recordLlmCallEvent({
          call_type: "task_verify",
          model: response.model,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
          cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
          duration_ms: Date.now() - callStart,
          task_id: taskId,
        });
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text : ""))
        .join("");

      return this.parseResponse(text);
    } catch (err) {
      this.log.error("LLM pass failed", {
        taskId,
        pass: passLabel,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(
        `Verification ${passLabel} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private parseResponse(text: string): VerificationResult {
    const cleaned = text
      .replace(/```(?:json)?\s*/g, "")
      .replace(/```/g, "")
      .trim();
    try {
      const parsed = JSON.parse(cleaned);
      const score = Math.min(Math.max(Number(parsed.score) || 0, 0), 1);
      // Only surface explanation when score is genuinely sub-0.80
      const explanation =
        score < 0.80 && parsed.explanation ? String(parsed.explanation) : undefined;

      // Parse dimensions if provided
      let dimensions: QualityDimensions | undefined;
      if (
        parsed.dimensions &&
        typeof parsed.dimensions === "object" &&
        !Array.isArray(parsed.dimensions)
      ) {
        dimensions = {
          correctness: Math.min(
            Math.max(Number(parsed.dimensions.correctness) || 0, 0),
            1,
          ),
          completeness: Math.min(
            Math.max(Number(parsed.dimensions.completeness) || 0, 0),
            1,
          ),
          test_coverage: Math.min(
            Math.max(Number(parsed.dimensions.test_coverage) || 0, 0),
            1,
          ),
          code_quality: Math.min(
            Math.max(Number(parsed.dimensions.code_quality) || 0, 0),
            1,
          ),
        };
      }

      return {
        approved: Boolean(parsed.approved),
        score,
        notes: String(parsed.notes ?? ""),
        revision: parsed.revision ? String(parsed.revision) : undefined,
        explanation,
        dimensions,
      };
    } catch {
      return {
        approved: false,
        score: 0,
        notes: "Failed to parse verification response",
      };
    }
  }
}
