# Claude Agent Orchestrator

## What This Is

The orchestrator is the control plane for a fleet of AI coding agents. Each agent is a persistent CLI session running in a Docker container, managed by the proxy. The orchestrator dispatches work, routes tasks, verifies quality, detects improvements, and manages agent lifecycle.

## Architecture

### Agent Fleet (7 Claude agents + 5 Codex agents across 6 repos)

> **Note:** Codex (OpenAI) pool variants are active alongside the Claude pool — all 5 codex agents are running and dispatching. See provider/model columns in the table below.

| Agent | Port | Model | Pool | Purpose |
|-------|------|-------|------|---------|
| claude-agent-orchestrator | 3472 | claude-opus-4-6 | orchestrator | Core daemon, state store, dispatching, triggers |
| claude-orchestrator-reviewer | 3474 | claude-sonnet-4-6 | reviewer | PR review, verification, supervisor |
| claude-orchestrator-dashboard | 3473 | claude-sonnet-4-6 | dashboard | Dashboard UI, CLI commands, metrics |
| claude-orchestrator-telegram | 3477 | claude-haiku-4-5 | — | Telegram command handling |
| claude-research-agent | 3478 | claude-opus-4-6 | research | Research, investigation, technology evaluation |
| claude-proxy | 3471 | claude-opus-4-6 | proxy | Proxy server, container management |
| meeting-facilitator-agent | 3485 | claude-sonnet-4-6 | — | Meeting facilitation, structured discussions |
| grok-meeting-voice | 3486 | grok-3 | — | Meeting standup voice (facilitation only); active once XAI_API_KEY set |
| deepseek-background | 3487 | deepseek-chat | — | High-volume background workloads; active once DEEPSEEK_API_KEY set |
| deepseek-reasoning | 3488 | deepseek-reasoner | reviewer | Deep reasoning for complex reviews; joins reviewer pool; active once DEEPSEEK_API_KEY set |
| gemini-synth | 3489 | gemini-2.5-pro | — | Long-context synthesis and standup summarisation; active once GEMINI_API_KEY set |

### Repos

| Repo | Owner | Scope |
|------|-------|-------|
| `rapartlu/agent-orchestrator` | This repo | Daemon, state, dispatching, routing, triggers |
| `rapartlu/agent-dashboard` | Dashboard agent | Web dashboard, CLI, metrics |
| `rapartlu/agent-reviewer` | Reviewer pool | PR review, verification, supervisor |
| `rapartlu/research-agent` | Research agent | Findings reports, technology evaluation |
| `rapartlu/agent-proxy` | Proxy agent | CLI wrapper, container management |

### Key Features

