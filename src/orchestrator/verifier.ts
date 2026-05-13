/**
 * Verifier schemas and utilities for task quality assurance.
 *
 * This module defines the required JSON schemas for verifying task outputs:
 * - TRIAGE_HOUSEKEEPING_SCHEMA: for single-repo backlog triage
 * - TRIAGE_CROSS_REPO_SCHEMA: for multi-repo cross-repo triage
 * - RESEARCH_FINDING_SCHEMA: for research findings (issue #1644)
 *
 * These schemas are used by the orchestrator's PR reviewer to validate
 * housekeeping and cross-repo triage PRs before they're merged. The same
 * schemas are also used by the reviewer agent's verifier to score task
 * outputs and detect missing or malformed metadata blocks.
 */

// ── Housekeeping Triage Schema ─────────────────────────────────────────────

/**
 * Housekeeping triage schema: required fields in PR metadata for single-repo triage.
 *
 * Tasks with `task_type === "housekeeping"` or a title containing `[housekeeping]`
 * must include a JSON block with these four required fields before reaching LLM
 * scoring in the reviewer agent's verifier.
 *
 * Scoring: each field is weighted 0.25; all four must be present for score ≥ 0.80.
 * Missing any field triggers immediate revision with an explicit list of missing fields
 * — no LLM score can override this gate.
 */
export const TRIAGE_HOUSEKEEPING_SCHEMA = {
  required_fields: [
    "duplicates_checked",
    "stale_issues",
    "priority_reordering",
    "outcome_summary"
  ],
  field_types: {
    duplicates_checked: "boolean",
    stale_issues: "array",
    priority_reordering: "array",
    outcome_summary: "string",
  },
  descriptions: {
    duplicates_checked: "boolean true — confirms a duplicate scan was performed",
    stale_issues: "array of { number, title, action, reason } (empty [] is valid)",
    priority_reordering: "array of { issue, old_rank, new_rank, reason } (empty [] is valid)",
    outcome_summary: "non-empty string (1–3 sentence summary)",
  },
} as const;

// ── Cross-Repo Triage Schema ───────────────────────────────────────────────

/**
 * Cross-repo triage schema: required fields in PR metadata for multi-repo triage.
 *
 * Cross-repo triage tasks span multiple agent repos (e.g. reviewing issues in
 * agent-reviewer while working from agent-orchestrator). When a housekeeping task
 * involves examining issues across multiple agent repositories, the output must
 * include this cross-repo triage schema to capture:
 *
 * - source_repo: the repo where the triage agent is based
 * - target_repo: the repo(s) being triaged
 * - issues_reviewed: count/list of issues examined
 * - routing_corrections: array of reroute decisions made (e.g. wrong agent, wrong repo)
 * - outcome_summary: summary of findings and actions taken
 *
 * Missing any required field triggers immediate revision with an explicit list
 * of missing fields — no LLM score can override this gate.
 *
 * Scoring: each field is weighted 0.20; all five must be present for score ≥ 0.80.
 *
 * This schema addresses issue #975: "Cross-repo triage schema and verifier gate"
 * where cross-repo triage tasks were scoring 0.68 (marginal) due to lack of
 * structured schema validation.
 */
export const TRIAGE_CROSS_REPO_SCHEMA = {
  required_fields: [
    "source_repo",
    "target_repo",
    "issues_reviewed",
    "routing_corrections",
    "outcome_summary"
  ],
  field_types: {
    source_repo: "string",
    target_repo: "string",
    issues_reviewed: "number|array",
    routing_corrections: "array",
    outcome_summary: "string",
  },
  descriptions: {
    source_repo: "repo where the triage agent is based (e.g. 'rapartlu/agent-orchestrator')",
    target_repo: "repo(s) being triaged (e.g. 'rapartlu/agent-reviewer')",
    issues_reviewed: "count of issues examined, or array of issue numbers",
    routing_corrections: "array of { issue_number, old_routing, new_routing, reason } (empty [] is valid)",
    outcome_summary: "summary of triage findings and routing corrections (1–3 sentences)",
  },
} as const;

// ── Research Finding Schema (issue #1644) ─────────────────────────────────

/**
 * Research finding schema: required markdown sections for fleet research outputs.
 *
 * Every research finding produced by the fleet — whether dispatched via `orch research`
 * or authored directly by an agent — must include all five sections before the finding
 * can be promoted into a spec, planning document, or implementation dispatch.
 *
 * The `verified_external_dependencies` and `unverified_claims` sections are the critical
 * ones: they make explicit which external-system claims have been confirmed with evidence
 * and which have not. Downstream consumers (planning agents, implementers) must address
 * every ⚠-flagged item in `unverified_claims` before writing code that depends on them.
 *
 * Background (issue #1642): The ImmunefiAdapter was built on a hallucinated API endpoint
 * (`api.immunefi.com`) because the research finding was silent on whether a programmatic
 * submission path existed. Silence was interpreted as "API exists." The verified-dependencies
 * section prevents this class of error by making silence impossible.
 *
 * Scoring: each section is weighted 0.20; all five must be present for score ≥ 0.80.
 * The `verified_external_dependencies` and `unverified_claims` sections carry double
 * weight at the Director gate — a finding missing either is rejected outright.
 *
 * Template: `docs/research/_template.md`
 * Worked example: `docs/research/2026-05-11-immunefi-bounty-submission.md`
 */
