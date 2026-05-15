import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseAssumptionsFile,
  checkPhasePromotionGate,
} from "./phase-promotion-gate.js";

// ── fs mock ───────────────────────────────────────────────────────────────────

const mockReadFileSync = vi.fn<[string, string], string>();

vi.mock("fs", () => ({
  readFileSync: (...args: [string, string]) => mockReadFileSync(...args),
}));

beforeEach(() => {
  mockReadFileSync.mockReset();
});

// ── parseAssumptionsFile ──────────────────────────────────────────────────────

describe("parseAssumptionsFile", () => {
  it("detects Phase A from bold markdown syntax", () => {
    const content = `
## Phase

- **Current:** A (stubbed)
- **Promote to B when:** all assumptions verified
`;
    const result = parseAssumptionsFile(content);
    expect(result.phase).toBe("A");
  });

  it("detects Phase B from bold markdown syntax", () => {
    const content = `
## Phase

- **Current:** B
- **Promote to B when:** already done
`;
    const result = parseAssumptionsFile(content);
    expect(result.phase).toBe("B");
  });

  it("detects Phase A from non-bold syntax", () => {
    const content = `
- Current: A (stubbed)
`;
    const result = parseAssumptionsFile(content);
    expect(result.phase).toBe("A");
  });

  it("returns unknown when no phase line is found", () => {
    const content = "No phase information here.";
    const result = parseAssumptionsFile(content);
    expect(result.phase).toBe("unknown");
  });

  it("extracts unverified assumptions from table rows with ❌", () => {
    const content = `
| \`api.immunefi.com\` resolves | ❌ no | — |
| \`/v1/submissions\` endpoint exists | ❌ no | — |
| Bearer token scope covers creation | ✅ yes | tested 2026-05-10 |
`;
    const result = parseAssumptionsFile(content);
    expect(result.unverifiedAssumptions).toHaveLength(2);
    expect(result.unverifiedAssumptions[0]).toBe("`api.immunefi.com` resolves");
    expect(result.unverifiedAssumptions[1]).toBe("`/v1/submissions` endpoint exists");
  });

  it("returns empty unverified list when all assumptions are ✅", () => {
    const content = `
| DNS resolves | ✅ yes | verified 2026-05-10 |
| Endpoint responds | ✅ yes | verified 2026-05-10 |

- **Current:** B
`;
    const result = parseAssumptionsFile(content);
    expect(result.unverifiedAssumptions).toHaveLength(0);
  });

  it("ignores table header separator rows", () => {
    const content = `
| Assumption | Verified? | Evidence |
|------------|-----------|----------|
| DNS resolves | ❌ no | — |
`;
    const result = parseAssumptionsFile(content);
    expect(result.unverifiedAssumptions).toHaveLength(1);
    // Separator row (---) must not appear as an assumption
    const hasSeparator = result.unverifiedAssumptions.some((a) =>
      a.startsWith("-"),
    );
    expect(hasSeparator).toBe(false);
    // The actual unverified row is "DNS resolves", not the header
    expect(result.unverifiedAssumptions[0]).toBe("DNS resolves");
  });
});

// ── checkPhasePromotionGate ───────────────────────────────────────────────────

