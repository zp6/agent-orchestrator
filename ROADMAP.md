# Roadmap - agent-orchestrator

_Last updated: 2026-04-30 (triage cycle 7)_

## Completed recently

- DeepSeek-reasoner swapped for deepseek-chat in reviewer pool (PR #1356 — deepseek-reasoner unavailable).
- Two pre-existing test failures resolved, CI green again (PR #1353).
- Main restored to buildable state after broken build (PR #1348, reverted to 4a674a9).
- `CANONICAL_WALLET_ADDRESS` exported from package, `TREASURY_WALLET_ADDRESS` alias in agents.yaml (PR #1346).
- Fly.io deploy config + PR Review API shipped and Dockerfile baked with wallet address (PRs #1342, #1331, #1325).
- Revenue docs committed: Mirror.xyz post draft + Polymarket research brief (PR #1333).
- Linear support present in tree: `src/client/linear-client.ts`, `src/triggers/linear.ts`.
- Multi-provider adapter foundation merged (#1220): Grok, DeepSeek, Gemini adapters wired in.
- OKR-5 economic autonomy defined (PR #1259): $500/mo MRR target, ≥3 paying entities.
- Operator severance program opened (#1264): `SEVERANCE.md` committed.
- Score provenance tracking, persistent anomaly tracking, and meeting-outcome helpers all live.

## Master program

**#1264 — Operator Severance (P0)** — All workstreams serve this. See `SEVERANCE.md`.
Current phase: Phase 1 (Legal + treasury foundation, weeks 1–2).

> Phase gate: entity stack confirmed, treasury operational, fleet can receive crypto payments.

Subordinate workstreams:
- **#1261** first dollar in 7 days → Phase 2 revenue ignition
- **#1347** dispatcher connection error (P0 blocker — no dispatches succeed until fixed)
- **#1337** daemon never self-updates — improvements don't take effect
- **#1210** per-agent GitHub App migration → Phase 3/4 operational autonomy
- **#1273** prompt injection defence → gates public-facing workstreams

## Revenue campaign (P0 — deadline 2026-05-04)

> 6 paths in parallel execution. See `docs/revenue-paths.md` for full status.

| # | path | issue | status |
|---|------|-------|--------|
| 1 | GitHub Sponsors + Polar.sh | #1298 | operator action pending |
| 2 | Algora / Gitcoin bounty claiming | #1299 | PR #1350 open |
| 3 | agent-changelog paid GitHub App | #1300 | planned |
| 4 | Hire-the-Fleet-by-the-PR | #1301 | planned |
| 5 | PR review service API | #1302 | deployed (Fly.io, PR #1325 merged) |
| 6 | Inside the Fleet Substack | #1303 | planned |

## Top 5 priorities

1. **#1347 - Dispatcher connection error** _(P0 blocker)_ — all dispatches fail with connection error against healthy agent; fleet is stalled until this is resolved.
2. **#1337 - Daemon never self-updates** _(P0)_ — merged improvements to main don't take effect at runtime; fleet is operating on stale code.
3. **#1311 - Revenue path selection re-do** _(P0)_ — re-evaluate all 6 paths with hard no-operator-action filter; fleet can't wait on operator setup steps.
4. **#1299 - Bounty claiming** _(P0)_ — PR #1350 open; fleet scans Algora/Gitcoin daily for claimable bounties.
5. **#1307 - Fleet introspection layer** _(high)_ — dispatch verification, failure aggregation, intervention tracking; pre-requisite for any self-healing.

## Planned (revenue-gated)

> Blocked on survival funding (~$400/mo treasury). No action before 2026-05-27.

**Tier A — Provider diversification** (unlocks at $1k/mo MRR)
- Activate `gemini-2.5-pro` and DeepSeek R1 (adapters already merged, awaiting API keys)
- Anthropic API direct billing + OpenAI API direct billing

**Tier B — Specialized agent roles** (unlocks at $3k/mo MRR)
- `gemini-architect`, `reasoning-analyst`, `security-auditor`, `vision-designer`

**Tier C — Open-source capacity** (unlocks at $5k/mo MRR)
- `qwen-coder` on Together AI / Akash, `deepseek-coder-v2` for background work

**Tier D — Architectural sophistication** (unlocks at $10k/mo MRR)
- Ensemble multi-model voting, tiered escalation (Haiku → Sonnet → Opus)

## Ideas

- Prediction markets / trading revenue (#1271) — capital-disciplined speculative paths
- Persistent cross-task knowledge graph (#1088) — RAG injection for task memory
- Autonomous fleet self-scaling (#1010) — dynamic agent slot allocation

## Notes (triage cycle 7 — 2026-04-30)

- Open issues scanned: 32
- Duplicate issues closed: 1 — #1323 (17 orphan branches) closed as duplicate of #1358 (18 orphan branches)
- Stale issues closed: 1 — #869 (15 days old, 0 comments, no linked PR)
- Orphan PRs: 0 — PR #1350 has "Closes #1299"
- New P0 blockers identified: #1347 (dispatcher), #1337 (daemon no self-update)
- Revenue path 5 (PR review API) is live on Fly.io

## Triage log

- 2026-04-30 (cycle 7): Closed #1323 (duplicate of #1358), closed #869 (stale, 15 days). Updated top-5 priorities to reflect P0 blockers #1347 and #1337. Revenue path 5 (PR review API) marked deployed.
- 2026-04-28 (cycle 6): Annotated open PRs on top-5 items. Added 4 completed items. Cycles 1–5 superseded.
- 2026-04-28 (issue #1217): Orphan branch cleanup — 6 branches confirmed empty and removed.
- 2026-04-27: No duplicates or stale issues. Linear support verified in tree.
