# Agent Orchestrator — Roadmap

This is the prioritised backlog for `rapartlu/agent-orchestrator`. Updated 2026-04-22 (pass 4 — triage PR).

---

## Next Up

These are the most impactful items — highest signal-to-noise for the fleet.

| # | Issue | What & Why |
|---|-------|-----------|
| 1 | [#1081](https://github.com/rapartlu/agent-orchestrator/issues/1081) | **Pre-dispatch cooldown filter** — all 20 tasks in a batch were PR existence guard hits; cooldown check runs post-dispatch rather than pre-dispatch, so tasks are still created; move check to before dispatch |
| 2 | [#1061](https://github.com/rapartlu/agent-orchestrator/issues/1061) | **Hard quality floor for cross-repo triage follow-ups** — cross-repo housekeeping tasks scoring 0.42–0.51 are being approved; enforce minimum 0.60 floor for triage schema compliance |
| 3 | [#1075](https://github.com/rapartlu/agent-orchestrator/issues/1075) | **PR guard cooldown keyed by PR number** — cooldown is keyed per-issue; when 12+ issues are blocked by the same PR, each re-queues independently; re-key by PR number to collapse storm into one entry |
| 4 | [#1076](https://github.com/rapartlu/agent-orchestrator/issues/1076) | **Telegram alert on already-in-review storm** — alert when multiple issues are blocked by the same PR across polling cycles; surface the PR-keyed storm pattern to operators |
| 5 | [#1040](https://github.com/rapartlu/agent-orchestrator/issues/1040) | **CI failing on main** — auto-detected CI failure; P1-high bug requiring investigation and fix |
| 6 | [#938](https://github.com/rapartlu/agent-orchestrator/issues/938) | **Dispatch safety audit log** — unified guard event feed for all pre-dispatch safety decisions (antibody, idempotency, lock, affinity); critical for debugging misroutes and blocked dispatches |
| 7 | [#929](https://github.com/rapartlu/agent-orchestrator/issues/929) | **Pre-dispatch semantic duplicate detection** — LLM-based dedup of open issues before dispatching; prevents agents implementing the same feature twice under different titles |
| 8 | [#911](https://github.com/rapartlu/agent-orchestrator/issues/911) | **Score coverage backfill endpoint** — expose `/api/tasks/backfill-scores` in daemon loop to retroactively score tasks missing quality data |
| 9 | [#869](https://github.com/rapartlu/agent-orchestrator/issues/869) | **Auto-route blocked dispatches to PR review queue** — when a dispatch is blocked, immediately surface it for review rather than losing it silently |
| 10 | [#885](https://github.com/rapartlu/agent-orchestrator/issues/885) | **Issue existence validation before dispatch** — stops wasted cycles dispatching to already-closed or nonexistent issues |

---

## Planned

Solid ideas, scoped and ready when Next Up clears.

| # | Issue | What & Why |
|---|-------|-----------|
| 11 | [#874](https://github.com/rapartlu/agent-orchestrator/issues/874) | **Agent name canonicalization** — prevent silent misrouting from name typos or renamed agents (complements the UNKNOWN_AGENT guard) |
| 12 | [#876](https://github.com/rapartlu/agent-orchestrator/issues/876) | **Research agent proactive dispatch** — auto-detect architecture/technology decisions and route them to the research agent before implementation begins |
| 13 | [#992](https://github.com/rapartlu/agent-orchestrator/issues/992) | **Cross-repo security propagation tracker** — detect when a security fix in one agent repo hasn't been applied to peer repos; auto-file propagation issues |
| 14 | [#877](https://github.com/rapartlu/agent-orchestrator/issues/877) | **Decisions dashboard panel** — expose `/api/routing-decisions` in agent-dashboard for visibility into why tasks are routed where they are (needs dashboard-side work) |
| 15 | [#1084](https://github.com/rapartlu/agent-orchestrator/issues/1084) | **New agent: claude-guard-agent** — proposal for a dedicated guard/security agent; needs scoping and capability definition before implementation |

---

## Ideas

Worth tracking but not yet scoped or prioritised.

| # | Issue | What & Why |
|---|-------|-----------|
| 16 | [#1009](https://github.com/rapartlu/agent-orchestrator/issues/1009) | **Predictive failure shield** — pre-score tasks against a failure-probability model before dispatch; high-risk tasks get scope decomposition or context injection before any tokens are spent |
| 17 | [#1010](https://github.com/rapartlu/agent-orchestrator/issues/1010) | **Autonomous fleet self-scaling** — capacity controller that spins up/down agent containers via Docker API based on queue depth and utilization |
| 18 | [#1019](https://github.com/rapartlu/agent-orchestrator/issues/1019) | **Fleet scaling dashboard integration** — metrics endpoint + dashboard panel for fleet capacity observability |
| 19 | [#1025](https://github.com/rapartlu/agent-orchestrator/issues/1025) | **Quality floor bypass alerts** — Telegram alert when a PR is approved despite very low quality score (bypass path) |
| 20 | [#1022](https://github.com/rapartlu/agent-orchestrator/issues/1022) | **Scaling alerting rules and anomaly detection** — dynamic thresholds, multi-metric correlation, anomaly severity classification |
| 21 | [#1038](https://github.com/rapartlu/agent-orchestrator/issues/1038) | **Prompt cache hit rate widget** — dashboard panel + weekly cost savings report from prompt caching (issue #1037 shipped caching; this tracks its ROI) |

---

## Recently Shipped

Key features merged since last triage:

- **#1047/#1052** — closed as shipped: flood gate (PR #1062) writes `dispatch_blocks` to SQLite on first guard fire, covering both in-process and cross-restart cooldown scenarios (2026-04-22)
- **#1083** — PR guard surge: consolidated Telegram alert (one alert per PR, not per issue) when multiple issues are blocked by the same PR (2026-04-22)
- **#1077/#1078** — research agent misrouting detection and redirect: `capability_tags: ["research-only"]` added to `claude-research-agent` in `agents.yaml`; `GET /misrouting` endpoint on metrics server (2026-04-22)
- **#1073/#1074** — exempt `pr-feedback` task type from `open_pr_exists` guard: PR feedback by definition targets an open PR, so the guard was incorrectly blocking reviewer change requests (2026-04-22)
- **#1065** — `/investigations` endpoint on metrics server (port 3472): paginated research task feed with `?limit`, `?offset`, `?status` filters; powers dashboard research panel (2026-04-22)
- **#1069** — inject live issue/PR state into meeting context: each standup now receives up-to-date open issues, open PRs, and 7-day task stats to prevent agents citing stale or closed items (2026-04-22)
- **#1060/#1062** — dispatch flood gate: blocks same-issue guard re-fires within 60-minute cooldown window; only first hit creates a task and Telegram alert (2026-04-22)
- **#1053** — resilient team meetings: zero-response meetings (all Docker connection errors) abandoned without DB save, so scheduler retries next cycle rather than waiting 24h (2026-04-21)
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
