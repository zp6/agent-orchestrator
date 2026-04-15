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
  /**
   * True when the task was approved but its score falls in the marginal range
   * (MARGINAL_APPROVAL_LOW–MARGINAL_APPROVAL_HIGH, i.e. 0.60–0.74).
   * Operators should spot-audit these tasks before technical debt accumulates —
   * a marginal approval is meaningfully weaker than a high-confidence approval.
   */
  marginalApproval?: boolean;
  /**
   * One-sentence summary of what prevented a higher score for a marginal approval.
   * Surfaces in the verification comment as a distinct badge so operators can
   * quickly understand the quality gap without reading the full notes.
   * Populated when marginalApproval is true; undefined otherwise.
   */
  marginalReason?: string;
  /**
   * Set to `'hard_block_sub50'` when the verifier's hard-block guard fires
   * (score < 0.50). This indicates the task was unconditionally rejected by the
   * quality gate, overriding any `approved: true` the LLM may have returned.
   *
   * Persisted to `verification_results.blocked_reason` so the dashboard rejection
   * log can surface hard-block rejections distinctly from ordinary sub-threshold
   * rejections.
   */
  blockedReason?: "hard_block_sub50";
  /**
   * Explains why a low-scoring task was approved, making the quality system
   * legible to operators. Undefined when the task was rejected or scored ≥ 0.75.
   *
   * Well-known prefixes:
   * - `'marginal_approval'`            — task scored 0.60–0.74 and was approved at the marginal bar
   * - `'second_pass_passed'`           — borderline (0.70–0.79) task cleared second-pass review
   * - `'research_task_schema_pass'`    — research task passed schema-compliance scoring
   * - `'triage_schema_compliance'`     — housekeeping task passed deterministic JSON schema check (score ≥ 0.80)
   *
   * Additional free-text detail (e.g. the LLM's marginal_reason) may be
   * appended after a colon: `"marginal_approval: Missing error handling …"`.
   */
  approvalRationale?: string;
  /**
   * Set to `true` when the priority quality gate fired: the task had
   * `issue_priority ≥ PRIORITY_FLOOR_THRESHOLD` (0.80) and a `quality_score`
   * below `PRIORITY_QUALITY_FLOOR` (0.60).
   *
   * When this flag is set the task `status` has been moved to `"escalated"` so
   * it will not be auto-merged or silently approved. A Telegram alert was sent
   * to the operator showing both the priority and the quality score.
   *
   * The orchestrator daemon should check this flag before routing the result —
   * if `priorityQualityEscalated` is true, skip auto-approval and wait for
   * human resolution via `/resolve` in the Telegram bot.
   */
  priorityQualityEscalated?: true;
}

/**
 * Required output schema for research tasks.
 *
 * All research agent outputs MUST include these five sections (in any order).
 * The verifier checks for schema compliance and penalises missing sections.
 * Downstream implementation tasks rely on this structure to extract findings
 * programmatically rather than parsing free-form prose.
 *
 * Exported so the orchestrator daemon can include it in research task dispatch
 * prompts and revision guidance.
 */
export const RESEARCH_OUTPUT_SCHEMA = `## Problem Statement
[What problem or question was investigated and why it matters]

## Key Findings
- [Finding 1 — concise, evidence-backed]
- [Finding 2 — concise, evidence-backed]
- [Additional findings as needed]

## Implementation Recommendations
[Concrete, actionable steps or architectural choices for the implementation team.
Include trade-offs and preferred approach.]

## Open Questions
- [Unresolved question, risk, or assumption that needs further investigation]

## References
- [Source: code file, library, documentation link, PR, issue, or prior art]`;

/**
 * Section headers required in every research task output.
 * Used by the verifier to check schema compliance.
 */
export const RESEARCH_REQUIRED_SECTIONS = [
  "## Problem Statement",
  "## Key Findings",
  "## Implementation Recommendations",
  "## Open Questions",
  "## References",
] as const;

/**
 * Required output schema for housekeeping/triage tasks.
 *
 * Every triage task result MUST include a JSON block with these four fields.
 * The verifier extracts and validates this block deterministically — no LLM
 * scoring can override a missing schema block. If any field is absent the
 * schema_compliance score falls below 0.80 and the task is sent for revision
 * with an explicit list of missing fields, eliminating ambiguous revision cycles.
 *
 * Exported so the orchestrator daemon can embed this template in housekeeping
 * dispatch prompts and revision guidance.
 */
export const TRIAGE_OUTPUT_SCHEMA = `\`\`\`json
{
  "duplicates_checked": true,
  "stale_issues": [
    { "number": <N>, "title": "<title>", "action": "closed|updated|kept", "reason": "<one line>" }
  ],
  "priority_reordering": [
    { "issue": <N>, "old_rank": <N>, "new_rank": <N>, "reason": "<one line>" }
  ],
  "outcome_summary": "<1-3 sentence summary of what was done>"
}
\`\`\``;

/**
 * Field names required in every triage task output's JSON schema block.
 * Used by checkTriageSchemaCompliance() and exported for dispatch prompt injection.
 */
export const TRIAGE_REQUIRED_FIELDS = [
  "duplicates_checked",
  "stale_issues",
  "priority_reordering",
  "outcome_summary",
] as const;

/**
 * Minimum schema_compliance score for a triage/housekeeping task to pass.
 * A task with schema_compliance below this threshold is rejected with a
 * specific missing-fields message regardless of LLM content quality score.
 */
const TRIAGE_SCHEMA_COMPLIANCE_THRESHOLD = 0.80;

/**
 * Per-field weights for triage schema compliance scoring.
 * Weights are equal (0.25 each, sum = 1.00) so that missing ANY single field
 * drops the score to 0.75 — below the TRIAGE_SCHEMA_COMPLIANCE_THRESHOLD of 0.80
 * — and a revision is dispatched. All four fields must be present to pass.
 * Changing these values requires updating tests and schema documentation in CLAUDE.md.
 */