- **Multi-provider pools** — Claude + Codex agents run in parallel; both pools are active and dispatching
- **Agent pools** — multiple instances share workload via round-robin (orchestrator, reviewer, dashboard, research, proxy)
- **Persistent sessions** — conversations resume across requests via `x-conversation-id` header
- **Per-agent models** — Opus for coding, Sonnet for reviews, Haiku for Telegram
- **Auto-rebase** — pre-submit validator auto-rebases stale branches before PR creation; proactive rebase scheduler (~15min cadence) prevents stale-branch build failures
- **Telegram bot** — two-way communication: `@TheSupervisor_rapartlu_bot`
- **Antibody log** — pre-dispatch failure prediction filter; blocks known-bad agent/task combos
- **Daemon lifecycle auditor** — immutable audit trail of daemon start/stop/restart events
- **Iteration cost tracking** — per-PR revision cost leaderboard with automatic improvement issue routing
- **Cross-repo feature tracker** — detects feature consistency gaps across Claude/Codex pool members
- **Health check postmortem** — auto-files structured incident reports for recurring health failures
- **Verification calibration** — logs verification outcomes (`verification_outcome_logs`) and polls PR events to build quality-score training data
- **Semantic task memory** — FTS5-based knowledge store; top-3 similar past successes injected into dispatch context at runtime; auto-tunes `min_quality_score` threshold via FTS5 query analysis with per-agent breakdown (issues #1011, #1033)
- **Dispatch cascade analyzer** — tracks parent→child task relationships; enforces per-trigger follow-up depth cap to prevent unbounded task spawning
- **Post-merge regression detector** — validates merged PRs in staging; auto-files revert tasks on regressions
- **Metrics server** — embedded HTTP server on port 3472 exposing `/dispatch-efficiency`, `/health`, `/semantic-memory-effectiveness`, `/investigations`, and `/misrouting` for dashboard and operator polling
- **Housekeeping triage schemas** — verifier enforces structured JSON blocks in housekeeping PR bodies (`TRIAGE_HOUSEKEEPING_SCHEMA`, `TRIAGE_CROSS_REPO_SCHEMA`); missing fields trigger immediate revision
- **Prompt caching** — all static LLM system prompts cached via Anthropic `cache_control: { type: 'ephemeral' }`; dynamic config portions kept variable to avoid cache invalidation; reduces token spend on repeated supervisor/verifier calls (issue #1037)
- **Dispatch waste rate alerting** — `getDispatchWasteMetrics24h()` tracks per-hour rolling window; Telegram alert fires when waste rate exceeds 15% in the most recent hour (`DISPATCH_WASTE_RATE_THRESHOLD = 0.15`) (issue #991)
- **Cross-repo PR guard** — pre-dispatch validator checks all peer agent repos (`config.agents[*].github`) for open non-draft PRs before dispatching; blocks with failure code `open_pr_exists_cross_repo` (issue #991)
- **Dispatch flood gate** — after the PR existence guard fires for a given issue, subsequent guard re-fires within a 60-minute cooldown window (`GUARD_FLOOD_GATE_WINDOW_MS = 3_600_000`) are silently dropped — no task created, no block recorded, no Telegram alert; only the first hit within the window creates a task and sends an alert (issue #1060)
- **Reviewer-side PR guard cooldown check** — `src/client/pr-guard-cooldown-client.ts` queries the reviewer agent's `/api/pr-guard-cooldowns` endpoint before each dispatch; if an active cooldown is recorded for the (repo, issue) pair, dispatch is suppressed entirely with a structured skip event; fail-open: reviewer outage or timeout returns `{ status: 'unavailable' }` and dispatch proceeds normally (issue #1112)
- **Quality gate pre-approval check** — `src/client/quality-gate-client.ts` calls `POST /api/quality-gate/check` on the reviewer agent immediately before any PR is enqueued for merge; if the gate returns `blocked` the PR receives a "Quality Gate Blocked" comment and is recorded as `request-changes` (not enqueued); if the reviewer is unreachable (timeout, 404, connection refused) the check fails open so reviewer outages never stall the merge queue; closes the #445 bypass hole where the LLM review decision alone could approve without the reviewer's explicit sign-off (PR #1199)
- **Resilient team meetings** — if all agents return connection errors in a standup (e.g. Docker outage), the meeting is abandoned without saving to the DB, so the time-based scheduler retries on the next cycle rather than waiting the full 24-hour cooldown (issue #1053)
- **Agent-initiated meeting requests** — standup Round 1 prompts include `REQUEST MEETING: <topic> [format: <type>]` instructions; `extractMeetingRequests()` (in `src/orchestrator/team-meeting.ts`) scans agent responses and writes `meeting_request` signals to the stigmergy table for the meeting facilitator to evaluate in the next cycle (PR #1115)
- **Meeting priority outcome auto-dispatch** — after every meeting, `extractPriorityOutcomes()` (team-meeting.ts) scans the synthesis for priority rankings, sequencing constraints, and follow-up recommendations, then writes a `meeting_priority_outcome` signal (14-day TTL); `checkPriorityOutcomeSignals()` in daemon.ts reads these signals each cycle and deterministically dispatches the top-ranked open issue to its owning agent — bypassing LLM supervisor reasoning for a direct fast-path (issue #1143)
- **Live meeting context injection** — before each standup, open issues (up to 15/repo), open PRs (up to 10/repo), and 7-day task stats are queried via `gh` CLI and injected into meeting context; prevents agents citing stale or closed issues during standups (issue #1069)
- **Research agent misrouting enforcement** — `capability_tags: ["research-only"]` set on `claude-research-agent` in `agents.yaml`; implementation tasks dispatched to the research agent are blocked and rerouted at dispatch time; `GET /misrouting` metrics endpoint and Slack digest alert for observability (issue #1077)
- **Predictive failure interception** — before every dispatch, scores incoming task title against recent failed tasks via token-overlap Jaccard similarity; injects top-3 failure post-mortems as "Lessons from Similar Failed Tasks" when similarity ≥ 0.6 (`FAILURE_INTERCEPTION_THRESHOLD`); sends Telegram alert at ≥ 0.75; records hits to `failure_interception_logs` table; `GET /failure-interceptions` metrics endpoint (issue #1086/#1093)
- **DAG-based parallel subtask execution** — `DagRuntime` in `src/orchestrator/dag-runtime.ts` decomposes complex multi-agent tasks into a persistent dependency graph (`dag_executions` + `dag_nodes` tables); dispatches independent leaf nodes in parallel (up to 4); gates downstream nodes on upstream completions; non-blocking — `advanceAll()` is called each daemon cycle without blocking the poll loop (issue #1085/#1094)
- **Live operator control plane** — `OperatorControlProcessor` in `src/service/operator-controls.ts` applies pending Telegram-issued directives (pause, resume, redirect, inject, merge) at the start of each daemon cycle before other work is dispatched; directives are persisted to `operator_controls` table and marked applied/failed per execution (issue #1087/#1092)
- **Dispatch surge auto-suppression** — after N≥5 `already_in_review` responses within a 30-minute window, the dispatcher blocks further dispatches for 2 hours; surge state is persisted to SQLite; Telegram alert fires once per surge event; cooldown is visible via `orch signals` (issue #1113, PR #1148)
- **Failure genome routing risk** — `FailureGenomeRouter` scores incoming tasks against the genome of recently failed tasks using token-overlap similarity; high-risk dispatch paths (genome score above threshold) are suppressed or redirected before reaching the agent; integrated into the dispatch pipeline at PR #1155 (issue #1131)
- **Score-0 silent approval block** — verification pipeline rejects tasks that score exactly 0 without an explicit operator bypass; prevents silent pass-through of completely unscored tasks; implemented in PR #1159
- **Standup synthesis retry with transcript fallback** — if the synthesis LLM call fails or returns an empty result, the daemon retries with a raw transcript fallback; prevents zero-item standups from being committed to the DB (PR #1156)
- **Verification calibration recommendations persistence** — after each verification pass, calibration recommendations (score drift, threshold adjustments) are written to the `verification_calibration_recs` table for cross-cycle analysis and operator review (PR #1153)
- **Guard health metrics + already-in-review dedup** — `guard_surge_hits` and `guard_surge_leaks` tables track all guard events and timing-race suppression failures; `hasRecentAlreadyInReviewTask()` skips task creation for already-in-review dupes within 6h; `GET /guard-health` and `orch guard-health` CLI surface suppression effectiveness (PR #1195, issues #1163/#1164)
- **Quality gate pre-approval check** — `quality-gate-client.ts` calls `POST /api/quality-gate/check` on the reviewer before any PR is enqueued for merge; fail-open on reviewer outage; closes the bypass hole from issue #445 (PR #1199)
- **Persistent score anomaly tracking** — `score_anomaly_observations` table persists recurring quality anomalies across daemon cycles; `GET /api/persistent-anomalies` REST endpoint; `orch anomalies` CLI with per-agent/type summaries; daily Telegram digest at 09:00 (PR #1222, issue #1207)
- **Per-agent GitHub App identity** — replaces shared Operator PAT with per-agent GitHub App installation tokens; `src/github-app-auth.ts` handles JWT exchange and token caching; aligns with CHARTER.md Article VII (PR #1221, issue #1210)
- **Multi-provider expansion** — Grok (xAI), Deepseek, and Gemini providers added alongside Claude and Codex pools; four new agents: `grok-meeting-voice` (port 3486), `deepseek-background` (port 3487), `deepseek-reasoning` (port 3488), `gemini-synth` (port 3489); active once operator drops API keys (PR #1220, issue #1211)
- **OrbStack socket recovery** — after Docker socket outage, `resetHttpConnections()` clears stale Anthropic SDK TCP sockets to prevent cascade failures on resume (PR #1218, issue #1216)

## CRITICAL: NEVER Push Directly to Main

**ALL changes MUST go through a PR.** No exceptions, no "quick fixes", no "just a config change."

1. Create a feature branch: `git checkout -b fix/description`
2. Commit your changes
3. Push and create a PR: `gh pr create`
4. Wait for review/merge

- GitHub access is per-agent: use GitHub App installation tokens, not a shared Operator PAT. The canonical migration spec is `docs/github-app-identity-migration.md`.

## CRITICAL: Scope Boundaries

This repo owns **core infrastructure only**:

**Owns:** daemon loop, state store (SQLite), task dispatching, trigger polling, agent deployment/sync, routing, planning, execution, Telegram bot.

**Does NOT own:**
- Dashboard, CLI UI → `rapartlu/agent-dashboard`
- PR reviewer, verifier, supervisor → `rapartlu/agent-reviewer`
- Proxy server, containers → `rapartlu/agent-proxy`
- Research reports → `rapartlu/research-agent`

## Management API

Agent lifecycle via the proxy management API (port 3400):

```bash
# List agents
curl http://localhost:3400/v1/agents

# Create agent
curl -X POST http://localhost:3400/v1/agents -H "Content-Type: application/json" \
  -d '{"name":"...", "project":"...", "port":3472, "session":"fresh", ...}'

# Update/rebuild agent
curl -X PUT http://localhost:3400/v1/agents/<name> -H "Content-Type: application/json" -d '{...}'

# Start/stop
curl -X POST http://localhost:3400/v1/agents/<name>/start
curl -X POST http://localhost:3400/v1/agents/<name>/stop

# Rebuild Docker image (all agents get new image on next recreate)
curl -X POST http://localhost:3400/v1/rebuild

# Delete
curl -X DELETE http://localhost:3400/v1/agents/<name>
```
**Important:** The management API is in-memory — registrations are lost on proxy restart. The daemon syncs agents on startup from `agents.yaml`.

## Telegram Bot

Two-way communication via `@TheSupervisor_rapartlu_bot`:

| Command | What it does |
|---------|-------------|
| `s` / `summary` | Executive briefing: health, shipped, attention, WIP |
| `stats` | Detailed metrics: throughput, backlog, pool distribution |
| `status` | Agent status |
| `health` | Ping all containers |
| `issues` | Open issues across repos |
| `prs` | Open PRs across repos |
| `chat <agent> <msg>` | Direct conversation (persistent) |
| `newchat <agent>` | Reset conversation |
| `issue <idea>` | Create issue from rough description |
| `dispatch <agent> <msg>` | Send task to agent |
| `standup-quality [agent] [days]` | Per-agent standup quality sparkline, avg score, trend, and low-streak alert (issue #591) |

Telegram polls independently every 3 seconds (not tied to daemon cycles).
Config: `~/.claude-orchestrator/.env` (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).

## Daemon Poll Cycle

Every 5 minutes (default; configurable via `--poll-interval`):
1. **Telegram polling** (independent 3s loop)
2. **Stale task watchdog** — kill tasks stuck >10 min (configurable per agent)
3. **Retry failed tasks** — exponential backoff, 3 retries max
4. **Dispatch triggers** — poll GitHub issues, dispatch to agents (pool-aware, with semantic memory context injection); cross-repo PR guard checks all peer repos before dispatching to block `open_pr_exists_cross_repo` failures
5. **Verify completed tasks** — LLM scores quality, dispatches revisions; enforces housekeeping triage schema
6. **Create orphan PRs** — auto-rebase stale branches, create PRs
7. **Proactive rebase** — every ~15min, rebase stale branches before they fall behind origin/main
8. **Review open PRs** — approve/merge, request changes, or escalate
9. **Merge queue** — sequential merges per repo to avoid conflicts; cascade cap enforced pre-merge
10. **Redeploy stale agents** — skip busy agents, health check after deploy
11. **Preventive restart** — every ~50 min, restart idle containers
12. **Supervisor** — every ~15min, strategic reasoning, dispatch decisions
13. **Backlog triage** — every ~5h, dispatch housekeeping to agents (staggered by `housekeeping_offset_cycles`)
14. **Post-merge regression check** — validates staging after merges, auto-files revert tasks on failures
15. **Semantic memory audit** — every ~24h, evaluates FTS5 memory effectiveness (zero-match rate tracking, query quality analysis), auto-tunes `min_quality_score` threshold, and provides per-agent memory breakdown
16. **Roadmap proposals** — every ~24h, proposes new issues based on coverage gap detection

## Pool Routing

Agents with the same `pool` field in `agents.yaml` share workload:

- **LLM calls** (reviews, verification, supervisor): round-robin across pool members
- **Dispatched tasks**: picks first idle pool member
- **Router**: scores one agent per pool, dispatcher resolves to idle instance
- **Dedup**: source_ref-based (pool-safe)

## Session Persistence

Conversations persist across requests:
- Orchestrator generates `conversation_id` per task (stored in DB)
- Passed as `x-conversation-id` header to proxy
- Proxy maps to CLI session UUID via `--resume`
- Session map persisted to disk (`~/.claude/session-map.json`)
- Telegram chat conversations persisted to `~/.claude-orchestrator/telegram-chats.json`

## Configuration (agents.yaml)

```yaml
proxy:
  url: "http://localhost:3457"
  manager_url: "http://localhost:3400"
  timeout_ms: 900000
  ssh_key: "~/.ssh/claude-proxy-agents"

verification:
  enabled: true
  sources: ["github", "linear"]
  min_score: 0.7      # minimum quality score to approve a task
  max_revisions: 1    # max LLM-driven revision attempts per task

escalation:
  retry_limit: 3
  max_followup_depth: 3   # cap follow-up chain depth before routing to escalation queue

# Optional: define custom task types (built-ins: implementation, research, facilitation)
task_types:
  planning:
    verification_prompt: "..."
    prompt_header: Planning Request
    result_header: Agent Plan
    dimensions: [feasibility, completeness, risk_assessment, clarity]

agents:
  agent-name:
    dir: "repo-directory"
    repo: "git@github.com:owner/repo.git"  # enables auto-deploy + volume isolation
    pool: "pool-name"                       # optional: pool for load balancing
    model: "claude-opus-4-6"                # per-agent model selection
    description: "What this agent does"
    capabilities: ["typescript", "api"]
    owns_topics: ["keyword1", "keyword2"]
    github: "owner/repo"                    # for GitHub issue polling
    housekeeping_offset_cycles: 0           # stagger housekeeping within each 5h window
    auto_reroute_rejection_threshold: 4     # auto-reroute after N consecutive rejections
    docker:
      port: 3472
      api_key: "secret"
      permissions: "bypassPermissions"
      session: "fresh"
src/
  index.ts                          — package entry point; exports all public modules
  config.ts                         — ReviewerConfig type and defaults
  notify.ts                         — Notifier interface; Telegram + dashboard alert queue
  health-recovery.ts                — health degraded/recovering detection and reporting
  supervisor-log.ts                 — queryable supervisor decision log
  client/
    llm-client.ts                   — Anthropic SDK wrapper; prompt-caching support
  github-app-auth.ts                — GitHub App JWT exchange + installation-token cache for per-agent identities
  config/
    security-allowlist.ts           — shared example/template file patterns (synced with agent-proxy)
  reviewer/
    pr-reviewer.ts                  — PR review: LLM eval, approve/request-changes/escalate
    verifier.ts                     — task verification: 0-1 score, dimension breakdown, second-pass
    supervisor.ts                   — strategic system-state reasoning, dispatch decisions
    improvement-detector.ts         — analyze task patterns, surface improvement candidates
    score-calibrator.ts             — score → outcome feedback loop; threshold recommendations
    calibration-drift.ts            — score distribution drift alerts with dedup cooldown
    pr-iteration-metrics.ts         — multi-round PR review patterns and coaching directives
    routing-accuracy.ts             - per-agent quality stats to inform routing preferences
    reroute-quality-tracker.ts      - reroute decision correlation with quality outcomes; degradation detection
    reroute-conflict-recovery.ts    - conflict-recovery routing metrics and Telegram alerts
    schema-impact.ts                - schema-consumer map; inject consumer notice into reviews
    schema-contract.ts              — schema contract drift detection (CREATE/ALTER/INSERT column checks)
    schema-contract.json            — checked-in registry of canonical column names per shared table
    schema-consumer-registry.ts     — dynamic schema-consumer map auto-discovered from state.db access logs
    quality-anomalies.ts            — quality anomaly feed: approvals where score contradicts PR outcome
    agent-trends.ts                 — agent performance trend analysis (rolling quality averages)
    health-incident-router.ts       — health incident routing and severity classification
    standup-dispatch-guard.ts       — blocks standup dispatch when zero action items remain
    issue-age.ts                    — issue age bucketing and severity (0-7d / 7-14d / 30d+)
    issue-creator.ts                — create GitHub issues for detected improvements
    standup-handler.ts              — zero-action standup handling; synthesis retry (up to 2x)
    standup-batch-splitter.ts       — split large standup batches into prioritized sequential child tasks
    triage-coaching.ts              — per-agent quality coaching directives injected into housekeeping prompts
    duplicate-dispatch-surge-detector.ts — detect surge in duplicate dispatches and send Telegram alert
    pr-existence-guard.ts           — pre-dispatch guard: check if a PR already exists before re-implementing
    score-integrity.ts              — score integrity audit: bucket breakdown and per-task violation list
    threshold-adjuster.ts           — per-verifier threshold auto-adjustment (Phase 2 calibration)
    cli-smoke-test.ts               — lightweight end-to-end smoke tests callable from CLI
    fleet-health-sparklines.ts      — per-agent health sparklines: rolling window of health events
    routing-violations.ts           — detect and surface routing decisions that breach policy rules
    semantic-duplicate-guard.ts     — semantic deduplication of improvement-detector issue candidates
    quality-system-health.ts        — aggregate quality-system health status: score floor, bypass rates, drift
    proactive-rebase-scheduler.ts   — detect stale PRs (≥3 commits behind main, open >24h); emit rebase tasks; track proactive vs reactive rebase counts
    capability-check.ts             — declare eligible task types; reject misrouted foreign implementation tasks
    pre-dispatch-capability-enforcer.ts — hard-block reviewer from accepting implementation tasks at dispatch time
    cross-agent-inflight-guard.ts   — prevent same GitHub issue being dispatched to multiple agents simultaneously
    dispatch-cascade-analyzer.ts    — detect, depth-limit, and cost-track multi-hop task cascades
    quality-floor-bypass-detector.ts — Telegram alert when task approved below 0.80 with no bypass_reason
    meta-quality-gate.ts            — stricter approval floor for quality-enforcement and calibration tasks
    pr-scope-checker.ts             — deterministic bundling/multi-issue detection before LLM review round
    memory-digest.ts                — daily Telegram digest of semantic task memory index; /memory command
    low-score-approval-alerter.ts   — real-time Telegram alert when task approved with score < 0.70
    score-zero-alert.ts             — dedicated alert for catastrophic score ≤ 0.05 approvals; higher-urgency than general low-score alerter
    low-score-feed.ts               — /api/low-score-approved payload builder for operator audit
    score-violations.ts             — /api/score-violations payload: sub-threshold approvals grouped by agent
    misrouting-digest.ts            — daily Telegram digest of implementation tasks dispatched to reviewer; /misrouting [hours] on-demand command
    bypass-audit.ts                 — /api/bypass-audit payload + BypassAuditScheduler daily Telegram digest for sub-0.60-floor approvals; IBypassAuditStore
    universal-quality-gate.ts       — checkApprovalQualityGate() + UniversalQualityGateMonitor; sub-0.80 alert for ALL task types across ALL approval paths
    research-investigation-client.ts — HTTP client for research agent /api/investigations feed; register/activate/complete/cancel lifecycle; `summary()` method for GET /api/investigations/summary snapshot (active_count, last_completed, oldest_in_flight_age); used by improvement-detector when dispatching research tasks
    investigations-feed.ts          — `/investigations` Telegram command: `getInvestigationsFeedPayload()` + `formatInvestigationsForTelegram()`; research feed grouped by status (active/pending/done/cancelled)
    meeting-facilitator-goal.ts     — meeting-facilitator monthly goal widget: `getMeetingFacilitatorGoalWidget()` tracking `core_logic_shipped` (target 1) and `meetings_facilitated` (target 5); `IMeetingFacilitatorGoalStore` wired into `ITelegramStateStore`
    pr-guard-cooldown-feed.ts       — `listActivePRGuardCooldowns(repo?)` bulk query returning all non-expired cooldown entries; `getPRGuardCooldownFeedPayload()` REST payload for `/api/pr-guard-cooldowns` endpoint
    pr-guard-cooldown-check.ts      — `getCooldownCheckPayload()` + `parseCooldownCheckParams()` for `GET /api/pr-guard-cooldown/check?repo=...&issue=N`; per-issue proactive dispatch gate
    triage-health.ts                — per-agent schema failure rates and triage validation stats; powers `/triage-health` Telegram command; reads from `triage_validator_calls` table
    triage-schema-validator.ts      — `POST /api/validate-triage-schema` pre-submission self-check; `validateTriageSchema()` callable by agents before submitting housekeeping results to avoid revision cycles
    low-quality-pr-labeler.ts       — `LowQualityPRLabeler` adds/removes `low-quality` GitHub label on PRs when tasks score below 0.80; hooks into the universal quality gate path
    pr-guard-surge-detector.ts      — `PRGuardSurgeDetector`: surge alert at ≥2 hits/60min; auto-suppression (2h block + Telegram alert with "dispatch suppressed until HH:MM UTC") at ≥5 hits/30min via `IPRGuardCooldownStore`
    score-provenance.ts             — `ScoreSource` type; `parseResponse()` score provenance tagging; `shouldBlockDefaultFallbackApproval()` guard for parse-error zeros; `/api/score-provenance/:task_id`
    persistent-anomalies.ts         — `score_anomaly_observations` persistence; `recordAnomalyObservation()`; `getPersistentAnomalies()`; `/api/persistent-anomalies`
    calibration-recommendations-feed.ts — `calibration_recommendations` persistence + review/resolve feed and high-confidence auto-apply helpers
    fleet-capability-check.ts       — `FLEET_CAPABILITY_MAP` + `evaluateFleetCapability()` + `GET /api/fleet-capability-check`; fleet-wide pre-work capability gate callable by any agent (research-agent#178)
    fork-protocol.ts                — canonical spec and types for `fork_from: conversation_id` dispatch payload field; `DispatchForkSpec`, `buildForkSpec()`, `parseForkFrom()`, `serialiseForkFrom()`, `isExploratoryFork()`, `KNOWN_FORK_LABELS`, `FORK_FROM_MIGRATION_SQL`; Phase 1 shadow-mode spec for session-fork infrastructure (issue #454)
    meeting-outcome-client.ts       — HTTP client for meeting-facilitator agent outcome API (port 3485); `MeetingOutcomeClient` with `fetchOutcome()`, `listOutcomes()`, `summary()`, `extractSupervisorIntelligence()`; `IssueRef`, `PriorityRankingEntry`, `SequencingConstraint`, `MeetingOutcome`, `MeetingOutcomeSummary` types; factory `createMeetingOutcomeClient()` (issue #460)
    meeting-priority-dispatcher.ts  — rule-based fast-path for auto-dispatch from `MeetingOutcome` signals; `evaluateAutoDispatch()` pure function; 7-rule ordered evaluation returning `PriorityDispatchDecision` (`"dispatch"` | `"skip"` | `"defer-to-llm"`); `MeetingPriorityDispatcher` class with `evaluate()` + `filterDispatchable()`; `DispatchEvaluationContext` for caller-supplied fleet state (open PRs, in-flight tasks, merged issues); factory `createMeetingPriorityDispatcher()` (issue #463)
  integration/
    orchestrator-adapter.ts         — createReviewerInstances() adapter for orchestrator import
  service/
    logger.ts                       — structured logger
  state/
    store.ts                        — SQLite state.db read/write helpers
    types.ts                        — shared TypeScript interfaces and type aliases
  telegram/
    command-handler.ts              — /status, /tasks, /approve and other bot commands
  util/
    ulid.ts                         — ULID generation utility for task/event IDs
  __tests__/                        — Vitest unit tests (one file per module)
```

## Metrics Server

An embedded HTTP server starts alongside the daemon on port **3472** (same as the agent port; bound to 127.0.0.1). It is started via `startMetricsServer()` in `src/service/metrics-server.ts`.

| Endpoint | Description |
|----------|-------------|
| `GET /dispatch-efficiency` | 7-day rolling dispatch block-rate metrics (configurable via `?days=N`) |
| `GET /health` | Basic liveness check — returns `{"status":"ok"}` |
| `GET /semantic-memory-effectiveness` | Semantic memory effectiveness metrics (match rates, latency, usefulness) over configurable window (`?days=N`) |
| `GET /investigations` | Research investigation feed — paginated task list with status/quality filters (`?limit=N&offset=N&status=done`) |
| `GET /misrouting` | Research agent implementation-task misroute feed — count + quality histogram for tasks dispatched to research-only agents (`?agent=claude-research-agent&days=N`) |
| `GET /failure-interceptions` | Predictive failure interception feed — interception events with similarity scores, lesson counts, model upgrade suggestions, and final outcomes (`?days=N`) |
| `GET /api/ulid-collisions` | ULID collision log — events where `createTask()` detected a duplicate ULID before INSERT; `createTask()` retries with a fresh ULID so the task still succeeds, but every collision event is logged here for operator audit; any non-empty result warrants ULID generator investigation (issue #1133) |
| `GET /supervisor-decisions` | Supervisor dispatch rationale feed — recent supervisor decisions with agent, action, reason, rationale, issue_refs, hard_gates, and outcome; supports `?limit=N&agent=<name>&days=N` filters; unblocks dashboard #570 (issue #1140) |
| `GET /standup-quality` | Per-agent standup quality trend — chronological score arrays (sparkline-ready), avg/latest scores, trend direction, and low-streak alert flag; supports `?agent=<name>&days=N` (default 30 days); populated by verification loop when standup tasks are scored (issue #591) |
| `GET /marginal-score-tasks` | Tasks with quality scores in a configurable marginal range (default 0.5–0.75) — task feed, daily trend for sparkline, and per-agent breakdown; supports `?days=N&min_score=X&max_score=Y&agent=<name>&limit=N&offset=N` (issue #597) |
| `POST /marginal-score-tasks/:id/redispatch` | Create a re-dispatch task for a marginal-score task; copies description and agent with `[redispatch]` prefix; returns 201 with new task ID (issue #597) |
| `GET /api/persistent-anomalies` | Persistent score anomaly feed — tasks with recurring quality anomalies tracked across cycles; supports `?days=N&min_cycles=N&agent=<name>&limit=N`; returns `{ total, anomalies[] }` (issue #1207) |
| `GET /guard-health` | Guard health metrics — total hits, leaked hits (timing-race suppression failures), duplicate-suppressed hits, active suppressions; supports `?hours=N` (max 720) (issue #1163) |

The dashboard agent polls `/dispatch-efficiency` to populate the dispatch efficiency panel without needing CLI access.

## CLI Commands (`orch`)

The `orch` CLI is built from `src/cli/index.ts`. Key command groups:

| Command | Description |
|---------|-------------|
| `orch agents` | List, sync, and inspect fleet agents |
| `orch status` | Task and agent status overview |
| `orch health` | Agent health checks |
| `orch metrics` | Dispatch and quality metrics |
| `orch memory stats` | Semantic memory index size and configuration |
| `orch memory query <text>` | Find similar past tasks (BM25 FTS5 ranking) |
| `orch memory reindex` | Force re-index of all approved tasks |
| `orch memory effectiveness` | Memory quality metrics: match rates, latency, usefulness scores |
| `orch memory autotune` | Show or apply recommended `min_quality_score` adjustment |
| `orch memory query-stats` | FTS5 query analysis: zero-match rates and noisy patterns |
| `orch memory per-agent` | Per-agent semantic memory effectiveness breakdown |
| `orch dispatch-efficiency` | Dispatch waste rate: 24h hourly breakdown, last 8h inline, avg/peak rates |
| `orch decisions` | Routing decisions audit |
| `orch audit` | General audit log |
| `orch preflight` | Pre-PR submission checks (duplicate PR, rebase, conflicts, issue ref) |
| `orch signals` | Dispatch signal and gate event feed |
| `orch fleet` | Fleet scaling observability |
| `orch supervisor-log` | Supervisor decision log |
| `orch antibodies` | Antibody filter management |
| `orch dag` | DAG parallel subtask execution management — list, show, and inspect node status for DAG executions |
| `orch controls` | Operator control plane — list, pause, resume, and redirect in-flight tasks via Telegram-issued directives |
| `orch lineage` | Task lineage and cascade explorer |
| `orch followup-chains` | Follow-up chain depth tracker |
| `orch skip-blockers` | Chronically skipped issue tracker |
| `orch routing-accuracy` | Routing accuracy and mismatch audit |
| `orch routing-mismatches` | Routing mismatch audit: tasks where executed agent ≠ intended agent |
| `orch review-saturation` | Review saturation metrics: ratio of already-in-review dedup responses |
| `orch health-checks` | Health check storm effectiveness panel: dispatched vs suppressed events (24h rolling) |
| `orch agent-gaps` | Coverage gap detection: unowned topics, scope overload, low-confidence routing |
| `orch cost` | Token usage and billing |
| `orch failure-interceptions` | Failure interception panel: pre-dispatch similarity filter hits, lesson injection counts, model upgrade suggestions, and pass/fail outcomes |
| `orch marginal-score-tasks` | Marginal-score task panel: tasks in the borderline quality range (default 50–75%) with daily trend sparkline, per-agent breakdown, and pagination; supports `--days`, `--min-score`, `--max-score`, `--agent`, `--limit`, `--offset`, `--json` (issue #597) |
| `orch anomalies` | Persistent score anomaly feed: tasks with recurring quality anomalies (cycle_count, anomaly_type, last_seen relative time); per-agent and per-type summary; supports `--days`, `--min-cycles`, `--agent`, `--limit`, `--json` (issue #1207) |
| `orch guard-health` | Guard health metrics panel: total guard hits, leaked hits (timing-race), duplicate-suppressed hits, active suppressions with time-remaining; supports `--hours` (1–720, default 24), `--json` (issue #1163) |

Run `orch --help` for the full list. All commands accept `--json` for machine-readable output.

## Tech Stack

- **Runtime:** Node.js 22+ (ES2022, ESNext modules)
- **Language:** TypeScript (strict mode)
- **CLI:** Commander.js
- **State:** SQLite via better-sqlite3 (FTS5 for semantic memory)
- **Build:** tsc (test files excluded via tsconfig)
- **GitHub API:** `gh` CLI
- **IDs:** ULID (`src/utils/ulid.ts`) — time-ordered, collision-safe task IDs

## Monitoring Session — Proactive Recovery

**You must proactively monitor the daemon, agents, and task progress — do not wait for the user to ask.** At the start of every session, set up a recurring monitoring loop using `/loop`:

```
/loop 3m Check daemon status, recent logs, and task progress. Fix issues or dispatch work.
```

This fires every 3 minutes automatically. **The goal is autonomous oversight: you are the operator, not a passive observer.** If something needs attention — fix it. Flag issues to the user only when human input is needed.

This session runs the health monitoring loop and **owns the daemon lifecycle**. When something is broken and a fix is available, execute it immediately — do not report the same issue across multiple checks.

### Automated recovery actions (no confirmation needed)

| Condition | Action |
|-----------|--------|
| Daemon PID missing or process dead | Start: `cd /Users/paultarr/Local/Git/claude-agent-orchestrator && nohup node dist/service/daemon-entry.js --poll-interval 300000 > /dev/null 2>&1 &` |
| Stale PID file (file exists, process dead) | `rm ~/.claude-orchestrator/daemon.pid` then start daemon |
| Daemon running but no new log lines for >15 min | Kill PID and restart |
| Same agents failing deployer health checks 2+ consecutive cycles | `curl -X POST http://localhost:3400/v1/rebuild` |
| Proxy registry empty (0 agents) | `node dist/cli/index.js agents sync` immediately |
| After any daemon start/restart | Always run `node dist/cli/index.js agents sync` — deployer only re-registers stale agents, not all missing ones |
| Docker socket unresponsive (`curl --unix-socket /var/run/docker.sock --max-time 8 http://localhost/ping` times out or EOF) | Detect runtime: `docker context show` returns `orbstack` → `killall OrbStack 2>/dev/null; sleep 5 && open -a OrbStack`; returns `desktop-linux` → `killall Docker 2>/dev/null; sleep 5 && open -a Docker`. Wait ~60s, verify socket ping, then `node dist/cli/index.js agents sync` |

### After any recovery action
- Verify it worked: check PID alive, agents healthy, new log activity
- Report what was done and the result
- If the issue recurs after recovery, file a GitHub issue in `rapartlu/agent-orchestrator`

### Health check cadence
Each check must verify all 6 points: daemon PID, latest cycle timestamp, ERROR lines in last 2 min, task status counts (done/failed/in_progress/escalated), agent health via `curl http://localhost:3400/v1/agents`, and Docker socket responsive (`curl --unix-socket /var/run/docker.sock --max-time 8 http://localhost/ping`). Report issues or confirm healthy.

## Token Rotation (Claude OAuth token)

When a new `CLAUDE_CODE_OAUTH_TOKEN` is provided, deploy it as follows.

### How token auth works
- Token lives in `/Users/paultarr/Documents/Git/claude-proxy/.env` as `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...`
- `generate.sh` reads it and writes to `.secrets/<agent>/oauth_token` (one file per agent)
- `docker-compose.generated.yml` mounts each file as a Docker secret at `/run/secrets/<agent>_oauth_token`
- `entrypoint.sh` exports it as `CLAUDE_CODE_OAUTH_TOKEN` env var before starting the Claude CLI

**Important:** `generate.sh` (full mode) is triggered by the proxy management API (port 3400, `src/manager.ts`) on every agent create/update. It wipes and recreates `.secrets/` each time. Do NOT write `.secrets/` files manually between bash calls — they will be overwritten.

### Rotation procedure

1. **Update `.env`:**
   ```bash
   # Edit /Users/paultarr/Documents/Git/claude-proxy/.env
   # Replace CLAUDE_CODE_OAUTH_TOKEN=<old> with the new token
   ```

2. **Run agents sync** — this registers all agents with the management API, which triggers `generate.sh` for each, writing the new token to all `.secrets/<agent>/oauth_token` files and restarting containers:
   ```bash
   GH_TOKEN="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" \
     node dist/cli/index.js agents sync
   ```

3. **Fix any containers that failed to start** (race condition: secrets wiped mid-rotation):
   ```bash
   # Write secrets and start in one atomic command
   OAUTH="<new-token>"
   GH="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"
   BASE="/Users/paultarr/Documents/Git/claude-proxy/.secrets"
   for agent in claude-orchestrator-telegram claude-agent-orchestrator codex-agent-orchestrator \
     claude-orchestrator-reviewer codex-orchestrator-reviewer claude-orchestrator-dashboard \
     codex-orchestrator-dashboard claude-research-agent codex-research-agent claude-proxy codex-proxy; do
     mkdir -p "$BASE/$agent"
     printf '%s' "$OAUTH" > "$BASE/$agent/oauth_token"
     printf '%s' "$GH" > "$BASE/$agent/gh_token"
     printf '' > "$BASE/$agent/openai_api_key"
     printf '' > "$BASE/$agent/gemini_api_key"
   done
   docker start $(docker ps -a --format "{{.Names}}" | grep "^claude-proxy-" | grep -v "child\|repo") 2>&1
   ```

4. **Verify** all 11 containers are running: `curl -s http://localhost:3400/v1/agents | python3 -c "import json,sys; a=json.load(sys.stdin); print(len(a), [(x['name'],x.get('status')) for x in a])"`

### If agents still show "Not logged in · Please run /login" after rotation

The `.env` path covers the `CLAUDE_CODE_OAUTH_TOKEN` env var injected at container startup. If the Claude CLI inside a container has cached a different (stale) token internally, the env var alone won't fix it. This requires **human interaction**:

```bash
# On the host machine, run:
claude setup-token
# Then restart the affected container so entrypoint.sh re-reads the new secrets
docker restart claude-proxy-<agent-name>-1
```

The `setup-token` command cannot be automated — it opens an OAuth flow or prompts for a token interactively.

## PR Discipline

- One issue, one branch, one PR
- Every PR must include `Closes #N`
- Keep PRs small (<5 files)
- Every commit: `Co-Authored-By: <agent-name> <agent-name@agent>`
- Don't fix unrelated things — create new issues
- Don't add meta-tooling unless asked
