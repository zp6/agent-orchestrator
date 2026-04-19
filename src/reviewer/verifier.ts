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

import { execSync } from "node:child_process";
import { buildCachedSystemContent, createLLMClient } from "../client/llm-client.js";
import { createLogger } from "../service/logger.js";
import type {
  IStateStore,
  IVerificationResultStore,
  SubtaskRollupPolicy,
  SubtaskRollupResult,
  SubtaskChildSummary,
  ShortCircuitDimension,
} from "../state/types.js";
import type { Notifier } from "../notify.js";
import {
  isCLITask,
  runSmokeTestsForTask,
  SMOKE_TEST_SCORE_PENALTY,
} from "./cli-smoke-test.js";

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
   * Set when the verifier's quality-gate enforcement overrides the LLM's decision:
   *
   * - `'hard_block_sub50'`  — score < 0.50: fundamentally incomplete work;
   *   held for operator review (hardest gate).
   * - `'low_score_sub60'`   — score in [0.50, 0.60): partial work that still falls
   *   well below the acceptance floor; held for operator review with dimension-level
   *   feedback so the operator can make an informed override-or-reject decision.
   * - `'held_for_operator_review'` — generic hold: score < 0.60, task requires
   *   explicit operator approval before it can proceed.
   *
   * All values persist to `verification_results.blocked_reason` so the dashboard
   * can distinguish enforced-gate holds from ordinary LLM rejections.
   */
  blockedReason?: "hard_block_sub50" | "low_score_sub60" | "held_for_operator_review";
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

/**
 * File patterns that identify "triage-only" concerns (documentation, admin files).
 * A PR mixing these files with feature files is considered bundled work.
 */
const TRIAGE_FILE_PATTERNS = [
  /^CLAUDE\.md$/i,
  /^README\.md$/i,
  /^README\.[a-z]+\.md$/i,
  /^ROADMAP\.md$/i,
  /^CHANGELOG\.md$/i,
  /^CHANGES\.md$/i,
  /^CONTRIBUTING\.md$/i,
  /^LICENSE$/i,
  /^docs\//i,
  /^\.github\//i, // GitHub workflows, but not source code config
];

/**
 * File patterns that identify "feature" concerns (implementation code).
 * A PR mixing these files with triage-only files is considered bundled work.
 */
const FEATURE_FILE_PATTERNS = [
  /^src\//i,
  /^lib\//i,
  /^dist\//i,
  /\.test\.(ts|js|tsx|jsx)$/i,
  /\.spec\.(ts|js|tsx|jsx)$/i,
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^yarn\.lock$/i,
  /^tsconfig.*\.json$/i,
  /^vite\.config\./i,
  /^webpack\.config\./i,
  /^jest\.config\./i,
  /\.eslintrc/i,
  /^\.prettierrc/i,
  /^babel\.config\./i,
];

/**
 * Categorizes a file path by concern: triage-only, feature, or neutral.
 */
function categorizeFile(filePath: string): "triage" | "feature" | "neutral" {
  const lower = filePath.toLowerCase();

  // Check triage patterns first
  for (const pattern of TRIAGE_FILE_PATTERNS) {
    if (pattern.test(lower)) {
      return "triage";
    }
  }

  // Check feature patterns
  for (const pattern of FEATURE_FILE_PATTERNS) {
    if (pattern.test(lower)) {
      return "feature";
    }
  }

  // Everything else is neutral (e.g., .gitignore, type defs, example files)
  return "neutral";
}

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
- Below 0.60: Rejected — score is below the hard floor; set approved:false and provide specific revision guidance

IMPORTANT: Any score below 0.60 MUST have approved:false. There is no approval path below the 0.60 floor regardless of mitigating factors.

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
 * Sub-0.60 rejection floor: any task scoring in the half-open interval
 * [HARD_BLOCK_THRESHOLD, SUB_THRESHOLD_REJECTION_LIMIT) is unconditionally
 * rejected with dimension-level feedback, regardless of the LLM's `approved`
 * field. Unlike the hard-block (< 0.50), these tasks have produced some
 * partial work but still fall well below the acceptable quality bar; targeted
 * dimension-level feedback is included so the agent can improve specific gaps.
 *
 * When this guard fires, `blockedReason` is set to `'low_score_sub60'`.
 */
const SUB_THRESHOLD_REJECTION_LIMIT = 0.60;

/**
 * Score range that triggers automatic second-pass review.
 * Tasks with a first-pass score in [BORDERLINE_LOW, BORDERLINE_HIGH] are
 * independently evaluated a second time before approval is finalised.
 *
 * Extended from [0.70, 0.79] to [0.60, 0.79] (issue #187) so that any
 * task that could plausibly be approved at the marginal bar gets a second
 * independent check before we commit to approval.
 */
const BORDERLINE_LOW = 0.60;
const BORDERLINE_HIGH = 0.79;

/**
 * Score range for marginal approvals.
 * Tasks approved with a score in [MARGINAL_APPROVAL_LOW, MARGINAL_APPROVAL_HIGH]
 * receive a distinct ⚠️ MARGINAL badge in the dashboard and a one-sentence
 * summary of what prevented a higher score, enabling operators to spot-audit
 * the weakest approved PRs before they accumulate technical debt.
 *
 * Upper bound raised from 0.74 to 0.79 (issue #187) to align with the
 * extended borderline range — any score that required a second pass to approve
 * is inherently marginal.
 */
const MARGINAL_APPROVAL_LOW = 0.60;
const MARGINAL_APPROVAL_HIGH = 0.79;

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
  "marginal_reason": "REQUIRED when approved is true AND score is between 0.60 and 0.79: one sentence explaining what prevented a higher score (e.g. 'Missing error handling in the retry path reduced confidence despite correct core logic.'). Omit entirely otherwise.",
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
- Below 0.60: Rejected — score is below the hard floor; set approved:false and provide specific revision guidance

