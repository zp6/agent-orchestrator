import { describe, expect, it } from "vitest";
import {
  checkScopeContract,
  extractScopeContractConstraints,
  formatScopeContractViolationComment,
} from "../reviewer/scope-contract.js";
import { normalizeAllowedBaseBranches } from "../reviewer/pr-reviewer.js";

function makeDiff(files: Array<{ path: string; lines?: number }>): string {
  return files
    .map(({ path, lines = 1 }) => {
      const body = Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join("\n");
      return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${body}\n`;
    })
    .join("\n");
}

describe("extractScopeContractConstraints", () => {
  it("parses exact file, max line, and forbidden-path constraints", () => {
    const constraints = extractScopeContractConstraints(
      "Exactly 1 file, max 200 lines, do NOT touch triggers/verifier/agents.yaml.",
    );

    expect(constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "exact-file-count", value: 1 }),
        expect.objectContaining({ kind: "max-lines", value: 200 }),
        expect.objectContaining({
          kind: "forbidden-paths",
          paths: expect.arrayContaining(["triggers/verifier/agents.yaml"]),
        }),
      ]),
    );
  });
});

describe("checkScopeContract", () => {
  it("returns clean when the diff respects the prompt constraints", () => {
    const result = checkScopeContract(
      "Exactly 1 file, max 200 lines, do not touch triggers/verifier/agents.yaml.",
      makeDiff([{ path: "src/reviewer/scope-contract.ts", lines: 40 }]),
    );

    expect(result.violation).toBe(false);
    expect(result.changed_files).toEqual(["src/reviewer/scope-contract.ts"]);
    expect(result.changed_lines).toBe(40);
  });

  it("blocks a diff that exceeds the exact file count", () => {
    const result = checkScopeContract(
      "Exactly 1 file.",
      makeDiff([
        { path: "src/reviewer/scope-contract.ts", lines: 5 },
        { path: "src/index.ts", lines: 5 },
      ]),
    );

    expect(result.violation).toBe(true);
    expect(result.violation_type).toBe("file-count");
    expect(result.reason).toContain("Expected exactly 1 file");
  });

  it("blocks a diff that exceeds the max line count", () => {
    const result = checkScopeContract(
      "Max 5 lines.",
      makeDiff([{ path: "src/reviewer/scope-contract.ts", lines: 6 }]),
    );

    expect(result.violation).toBe(true);
    expect(result.violation_type).toBe("line-count");
    expect(result.reason).toContain("no more than 5 changed lines");
  });

  it("blocks a diff that touches a forbidden path", () => {
    const result = checkScopeContract(
      "Do NOT touch triggers/verifier/agents.yaml.",
      makeDiff([{ path: "triggers/verifier/agents.yaml", lines: 3 }]),
    );

    expect(result.violation).toBe(true);
    expect(result.violation_type).toBe("forbidden-paths");
    expect(result.reason).toContain("forbidden path");
  });

  it("formats a review comment with the observed scope", () => {
    const result = checkScopeContract(
      "Exactly 1 file.",
      makeDiff([
        { path: "src/reviewer/scope-contract.ts", lines: 5 },
        { path: "src/index.ts", lines: 5 },
      ]),
    );

    const comment = formatScopeContractViolationComment(result, {
      prNumber: 1251,
      title: "Implement hard scope checks",
    });

    expect(comment).toContain("PR #1251");
    expect(comment).toContain("Scope contract violated");
    expect(comment).toContain("Observed: 2 file(s)");
  });
});

describe("normalizeAllowedBaseBranches", () => {
  it("defaults to main when the allowlist is absent or empty", () => {
    expect(normalizeAllowedBaseBranches()).toEqual(["main"]);
    expect(normalizeAllowedBaseBranches([])).toEqual(["main"]);
  });

  it("trims and deduplicates configured branches", () => {
    expect(normalizeAllowedBaseBranches([" main ", "release/1.0", "main"])).toEqual([
      "main",
      "release/1.0",
    ]);
  });
});