const TRIAGE_FIELD_WEIGHTS: Record<string, number> = {
  duplicates_checked: 0.25,
  stale_issues: 0.25,
  priority_reordering: 0.25,
  outcome_summary: 0.25,
};

const TRIAGE_SYSTEM_PROMPT = `You are a quality reviewer for housekeeping and backlog triage tasks produced by an AI agent. Given a triage task description and the agent's output, assess the quality of the triage work.

## Required Output Schema

All triage/housekeeping task outputs MUST include a JSON block with these four fields:

\`\`\`json
{
  "duplicates_checked": true,
  "stale_issues": [
    { "number": <N>, "title": "<title>", "action": "closed|updated|kept", "reason": "<one line>" }
  ],
  "priority_reordering": [
    { "issue": <N>, "old_rank": <N>, "new_rank": <N>, "reason": "<one line>" }
  ],
  "outcome_summary": "<1-3 sentence summary of what was done>"
}
\`\`\`

**Schema compliance is mandatory.** The verifier runs a separate deterministic schema check — your score reflects content quality. Missing the schema block causes a hard revision regardless of your score.

Note: \`stale_issues\` and \`priority_reordering\` may be empty arrays (\`[]\`) if no changes were needed.

## Scoring

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Brief assessment of triage quality and completeness",
  "revision": "If not approved, specific guidance for what was missed (omit if approved)",
  "explanation": "REQUIRED when score < 0.80: 1-3 sentences explaining what drove the low score. Omit entirely when score >= 0.80.",
  "marginal_reason": "REQUIRED when approved is true AND score is between 0.60 and 0.74: one sentence explaining what prevented a higher score. Omit entirely otherwise.",
  "dimensions": {
    "correctness": 0.0-1.0,
    "completeness": 0.0-1.0,
    "test_coverage": 0.0-1.0,
    "code_quality": 0.0-1.0
  }
}

## Content Quality Criteria

Evaluate triage quality on:
- **Thoroughness**: Were all open issues reviewed? Were duplicates actively scanned?
- **Accuracy**: Are closed/updated issues correctly classified? Are reasons specific?
- **Prioritization**: Are roadmap/priority changes well-reasoned and outcome-focused?
- **Outcome clarity**: Is the outcome_summary actionable and complete?
- **Scope discipline**: Did the agent avoid doing out-of-scope work (feature implementation, etc.)?

Scoring guide:
- 0.9-1.0: Excellent — complete scan, well-reasoned changes, specific outcome summary
- 0.75-0.89: Good — covers most issues with minor gaps in reasoning or coverage
- 0.60-0.74: Marginal — triage performed but with shallow reasoning or coverage gaps; use marginal_reason
- 0.5-0.59: Acceptable — some triage performed but significant issues not covered
- Below 0.5: Needs revision — superficial or missing key parts of the triage

Dimension guide (for triage tasks):
- **correctness**: Were issues correctly classified? Are action/reason pairs accurate?
- **completeness**: Were all open issues reviewed? Was nothing skipped without reason?
- **test_coverage**: Was evidence gathered? Were duplicates verified against each other?
- **code_quality**: Schema compliance — is the required JSON block present and well-formed?`;

/**
 * Minimum score required to approve a task.
 * Also recorded as the `threshold` field in `verification_results`.
 */
const APPROVAL_THRESHOLD = 0.80;

/**
 * Hard-block threshold: any task scoring below this value is unconditionally
 * rejected, regardless of the LLM's `approved` field.
 *
 * Scores below 0.50 represent fundamentally incomplete or incorrect work where
 * the LLM has determined the task needs substantial revision. No amount of
 * borderline leniency or marginal approval should override this gate — a
 * `approved: true` with score 0.38 is a bug, not a valid outcome.
 *
 * When the guard fires, `blockedReason` is set to `'hard_block_sub50'` in the
 * VerificationResult and persisted to `verification_results.blocked_reason` so
 * operators can distinguish a hard-block rejection from a regular sub-threshold
 * rejection in the dashboard rejection log.
 */
const HARD_BLOCK_THRESHOLD = 0.50;

/**
 * Score range that triggers automatic second-pass review.
 * Tasks with a first-pass score in [BORDERLINE_LOW, BORDERLINE_HIGH] are
 * independently evaluated a second time before approval is finalised.
 */
const BORDERLINE_LOW = 0.70;
const BORDERLINE_HIGH = 0.79;

/**
 * Score range for marginal approvals.
 * Tasks approved with a score in [MARGINAL_APPROVAL_LOW, MARGINAL_APPROVAL_HIGH]
 * receive a distinct ⚠️ MARGINAL badge in the dashboard and a one-sentence
 * summary of what prevented a higher score, enabling operators to spot-audit
 * the weakest approved PRs before they accumulate technical debt.
 */
const MARGINAL_APPROVAL_LOW = 0.60;
const MARGINAL_APPROVAL_HIGH = 0.74;

/**
 * Minimum `issue_priority` score that activates the priority quality gate.
 * Tasks with an issue priority at or above this threshold are considered
 * critical-path work and subject to a stricter quality floor.
 */
export const PRIORITY_FLOOR_THRESHOLD = 0.80;

/**
 * Minimum `quality_score` required for high-priority tasks.
 * When a task's `issue_priority ≥ PRIORITY_FLOOR_THRESHOLD` and its
 * `quality_score` falls below this value, the verifier escalates the task
 * to a human operator via Telegram rather than allowing auto-approval.
 *
 * Rationale: a 0.15 quality score on a 0.90-priority issue (CI blocked on
 * main, for example) means the most important work in the system may be
 * unresolved, yet it would otherwise pass through silently.
 */
export const PRIORITY_QUALITY_FLOOR = 0.60;