IMPORTANT: Any score below 0.60 MUST have approved:false. There is no approval path below the 0.60 floor regardless of mitigating factors.

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
- Below 0.60: Rejected — score is below the hard floor; set approved:false and provide specific revision guidance

IMPORTANT: Any score below 0.60 MUST have approved:false. There is no approval path below the 0.60 floor regardless of mitigating factors.

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
  "marginal_reason": "REQUIRED when approved is true AND score is between 0.60 and 0.79: one sentence explaining what prevented a higher score (e.g. 'Missing error handling in the retry path reduced confidence despite correct core logic.'). Omit entirely otherwise.",
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
- Below 0.60: Rejected — score is below the hard floor; set approved:false and provide specific revision guidance

IMPORTANT: Any score below 0.60 MUST have approved:false. There is no approval path below the 0.60 floor regardless of mitigating factors.

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
   * Extracts changed file paths from a git diff.
   * Supports both full git diff format and patch format.
   *
   * @param diff - Raw diff string
   * @returns Array of changed file paths
   */
  private extractChangedFilesFromDiff(diff: string): string[] {
    const files = new Set<string>();

    // Primary: git diff headers
    for (const match of diff.matchAll(/^diff --git a\/(.+) b\/.+$/gm)) {
      files.add(match[1]);
    }

    // Fallback: +++ b/<path> lines (patch format without git headers)
    if (files.size === 0) {
      for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
        const path = match[1];
        if (path !== "/dev/null") files.add(path);
      }
    }

    return [...files];
  }

  /**
   * Checks for bundled work in a PR by analyzing which files were changed.
   * A PR is considered bundled if it contains both triage-only files (docs, CLAUDE.md)
   * and feature files (src/, implementation configs) in the same PR.
   *
   * @param changedFiles - Array of file paths changed in the PR
   * @returns Object containing:
   *   - bundled: true if the PR mixes triage and feature files
   *   - triageFiles: files categorized as triage-only
   *   - featureFiles: files categorized as feature implementation
   *   - violationType: describes the bundling type if bundled is true
   */
  checkBundlingCompliance(changedFiles: string[]): {
    bundled: boolean;
    triageFiles: string[];
    featureFiles: string[];
    violationType: string;
  } {
    const triageFiles: string[] = [];
    const featureFiles: string[] = [];

    for (const file of changedFiles) {
      const category = categorizeFile(file);
      if (category === "triage") {
        triageFiles.push(file);
      } else if (category === "feature") {
        featureFiles.push(file);
      }
      // neutral files are ignored for bundling purposes
    }

    const bundled = triageFiles.length > 0 && featureFiles.length > 0;
    const violationType = bundled ? "Mixed triage and feature files" : "Single concern";

    return { bundled, triageFiles, featureFiles, violationType };
  }

  /**
   * Extracts a PR reference from task result text.
   * Looks for patterns like "PR #123", "https://github.com/.../pull/123", etc.
   *
   * @param result - Raw task result string
   * @returns Object with repo and prNumber, or null if not found
   */
  private extractPRReferenceFromResult(
    result: string,
  ): { repo: string; prNumber: number } | null {
    if (!result) return null;

    // Pattern 1: "PR #123" or "PR#123"
    const simpleMatch = result.match(/PR\s*#(\d+)/i);
    if (simpleMatch) {
      const prNumber = parseInt(simpleMatch[1]!, 10);
      // PR number found but repo is unknown — caller will use source_ref or context
      return { repo: "", prNumber };
    }

    // Pattern 2: "https://github.com/owner/repo/pull/123"
    const urlMatch = result.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
    if (urlMatch) {
      const repo = urlMatch[1]!;
      const prNumber = parseInt(urlMatch[2]!, 10);
      return { repo, prNumber };
    }

    // Pattern 3: "rapartlu/some-repo PR #123" or similar
    const repoPatternMatch = result.match(/([\w-]+\/[\w-]+)\s+PR\s*#(\d+)/i);
    if (repoPatternMatch) {
      const repo = repoPatternMatch[1]!;
      const prNumber = parseInt(repoPatternMatch[2]!, 10);
      return { repo, prNumber };
    }

    return null;
  }

  /**
   * Fetches the PR diff from GitHub using the gh CLI.
   * Returns the full diff as a string for bundling analysis.
   *
   * @param repo - GitHub repo in format "owner/repo"
   * @param prNumber - Pull request number
   * @returns Diff as string, or null if fetch fails
   */
  private fetchPRDiffForBundlingCheck(repo: string, prNumber: number): string | null {
    if (!repo || !prNumber) return null;

    try {
      const diff = execSync(`gh pr diff ${prNumber} --repo ${repo}`, {
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024, // 10 MB max diff size
      }).toString();
      return diff;
    } catch (error) {
      // Log but don't fail — bundling check is opportunistic
      this.log.warn("Failed to fetch PR diff for bundling check", {
        repo,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
    blockedReason?: "hard_block_sub50" | "low_score_sub60" | "held_for_operator_review",
    approvalRationale?: string,
    /** null = non-CLI task; 1 = smoke tests passed; 0 = smoke tests failed */
    cliSmokeTestPassed?: number | null,
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
        cli_smoke_test_passed: cliSmokeTestPassed ?? null,
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
   *
   * Issue #272: tasks below 0.50 are now held for operator review rather than
   * auto-rejected. The operator can approve-with-override (logged) or reject.
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
   * Enforce the sub-0.60 rejection floor after a verification decision has been
   * parsed (issue #187).
   *
   * Handles scores in the half-open interval [HARD_BLOCK_THRESHOLD, SUB_THRESHOLD_REJECTION_LIMIT)
   * i.e. [0.50, 0.60). Scores below 0.50 are already handled by applyHardBlockGuard.
   * Scores at or above 0.60 are unaffected.
   *
   * When the guard fires:
   *   - `approved` is forced to `false`
   *   - `blockedReason` is set to `'low_score_sub60'`
   *   - All marginal/approval flags are stripped
   *
   * The score itself is preserved so dimension-level feedback can target
   * the specific quality gaps.
   */
  private applySubThresholdRejectionGuard(result: VerificationResult): VerificationResult {
    if (result.score < HARD_BLOCK_THRESHOLD || result.score >= SUB_THRESHOLD_REJECTION_LIMIT) {
      // Outside this guard's range — already handled by hard-block (< 0.50)
      // or acceptable for borderline/standard path (>= 0.60).
      return result;
    }
    if (!result.approved) {
      // Already rejected by the LLM — no override needed; preserve existing result.
      return result;
    }

    // The LLM returned approved:true but score < 0.60 — override.
    const {
      marginalApproval: _marginalApproval,
      marginalReason: _marginalReason,
      approvalRationale: _approvalRationale,
      approved: _approved,
      ...rest
    } = result;

    return {
      ...rest,
      approved: false,
      blockedReason: "low_score_sub60",
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

  /**
   * Hold a sub-0.60 task for operator review instead of auto-rejecting.
   *
   * Issue #272: tasks below the quality floor (0.60) are placed in
   * `needs_operator_review` status and a Telegram alert is sent. The operator
   * can approve-with-override (logged with rationale) or reject.
   *
   * This replaces the previous silent auto-rejection which allowed critically
   * low scores (0.30, 0.48, 0.58) to be silently re-dispatched without
   * operator awareness.
   *
   * @param taskId — task ID being verified
   * @param agentName — agent that produced the work
   * @param result — the guard-enforced verification result (approved=false, score < 0.60)
   */
  private async holdForOperatorReview(
    taskId: string,
    agentName: string | null | undefined,
    result: VerificationResult,
  ): Promise<void> {
    const scorePct = (result.score * 100).toFixed(0);
    const agent = agentName ?? "unknown";
    const tier = result.score < HARD_BLOCK_THRESHOLD ? "critical" : "low";
    const gate = result.blockedReason === "hard_block_sub50"
      ? `hard block (< ${(HARD_BLOCK_THRESHOLD * 100).toFixed(0)}%)`
      : `quality floor (< ${(SUB_THRESHOLD_REJECTION_LIMIT * 100).toFixed(0)}%)`;

    this.log.warn("Holding task for operator review — score below quality floor", {
      taskId,
      score: result.score,
      agent,
      blockedReason: result.blockedReason,
      tier,
    });

    // Move task to needs_operator_review status so the daemon does not
    // auto-retry or auto-approve. The task stays in this state until an
    // operator explicitly approves-with-override or rejects via the
    // Telegram /resolve command or dashboard.
    this.store.updateTask(taskId, {
      verification_status: "needs_operator_review" as any,
      quality_score: result.score,
      verification_notes: result.notes,
      quality_explanation: result.explanation ?? null,
    });

    // Alert the operator via Telegram.
    if (this.notifier) {
      const dimBreakdown = result.dimensions
        ? Object.entries(result.dimensions)
          .map(([dim, score]) => `  ${dim}: ${((score as number) * 100).toFixed(0)}%`)
          .join("\n")
        : null;

      const body = [
        `Task \`${taskId.slice(0, 12)}\` scored *${scorePct}%* — below the ${gate}.`,
        ``,
        `*Task:* \`${taskId}\``,
        `*Agent:* \`${agent}\``,
        `*Score:* ${scorePct}% (floor: ${(SUB_THRESHOLD_REJECTION_LIMIT * 100).toFixed(0)}%)`,
        `*Gate:* ${result.blockedReason ?? "sub_threshold"}`,
        ...(dimBreakdown ? [``, `*Dimensions:*`, dimBreakdown] : []),
        ``,
        `Task held in \`needs_operator_review\`. Use \`/resolve ${taskId.slice(0, 8)}\` to approve-with-override or reject.`,
      ].join("\n");

      await this.notifier.notifyOperator(
        "Quality floor hold: task requires operator review",
        body,
        "high",
      );
    }
  }

  /**
   * Record a canonical quality score for a task that exited via a short-circuit
   * path — no agent work was performed, so no LLM verification is needed.
   *
   * Short-circuit exits include:
   *   - `'no_action_needed'`     — already-in-review, zero-action standup, etc.
   *   - `'pre_dispatch_blocked'` — pre-dispatch guard exit (issue closed, auth failure)
   *   - `'orchestrator_routed'`  — orchestrator handled routing without agent work
   *
   * Records a canonical score of 1.0 (perfect, no action required) and marks
   * the task as 'approved' with a dimension label explaining the short-circuit.
   *
   * This closes the verification coverage gap for tasks that bypass the normal
   * verify() flow, ensuring operators can filter/sort all tasks by quality_score
   * without gaps.
   *
   * @param taskId    - The task to score.
   * @param dimension - Which short-circuit category applies.
   * @param reason    - Human-readable explanation (e.g. "Issue #42 already has open PR #43").
   * @returns The recorded VerificationResult.
   */
  recordShortCircuitScore(
    taskId: string,
    dimension: ShortCircuitDimension,
    reason: string,
  ): VerificationResult {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const CANONICAL_SCORE = 1.0;
    const notes = `[Short-circuit: ${dimension}] ${reason}`;
    const approvalRationale = `short_circuit_${dimension}`;

    this.store.updateTask(taskId, {
      verification_status: "approved",
      quality_score: CANONICAL_SCORE,
      verification_notes: notes,
    });

    this.recordVerificationResult(
      taskId,
      task.agent_name ?? "unknown",
      CANONICAL_SCORE,
      true,   // approved
      undefined, // no rejection reason
      undefined, // no blocked reason
      approvalRationale,
    );

    this.log.info("Recorded short-circuit score", {
      taskId,
      dimension,
      score: CANONICAL_SCORE,
      agent: task.agent_name,
      reason,
    });

    return {
      approved: true,
      score: CANONICAL_SCORE,
      notes,
      approvalRationale,
      dimensions: {
        correctness: 1.0,
        completeness: 1.0,
        test_coverage: 1.0,
        code_quality: 1.0,
      },
    };
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

      const rawInferredResult = await this.inferMissingScore(task);

      // Apply the hard floor guards defensively after inferMissingScore returns
      // (issue #279).  inferMissingScore applies them internally, but if it is
      // mocked, stubbed, or extended in the future without guards the floor
      // still enforces: no inferred result with score < 0.60 may be approved.
      const inferredResult = this.applySubThresholdRejectionGuard(
        this.applyHardBlockGuard(rawInferredResult),
      );

      // Issue #203: inferMissingScore now applies hard-block and sub-threshold
      // guards.  If the inferred score is below threshold, the result will have
      // approved=false.  We must update verification_status accordingly —
      // never leave a task as "approved" with a below-threshold score.
      const effectiveStatus = inferredResult.approved ? "approved" : "rejected";

      this.store.updateTask(taskId, {
        verification_status: effectiveStatus,
        quality_score: inferredResult.score,
        verification_notes: inferredResult.notes,
        quality_explanation: inferredResult.approved
          ? (inferredResult.approvalRationale ?? null)
          : (inferredResult.explanation ?? `Score ${inferredResult.score.toFixed(2)} below threshold — inferred score triggered rejection`),
      });

      this.recordVerificationResult(
        taskId,
        task.agent_name ?? "unknown",
        inferredResult.score,
        inferredResult.approved,
        inferredResult.approved ? undefined : (inferredResult.explanation ?? "Inferred score below threshold"),
        inferredResult.blockedReason,
        inferredResult.approvalRationale,
      );

      if (!inferredResult.approved) {
        this.log.warn("Pre-approved task rejected after score inference — score below threshold", {
          taskId,
          inferredScore: inferredResult.score,
          blockedReason: inferredResult.blockedReason,
          agentName: task.agent_name,
        });
      }

      return inferredResult;
    }

    // ── Already-handled pattern check ───────────────────────────────────────
    // Agents that correctly detect an existing open / mergeable PR should not
    // be penalised for "lacking implementation content".  If the result preview
    // matches a well-known already-handled pattern, short-circuit immediately
    // with score=1.0 rather than running LLM scoring.
    const resultText = task.result ?? "";
    const isAlreadyHandled =
      resultText.startsWith("already-in-review:") ||
      /already[\s-]handled/i.test(resultText) ||
      /pr already exists and is mergeable/i.test(resultText);

    if (isAlreadyHandled) {
      this.log.info(
        "Already-handled pattern detected — short-circuiting with score 1.0",
        {
          taskId,
          agentName: task.agent_name,
          resultPreview: resultText.slice(0, 120),
        },
      );
      return this.recordShortCircuitScore(
        taskId,
        "no_action_needed",
        "Agent correctly identified that work was already handled (existing open PR or already-in-review).",
      );
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

      // ── Bundling detection (issue #433) ───────────────────────────────────
      // After schema passes, check if the PR mixes feature files with triage files.
      // This prevents close-and-redo cycles where agents bundle unrelated concerns.
      const prRef = this.extractPRReferenceFromResult(task.result ?? "");
      if (prRef && prRef.prNumber > 0) {
        // Determine the repo: use extracted repo, or infer from task source_ref/context.
        // source_ref may be in the form "owner/repo#123" — strip the issue number first
        // by splitting on "#" before splitting on "/" to extract "owner/repo".
        let inferredRepo = "";
        if (typeof task.source_ref === "string") {
          const withoutIssue = task.source_ref.split("#")[0] ?? "";
          const segments = withoutIssue.split("/").filter(Boolean);
          if (segments.length === 2) {
            inferredRepo = segments.join("/");
          }
        }
        const repo = prRef.repo || inferredRepo;

        if (repo) {
          const diff = this.fetchPRDiffForBundlingCheck(repo, prRef.prNumber);
          if (diff) {
            // Extract changed files from diff using the same approach as schema-impact.ts
            const changedFiles = this.extractChangedFilesFromDiff(diff);
            const bundlingResult = this.checkBundlingCompliance(changedFiles);

            if (bundlingResult.bundled) {
              const triageList = bundlingResult.triageFiles.map((f) => `  - \`${f}\``).join("\n");
              const featureList = bundlingResult.featureFiles.map((f) => `  - \`${f}\``).join("\n");
              const revision = [
                `Bundled work detected in PR #${prRef.prNumber} — split into separate PRs.`,
                ``,
                `Feature implementation files (should be in a separate PR):`,
                featureList,
                ``,
                `Triage/documentation files (should be in a separate PR):`,
                triageList,
                ``,
                `To fix:`,
                `1. Close this PR`,
                `2. Create one PR with ONLY the feature files`,
                `3. Create a second PR with ONLY the triage files`,
                `4. Ensure each PR body includes "Closes #<issue>" to link to the originating issue`,
              ].join("\n");

              const failResult: VerificationResult = {
                approved: false,
                score: 0.0,
                notes: `Bundled work detected: PR mixes ${bundlingResult.triageFiles.length} triage file(s) with ${bundlingResult.featureFiles.length} feature file(s)`,
                revision,
                explanation: `The PR bundles unrelated work: feature implementation and triage/documentation changes should be in separate PRs.`,
              };

              this.store.updateTask(taskId, {
                verification_status: "rejected",
                quality_score: 0.0,
                verification_notes: failResult.notes,
                quality_explanation: failResult.explanation ?? null,
              });

              this.recordVerificationResult(
                taskId,
                task.agent_name ?? "unknown",
                0.0,
                false,
                failResult.explanation,
                undefined,
                undefined,
              );

              return failResult;
            }
          }
        }
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
    const enforcedFirstPassResult = this.applySubThresholdRejectionGuard(
      this.applyHardBlockGuard(firstPassResult),
    );

    // ── CLI smoke test quality gate (issue #277) ────────────────────────────
    // For tasks that reference CLI commands, automatically run the relevant
    // smoke test specs and apply a score penalty if any tests fail.
    // This runs after LLM scoring so the penalty stacks on top of the LLM score.
    // Environment errors (binary not found, timeout) are fail-open — they are
    // recorded in verification_notes but do NOT trigger a penalty.
    let smokeTestReport = null as ReturnType<typeof runSmokeTestsForTask> | null;
    let cliSmokeTestPassed: number | null = null;

    if (isCLITask(task.title, task.description)) {
      this.log.info("CLI task detected — running smoke tests", {
        taskId,
        title: task.title,
        agent: task.agent_name,
      });

      try {
        smokeTestReport = runSmokeTestsForTask(task.title, task.description, this.log);

        // Map boolean → SQLite integer for storage
        // null when no specs were selected (isCLITask=true but no keyword match)
        if (smokeTestReport.results.length > 0) {
          cliSmokeTestPassed = smokeTestReport.allPassed ? 1 : 0;
        }

        this.log.info("CLI smoke tests complete", {
          taskId,
          testsRun: smokeTestReport.results.length,
          allPassed: smokeTestReport.allPassed,
          anyFailed: smokeTestReport.anyFailed,
          scorePenalty: smokeTestReport.scorePenalty,
        });
      } catch (err) {
        // Never let smoke tests interrupt the main verification flow
        this.log.warn("CLI smoke test runner error — skipping smoke gate", { taskId, err });
        smokeTestReport = null;
      }
    }

    /**
     * Apply the smoke test score penalty to an LLM-derived score.
     * Clamps to [0, 1] and re-runs the guards so the quality floor is always
     * enforced on the final (post-penalty) score.
     */
    const applySmokePenalty = (score: number): number => {
      if (!smokeTestReport || smokeTestReport.scorePenalty === 0) return score;
      return Math.max(0, score - smokeTestReport.scorePenalty);
    };

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
      const enforcedSecondPassResult = this.applySubThresholdRejectionGuard(
        this.applyHardBlockGuard(secondPassResult),
      );

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

      // ── Smoke test penalty (borderline path) ───────────────────────────────
      // Apply after both LLM passes; re-enforce guards so the quality floor
      // is always honoured on the penalty-adjusted score.
      const borderlinePenaltyScore = applySmokePenalty(enforcedFirstPassResult.score);
      const borderlineScokeAdjusted = borderlinePenaltyScore < enforcedFirstPassResult.score;
      const borderlineFinalApproved =
        finalApproved &&
        !this.applyHardBlockGuard({ ...enforcedFirstPassResult, score: borderlinePenaltyScore }).blockedReason &&
        borderlinePenaltyScore >= SUB_THRESHOLD_REJECTION_LIMIT;

      // Prefix combined notes with marginal badge when applicable.
      const marginalBadge =
        finalMarginalApproval
          ? `⚠️ MARGINAL APPROVAL — score ${(borderlinePenaltyScore * 100).toFixed(0)}%` +
            (finalMarginalReason ? ` — ${finalMarginalReason}` : "") +
            "\n\n"
          : "";
      const smokeSection = smokeTestReport?.reportText
        ? `\n\n${smokeTestReport.reportText}`
        : "";
      const enrichedNotes = `${marginalBadge}${combinedNotes}${smokeSection}`;

      // Derive approval_rationale for auditable low-score approvals.
      // For borderline tasks that cleared the second pass, use 'second_pass_passed'
      // as the base code; upgrade to 'marginal_approval' when the score also falls
      // in the marginal range and both codes apply.
      const secondPassApprovalRationale = borderlineFinalApproved
        ? finalMarginalApproval
          ? `marginal_approval${finalMarginalReason ? `: ${finalMarginalReason}` : ""}`
          : "second_pass_passed"
        : undefined;

      const finalResult: VerificationResult = {
        approved: borderlineFinalApproved,
        score: borderlinePenaltyScore,
        notes: enrichedNotes,
        revision: borderlineFinalApproved ? undefined : enrichedRevision,
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
        finalApproved: borderlineFinalApproved,
        agent: task.agent_name,
        ...(borderlineScokeAdjusted && {
          smokeTestPenalty: SMOKE_TEST_SCORE_PENALTY,
          prepenaltyScore: enforcedFirstPassResult.score,
        }),
        ...(finalExplanation && { explanation: finalExplanation }),
        ...(finalMarginalApproval && { marginalApproval: true, marginalReason: finalMarginalReason }),
        ...(secondPassApprovalRationale && { approvalRationale: secondPassApprovalRationale }),
      });

      // Issue #272: if the borderline path produced a sub-0.60 score (e.g. smoke
      // test penalty dropped it below the floor), hold for operator review.
      const borderlineHeld = !borderlineFinalApproved && borderlinePenaltyScore < SUB_THRESHOLD_REJECTION_LIMIT;

      if (borderlineHeld) {
        const heldResult: VerificationResult = {
          ...finalResult,
          blockedReason: "held_for_operator_review",
        };

        await this.holdForOperatorReview(taskId, task.agent_name, heldResult);

        this.recordVerificationResult(
          taskId,
          task.agent_name ?? "unknown",
          borderlinePenaltyScore,
          false,
          finalExplanation ?? finalResult.revision,
          "held_for_operator_review",
          undefined,
          cliSmokeTestPassed,
        );

        return heldResult;
      }

      this.store.updateTask(taskId, {
        verification_status: borderlineFinalApproved ? "approved" : "rejected",
        quality_score: borderlinePenaltyScore,
        verification_notes: enrichedNotes,
        quality_explanation: finalExplanation ?? null,
      });

      this.recordVerificationResult(
        taskId,
        task.agent_name ?? "unknown",
        borderlinePenaltyScore,
        borderlineFinalApproved,
        borderlineFinalApproved ? undefined : (finalExplanation ?? finalResult.revision),
        finalResult.blockedReason,
        secondPassApprovalRationale,
        cliSmokeTestPassed,
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

    // Apply CLI smoke test penalty and re-enforce quality guards on the
    // penalty-adjusted score so the quality floor is always honoured.
    const standardPenaltyScore = applySmokePenalty(enforcedFirstPassResult.score);
    const standardScoreAdjusted = standardPenaltyScore < enforcedFirstPassResult.score;

    // Re-enforce hard-block and sub-threshold guards with the adjusted score.
    // This ensures a penalty that drops a task below 0.60 is treated as a rejection.
    const penaltyAdjustedResult = this.applySubThresholdRejectionGuard(
      this.applyHardBlockGuard({
        ...enforcedFirstPassResult,
        score: standardPenaltyScore,
      }),
    );

    this.log.info("Verification complete", {
      taskId,
      approved: penaltyAdjustedResult.approved,
      score: penaltyAdjustedResult.score,
      agent: task.agent_name,
      ...(standardScoreAdjusted && {
        smokeTestPenalty: SMOKE_TEST_SCORE_PENALTY,
        prepenaltyScore: enforcedFirstPassResult.score,
      }),
      ...(penaltyAdjustedResult.explanation && { explanation: penaltyAdjustedResult.explanation }),
      ...(penaltyAdjustedResult.marginalApproval && {
        marginalApproval: true,
        marginalReason: penaltyAdjustedResult.marginalReason,
      }),
      ...(penaltyAdjustedResult.blockedReason && { blockedReason: penaltyAdjustedResult.blockedReason }),
    });

    // Enrich revision with explanation and dimension breakdown so agents understand the low score.
    const dimensionsBreakdown =
      !penaltyAdjustedResult.approved && penaltyAdjustedResult.dimensions
        ? `\n\n${this.formatDimensionsBreakdown(penaltyAdjustedResult.dimensions, isResearch, isHousekeeping)}`
        : "";
    const enrichedRevision =
      !penaltyAdjustedResult.approved &&
      penaltyAdjustedResult.revision &&
      penaltyAdjustedResult.explanation
        ? `${penaltyAdjustedResult.explanation}${dimensionsBreakdown}\n\n${penaltyAdjustedResult.revision}`
        : penaltyAdjustedResult.revision;

    // Prefix notes with marginal badge so the dashboard task list can surface it.
    // Issue #272: sub-0.60 tasks now show "HELD FOR REVIEW" badge instead of silent rejection.
    const isHeldForReview = !!penaltyAdjustedResult.blockedReason &&
      (penaltyAdjustedResult.blockedReason === "hard_block_sub50" || penaltyAdjustedResult.blockedReason === "low_score_sub60");
    const marginalBadge =
      penaltyAdjustedResult.blockedReason === "hard_block_sub50"
        ? `🚧 HELD FOR OPERATOR REVIEW — score ${(penaltyAdjustedResult.score * 100).toFixed(0)}% below 50% hard floor\n\n`
        : penaltyAdjustedResult.blockedReason === "low_score_sub60"
          ? `🔴 HELD FOR OPERATOR REVIEW — score ${(penaltyAdjustedResult.score * 100).toFixed(0)}% below the 60% minimum floor\n\n`
          : penaltyAdjustedResult.marginalApproval
            ? `⚠️ MARGINAL APPROVAL — score ${(penaltyAdjustedResult.score * 100).toFixed(0)}%` +
              (penaltyAdjustedResult.marginalReason ? ` — ${penaltyAdjustedResult.marginalReason}` : "") +
          "\n\n"
          : "";
    const smokeSection = smokeTestReport?.reportText
      ? `\n\n${smokeTestReport.reportText}`
      : "";
    const enrichedNotes = `${marginalBadge}${penaltyAdjustedResult.notes}${smokeSection}`;

    // Derive approval_rationale for auditable low-score approvals.
    const singlePassApprovalRationale = penaltyAdjustedResult.approved
      ? penaltyAdjustedResult.marginalApproval
        ? `marginal_approval${penaltyAdjustedResult.marginalReason ? `: ${penaltyAdjustedResult.marginalReason}` : ""}`
        : isHousekeeping
          ? "triage_schema_compliance"
          : isResearch
            ? "research_task_schema_pass"
            : undefined
      : undefined;

    // Issue #272: hold sub-0.60 tasks for operator review instead of auto-rejecting.
    // The operator can approve-with-override or reject via /resolve.
    if (isHeldForReview) {
      const heldResult: VerificationResult = {
        ...penaltyAdjustedResult,
        notes: enrichedNotes,
        revision: enrichedRevision,
        blockedReason: "held_for_operator_review",
      };

      await this.holdForOperatorReview(taskId, task.agent_name, heldResult);

      this.recordVerificationResult(
        taskId,
        task.agent_name ?? "unknown",
        penaltyAdjustedResult.score,
        false,
        penaltyAdjustedResult.explanation ?? penaltyAdjustedResult.revision,
        penaltyAdjustedResult.blockedReason,
        undefined,
        cliSmokeTestPassed,
      );

      return heldResult;
    }

    this.store.updateTask(taskId, {
      verification_status: penaltyAdjustedResult.approved ? "approved" : "rejected",
      quality_score: penaltyAdjustedResult.score,
      verification_notes: enrichedNotes,
      quality_explanation: penaltyAdjustedResult.explanation ?? null,
    });

    this.recordVerificationResult(
      taskId,
      task.agent_name ?? "unknown",
      penaltyAdjustedResult.score,
      penaltyAdjustedResult.approved,
      penaltyAdjustedResult.approved
        ? undefined
        : (penaltyAdjustedResult.explanation ?? penaltyAdjustedResult.revision),
      penaltyAdjustedResult.blockedReason,
      singlePassApprovalRationale,
      cliSmokeTestPassed,
    );

    const standardResult: VerificationResult = {
      ...penaltyAdjustedResult,
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
            system: buildCachedSystemContent(systemPrompt),
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

      // ── Hard floor: reject all scores below 0.60 (issue #279) ──────────────
      //
      // Two sub-ranges, each with a distinct blocked_reason:
      //
      //   < 0.50  → hard_block_sub50: fundamentally incomplete/incorrect work.
      //             Unconditional rejection — no amount of borderline leniency
      //             or marginal approval should override this gate.
      //
      //   [0.50, 0.60) → low_score_sub60: partial work that still falls well
      //             below the acceptance floor.  Rejected with dimension-level
      //             feedback so the agent can target specific gaps.
      //
      // Both gates are applied inline here (parseResponse is the single source
      // of truth for all LLM-derived VerificationResults) AND redundantly in
      // applyHardBlockGuard / applySubThresholdRejectionGuard for defence-in-depth.
      const isHardBlocked = score < HARD_BLOCK_THRESHOLD;
      const isBelowMarginalFloor =
        !isHardBlocked && score < SUB_THRESHOLD_REJECTION_LIMIT;

      // Effective approval: tasks below the marginal floor are NEVER approved.
      const effectiveApproved =
        isHardBlocked || isBelowMarginalFloor ? false : approved;

      // Blocked reason — persisted to verification_results.blocked_reason for
      // the dashboard rejection log and audit queries.
      const blockedReason: "hard_block_sub50" | "low_score_sub60" | undefined =
        isHardBlocked
          ? "hard_block_sub50"
          : isBelowMarginalFloor
            ? "low_score_sub60"
            : undefined;

      // Marginal approval detection uses effectiveApproved so that sub-threshold
      // tasks (which are never approved) are never flagged as marginal.
      const isMarginalApproval =
        effectiveApproved &&
        score >= MARGINAL_APPROVAL_LOW &&
        score <= MARGINAL_APPROVAL_HIGH;
      const marginalReason =
        isMarginalApproval && parsed.marginal_reason
          ? String(parsed.marginal_reason)
          : undefined;

      return {
        approved: effectiveApproved,
        score,
        notes: String(parsed.notes ?? ""),
        revision: parsed.revision ? String(parsed.revision) : undefined,
        explanation,
        dimensions,
        ...(isMarginalApproval && { marginalApproval: true }),
        ...(marginalReason && { marginalReason }),
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
    // Issue #244: expand from approved-only to both approved AND rejected.
    // The name is kept for backwards compatibility (/backfill-scores Telegram
    // command calls this method by name).
    //
    // Previously this only covered verification_status = 'approved'.  Rejected
    // tasks with null quality_score were invisible to this repair, causing
    // quality analytics (trend charts, calibration drift, SLA alerts) to be
    // blind to ~half the verified task history whenever rejections accumulated
    // without scores.
    const nullScoreTasks = this.store.getVerifiedTasksWithNullScores(10000);

    if (nullScoreTasks.length === 0) {
      this.log.info("No verified tasks with null quality_score found");
      return 0;
    }

    this.log.info("Repairing null scores for verified tasks", {
      count: nullScoreTasks.length,
      approved: nullScoreTasks.filter((t) => t.verification_status === "approved").length,
      rejected: nullScoreTasks.filter((t) => t.verification_status === "rejected").length,
      taskIds: nullScoreTasks.map((t) => t.id.slice(0, 12)),
    });

    let repaired = 0;
    for (const task of nullScoreTasks) {
      try {
        const inferredResult = await this.inferMissingScore(task);

        // Apply the same hard-block and sub-threshold guards that the normal
        // verify() path applies — so the repair loop cannot silently approve a
        // task whose inferred score is critically low (issue #203).
        const guardedResult = this.applySubThresholdRejectionGuard(
          this.applyHardBlockGuard(inferredResult),
        );

        // For tasks already marked rejected, preserve the rejection — do not
        // flip them to approved even if the inferred score is above threshold.
        // For approved tasks whose guarded score is below the floor, use
        // 'needs_revision' (not 'rejected') so the task stays in the work queue
        // for redispatch rather than being permanently closed (issue #266).
        const alreadyRejected = task.verification_status === "rejected";
        const effectiveStatus: "approved" | "rejected" | "needs_revision" = alreadyRejected
          ? "rejected"
          : guardedResult.approved
            ? "approved"
            : "needs_revision";

        this.store.updateTask(task.id, {
          verification_status: effectiveStatus,
          quality_score: guardedResult.score,
          verification_notes: guardedResult.notes,
          quality_explanation: effectiveStatus === "approved"
            ? (guardedResult.approvalRationale ?? null)
            : (guardedResult.explanation ?? `Score ${guardedResult.score.toFixed(2)} below threshold — inferred score triggered rejection`),
        });

        this.recordVerificationResult(
          task.id,
          task.agent_name ?? "unknown",
          guardedResult.score,
          effectiveStatus === "approved",
          effectiveStatus !== "approved" ? (guardedResult.explanation ?? "Inferred score below threshold") : undefined,
          guardedResult.blockedReason,
          guardedResult.approvalRationale,
        );

        repaired++;
        this.log.info("Repaired null score for verified task", {
          taskId: task.id,
          inferredScore: guardedResult.score,
          originalStatus: task.verification_status,
          effectiveStatus,
          approvalRationale: guardedResult.approvalRationale,
          blockedReason: guardedResult.blockedReason,
        });
      } catch (err) {
        this.log.error("Failed to repair null score for verified task", {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return repaired;
  }

  /**
   * Proactive score backfill — called from the supervisor cycle.
   *
   * Finds ALL approved tasks with null quality_score and infers scores for
   * them, just like `repairNullScoresForApprovedTasks()`.  Also picks up
   * "done" tasks whose verification_status is still null (missed by the
   * normal verify cycle) and runs full verification on them.
   *
   * Returns the total number of tasks that were scored.
   *
   * Issue #212: ensures quality_score is always populated on verified tasks
   * so that quality trend analysis, calibration drift detection, and routing
   * accuracy tracking are never blind.
   */
  async ensureScoresPopulated(batchLimit: number = 50): Promise<number> {
    let scored = 0;

    // Phase 1: verified tasks (approved OR rejected) with null quality_score → infer score
    // Covers both approved tasks that bypassed the verifier and rejected tasks that
    // were hard-blocked before a score could be computed.
    //
    // Issue #244: the default batchLimit is raised from 10 to 50 so that a single
    // cycle can drain a backlog of up to 50 null-score tasks without waiting for
    // the next daemon cycle.
    const nullScoreTasks = this.store.getVerifiedTasksWithNullScores(batchLimit);
    if (nullScoreTasks.length > 0) {
      this.log.info("ensureScoresPopulated: backfilling verified tasks with null scores", {
        count: nullScoreTasks.length,
        approved: nullScoreTasks.filter((t) => t.verification_status === "approved").length,
        rejected: nullScoreTasks.filter((t) => t.verification_status === "rejected").length,
      });
      for (const task of nullScoreTasks) {
        try {
          const inferredResult = await this.inferMissingScore(task);

          // For tasks already marked rejected, preserve the rejection — do not
          // flip them to approved even if the inferred score is above threshold.
          // We only need to fill in the numeric score so quality analytics work.
          // For approved tasks, apply the normal score-approval invariant: if the
          // inferred score is below threshold, downgrade to rejected.
          const alreadyRejected = task.verification_status === "rejected";
          const effectiveStatus: "approved" | "rejected" = alreadyRejected
            ? "rejected"
            : inferredResult.approved
              ? "approved"
              : "rejected";

          this.store.updateTask(task.id, {
            verification_status: effectiveStatus,
            quality_score: inferredResult.score,
            verification_notes: inferredResult.notes,
            quality_explanation: effectiveStatus === "approved"
              ? (inferredResult.approvalRationale ?? null)
              : (inferredResult.explanation ?? `Score ${inferredResult.score.toFixed(2)} — inferred score backfill`),
          });

          this.recordVerificationResult(
            task.id,
            task.agent_name ?? "unknown",
            inferredResult.score,
            effectiveStatus === "approved",
            effectiveStatus !== "approved" ? (inferredResult.explanation ?? "Inferred score below threshold") : undefined,
            inferredResult.blockedReason,
            inferredResult.approvalRationale,
          );

          scored++;
          this.log.info("ensureScoresPopulated: backfilled score", {
            taskId: task.id,
            inferredScore: inferredResult.score,
            originalStatus: task.verification_status,
            effectiveStatus,
          });
        } catch (err) {
          this.log.error("ensureScoresPopulated: failed to infer score", {
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Phase 2: done tasks with verification_status IS NULL → full verify
    //
    // Issue #244: Phase 2 previously used `remaining = batchLimit - scored`
    // which meant Phase 2 was starved whenever Phase 1 filled the batch.  For
    // example, with batchLimit=10 and 10+ null-score verified tasks, Phase 2
    // would get `remaining = 0` and unverified done tasks would accumulate
    // indefinitely.  The fix: each phase uses the full batchLimit independently.
    const unverified = this.store.getUnverified(batchLimit);
    if (unverified.length > 0) {
      this.log.info("ensureScoresPopulated: verifying unscored done tasks", {
        count: unverified.length,
      });
      for (const task of unverified) {
        try {
          await this.verify(task.id);
          scored++;
        } catch (err) {
          this.log.error("ensureScoresPopulated: verification failed", {
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Phase 3: done tasks with null quality_score AND null verification_status,
    // older than 5 minutes — these are tasks that bypassed the normal verification
    // flow entirely (short-circuit exits, pre-dispatch guard blocks, orchestrator-
    // routed no-ops).  Assign a canonical 1.0 score with 'no_action_needed'
    // dimension since the task reached 'done' without requiring agent work.
    //
    // Issue #250: ensures zero null quality_score rows for tasks in 'done' status
    // older than the grace period.
    if (typeof this.store.getDoneTasksWithNullScores === "function") {
      const staleNullScoreTasks = this.store.getDoneTasksWithNullScores(5, batchLimit);
      if (staleNullScoreTasks.length > 0) {
        this.log.info("ensureScoresPopulated: Phase 3 — scoring stale done tasks with null scores", {
          count: staleNullScoreTasks.length,
        });
        for (const task of staleNullScoreTasks) {
          try {
            this.recordShortCircuitScore(
              task.id,
              "no_action_needed",
              "Task reached 'done' status without verification — backfilled by ensureScoresPopulated Phase 3",
            );
            scored++;
          } catch (err) {
            this.log.error("ensureScoresPopulated: Phase 3 scoring failed", {
              taskId: task.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    if (scored > 0) {
      this.log.info("ensureScoresPopulated: completed", { scored });
    }

    return scored;
  }

  /**
   * Infer a quality score for approved tasks that lack a score.
   * Uses task-type-specific heuristics and a lightweight LLM pass as fallback.
   * Flags the score as inferred via approvalRationale.
   *
   * Called when an approved task is detected with quality_score = null.
   * Returns a VerificationResult with an inferred score and a special
   * approvalRationale prefix indicating inference was needed.
   *
   * IMPORTANT (issue #203): The inferred score is subject to the same
   * hard-block (< 0.50) and sub-threshold (< 0.60) guards as first-pass
   * scores. If the LLM inference returns a very low score, the task will
   * be rejected — not silently approved with a low score.
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
        system: buildCachedSystemContent(inferenceSystemPrompt),
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

      // ── Score threshold enforcement for inferred scores (issue #203) ──────
      // Apply the same hard-block and sub-threshold guards as first-pass scores.
      // A pre-approved task whose inferred score is very low indicates the
      // original approval was wrong — reject it rather than silently recording
      // an approved task with a trust-breaking score.
      const inferredResult: VerificationResult = {
        approved: true,
        score: inferredScore,
        notes: `[Fallback score inferred via lightweight LLM pass — task was approved but lacked quality_score in DB]`,
        approvalRationale: `inferred_fallback_llm_secondary`,
      };

      return this.applySubThresholdRejectionGuard(
        this.applyHardBlockGuard(inferredResult),
      );
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
