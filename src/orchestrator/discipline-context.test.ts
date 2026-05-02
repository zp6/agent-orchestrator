import { describe, expect, it } from "vitest";
import {
  assessTaskDisciplineAlignment,
  captureDisciplineContext,
  detectDisciplineConflict,
  formatDisciplineRefreshBlock,
} from "./discipline-context.js";

describe("discipline-context", () => {
  it("detects known discipline anti-patterns", () => {
    const result = detectDisciplineConflict("Please stage a Substack draft, ask the operator to sign up for Stripe Connect, and keep the paid tier ready.");
    expect(result.aligned).toBe(false);
    expect(result.requires_rescope).toBe(true);
    expect(result.matched_patterns).toEqual(expect.arrayContaining(["Substack", "Sponsors signup", "Stripe Connect"]));
  });

  it("forces stale dispatches back through re-evaluation even when no anti-pattern is mentioned", () => {
    const current = captureDisciplineContext(process.cwd());
    const prior = {
      ...current,
      captured_at: "2026-04-29T00:00:00.000Z",
      docs: current.docs.map((doc) => ({
        ...doc,
        sha256: doc.sha256 ? `${doc.sha256}-old` : doc.sha256,
      })),
    };

    const alignment = assessTaskDisciplineAlignment(
      { title: "Build a feature", description: null, result: null, source_ref: null },
      current,
      prior,
    );

    expect(alignment.aligned).toBe(false);
    expect(alignment.stale_snapshot).toBe(true);
    expect(alignment.requires_rescope).toBe(true);
    expect(alignment.reason).toContain("re-evaluated");

    const refresh = formatDisciplineRefreshBlock(current, "Build a feature");
    expect(refresh).toContain("re-read the current `CLAUDE.md` and `CHARTER.md`");
    expect(prior.docs[0]?.sha256).not.toBe(current.docs[0]?.sha256);
  });

  it("builds a refresh block from the current docs snapshot", () => {
    const snapshot = captureDisciplineContext(process.cwd());
    const block = formatDisciplineRefreshBlock(snapshot, "Build a feature");
    expect(block).toContain("Discipline refresh");
    expect(block).toContain("CLAUDE.md");
    expect(block).toContain("CHARTER.md");
  });
});
