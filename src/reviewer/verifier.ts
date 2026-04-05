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
 */

import { createLLMClient } from "../client/llm-client.js";
import { createLogger } from "../service/logger.js";
import type { IStateStore } from "../state/types.js";

export interface VerificationResult {
  approved: boolean;
  score: number;
  notes: string;
  revision?: string;
}

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

export class Verifier {
  private log = createLogger("verifier");

  constructor(private store: IStateStore) {}

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
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create(
          {
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            system: isResearch ? RESEARCH_SYSTEM_PROMPT : SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
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

      const result = this.parseResponse(text);

      this.log.info("Verification complete", {
        taskId,
        approved: result.approved,
        score: result.score,
        agent: task.agent_name,
      });

      this.store.updateTask(taskId, {
        verification_status: result.approved ? "approved" : "rejected",
        quality_score: result.score,
        verification_notes: result.notes,
      });

      return result;
    } catch (err) {
      this.log.error("Verification failed", {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.store.updateTask(taskId, { verification_status: null });
      throw new Error(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