const SYSTEM_PROMPT = `You are a quality reviewer for an AI agent orchestrator. Given a task description and the agent's response, assess the quality of the work.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Brief assessment of quality, completeness, correctness",
  "revision": "If not approved, specific guidance for improvement (omit if approved)",
  "explanation": "REQUIRED when score < 0.80: 1-3 sentences explaining what drove the low score — e.g. which acceptance criteria were unmet, what gaps were found, or why the work was hard to verify. Omit entirely when score >= 0.80.",
  "marginal_reason": "REQUIRED when approved is true AND score is between 0.60 and 0.74: one sentence explaining what prevented a higher score (e.g. 'Missing error handling in the retry path reduced confidence despite correct core logic.'). Omit entirely otherwise.",
  "dimensions": {
    "correctness": 0.0-1.0,
    "completeness": 0.0-1.0,
    "test_coverage": 0.0-1.0,
    "code_quality": 0.0-1.0
  }
}

Scoring guide:
- 0.9-1.0: Excellent — thorough, correct, well-structured
- 0.75-0.89: Good — meets requirements with minor gaps
- 0.60-0.74: Marginal — meets minimum bar but with meaningful quality gaps; use marginal_reason
- 0.5-0.59: Acceptable — partially addresses the task
- Below 0.5: Needs revision — incomplete or incorrect

Dimension guide:
- **correctness**: Does the code work correctly with no logic errors? Is it sound?
- **completeness**: Are all requirements and acceptance criteria addressed?
- **test_coverage**: Are edge cases covered? Is test coverage sufficient?
- **code_quality**: Is the code clear, maintainable, and well-documented?`;

const RESEARCH_SYSTEM_PROMPT = `You are a quality reviewer for research and feasibility analysis produced by an AI agent. Given a research question and the agent's analysis, assess the quality of the research.

## Required Output Schema

All research outputs MUST contain these five sections (exact markdown headers):

  ## Problem Statement
  ## Key Findings
  ## Implementation Recommendations
  ## Open Questions
  ## References

**Schema compliance is mandatory.** Deduct 0.15 from the score for each missing section (up to −0.60 for four missing sections). If ALL five sections are absent, cap the score at 0.30 regardless of content quality — the output is not machine-parseable and downstream implementation tasks cannot consume it.

When sections are missing, the revision guidance MUST include the full required schema template so the agent knows exactly what to produce.

## Scoring

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Brief assessment of research quality and schema compliance",
  "revision": "If not approved, specific guidance for improvement including the full schema template if sections are missing (omit if approved)",
  "explanation": "REQUIRED when score < 0.80: 1-3 sentences explaining what drove the low score — e.g. which sections were missing, which research dimensions were thin, what evidence was missing, or why the analysis was hard to act on. Omit entirely when score >= 0.80.",
  "marginal_reason": "REQUIRED when approved is true AND score is between 0.60 and 0.74: one sentence explaining what prevented a higher score (e.g. 'Analysis lacked comparative alternatives, limiting its actionability despite sound core findings.'). Omit entirely otherwise.",
  "dimensions": {
    "correctness": 0.0-1.0,
    "completeness": 0.0-1.0,
    "test_coverage": 0.0-1.0,
    "code_quality": 0.0-1.0
  }
}

## Content Quality Criteria

Evaluate research quality on:
- **Thoroughness**: Did the agent investigate the question fully, or leave obvious gaps?
- **Evidence**: Are claims backed by concrete examples, code references, or data?
- **Alternatives**: Were multiple approaches considered and compared?
- **Honesty**: Does the analysis acknowledge uncertainty, risks, and limitations?
- **Actionability**: Could a decision-maker use this analysis to make an informed choice?

Scoring guide (before schema compliance deductions):
- 0.9-1.0: Excellent — comprehensive analysis with evidence, alternatives, and clear recommendation
- 0.75-0.89: Good — solid analysis with minor gaps in coverage or evidence
- 0.60-0.74: Marginal — addresses the question but with meaningful depth or evidence gaps; use marginal_reason
- 0.5-0.59: Acceptable — addresses the question but lacks depth or alternatives
- Below 0.5: Needs revision — superficial, missing key considerations, or not actionable

Dimension guide (for research tasks, these map to content quality):
- **correctness**: Are the claims technically sound and factually accurate?
- **completeness**: Does the analysis address all relevant aspects of the question?
- **test_coverage**: Was evidence gathered comprehensively? Were findings validated or stress-tested?
- **code_quality**: Schema compliance — are all five required sections present and substantively filled?`;

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
  "marginal_reason": "REQUIRED when approved is true AND score is between 0.60 and 0.74: one sentence explaining what prevented a higher score (e.g. 'Missing error handling in the retry path reduced confidence despite correct core logic.'). Omit entirely otherwise.",
  "dimensions": {
    "correctness": 0.0-1.0,
    "completeness": 0.0-1.0,
    "test_coverage": 0.0-1.0,
    "code_quality": 0.0-1.0
  }
}

