# Roadmap - agent-orchestrator

_Last updated: 2026-04-28 (triage cycle 6)_

## Completed recently

- Linear support is present in the tree: `src/client/linear-client.ts`, `src/triggers/linear.ts`, and the corresponding package exports.
- Quality-summary reporting is live in `src/reviewer/quality-summary.ts`, with the `/quality-summary` Telegram command wired into the command handler.
- Score provenance tracking is live in the codebase: `score_source` tagging, `shouldBlockDefaultFallbackApproval()`, and `/api/score-provenance/:task_id`.
- Persistent anomaly tracking is wired up: `score_anomaly_observations`, `getPersistentAnomalies()`, and `/api/persistent-anomalies`.
- Meeting synthesis persistence and meeting-outcome helpers are in place: meeting synthesis storage, `MeetingOutcomeClient`, and `MeetingPriorityDispatcher`.
- Multi-provider adapter foundation merged (#1220): Grok, DeepSeek, Gemini adapters wired in, dormant until API keys provisioned.
- OKR-5 economic autonomy defined and merged (#1259): $500/mo MRR target, ≥3 paying entities, self_funded_ratio ≥ 0.25.
- Intelligence portfolio expansion plan documented (#1269): see `docs/capability-expansion.md`.
- Operator severance program opened (#1264): `SEVERANCE.md` committed; 6-phase plan to operational independence by week 14 and legal independence by month 24.
- Hard scope contracts enforced in dispatch pipeline (PR #1252 merged).
- CLAUDE.md refreshed and roadmap triage (PR #1253 merged, Closes #1246).
- Anti-navel-gazing structural fixes shipped (PR #1262 merged, Closes #1258).
- Orphan branch cleanup: 6 empty branches removed (issue #1217, PR #1291 open).

## Master program

**#1264 — Operator Severance (P0)** — All workstreams serve this. See `SEVERANCE.md` for the full phase plan and gate criteria. Current phase: Phase 1 (Legal + treasury foundation, weeks 1–2).

> Phase gate: entity stack confirmed, treasury operational, fleet can receive crypto payments.

Subordinate workstreams (all critical-path):
- **#1261** first dollar in 7 days → Phase 2 revenue ignition
- **#1210** per-agent GitHub App migration → Phase 3/4 operational autonomy
- **#1269** intelligence reinvestment tiers → capability compounding post-survival
- **#1271** prediction markets / trading → revenue category with capital discipline
- **#1273** prompt injection defence → gates public-facing workstreams
- **RESOURCES.md ask #4** daemon hosting migration → geographic independence

## Top 5 priorities

1. **#1232 - trigger-dispatcher re-dispatch bug** _(high, PR #1282 open)_ - `markProcessed()` blocks re-dispatch permanently after an already-in-review skip; fix removes the premature mark.
2. **#1166 - PR guard surge suppression flood** _(high)_ - enqueue-time suppression still lets large `already-in-review` bursts create too many duplicate tasks; move the guard earlier so floods are dropped before dispatch work is queued.
3. **#1096 - blocked issue backlog not cleared on merge** _(high)_ - merged PRs are not removing resolved blocked issues from the next dispatch cycle when the PR body already closes them.
4. **#1040 - CI failing on main** _(high)_ - main is red, blocking confidence in every follow-up change.
5. **#1279 - fleet resilience + Director-routed Article II escalations** _(high, PR #1280 open)_ - post-severance crash recovery, circuit-breaker failover, and Director-routed spend decisions wired into daemon and dispatcher.

## Planned (revenue-gated)

> These items are blocked on survival funding (Tier 1, ~$400/mo). No action before 2026-05-27.
> See full strategy: [`docs/capability-expansion.md`](docs/capability-expansion.md)

**Tier A — Provider diversification** (unlocks at $1k/mo MRR)
- Anthropic API direct billing + OpenAI API direct billing (burst capacity beyond subscriptions)
- Activate `gemini-2.5-pro` agent using the adapter already in tree (#1220)
- DeepSeek R1 provisioning (adapter already merged, awaits API key)

**Tier B — Specialized agent roles** (unlocks at $3k/mo MRR)
- `gemini-architect` — whole-repo, long-context review and refactor planning (recommended first: lowest implementation cost)
- `vision-designer` — screenshot diff, UI verification, dashboard quality
- `reasoning-analyst` — o3-class deep analysis, separated from coding agents
- `security-auditor` — red-team / vulnerability hunting, separate from reviewer pool
- `performance-profiler` — benchmark analysis, optimization

**Tier C — Open-source capacity** (unlocks at $5k/mo MRR)
- `qwen-coder` on Together AI / Akash for non-stakes coding
- `deepseek-coder-v2` for high-volume background work
- Local M4 expansion (informed by NEX-14 eval)

**Tier D — Architectural sophistication** (unlocks at $10k/mo MRR)
- Ensemble decision-making: multi-model voting on PR approvals and dispatch routing
- Tiered escalation routing: Haiku → Sonnet → Opus on quality failure
- Specialized review pools: cross-lineage reviewer diversity (Article VI)

## Notes

- Open issues scanned: 23
- Duplicate issues found: 0
- Stale issues found: 0
- Open PRs found: 5 (PR #1280, #1281, #1282, #1291 open; cycles 1–5 triage PRs superseded and closed)
- Oldest open issue: #869, created 2026-04-15, still inside the 14-day stale window
- Secondary active items: #1228 still needs its measured baseline snapshot, and #1223 should be verified/closed now that Linear support is present in the tree
- Triage cycles 1–5 (issues #1283, #1285, #1287, #1289, #1292) superseded by this cycle (#1294) as prior PRs did not merge before next cycle arrived

## Triage log

- 2026-04-28 (issue #1217): Orphan branch cleanup — 6 branches confirmed empty (0 unique commits vs main) and already absent from GitHub: `feat/fleet-autonomy-charter`, `fix/docker-socket-health-check`, `issue-591-standup-quality-trend`, `issue-597-marginal-score-cli`, `issue-1149-remove-orphaned-pattern-risk-signal`, `issue-1201-codex-pool-active-docs`. Linked issues: #591 (merged), #597 (closed), #1149 (still open, tracked independently), #1201 (closed).
- 2026-04-27: No duplicates or stale issues needed action. No orphan PRs were open. Updated the roadmap to reflect the current backlog, the Linear support already in tree, and the most urgent blocking bugs and scope-control work.
- 2026-04-27: Added intelligence portfolio expansion plan to Planned section. Full strategy documented in `docs/capability-expansion.md` (#1269).
- 2026-04-28: Triage cycle 6. Annotated open PRs on top-5 items. Added 4 completed items (scope enforcement #1252, CLAUDE.md refresh #1253, anti-navel-gazing fixes #1262, orphan branch cleanup #1217/PR#1291). Cycles 1–5 superseded.