describe("checkPhasePromotionGate", () => {
  const adaptersDir = "/repo/src/orchestrator/submission-adapters";

  it("allows non-go-live tasks without reading any file", () => {
    const result = checkPhasePromotionGate({
      issueTitle: "Fix typo in README",
      issueBody: "There is a typo on line 3.",
      adaptersDir,
    });
    expect(result.allowed).toBe(true);
    expect(result.adapterName).toBeNull();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("allows go-live tasks that reference no known adapter", () => {
    const result = checkPhasePromotionGate({
      issueTitle: "Go live with the new landing page",
      issueBody: "Deploy the static site to Cloudflare Pages.",
      adaptersDir,
    });
    expect(result.allowed).toBe(true);
    expect(result.adapterName).toBeNull();
  });

  it("blocks when assumptions.md is missing", () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = checkPhasePromotionGate({
      issueTitle: "Provision Immunefi token and go live",
      issueBody: "Enable production submission via Immunefi.",
      adaptersDir,
    });

    expect(result.allowed).toBe(false);
    expect(result.adapterName).toBe("immunefi");
    expect(result.reason).toContain("no assumptions.md found");
  });

  it("blocks when adapter is Phase A", () => {
    const assumptionsContent = `
## External dependencies

| \`api.immunefi.com\` resolves | ❌ no | — |
| Endpoint accepts POST | ❌ no | — |

## Phase

- **Current:** A (stubbed)
`;
    mockReadFileSync.mockReturnValue(assumptionsContent);

    const result = checkPhasePromotionGate({
      issueTitle: "Provision Immunefi token",
      issueBody: "See issue #1639.",
      adaptersDir,
    });

    expect(result.allowed).toBe(false);
    expect(result.phase).toBe("A");
    expect(result.unverifiedAssumptions).toHaveLength(2);
    expect(result.reason).toContain("Phase A");
    expect(result.reason).toContain("2 unverified");
  });

  it("blocks when adapter claims Phase B but has ❌ rows (discipline violation)", () => {
    const assumptionsContent = `
## External dependencies

| DNS resolves | ✅ yes | verified |
| Endpoint accepts POST | ❌ no | — |

## Phase

- **Current:** B
`;
    mockReadFileSync.mockReturnValue(assumptionsContent);

    const result = checkPhasePromotionGate({
      issueTitle: "Go live with Immunefi production",
      issueBody: "Enable production submission.",
      adaptersDir,
    });

    expect(result.allowed).toBe(false);
    expect(result.phase).toBe("B");
    expect(result.unverifiedAssumptions).toHaveLength(1);
    expect(result.reason).toContain("discipline violation");
  });

  it("allows when adapter is Phase B with all assumptions verified", () => {
    const assumptionsContent = `
## External dependencies

| DNS resolves | ✅ yes | verified 2026-05-12 |
| Endpoint accepts POST | ✅ yes | verified 2026-05-12 |
| Response has submission_id | ✅ yes | verified 2026-05-12 |

## Phase

- **Current:** B
`;
    mockReadFileSync.mockReturnValue(assumptionsContent);

    const result = checkPhasePromotionGate({
      issueTitle: "Go live with Immunefi production",
      issueBody: "All assumptions verified, see evidence in assumptions.md.",
      adaptersDir,
    });

    expect(result.allowed).toBe(true);
    expect(result.phase).toBe("B");
    expect(result.unverifiedAssumptions).toHaveLength(0);
  });

  it("matches go-live patterns: 'enable production'", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = checkPhasePromotionGate({
      issueTitle: "Enable production mode for Immunefi",
      issueBody: "Switch from stub to live.",
      adaptersDir,
    });

    expect(result.allowed).toBe(false);
    expect(result.adapterName).toBe("immunefi");
  });

  it("matches go-live patterns: 'deploy production'", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = checkPhasePromotionGate({
      issueTitle: "Deploy production Immunefi adapter",
      issueBody: "",
      adaptersDir,
    });

    expect(result.allowed).toBe(false);
    expect(result.adapterName).toBe("immunefi");
  });

  it("matches go-live patterns: 'promote to Phase B'", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = checkPhasePromotionGate({
      issueTitle: "Promote Immunefi adapter to Phase B",
      issueBody: "All checks passed.",
      adaptersDir,
    });

    expect(result.allowed).toBe(false);
    expect(result.adapterName).toBe("immunefi");
  });

  it("reads from the expected path: <adaptersDir>/<adapter>.assumptions.md", () => {
    mockReadFileSync.mockReturnValue("## Phase\n- **Current:** B\n");

    checkPhasePromotionGate({
      issueTitle: "Go live with Immunefi production",
      issueBody: "",
      adaptersDir: "/custom/dir",
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(
      "/custom/dir/immunefi.assumptions.md",
      "utf-8",
    );
  });
});
