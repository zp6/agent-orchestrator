import { describe, it, expect } from "vitest";
import {
  findBestReferenceImplementation,
  buildReferenceImplementationBlock,
} from "./reference-implementation.js";

// Minimal fake store factory
function makeStore(tasks: Array<{
  id: string;
  source_ref: string | null;
  status: string;
  quality_score: number | null;
  result: string | null;
}>) {
  return {
    getLineageGroup: (_groupId: string) => tasks,
  };
}

describe("findBestReferenceImplementation", () => {
  it("returns null when task has no lineage_group_id", () => {
    const store = makeStore([]);
    const result = findBestReferenceImplementation(store, { lineage_group_id: null, source_ref: "owner/repo#1" }, "owner/repo");
    expect(result).toBeNull();
  });

  it("returns null when no peer tasks meet quality threshold", () => {
    const store = makeStore([
      { id: "t1", source_ref: "owner/agent-dashboard#172", status: "done", quality_score: 0.65, result: "done" },
    ]);
    const result = findBestReferenceImplementation(
      store,
      { lineage_group_id: "group-1", source_ref: "owner/agent-proxy#404" },
      "owner/agent-proxy",
    );
    expect(result).toBeNull();
  });

  it("returns null when the only high-quality task is for the same target repo", () => {
    const store = makeStore([
      { id: "t1", source_ref: "owner/agent-proxy#172", status: "done", quality_score: 0.88, result: "https://github.com/owner/agent-proxy/pull/55" },
    ]);
    const result = findBestReferenceImplementation(
      store,
      { lineage_group_id: "group-1", source_ref: "owner/agent-proxy#404" },
      "owner/agent-proxy",
    );
    expect(result).toBeNull();
  });

  it("picks the highest-quality peer task", () => {
    const store = makeStore([
      { id: "t1", source_ref: "owner/agent-dashboard#172", status: "done", quality_score: 0.88, result: "https://github.com/owner/agent-dashboard/pull/99" },
      { id: "t2", source_ref: "owner/agent-proxy#404", status: "done", quality_score: 0.72, result: "https://github.com/owner/agent-proxy/pull/55" },
    ]);
    const result = findBestReferenceImplementation(
      store,
      { lineage_group_id: "group-1", source_ref: "owner/agent-reviewer#124" },
      "owner/agent-reviewer",
    );
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe("t1");
    expect(result!.qualityScore).toBe(0.88);
    expect(result!.prRef).toBe("https://github.com/owner/agent-dashboard/pull/99");
  });

  it("skips non-done tasks", () => {
    const store = makeStore([
      { id: "t1", source_ref: "owner/agent-dashboard#172", status: "failed", quality_score: 0.88, result: "https://github.com/owner/agent-dashboard/pull/99" },
    ]);
    const result = findBestReferenceImplementation(
      store,
      { lineage_group_id: "group-1", source_ref: "owner/agent-reviewer#124" },
      "owner/agent-reviewer",
    );
    expect(result).toBeNull();
  });

  it("skips tasks with the same source_ref as the dispatched task", () => {
    const store = makeStore([
      { id: "t1", source_ref: "owner/agent-reviewer#124", status: "done", quality_score: 0.88, result: "PR #88" },
    ]);
    const result = findBestReferenceImplementation(
      store,
      { lineage_group_id: "group-1", source_ref: "owner/agent-reviewer#124" },
      "owner/agent-reviewer",
    );
    expect(result).toBeNull();
  });

  it("extracts PR ref from shorthand format", () => {
    const store = makeStore([
      { id: "t1", source_ref: "owner/agent-dashboard#172", status: "done", quality_score: 0.80, result: "Closed via owner/agent-dashboard#55 — merged successfully." },
    ]);
    const result = findBestReferenceImplementation(
      store,
      { lineage_group_id: "group-1", source_ref: "owner/agent-proxy#404" },
      "owner/agent-proxy",
    );
    expect(result).not.toBeNull();
    expect(result!.prRef).toBe("owner/agent-dashboard#55");
  });
});

describe("buildReferenceImplementationBlock", () => {
  it("returns empty string for null ref", () => {
    expect(buildReferenceImplementationBlock(null)).toBe("");
  });

  it("includes source ref and PR ref in output", () => {
    const block = buildReferenceImplementationBlock({
      taskId: "task-abc",
      sourceRef: "owner/agent-dashboard#172",
      qualityScore: 0.88,
      prRef: "https://github.com/owner/agent-dashboard/pull/99",
      resultExcerpt: "Implemented unified secrets health aggregate view.",
    });
    expect(block).toContain("Reference Implementation");
    expect(block).toContain("owner/agent-dashboard#172");
    expect(block).toContain("https://github.com/owner/agent-dashboard/pull/99");
    expect(block).toContain("0.88");
    expect(block).toContain("Implemented unified secrets health aggregate view.");
  });

  it("omits PR ref line when prRef is null", () => {
    const block = buildReferenceImplementationBlock({
      taskId: "task-abc",
      sourceRef: "owner/agent-dashboard#172",
      qualityScore: 0.80,
      prRef: null,
      resultExcerpt: "Done.",
    });
    expect(block).not.toContain("Reference PR");
    expect(block).toContain("owner/agent-dashboard#172");
  });
});
