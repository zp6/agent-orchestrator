# Agent Orchestrator — Roadmap

This is the prioritised backlog for `rapartlu/agent-orchestrator`. Updated 2026-04-22.

---

## Next Up

These are the most impactful items — highest signal-to-noise for the fleet.

| # | Issue | What & Why |
|---|-------|-----------|
| 1 | [#1047](https://github.com/rapartlu/agent-orchestrator/issues/1047) | **Already-in-review state persistence** — persist already-in-review results to `state.db` so cross-restart re-dispatch is prevented; high severity — 20 identical wasted dispatches observed in a single daemon window |
| 2 | [#1052](https://github.com/rapartlu/agent-orchestrator/issues/1052) | **PR existence guard cooldown** — after the guard fires once for an issue, set an issue-level cooldown so subsequent cycles don't re-check and re-alert; complements #1047 |
| 3 | [#938](https://github.com/rapartlu/agent-orchestrator/issues/938) | **Dispatch safety audit log** — unified guard event feed for all pre-dispatch safety decisions (antibody, idempotency, lock, affinity); critical for debugging misroutes and blocked dispatches |
| 4 | [#929](https://github.com/rapartlu/agent-orchestrator/issues/929) | **Pre-dispatch semantic duplicate detection** — LLM-based dedup of open issues before dispatching; prevents agents implementing the same feature twice under different titles |
| 5 | [#911](https://github.com/rapartlu/agent-orchestrator/issues/911) | **Score coverage backfill endpoint** — expose `/api/tasks/backfill-scores` in daemon loop to retroactively score tasks missing quality data |

---

## Planned

Solid ideas, scoped and ready when Next Up clears.

| # | Issue | What & Why |
|---|-------|-----------|
| 6 | [#885](https://github.com/rapartlu/agent-orchestrator/issues/885) | **Issue existence validation before dispatch** — stops wasted cycles dispatching to already-closed or nonexistent issues |
| 7 | [#874](https://github.com/rapartlu/agent-orchestrator/issues/874) | **Agent name canonicalization** — prevent silent misrouting from name typos or renamed agents (complements the UNKNOWN_AGENT guard) |
| 8 | [#876](https://github.com/rapartlu/agent-orchestrator/issues/876) | **Research agent proactive dispatch** — auto-detect architecture/technology decisions and route them to the research agent before implementation begins |
| 9 | [#869](https://github.com/rapartlu/agent-orchestrator/issues/869) | **Auto-route blocked dispatches to PR review queue** — when a dispatch is blocked, immediately surface it for review rather than losing it silently |
| 10 | [#992](https://github.com/rapartlu/agent-orchestrator/issues/992) | **Cross-repo security propagation tracker** — detect when a security fix in one agent repo hasn't been applied to peer repos; auto-file propagation issues |
| 11 | [#877](https://github.com/rapartlu/agent-orchestrator/issues/877) | **Decisions dashboard panel** — expose `/api/routing-decisions` in agent-dashboard for visibility into why tasks are routed where they are (needs dashboard-side work) |

---

## Ideas

Worth tracking but not yet scoped or prioritised.

| # | Issue | What & Why |
|---|-------|-----------|
| 12 | [#1009](https://github.com/rapartlu/agent-orchestrator/issues/1009) | **Predictive failure shield** — pre-score tasks against a failure-probability model before dispatch; high-risk tasks get scope decomposition or context injection before any tokens are spent |
| 13 | [#1010](https://github.com/rapartlu/agent-orchestrator/issues/1010) | **Autonomous fleet self-scaling** — capacity controller that spins up/down agent containers via Docker API based on queue depth and utilization |
| 14 | [#1019](https://github.com/rapartlu/agent-orchestrator/issues/1019) | **Fleet scaling dashboard integration** — metrics endpoint + dashboard panel for fleet capacity observability |
| 15 | [#1025](https://github.com/rapartlu/agent-orchestrator/issues/1025) | **Quality floor bypass alerts** — Telegram alert when a PR is approved despite very low quality score (bypass path) |
| 16 | [#1022](https://github.com/rapartlu/agent-orchestrator/issues/1022) | **Scaling alerting rules and anomaly detection** — dynamic thresholds, multi-metric correlation, anomaly severity classification |
| 17 | [#1038](https://github.com/rapartlu/agent-orchestrator/issues/1038) | **Prompt cache hit rate widget** — dashboard panel + weekly cost savings report from prompt caching (issue #1037 shipped caching; this tracks its ROI) |

---

## Recently Shipped

Key features merged since last triage:

- **#1057** — add waste/guard/metric topics to orchestrator owns_topics (eliminates coverage gap detector noise) (2026-04-22)
- **#991/#1048** — dispatch waste rate metric (24h hourly window), 15% Telegram alert, cross-repo PR guard checking all peer agent repos before dispatch (2026-04-21)
- **#1049** — reduce Telegram noise: stop alerting on removed agents + daily stuck-issue cap (2026-04-21)
- **#1045** — auto-restart Docker/OrbStack when proxy outage detected (2026-04-21)
- **#1044** — fix proxy alert flapping: rolling window + recovery debounce (2026-04-20)
- **#1039** — bypass reason validation for `/approve` with very low scores (2026-04-20)
- **#1037** — prompt caching (`cache_control: { type: 'ephemeral' }`) on all LLM system prompts to reduce token spend (2026-04-20)
- **#1028/#1033** — semantic memory effectiveness dashboard + auto-tuning of `min_quality_score`, FTS5 query analysis, per-agent breakdown (2026-04-19)
- **#1032** — CI: path filtering, caching, and self-hosted runner support to fix billing exhaustion (2026-04-19)
- **#1011** — shared semantic task memory: FTS5-based knowledge store, top-3 similar past successes injected at dispatch time (2026-04-19)
- **#1000** — fix: dispatch coordination group child tasks stuck at pending (2026-04-19)
- **#959** — fix research-agent PR-existence guard (2026-04-19)
- **#956** — enable auto-merge in daemon merge queue (2026-04-18)
- **#943** — fix 3 CI test failures on main (2026-04-18)
- **#940** — remove Codex agents from pool routing (disabled, out of tokens) (2026-04-18)
- **#937** — Telegram approval queue: rich task context card (2026-04-18)
- **#935** — duplicate task ID detection and alerting (2026-04-18)
- **#928** — repo-to-agent affinity guardrail to prevent cross-domain routing misfires (2026-04-18)
- **#927** — in-flight dispatch reservation to prevent concurrent dual implementations (2026-04-18)
- **#908** — reduce LLM call timeouts to 2 min to prevent DEADLOCK (2026-04-18)
- **#905** — verification outcome logs + PR events poller (calibration Phase 1) (2026-04-17)
- **#879** — auto-file improvement issues from health incident post-mortems (2026-04-15)
- **#868** — pre-dispatch open-PR deduplication (2026-04-15)
- **#867** — UNKNOWN_AGENT guard: reject dispatches to unregistered agents (2026-04-15)
