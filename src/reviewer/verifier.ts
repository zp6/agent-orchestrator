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
import type { IStateStore } from "../state/types.js";
import type { Notifier } from "../notify.js";

export interface VerificationResult {
  approved: boolean;
  score: number;
  notes: string;
  revision?: string;
  /**
   * Present when a borderline score (0.70–0.79) triggered an automatic
   * second-pass review. The orchestrator can use this to detect disagreements.
   */
  secondPass?: {
    score: number;
    notes: string;
    /** True when both passes agreed on the approval decision. */
    agreed: boolean;
  };
}

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
  "revision": "If not approved, specific guidance for improvement (omit if approved)"
}

Scoring guide:
- 0.9-1.0: Excellent — thorough, correct, well-structured
- 0.7-0.89: Good — meets requirements with minor gaps
- 0.5-0.69: Acceptable — partially addresses the task
- Below 0.5: Needs revision — incomplete or incorrect`;

const RESEARCH_SYSTEM_PROMPT = `You are a quality reviewer for research and feasibility analysis produced by an AI agent. Given a research question and the agent's analysis, assess the quality of the research.

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
  "revision": "If not approved, concrete guidance for what needs to change (omit if approved)"
}

Scoring guide:
- 0.9-1.0: Excellent — thorough, correct, well-structured
- 0.7-0.89: Good — meets requirements with minor gaps
- 0.5-0.69: Acceptable — partially addresses the task
- Below 0.5: Needs revision — incomplete or incorrect`;

export class Verifier {
  private log = createLogger("verifier");

  constructor(
    private store: IStateStore,
    private notifier?: Notifier,
  ) {}

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

      const finalResult: VerificationResult = {
        approved: finalApproved,
        score: firstPassResult.score,
        notes: combinedNotes,
        revision: finalApproved ? undefined : (secondPassResult.revision ?? firstPassResult.revision),
        secondPass: {
          score: secondPassResult.score,
          notes: secondPassResult.notes,
          agreed,
        },
      };

      this.log.info("Second-pass review complete", {
        taskId,
        firstPassApproved: firstPassResult.approved,
        secondPassApproved: secondPassResult.approved,
        agreed,
        finalApproved,
        agent: task.agent_name,
      });

      this.store.updateTask(taskId, {
        verification_status: finalApproved ? "approved" : "rejected",
        quality_score: firstPassResult.score,
        verification_notes: combinedNotes,
      });

      return finalResult;
    }

    // ── Standard (non-borderline) result ────────────────────────────────────
    this.log.info("Verification complete", {
      taskId,
      approved: firstPassResult.approved,
      score: firstPassResult.score,
      agent: task.agent_name,
    });

    this.store.updateTask(taskId, {
      verification_status: firstPassResult.approved ? "approved" : "rejected",
      quality_score: firstPassResult.score,
      verification_notes: firstPassResult.notes,
    });

    return firstPassResult;
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
      return {
        approved: Boolean(parsed.approved),
        score: Math.min(Math.max(Number(parsed.score) || 0, 0), 1),
        notes: String(parsed.notes ?? ""),
        revision: parsed.revision ? String(parsed.revision) : undefined,
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
