import { describe, expect, it } from "vitest";
import {
  RESEARCH_FINDING_SCHEMA,
  RESEARCH_FINDING_SECTION_HEADINGS,
  checkResearchFindingCompliance,
  checkHousekeepingSchemaCompliance,
  checkCrossRepoTriageSchemaCompliance,
  TRIAGE_HOUSEKEEPING_SCHEMA,
  TRIAGE_CROSS_REPO_SCHEMA,
} from "./verifier.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FULL_VALID_FINDING = `
# Immunefi Bug Bounty Submission — Research Finding

## Problem Statement

The fleet needs zero-operator-action revenue paths that pay in crypto.

## Key Findings

1. Immunefi's landing page is publicly accessible.
2. No REST API was found.

## Verified External Dependencies

| Claim | Verification evidence | Status |
|-------|----------------------|--------|
| Payout currency: USDC | https://immunefi.com/bug-bounty/ethena/information/ | ✓ verified |
| API at api.immunefi.com | (no evidence located) | ⚠ unverified |

## Unverified Claims (Load-Bearing Risks)

- **API existence**: Would break all programmatic submission work.

## Implementation Recommendations

1. Probe api.immunefi.com before building any adapter.
2. Fallback to direct-GitHub-PR approach.

## Open Questions

- Is there a non-public API for registered accounts?

## References

