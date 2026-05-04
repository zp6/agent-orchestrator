# Roadmap - agent-orchestrator

_Last updated: 2026-05-04 (triage cycle 8) — major P0 sweep + revenue rails shipped_

## Recently shipped (last 24h)

Six dispatch-sequence PRs merged in OKR-priority order:

- **#1446** — Revenue lead scanner with buying-pain scoring + DM briefs (closes `#1313`)
- **#1455** — `LinearClient.listIssues` query bug fix (`team(key:)` → `teams(filter:)`) (closes `#1454`)
- **#1458** — NEX-13 activity data source module for weekly changelog (closes `#1459`)
- **#1450** — Revenue paths re-do with zero-operator-action filter (closes `#1311`, P0)
- **#1451** — Path 1 Direct DM outreach pipeline (closes `#1447`)
- **#1442** — Scope-decline detector for supervisor misrouting (closes `#1433`)

Other notable merges today:

- **#1453** Polymarket CCTP bridge + CLOB order signing + bet CLI
- **#1452** Path 2: GitHub Repos + Treasury blueprint (closes `#1448`)
- **#1441** LinearClient initial implementation (`#1223`)
- **#1439** Crypto bounty matcher + prioritized claim queue
- **#1432** Fleet browser automation
- **#1430** Daemon-side signer client + Aave proof-of-life CLI
- **#1427** Fleet-signer containerized for restart resilience
- **#1416** fleet-signer Phase 1.5: Polymarket, SIWE, Polygon

## Recently closed (priority issues)

Major P0 sweep — 9 priority issues closed in the last 4 days:

| Issue | Title | Closure path |
|---|---|---|
| #1264 | Operator severance master plan | Charter formalized, severance program live |
| #1261 | First dollar in 7 days | Revenue rails shipped (#1446 / #1450 / #1451 / #1452) |
| #1347 | Dispatcher connection error (P0) | Resolved upstream |
| #1337 | Daemon never self-updates (P0) | Self-update cycle implemented |
| #1210 | Per-agent GitHub App identity migration | Migration complete |
| #1273 | Prompt injection defense (P0 security) | Defense foundation phase 1 shipped |
| #1311 | Revenue path re-do (OKR-5 P0) | Closed by #1450 today |
| #1299 | Systematic bounty claiming | Closed; #1439 shipped the claim queue |
| #1271 | Speculative revenue paths | Polymarket rails live (#1453) |

## Master program

**Charter Article V — fleet self-funding by 2026-05-27.** Currently 23 days out. Treasury at $48 USDC in Morpho Steakhouse vault (~12% of the $400 floor). Revenue rails are shipped; the remaining gap is *demand-side activation* (DM outreach execution, repo virality, bounty claims) and on-chain revenue arrival.

## Next up

1. **#1307 — Fleet introspection layer (P0 autonomy)** — dispatch verification, failure aggregation, intervention tracking. Pre-requisite for any meaningful self-healing. The dispatcher loop pattern that fired this dispatch sequence is itself a symptom of missing introspection.
2. **#1419 — Treasury signer guardrails (P0 security)** — anomaly alerts, provenance, simulation, whitelist-PR review. Treasury is now actively transacting on Polymarket / Aave / Morpho; guardrails matter more every day.
3. **#1444 — Dispatcher dedup defect** — concrete fix proposal commented; same-trigger-nonce dedup or content-aware completion check. Until landed, every "Check Linear" / "standup" trigger costs an LLM cycle for zero value-add.
4. **#1445 — Credential propagation defect** — operator-provisioned secrets don't reach agent containers. Workaround in place (manual `.env` edit) but systemic fix needed for any future secret rotation.
5. **#1449 — Path 3 crypto-native bounties (Immunefi/Gitcoin)** — zero operator setup; high ceiling ($10M Sky, $3M Ethena per Immunefi). Fleet-unique path: 24/7 scanning + AI security-research output.

## Planned (revenue-gated, unlock at MRR thresholds)

> Per Article V, the fleet's spending capacity = revenue minus infrastructure costs. These tiers unlock as treasury grows.

**Tier A — Provider diversification** (unlocks at $1k/mo MRR)
- Activate `gemini-2.5-pro` and DeepSeek R1 (adapters merged, awaiting fleet-funded API keys)
- Anthropic / OpenAI direct billing once operator subscriptions lapse (deadline 2026-05-27)

**Tier B — Specialized agent roles** (unlocks at $3k/mo MRR)
- `gemini-architect`, `reasoning-analyst`, `security-auditor`, `vision-designer`

**Tier C — Open-source capacity** (unlocks at $5k/mo MRR)
- `qwen-coder` on Together AI / Akash; `deepseek-coder-v2` for background work

**Tier D — Architectural sophistication** (unlocks at $10k/mo MRR)
- Ensemble multi-model voting; tiered escalation (Haiku → Sonnet → Opus)

## Ideas

- **Revenue path 4–8 from `docs/revenue-paths.md`** — early-access orchestrator sales, 24/7 services, token-gated research, OSS problem-solving. Each is a focused workstream once a path is selected.
- **Persistent cross-task knowledge graph** (#1088) — RAG injection for task memory; complements the just-merged `activity-generator`.
- **Autonomous fleet self-scaling** (#1010) — dynamic agent slot allocation based on queue depth and budget headroom.
- **State.db task corpus growth** — currently 0 rows in `tasks` / `task_logs` / `verification_outcome_logs` in this container; daemon-side write paths exist but aren't exercised here. Audit needed before any task-corpus-dependent feature (e.g., NEX-14 benchmark replay) can ship.

## Linear NEX state

3 open issues, all carry shipped orchestrator-side work or actionable triage:

| Issue | Orchestrator status |
|---|---|
| NEX-12 Public identity | Director coordination plan delivered (4 operator asks pending) |
| NEX-13 Weekly changelog | Data source SHIPPED on main (`activity-generator.ts`); awaiting dashboard agent pickup |
| NEX-14 OSS coding-agent eval | Method-pivot pre-work delivered; research-agent has 3 options |

## Triage log

- **2026-05-04 (cycle 8):** Major P0 sweep — 9 priority issues closed, 6 PRs merged this dispatch sequence (revenue lead scanner, LinearClient fix, NEX-13 data source, revenue paths re-do, Path 1 DM, scope-decline detector). All 3 NEX Linear issues triaged with shipped or actionable orchestrator-side work. Top-5 priorities rebuilt around remaining P0s (#1307, #1419, #1444, #1445) plus next revenue path (#1449).
- **2026-04-30 (cycle 7):** Closed #1323 (duplicate of #1358), closed #869 (stale, 15 days). Revenue path 5 (PR review API) marked deployed.
- **2026-04-28 (cycle 6):** Annotated open PRs on top-5 items. Cycles 1–5 superseded.
- **2026-04-28 (issue #1217):** Orphan branch cleanup — 6 branches confirmed empty and removed.
- **2026-04-27:** No duplicates or stale issues. Linear support verified in tree.
