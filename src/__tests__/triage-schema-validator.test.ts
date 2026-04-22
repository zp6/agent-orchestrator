/**
 * Tests for triage-schema-validator.ts (issue #406).
 *
 * Covers:
 *   1. validateTriageSchema() — all field checks, pass/fail logic, score calculation
 *   2. validateTriageSchema() — input format handling (fenced block, bare JSON, prose)
 *   3. createTriageSchemaValidationHandler() — HTTP handler request parsing and response shape
 */

import { describe, it, expect, vi } from "vitest";
import {
  validateTriageSchema,
  createTriageSchemaValidationHandler,
  TRIAGE_VALIDATION_PASS_THRESHOLD,
  TRIAGE_FIELD_SCORE_WEIGHTS,
  type TriageSchemaValidationResult,
} from "../reviewer/triage-schema-validator.js";
import { TRIAGE_OUTPUT_SCHEMA, TRIAGE_REQUIRED_FIELDS } from "../reviewer/verifier.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_SCHEMA = {
  duplicates_checked: true,
  stale_issues: [],
  priority_reordering: [],
  outcome_summary: "Triage complete — no duplicates or stale issues found.",
};

const VALID_JSON = JSON.stringify(VALID_SCHEMA);

const VALID_FENCED = `Some prose before.

\`\`\`json
${VALID_JSON}
\`\`\`

Some prose after.`;

function makeReq(body: unknown): any {
  return { body };
}

function makeRes(): { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  const res: any = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  };
  return res;
}

// ── validateTriageSchema — input formats ──────────────────────────────────────