- [Immunefi Sky](https://immunefi.com/bug-bounty/sky/information/)
`;

const MISSING_VERIFIED_DEPS = `
# Some Research Finding

## Problem Statement

Research question.

## Key Findings

1. Finding one.

## Unverified Claims (Load-Bearing Risks)

None.

## Implementation Recommendations

1. Do something.
`;

const MISSING_UNVERIFIED_CLAIMS = `
# Some Research Finding

## Problem Statement

Research question.

## Key Findings

1. Finding one.

## Verified External Dependencies

| Claim | Verification evidence | Status |
|-------|----------------------|--------|
| Something | https://example.com | ✓ verified |

## Implementation Recommendations

1. Do something.
`;

const MISSING_ALL_SECTIONS = `
# Empty Finding

Just some notes without structure.
`;

// ── RESEARCH_FINDING_SCHEMA constants ────────────────────────────────────────

describe("RESEARCH_FINDING_SCHEMA", () => {
  it("has exactly 5 required sections", () => {
    expect(RESEARCH_FINDING_SCHEMA.required_sections).toHaveLength(5);
  });

  it("includes verified_external_dependencies and unverified_claims as required sections", () => {
    expect(RESEARCH_FINDING_SCHEMA.required_sections).toContain("verified_external_dependencies");
    expect(RESEARCH_FINDING_SCHEMA.required_sections).toContain("unverified_claims");
  });

  it("marks verified_external_dependencies and unverified_claims as hard_required", () => {
    expect(RESEARCH_FINDING_SCHEMA.hard_required).toContain("verified_external_dependencies");
    expect(RESEARCH_FINDING_SCHEMA.hard_required).toContain("unverified_claims");
  });

  it("uses 0.20 weight per section (5 × 0.20 = 1.0)", () => {
    expect(RESEARCH_FINDING_SCHEMA.section_weight).toBe(0.20);
    expect(RESEARCH_FINDING_SCHEMA.required_sections.length * RESEARCH_FINDING_SCHEMA.section_weight).toBe(1.0);
  });

  it("has section_descriptions for all required sections", () => {
    for (const section of RESEARCH_FINDING_SCHEMA.required_sections) {
      expect(RESEARCH_FINDING_SCHEMA.section_descriptions).toHaveProperty(section);
    }
  });
});

describe("RESEARCH_FINDING_SECTION_HEADINGS", () => {
  it("has a heading entry for each required section", () => {
    for (const section of RESEARCH_FINDING_SCHEMA.required_sections) {
      expect(RESEARCH_FINDING_SECTION_HEADINGS).toHaveProperty(section);
    }
  });

  it("all headings start with '## '", () => {
    for (const heading of Object.values(RESEARCH_FINDING_SECTION_HEADINGS)) {
      expect(heading).toMatch(/^## /);
    }
  });
});

// ── checkResearchFindingCompliance ───────────────────────────────────────────

describe("checkResearchFindingCompliance", () => {
  describe("with a fully valid finding", () => {
    it("returns valid: true", () => {
      const result = checkResearchFindingCompliance(FULL_VALID_FINDING);
      expect(result.valid).toBe(true);
    });

    it("returns score 1.0", () => {
      const result = checkResearchFindingCompliance(FULL_VALID_FINDING);
      expect(result.score).toBe(1.0);
    });

    it("returns no missing sections", () => {
      const result = checkResearchFindingCompliance(FULL_VALID_FINDING);
      expect(result.missingSections).toHaveLength(0);
    });

    it("returns hardRequiredMissing: false", () => {
      const result = checkResearchFindingCompliance(FULL_VALID_FINDING);
      expect(result.hardRequiredMissing).toBe(false);
    });

    it("returns no error message", () => {
      const result = checkResearchFindingCompliance(FULL_VALID_FINDING);
      expect(result.error).toBeUndefined();
    });
  });

  describe("with verified_external_dependencies section missing", () => {
    it("returns valid: false", () => {
      const result = checkResearchFindingCompliance(MISSING_VERIFIED_DEPS);
      expect(result.valid).toBe(false);
    });

    it("flags verified_external_dependencies in missingSections", () => {
      const result = checkResearchFindingCompliance(MISSING_VERIFIED_DEPS);
      expect(result.missingSections).toContain("verified_external_dependencies");
    });

    it("sets hardRequiredMissing: true", () => {
      const result = checkResearchFindingCompliance(MISSING_VERIFIED_DEPS);
      expect(result.hardRequiredMissing).toBe(true);
    });

    it("includes HARD-REQUIRED label in error message", () => {
      const result = checkResearchFindingCompliance(MISSING_VERIFIED_DEPS);
      expect(result.error).toContain("HARD-REQUIRED");
    });

    it("returns score reduced by one section weight (0.80)", () => {
      const result = checkResearchFindingCompliance(MISSING_VERIFIED_DEPS);
      expect(result.score).toBeCloseTo(0.80);
    });
  });

  describe("with unverified_claims section missing", () => {
    it("returns valid: false", () => {
      const result = checkResearchFindingCompliance(MISSING_UNVERIFIED_CLAIMS);
      expect(result.valid).toBe(false);
    });

    it("flags unverified_claims in missingSections", () => {
      const result = checkResearchFindingCompliance(MISSING_UNVERIFIED_CLAIMS);
      expect(result.missingSections).toContain("unverified_claims");
    });

    it("sets hardRequiredMissing: true", () => {
      const result = checkResearchFindingCompliance(MISSING_UNVERIFIED_CLAIMS);
      expect(result.hardRequiredMissing).toBe(true);
    });
  });

  describe("with all sections missing", () => {
    it("returns valid: false", () => {
      const result = checkResearchFindingCompliance(MISSING_ALL_SECTIONS);
      expect(result.valid).toBe(false);
    });

    it("returns all 5 sections as missing", () => {
      const result = checkResearchFindingCompliance(MISSING_ALL_SECTIONS);
      expect(result.missingSections).toHaveLength(5);
    });

    it("returns score 0.0 (clamped)", () => {
      const result = checkResearchFindingCompliance(MISSING_ALL_SECTIONS);
      expect(result.score).toBe(0.0);
    });

    it("sets hardRequiredMissing: true", () => {
      const result = checkResearchFindingCompliance(MISSING_ALL_SECTIONS);
      expect(result.hardRequiredMissing).toBe(true);
    });
  });

  describe("score arithmetic", () => {
    it("reduces score by 0.20 per missing section", () => {
      // MISSING_VERIFIED_DEPS is missing 1 section (problem_statement present, key_findings present,
      // verified_external_dependencies missing, unverified_claims present, implementation_recommendations present)
      // Actually let's count more carefully from MISSING_VERIFIED_DEPS fixture:
      // Has: Problem Statement, Key Findings, Unverified Claims, Implementation Recommendations
      // Missing: Verified External Dependencies
      // So 1 missing → score should be 0.80
      const result = checkResearchFindingCompliance(MISSING_VERIFIED_DEPS);
      expect(result.score).toBeCloseTo(1.0 - result.missingSections.length * 0.20);
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      const result = checkResearchFindingCompliance("");
      expect(result.valid).toBe(false);
      expect(result.missingSections).toHaveLength(5);
    });

    it("treats a heading with a trailing suffix as a match (substring check)", () => {
      // A heading like "## Verified External Dependencies (updated)" still contains
      // the required heading as a substring, so the section is detected as present.
      const mdWithSuffix = FULL_VALID_FINDING.replace(
        "## Verified External Dependencies",
        "## Verified External Dependencies (updated 2026-05-11)",
      );
      const result = checkResearchFindingCompliance(mdWithSuffix);
      // Substring match: the section IS found even with a suffix
      expect(result.missingSections).not.toContain("verified_external_dependencies");
    });
  });
});

// ── Existing triage schema compliance (regression guard) ─────────────────────

describe("checkHousekeepingSchemaCompliance (regression)", () => {
  it("accepts a valid housekeeping schema object", () => {
    const valid = {
      duplicates_checked: true,
      stale_issues: [],
      priority_reordering: [],
      outcome_summary: "All good.",
    };
    expect(checkHousekeepingSchemaCompliance(valid).valid).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(checkHousekeepingSchemaCompliance("not an object")).toEqual(
      expect.objectContaining({ valid: false }),
    );
  });

  it("reports missing fields", () => {
    const partial = { duplicates_checked: true };
    const result = checkHousekeepingSchemaCompliance(partial);
    expect(result.valid).toBe(false);
    expect(result.missingFields).toEqual(
      expect.arrayContaining(["stale_issues", "priority_reordering", "outcome_summary"]),
    );
  });
});

describe("checkCrossRepoTriageSchemaCompliance (regression)", () => {
  it("accepts a valid cross-repo triage schema object", () => {
    const valid = {
      source_repo: "rapartlu/agent-orchestrator",
      target_repo: "rapartlu/agent-reviewer",
      issues_reviewed: 12,
      routing_corrections: [],
      outcome_summary: "No corrections needed.",
    };
    expect(checkCrossRepoTriageSchemaCompliance(valid).valid).toBe(true);
  });

  it("rejects an array", () => {
    expect(checkCrossRepoTriageSchemaCompliance([])).toEqual(
      expect.objectContaining({ valid: false }),
    );
  });
});

// ── Schema constant exports (ensure they're exported correctly) ──────────────

describe("schema exports", () => {
  it("TRIAGE_HOUSEKEEPING_SCHEMA has 4 required_fields", () => {
    expect(TRIAGE_HOUSEKEEPING_SCHEMA.required_fields).toHaveLength(4);
  });

  it("TRIAGE_CROSS_REPO_SCHEMA has 5 required_fields", () => {
    expect(TRIAGE_CROSS_REPO_SCHEMA.required_fields).toHaveLength(5);
  });

  it("RESEARCH_FINDING_SCHEMA has 5 required_sections", () => {
    expect(RESEARCH_FINDING_SCHEMA.required_sections).toHaveLength(5);
  });
});
