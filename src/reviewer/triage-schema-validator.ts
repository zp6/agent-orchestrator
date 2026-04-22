/**
 * Pre-submission triage schema validator — `/api/validate-triage-schema` (issue #406).
 *
 * Agents preparing a housekeeping/triage PR can POST their JSON block to this
 * endpoint and receive field-level pass/fail feedback BEFORE opening the PR.
 * This closes the loop on the revision cycles caused by schema errors that are
 * only caught during verification.
 *
 * The validation logic mirrors `Verifier.checkTriageSchemaCompliance()` exactly,
 * ensuring the self-check and the post-submission gate are identical.
 *
 * ## Mount in the orchestrator or dashboard server
 *
 *   import { createTriageSchemaValidationHandler } from 'claude-orchestrator-reviewer';
 *
 *   // POST /api/validate-triage-schema
 *   // Body: { "body": "<PR body text or bare JSON string>" }
 *   // OR:   raw JSON object matching the triage schema (parsed by Express json())
 *   app.post('/api/validate-triage-schema', createTriageSchemaValidationHandler());
 *
 * ## Agent usage
 *
 *   Before opening a PR, an agent can call:
 *
 *   curl -s -X POST http://localhost:3472/api/validate-triage-schema \
 *     -H 'Content-Type: application/json' \
 *     -d '{"body": "```json\n{\"duplicates_checked\":true,...}\n```"}'
 *
 *   Response:
 *   {
 *     "passed": true,
 *     "score": 1.0,
 *     "missing_fields": [],
 *     "field_errors": [],
 *     "present_fields": ["duplicates_checked","stale_issues","priority_reordering","outcome_summary"]
 *   }
 *
 * ## Acceptance criteria (issue #406)
 *   ✓ POST /api/validate-triage-schema accepts a JSON block or PR body text
 *   ✓ Returns pass/fail with field-level errors matching verifier logic
 *   ✓ Same scoring logic as Verifier.checkTriageSchemaCompliance()
 *   ✓ Agents can call before opening a PR to self-check
 */

import {
  TRIAGE_REQUIRED_FIELDS,
  TRIAGE_OUTPUT_SCHEMA,
} from "./verifier.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("triage-schema-validator");

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Score threshold — matches TRIAGE_SCHEMA_COMPLIANCE_THRESHOLD in verifier.ts.
 * All four fields (0.25 each) must be present for `passed: true`.
 */
export const TRIAGE_VALIDATION_PASS_THRESHOLD = 0.80;

/** Per-field score weights — identical to TRIAGE_FIELD_WEIGHTS in verifier.ts. */
export const TRIAGE_FIELD_SCORE_WEIGHTS: Record<string, number> = {
  duplicates_checked: 0.25,
  stale_issues: 0.25,
  priority_reordering: 0.25,
  outcome_summary: 0.25,
};

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One field-level error returned when a required field is missing or malformed.
 */
export interface TriageFieldError {
  /** The field name (or compound key like "stale_issues[*].{number,title,action,reason}"). */
  field: string;
  /** Human-readable explanation of the problem. */
  message: string;
  /**
   * Expected value description for the field.
   * Useful for surfacing to the agent without requiring them to look up the schema.
   */
  expected: string;
}

/**
 * Result returned by `validateTriageSchema()` and the HTTP endpoint.
 */
export interface TriageSchemaValidationResult {
  /** True when the JSON block passes all required field checks. */
  passed: boolean;
  /**
   * Compliance score 0–1.
   * Each of the four required fields contributes 0.25.
   * `passed` is true when score ≥ 0.80.
   */
  score: number;
  /** Field keys that are missing or malformed. Empty when `passed === true`. */
  missing_fields: string[];
  /** Per-field error details for each missing field. */
  field_errors: TriageFieldError[];
  /** Field keys that are present and valid. */
  present_fields: string[];
  /**
   * The schema template for reference — same as `TRIAGE_OUTPUT_SCHEMA`.
   * Included in the response so agents can diff their submission against the template.
   */
  schema_template: string;
}

// ── Core validator ────────────────────────────────────────────────────────────

/**
 * Validate a triage JSON block (or PR body containing one) against the required
 * housekeeping schema.
 *
 * Mirrors `Verifier.checkTriageSchemaCompliance()` exactly — same field checks,
 * same weights, same pass threshold — so the self-check gives agents the same
 * result as post-submission verification.
 *
 * Inputs accepted:
 *   - Fenced markdown block: ` ```json\n{...}\n``` `
 *   - Bare JSON string: `{"duplicates_checked": true, ...}`
 *   - Full PR body text containing a fenced JSON block anywhere in the text
 *
 * Fail-open: unparseable input returns `passed: false` with a clear error rather
 * than throwing. The HTTP handler wraps this so a malformed request body never
 * crashes the server.
 *
 * @param jsonOrText - Raw text to validate (PR body, fenced block, or bare JSON).
 */
