import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  looksLikeStandupTask,
  extractStandupIssueNumber,
  shouldSkipStandupDispatch,
} from "./standup-dispatch-guard.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    promisify: (fn: unknown) => fn, // execFileAsync = execFile (already mocked)
  };
});

vi.mock("../service/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile) as unknown as ReturnType<typeof vi.fn>;

function mockGhIssue(data: Record<string, unknown>): void {
  mockExecFile.mockResolvedValue({ stdout: JSON.stringify(data), stderr: "" });
}

describe("looksLikeStandupTask", () => {
  it("matches standup titles and source refs", () => {
    expect(looksLikeStandupTask("[📋 Standup] Daily update", null)).toBe(true);
    expect(looksLikeStandupTask("Blue sky follow-up", "standup:123")).toBe(true);
    expect(looksLikeStandupTask("Routine task", "owner/repo#123")).toBe(false);
  });
});

describe("extractStandupIssueNumber", () => {
  it("extracts numbers from supported source ref formats", () => {
    expect(extractStandupIssueNumber("standup:703")).toBe(703);
    expect(extractStandupIssueNumber("github-issue:owner/repo#703")).toBe(703);
    expect(extractStandupIssueNumber("#703")).toBe(703);
    expect(extractStandupIssueNumber("owner/repo#703")).toBe(703);
    expect(extractStandupIssueNumber("linear:ENG-123")).toBeNull();
  });
});

describe("shouldSkipStandupDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips zero-action standups", async () => {
    mockGhIssue({
      number: 703,
      title: "[📋 Standup] Daily update",
      body: "### Action Items\nNo action items\n### Synthesis\nAll clear",
      labels: [{ name: "standup" }],
      state: "open",
    });

    const decision = await shouldSkipStandupDispatch("owner/repo", 703);

    expect(decision.skip).toBe(true);
    expect(decision.actionItemCount).toBe(0);
    expect(decision.reason).toContain("auto-handled");
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["issue", "view", "703", "--repo", "owner/repo", "--json", "number,title,body,labels,state"],
      expect.objectContaining({ encoding: "utf-8", timeout: 15000 }),
    );
  });

  it("dispatches normally when action items exist", async () => {
    mockGhIssue({
      number: 704,
      title: "[📋 Standup] Daily update",
      body: "### Action Items\n- [ ] Fix bug\n- [ ] Update docs",
      labels: [{ name: "standup" }],
      state: "open",
    });

    const decision = await shouldSkipStandupDispatch("owner/repo", 704);

    expect(decision.skip).toBe(false);
    expect(decision.actionItemCount).toBe(2);
    expect(decision.reason).toContain("dispatching to agent");
  });

  it("matches plain list items and asterisk lists", async () => {
    mockGhIssue({
      number: 705,
      title: "[📋 Standup] Daily update",
      body: "### Action Items\n- Fix the bug\n* Deploy the change\n### Synthesis\nDone",
      labels: [{ name: "standup" }],
      state: "open",
    });

    const decision = await shouldSkipStandupDispatch("owner/repo", 705);

    expect(decision.skip).toBe(false);
    expect(decision.actionItemCount).toBe(2);
  });

  it("falls through on fetch error", async () => {
    mockExecFile.mockRejectedValue(new Error("gh not found"));

    const decision = await shouldSkipStandupDispatch("owner/repo", 706);

    expect(decision.skip).toBe(false);
    expect(decision.reason).toContain("Could not fetch");
  });
});
