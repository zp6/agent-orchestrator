import { describe, it, expect, vi } from "vitest";
import { extractClosedIssueNumbers, shouldVerifyTask, buildHousekeepingMessage, needsRoadmapBootstrap, buildRoadmapBootstrapMessage } from "./daemon.js";

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

describe("buildHousekeepingMessage", () => {
  const agentName = "my-agent";
  const githubRepo = "owner/my-agent";

  it("includes the github repo in the message", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg).toContain(githubRepo);
  });

  it("instructs closing duplicate issues", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg.toLowerCase()).toContain("duplicate");
  });

  it("instructs closing stale issues", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg.toLowerCase()).toContain("stale");
  });

  it("instructs maintaining ROADMAP.md", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg).toContain("ROADMAP.md");
  });

  it("instructs checking for orphan PRs", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg.toLowerCase()).toContain("orphan");
  });

  it("includes gh issue list command referencing the repo", () => {
    const msg = buildHousekeepingMessage(agentName, githubRepo);
    expect(msg).toContain(`gh issue list --repo ${githubRepo}`);
  });

  it("produces different messages for different agents", () => {
    const msg1 = buildHousekeepingMessage("agent-a", "org/agent-a");
    const msg2 = buildHousekeepingMessage("agent-b", "org/agent-b");
    expect(msg1).not.toEqual(msg2);
    expect(msg1).toContain("org/agent-a");
    expect(msg2).toContain("org/agent-b");
  });
});

describe("needsRoadmapBootstrap", () => {
  /**
   * needsRoadmapBootstrap shells out to `gh api` and interprets exit codes.
   * We verify the logic by testing the two observable branches directly via
   * a thin wrapper that accepts a custom exec function, exercised through the
   * exported function's behaviour when the underlying execSync would succeed
   * or throw.
   *
   * Because ESM module namespaces are not configurable (vi.spyOn on
   * node:child_process is not supported in Vitest ESM mode), we instead test
   * the function's behaviour by using its own exported interface: the exported
   * function accepts an optional `execFn` dependency-injection parameter so
   * unit tests can supply a fake without patching globals.
   */

  it("returns false when execFn succeeds (ROADMAP.md exists)", () => {
    const execFn = vi.fn().mockReturnValue("");
    expect(needsRoadmapBootstrap("owner/repo", execFn)).toBe(false);
  });

  it("returns true when execFn throws (ROADMAP.md absent / 404)", () => {
    const execFn = vi.fn().mockImplementation(() => {
      throw new Error("Command failed with exit code 1");
    });
    expect(needsRoadmapBootstrap("owner/repo", execFn)).toBe(true);
  });

  it("returns true on network errors (safe fallback)", () => {
    const execFn = vi.fn().mockImplementation(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(needsRoadmapBootstrap("owner/repo", execFn)).toBe(true);
  });

  it("calls gh api with the correct repo path", () => {
    const execFn = vi.fn().mockReturnValue("");
    needsRoadmapBootstrap("myorg/my-repo", execFn);
    expect(execFn).toHaveBeenCalledOnce();
    const cmd = execFn.mock.calls[0][0] as string;
    expect(cmd).toContain("gh api repos/myorg/my-repo/contents/ROADMAP.md");
  });
});

describe("buildRoadmapBootstrapMessage", () => {
  const agentName = "my-agent";
  const githubRepo = "owner/my-agent";

  it("includes the github repo in the message", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg).toContain(githubRepo);
  });

  it("instructs creating ROADMAP.md", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg).toContain("ROADMAP.md");
  });

  it("instructs opening a PR", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg.toLowerCase()).toContain("pr");
  });

  it("instructs surveying open issues", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg).toContain(`gh issue list --repo ${githubRepo}`);
  });

  it("instructs reviewing recent merged PRs", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg).toContain(`gh pr list --repo ${githubRepo}`);
  });

  it("asks for top 5 priorities sorted by user impact", () => {
    const msg = buildRoadmapBootstrapMessage(agentName, githubRepo);
    expect(msg.toLowerCase()).toContain("top 5");
    expect(msg.toLowerCase()).toContain("user impact");
  });

  it("produces different messages for different agents", () => {
    const msg1 = buildRoadmapBootstrapMessage("agent-a", "org/agent-a");
    const msg2 = buildRoadmapBootstrapMessage("agent-b", "org/agent-b");
    expect(msg1).not.toEqual(msg2);
    expect(msg1).toContain("org/agent-a");
    expect(msg2).toContain("org/agent-b");
  });

  it("is distinct from the housekeeping maintenance message", () => {
    const bootstrap = buildRoadmapBootstrapMessage(agentName, githubRepo);
    const housekeeping = buildHousekeepingMessage(agentName, githubRepo);
    expect(bootstrap).not.toEqual(housekeeping);
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