describe("validateTriageSchema — input formats", () => {
  it("accepts bare JSON string", () => {
    const result = validateTriageSchema(VALID_JSON);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it("accepts fenced ```json ... ``` block", () => {
    const result = validateTriageSchema(VALID_FENCED);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it("accepts full PR body text with embedded fenced block", () => {
    const prBody = `
## Triage Summary

All good.

\`\`\`json
{"duplicates_checked":true,"stale_issues":[],"priority_reordering":[],"outcome_summary":"Done."}
\`\`\`

Closes #123
`;
    const result = validateTriageSchema(prBody);
    expect(result.passed).toBe(true);
  });

  it("returns all-missing on unparseable input", () => {
    const result = validateTriageSchema("not json at all");
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.missing_fields).toHaveLength(TRIAGE_REQUIRED_FIELDS.length);
  });

  it("returns all-missing when JSON is an array (not an object)", () => {
    const result = validateTriageSchema("[1, 2, 3]");
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.missing_fields).toHaveLength(TRIAGE_REQUIRED_FIELDS.length);
  });
});

// ── validateTriageSchema — field checks ───────────────────────────────────────

describe("validateTriageSchema — field checks", () => {
  it("passes when all four fields are correctly present", () => {
    const result = validateTriageSchema(VALID_JSON);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.missing_fields).toHaveLength(0);
    expect(result.field_errors).toHaveLength(0);
    expect(result.present_fields).toEqual(
      expect.arrayContaining(["duplicates_checked", "stale_issues", "priority_reordering", "outcome_summary"]),
    );
  });

  it("fails when duplicates_checked is false (not true)", () => {
    const json = JSON.stringify({ ...VALID_SCHEMA, duplicates_checked: false });
    const result = validateTriageSchema(json);
    expect(result.passed).toBe(false);
    expect(result.missing_fields).toContain("duplicates_checked");
    const err = result.field_errors.find((e) => e.field === "duplicates_checked");
    expect(err).toBeDefined();
    expect(err!.message).toContain("true");
  });

  it("fails when duplicates_checked is missing", () => {
    const { duplicates_checked: _, ...rest } = VALID_SCHEMA;
    const result = validateTriageSchema(JSON.stringify(rest));
    expect(result.missing_fields).toContain("duplicates_checked");
  });

  it("passes with stale_issues as empty array", () => {
    const result = validateTriageSchema(VALID_JSON);
    expect(result.present_fields).toContain("stale_issues");
  });

  it("passes with stale_issues containing valid entries", () => {
    const json = JSON.stringify({
      ...VALID_SCHEMA,
      stale_issues: [{ number: 42, title: "Old issue", action: "closed", reason: "No activity" }],
    });
    const result = validateTriageSchema(json);
    expect(result.present_fields).toContain("stale_issues");
    expect(result.passed).toBe(true);
  });

  it("fails when stale_issues entry is missing required sub-fields", () => {
    const json = JSON.stringify({
      ...VALID_SCHEMA,
      stale_issues: [{ number: 42, title: "Old issue" }], // missing action and reason
    });
    const result = validateTriageSchema(json);
    expect(result.passed).toBe(false);
    expect(result.missing_fields.some((f) => f.includes("stale_issues"))).toBe(true);
  });

  it("fails when stale_issues is not an array", () => {
    const json = JSON.stringify({ ...VALID_SCHEMA, stale_issues: "none" });
    const result = validateTriageSchema(json);
    expect(result.missing_fields).toContain("stale_issues");
    expect(result.field_errors.find((e) => e.field === "stale_issues")?.message).toContain("array");
  });

  it("passes with priority_reordering as empty array", () => {
    const result = validateTriageSchema(VALID_JSON);
    expect(result.present_fields).toContain("priority_reordering");
  });

  it("fails when priority_reordering is not an array", () => {
    const json = JSON.stringify({ ...VALID_SCHEMA, priority_reordering: null });
    const result = validateTriageSchema(json);
    expect(result.missing_fields).toContain("priority_reordering");
    expect(result.field_errors.find((e) => e.field === "priority_reordering")?.message).toContain("array");
  });

  it("fails when outcome_summary is missing", () => {
    const { outcome_summary: _, ...rest } = VALID_SCHEMA;
    const result = validateTriageSchema(JSON.stringify(rest));
    expect(result.missing_fields).toContain("outcome_summary");
  });

  it("fails when outcome_summary is an empty string", () => {
    const json = JSON.stringify({ ...VALID_SCHEMA, outcome_summary: "" });
    const result = validateTriageSchema(json);
    expect(result.missing_fields).toContain("outcome_summary");
    expect(result.field_errors.find((e) => e.field === "outcome_summary")?.message).toContain("empty");
  });

  it("fails when outcome_summary is a number", () => {
    const json = JSON.stringify({ ...VALID_SCHEMA, outcome_summary: 42 });
    const result = validateTriageSchema(json);
    expect(result.missing_fields).toContain("outcome_summary");
  });
});

// ── validateTriageSchema — score and threshold ────────────────────────────────

describe("validateTriageSchema — score and threshold", () => {
  it("score is 1.0 when all fields present", () => {
    expect(validateTriageSchema(VALID_JSON).score).toBe(1.0);
  });

  it("score is 0.75 when one field is missing (below 0.80 threshold)", () => {
    const { outcome_summary: _, ...rest } = VALID_SCHEMA;
    const result = validateTriageSchema(JSON.stringify(rest));
    expect(result.score).toBeCloseTo(0.75);
    expect(result.passed).toBe(false);
  });

  it("score is 0.50 when two fields are missing", () => {
    const { outcome_summary: _1, priority_reordering: _2, ...rest } = VALID_SCHEMA;
    const result = validateTriageSchema(JSON.stringify(rest));
    expect(result.score).toBeCloseTo(0.50);
    expect(result.passed).toBe(false);
  });

  it("score is 0.0 when no fields are present", () => {
    const result = validateTriageSchema(JSON.stringify({}));
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("TRIAGE_VALIDATION_PASS_THRESHOLD is 0.80", () => {
    expect(TRIAGE_VALIDATION_PASS_THRESHOLD).toBe(0.80);
  });

  it("TRIAGE_FIELD_SCORE_WEIGHTS sum to 1.0", () => {
    const sum = Object.values(TRIAGE_FIELD_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0);
  });
});

// ── validateTriageSchema — response fields ────────────────────────────────────

describe("validateTriageSchema — response fields", () => {
  it("always includes schema_template in the response", () => {
    const result = validateTriageSchema(VALID_JSON);
    expect(result.schema_template).toBe(TRIAGE_OUTPUT_SCHEMA);
  });

  it("field_errors include expected value description for each missing field", () => {
    const result = validateTriageSchema(JSON.stringify({}));
    for (const err of result.field_errors) {
      expect(err.expected.length).toBeGreaterThan(0);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it("expected description for priority_reordering mentions old_rank: null", () => {
    const { priority_reordering: _, ...rest } = VALID_SCHEMA;
    const result = validateTriageSchema(JSON.stringify(rest));
    const err = result.field_errors.find((e) => e.field === "priority_reordering");
    expect(err!.expected).toContain("null");
  });

  it("present_fields + missing_fields cover all required fields", () => {
    const result = validateTriageSchema(VALID_JSON);
    const allFields = [...result.present_fields, ...result.missing_fields.map((f) => f.split("[")[0]!)];
    for (const field of TRIAGE_REQUIRED_FIELDS) {
      expect(allFields).toContain(field);
    }
  });
});

// ── createTriageSchemaValidationHandler ───────────────────────────────────────

describe("createTriageSchemaValidationHandler", () => {
  const handler = createTriageSchemaValidationHandler();

  it("returns 200 with passed:true for valid schema object", () => {
    const req = makeReq(VALID_SCHEMA);
    const res = makeRes();
    handler(req, res);
    expect(res.json).toHaveBeenCalledOnce();
    const payload: TriageSchemaValidationResult = res.json.mock.calls[0][0];
    expect(payload.passed).toBe(true);
    expect(payload.score).toBe(1.0);
  });

  it("accepts { body: <fenced string> } and validates correctly", () => {
    const req = makeReq({ body: VALID_FENCED });
    const res = makeRes();
    handler(req, res);
    const payload: TriageSchemaValidationResult = res.json.mock.calls[0][0];
    expect(payload.passed).toBe(true);
  });

  it("returns passed:false with field_errors for incomplete schema", () => {
    const req = makeReq({ duplicates_checked: true }); // missing 3 fields
    const res = makeRes();
    handler(req, res);
    const payload: TriageSchemaValidationResult = res.json.mock.calls[0][0];
    expect(payload.passed).toBe(false);
    expect(payload.missing_fields.length).toBeGreaterThan(0);
    expect(payload.field_errors.length).toBeGreaterThan(0);
  });

  it("returns 400 when body is null", () => {
    const req = makeReq(null);
    const res = makeRes();
    handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    const errPayload = res.json.mock.calls[0][0];
    expect(errPayload).toHaveProperty("error");
  });

  it("always includes schema_template in the response", () => {
    const req = makeReq(VALID_SCHEMA);
    const res = makeRes();
    handler(req, res);
    const payload: TriageSchemaValidationResult = res.json.mock.calls[0][0];
    expect(payload.schema_template).toBe(TRIAGE_OUTPUT_SCHEMA);
  });

  it("accepts { body: <bare JSON string> } and validates", () => {
    const req = makeReq({ body: VALID_JSON });
    const res = makeRes();
    handler(req, res);
    const payload: TriageSchemaValidationResult = res.json.mock.calls[0][0];
    expect(payload.passed).toBe(true);
  });

  it("treats entire body as schema when no 'body' string field present", () => {
    // Send the schema fields directly (Express json() parsed the body)
    const req = makeReq({ ...VALID_SCHEMA });
    const res = makeRes();
    handler(req, res);
    const payload: TriageSchemaValidationResult = res.json.mock.calls[0][0];
    expect(payload.passed).toBe(true);
  });
});
