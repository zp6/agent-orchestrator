# Agent Orchestrator — Roadmap

This is the prioritised backlog for `rapartlu/agent-orchestrator`. Updated 2026-04-27 (pass 12 — triage pass).

---

## Next Up

These are the most impactful items — highest signal-to-noise for the fleet.

| # | Issue | What & Why |
|---|-------|-----------|
| 1 | [#1040](https://github.com/rapartlu/agent-orchestrator/issues/1040) | **CI failing on main** — auto-detected CI failure; P1-high bug requiring investigation and fix to unblock PR merges |
| 2 | [#1166](https://github.com/rapartlu/agent-orchestrator/issues/1166) | **PR guard surge suppression still not stopping flood** — 10 identical tasks created for agent-proxy#455/PR#456 despite suppression being triggered; surge detector keying or state persistence needs a fix |
| 3 | [#1168](https://github.com/rapartlu/agent-orchestrator/issues/1168) | **Cross-agent inflight guard miss** — codex-agent-orchestrator and claude-agent-orchestrator both dispatched for same issues; cross-agent pool dedup not enforced at dispatch time |
| 4 | [#1167](https://github.com/rapartlu/agent-orchestrator/issues/1167) | **Make triage validator mandatory** — triage pre-submission validator should be a hard gate to break the recurring revision cycle on housekeeping PRs |
| 5 | [#1121](https://github.com/rapartlu/agent-orchestrator/issues/1121) | **Preventive restart blocks on disabled Codex agents** — `no_port` health-check failures on disabled Codex agents loop the preventive-restart cycle; skip restart for agents with no configured port |
| 6 | [#1096](https://github.com/rapartlu/agent-orchestrator/issues/1096) | **PR merge does not clear blocked issue backlog** — after a PR merges, issues immediately re-block on the next open PR; need to auto-resolve referenced issues at merge time |
| 7 | [#1149](https://github.com/rapartlu/agent-orchestrator/issues/1149) | **Dangling pattern_risk signals** — `pattern_risk` is written to the stigmergy table but has no consumer in the pattern-learning loop; remove or wire it |
| 8 | [#1132](https://github.com/rapartlu/agent-orchestrator/issues/1132) | **Improvement detector batch deduplication guard** — prevent the improvement detector from queuing the same improvement issue multiple times in a single scan batch |

---

## Planned

Solid ideas, scoped and ready when Next Up clears.

| # | Issue | What & Why |
|---|-------|-----------|
| 9 | [#1196](https://github.com/rapartlu/agent-orchestrator/issues/1196) | **Orchestrator-side already-in-review dedup guard** — standup action item to wire #1164 dedup guard to stop duplicate task accumulation before surge suppression kicks in |
| 10 | [#1197](https://github.com/rapartlu/agent-orchestrator/issues/1197) | **Route meeting_request signals to meeting-facilitator-agent** — standup action item to auto-dispatch meeting requests from stigmergy table to the meeting facilitator to fix 0% meeting-request routing rate |
| 11 | [#869](https://github.com/rapartlu/agent-orchestrator/issues/869) | **Auto-route blocked dispatches to PR review queue** — when a dispatch is blocked, immediately surface it for review rather than losing it silently |
| 12 | [#911](https://github.com/rapartlu/agent-orchestrator/issues/911) | **Score coverage backfill endpoint** — expose `/api/tasks/backfill-scores` in daemon loop to retroactively score tasks missing quality data |

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

- **#1163/#1164** (PR #1195) — guard health metrics + already-in-review dedup: `guard_surge_hits` table, `/guard-health` endpoint, `orch guard-health` CLI, 6h task dedup before surge engages (2026-04-26)
- **#513** (PR #1199) — quality gate pre-approval check: `quality-gate-client.ts` calls reviewer before any PR merge; fail-open on reviewer outage (2026-04-26)
- **#1216** (PR #1218) — reset Anthropic sockets after OrbStack recovery: clears stale TCP connections on Docker socket restore (2026-04-27)
- **#1207** (PR #1222) — persistent anomaly tracking: `score_anomaly_observations` table, `GET /api/persistent-anomalies` endpoint, `orch anomalies` CLI, daily Telegram digest (2026-04-27)
- **#1210** (PR #1221) — per-agent GitHub App identity migration: replaces shared Operator PAT with per-agent installation tokens (2026-04-27)
- **#1211** (PR #1220) — multi-provider expansion: Grok, Deepseek, Gemini providers activated; four new agents (grok-meeting-voice, deepseek-background, deepseek-reasoning, gemini-synth) (2026-04-27)
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