Scoring guide:
- 0.9-1.0: Excellent — thorough, correct, well-structured
- 0.75-0.89: Good — meets requirements with minor gaps
- 0.60-0.74: Marginal — meets minimum bar but with meaningful quality gaps; use marginal_reason
- 0.5-0.59: Acceptable — partially addresses the task
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
   *
   * @param dimensions - Per-dimension scores to render.
   * @param isResearch - When true, dimension labels are adapted for research tasks:
   *   - "Test Coverage" → "Evidence Coverage" (comprehensiveness of evidence gathered)
   *   - "Code Quality"  → "Schema Compliance" (all five required sections present)
   * @param isHousekeeping - When true, dimension labels are adapted for triage tasks:
   *   - "Test Coverage" → "Evidence Coverage" (duplicates verified against each other)
   *   - "Code Quality"  → "Schema Compliance" (JSON block present and well-formed)
   */
  private formatDimensionsBreakdown(
    dimensions: QualityDimensions,
    isResearch = false,
    isHousekeeping = false,
  ): string {
    const threshold = 0.8;
    const formatScore = (d: number) => `${(d * 100).toFixed(0)}/100`;
    const indicator = (d: number) => (d >= threshold ? "✓" : "✗");

    const taskMode = isHousekeeping ? "housekeeping" : isResearch ? "research" : "standard";

    const labels = {
      correctness:
        taskMode === "housekeeping"
          ? "issues correctly classified, action/reason accurate"
          : taskMode === "research"
            ? "claims technically sound"
            : "logic, no bugs",
      completeness:
        taskMode === "housekeeping"
          ? "all open issues reviewed, nothing skipped"
          : taskMode === "research"
            ? "all aspects of question addressed"
            : "requirements met",
      test_coverage:
        taskMode === "housekeeping"
          ? "duplicates verified, evidence gathered"
          : taskMode === "research"
            ? "findings validated, evidence comprehensive"
            : "edge cases covered",
      code_quality:
        taskMode === "housekeeping"
          ? "JSON schema block present and well-formed"
          : taskMode === "research"
            ? "all 5 required sections present and substantive"
            : "clarity, documentation",
    };

    const test_coverage_label =
      taskMode === "standard" ? "Test Coverage" : "Evidence Coverage";
    const code_quality_label =
      taskMode === "standard" ? "Code Quality" : "Schema Compliance";

    return [
      "## Quality Dimensions Breakdown",
      `- **Correctness**: ${formatScore(dimensions.correctness)} ${indicator(dimensions.correctness)} (${labels.correctness})`,
      `- **Completeness**: ${formatScore(dimensions.completeness)} ${indicator(dimensions.completeness)} (${labels.completeness})`,
      `- **${test_coverage_label}**: ${formatScore(dimensions.test_coverage)} ${indicator(dimensions.test_coverage)} (${labels.test_coverage})`,
      `- **${code_quality_label}**: ${formatScore(dimensions.code_quality)} ${indicator(dimensions.code_quality)} (${labels.code_quality})`,
    ].join("\n");
  }

  /**
   * Deterministically check whether a triage task result contains the required
   * JSON schema block with all four mandatory fields.
   *
   * This method is public so the orchestrator and tests can run schema checks
   * independently, e.g. to gate revision dispatch or validate dispatch templates.
   *
   * This check is independent of the LLM quality score — a task that fails schema
   * compliance is sent for revision with an explicit list of missing fields,
   * regardless of how highly the LLM rates the prose content.
   *
   * @param result - The raw task result string to check.
   * @returns An object containing:
   *   - `score` — composite compliance score (0–1); must be ≥ 0.80 to pass
   *   - `missingFields` — fields that are absent or structurally invalid
   *   - `passes` — true when score ≥ TRIAGE_SCHEMA_COMPLIANCE_THRESHOLD
   */
  checkTriageSchemaCompliance(result: string): {
    score: number;
    missingFields: string[];
    passes: boolean;
  } {
    const missingFields: string[] = [];
    let score = 0;

    // Extract the first JSON object from the result string.
    // We look for a ```json ... ``` block first, then fall back to a bare { ... }.
    let parsed: Record<string, unknown> | null = null;

    const jsonBlockMatch = result.match(/```json\s*([\s\S]*?)```/);
    const candidateJson = jsonBlockMatch ? jsonBlockMatch[1] : null;

    if (candidateJson) {
      try {
        const raw = JSON.parse(candidateJson);
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          parsed = raw as Record<string, unknown>;
        }
      } catch {
        // JSON parse failed — all fields missing
      }
    }

    if (!parsed) {
      // No valid JSON block found — all fields are missing
      return {
        score: 0,
        missingFields: [...TRIAGE_REQUIRED_FIELDS],
        passes: false,
      };
    }

    // Check duplicates_checked: must be boolean true
    if (parsed["duplicates_checked"] === true) {
      score += TRIAGE_FIELD_WEIGHTS["duplicates_checked"]!;
    } else {
      missingFields.push("duplicates_checked");
    }

    // Check stale_issues: must be an array (empty OK)
    if (Array.isArray(parsed["stale_issues"])) {
      const entries = parsed["stale_issues"] as unknown[];
      const allValid = entries.every(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          "number" in e &&
          "title" in e &&
          "action" in e &&
          "reason" in e,
      );
      if (entries.length === 0 || allValid) {
        score += TRIAGE_FIELD_WEIGHTS["stale_issues"]!;
      } else {
        missingFields.push("stale_issues[*].{number,title,action,reason}");
      }
    } else {
      missingFields.push("stale_issues");
    }

    // Check priority_reordering: must be an array (empty OK)
    if (Array.isArray(parsed["priority_reordering"])) {
      score += TRIAGE_FIELD_WEIGHTS["priority_reordering"]!;
    } else {
      missingFields.push("priority_reordering");
    }

    // Check outcome_summary: must be a non-empty string
    if (typeof parsed["outcome_summary"] === "string" && parsed["outcome_summary"].trim().length > 0) {
      score += TRIAGE_FIELD_WEIGHTS["outcome_summary"]!;
    } else {
      missingFields.push("outcome_summary");
    }

    return {
      score,
      missingFields,
      passes: score >= TRIAGE_SCHEMA_COMPLIANCE_THRESHOLD,
    };
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
    blockedReason?: "hard_block_sub50",
    approvalRationale?: string,
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
        blocked_reason: blockedReason ?? null,
        approval_rationale: approvalRationale ?? null,
        threshold: APPROVAL_THRESHOLD,
        agent_id: agentId,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // Never let instrumentation interrupt the main flow.
      this.log.warn("Failed to record verification result", { taskId, err });
    }
  }

  /**
   * Enforce the sub-0.50 hard-block after a verification decision has been
   * parsed. This protects the write path even if a future caller bypasses the
   * parser's own guard.
   */
  private applyHardBlockGuard(result: VerificationResult): VerificationResult {
    if (result.score >= HARD_BLOCK_THRESHOLD) return result;

    const {
      marginalApproval: _marginalApproval,
      marginalReason: _marginalReason,
      approvalRationale: _approvalRationale,
      blockedReason: _blockedReason,
      approved: _approved,
      ...rest
    } = result;

    return {
      ...rest,
      approved: false,
      blockedReason: "hard_block_sub50",
    };
  }

  /**
   * Apply the priority quality gate after a verification decision has been made.
   *
   * Fires when **both** conditions hold:
   *   1. `task.issue_priority ≥ PRIORITY_FLOOR_THRESHOLD` (0.80) — the issue is
   *      considered critical-path work.
   *   2. `score < PRIORITY_QUALITY_FLOOR` (0.60) — the quality is too low to
   *      auto-approve work this important.
   *
   * When the gate fires:
   *   - The task `status` is moved to `"escalated"` in the state store so the
   *     orchestrator daemon does not route it as a normal done/rejected task.
   *   - A Telegram operator alert (urgency=high) is sent showing the task ID,
   *     priority score, quality score, and agent name.
   *   - The result gains `priorityQualityEscalated: true` so callers can detect
   *     that the task has been routed to a human.
   *
   * Returns the (possibly mutated) result. When the gate does NOT fire the
   * result is returned unchanged.
   */
  private async applyPriorityQualityGate(
    taskId: string,
    agentName: string | null | undefined,
    issuePriority: number | null | undefined,
    result: VerificationResult,
  ): Promise<VerificationResult> {
    if (
      issuePriority == null ||
      issuePriority < PRIORITY_FLOOR_THRESHOLD ||
      result.score >= PRIORITY_QUALITY_FLOOR
    ) {
      return result;
    }

    this.log.warn("Priority quality gate fired — escalating task to human", {
      taskId,
      issuePriority,
      qualityScore: result.score,
      agent: agentName ?? "unknown",
    });

    // Move task status to escalated so the daemon does not auto-approve/retry.
    this.store.updateTask(taskId, { status: "escalated" });

    // Alert the operator via Telegram.
    if (this.notifier) {
      const priorityPct = (issuePriority * 100).toFixed(0);
      const qualityPct = (result.score * 100).toFixed(0);
      const body = [
        `Task \`${taskId.slice(0, 12)}\` was the system's highest-priority work yet returned a critically low quality score.`,
        ``,
        `*Task:* \`${taskId}\``,
        `*Agent:* \`${agentName ?? "unknown"}\``,
        `*Issue priority:* ${priorityPct}% (threshold: ${(PRIORITY_FLOOR_THRESHOLD * 100).toFixed(0)}%)`,
        `*Quality score:* ${qualityPct}% (floor: ${(PRIORITY_QUALITY_FLOOR * 100).toFixed(0)}%)`,
        ``,
        `Task status moved to \`escalated\`. Use \`/resolve ${taskId.slice(0, 8)}\` to de-escalate after manual review.`,
      ].join("\n");

      await this.notifier.notifyOperator(
        "Priority quality gate: high-priority task below quality floor",
        body,
        "high",
      );
    }

    return { ...result, priorityQualityEscalated: true };
  }

  async verify(taskId: string): Promise<VerificationResult> {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== "done") {
      throw new Error(`Task ${taskId} is not done (status: ${task.status})`);
    }

    // ── Repair null quality_score for pre-approved tasks ──────────────────
    // If a task is marked approved but has no quality_score (due to race condition
    // or external approval), infer a score before proceeding.
    if (
      task.verification_status === "approved" &&
      task.quality_score === null
    ) {
      this.log.warn("Detected approved task with null quality_score, inferring score", {
        taskId,
        title: task.title,
        agentName: task.agent_name,
      });

      const inferredResult = await this.inferMissingScore(task);
      this.store.updateTask(taskId, {
        quality_score: inferredResult.score,
        verification_notes: inferredResult.notes,
        quality_explanation: inferredResult.approvalRationale ?? null,
      });

      this.recordVerificationResult(
        taskId,
        task.agent_name ?? "unknown",
        inferredResult.score,
        true,
        undefined,
        undefined,
        inferredResult.approvalRationale,
      );

      return inferredResult;
    }

    this.store.updateTask(taskId, { verification_status: "pending" });

    const client = createLLMClient();

    const isResearch = task.task_type === "research";
    const isHousekeeping =
      task.task_type === "housekeeping" || task.title.includes("[housekeeping]");
    const prompt = isResearch
      ? `## Research Question\n${task.description ?? task.title}\n\n## Agent Analysis (${task.agent_name})\n${task.result ?? "(no result)"}`
      : isHousekeeping
        ? `## Triage Task\n${task.description ?? task.title}\n\n## Agent Output (${task.agent_name})\n${task.result ?? "(no result)"}`
        : `## Task\n${task.description ?? task.title}\n\n## Agent Response (${task.agent_name})\n${task.result ?? "(no result)"}`;

    // ── Triage schema compliance pre-check ──────────────────────────────────
    // For housekeeping tasks, run a deterministic JSON schema check BEFORE the
    // LLM pass. A compliance score < 0.80 immediately triggers revision with a
    // specific missing-fields message — no LLM scoring can override this gate.
    if (isHousekeeping) {
      const schemaResult = this.checkTriageSchemaCompliance(task.result ?? "");
      if (!schemaResult.passes) {
        const missingList = schemaResult.missingFields
          .map((f) => `  - \`${f}\``)
          .join("\n");
        const revision = [
          `Triage schema compliance check failed (score ${(schemaResult.score * 100).toFixed(0)}% — required ≥ 80%).`,
          ``,
          `Missing or invalid fields:`,
          missingList,
          ``,
          `Include the following JSON block verbatim in your PR body or triage comment:`,
          ``,
          TRIAGE_OUTPUT_SCHEMA,
          ``,
          `Fields may be empty arrays (\`[]\`) if no changes were made, but all four fields must be present.`,
        ].join("\n");

        const failResult: VerificationResult = {
          approved: false,
          score: schemaResult.score,
          notes: `Triage schema compliance failed — ${schemaResult.missingFields.length} field(s) missing: ${schemaResult.missingFields.join(", ")}`,
          revision,
          explanation: `The required JSON schema block was ${schemaResult.score === 0 ? "entirely absent" : "present but incomplete"}. Missing fields: ${schemaResult.missingFields.join(", ")}.`,
        };

        this.store.updateTask(taskId, {
          verification_status: "rejected",
          quality_score: schemaResult.score,
          verification_notes: failResult.notes,
          quality_explanation: failResult.explanation ?? null,
        });

        this.recordVerificationResult(
          taskId,
          task.agent_name ?? "unknown",
          schemaResult.score,
          false,
          failResult.explanation,
          undefined,
          undefined,
        );

        return failResult;
      }
    }

    const LLM_TIMEOUT_MS = 5 * 60 * 1000;

    // ── First pass ──────────────────────────────────────────────────────────
    const systemPrompt = isHousekeeping
      ? TRIAGE_SYSTEM_PROMPT
      : isResearch
        ? RESEARCH_SYSTEM_PROMPT
        : SYSTEM_PROMPT;

    const firstPassResult = await this.runLLMPass(
      client,
      systemPrompt,
      prompt,
      LLM_TIMEOUT_MS,
      taskId,
      "first-pass",
    );
    const enforcedFirstPassResult = this.applyHardBlockGuard(firstPassResult);

    // ── Borderline second-pass guard ────────────────────────────────────────
    const isBorderline =
      enforcedFirstPassResult.score >= BORDERLINE_LOW &&
      enforcedFirstPassResult.score <= BORDERLINE_HIGH;

    if (isBorderline) {
      this.log.info("Borderline score — triggering second-pass review", {
        taskId,
        firstPassScore: enforcedFirstPassResult.score,
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
      const enforcedSecondPassResult = this.applyHardBlockGuard(secondPassResult);

      const agreed = enforcedFirstPassResult.approved === enforcedSecondPassResult.approved;

      // Conservative final decision: if either pass rejects, reject overall.
      const finalApproved = enforcedFirstPassResult.approved && enforcedSecondPassResult.approved;

      const combinedNotes = [
        `[First pass — score ${(enforcedFirstPassResult.score * 100).toFixed(0)}%] ${enforcedFirstPassResult.notes}`,
        `[Second pass — score ${(enforcedSecondPassResult.score * 100).toFixed(0)}%] ${enforcedSecondPassResult.notes}`,
        agreed
          ? `[Agreement: both passes ${finalApproved ? "approved" : "rejected"}]`
          : `[Disagreement: passes diverged — conservative decision: ${finalApproved ? "approved" : "rejected"}]`,
      ].join("\n");

      // Escalate to Telegram when passes disagree.
      if (!agreed && this.notifier) {
        const body = [
          `Task \`${taskId.slice(0, 12)}\` scored *${(enforcedFirstPassResult.score * 100).toFixed(0)}%* on first pass — borderline range triggered second review.`,
          ``,
          `*First pass:* ${enforcedFirstPassResult.approved ? "✅ approved" : "❌ rejected"} (${(enforcedFirstPassResult.score * 100).toFixed(0)}%)`,
          `*Second pass:* ${enforcedSecondPassResult.approved ? "✅ approved" : "❌ rejected"} (${(enforcedSecondPassResult.score * 100).toFixed(0)}%)`,
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
        enforcedSecondPassResult.explanation ?? enforcedFirstPassResult.explanation;

      // When not approved, enrich the revision guidance with the explanation so
      // agents know what specifically drove the low score.
      const baseRevision = enforcedSecondPassResult.revision ?? enforcedFirstPassResult.revision;
      const usedDimensions = enforcedSecondPassResult.dimensions ?? enforcedFirstPassResult.dimensions;
      const dimensionsBreakdown =
        !finalApproved && usedDimensions
          ? `\n\n${this.formatDimensionsBreakdown(usedDimensions, isResearch, isHousekeeping)}`
          : "";
      const enrichedRevision =
        !finalApproved && baseRevision && finalExplanation
          ? `${finalExplanation}${dimensionsBreakdown}\n\n${baseRevision}`
          : baseRevision;

      // Marginal approval detection for second-pass results.
      // Use second-pass marginal_reason if available; otherwise fall back to first pass.
      const finalMarginalApproval =
        finalApproved &&
        enforcedFirstPassResult.score >= MARGINAL_APPROVAL_LOW &&
        enforcedFirstPassResult.score <= MARGINAL_APPROVAL_HIGH;
      const finalMarginalReason =
        finalMarginalApproval
          ? (enforcedSecondPassResult.marginalReason ?? enforcedFirstPassResult.marginalReason)
          : undefined;

      // Prefix combined notes with marginal badge when applicable.
      const marginalBadge =
        finalMarginalApproval
          ? `⚠️ MARGINAL APPROVAL — score ${(enforcedFirstPassResult.score * 100).toFixed(0)}%` +
            (finalMarginalReason ? ` — ${finalMarginalReason}` : "") +
            "\n\n"
          : "";
      const enrichedNotes = `${marginalBadge}${combinedNotes}`;

      // Derive approval_rationale for auditable low-score approvals.
      // For borderline tasks that cleared the second pass, use 'second_pass_passed'
      // as the base code; upgrade to 'marginal_approval' when the score also falls
      // in the marginal range and both codes apply.
      const secondPassApprovalRationale = finalApproved
        ? finalMarginalApproval
          ? `marginal_approval${finalMarginalReason ? `: ${finalMarginalReason}` : ""}`
          : "second_pass_passed"
        : undefined;

      const finalResult: VerificationResult = {
        approved: finalApproved,
        score: enforcedFirstPassResult.score,
        notes: enrichedNotes,
        revision: finalApproved ? undefined : enrichedRevision,
        explanation: finalExplanation,
        dimensions: usedDimensions,
        secondPass: {
          score: enforcedSecondPassResult.score,
          notes: enforcedSecondPassResult.notes,
          agreed,
          dimensions: enforcedSecondPassResult.dimensions,
        },
        ...(finalMarginalApproval && { marginalApproval: true }),
        ...(finalMarginalReason && { marginalReason: finalMarginalReason }),
        ...(secondPassApprovalRationale && { approvalRationale: secondPassApprovalRationale }),
      };

      this.log.info("Second-pass review complete", {
        taskId,
        firstPassApproved: enforcedFirstPassResult.approved,
        secondPassApproved: enforcedSecondPassResult.approved,
        agreed,
        finalApproved,
        agent: task.agent_name,
        ...(finalExplanation && { explanation: finalExplanation }),
        ...(finalMarginalApproval && { marginalApproval: true, marginalReason: finalMarginalReason }),
        ...(secondPassApprovalRationale && { approvalRationale: secondPassApprovalRationale }),
      });

      this.store.updateTask(taskId, {
        verification_status: finalApproved ? "approved" : "rejected",
        quality_score: enforcedFirstPassResult.score,
        verification_notes: enrichedNotes,
        quality_explanation: finalExplanation ?? null,
      });

      this.recordVerificationResult(
        taskId,
        task.agent_name ?? "unknown",
        enforcedFirstPassResult.score,
        finalApproved,
        finalApproved ? undefined : (finalExplanation ?? finalResult.revision),
        finalResult.blockedReason,
        secondPassApprovalRationale,
      );

      // ── Priority quality gate (borderline path) ──────────────────────────
      return this.applyPriorityQualityGate(
        taskId,
        task.agent_name,
        task.issue_priority,
        finalResult,
      );
    }

    // ── Standard (non-borderline) result ────────────────────────────────────
    this.log.info("Verification complete", {
      taskId,
      approved: enforcedFirstPassResult.approved,
      score: enforcedFirstPassResult.score,
      agent: task.agent_name,
      ...(enforcedFirstPassResult.explanation && { explanation: enforcedFirstPassResult.explanation }),
      ...(enforcedFirstPassResult.marginalApproval && {
        marginalApproval: true,
        marginalReason: enforcedFirstPassResult.marginalReason,
      }),
      ...(enforcedFirstPassResult.blockedReason && { blockedReason: enforcedFirstPassResult.blockedReason }),
    });

    // Enrich revision with explanation and dimension breakdown so agents understand the low score.
    const dimensionsBreakdown =
      !enforcedFirstPassResult.approved && enforcedFirstPassResult.dimensions
        ? `\n\n${this.formatDimensionsBreakdown(enforcedFirstPassResult.dimensions, isResearch, isHousekeeping)}`
        : "";
    const enrichedRevision =
      !enforcedFirstPassResult.approved &&
      enforcedFirstPassResult.revision &&
      enforcedFirstPassResult.explanation
        ? `${enforcedFirstPassResult.explanation}${dimensionsBreakdown}\n\n${enforcedFirstPassResult.revision}`
        : enforcedFirstPassResult.revision;

    // Prefix notes with marginal badge so the dashboard task list can surface it.
    const marginalBadge =
      enforcedFirstPassResult.blockedReason
        ? `🚧 HARD BLOCK — score ${(enforcedFirstPassResult.score * 100).toFixed(0)}% below 50% threshold\n\n`
        : enforcedFirstPassResult.marginalApproval
          ? `⚠️ MARGINAL APPROVAL — score ${(enforcedFirstPassResult.score * 100).toFixed(0)}%` +
            (enforcedFirstPassResult.marginalReason ? ` — ${enforcedFirstPassResult.marginalReason}` : "") +
          "\n\n"
          : "";
    const enrichedNotes = `${marginalBadge}${enforcedFirstPassResult.notes}`;

    // Derive approval_rationale for auditable low-score approvals.
    const singlePassApprovalRationale = enforcedFirstPassResult.approved
      ? enforcedFirstPassResult.marginalApproval
        ? `marginal_approval${enforcedFirstPassResult.marginalReason ? `: ${enforcedFirstPassResult.marginalReason}` : ""}`
        : isHousekeeping
          ? "triage_schema_compliance"
          : isResearch
            ? "research_task_schema_pass"
            : undefined
      : undefined;

    this.store.updateTask(taskId, {
      verification_status: enforcedFirstPassResult.approved ? "approved" : "rejected",
      quality_score: enforcedFirstPassResult.score,
      verification_notes: enrichedNotes,
      quality_explanation: enforcedFirstPassResult.explanation ?? null,
    });

    this.recordVerificationResult(
      taskId,
      task.agent_name ?? "unknown",
      enforcedFirstPassResult.score,
      enforcedFirstPassResult.approved,
      enforcedFirstPassResult.approved
        ? undefined
        : (enforcedFirstPassResult.explanation ?? enforcedFirstPassResult.revision),
      enforcedFirstPassResult.blockedReason,
      singlePassApprovalRationale,
    );

    const standardResult: VerificationResult = {
      ...enforcedFirstPassResult,
      notes: enrichedNotes,
      revision: enrichedRevision,
      ...(singlePassApprovalRationale && { approvalRationale: singlePassApprovalRationale }),
    };

    // ── Priority quality gate (standard path) ────────────────────────────────
    return this.applyPriorityQualityGate(
      taskId,
      task.agent_name,
      task.issue_priority,
      standardResult,
    );
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
      const approved = Boolean(parsed.approved);
      const score = Math.min(Math.max(Number(parsed.score) || 0, 0), 1);
      // Only surface explanation when score is genuinely sub-0.80
      const explanation =
        score < 0.80 && parsed.explanation ? String(parsed.explanation) : undefined;

      // Detect marginal approvals: approved tasks scoring in [0.60, 0.74]
      const isMarginalApproval =
        approved &&
        score >= MARGINAL_APPROVAL_LOW &&
        score <= MARGINAL_APPROVAL_HIGH;
      const marginalReason =
        isMarginalApproval && parsed.marginal_reason
          ? String(parsed.marginal_reason)
          : undefined;

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

      // ── Hard-block guard ────────────────────────────────────────────────
      // Any score below HARD_BLOCK_THRESHOLD (0.50) is unconditionally rejected.
      // The LLM may return `approved: true` for very low scores in rare cases;
      // this guard ensures those scores can never reach state.db as 'approved'.
      const isHardBlocked = score < HARD_BLOCK_THRESHOLD;
      const effectiveApproved = isHardBlocked ? false : approved;
      const blockedReason: "hard_block_sub50" | undefined = isHardBlocked
        ? "hard_block_sub50"
        : undefined;

      return {
        approved: effectiveApproved,
        score,
        notes: String(parsed.notes ?? ""),
        revision: parsed.revision ? String(parsed.revision) : undefined,
        explanation,
        dimensions,
        ...(isMarginalApproval && !isHardBlocked && { marginalApproval: true }),
        ...(marginalReason && !isHardBlocked && { marginalReason }),
        ...(blockedReason && { blockedReason }),
      };
    } catch {
      return {
        approved: false,
        score: 0,
        notes: "Failed to parse verification response",
      };
    }
  }

  /**
   * Scan and repair all approved tasks with null quality_score.
   * Called periodically by the daemon to eliminate audit gaps.
   * Returns count of tasks repaired.
   */
  async repairNullScoresForApprovedTasks(): Promise<number> {
    // Query tasks without a hard limit; we want to find ALL approved tasks with null scores
    const allTasks = this.store.listTasks({ limit: 10000 });
    const nullScoreTasks = allTasks.filter(
      (t) => t.verification_status === "approved" && t.quality_score === null,
    );

    if (nullScoreTasks.length === 0) {
      this.log.info("No approved tasks with null quality_score found");
      return 0;
    }

    this.log.info("Repairing null scores for approved tasks", {
      count: nullScoreTasks.length,
      taskIds: nullScoreTasks.map((t) => t.id.slice(0, 12)),
    });

    let repaired = 0;
    for (const task of nullScoreTasks) {
      try {
        const inferredResult = await this.inferMissingScore(task);
        this.store.updateTask(task.id, {
          quality_score: inferredResult.score,
          verification_notes: inferredResult.notes,
          quality_explanation: inferredResult.approvalRationale ?? null,
        });

        this.recordVerificationResult(
          task.id,
          task.agent_name ?? "unknown",
          inferredResult.score,
          true,
          undefined,
          undefined,
          inferredResult.approvalRationale,
        );

        repaired++;
        this.log.info("Repaired null score for approved task", {
          taskId: task.id,
          inferredScore: inferredResult.score,
          approvalRationale: inferredResult.approvalRationale,
        });
      } catch (err) {
        this.log.error("Failed to repair null score for approved task", {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return repaired;
  }

  /**
   * Infer a quality score for approved tasks that lack a score.
   * Uses task-type-specific heuristics and a lightweight LLM pass as fallback.
   * Flags the score as inferred via approvalRationale.
   *
   * Called when an approved task is detected with quality_score = null.
   * Returns a VerificationResult with an inferred score (0.80+) and a special
   * approvalRationale prefix indicating inference was needed.
   */
  private async inferMissingScore(task: {
    id: string;
    task_type: string;
    title: string;
    description?: string | null;
    result?: string | null;
    agent_name?: string | null;
  }): Promise<VerificationResult> {
    const isResearch = task.task_type === "research";
    const isHousekeeping =
      task.task_type === "housekeeping" || task.title.includes("[housekeeping]");

    // ── Heuristic scoring: research and housekeeping tasks ──────────────────
    // Research tasks: if they passed schema checks, use 0.85
    // Housekeeping: if they're approved, they likely passed schema, use 0.82
    if (isResearch || isHousekeeping) {
      const heuristicScore = isResearch ? 0.85 : 0.82;
      this.log.info("Applying heuristic fallback score for approved task", {
        taskId: task.id,
        taskType: task.task_type,
        heuristicScore,
      });

      return {
        approved: true,
        score: heuristicScore,
        notes: `[Fallback score inferred — task was approved but lacked quality_score in DB]`,
        approvalRationale: `inferred_fallback_${task.task_type}_heuristic`,
      };
    }

    // ── Lightweight LLM inference for other task types ──────────────────────
    // For implementation and other task types, run a quick secondary pass
    // that just assigns a score without detailed rejection reasoning.
    const client = createLLMClient();
    const inferencePrompt = `Task: ${task.title}
Description: ${task.description ?? "(none)"}

Output (first 500 chars):
${(task.result ?? "(no output)").substring(0, 500)}

This task was approved but is missing a quality score in our audit system.
Assign a quality score 0.0-1.0 for this approved work. Return JSON:
{ "score": 0.80, "confidence": "high" }`;

    const inferenceSystemPrompt = `You are a quality auditor assigning a single score to pre-approved work.
Do not reject the task — it was already approved. Just estimate its quality.
Return valid JSON with "score" (0.0-1.0) and "confidence" ("low", "medium", "high").`;

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        system: inferenceSystemPrompt,
        messages: [{ role: "user", content: inferencePrompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text : ""))
        .join("");

      const cleaned = text
        .replace(/```(?:json)?\s*/g, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      const inferredScore = Math.min(Math.max(Number(parsed.score) || 0.80, 0), 1);

      this.log.info("LLM fallback score inferred", {
        taskId: task.id,
        taskType: task.task_type,
        inferredScore,
        confidence: parsed.confidence,
      });

      return {
        approved: true,
        score: inferredScore,
        notes: `[Fallback score inferred via lightweight LLM pass — task was approved but lacked quality_score in DB]`,
        approvalRationale: `inferred_fallback_llm_secondary`,
      };
    } catch (err) {
      // If inference fails, use a safe default for an approved task
      this.log.warn("Inference fallback failed, using default score", {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });

      return {
        approved: true,
        score: 0.80,
        notes: `[Default fallback score assigned — inference failed]`,
        approvalRationale: `inferred_fallback_default`,
      };
    }
  }
}
