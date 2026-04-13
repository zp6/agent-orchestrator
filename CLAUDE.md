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

**Task verification**: completed tasks are scored 0–1 by an LLM across four quality dimensions (correctness, completeness, test_coverage, code_quality). Below min_score (0.80) → revision feedback with dimension breakdown dispatched back to agent. Scores in 0.70–0.79 trigger an automatic second-pass review before final rejection. Results persisted to `verification_results` in state.db. Research tasks use a separate prompt with schema compliance scoring and research-specific dimension labels.

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
- Schema-consumer impact detection: flag cross-repo schema changes in PR reviews
- Standup handler: process zero-action standups; retry failed synthesis
- Health recovery: detect and report agent degraded/recovering transitions
- Supervisor log: queryable decision log for CLI and dashboard consumers

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
  reviewer/
    pr-reviewer.ts                  — PR review: LLM eval, approve/request-changes/escalate
    verifier.ts                     — task verification: 0-1 score, dimension breakdown, second-pass
    supervisor.ts                   — strategic system-state reasoning, dispatch decisions
    improvement-detector.ts         — analyze task patterns, surface improvement candidates
    score-calibrator.ts             — score → outcome feedback loop; threshold recommendations
    calibration-drift.ts            — score distribution drift alerts with dedup cooldown
    pr-iteration-metrics.ts         — multi-round PR review patterns and coaching directives
    routing-accuracy.ts             — per-agent quality stats to inform routing preferences
    schema-impact.ts                — schema-consumer map; inject consumer notice into reviews
    issue-age.ts                    — issue age bucketing and severity (0-7d / 7-14d / 30d+)
    issue-creator.ts                — create GitHub issues for detected improvements
    standup-handler.ts              — zero-action standup handling; synthesis retry (up to 2x)
  integration/
    orchestrator-adapter.ts         — createReviewerInstances() adapter for orchestrator import
  service/
    logger.ts                       — structured logger
  state/
    store.ts                        — SQLite state.db read/write helpers
    types.ts                        — shared TypeScript interfaces and type aliases
  telegram/
    command-handler.ts              — /status, /tasks, /approve and other bot commands
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
