# Agent Orchestrator — Roadmap

This is the prioritised backlog for `rapartlu/agent-orchestrator`. Updated 2026-04-17.

---

## Next Up

These are the most impactful items — highest signal-to-noise for the fleet.

| # | Issue | What & Why |
|---|-------|-----------|
| 1 | [#908](https://github.com/rapartlu/agent-orchestrator/issues/908) | **Per-call LLM timeout on PR reviewer** — prevents DEADLOCK when a single slow review blocks the entire daemon cycle |
| 2 | [#885](https://github.com/rapartlu/agent-orchestrator/issues/885) | **Issue existence validation before dispatch** — stops wasted cycles dispatching to already-closed or nonexistent issues |
| 3 | [#877](https://github.com/rapartlu/agent-orchestrator/issues/877) | **Decisions dashboard panel** — expose `/api/routing-decisions` in agent-dashboard for visibility into why tasks are routed where they are |
| 4 | [#869](https://github.com/rapartlu/agent-orchestrator/issues/869) | **Auto-route blocked dispatches to PR review queue** — when a dispatch is blocked, immediately surface it for review rather than losing it silently |
| 5 | [#863](https://github.com/rapartlu/agent-orchestrator/issues/863) | **Cross-repo duplicate issue dispatch detection** — deduplicate work items that exist in multiple repos to avoid agents duplicating effort |

---

## Planned

Solid ideas, scoped and ready when Next Up clears.

| # | Issue | What & Why |
|---|-------|-----------|
| 6 | [#876](https://github.com/rapartlu/agent-orchestrator/issues/876) | **Research agent proactive dispatch** — auto-detect architecture/technology decisions and route them to the research agent before implementation begins |
| 7 | [#875](https://github.com/rapartlu/agent-orchestrator/issues/875) | **Unified dispatch health panel** — consolidate all blocking/skip/dedup signals into one dashboard view |
| 8 | [#874](https://github.com/rapartlu/agent-orchestrator/issues/874) | **Agent name canonicalization** — prevent silent misrouting from name typos or renamed agents |
| 9 | [#860](https://github.com/rapartlu/agent-orchestrator/issues/860) | **Agent identity validation** — block dispatches to stale/renamed agents before wasting a cycle |
| 10 | [#849](https://github.com/rapartlu/agent-orchestrator/issues/849) | **Schema registry auto-sync** — update consumer repos automatically when the cross-repo schema registry changes |
| 11 | [#794](https://github.com/rapartlu/agent-orchestrator/issues/794) | **Idempotency guard** — block re-dispatch when a PR already exists for the issue (complements #868, which is merged) |
| 12 | [#762](https://github.com/rapartlu/agent-orchestrator/issues/762) | **Antibody filter false-positive correction** — add a feedback path to demote over-aggressive immune patterns |

---

## Ideas

Worth tracking but not yet scoped or prioritised.

| # | Issue | What & Why |
|---|-------|-----------|
| 13 | [#787](https://github.com/rapartlu/agent-orchestrator/issues/787) | **Dispatch skip pattern aggregator** — surface systemic skip patterns and auto-create issues for recurring blockers |
| 14 | [#711](https://github.com/rapartlu/agent-orchestrator/issues/711) | **Lineage blast-radius graph** — visual view of which issues/PRs were spawned by a root issue |

---

## Recently Shipped

Key features merged since last triage:

- **#908** — staging-validator per-call timeout (proxy, merged as #900)
- **#905** — verification outcome logs + PR events poller (calibration Phase 1)
- **#903** — auto-rebuild stale dist/ on daemon startup
- **#879** — auto-file improvement issues from health incident post-mortems
- **#872** — priority review fast-lane for dispatch-blocking PRs
- **#868** — pre-dispatch open-PR deduplication
- **#867** — UNKNOWN_AGENT guard for unregistered agent dispatches
- **#848** — cross-repo schema contract registry
- **#845** — configurable verification prompts via `agents.yaml`
- **#841** — routing decisions timeline table + API
