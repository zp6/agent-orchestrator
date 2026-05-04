import { describe, it, expect } from "vitest";
import { detectScopeDecline } from "./scope-decline-detector.js";

describe("detectScopeDecline", () => {
  describe("positive cases (should detect decline)", () => {
    it("detects 'out of scope' declarations", () => {
      const result = detectScopeDecline(
        "After reviewing the issue, this is out of scope for the orchestrator-reviewer package. The work belongs in the runtime repo.",
      );
      expect(result.declined).toBe(true);
      expect(result.signal).toBe("out-of-scope-declaration");
    });

    it("detects 'not in scope' declarations", () => {
      const result = detectScopeDecline(
        "I cannot pick this up — the task is not in scope for this agent's mandate per CLAUDE.md.",
      );
      expect(result.declined).toBe(true);
    });

    it("detects 'outside my scope' declarations", () => {
      const result = detectScopeDecline(
        "This is outside my scope as a review-only agent. Please reroute to an implementation agent.",
      );
      expect(result.declined).toBe(true);
      expect(result.signal).toBe("out-of-scope-declaration");
    });

    it("detects explicit decline verb at start of paragraph", () => {
      const result = detectScopeDecline(
        "Declining: this task involves browser automation which is not part of the orchestrator package's responsibilities.",
      );
      expect(result.declined).toBe(true);
      expect(result.signal).toBe("explicit-decline-verb");
    });

    it("detects 'I am declining' phrasing", () => {
      const result = detectScopeDecline(
        "After review, I am declining this dispatch. Browser automation belongs in fleet-runtime.",
      );
      expect(result.declined).toBe(true);
    });

    it("detects CLAUDE.md scope citation", () => {
      const result = detectScopeDecline(
        "Per the 'out of scope' section of CLAUDE.md, this repo does not own browser automation. Please re-home this issue.",
      );
      expect(result.declined).toBe(true);
      expect(result.signal).toBe("claude-md-scope-citation");
    });

    it("detects 'belongs in <other repo>' phrasing", () => {
      const result = detectScopeDecline(
        "Looking at the scope, this work belongs in the runtime repository, not the orchestrator-reviewer package.",
      );
      expect(result.declined).toBe(true);
      expect(result.signal).toBe("belongs-in-other-repo");
    });

    it("detects 'belongs in dashboard repo' phrasing", () => {
      const result = detectScopeDecline(
        "The frontend changes here belong in the dashboard package — this repo only owns reviewer logic.",
      );
      expect(result.declined).toBe(true);
    });

    it("detects 'not for this agent' phrasing", () => {
      const result = detectScopeDecline(
        "This task is not for this agent — please dispatch to the runtime owner instead.",
      );
      expect(result.declined).toBe(true);
      expect(result.signal).toBe("not-for-this-agent");
    });

    it("detects 'wrong agent' / 'wrong repo' claims", () => {
      const result = detectScopeDecline(
        "I think this is the wrong repo for this work. The browser-automation runtime is sibling to fleet-signer and lives elsewhere.",
      );
      expect(result.declined).toBe(true);
      expect(result.signal).toBe("wrong-routing-claim");
    });

    it("returns the first matching signal label when multiple patterns hit", () => {
      const result = detectScopeDecline(
        "This is out of scope. Declining: please reroute to the correct agent.",
      );
      expect(result.declined).toBe(true);
      // First high-confidence pattern wins
      expect(result.signal).toBe("out-of-scope-declaration");
    });
  });

  describe("negative cases (should NOT detect decline)", () => {
    it("does not flag 'scope creep' as a decline", () => {
      const result = detectScopeDecline(
        "I noticed some scope creep in the original ticket but I've narrowed it down. PR is open.",
      );
      expect(result.declined).toBe(false);
    });

    it("does not flag 'in scope of this PR' as a decline", () => {
      const result = detectScopeDecline(
        "The change is in scope of this PR. I added tests for the idempotency contract.",
      );
      expect(result.declined).toBe(false);
    });

    it("does not flag 'scope of work' as a decline", () => {
      const result = detectScopeDecline(
        "The scope of work for the next sprint includes the bounty matcher and the lead scanner.",
      );
      expect(result.declined).toBe(false);
    });

    it("does not flag 'project scope' as a decline", () => {
      const result = detectScopeDecline(
        "Within the project scope I implemented the migration and wrote unit tests.",
      );
      expect(result.declined).toBe(false);
    });

    it("does not flag a successful task completion", () => {
      const result = detectScopeDecline(
        "PR #1180 is open. Done. Summary of what was shipped: orch standup-quality backfill (closes #1177).",
      );
      expect(result.declined).toBe(false);
    });

    it("does not flag empty or null input", () => {
      expect(detectScopeDecline(null).declined).toBe(false);
      expect(detectScopeDecline(undefined).declined).toBe(false);
      expect(detectScopeDecline("").declined).toBe(false);
    });

    it("does not flag very short responses", () => {
      expect(detectScopeDecline("Done.").declined).toBe(false);
      expect(detectScopeDecline("PR #1234 open").declined).toBe(false);
    });

    it("does not flag non-string input", () => {
      // @ts-expect-error testing runtime guard
      expect(detectScopeDecline(123).declined).toBe(false);
      // @ts-expect-error testing runtime guard
      expect(detectScopeDecline({}).declined).toBe(false);
    });

    it("suppresses match when benign context is in same paragraph", () => {
      // 'scope creep' appears in same paragraph as 'out of scope' — suppress.
      const result = detectScopeDecline(
        "I noticed some scope creep here but the change is not out of scope of this PR — I'll keep it focused.",
      );
      expect(result.declined).toBe(false);
    });

    it("does NOT suppress match when benign context is in a different paragraph", () => {
      // Real decline in para 1; unrelated 'scope of work' three paragraphs later — should still detect
      const result = detectScopeDecline(
        "This is out of scope for this agent. Please reroute.\n\n" +
          "Background: the team's scope of work for next sprint is unrelated.",
      );
      expect(result.declined).toBe(true);
    });
  });

  describe("real-world fixtures", () => {
    it("detects the actual decline pattern from issue #1418 / #1433", () => {
      // Modeled after the public decline comment that triggered #1433.
      const result = detectScopeDecline(
        "I'm not picking this up. CLAUDE.md in this repo is explicit about being out of scope: " +
          "'This repo is not the agent runtime, the proxy server, or the dashboard app.' " +
          "A browser-automation runtime (Playwright + Chromium + wallet extension + dApp recipes) " +
          "is sibling to fleet-signer (#1413/#1414), which lives outside this package. " +
          "Please re-home this issue to the runtime repo.",
      );
      expect(result.declined).toBe(true);
    });
  });
});
