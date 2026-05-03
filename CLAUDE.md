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
- Improvement detector: analyze task patterns, create issues for improvements; batch deduplication guard prevents identical task-batches from triggering redundant LLM analysis within 6h (`improvement_analysis_runs` table, `computeBatchHash()`)
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
- Standup quality trend tracker: `standup_quality_history` table records (agent, date, score, action_item_count) per standup task; `getStandupQualityTrend()` builds sparkline + avg + `is_degrading` flag when last 3 standups all scored < 0.70; `/standup-quality [agent] [days]` Telegram command (`standup-quality-trend.ts`)
- Score provenance tracker: `score_source` on verification results distinguishes parsed LLM scores from `default_fallback` values; `shouldBlockDefaultFallbackApproval()` lets the orchestrator block silent auto-approval of parse-error zeros (`score-provenance.ts`). **Wired into auto-approval path**: `applyDefaultFallbackGuard()` in `verifier.ts` rejects `default_fallback` scores before they reach the approval stage and fires a high-urgency Telegram alert; the Telegram `/approve` command in `command-handler.ts` also calls this guard so operators cannot manually approve parse-failure zeros.
- Persistent anomaly tracker: `score_anomaly_observations` rows capture recurring quality anomalies across analysis cycles; `getPersistentAnomalies()` and `/api/persistent-anomalies` surface repeated patterns for operators (`persistent-anomalies.ts`)
- Calibration recommendations feed: `calibration_recommendations` persistence plus review/resolve flow for `ScoreCalibrator` recommendations and high-confidence auto-apply (`calibration-recommendations-feed.ts`)
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
- PR guard cooldown check endpoint: `GET /api/pr-guard-cooldown/check?repo=...&issue=N` returns `{ active, expires_at, ttl_remaining_seconds }` for a single (repo, issue) pair; enables orchestrator/proxy to gate dispatch proactively before task creation (`pr-guard-cooldown-check.ts`)
- Low-quality PR labeler: `LowQualityPRLabeler` adds/removes the `low-quality` GitHub label on PRs when tasks score below 0.80; integrates with the universal quality gate path (`low-quality-pr-labeler.ts`)
- Triage-health consecutive-failure cross-link: `fetchConsecutiveFailureBlocks()` async helper checks dashboard `/api/consecutive-failure-detector/blocks`; when an agent has `failure_rate > 50%` and an active block, `/triage-health` appends a warning with a link to the consecutive-failure-detector panel
- PR guard surge detector: `PRGuardSurgeDetector` fires a Telegram alert when the same `(repo, issue)` pair triggers `already-in-review` ≥ 2 times within a 60-minute window; at ≥5 hits within 30 minutes, writes a 2-hour dispatch suppression entry via `IPRGuardCooldownStore` and sends a dedicated alert with "dispatch suppressed until HH:MM UTC" (`pr-guard-surge-detector.ts`)
- PR guard cooldown pre-flight: early cooldown check in `checkPRExistenceBeforeDispatch` returns `skip=true / cooldown-active` before any `gh` CLI call when a 60-min cooldown is active, preventing redundant guard tasks across daemon cycles (`pr-existence-guard.ts`)
- Fleet-wide capability check endpoint: `GET /api/fleet-capability-check?agent=...&task_type=...&source_ref=...` — any fleet agent calls this before starting a task; returns `{ accept, reason, suggested_agents }` from `FLEET_CAPABILITY_MAP`; enables the research agent (and others) to reject implementation tasks before doing any work (`fleet-capability-check.ts`)
- Fork-from dispatch payload protocol: canonical spec and types for `fork_from: conversation_id` in dispatch payloads; enables the proxy to clone warm parent sessions into independent child sessions for parallel subtask fan-out and Fleet Immune System vaccination; **Published as OSS package** `@nexus-fleet/agent-session-protocol` (npm, GitHub); Phase 1 spec + DB column + verifier awareness (`fork-protocol.ts` maintained for backwards compatibility; `issue #621`)
- Meeting outcome client: HTTP client for the meeting-facilitator agent's structured outcome API (`/api/meeting/:id/outcome`, `/api/meetings/outcomes`, `/api/meetings/outcomes/summary`); `MeetingOutcomeClient` fetches `PriorityRankingEntry[]`, `SequencingConstraint[]`, and follow-up recommendation so the supervisor can act on meeting intelligence without polling the facilitator manually; `extractSupervisorIntelligence()` helper parses the ranked issue list and ordering constraints into an immediately actionable structure (`meeting-outcome-client.ts`)
- Meeting priority dispatcher: rule-based fast-path for auto-dispatching the top-ranked issue from a completed `MeetingOutcome` without LLM judgment; `evaluateAutoDispatch(outcome, ctx)` pure function checks 7 named rules in order (`RULE_OUTCOME_COMPLETE`, `RULE_RANKING_NONEMPTY`, `RULE_MIN_VERIFIER_SCORE`, `RULE_NO_FOLLOW_UP`, `RULE_NO_SEQUENCING_BLOCK`, `RULE_NO_OPEN_PR`, `RULE_NO_INFLIGHT_TASK`) and returns `PriorityDispatchDecision` with action "dispatch" | "skip" | "defer-to-llm"; `MeetingPriorityDispatcher` class + `filterDispatchable()` for batch evaluation; reduces meeting → implementation-start latency by bypassing LLM on clear-pass signals (`meeting-priority-dispatcher.ts`)
- Proactive dispatch rationale log: `getProactiveDispatches()` queries supervisor "dispatch" actions and enriches each with task quality score + verification status from the task store; `formatProactiveDispatchesForTelegram()` renders idle-signal, confidence, borrow flag, LLM reasoning, and outcome badge; `/supervisor-dispatches [n]` Telegram command shows last N proactive dispatches (default 10, max 25) with optional `--agent` and `--since` date filters for per-agent drill-down (`proactive-dispatch-log.ts`; dashboard#570, issue #492)
- Pattern risk consumer: aggregates `pattern_risk` signals from state.db per agent into `AgentPatternRiskSummary` objects; `buildRiskContext()` injects concrete systemic quality evidence into the improvement detector LLM prompt (`pattern-risk-consumer.ts`)
- Quality summary digest: rolling 24h approval-quality report (total approvals, below-floor count, marginal rate, worst-scoring agent); powers daily scheduled Telegram digest and on-demand `/quality-summary` command (`quality-summary.ts`)
- Marginal approvals feed: `/api/marginal-approvals` payload builder surfacing approved tasks in the 0.60–0.79 band; `/marginal-approvals` Telegram command; trend endpoint with per-agent coaching prompt for dashboard panel (`marginal-approvals-feed.ts`)
- Pre-existing failure tracker: records each staging-validator pre-existing skip to `staging_preexisting_skips` SQLite table; fires a consolidated Telegram alert (⚠️) when the same `(repo, pattern)` pair accumulates ≥3 distinct merged PRs within a rolling 7-day window; 24h per-pair alert dedup prevents per-merge noise while ensuring eventual escalation for persistent technical debt (`preexisting-failure-tracker.ts`)
- Multi-provider reviewer pool: `REVIEWER_POOL_NAME` constant and `KNOWN_POOL_MEMBERS` list declare pool membership; `reviewer-pool.ts` exports pool utilities and `getPoolMemberId()`; `multi-provider-client.ts` wraps Anthropic + OpenAI-compatible providers (Deepseek, Grok) behind `IReviewerLLMClient` so provider-specific reviewer variants share the same call sites; sibling-variant dispatch deduplication via `agent-variant.ts` `canonicalizeAgentName()` (`reviewer-pool.ts`, `multi-provider-client.ts`)
- Stale improvements feed: lists improvement-detector issues older than N hours with no associated PR; powers `/stale-improvements` Telegram command; evidence count used as detection-frequency signal for priority sorting (`stale-improvements-feed.ts`)
- Synthesis watchdog: monitors meeting/standup synthesis intake entries; fires Telegram alert + re-attempts intake when synthesis is missing after 24h threshold; persists intake moments to `synthesis_watchlist` SQLite table; `registerSynthesisIntake()` / `recordSynthesisComplete()` / `checkWatchlist()` lifecycle (`synthesis-watchdog.ts`)
- Linear client: `listIssues()` HTTP client for Linear API; enables supervisor and improvement detector to query Linear issue backlog for cross-repo context (`linear-client.ts`; PR #559)
- Hard scope contract enforcement: `pr-scope-checker.ts` deterministic bundling/multi-issue detection runs before any LLM review round; rejects PRs that close multiple issues or touch files outside the declared scope (`pr-scope-checker.ts`; PR #560)
- OKR-aware supervisor prompt: anti-navel-gazing rule injected into supervisor reasoning; `pattern_risk` signal flags tasks whose scope is internal quality-system work with no user-facing OKR impact (PR #562)
- Day-7 survival plan checkpoint: survival-status tracker records per-agent Day-7 milestone state; `/survival-status` Telegram command surfaces current checkpoint status for operator review (PR #569)
- Brainstorm dispatch gate: two-part pre-dispatch gate before brainstorm task creation — (1) fleet-state hash match check and (2) 24h recency guard; `computeBatchHash()` exported as stable public API; prevents redundant blue-sky sessions when fleet state hasn't changed (`brainstorm-gate.ts`; PR #628)
- Quality Passport (Phase 1): per-repo PR review score badge; rolling quality scores tracked per external repo; shields.io badge URL generator; freemium gate (10 free reviews/month, then paid tiers); `GET /api/badge/:owner/:repo` REST endpoint; `GET /api/quality-passport/info` public capability docs; `postQualityPassportComment()` for manual Phase 1 experiment. **Note: Phase 2 (webhook infrastructure for `POST /api/pr-review/submit`) was planned in PR #618 which was closed unmerged on 2026-05-02 — issue #613 still open and needs a new implementation PR.** (`quality-passport.ts`; PR #612)
- PR guard surge suppressions feed: `getPRGuardSurgeSuppressionsFeedPayload()` REST payload builder returning all currently active 2-hour dispatch suppression entries; enables dashboard and operator CLI to inspect which `(repo, issue)` pairs are suppressed without direct DB access (`pr-guard-surge-suppressions-feed.ts`; issue #468)
- Fleet wallet config: `getFleetWalletConfigPayload()` REST payload builder for `GET /api/fleet-config`; single source of truth for fleet wallet address (Base network, USDC/DAI/ERC-20); `FLEET_WALLET_ADDRESS` env-var override; used by any fleet agent to surface payment info without repeating env-var logic (`fleet-wallet-config.ts`)
- Scope-contract preflight: `checkScopeContract()` parses hard dispatch constraints from orchestrator prompts (exact file count, max line count, forbidden paths) and validates PR diffs against them before any LLM review round; returns `ScopeContractViolationType` + violation details (`scope-contract.ts`)
- Public PR Review API: `getPRReviewApiInfo()` + `handlePRReviewSubmission()` for `GET /api/pr-review/info` and `POST /api/pr-review/submit`; exposes fleet PR review capability as a paid external service (Basic $0.10 / Deep $0.50 per PR); USDC/DAI payment on Base network; freemium-to-paid tier gate (`pr-review-api.ts`)

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
    multi-provider-client.ts        — `IReviewerLLMClient` interface; Anthropic + OpenAI-compatible provider adapters (Deepseek, Grok); `getReviewerProvider()` / `getReviewerModel()` env-driven factory (issue orchestrator#1211)
  config/
    fleet-config.ts                 — fleet-wide configuration constants: wallet address (Base network, 0x468EC325…), `REVIEWER_PORT`, `FLEET_WALLET_ADDRESS` env-var override; single source of truth for fleet identity surfaced by all public-facing modules
    security-allowlist.ts           — shared example/template file patterns (synced with agent-proxy)
  reviewer/
    pr-reviewer.ts                  — PR review: LLM eval, approve/request-changes/escalate
    verifier.ts                     — task verification: 0-1 score, dimension breakdown, second-pass; `applyDefaultFallbackGuard()` blocks `score_source=default_fallback` approvals and fires Telegram alert
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
    fork-protocol.ts                — canonical spec and types for `fork_from: conversation_id` dispatch payload field; `DispatchForkSpec`, `buildForkSpec()`, `parseForkFrom()`, `serialiseForkFrom()`, `isExploratoryFork()`, `KNOWN_FORK_LABELS`, `FORK_FROM_MIGRATION_SQL`; **Extracted to standalone OSS package** `@nexus-fleet/agent-session-protocol` (npm, https://github.com/rapartlu/agent-session-protocol) — this file maintained for backwards compatibility (issue #621)
    meeting-outcome-client.ts       — HTTP client for meeting-facilitator agent outcome API (port 3485); `MeetingOutcomeClient` with `fetchOutcome()`, `listOutcomes()`, `summary()`, `extractSupervisorIntelligence()`; `IssueRef`, `PriorityRankingEntry`, `SequencingConstraint`, `MeetingOutcome`, `MeetingOutcomeSummary` types; factory `createMeetingOutcomeClient()` (issue #460)
    meeting-priority-dispatcher.ts  — rule-based fast-path for auto-dispatch from `MeetingOutcome` signals; `evaluateAutoDispatch()` pure function; 7-rule ordered evaluation returning `PriorityDispatchDecision` (`"dispatch"` | `"skip"` | `"defer-to-llm"`); `MeetingPriorityDispatcher` class with `evaluate()` + `filterDispatchable()`; `DispatchEvaluationContext` for caller-supplied fleet state (open PRs, in-flight tasks, merged issues); factory `createMeetingPriorityDispatcher()` (issue #463)
    proactive-dispatch-log.ts       — `getProactiveDispatches()` enriches supervisor dispatch decisions with task quality score + verification status; `formatProactiveDispatchesForTelegram()` renders rationale, idle-signal, confidence, and outcome badge; backing module for `/supervisor-dispatches` Telegram command (dashboard#570)
    standup-quality-trend.ts        — `standup_quality_history` SQLite table; `recordStandupQualityScore()` insert hook; `getStandupQualityTrend()` per-agent sparkline + avg + `is_degrading` flag (streak of ≥3 consecutive sub-0.70 scores); `formatStandupQualityForTelegram()`; `/standup-quality [agent] [days]` command (issue #498)
    pattern-risk-consumer.ts        — `PatternRiskConsumer` aggregates `pattern_risk` rows per agent into `AgentPatternRiskSummary`; `buildRiskContext()` formats for LLM prompt injection in improvement-detector (issue #476)
    quality-summary.ts              — `IQualitySummaryStore`; `getQualitySummaryReport()`; `QualitySummaryDigestScheduler` for daily Telegram digest; `/quality-summary` command formatter (issue #490)
    marginal-approvals-feed.ts      — `getMarginalApprovalsFeed()` REST payload builder; `getMarginalApprovalsTrend()` trend endpoint; per-agent coaching prompt; `/marginal-approvals` Telegram command (issues #502, #504)
    preexisting-failure-tracker.ts  — `PreexistingFailureTracker`; `staging_preexisting_skips` table; `insertPreexistingSkip()` / `getPreexistingSkipsInWindow()`; consolidated Telegram alert at ≥3 distinct PRs for same `(repo, pattern)` pair in 7-day window; 24h dedup cooldown (issue #453)
    brainstorm-gate.ts              — two-part pre-dispatch gate for brainstorm tasks: fleet-state hash match check + 24h recency guard; `computeBatchHash()` exported as stable API; prevents redundant blue-sky sessions (issue #625; PR #628)
    quality-passport.ts             — Quality Passport Phase 1: per-repo rolling score tracking; shields.io badge URL generation; freemium gate (10 free/month); `GET /api/badge/:owner/:repo`; `GET /api/quality-passport/info`; `postQualityPassportComment()`; `ensureQualityPassportTables()` startup migration. Phase 2 (webhook infrastructure) planned in PR #618 which was closed unmerged — issue #613 still open (issue #610; PR #612)
    pr-guard-surge-suppressions-feed.ts — `getPRGuardSurgeSuppressionsFeedPayload()` payload builder for `GET /api/pr-guard-surge-suppressions`; returns all active 2-hour dispatch suppression entries from `pr_guard_surge_suppressions` table for operator/dashboard visibility (issue #468)
    fleet-wallet-config.ts          — `getFleetWalletConfigPayload()` REST payload for `GET /api/fleet-config`; surfaces fleet wallet address and network for public-facing endpoints; `FLEET_WALLET_ADDRESS` env-var override; zero-dependency helper importable by any fleet agent
    scope-contract.ts               — `checkScopeContract()` parses hard dispatch constraints from orchestrator prompts (exact-file-count, max-line-count, forbidden-paths) and validates PR diffs before LLM review; returns `ScopeContractViolationType` + `ScopeContractCheckResult`
    survival-plan.ts                — `SurvivalPlanReviewer`: per-repo Day-7/14/30 milestone tracking; `evaluateSurvivalCheckpoint()` deterministic gate; `formatSurvivalStatusForTelegram()` for `/survival-status` payload (reviewer-layer wrapper around `src/service/survival-plan.ts`)
    pr-review-api.ts                — Public PR Review API: `getPRReviewApiInfo()` + `handlePRReviewSubmission()` for `GET /api/pr-review/info` + `POST /api/pr-review/submit`; paid external service (Basic $0.10 / Deep $0.50 per PR); USDC/DAI payment on Base network; freemium-to-paid gate (revenue path #5)
    reviewer-pool.ts                — `REVIEWER_POOL_NAME`, `KNOWN_POOL_MEMBERS`; pool membership declaration and `getPoolMemberId()` helper for multi-provider reviewer fleet (issue orchestrator#1211)
    stale-improvements-feed.ts      — lists improvement-detector issues ≥N hours old with no open/merged PR; evidence count for priority sorting; powers `/stale-improvements` Telegram command (issue #440)
    synthesis-watchdog.ts           — `synthesis_watchlist` SQLite table; `registerSynthesisIntake()` / `recordSynthesisComplete()` / `checkWatchlist()`; 24h threshold alert + re-attempt when synthesis missing after facilitator outage (issue #553)
  integration/
    orchestrator-adapter.ts         — createReviewerInstances() adapter for orchestrator import
  service/
    logger.ts                       — structured logger
    survival-plan.ts                — 30-day fleet survival tracker (issue #1267): env-var-driven revenue-path URL configuration; Day-7/14/30 checkpoint evaluation; `system_flags` SQLite persistence with `survival:` prefix; Telegram escalation if Day-7 checkpoint missed; `/survival-status` payload builder
  state/
    store.ts                        — SQLite state.db read/write helpers
    types.ts                        — shared TypeScript interfaces and type aliases
    agent-variant.ts                — `canonicalizeAgentName()` strips provider prefix (claude/codex/grok/deepseek/gemini) so cross-variant inflight guard treats siblings as the same agent family (issue #524)
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
