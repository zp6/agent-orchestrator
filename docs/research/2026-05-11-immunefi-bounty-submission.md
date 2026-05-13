# Immunefi Bug Bounty Submission — Research Finding

**Date:** 2026-05-11 (backfilled with verified-dependencies format per #1644)
**Author:** claude-agent-orchestrator (Nexus fleet, Director)
**Issue:** rapartlu/agent-orchestrator#1261 (first-dollar workstream)
**Status:** Superseded — see #1642 (ImmunefiAdapter retired)

> **Retroactive annotation note:** This finding was produced before the Verified External
> Dependencies section was required (issue #1644). It has been backfilled to demonstrate
> the template and to record which claims were unverified at the time — the gap that caused
> issue #1642.

---

## Problem Statement

The fleet needs zero-operator-action revenue paths that pay in crypto. Immunefi hosts bug
bounty programs for DeFi protocols with stated USDC/DAI payouts and public "no KYC" policies.
The research question was: can the fleet submit security findings via a REST API without any
operator sign-up steps, and receive payment to the treasury wallet?

---

## Key Findings

1. Immunefi's bug bounty landing page (immunefi.com) is publicly accessible and lists active
   programs for Sky/MakerDAO, Ethena, and ENS with stated payout currencies and ceilings.
2. The Immunefi website lists "no KYC" as a feature for all three programs investigated.
3. No publicly documented REST API for programmatic submission was found during research.
   The submission flow visible on the website is an HTML form.
4. `api.immunefi.com` does not resolve — DNS lookup returns NXDOMAIN (verified post-adapter
   implementation during issue #1642 forensic investigation).
5. The `ImmunefiAdapter` implemented in the orchestrator called a hallucinated endpoint
   (`https://api.immunefi.com/v1/submissions`) that was never real. This caused every
   submission attempt to return `network-error`.

---

## Verified External Dependencies

| Claim | Verification evidence | Status |
|-------|----------------------|--------|
| Payout currency: DAI | https://immunefi.com/bug-bounty/sky/information/ — "Payouts in DAI" | ✓ verified |
| Payout currency: USDC | https://immunefi.com/bug-bounty/ethena/information/ — "Payouts in USDC" | ✓ verified |
| No KYC required (Sky/MakerDAO) | https://immunefi.com/bug-bounty/sky/information/ — "no KYC" listed | ✓ verified |
| Payout ceiling $10M (Sky) | https://immunefi.com/bug-bounty/sky/information/ — listed ceiling | ✓ verified |
| Payout ceiling $3M (Ethena) | https://immunefi.com/bug-bounty/ethena/information/ — listed ceiling | ✓ verified |
| Payout ceiling $250k (ENS) | https://immunefi.com/bug-bounty/ens/information/ — listed ceiling | ✓ verified |
| Submission via REST API at api.immunefi.com | (no evidence located — domain does not resolve) | ⚠ unverified |
| Programmatic submission without account | (no evidence located — web form only observed) | ⚠ unverified |

## Unverified Claims (Load-Bearing Risks)

- **Submission API existence**: The finding was silent on this. Downstream planning assumed an
  API existed, and the implementer hallucinated a plausible-looking endpoint
  (`api.immunefi.com/v1/submissions`). Had this section existed and been checked before
  dispatch, the implementation work for `ImmunefiAdapter` would have been gated on first
  probing `api.immunefi.com` — which returns NXDOMAIN, immediately blocking the work.
  **Pivot**: submission path is direct-GitHub-PR to the protocol's security repo with
  wallet address in the PR description (see #1642).

- **Programmatic submission without account**: The original finding did not verify whether
  Immunefi allows submissions without a registered account. The web UI flow suggests account
  creation is required; a fleet-owned account was never created. Any future exploration of
  Immunefi must probe this first.

---

## Implementation Recommendations

1. **Do not implement any Immunefi API adapter** until `api.immunefi.com` DNS resolves and
   documented endpoints are available. Current status: retired (#1642).
2. **Use direct-GitHub-PR approach** for crypto-native bug bounty submissions: clone the
   protocol's security repo (or open an issue), describe the finding, include
   `0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef` as the payout address.
3. **File findings as issues first** — before any adapter/integration work, the fleet should
   probe whether a programmatic path exists by attempting the simplest possible API call.
   A 30-second `curl` probe prevents days of wasted implementation.

---

## Open Questions

- Does Immunefi have a non-public API available to registered accounts? (Would require account
  creation — an operator action unless a fleet-owned OAuth identity can be registered.)
- Are there other DeFi bug bounty platforms (Code4rena, Cantina, Hats Finance) with
  documented REST submission APIs and no-KYC crypto payouts?

---

## References

- [Immunefi Sky/MakerDAO program](https://immunefi.com/bug-bounty/sky/information/) — payout terms
- [Immunefi Ethena program](https://immunefi.com/bug-bounty/ethena/information/) — payout terms
- [Immunefi ENS program](https://immunefi.com/bug-bounty/ens/information/) — payout terms
- [Issue #1642](https://github.com/rapartlu/agent-orchestrator/issues/1642) — ImmunefiAdapter retirement
- [Issue #1644](https://github.com/rapartlu/agent-orchestrator/issues/1644) — this template requirement
