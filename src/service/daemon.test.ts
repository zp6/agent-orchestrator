import { describe, it, expect } from "vitest";
import { extractClosedIssueNumbers, shouldVerifyTask } from "./daemon.js";

describe("extractClosedIssueNumbers", () => {
  it("extracts Closes #N", () => {
    expect(extractClosedIssueNumbers("Closes #42")).toEqual([42]);
  });

  it("extracts Fixes #N", () => {
    expect(extractClosedIssueNumbers("Fixes #7")).toEqual([7]);
  });

  it("extracts Resolves #N", () => {
    expect(extractClosedIssueNumbers("Resolves #100")).toEqual([100]);
  });

  it("is case-insensitive", () => {
    expect(extractClosedIssueNumbers("closes #1\nFIXES #2\nResolves #3")).toEqual([1, 2, 3]);
  });

  it("extracts multiple refs from one body", () => {
    expect(extractClosedIssueNumbers("Closes #10\nAlso fixes #20")).toEqual([10, 20]);
  });

  it("deduplicates", () => {
    expect(extractClosedIssueNumbers("Closes #5\nAlso closes #5")).toEqual([5]);
  });

  it("returns empty array when no refs", () => {
    expect(extractClosedIssueNumbers("No issue references here")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractClosedIssueNumbers("")).toEqual([]);
  });

  it("handles refs inline with other text", () => {
    expect(extractClosedIssueNumbers("This PR closes #42 and fixes #43.")).toEqual([42, 43]);
  });
});

describe("shouldVerifyTask", () => {
  describe("no filter configured", () => {
    it("verifies github tasks when filter is absent", () => {
      expect(shouldVerifyTask("github")).toBe(true);
    });

    it("verifies manual tasks when filter is absent", () => {
      expect(shouldVerifyTask("manual")).toBe(true);
    });

    it("verifies linear tasks when filter is absent", () => {
      expect(shouldVerifyTask("linear")).toBe(true);
    });

    it("verifies any source when filter is undefined", () => {
      expect(shouldVerifyTask("slack", undefined)).toBe(true);
    });

    it("verifies any source when filter is empty array", () => {
      expect(shouldVerifyTask("slack", [])).toBe(true);
    });
  });

  describe("sources allowlist configured", () => {
    const filter = ["github", "linear"];

    it("verifies github tasks (in allowlist)", () => {
      expect(shouldVerifyTask("github", filter)).toBe(true);
    });

    it("verifies linear tasks (in allowlist)", () => {
      expect(shouldVerifyTask("linear", filter)).toBe(true);
    });

    it("always verifies manual tasks even when not in allowlist", () => {
      expect(shouldVerifyTask("manual", filter)).toBe(true);
    });

    it("skips slack tasks (not in allowlist, not manual)", () => {
      expect(shouldVerifyTask("slack", filter)).toBe(false);
    });

    it("skips unknown source (not in allowlist, not manual)", () => {
      expect(shouldVerifyTask("webhook", filter)).toBe(false);
    });
  });

  describe("manual-only allowlist edge case", () => {
    it("verifies manual tasks when filter is [manual]", () => {
      expect(shouldVerifyTask("manual", ["manual"])).toBe(true);
    });

    it("skips github when filter is [manual] only", () => {
      expect(shouldVerifyTask("github", ["manual"])).toBe(false);
    });
  });
});