export function validateTriageSchema(jsonOrText: string): TriageSchemaValidationResult {
  const missingFields: string[] = [];
  const fieldErrors: TriageFieldError[] = [];
  const presentFields: string[] = [];
  let score = 0;

  // ── Extract JSON ──────────────────────────────────────────────────────────

  let parsed: Record<string, unknown> | null = null;

  // Try fenced ```json ... ``` block first (matches Verifier logic exactly)
  const jsonBlockMatch = jsonOrText.match(/```json\s*([\s\S]*?)```/);
  const candidateJson = jsonBlockMatch ? jsonBlockMatch[1].trim() : jsonOrText.trim();

  try {
    const raw = JSON.parse(candidateJson);
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    // Parse failed — return all-missing result
    const allMissingErrors: TriageFieldError[] = TRIAGE_REQUIRED_FIELDS.map((f) => ({
      field: f,
      message: `Field "${f}" is missing — no parseable JSON block found in the input.`,
      expected: fieldExpectedDescription(f),
    }));
    return {
      passed: false,
      score: 0,
      missing_fields: [...TRIAGE_REQUIRED_FIELDS],
      field_errors: allMissingErrors,
      present_fields: [],
      schema_template: TRIAGE_OUTPUT_SCHEMA,
    };
  }

  if (!parsed) {
    // Parsed successfully but top-level value is not an object
    const allMissingErrors: TriageFieldError[] = TRIAGE_REQUIRED_FIELDS.map((f) => ({
      field: f,
      message: `Field "${f}" is missing — JSON was parsed but is not an object.`,
      expected: fieldExpectedDescription(f),
    }));
    return {
      passed: false,
      score: 0,
      missing_fields: [...TRIAGE_REQUIRED_FIELDS],
      field_errors: allMissingErrors,
      present_fields: [],
      schema_template: TRIAGE_OUTPUT_SCHEMA,
    };
  }

  // ── Field checks (mirrors Verifier.checkTriageSchemaCompliance exactly) ──

  // duplicates_checked: must be boolean true
  if (parsed["duplicates_checked"] === true) {
    score += TRIAGE_FIELD_SCORE_WEIGHTS["duplicates_checked"]!;
    presentFields.push("duplicates_checked");
  } else {
    const actual = JSON.stringify(parsed["duplicates_checked"] ?? null);
    missingFields.push("duplicates_checked");
    fieldErrors.push({
      field: "duplicates_checked",
      message: `"duplicates_checked" must be the boolean value \`true\`. Got: ${actual}.`,
      expected: fieldExpectedDescription("duplicates_checked"),
    });
  }

  // stale_issues: must be an array; if non-empty, each entry needs {number, title, action, reason}
  if (Array.isArray(parsed["stale_issues"])) {
    const entries = parsed["stale_issues"] as unknown[];
    const invalidEntries = entries.filter(
      (e) =>
        !(
          typeof e === "object" &&
          e !== null &&
          "number" in e &&
          "title" in e &&
          "action" in e &&
          "reason" in e
        ),
    );
    if (entries.length === 0 || invalidEntries.length === 0) {
      score += TRIAGE_FIELD_SCORE_WEIGHTS["stale_issues"]!;
      presentFields.push("stale_issues");
    } else {
      missingFields.push("stale_issues[*].{number,title,action,reason}");
      fieldErrors.push({
        field: "stale_issues[*].{number,title,action,reason}",
        message:
          `"stale_issues" contains ${invalidEntries.length} malformed entr${invalidEntries.length === 1 ? "y" : "ies"}. ` +
          `Each entry must have: number, title, action ("closed"|"updated"|"kept"), reason.`,
        expected: fieldExpectedDescription("stale_issues"),
      });
    }
  } else {
    missingFields.push("stale_issues");
    fieldErrors.push({
      field: "stale_issues",
      message: `"stale_issues" must be an array (use \`[]\` if no stale issues were found). Got: ${typeof parsed["stale_issues"]}.`,
      expected: fieldExpectedDescription("stale_issues"),
    });
  }

  // priority_reordering: must be an array (empty OK)
  if (Array.isArray(parsed["priority_reordering"])) {
    score += TRIAGE_FIELD_SCORE_WEIGHTS["priority_reordering"]!;
    presentFields.push("priority_reordering");
  } else {
    missingFields.push("priority_reordering");
    fieldErrors.push({
      field: "priority_reordering",
      message: `"priority_reordering" must be an array (use \`[]\` if no reordering occurred). Got: ${typeof parsed["priority_reordering"]}.`,
      expected: fieldExpectedDescription("priority_reordering"),
    });
  }

  // outcome_summary: must be a non-empty string
  if (
    typeof parsed["outcome_summary"] === "string" &&
    parsed["outcome_summary"].trim().length > 0
  ) {
    score += TRIAGE_FIELD_SCORE_WEIGHTS["outcome_summary"]!;
    presentFields.push("outcome_summary");
  } else {
    const actual =
      parsed["outcome_summary"] === undefined
        ? "missing"
        : parsed["outcome_summary"] === ""
          ? "empty string"
          : typeof parsed["outcome_summary"];
    missingFields.push("outcome_summary");
    fieldErrors.push({
      field: "outcome_summary",
      message: `"outcome_summary" must be a non-empty string. Got: ${actual}.`,
      expected: fieldExpectedDescription("outcome_summary"),
    });
  }

  return {
    passed: score >= TRIAGE_VALIDATION_PASS_THRESHOLD,
    score,
    missing_fields: missingFields,
    field_errors: fieldErrors,
    present_fields: presentFields,
    schema_template: TRIAGE_OUTPUT_SCHEMA,
  };
}

