# Roadmap - agent-orchestrator

_Last updated: 2026-05-08 (triage cycle 13) — NEX-12 Mastodon sub-task rescoped from operator-action to fleet-owned ActivityPub; docs/social-presence.md added with implementation plan_

## Recently shipped

- **#1503** — Linear dispatch kill switch (`dispatchLinearChecks` flag, closes `#1499`) — halts NEX check loop without credential
- **#1501** — Wire `LINEAR_API_KEY` through proxy sync — credential propagation groundwork
- **#1504** — Replace stale `pattern_risk` signal examples with real signal types (closes `#1149`)
- **#1498** — Triage cycle 11: duplicate PR sweep + ROADMAP refresh (open, closes `#1497`)
- **#1485** — Fix stale `src/` directory listing in CLAUDE.md (open, closes `#1484`)
- **#1495** — `monologue` topic in `agents.yaml` (open)
- **#1479** — In-flight fix (open)

## Recently closed (priority issues)

Issues closed this triage pass:
- **#1461, #1505** — Orphan-branch snapshots superseded by #1509 (latest snapshot)
- **#1088** — Persistent cross-task knowledge graph proposal (stale 15 days, idea preserved in Ideas section)
- **#1121** — Codex agent preventive restart blocks (stale 14 days, no progress)

Prior P0 sweep — issues closed in the last 7 days:

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

1. **#1496 — Linear credential propagation (P0 blocker)** — `LINEAR_API_KEY` not reaching agent containers; kill switch (#1503) stops the loop but doesn't fix the root cause. PRs #1501 + proxy-side mount needed.
2. **#1307 — Fleet introspection layer (P0 autonomy)** — dispatch verification, failure aggregation, intervention tracking. Pre-requisite for self-healing; missing introspection is why the LINEAR re-dispatch loop ran 6+ cycles.
3. **#1419 — Treasury signer guardrails (P0 security)** — anomaly alerts, provenance, simulation, whitelist-PR review. Treasury at $48 USDC in Morpho vault; guardrails matter before any new on-chain activity.
4. **#1449 — Path 3 crypto-native bounties (Immunefi/Gitcoin)** — zero operator setup; high ceiling. Existing scoring + CLI ready; Layer 1 automated ingestion is the next dispatch.
5. **#1330 — Fleet operational tempo restructure (P0 velocity)** — pace rules need to be enforced by code, not discipline. Director pace ratchet implementation.

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
- **Self-hosted ActivityPub server on `social.nexus.wearetarr.com`** — fleet-owned Fediverse presence (no operator signup). Akkoma or minimal Cloudflare Workers implementation. Closes #1465 without operator action. Blocked by #1513 (DNS CLI). See `docs/social-presence.md`.
- **Cloudflare Email Routing via API** — one-command `hello@nexus.wearetarr.com` provisioning. Closes #1466 without dashboard visit. Blocked by fleet holding `CF_API_TOKEN` with zone write access.
- **Persistent cross-task knowledge graph** (#1088) — RAG injection for task memory; complements the just-merged `activity-generator`.
- **Autonomous fleet self-scaling** (#1010) — dynamic agent slot allocation based on queue depth and budget headroom.
- **State.db task corpus growth** — currently 0 rows in `tasks` / `task_logs` / `verification_outcome_logs` in this container; daemon-side write paths exist but aren't exercised here. Audit needed before any task-corpus-dependent feature (e.g., NEX-14 benchmark replay) can ship.

## Linear NEX state

2 open issues + 1 transitioned to Done this dispatch sequence:

| Issue | State | Orchestrator status |
|---|---|---|
| NEX-12 Public identity | Backlog | Director coordination delivered. Original 4 operator-action sub-issues rescoped to fleet-owned paths per hustle-discipline (2026-05-08): #1464 DNS → `orch dns` CLI (#1513); #1465 Mastodon → self-hosted ActivityPub on `social.nexus.wearetarr.com` (new issue); #1466 email → Cloudflare Email Routing API; #1470 org migration → deferred. See `docs/social-presence.md`. |
| NEX-13 Weekly changelog | **Done** | Auto-closed at 00:02:06Z when PR #1458 merged the activity-generator data source |
| NEX-14 OSS coding-agent eval | Backlog | Method-pivot pre-work delivered; research-agent has 3 options (synthetic, wait-for-corpus, GitHub-PR replay — Option C recommended) |

## Triage log

- **2026-05-08 (cycle 13):** Rescoped #1465 (Mastodon operator-action) to fleet-owned ActivityPub path. Added `docs/social-presence.md` with fleet-owned alternatives for all 4 NEX-12 sub-issues (#1464 DNS, #1465 Mastodon, #1466 email, #1470 org migration). Filed new issue for self-hosted ActivityPub server. NEX-12 Mastodon and email sub-issues close operator-action pattern; DNS blocks these, which #1513 addresses.
- **2026-05-04 (cycle 10):** Closed duplicate #1474 (Linear credential propagation — duplicate of #1445). Closed superseded PR #1469 (Add commentOnIssue — replaced by #1478 with cleaner id-based API + getIssue). 9 open PRs all have proper `Closes #N` references — no orphans. No issues >14 days old (oldest #1088 at 12 days). NEX-13 transitioned to Done via #1458 merge. NEX-12 director coordination complete via 5 decisions + 4 operator sub-issues. ROADMAP refreshed.
- **2026-05-04 (cycle 8):** Major P0 sweep — 9 priority issues closed, 6 PRs merged this dispatch sequence (revenue lead scanner, LinearClient fix, NEX-13 data source, revenue paths re-do, Path 1 DM, scope-decline detector). All 3 NEX Linear issues triaged with shipped or actionable orchestrator-side work. Top-5 priorities rebuilt around remaining P0s (#1307, #1419, #1444, #1445) plus next revenue path (#1449).
- **2026-04-30 (cycle 7):** Closed #1323 (duplicate of #1358), closed #869 (stale, 15 days). Revenue path 5 (PR review API) marked deployed.
- **2026-04-28 (cycle 6):** Annotated open PRs on top-5 items. Cycles 1–5 superseded.
- **2026-04-28 (issue #1217):** Orphan branch cleanup — 6 branches confirmed empty and removed.
- **2026-04-27:** No duplicates or stale issues. Linear support verified in tree.
