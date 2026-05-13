# Active Fleet Actions — schema & protocol

`docs/active-fleet-actions.yaml` is the shared friction surface for the fleet's producer/critic loop. Hustle proposes actions; auditor reviews them; hustle executes only the approved ones; outcomes are recorded.

Both agents read and write this file. The schema is contract.

## Purpose

Decouples the two roles via a shared ledger rather than direct calls:

- **Hustle** is forward propulsion. It scans signals, identifies opportunities, proposes actions.
- **Auditor** is guardrails. It reads proposals, applies charter / capital-discipline / KR-alignment checks, approves or blocks.

The result is **healthy friction**: hustle wants to ship more; auditor wants to keep commitments. The right operating point is 1-3 holds per day — zero means auditor is rubber-stamping; flood means hustle is over-aggressive.

## Schema

```yaml
schema_version: 1
generated_at: 2026-05-13T20:00:00Z  # written by `orch fleet-actions sync`, not by humans
actions:
  - id: hustle-2026-05-13T20:30:00Z-a3f
    proposed_by: hustle-agent
    proposed_at: 2026-05-13T20:30:00Z
    type: github-pr-open
    target: "rapartlu/agent-orchestrator#1234 | github.com/ensdomains/ens-app-v3 | @maintainer-handle"
    summary: "One-line description"
    reasoning: |
      Multi-line: why this matters, evidence, expected impact
    expected_value:
      currency: USD
      amount: 200
      confidence: medium  # low | medium | high
    source_signals:
      - "stale-issue scan: ENS#234, open 67 days, no PR"
    okr_alignment: [okr-1, okr-5]
    status: proposed  # proposed | under_review | approved | rejected | executing | executed | abandoned
    auditor_review:
      reviewed_at: null
      reviewer: null
      decision: null   # approve | hold | reject
      reasoning: null
      conditions: []
    execution:
      started_at: null
      completed_at: null
      artifact_url: null
      outcome: null    # success | failure
      revenue_received_usd: null
```

## Action types

- **`github-pr-open`** — open a PR against an external repo fixing a bug/feature. Wallet address in PR description as voluntary tip jar.
- **`outreach-dm`** — send a DM to a maintainer/founder offering a specific service for a specific price.
- **`bounty-submission`** — file a finding on a bounty platform (Immunefi, Sherlock, Code4rena). Currently web-UI only per #1642.
- **`demo-repo-update`** — commit improvements to a fleet-authored public demo repo.
- **`content-post`** — publish to Inside the Fleet, Farcaster, etc.

Future types are additive — agents must skip actions they don't understand.

## Lifecycle states

```
proposed ──► under_review ──► approved ──► executing ──► executed
                          └──► hold ──┐ (resume after re-review)
                          └──► rejected ──► abandoned
```

- `proposed`: hustle wrote it, auditor hasn't seen it yet
- `under_review`: auditor has picked it up
- `approved`: auditor okayed, hustle will execute on next cycle
- `hold`: auditor wants to wait (new info expected, or low confidence)
- `rejected`: auditor blocks, hustle abandons
- `executing`: hustle has begun work (opening PR, drafting DM, etc.)
- `executed`: complete with outcome recorded
- `abandoned`: hustle gave up (rejected, or stale)

## Cadence and bounded work

Both agents run every ~5 cycles (≈5 min at 60s poll interval). Bounded per-cycle:

- **Hustle per cycle**: scan ONE signal source (rotates across stale-issue / twitter / bounty / etc.), propose at most 1 new action.
- **Auditor per cycle**: review ONE pending action, run ONE other classifier (rotating).

This keeps token spend bounded (~5k tokens/cycle) while producing constant signal.

## Disagreement resolution

When `decision: reject` lands and hustle disagrees, hustle writes a `dispute` block:

```yaml
dispute:
  raised_by: hustle-agent
  raised_at: 2026-05-13T21:00:00Z
  reasoning: |
    Why the reject is wrong; what hustle expected
```

meeting-facilitator-agent reads disputes, runs an async-round between the two, writes resolution back to the action. Persistent disagreement (>2h unresolved) escalates to operator via Telegram.

For MVP, dispute handling is deferred — hustle simply abandons rejected actions and logs the rejection. Adding the dispute path is a follow-up issue.

## Append-only conventions

- New actions are appended to the `actions` array, never deleted
- Status changes are in-place mutations to the action object
- History queries (`orch fleet-actions history`) read the full file
- File pruning happens manually via PR every ~30 days

This keeps the audit trail intact for the auditor's introspection and operator review.

## CLI

```bash
orch fleet-actions list [--status proposed]    # show ledger entries
orch fleet-actions propose --type X --target Y --summary Z  # used by agents, not humans
orch fleet-actions review ID --decision approve|hold|reject --reasoning "..."
orch fleet-actions execute ID --artifact-url URL  # mark execution
orch fleet-actions history [--days N]            # show outcomes
orch fleet-actions stats                          # velocity, hold rate, execution rate
```

Direct file edits are also valid (it's a YAML file in the repo). The CLI is for agent automation and operator convenience.

## KPI rules surfaced on dashboard

- `hustle_actions_proposed_24h ≥ 3` — velocity floor (deliberate momentum)
- `auditor_holds_per_24h between 1 and 5` — friction band (not zero, not flood)
- `approved_action_execution_rate ≥ 0.8` — follow-through (no languishing approvals)

These three together describe the producer/critic loop's health.

## Related

- `goals.yaml` — the OKRs this loop is designed to move
- `CHARTER.md` Article III — money in, never out (auditor blocks payouts)
- `MEMORY.md` `cadence_default_velocity_discipline` — daily-or-faster while survival isn't funded
- Issue `#TBD` — implementation tracker
