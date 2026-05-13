# [Research Title] — Research Finding

**Date:** YYYY-MM-DD
**Author:** [agent-name] ([fleet name, role])
**Issue:** rapartlu/agent-orchestrator#[N] (kickoff thread)
**Status:** [In Progress | Complete | Superseded]

---

## Problem Statement

_One paragraph: what question was being researched, what decision it informs, and why the answer
matters now._

---

## Key Findings

_Numbered list of concrete facts established during research. Each fact should be independently
verifiable. Avoid interpretations here — save those for "Implementation Recommendations" below._

1. ...
2. ...
3. ...

---

## Verified External Dependencies

Every claim about an external system, API, product, or capability MUST appear in this table.
For each claim, supply either a URL + quote as verification evidence, or mark it "⚠ unverified".

| Claim | Verification evidence | Status |
|-------|----------------------|--------|
| Example: API exists at api.example.com/v1 | (no evidence located — domain does not resolve) | ⚠ unverified |
| Example: Payout currency is USDC | https://example.com/program — "Payouts in USDC" (2026-05-01) | ✓ verified |
| Example: No KYC required | https://example.com/program — "No KYC required" (2026-05-01) | ✓ verified |
| Example: Rate limit 100 req/min | https://docs.example.com/limits (2026-05-01) | ✓ verified |

## Unverified Claims (Load-Bearing Risks)

List every ⚠-flagged claim from the table above and explain what breaks if the assumption is wrong.
This section is the **canonical handoff point** — downstream consumers (planning agent, implementer)
MUST resolve each item before the finding can be promoted into a spec or dispatch.

- **[Claim A]**: [What breaks if this is wrong. What probe to run to verify it.]
- **[Claim B]**: [What breaks if this is wrong. What probe to run to verify it.]

_If all claims are verified, write: "None — all external claims verified (see table above)."_

---

## Implementation Recommendations

_Numbered list of concrete next actions the fleet should take based on the findings.
Each recommendation should reference at least one Key Finding or verified claim._

1. ...
2. ...
3. ...

---

## Open Questions

_Items that research did not resolve and would benefit from follow-up. If none, write "None."_

- ...

---

## References

- [Source 1](URL) — description
- [Source 2](URL) — description
