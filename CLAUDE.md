# Claude Orchestrator Reviewer

## What This Is

The quality and oversight layer for the Claude Agent Orchestrator. This repo owns PR review, task verification, supervision, and improvement detection — everything that evaluates and improves agent output quality.

**This container also serves as the LLM backend for the orchestrator.** All PR reviews, task verifications, supervisor decisions, and improvement analysis are routed through this container. Keep it lightweight and responsive.

## System Architecture (context for reviews)

The orchestrator manages a fleet of Claude Code agents, each in a Docker container:

| Agent | Repo | Port | Purpose |
|-------|------|------|---------|
| claude-agent-orchestrator | rapartlu/agent-orchestrator | 3472 | Core daemon, state store, dispatching, triggers |
| claude-orchestrator-dashboard | rapartlu/agent-dashboard | 3473 | Dashboard UI, CLI commands, metrics |
| claude-orchestrator-reviewer | rapartlu/agent-reviewer | 3474 | **This repo** — PR review, verification, supervisor |
| claude-orchestrator-telegram | rapartlu/agent-orchestrator | 3477 | Telegram command handling (Haiku model) |
| claude-research-agent | rapartlu/research-agent | 3478 | Research, investigation, technology evaluation |
| claude-proxy | rapartlu/agent-proxy | 3471 | Proxy server, container management |
| meeting-facilitator-agent | rapartlu/meeting-facilitator-agent | 3485 | Meeting facilitation, structured discussions |

**Daemon loop** runs every 30s: poll GitHub issues → dispatch to agents → verify quality → review PRs → detect improvements → supervisor decisions.

**PR review flow**: reviewer reads diff → LLM evaluates → approve (merge via squash) / request-changes (dispatch feedback to agent) / escalate (notify human via Telegram).

**Task verification**: completed tasks are scored 0–1 by an LLM across four quality dimensions (correctness, completeness, test_coverage, code_quality). Below min_score (0.80) → revision feedback with dimension breakdown dispatched back to agent. Scores in 0.70–0.79 trigger an automatic second-pass review before final rejection. Results persisted to `verification_results` in state.db. Research tasks use a separate prompt with schema compliance scoring and research-specific dimension labels. Housekeeping/triage tasks use a deterministic JSON schema pre-check before the LLM pass (see below).

**Housekeeping/triage schema compliance**: Tasks with `task_type === "housekeeping"` or a title containing `[housekeeping]` must include a JSON block with four required fields before reaching LLM scoring. Missing any field triggers immediate revision with an explicit list of missing fields — no LLM score can override this gate. Required fields (each weighted 0.25; all four must be present for score ≥ 0.80):
- `duplicates_checked` — boolean `true` (confirms a duplicate scan was performed)
- `stale_issues` — array of `{ number, title, action, reason }` (empty `[]` is valid)
- `priority_reordering` — array of `{ issue, old_rank, new_rank, reason }` (empty `[]` is valid)
- `outcome_summary` — non-empty string (1–3 sentence summary)

The `TRIAGE_OUTPUT_SCHEMA` and `TRIAGE_REQUIRED_FIELDS` constants exported from `verifier.ts` (and re-exported from `index.ts`) allow the orchestrator dispatcher to embed the schema template in housekeeping dispatch prompts. `Verifier.checkTriageSchemaCompliance(result)` is a public method for standalone schema checks.

**Marginal approval**: Tasks scoring 0.60–0.74 that are approved include a `marginal_reason` badge surfaced to operators so quality gaps are visible without blocking the task.

**Key conventions:**
- Every PR must have `Closes #N` in the body
- Agents use `Co-Authored-By: <agent-name> <agent-name@agent>` in commits
- One issue, one branch, one PR — no bundling
- PRs with merge conflicts get auto-rebased; if rebase fails, escalate

## Review Guidelines

