# Agent Orchestrator — Roadmap

This is the prioritised backlog for `rapartlu/agent-orchestrator`. Updated 2026-04-25 (pass 11 — triage pass).

---

## Next Up

These are the most impactful items — highest signal-to-noise for the fleet.

| # | Issue | What & Why |
|---|-------|-----------|
| 1 | [#1040](https://github.com/rapartlu/agent-orchestrator/issues/1040) | **CI failing on main** — auto-detected CI failure; P1-high bug requiring investigation and fix to unblock PR merges |
| 2 | [#1157](https://github.com/rapartlu/agent-orchestrator/issues/1157) | **PR guard cooldown non-functional** — confirmed: agent-proxy#455 hit 6 times in one dispatch batch; cooldown keying is wrong and needs a fix before the next flood |
| 3 | [#1158](https://github.com/rapartlu/agent-orchestrator/issues/1158) | **Dispatch surge suppression not cross-wired to PR guard hits** — newly shipped surge suppression (PR #1148) counts task dispatches but not PR guard fires; guard storms bypass the surge cap entirely |
| 4 | [#1121](https://github.com/rapartlu/agent-orchestrator/issues/1121) | **Preventive restart blocks on disabled Codex agents** — `no_port` health-check failures on disabled Codex agents loop the preventive-restart cycle; skip restart for agents with no configured port |
| 5 | [#1096](https://github.com/rapartlu/agent-orchestrator/issues/1096) | **PR merge does not clear blocked issue backlog** — after a PR merges, issues immediately re-block on the next open PR; need to auto-resolve referenced issues at merge time |
| 6 | [#1149](https://github.com/rapartlu/agent-orchestrator/issues/1149) | **Dangling pattern_risk signals** — `pattern_risk` is written to the stigmergy table but has no consumer in the pattern-learning loop; remove or wire it |
| 7 | [#1132](https://github.com/rapartlu/agent-orchestrator/issues/1132) | **Improvement detector batch deduplication guard** — prevent the improvement detector from queuing the same improvement issue multiple times in a single scan batch |
| 8 | [#869](https://github.com/rapartlu/agent-orchestrator/issues/869) | **Auto-route blocked dispatches to PR review queue** — when a dispatch is blocked, immediately surface it for review rather than losing it silently |

---

## Planned

Solid ideas, scoped and ready when Next Up clears.

| # | Issue | What & Why |
|---|-------|-----------|
| 9 | [#1038](https://github.com/rapartlu/agent-orchestrator/issues/1038) | **Prompt cache hit rate dashboard widget** — dashboard panel + Telegram `cache` command + auto-tuning alert; closes the loop on token spend reduction from issue #1037 |
| 10 | [#911](https://github.com/rapartlu/agent-orchestrator/issues/911) | **Score coverage backfill endpoint** — expose `/api/tasks/backfill-scores` in daemon loop to retroactively score tasks missing quality data |

---

## Ideas

Worth tracking but not yet scoped or prioritised.

| # | Issue | What & Why |
|---|-------|-----------|
| 12 | [#1010](https://github.com/rapartlu/agent-orchestrator/issues/1010) | **Autonomous fleet self-scaling** — capacity controller that spins up/down agent containers via Docker API based on queue depth and utilization |
| 13 | [#1088](https://github.com/rapartlu/agent-orchestrator/issues/1088) | **Persistent cross-task knowledge graph with RAG injection** — index merged PR diffs + verification scores into a vector store; inject top-5 similar past solutions at dispatch time for compounding intelligence advantage |

---

## Recently Shipped

Key features merged since last triage:

- **#1159** (PR #1159) — block score-0 silent approval: verification pipeline now rejects tasks that score 0 without explicit bypass (2026-04-25)
- **#1156** (PR #1156) — standup synthesis retry with transcript fallback: prevents zero-item standups when synthesis fails (2026-04-25)
- **#1131** (PR #1155) — wire failure genome risk into live dispatcher routing: genome similarity now actively suppresses high-risk dispatch paths (2026-04-25)
- **#1153** (PR #1153) — persist verification calibration recommendations: recommendations written to DB for cross-cycle analysis (2026-04-24)
- **#1151** (PR #1151) — close dangling loops: auto-file action items and apply goal adjustments from meeting outcomes (2026-04-24)
- **#1113** (PR #1148) — dispatch surge auto-suppression: blocks further dispatch for 2h after N≥5 already-in-review responses within 30 min (2026-04-24)
- **#1145** (PR #1147) — prune 6 orphan branches with no open PR (2026-04-24)
- **#1133** (PR #1137) — ULID collision detection, retry, and `/api/ulid-collisions` endpoint (2026-04-24)
- **#1143** (PR #1144) — meeting priority outcome auto-dispatch: top-ranked open issue dispatched deterministically after each meeting (2026-04-24)
- **#1112** (PR #1117) — enforce PR guard cooldown at dispatch time: query reviewer's `/api/pr-guard-cooldowns` before dispatching (2026-04-23)
- **#1086/#1093** — predictive failure interception: pre-dispatch task similarity scoring; top-3 failure post-mortems injected when similarity ≥ 0.6 (2026-04-23)
- **#1085/#1094** — DAG-based parallel subtask execution: `DagRuntime` decomposes complex tasks into dependency graph (2026-04-23)
- **#1087/#1092** — live operator control plane: pause, resume, redirect, inject directives via Telegram (2026-04-23)
- **#1047/#1052** — dispatch flood gate: blocks same-issue guard re-fires within 60-minute cooldown window (2026-04-22)
- **#1077/#1078** — research agent misrouting detection: `capability_tags: ["research-only"]`; `GET /misrouting` endpoint (2026-04-22)
- **#1011** — shared semantic task memory: FTS5-based knowledge store (2026-04-19)
- **#992** (PR #994) — cross-repo security propagation tracker (2026-04-19)
- **#1025** (PR #1035) — quality floor bypass alerts in Telegram bot (2026-04-19)
