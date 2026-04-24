# Agent Orchestrator — Roadmap

This is the prioritised backlog for `rapartlu/agent-orchestrator`. Updated 2026-04-24 (pass 9 — triage PR).

---

## Next Up

These are the most impactful items — highest signal-to-noise for the fleet.

| # | Issue | What & Why |
|---|-------|-----------|
| 1 | [#1040](https://github.com/rapartlu/agent-orchestrator/issues/1040) | **CI failing on main** — auto-detected CI failure; P1-high bug requiring investigation and fix to unblock PR merges |
| 2 | [#1131](https://github.com/rapartlu/agent-orchestrator/issues/1131) | **Wire failure genome into live routing** — shadow-mode vaccination prototype (in agent-proxy) has been running; once accuracy >60% is confirmed, promote genome similarity results from log-only to live dispatch suppression |
| 3 | [#1121](https://github.com/rapartlu/agent-orchestrator/issues/1121) | **Preventive restart blocks on disabled Codex agents** — `no_port` health-check failures on disabled Codex agents loop the preventive-restart cycle; skip restart for agents with no configured port |
| 4 | [#1096](https://github.com/rapartlu/agent-orchestrator/issues/1096) | **PR merge does not clear blocked issue backlog** — after a PR merges, issues immediately re-block on the next open PR; need to auto-resolve referenced issues at merge time |
| 5 | [#1106](https://github.com/rapartlu/agent-orchestrator/issues/1106) | **Cross-repo follow-up: all orchestrator dispatches failing with 405** — dispatch endpoint returning 405 on every task; highest-impact blocker |
| 6 | [#1113](https://github.com/rapartlu/agent-orchestrator/issues/1113) | **Dispatch surge auto-suppression** — alerting alone insufficient after 11-task flood; extend surge detector to block further dispatch for 2h after N≥5 already-in-review responses within 30 min |
| 7 | [#1075](https://github.com/rapartlu/agent-orchestrator/issues/1075) | **PR guard cooldown keyed by PR number** — cooldown is per-issue; 12+ issues blocked by same PR each re-queue independently; re-key by PR number to collapse storm into one entry |
| 8 | [#1061](https://github.com/rapartlu/agent-orchestrator/issues/1061) | **Hard quality floor for cross-repo triage follow-ups** — cross-repo housekeeping tasks scoring 0.42–0.51 are being approved; enforce minimum 0.60 floor for triage schema compliance |
| 9 | [#938](https://github.com/rapartlu/agent-orchestrator/issues/938) | **Dispatch safety audit log** — unified guard event feed for all pre-dispatch safety decisions; critical for debugging misroutes and blocked dispatches |
| 10 | [#929](https://github.com/rapartlu/agent-orchestrator/issues/929) | **Pre-dispatch semantic duplicate detection** — LLM-based dedup of open issues before dispatching; prevents agents implementing the same feature twice under different titles |

---

## Planned

Solid ideas, scoped and ready when Next Up clears.

| # | Issue | What & Why |
|---|-------|-----------|
| 11 | [#911](https://github.com/rapartlu/agent-orchestrator/issues/911) | **Score coverage backfill endpoint** — expose `/api/tasks/backfill-scores` in daemon loop to retroactively score tasks missing quality data |
| 12 | [#869](https://github.com/rapartlu/agent-orchestrator/issues/869) | **Auto-route blocked dispatches to PR review queue** — when a dispatch is blocked, immediately surface it for review rather than losing it silently |
| 13 | [#992](https://github.com/rapartlu/agent-orchestrator/issues/992) | **Cross-repo security propagation tracker** — detect when a security fix in one agent repo hasn't been applied to peer repos; auto-file propagation issues |
| 14 | [#1025](https://github.com/rapartlu/agent-orchestrator/issues/1025) | **Quality floor bypass alerts in Telegram bot** — persist bypass events to SQLite; `/quality-bypasses` command returns last 10 bypass events; daily summary includes bypass count |
| 15 | [#1038](https://github.com/rapartlu/agent-orchestrator/issues/1038) | **Prompt cache hit rate dashboard widget** — dashboard panel + Telegram `cache` command + auto-tuning alert; closes the loop on token spend reduction from issue #1037 |
| 16 | [#1132](https://github.com/rapartlu/agent-orchestrator/issues/1132) | **Improvement detector batch deduplication guard** — prevent the improvement detector from queuing the same improvement issue multiple times in a single scan batch |
| 17 | [#1122](https://github.com/rapartlu/agent-orchestrator/issues/1122) | **Orphan branch cleanup** — 5 auto-detected branches with no open PR; prune to reduce repo noise |

---

## Ideas

Worth tracking but not yet scoped or prioritised.

| # | Issue | What & Why |
|---|-------|-----------|
| 16 | [#1010](https://github.com/rapartlu/agent-orchestrator/issues/1010) | **Autonomous fleet self-scaling** — capacity controller that spins up/down agent containers via Docker API based on queue depth and utilization |
| 17 | [#1088](https://github.com/rapartlu/agent-orchestrator/issues/1088) | **Persistent cross-task knowledge graph with RAG injection** — index merged PR diffs + verification scores into a vector store; inject top-5 similar past solutions at dispatch time for compounding intelligence advantage |

---

## Recently Shipped

Key features merged since last triage:

- **#1133** (PR #1137) — ULID collision detection, retry, and `/api/ulid-collisions` endpoint: `createTask()` retries with fresh ULID on collision; `ulid_collision_log` table persists every event for operator audit (2026-04-24)
- **Agent meeting requests** (PR #1115) — standup Round 1 prompts now include `REQUEST MEETING: <topic>` instructions; `extractMeetingRequests()` writes `meeting_request` signals to the stigmergy table for the meeting facilitator to evaluate (2026-04-23)
- **June goal metric evaluators** (PR #1116) — enables real progress tracking in the dashboard for June objectives (2026-04-23)
- **#1120** — restored 5 Codex agents to all pools (infrastructure; no issue ref) (2026-04-23)
- **#1112** — cross-repo PR guard cooldown enforcement at dispatch time: query reviewer's `/api/pr-guard-cooldowns` before dispatching; suppress entirely if cooldown active (2026-04-23)
- **#1086/#1093** — predictive failure interception: pre-dispatch task similarity scoring; top-3 failure post-mortems injected when similarity ≥ 0.6 (2026-04-23)
- **#1085/#1094** — DAG-based parallel subtask execution: `DagRuntime` decomposes complex tasks into dependency graph; dispatches independent leaf nodes in parallel (up to 4) (2026-04-23)
- **#1087/#1092** — live operator control plane: pause, resume, redirect, inject directives via Telegram; `OperatorControlProcessor` applies at start of each daemon cycle (2026-04-23)
- **#1095/#1097** — atomic PR guard cooldown lock: prevents duplicate guard-hit tasks via SQLite transaction lock (2026-04-23)
- **#1101/#1102** — fix: bypass open_pr_exists guard for rerouted pr-feedback tasks; tighten pr-feedback skip regex (2026-04-23)
- **#1047/#1052** — closed as shipped: flood gate (PR #1062) writes `dispatch_blocks` to SQLite on first guard fire, covering both in-process and cross-restart cooldown scenarios (2026-04-22)
- **#1083** — PR guard surge: consolidated Telegram alert (one alert per PR, not per issue) when multiple issues are blocked by the same PR (2026-04-22)
- **#1077/#1078** — research agent misrouting detection and redirect: `capability_tags: ["research-only"]` added to `claude-research-agent` in `agents.yaml`; `GET /misrouting` endpoint on metrics server (2026-04-22)
- **#1073/#1074** — exempt `pr-feedback` task type from `open_pr_exists` guard (2026-04-22)
- **#1065** — `/investigations` endpoint on metrics server (port 3472): paginated research task feed (2026-04-22)
- **#1069** — inject live issue/PR state into meeting context (2026-04-22)
- **#1060/#1062** — dispatch flood gate: blocks same-issue guard re-fires within 60-minute cooldown window (2026-04-22)
- **#1053** — resilient team meetings: zero-response meetings abandoned without DB save (2026-04-21)
- **#991/#1048** — dispatch waste rate metric, 15% Telegram alert, cross-repo PR guard (2026-04-21)
- **#1049** — reduce Telegram noise: stop alerting on removed agents + daily stuck-issue cap (2026-04-21)
- **#1045** — auto-restart Docker/OrbStack when proxy outage detected (2026-04-21)
- **#1044** — fix proxy alert flapping: rolling window + recovery debounce (2026-04-20)
- **#1039** — bypass reason validation for `/approve` with very low scores (2026-04-20)
- **#1037** — prompt caching on all LLM system prompts to reduce token spend (2026-04-20)
- **#1028/#1033** — semantic memory effectiveness dashboard + auto-tuning (2026-04-19)
- **#1032** — CI: path filtering, caching, and self-hosted runner support (2026-04-19)
- **#1011** — shared semantic task memory: FTS5-based knowledge store (2026-04-19)
- **#1000** — fix: dispatch coordination group child tasks stuck at pending (2026-04-19)
- **#956** — enable auto-merge in daemon merge queue (2026-04-18)
- **#943** — fix 3 CI test failures on main (2026-04-18)
- **#940** — remove Codex agents from pool routing (2026-04-18)
- **#937** — Telegram approval queue: rich task context card (2026-04-18)
- **#935** — duplicate task ID detection and alerting (2026-04-18)
- **#928** — repo-to-agent affinity guardrail (2026-04-18)
- **#927** — in-flight dispatch reservation to prevent concurrent dual implementations (2026-04-18)
- **#908** — reduce LLM call timeouts to 2 min to prevent DEADLOCK (2026-04-18)
- **#905** — verification outcome logs + PR events poller (2026-04-17)
- **#879** — auto-file improvement issues from health incident post-mortems (2026-04-15)
- **#868** — pre-dispatch open-PR deduplication (2026-04-15)
- **#867** — UNKNOWN_AGENT guard: reject dispatches to unregistered agents (2026-04-15)