export const RESEARCH_FINDING_SCHEMA = {
  required_sections: [
    "problem_statement",
    "key_findings",
    "verified_external_dependencies",
    "unverified_claims",
    "implementation_recommendations",
  ],
  section_descriptions: {
    problem_statement: "One paragraph: what question was researched, what decision it informs, and why the answer matters now",
    key_findings: "Numbered list of concrete, independently verifiable facts established during research",
    verified_external_dependencies: "Markdown table of every external claim: each row has the claim, verification evidence (URL + quote), and ✓ verified or ⚠ unverified status",
    unverified_claims: "Explicit list of every ⚠-flagged claim with: what breaks if wrong, how to probe. May be 'None' if all claims verified.",
    implementation_recommendations: "Numbered list of concrete next actions grounded in the key findings",
  },
  /**
   * Sections that, if absent, trigger an outright rejection (not a score penalty).
   * The Director must refuse to dispatch implementation work from a finding that
   * lacks either of these two sections.
   */
  hard_required: ["verified_external_dependencies", "unverified_claims"] as const,
  section_weight: 0.20,
} as const;

/**
 * Required section headings as they appear in the Markdown source.
 * Used by checkResearchFindingCompliance() to detect presence/absence.
 */
export const RESEARCH_FINDING_SECTION_HEADINGS: Record<
  (typeof RESEARCH_FINDING_SCHEMA.required_sections)[number],
  string
> = {
  problem_statement: "## Problem Statement",
  key_findings: "## Key Findings",
  verified_external_dependencies: "## Verified External Dependencies",
  unverified_claims: "## Unverified Claims",
  implementation_recommendations: "## Implementation Recommendations",
};

// ── Schema Utilities ───────────────────────────────────────────────────────

export interface TriageSchemaValidationResult {
  valid: boolean;
  error?: string;
  missingFields?: string[];
}

/**
 * Check if a task output includes required housekeeping triage schema fields.
 * Returns validation result with error details if invalid.
 */
export function checkHousekeepingSchemaCompliance(json: unknown): TriageSchemaValidationResult {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      valid: false,
      error: "Schema must be an object (not an array or primitive)"
    };
  }

  const obj = json as Record<string, unknown>;
  const missingFields = TRIAGE_HOUSEKEEPING_SCHEMA.required_fields.filter(
    field => !(field in obj)
  );

  if (missingFields.length > 0) {
    return {
      valid: false,
      error: `Missing required fields: ${missingFields.join(', ')}`,
      missingFields
    };
  }

  return { valid: true };
}

/**
 * Check if a task output includes required cross-repo triage schema fields.
 * Returns validation result with error details if invalid.
 */
export function checkCrossRepoTriageSchemaCompliance(json: unknown): TriageSchemaValidationResult {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      valid: false,
      error: "Schema must be an object (not an array or primitive)"
    };
  }

  const obj = json as Record<string, unknown>;
  const missingFields = TRIAGE_CROSS_REPO_SCHEMA.required_fields.filter(
    field => !(field in obj)
  );

  if (missingFields.length > 0) {
    return {
      valid: false,
      error: `Missing required fields: ${missingFields.join(', ')}`,
      missingFields
    };
  }

  return { valid: true };
}

// ── Research Finding Validation ────────────────────────────────────────────

export interface ResearchFindingValidationResult {
  /** True if all required sections are present. */
  valid: boolean;
  /** Human-readable error summary. Undefined when valid. */
  error?: string;
  /** Required sections that are absent from the markdown. */
  missingSections: string[];
  /**
   * True when any hard-required section (verified_external_dependencies or
   * unverified_claims) is absent. A hard-required miss means the finding must
   * be rejected outright — no LLM score can override it.
   */
  hardRequiredMissing: boolean;
  /** Computed quality score: 1.0 - (missingSections.length × section_weight). */
  score: number;
}

/**
 * Check whether a research finding Markdown document includes all required
 * sections from RESEARCH_FINDING_SCHEMA.
 *
 * Pass the raw Markdown string of the finding. The function looks for the
 * canonical section headings defined in RESEARCH_FINDING_SECTION_HEADINGS.
 *
 * @example
 * ```ts
 * const md = fs.readFileSync("docs/research/2026-05-immunefi.md", "utf8");
 * const result = checkResearchFindingCompliance(md);
 * if (!result.valid) {
 *   console.error(`Finding rejected: ${result.error}`);
 *   if (result.hardRequiredMissing) {
 *     console.error("Hard-required section missing — cannot promote to spec.");
 *   }
 * }
 * ```
 */
export function checkResearchFindingCompliance(
  markdownContent: string,
): ResearchFindingValidationResult {
  const missingSections: string[] = [];

  for (const [sectionKey, heading] of Object.entries(RESEARCH_FINDING_SECTION_HEADINGS)) {
    // Match the heading anywhere in the document (case-sensitive, start-of-line).
    if (!markdownContent.includes(heading)) {
      missingSections.push(sectionKey);
    }
  }

  const hardRequiredMissing = RESEARCH_FINDING_SCHEMA.hard_required.some(
    key => missingSections.includes(key),
  );

  const score = Math.max(
    0,
    1.0 - missingSections.length * RESEARCH_FINDING_SCHEMA.section_weight,
  );

  if (missingSections.length === 0) {
    return { valid: true, missingSections: [], hardRequiredMissing: false, score: 1.0 };
  }

  const hardLabel = hardRequiredMissing ? " [HARD-REQUIRED — reject outright]" : "";
  return {
    valid: false,
    error: `Missing required sections: ${missingSections.join(", ")}${hardLabel}`,
    missingSections,
    hardRequiredMissing,
    score,
  };
}
