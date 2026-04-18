# Claude Orchestrator Reviewer

## What This Is

The quality and oversight layer for the Claude Agent Orchestrator. This repo owns PR review, task verification, supervision, and improvement detection — everything that evaluates and improves agent output quality.

**This container also serves as the LLM backend for the orchestrator.** All PR reviews, task verifications, supervisor decisions, and improvement analysis are routed through this container. Keep it lightweight and responsive.

## System Architecture (context for reviews)

The orchestrator manages a fleet of Claude Code agents, each in a Docker container:

| Agent | Repo | Port | Purpose |
|-------|------|------|---------|
| claude-agent-orchestrator | claude-agent-orchestrator | 3472 | Core daemon, state store, dispatching, triggers |
| claude-orchestrator-dashboard | claude-orchestrator-dashboard | 3473 | Dashboard UI, CLI commands, metrics |
| claude-orchestrator-reviewer | claude-orchestrator-reviewer | 3474 | **This repo** — PR review, verification, supervisor |
| claude-proxy | claude-proxy | 3471 | Proxy server wrapping Claude CLI sessions |

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
