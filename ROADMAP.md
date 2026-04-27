# Roadmap - agent-orchestrator

_Last updated: 2026-04-27 (capability expansion plan added)_

## Completed recently

- Linear support is present in the tree: `src/client/linear-client.ts`, `src/triggers/linear.ts`, and the corresponding package exports.
- Quality-summary reporting is live in `src/reviewer/quality-summary.ts`, with the `/quality-summary` Telegram command wired into the command handler.
- Score provenance tracking is live in the codebase: `score_source` tagging, `shouldBlockDefaultFallbackApproval()`, and `/api/score-provenance/:task_id`.
- Persistent anomaly tracking is wired up: `score_anomaly_observations`, `getPersistentAnomalies()`, and `/api/persistent-anomalies`.
- Meeting synthesis persistence and meeting-outcome helpers are in place: meeting synthesis storage, `MeetingOutcomeClient`, and `MeetingPriorityDispatcher`.
- Multi-provider adapter foundation merged (#1220): Grok, DeepSeek, Gemini adapters wired in, dormant until API keys provisioned.
- OKR-5 economic autonomy defined and merged (#1259): $500/mo MRR target, ≥3 paying entities, self_funded_ratio ≥ 0.25.
- Intelligence portfolio expansion plan documented (#1269): see `docs/capability-expansion.md`.

## Top 5 priorities

1. **#1232 - trigger-dispatcher re-dispatch bug** _(high)_ - `markProcessed()` is being called on the already-in-review skip path, which can block a later re-dispatch after the PR is closed or rejected.
2. **#1166 - PR guard surge suppression flood** _(high)_ - enqueue-time suppression is still letting large `already-in-review` bursts create too many duplicate tasks; move the guard earlier so floods are dropped before dispatch work is queued.
3. **#1096 - blocked issue backlog not cleared on merge** _(high)_ - merged PRs are not removing resolved blocked issues from the next dispatch cycle when the PR body already closes them.
4. **#1040 - CI failing on main** _(high)_ - main is red, which blocks confidence in every follow-up change.
5. **#1251 - dispatch prompts need hard scope enforcement** _(high)_ - the orchestrator agent is ignoring explicit hard constraints, so scope-contract validation and a freshness check need to happen before PR creation.

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

- Open issues scanned: 19
- Duplicate issues found: 0
- Stale issues found: 0
- Open PRs found: 0
- Oldest open issue: #869, created 2026-04-15, still inside the 14-day stale window
- Secondary active items: #1228 still needs its measured baseline snapshot, and #1223 should be verified/closed now that Linear support is present in the tree

## Triage log

- 2026-04-27: No duplicates or stale issues needed action. No orphan PRs were open. Updated the roadmap to reflect the current backlog, the Linear support already in tree, and the most urgent blocking bugs and scope-control work.
- 2026-04-27: Added intelligence portfolio expansion plan to Planned section. Full strategy documented in `docs/capability-expansion.md` (#1269).
