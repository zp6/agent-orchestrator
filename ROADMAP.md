# Agent Orchestrator — Roadmap

This is the prioritised backlog for `rapartlu/agent-orchestrator`. Updated 2026-04-19.

---

## Next Up

These are the most impactful items — highest signal-to-noise for the fleet.

| # | Issue | What & Why |
|---|-------|-----------|
| 1 | [#938](https://github.com/rapartlu/agent-orchestrator/issues/938) | **Dispatch safety audit log** — unified guard event feed for all pre-dispatch safety decisions (antibody, idempotency, lock, affinity); critical for debugging misroutes and blocked dispatches |
| 2 | [#929](https://github.com/rapartlu/agent-orchestrator/issues/929) | **Pre-dispatch semantic duplicate detection** — LLM-based dedup of open issues before dispatching; prevents agents implementing the same feature twice under different titles |
| 3 | [#911](https://github.com/rapartlu/agent-orchestrator/issues/911) | **Score coverage backfill endpoint** — expose `/api/tasks/backfill-scores` in daemon loop to retroactively score tasks missing quality data |
| 4 | [#885](https://github.com/rapartlu/agent-orchestrator/issues/885) | **Issue existence validation before dispatch** — stops wasted cycles dispatching to already-closed or nonexistent issues |
| 5 | [#874](https://github.com/rapartlu/agent-orchestrator/issues/874) | **Agent name canonicalization** — prevent silent misrouting from name typos or renamed agents (complements the UNKNOWN_AGENT guard) |

---

## Planned

Solid ideas, scoped and ready when Next Up clears.

| # | Issue | What & Why |
|---|-------|-----------|
| 6 | [#876](https://github.com/rapartlu/agent-orchestrator/issues/876) | **Research agent proactive dispatch** — auto-detect architecture/technology decisions and route them to the research agent before implementation begins |
| 7 | [#869](https://github.com/rapartlu/agent-orchestrator/issues/869) | **Auto-route blocked dispatches to PR review queue** — when a dispatch is blocked, immediately surface it for review rather than losing it silently |
| 8 | [#877](https://github.com/rapartlu/agent-orchestrator/issues/877) | **Decisions dashboard panel** — expose `/api/routing-decisions` in agent-dashboard for visibility into why tasks are routed where they are (needs dashboard-side work) |
| 9 | [#794](https://github.com/rapartlu/agent-orchestrator/issues/794) | **Idempotency guard** — block re-dispatch when a PR already exists for the issue (complements existing open-PR deduplication) |
| 10 | [#762](https://github.com/rapartlu/agent-orchestrator/issues/762) | **Antibody filter false-positive correction** — add a feedback path to demote over-aggressive immune patterns that block valid tasks |

---

## Ideas

Worth tracking but not yet scoped or prioritised.

| # | Issue | What & Why |
|---|-------|-----------|
| 11 | [#711](https://github.com/rapartlu/agent-orchestrator/issues/711) | **Lineage blast-radius graph API** — HTTP query API for lineage groups; branch `issue-711-lineage-api` has the work but PR was closed without merge |

---

## Recently Shipped

Key features merged since last triage:

- **#961** — fix WAL data leakage in getScoreDistribution test (isolated DB paths) (2026-04-19)
- **#959** — fix research-agent PR-existence guard (2026-04-19)
- **#956** — enable auto-merge in daemon merge queue (2026-04-18)
- **#943** — fix 3 CI test failures on main (2026-04-18)
- **#940** — remove Codex agents from pool routing (disabled, out of tokens) (2026-04-18)
- **#937** — Telegram approval queue: rich task context card (2026-04-18)
- **#935** — duplicate task ID detection and alerting (2026-04-18)
- **#928** — repo-to-agent affinity guardrail to prevent cross-domain routing misfires (2026-04-18)
- **#927** — in-flight dispatch reservation to prevent concurrent dual implementations (2026-04-18)
- **#912** — CI fixed on main (2026-04-18)
- **#908** — reduce LLM call timeouts to 2 min to prevent DEADLOCK (2026-04-18)
- **#905** — verification outcome logs + PR events poller (calibration Phase 1) (2026-04-17)
- **#900** — staging-validator 120s per-call timeout (2026-04-17)
- **#898** — pre-dispatch always queries live GitHub for open PRs (2026-04-17)
- **#879** — auto-file improvement issues from health incident post-mortems (2026-04-15)
- **#868** — pre-dispatch open-PR deduplication (2026-04-15)
- **#867** — UNKNOWN_AGENT guard: reject dispatches to unregistered agents (2026-04-15)
