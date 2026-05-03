import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { StateStore } from "../state/store.js";
import { scoreBountyOpportunity, buildClaimBrief } from "./bounty-matcher.js";

describe("scoreBountyOpportunity", () => {
  const fixedNow = new Date("2026-05-03T00:00:00Z");

  it("rewards high crypto payout with capability match", () => {
    const result = scoreBountyOpportunity(
      {
        title: "Fix TS bug in DeFi protocol",
        scope: "TypeScript bug fix in EVM-adjacent tooling",
        payout_amount_usd: 2000,
        payout_currency: "USDC",
        payout_terms: "paid on merge to main",
        deadline: "2026-05-10T00:00:00Z",
        capabilities: ["typescript", "smart-contracts", "bug-fix"],
      },
      undefined,
      fixedNow,
    );
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.capability_match).toContain("typescript");
  });

  it("penalizes fiat + KYC bounties", () => {
    const result = scoreBountyOpportunity(
      {
        title: "Marketing copy",
        scope: null,
        payout_amount_usd: 500,
        payout_currency: "USD",
        payout_terms: "submit W-9 tax form before payout",
        deadline: null,
        capabilities: [],
      },
      undefined,
      fixedNow,
    );
    expect(result.score).toBeLessThan(30);
    expect(result.rationale).toMatch(/KYC/i);
  });

  it("penalizes expired deadlines", () => {
    const result = scoreBountyOpportunity(
      {
        title: "Old issue",
        scope: null,
        payout_amount_usd: 1000,
        payout_currency: "USDC",
        payout_terms: null,
        deadline: "2026-04-01T00:00:00Z",
        capabilities: ["typescript"],
      },
      undefined,
      fixedNow,
    );
    expect(result.rationale).toMatch(/deadline passed/);
  });

  it("clamps score to 0..100", () => {
    const result = scoreBountyOpportunity(
      {
        title: "x",
        scope: null,
        payout_amount_usd: 1_000_000,
        payout_currency: "USDC",
        payout_terms: null,
        deadline: null,
        capabilities: ["typescript", "rust", "solidity", "security-review"],
      },
      undefined,
      fixedNow,
    );
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe("BountyOpportunity persistence", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-bounty-${randomUUID()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("adds, lists, scores, and updates status", () => {
    const opp = store.addBountyOpportunity({
      source_url: "https://example.com/bounty/1",
      title: "Audit ERC20 deploy",
      scope: "Review deploy script",
      payout_amount_usd: 750,
      payout_currency: "USDC",
      capabilities: ["solidity", "security-review"],
    });
    expect(opp.id).toBeGreaterThan(0);
    expect(opp.status).toBe("open");

    const scoring = scoreBountyOpportunity({
      title: opp.title,
      scope: opp.scope,
      payout_amount_usd: opp.payout_amount_usd,
      payout_currency: opp.payout_currency,
      payout_terms: opp.payout_terms,
      deadline: opp.deadline,
      capabilities: opp.capabilities,
    });
    const brief = buildClaimBrief(opp, scoring);
    expect(brief).toContain("Claim Brief");
    expect(brief).toContain(opp.source_url);
    store.updateBountyOpportunityScore(opp.id, scoring.score, scoring.rationale, brief);

    const all = store.listBountyOpportunities();
    expect(all).toHaveLength(1);
    expect(all[0].score).toBe(scoring.score);
    expect(all[0].brief).toContain("Claim Brief");

    store.updateBountyOpportunityStatus(opp.id, "claimed");
    expect(store.getBountyOpportunity(opp.id)!.status).toBe("claimed");

    expect(store.listBountyOpportunities({ status: "open" })).toHaveLength(0);
    expect(store.listBountyOpportunities({ status: "claimed" })).toHaveLength(1);
  });

  it("rejects duplicate URLs", () => {
    store.addBountyOpportunity({ source_url: "https://x/y", title: "A" });
    expect(() =>
      store.addBountyOpportunity({ source_url: "https://x/y", title: "B" }),
    ).toThrow(/already tracked/);
  });

  it("orders list by score DESC with nulls last", () => {
    const a = store.addBountyOpportunity({ source_url: "https://a", title: "A" });
    const b = store.addBountyOpportunity({ source_url: "https://b", title: "B" });
    const c = store.addBountyOpportunity({ source_url: "https://c", title: "C" });
    store.updateBountyOpportunityScore(a.id, 30, "r", "br");
    store.updateBountyOpportunityScore(b.id, 80, "r", "br");
    // c stays unscored
    const list = store.listBountyOpportunities();
    expect(list.map((x) => x.title)).toEqual(["B", "A", "C"]);
  });
});
