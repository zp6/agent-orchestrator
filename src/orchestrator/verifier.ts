/**
 * Verifier schemas and utilities for task quality assurance.
 *
 * This module defines the required JSON schemas for verifying task outputs:
 * - TRIAGE_HOUSEKEEPING_SCHEMA: for single-repo backlog triage
 * - TRIAGE_CROSS_REPO_SCHEMA: for multi-repo cross-repo triage
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
