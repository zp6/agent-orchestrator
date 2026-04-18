# Agent Orchestrator — Roadmap

This is the prioritised backlog for `rapartlu/agent-orchestrator`. Updated 2026-04-18.

---

## Next Up

These are the most impactful items — highest signal-to-noise for the fleet.

| # | Issue | What & Why |
|---|-------|-----------|
| 1 | [#912](https://github.com/rapartlu/agent-orchestrator/issues/912) | **CI failing on main** — P1 bug; all PR merges are blocked until CI is green |
| 2 | [#908](https://github.com/rapartlu/agent-orchestrator/issues/908) | **Per-call LLM timeout on PR reviewer** — prevents DEADLOCK when a single slow review blocks the entire daemon cycle; root fix is parallel verification (not just a timeout) |
| 3 | [#911](https://github.com/rapartlu/agent-orchestrator/issues/911) | **Score coverage backfill endpoint** — expose `/api/tasks/backfill-scores` in daemon loop to retroactively score tasks missing quality data |
| 4 | [#885](https://github.com/rapartlu/agent-orchestrator/issues/885) | **Issue existence validation before dispatch** — stops wasted cycles dispatching to already-closed or nonexistent issues |
| 5 | [#869](https://github.com/rapartlu/agent-orchestrator/issues/869) | **Auto-route blocked dispatches to PR review queue** — when a dispatch is blocked, immediately surface it for review rather than losing it silently |

---

## Planned

Solid ideas, scoped and ready when Next Up clears.

| # | Issue | What & Why |
|---|-------|-----------|
| 6 | [#876](https://github.com/rapartlu/agent-orchestrator/issues/876) | **Research agent proactive dispatch** — auto-detect architecture/technology decisions and route them to the research agent before implementation begins |
| 7 | [#874](https://github.com/rapartlu/agent-orchestrator/issues/874) | **Agent name canonicalization** — prevent silent misrouting from name typos or renamed agents (complements the UNKNOWN_AGENT guard from #867) |
| 8 | [#863](https://github.com/rapartlu/agent-orchestrator/issues/863) | **Cross-repo duplicate issue dispatch detection** — deduplicate work items that exist in multiple repos to avoid agents duplicating effort |
| 9 | [#849](https://github.com/rapartlu/agent-orchestrator/issues/849) | **Schema registry auto-sync** — update consumer repos automatically when the cross-repo schema registry changes |
| 10 | [#877](https://github.com/rapartlu/agent-orchestrator/issues/877) | **Decisions dashboard panel** — expose `/api/routing-decisions` in agent-dashboard for visibility into why tasks are routed where they are (needs dashboard-side work) |

---

## Ideas

Worth tracking but not yet scoped or prioritised.

| # | Issue | What & Why |
|---|-------|-----------|
| 11 | [#794](https://github.com/rapartlu/agent-orchestrator/issues/794) | **Idempotency guard** — block re-dispatch when a PR already exists for the issue (complements #868, which is merged) |
| 12 | [#787](https://github.com/rapartlu/agent-orchestrator/issues/787) | **Dispatch skip pattern aggregator** — surface systemic skip patterns and auto-create issues for recurring blockers |
| 13 | [#762](https://github.com/rapartlu/agent-orchestrator/issues/762) | **Antibody filter false-positive correction** — add a feedback path to demote over-aggressive immune patterns |
| 14 | [#711](https://github.com/rapartlu/agent-orchestrator/issues/711) | **Lineage blast-radius graph API** — HTTP query API for lineage groups; branch `issue-711-lineage-api` has the work but PR was closed without merge |

---

## Recently Shipped

Key features merged since last triage:

- **#909** — bootstrapped ROADMAP.md (2026-04-17)
- **#907** — fix learned_patterns migration crash (no such column active) (2026-04-17)
- **#905** — verification outcome logs + PR events poller (calibration Phase 1) (2026-04-17)
- **#904** — ALTER TABLE migration for learned_patterns.active column (2026-04-17)
- **#903** — auto-rebuild stale dist/ on daemon startup (2026-04-17)
- **#900** — staging-validator 120s per-call timeout to prevent daemon DEADLOCK (2026-04-17)
- **#898** — pre-dispatch always queries live GitHub for open PRs before dispatch (2026-04-17)
- **#897** — resolve FOREIGN KEY constraint on post-merge validation DB write (2026-04-17)
- **#879** — auto-file improvement issues from health incident post-mortems (2026-04-15)
- **#872** — priority review fast-lane for dispatch-blocking PRs (2026-04-15)
- **#868** — pre-dispatch open-PR deduplication (2026-04-15)
- **#867** — UNKNOWN_AGENT guard: reject dispatches to unregistered agents (2026-04-15)
- **#848** — cross-repo schema contract registry to prevent column-name drift (2026-04-15)
