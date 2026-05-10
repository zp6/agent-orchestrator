# Roadmap - agent-orchestrator

_Last updated: 2026-05-10 (triage cycle 17) — 2 duplicate standup action items closed; Next Up refreshed; treasury day-count updated_

## Recently shipped

- **#1542** — env-gate proactive-rebase-scheduler (hot-fix, closes daemon crash on divergent config)
- **#1536** — Add pub/sub architecture RFC to ROADMAP Ideas (closes #1535)
- **#1529** — Validate per-repo "What to implement" payload before dispatch
- **#1527/#1528** — Layer 1 daily revenue-executor dispatch + type fix
- **#1526** — Mark deleted-agent retries as superseded, not failed
- **#1525** — Bump provider model from `claude-opus-4-6` → `claude-opus-4-7`
- **#1524** — Fleet-wide idempotency fingerprint store
- **#1519** — Daemon in-flight deploy guard prevents orphan compose processes
- **#1516** — Rescope #1465: Mastodon operator-action → fleet-owned ActivityPub

## Recently closed (priority issues)

Issues closed this triage pass (cycle 14, 2026-05-09):
- **#1543** — Duplicate claude-linear-agent proposal (→ kept #1506)
- **#1509** — Superseded orphan-branch snapshot (→ kept newer #1544)

Issues closed last pass (cycle 13, 2026-05-08):
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

**Charter Article V — fleet self-funding by 2026-05-27.** Currently **17 days out**. Treasury at $2 USDC in Morpho Steakhouse vault (bridging losses to Polygon cost ~$46; see CLAUDE.md treasury section). Revenue rails are shipped; critical reliability bugs are now the top blocker (37% task failure rate from connection errors + .claude.json corruption).

## Next up

1. **#1518/1532 — Replace spawnSync with async git calls** — blocks event loop, causes daemon freeze. Root cause of connection-error retry storms and exit-143 timeout pattern. Every freeze means missed dispatches and amplified failure rate.
2. **#1531 — Housekeeping-PR JSON validator re-dispatches closed issues** — dispatch loop bug. Validator incorrectly re-queues already-closed issues, wasting cycles and inflating the failure count. Pair with #1537 (coordinated-change 'target repository' field bug).
3. **#1520 — .claude.json corruption (150–200 task failures)** — CLI spawn issues corrupt agent config. Paired with #1539 (daemon env load) and #1540 (daemon selfUpdate) for full reliability sprint.
4. **#1512 — Fleet autonomous-revenue layer** — P0 survival. Layer 1 dispatcher shipped; Layer 4 (#1562 on-chain USDC watcher) filed. 17 days to Article V deadline.
5. **#1588 — fleet-signer container has no restart policy** — infrastructure gap. Signer flaps and blocks treasury ops; `restart: unless-stopped` is a one-line fix that unblocks all on-chain revenue paths.

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
- **Pub/sub message broker for inter-agent dispatch** (#1535) — replace direct daemon→agent calls with a broker (SQLite MVP → Redis/NATS at scale); enables cross-agent communication and decouples orchestrator from agent availability. Tier D ($10k/mo). Operator directive 2026-05-09.

## Linear NEX state

2 open issues + 1 transitioned to Done this dispatch sequence:

| Issue | State | Orchestrator status |
|---|---|---|
| NEX-12 Public identity | Backlog | Sub-issues closed: #1464 DNS (CLOSED), #1465 Mastodon (CLOSED — rescoped to fleet-owned ActivityPub per #1516). Open: #1466 email (Cloudflare Email Routing API path). Fleet-owned alternatives documented in `docs/social-presence.md`. |
| NEX-13 Weekly changelog | **Done** | Auto-closed at 00:02:06Z when PR #1458 merged the activity-generator data source |
| NEX-14 OSS coding-agent eval | Backlog | Method-pivot pre-work delivered; research-agent has 3 options (synthetic, wait-for-corpus, GitHub-PR replay — Option C recommended) |

## Triage log

- **2026-05-10 (cycle 17):** Closed 2 duplicate standup action items: #1579 (→ #1532, ship async git patch) and #1580 (→ #1533, merge idle PRs). No stale issues (oldest is #1223 at 13 days). No open PRs. Next Up refreshed: added #1531 dispatch-loop bug and #1588 fleet-signer restart gap; updated day count to 17 and corrected treasury balance ($2 after bridging losses).
- **2026-05-10 (cycle 15):** Closed #1555 — stale cross-repo follow-up from dashboard#753 (changelog RSS feed). Issue was created with truncated context due to disk-space ENOSPC during parent task execution; no orchestrator changes were required. Actual work completed in dashboard PR #770 (merged). Reviewer confirmed: "No code changes required in agent-reviewer." Triage: close as resolved-upstream.
- **2026-05-09 (cycle 14):** Closed #1543 (duplicate claude-linear-agent proposal → kept #1506) and #1509 (superseded orphan-branch snapshot → kept #1544). No open PRs — queue clean. No stale issues (oldest is #1223 at 12 days). Refreshed Recently Shipped, Next Up (6 new P1 reliability bugs dominate), and Master Program day-count. NEX-12 sub-issue status updated (#1464 DNS + #1465 Mastodon now closed).
- **2026-05-08 (cycle 13):** Rescoped #1465 (Mastodon operator-action) to fleet-owned ActivityPub path. Added `docs/social-presence.md` with fleet-owned alternatives for all 4 NEX-12 sub-issues (#1464 DNS, #1465 Mastodon, #1466 email, #1470 org migration). Filed new issue for self-hosted ActivityPub server. NEX-12 Mastodon and email sub-issues close operator-action pattern; DNS blocks these, which #1513 addresses.
- **2026-05-04 (cycle 10):** Closed duplicate #1474 (Linear credential propagation — duplicate of #1445). Closed superseded PR #1469 (Add commentOnIssue — replaced by #1478 with cleaner id-based API + getIssue). 9 open PRs all have proper `Closes #N` references — no orphans. No issues >14 days old (oldest #1088 at 12 days). NEX-13 transitioned to Done via #1458 merge. NEX-12 director coordination complete via 5 decisions + 4 operator sub-issues. ROADMAP refreshed.
- **2026-05-04 (cycle 8):** Major P0 sweep — 9 priority issues closed, 6 PRs merged this dispatch sequence (revenue lead scanner, LinearClient fix, NEX-13 data source, revenue paths re-do, Path 1 DM, scope-decline detector). All 3 NEX Linear issues triaged with shipped or actionable orchestrator-side work. Top-5 priorities rebuilt around remaining P0s (#1307, #1419, #1444, #1445) plus next revenue path (#1449).
- **2026-04-30 (cycle 7):** Closed #1323 (duplicate of #1358), closed #869 (stale, 15 days). Revenue path 5 (PR review API) marked deployed.
- **2026-04-28 (cycle 6):** Annotated open PRs on top-5 items. Cycles 1–5 superseded.
- **2026-04-28 (issue #1217):** Orphan branch cleanup — 6 branches confirmed empty and removed.
- **2026-04-27:** No duplicates or stale issues. Linear support verified in tree.