When this container is used for LLM PR reviews:
- **Default to approve.** Most PRs that work correctly should be approved.
- Only request changes for **real bugs**: runtime failures, security vulnerabilities, data loss.
- **Never block** on style, naming, missing comments, or "could be cleaner" suggestions.
- If minor issues exist, include them in an approval comment.

## Scope

**In scope:**
- PR reviewer: review diffs, approve/request-changes/escalate, auto-rebase
- Task verifier: score completed tasks, approve/reject, dispatch revisions
- Supervisor: strategic reasoning about system state, dispatch decisions
- Improvement detector: analyze task patterns, create issues for improvements
- Escalation system: Telegram notifications, dashboard alert queue
- Score calibrator: close feedback loop between scores and actual PR outcomes
- Calibration drift monitor: alert when score distributions shift significantly
- PR iteration metrics: surface multi-round review patterns and coaching directives
- Routing accuracy tracker: per-agent quality metrics to inform routing decisions
- Reroute quality tracker: flag auto-reroutes that degrade outcomes; identify problematic routing patterns
- Conflict recovery reroute monitor: track conflict-recovery dispatch rates and alert on spikes
- Shared security allowlist: example/template file patterns synchronized with security scanner in agent-proxy
- Schema-consumer impact detection: flag cross-repo schema changes in PR reviews
- Standup handler: process zero-action standups; retry failed synthesis; split large batches into child tasks
- Health recovery: detect and report agent degraded/recovering transitions
- Supervisor log: queryable decision log for CLI and dashboard consumers
- Score integrity audit: bucket breakdown and violation list for approved tasks with low scores
- Duplicate-dispatch surge detector: alert when dispatch volume for a single issue spikes anomalously
- Pre-dispatch PR existence guard: prevent re-implementation when a PR already exists for an issue
- Per-verifier threshold auto-adjustment: Phase 2 calibration that adapts `min_score` per verifier instance
- Per-agent quality coaching: inject agent-specific coaching directives into housekeeping task prompts
- CLI smoke tests: lightweight end-to-end checks callable from CLI to verify core reviewer paths
- Fleet health sparklines: per-agent rolling health event windows surfaced to dashboard and Telegram
- Routing violation detection: surface routing decisions that breach configured policy rules
- Semantic duplicate guard: deduplicate improvement-detector issue candidates using semantic similarity
- Quality system health: aggregate health status covering score floor, bypass rates, and calibration drift
- Proactive rebase scheduler: detect PRs ≥3 commits behind main that have been open >24h; emit rebase tasks; count proactive vs reactive rebases separately
- Pre-dispatch capability enforcer: declare eligible task types and reject misrouted foreign implementation tasks
- Cross-agent in-flight guard: prevent the same GitHub issue being dispatched to multiple agents simultaneously
- Dispatch cascade analyzer: detect, depth-limit, and cost-track task chains spawned from a single trigger
- Quality floor bypass detector: Telegram alert when a task is approved below 0.80 with no explicit bypass_reason
- Meta-quality gate: stricter approval floor for tasks whose scope is quality enforcement or calibration
- PR scope pre-flight check: deterministic bundling detection before LLM review is triggered
- Semantic task memory: daily Telegram digest summarising the semantic task memory index; `/memory` command
- Research investigation client: HTTP client for the research agent's investigation feed API (`/api/investigations`); registers new investigations when research tasks are dispatched, activates them when work begins, completes them with findings + result issue URL after `analyzeResearchFindings()` converts a report into a GitHub issue; `summary()` method calls `GET /api/investigations/summary` for lightweight snapshots (active_count, last_completed, oldest_in_flight_age)
- Real-time low-score approval alerter: Telegram notification when a task is approved with score < 0.70
- Score-zero approval alerter: dedicated real-time Telegram alert for catastrophic score ≤ 0.05 approvals with full dimension breakdown
- Low-score approved task feed: `/api/low-score-approved` payload builder for operator audit
- Score-bypass violation report: `/api/score-violations` payload listing sub-threshold approvals by agent
- Misrouting digest: daily Telegram summary of all tasks dispatched to the reviewer that matched implementation patterns; `/misrouting [hours]` on-demand command
- Bypass-audit endpoint: `/api/bypass-audit` payload builder listing all tasks approved below the 0.60 quality floor in a rolling window with `bypass_reason` (or 'none' for silent bypasses); `BypassAuditScheduler` sends a daily Telegram digest with count and worst offender
- PR guard cooldown: `pr_guard_cooldown` table in `state.db` — written when the PR existence guard returns `already-in-review`; `isPRGuardCooldownActive()` prevents re-queuing the same issue for 60 min without a second gh CLI call
- old_rank pre-submission validator: `validateOldRankInPriorityReordering()` — deterministic checker for `priority_reordering` entries where `old_rank` should be `null` (newly-added issues); embedded as a pre-submission checklist in the triage coaching prompt
- Per-agent triage coaching with `validation_pre_check_passed`: coaching directive now carries `validation_pre_check_passed: boolean | null` and exposes validator results for prior submissions in the prompt banner
- Universal quality gate: `checkApprovalQualityGate(task, notifier)` pure function + `UniversalQualityGateMonitor` class; catches sub-0.80 approvals across ALL task types and ALL approval paths (verify callback, orchestrator short-circuit, operator `/approve`, cross-repo follow-ups); no task-type exemptions
- Triage schema pre-submission validator: `POST /api/validate-triage-schema` endpoint allows agents to self-check housekeeping JSON blocks before submission, reducing revision cycles
- Triage health dashboard: `/triage-health` Telegram command exposes per-agent schema failure rates and validator call counts from `triage_validator_calls` table; triage revision-rate before/after metrics
- Investigations feed: `/investigations` Telegram command shows research agent investigation feed (active, pending, done, cancelled) via `investigations-feed.ts`
- Meeting-facilitator goal widget: monthly goal tracking for the meeting-facilitator agent (`meeting-facilitator-goal.ts`) — `core_logic_shipped` and `meetings_facilitated` targets surfaced to operators
- PR guard cooldown feed: `listActivePRGuardCooldowns()` bulk query + `/api/pr-guard-cooldowns` REST endpoint (`pr-guard-cooldown-feed.ts`) for dashboard-level flood gate visibility

