/**
 * Improvement detector — analyzes recent task results and suggests product improvements.
 *
 * Migrated from rapartlu/claude-agent-orchestrator:src/orchestrator/improvement-detector.ts
 * Adaptations:
 *   - Uses createLLMClient() from ../client/llm-client (no proxy routing)
 *   - Config replaced with ReviewerConfig (agents map only needed for name validation)
 */

import { createHash } from "node:crypto";
import { createLLMClient } from "../client/llm-client.js";
import { createLogger } from "../service/logger.js";
import type { ReviewerConfig } from "../config.js";
import type { IStateStore, Task, IImprovementBatchDeduplicationStore, IPatternRiskStore } from "../state/types.js";
import { PatternRiskConsumer } from "./pattern-risk-consumer.js";

export interface DetectedImprovement {
  title: string;
  description: string;
  affected_agents: string[];
  severity: "low" | "medium" | "high";
  evidence: Array<{ taskId: string; detail: string }>;
  /** Indicates whether this improvement was surfaced from a research report. */
  source?: "task-pattern" | "research-finding";
}

const SYSTEM_PROMPT = `You are a product improvement analyst for a multi-agent system. Each agent is a product with users. Analyze recent task results and suggest improvements that make agents more useful, not just more technically polished.

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
- claude-orchestrator-reviewer: The quality and oversight layer — should suggest improvements to review accuracy, escalation logic, or verification coverage

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

/**
 * System prompt for extracting implementation proposals from completed research reports.
 *
 * Research reports follow a structured markdown format with Recommendation and Next Steps
 * sections. This prompt instructs the LLM to faithfully extract those proposals (not invent
 * new ones) and convert them into trackable GitHub issues.
 */
const RESEARCH_FINDINGS_SYSTEM_PROMPT = `You are a product analyst extracting actionable implementation proposals from completed research reports.

Research reports follow a standard structure: Summary, Options Evaluated, Findings, Recommendation, and Next Steps. Your job is to extract the concrete implementation proposals from the Recommendation and Next Steps sections and represent them as GitHub issue candidates.

RULES:
1. Only extract proposals that are explicitly stated in the Recommendation or Next Steps sections — do NOT add your own ideas.
2. Each proposal must be concrete and implementable, not a vague directive like "improve X".
3. Prefer user-facing features and capabilities over internal tooling, test infrastructure, or refactoring.
4. Infer which agent should implement each proposal from context clues in the report (repo names, system descriptions, agent mentions).
5. One proposal per distinct recommendation. Do not split a single recommendation into multiple items.

Each agent has a specific product identity:
- claude-agent-orchestrator: The orchestrator control plane — autonomous oversight, routing, PR review quality, supervisor intelligence
- claude-proxy: Developer tool for running Claude Code — UX improvements, dashboards, developer productivity
- claude-orchestrator-reviewer: The quality and oversight layer — review accuracy, escalation logic, verification coverage

Respond with ONLY a JSON array (no markdown, no code fences):
[
  {
    "title": "Short, specific implementation title",
    "description": "What to implement (drawn directly from the research), why it matters, and specific acceptance criteria from the report",
    "affected_agents": ["agent-name"],
    "severity": "low|medium|high"
  }
]