// ── HTTP handler factory ──────────────────────────────────────────────────────

/**
 * Create an Express-compatible `POST /api/validate-triage-schema` route handler.
 *
 * Mount in your orchestrator or dashboard server:
 *
 *   import { createTriageSchemaValidationHandler } from 'claude-orchestrator-reviewer';
 *   app.post('/api/validate-triage-schema', express.json(), createTriageSchemaValidationHandler());
 *
 * Request body (JSON):
 *   { "body": "<PR body text or fenced JSON block string>" }
 *   OR the triage schema object directly (if already parsed by express.json()):
 *   { "duplicates_checked": true, "stale_issues": [], "priority_reordering": [], "outcome_summary": "..." }
 *
 * Response (always 200 — errors are in the payload, not HTTP status):
 *   {
 *     "passed": boolean,
 *     "score": number,
 *     "missing_fields": string[],
 *     "field_errors": [{ "field": string, "message": string, "expected": string }],
 *     "present_fields": string[],
 *     "schema_template": string
 *   }
 *
 * Always returns 200 (even for validation failures) so agents can safely read
 * the response body. A 4xx is only returned for genuinely malformed requests
 * (missing Content-Type, no body).
 */
export function createTriageSchemaValidationHandler(): (req: any, res: any) => void {
  return (req: any, res: any): void => {
    try {
      const body: unknown = req.body;

      let inputText: string;

      if (typeof body === "string") {
        // Body was sent as plain text
        inputText = body;
      } else if (body !== null && typeof body === "object") {
        // Express parsed the JSON body — check for a "body" string field first
        const bodyObj = body as Record<string, unknown>;
        if (typeof bodyObj["body"] === "string") {
          // Agent sent { "body": "<PR body text>" }
          inputText = bodyObj["body"];
        } else {
          // Treat the whole parsed object as the triage schema
          inputText = JSON.stringify(bodyObj);
        }
      } else {
        res.status(400).json({
          error: "Request body must be JSON. Send { \"body\": \"<PR body text>\" } or the triage schema object directly.",
        });
        return;
      }

      const result = validateTriageSchema(inputText);

      log.info("Triage schema validation", {
        passed: result.passed,
        score: result.score,
        missingFields: result.missing_fields,
      });

      res.json(result);
    } catch (err) {
      log.error("Triage schema validation handler error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        error: "Internal validation error. Please check your request body and try again.",
      });
    }
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Human-readable "expected" description for each required triage field.
 * Surfaced in field_errors so agents can fix errors without consulting the schema.
 */
function fieldExpectedDescription(field: string): string {
  switch (field) {
    case "duplicates_checked":
      return `Boolean true — set to true after you've scanned open issues for duplicates.`;
    case "stale_issues":
      return `Array — list of issues closed/updated as stale, or [] if none. Each entry: { "number": N, "title": "...", "action": "closed|updated|kept", "reason": "..." }`;
    case "priority_reordering":
      return `Array — list of ROADMAP priority changes, or [] if none. Each entry: { "issue": N, "old_rank": <number|null>, "new_rank": N, "reason": "..." }. Use old_rank: null for newly-added issues (never 0).`;
    case "outcome_summary":
      return `Non-empty string — 1–3 sentence summary of what was done in this triage pass.`;
    default:
      return `Required field — see TRIAGE_OUTPUT_SCHEMA for the expected value.`;
  }
}