**Out of scope (belongs to orchestrator-core):**
- Daemon loop, state store, dispatching infrastructure
- GitHub/Linear/Slack trigger polling
- Agent deployment, container management

**Out of scope (belongs to dashboard):**
- Web UI, CLI commands, activity views

## Source Layout

```
src/
  index.ts                          — package entry point; exports all public modules
  config.ts                         — ReviewerConfig type and defaults
  notify.ts                         — Notifier interface; Telegram + dashboard alert queue
  health-recovery.ts                — health degraded/recovering detection and reporting
  supervisor-log.ts                 — queryable supervisor decision log
  client/
    llm-client.ts                   — Anthropic SDK wrapper; prompt-caching support
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
    triage-health.ts                — per-agent schema failure rates and triage validation stats; powers `/triage-health` Telegram command; reads from `triage_validator_calls` table
    triage-schema-validator.ts      — `POST /api/validate-triage-schema` pre-submission self-check; `validateTriageSchema()` callable by agents before submitting housekeeping results to avoid revision cycles
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

## Tech Stack

- TypeScript (ESM, `"type": "module"`)
- `@anthropic-ai/sdk` — LLM calls (review, verify, supervise)
- `better-sqlite3` — synchronous SQLite access to shared state.db
- `gh` CLI — PR operations (approve, merge, request-changes)
- Vitest — unit tests

## Commands

```bash
npm run build      # tsc compile to dist/
npm test           # vitest run (single pass)
npm run test:watch # vitest watch mode
```

## PR Discipline

- One issue, one branch, one PR
- Every PR must include `Closes #N`
- Keep PRs small (<5 files)
- Every commit must end with: `Co-Authored-By: claude-orchestrator-reviewer <claude-orchestrator-reviewer@agent>`