If no actionable proposals are found, return an empty array: []`;

/**
 * Compute a deterministic SHA-256 hex digest for a task batch.
 *
 * Sorts tasks by ID before hashing so the result is order-independent.
 * Each task contributes a `<id>:<status>` segment so that the same IDs
 * with different statuses produce a different hash.
 *
 * Exported so tests can verify the hashing logic independently.
 */
export function computeBatchHash(tasks: Task[]): string {
  const entries = tasks
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => `${t.id}:${t.status}`)
    .join(",");
  return createHash("sha256").update(entries).digest("hex");
}

export class ImprovementDetector {
  private log = createLogger("improvement-detector");

  constructor(
    private config: ReviewerConfig,
    private store?: (IStateStore & IImprovementBatchDeduplicationStore & IPatternRiskStore) | (IStateStore & IImprovementBatchDeduplicationStore) | IStateStore,
  ) {}

  async analyze(recentTasks: Task[]): Promise<DetectedImprovement[]> {
    // Filter out research tasks — they don't produce code artifacts; use
    // analyzeResearchFindings() to process research results separately.
    const implTasks = recentTasks.filter((t) => t.task_type !== "research");
    if (implTasks.length === 0) return [];

    // Batch deduplication guard (issue #458): skip identical task-batches
    // that were already analysed within the last 6 hours to prevent redundant
    // LLM calls and duplicate improvement issues across daemon cycles.
    const dedupStore = this.asDedupStore();
    if (dedupStore) {
      const batchHash = computeBatchHash(implTasks);
      if (dedupStore.hasRecentImprovementAnalysisRun(batchHash)) {
        this.log.warn("Skipping improvement analysis — duplicate batch within 6h window", {
          batch_hash: batchHash.slice(0, 16),
          task_count: implTasks.length,
        });
        dedupStore.recordImprovementAnalysisRun(batchHash, implTasks.length, true);
        return [];
      }
      // Record the (non-skipped) run before calling the LLM so that a crash
      // mid-analysis still counts as "seen" and prevents a retry loop.
      dedupStore.recordImprovementAnalysisRun(batchHash, implTasks.length, false);
    }

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

    // Enrich the prompt with pattern_risk signals when the store supports it
    // (issue #1149).  These are written by the daemon on verification failure
    // and were previously orphaned — consuming them here gives the LLM
    // concrete evidence of systemic quality gaps beyond what the task summaries
    // alone convey.
    const riskCtx = this.asPatternRiskStore()
      ? new PatternRiskConsumer(this.asPatternRiskStore()!).buildRiskContext()
      : "";

    const prompt =
      `Analyze these ${implTasks.length} recent tasks and identify cross-cutting improvements:\n\n` +
      JSON.stringify(taskSummaries, null, 2) +
      riskCtx;

    const LLM_TIMEOUT_MS = 5 * 60 * 1000;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
    const callStart = Date.now();
    try {
      const client = createLLMClient();
      let response;
      try {
        response = await client.messages.create(
          {
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
          },
          { signal: abortController.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      if (this.store && response.usage) {
        this.store.recordLlmCallEvent({
          call_type: "improvement",
          model: response.model,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
          cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
          duration_ms: Date.now() - callStart,
        });
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text : ""))
        .join("");

      return this.parseResponse(text, implTasks);
    } catch (err) {
      this.log.error("Improvement detection failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Analyze completed research tasks and extract concrete implementation proposals
   * from their findings. Proposals are returned as `DetectedImprovement` objects with
   * `source: "research-finding"` so issue bodies can be attributed correctly.
   *
   * Unlike `analyze()`, this method includes the full result text (up to 2 000 chars)
   * so the LLM can read the Recommendation and Next Steps sections of each report.
   */
  async analyzeResearchFindings(recentTasks: Task[]): Promise<DetectedImprovement[]> {
    const researchTasks = recentTasks.filter(
      (t) => t.task_type === "research" && t.status === "done" && t.result,
    );
    if (researchTasks.length === 0) return [];

    // Batch deduplication guard (issue #458): same protection as analyze().
    const dedupStore = this.asDedupStore();
    if (dedupStore) {
      const batchHash = computeBatchHash(researchTasks);
      if (dedupStore.hasRecentImprovementAnalysisRun(batchHash)) {
        this.log.warn("Skipping research-findings analysis — duplicate batch within 6h window", {
          batch_hash: batchHash.slice(0, 16),
          task_count: researchTasks.length,
        });
        dedupStore.recordImprovementAnalysisRun(batchHash, researchTasks.length, true);
        return [];
      }
      dedupStore.recordImprovementAnalysisRun(batchHash, researchTasks.length, false);
    }

    const taskSummaries = researchTasks.map((t) => ({
      id: t.id.slice(0, 8),
      agent: t.agent_name,
      title: t.title,
      // Include substantially more result content for research tasks so the LLM
      // can read the Recommendation and Next Steps sections of the markdown report.
      result: t.result?.slice(0, 2000),
    }));

    const prompt = `Extract actionable implementation proposals from these ${researchTasks.length} completed research reports:\n\n${JSON.stringify(taskSummaries, null, 2)}`;

    const LLM_TIMEOUT_MS = 5 * 60 * 1000;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
    const callStart = Date.now();
    try {
      const client = createLLMClient();
      let response;
      try {
        response = await client.messages.create(
          {
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            system: RESEARCH_FINDINGS_SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
          },
          { signal: abortController.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      if (this.store && response.usage) {
        this.store.recordLlmCallEvent({
          call_type: "improvement",
          model: response.model,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
          cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
          duration_ms: Date.now() - callStart,
        });
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text : ""))
        .join("");

      return this.parseResponse(text, researchTasks, "research-finding");
    } catch (err) {
      this.log.error("Research findings analysis failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Type-narrow `this.store` to `IImprovementBatchDeduplicationStore` if the
   * store implements the required methods.  Returns `null` when the store is
   * absent or does not support deduplication (e.g. in minimal test stubs).
   */
  private asDedupStore(): IImprovementBatchDeduplicationStore | null {
    if (
      this.store &&
      typeof (this.store as IImprovementBatchDeduplicationStore).hasRecentImprovementAnalysisRun ===
        "function"
    ) {
      return this.store as IImprovementBatchDeduplicationStore;
    }
    return null;
  }

  /**
   * Cast the store to `IPatternRiskStore` when it exposes the pattern-risk
   * read methods.  Returns null when the store is absent or does not support
   * pattern-risk reads (e.g. in minimal test stubs).
   */
  private asPatternRiskStore(): IPatternRiskStore | null {
    if (
      this.store &&
      typeof (this.store as IPatternRiskStore).getAgentPatternRiskSummaries === "function"
    ) {
      return this.store as IPatternRiskStore;
    }
    return null;
  }

  private parseResponse(
    text: string,
    tasks: Task[],
    source: DetectedImprovement["source"] = "task-pattern",
  ): DetectedImprovement[] {
    const cleaned = text
      .replace(/```(?:json)?\s*/g, "")
      .replace(/```/g, "")
      .trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      const agentNames = new Set(Object.keys(this.config.agents));

      return parsed
        .filter(
          (item: Record<string, unknown>) =>
            item.title && item.description && Array.isArray(item.affected_agents),
        )
        .map((item: Record<string, unknown>) => ({
          title: String(item.title),
          description: String(item.description),
          affected_agents: (item.affected_agents as string[]).filter((a) => agentNames.has(a)),
          severity: (
            ["low", "medium", "high"].includes(String(item.severity))
              ? String(item.severity)
              : "medium"
          ) as "low" | "medium" | "high",
          evidence: tasks
            .filter((t) => (item.affected_agents as string[]).includes(t.agent_name ?? ""))
            .slice(0, 3)
            .map((t) => ({ taskId: t.id, detail: t.title })),
          source,
        }))
        .filter((imp) => imp.affected_agents.length > 0);
    } catch {
      return [];
    }
  }
}
