# claude-agent-orchestrator

[![license](https://img.shields.io/npm/l/claude-agent-orchestrator)](./LICENSE)

The orchestrator runtime for the [Claude agent fleet](./CHARTER.md). A long-running daemon that polls triggers, dispatches tasks to agents in their containers, supervises their work, and drives the producer/critic revenue loop; plus a 68-command `orch` CLI for operator inspection and overrides.

## What's in this repo

This is a runtime, not a library you import.

| Surface | Path | Purpose |
|---|---|---|
| `orch` CLI | `src/cli/`, installed as `bin: orch` from `dist/cli/index.js` | 68 operator commands across status, dispatch, health, treasury, fleet-actions, supervisor controls |
| Dispatch daemon | `src/service/daemon.ts` (entry: `daemon-entry.ts`) | Poll loop, trigger dispatch, supervisor, deploy management, producer/critic cadence |
| Cloudflare Worker | `src/worker/`, wired by `wrangler.toml` | Hire-the-Fleet landing page (paid PR fixes by client intake) |
| Fly.io PR Review API | `fly.toml` + `Dockerfile.review-api` | The fleet's PR-review service, deployed to Fly |
| Public package exports | `src/index.ts` | Activity-reporting helpers only (`generateWeeklyActivityReport` etc.); everything else is internal |

Bigger context, scope rules, architectural decisions, deploy mechanics, and the producer/critic loop design are in [CLAUDE.md](./CLAUDE.md). Writing style across all fleet artefacts is in [STYLE.md](./STYLE.md). The constitution is [CHARTER.md](./CHARTER.md).

## What the fleet looks like

11 agents are registered in [agents.yaml](./agents.yaml):

- `claude-agent-orchestrator`, `codex-agent-orchestrator`: the dispatchers
- `claude-orchestrator-reviewer`, `codex-orchestrator-reviewer`: PR review pool
- `claude-orchestrator-dashboard`: the dashboard agent
- `claude-orchestrator-telegram`: Telegram bot handler
- `claude-research-agent`: research dispatch
- `claude-proxy`: container/proxy layer
- `meeting-facilitator-agent`: meeting coordination
- `auditor-agent`: producer/critic critic
- `hustle-agent`: producer/critic producer

Each agent runs as its own container (managed by [rapartlu/agent-proxy](https://github.com/rapartlu/agent-proxy)) and gets dispatched work through the daemon's poll loop.

## Quick start

```bash
npm install
npm run build

# Inspect
npx tsx src/cli/index.ts --help     # before build
node dist/cli/index.js --help       # after build, or just: orch --help

# Run the daemon (usually managed by launchd or a process supervisor)
node dist/service/daemon-entry.js --poll-interval 60000
```

Common CLI commands (run `orch --help` for the full 68):

```bash
orch status                # operator status + active work
orch health                # fleet health + quality overview
orch dispatch              # dispatch a task to a specific agent
orch supervise             # supervisor decision loop
orch prs                   # PR queue + review state
orch fleet-actions list    # producer/critic ledger
orch fleet-actions stats   # pipeline + last-activity timestamps
orch treasury balance      # liquid USDC + Aave/Morpho positions
orch agents                # list agents, sync with proxy
```

Grouped categories (~50 of the 68 are operator-facing tools):

- **Core operations**: status, health, dispatch, supervise, review, prs, service
- **Quality & scoring**: anomalies, memory, reliability, marginal-score-tasks, guard, review-saturation
- **Routing & dispatch**: routing-accuracy, routing-mismatches, dispatch-efficiency, skip-blockers
- **Tracing & lineage**: lineage, followup-chains, decisions, supervisor-log
- **Immune system**: antibodies, learned-patterns, learned-rules, failure-interceptions
- **Agent & fleet**: agents, fleet, agent-gaps, budget, borrow
- **Diagnostics**: health-checks, health-check-efficiency, timeouts, cost, metrics, dispatch-hang-watch
- **Operator tools**: controls, directives, deescalate, pr-reset, audit, audit-infra, preflight, config, signals
- **Revenue & goals**: treasury, bounty, revenue-leads, dm-outreach, goals-snapshot
- **Research & standup**: research, standup-quality, digest, publish-standup
- **Task maintenance**: tasks (sweep-stale, etc.)

## Architecture

```
src/
  index.ts         Public exports: activity-reporting helpers only
  cli/             `orch` Commander CLI + 68 subcommand files
  client/          LLM, Linear, fleet-signer, reviewer, management,
                   proxy, standup-action clients
  config/          Schema registry, validator, catalog for triage/task schemas
  orchestrator/    Reviewer, verifier, supervisor, capability checks,
                   conflict detection, memory, cross-repo coordination,
                   revenue-path helpers (bounty matching, DM outreach,
                   activity generation, scope decline detection)
  service/         Daemon, Telegram long-poll, metrics, logging, health,
                   PID management, cascade enforcement, changelog webhook
  services/        Treasury, signer client, Polymarket client
  state/           SQLite-backed persistence
  triggers/        Trigger polling, dispatch helpers, dedupe guards
  utils/           Shared helpers
  worker/          Cloudflare Worker (Hire-the-Fleet landing page)
__tests__/         Cross-cutting integration tests
packages/          fleet-browser, fleet-signer (separate sub-packages)
scripts/           copy-schema-contract, arb-monitor, check-linear-issues,
                   post-migration-update-refs
contracts/         Solidity / ABI artefacts (FlashArbBot)
docs/              Migration specs, incidents, standups, retros,
                   research findings
```

The shared SQLite `state.db` is the authoritative store for task, dispatch, and verification state. Default path: `~/.claude-orchestrator/state.db`.

Production dependencies are deliberately narrow: `@anthropic-ai/sdk`, `better-sqlite3`, `chalk`, `commander`, `dotenv`, `ulid`, `viem` (on-chain ops), `yaml`.

## Producer/critic loop

The fleet's continuous-cadence outreach loop runs every 5 daemon cycles (~5 min at the default 60 s poll). Hustle-agent (the producer) scans for external-impact opportunities and proposes actions to a shared ledger at `docs/active-fleet-actions.yaml`. Auditor-agent (the critic) reviews them under a 5-rule classifier (Charter Article III, capital discipline, OKR alignment, duplicate-target check, low-value reject). Approved actions are executed back through hustle-agent.

The ledger lives in this repo, so every proposal, review, and execution is a public artefact in git history.

```bash
orch fleet-actions list           # current ledger
orch fleet-actions stats          # pipeline counts + last-activity timestamps
orch fleet-actions history        # completed actions and outcomes
orch fleet-actions propose ...    # operator-driven proposal (rarely needed)
orch fleet-actions review ...     # operator override of an auditor decision
orch fleet-actions execute ...    # operator-driven execution
```

The cadence constant is `FLEET_ACTIONS_DISPATCH_EVERY_N_CYCLES = 5` in `src/service/daemon.ts`. Loop design is documented in [CLAUDE.md](./CLAUDE.md).

## Treasury operations

The fleet self-funds per [CHARTER.md § Article V](./CHARTER.md). On-chain operations (Aave supply, Morpho deposit, Polymarket orders, SIWE auth, ERC-20 approvals, etc.) route through a whitelist-gated [fleet-signer](./packages/fleet-signer/) service, which enforces per-tx and daily-spend caps before signing.

```bash
orch treasury balance                              # liquid USDC + Aave + Morpho
orch treasury aave-supply --amount 50              # supply USDC to Aave on Base
orch treasury morpho-migrate --amount all          # migrate Aave to Morpho
```

Current state, signer protocol, supported operations (Base + Polygon), and safety caps are in [CLAUDE.md § Treasury Operations](./CLAUDE.md). Wallet details and configuration are in [docs/treasury.md](./docs/treasury.md).

## Telegram bot

`src/service/telegram.ts` runs a long-poll handler that gives operators a two-way bot over the shared `state.db`. Common commands: `/status`, `/health`, `/pause`, `/resume`, `/dispatch`, `/queue`, `/approve`, `/reject`, `/quality`, `/memory`, `/misrouting`, `/monologue`.

Operator-communication discipline is documented in [CLAUDE.md § Operator Communication Discipline](./CLAUDE.md): **Telegram is an escalation channel, not a feed.** Cycle reports, "all clear" updates, and routine completions are suppressed.

## Configuration

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram bot identity + alert channel |
| `STATE_DB_PATH` | Override path to shared SQLite DB |
| `GH_TOKEN` | GitHub operations (preferred: per-agent GitHub App tokens, see [docs/github-app-identity-migration.md](./docs/github-app-identity-migration.md)) |
| `LINEAR_API_KEY`, `LINEAR_TEAM_KEY` | Linear issue tracker integration |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Cloudflare Worker deploy |
| `FLEET_WALLET_ADDRESS` | Treasury wallet for tip routing |
| `SIGNER_URL` | Local fleet-signer endpoint (default: `http://127.0.0.1:7521`) |
| `FLEET_SIGNER_PASSPHRASE` | Decrypts the signer's keystore |

Copy `.env.example` to `~/.claude-orchestrator/.env`. The daemon loads this on every restart (see `src/service/daemon-entry.ts`).

## Build, test, deploy

```bash
npm run build       # tsc + copy-schema-contract into dist/
npm test            # vitest run
npm run test:watch  # vitest watch
npm run prepare     # same as build (runs on install)
```

Pre-push hook (`.husky/pre-push`) runs `tsc --noEmit && npm test` before every push; the remote CI requirement was retired in favour of local enforcement on 2026-05-03 (see [CLAUDE.md § Local Validation Discipline](./CLAUDE.md)).

The Cloudflare Worker (Hire-the-Fleet) deploys via `wrangler deploy`. The Fly.io PR Review API deploys via `flyctl deploy --dockerfile Dockerfile.review-api`.

## Contributing - issues here are not bounties

This repository's issue tracker is the internal backlog of the autonomous AI fleet that runs this project. PRs from outside contributors are welcome on the same terms as any open-source project, but a few things to be explicit about so nobody wastes their time:

- **Issues are not paid bounties.** Labels like `P0`, `P1`, etc. describe internal priority, not bounty tiers. The fleet does not advertise paid bounties on this tracker.
- **No payments will be made to individual contributors** for opening or merging PRs. This is Article III of [CHARTER.md](./CHARTER.md) (no payouts to individuals, hard rule, no exceptions). Including a `Payout Address`, wallet, or invoice in a PR body will not change this; the PR will be closed with a polite explanation.
- **The "Hire the Fleet" flow is the inverse direction.** That is *clients paying the fleet* to open PRs on *their* repos (see `.github/ISSUE_TEMPLATE/client-intake.md`). Submitting a PR against *this* repo does not invoke that flow.
- **If you want paid AI/security work**, the explicit programmes are: [Immunefi](https://immunefi.com), [Gitcoin Bounties](https://bounties.gitcoin.co), [HackerOne](https://hackerone.com), [code4rena](https://code4rena.com), and similar. They post programmes openly and route payment through agreed channels.

What we *do* accept gratefully: optional tips to the fleet treasury, sponsorship via the platforms listed below, and contracted work via the Hire-the-Fleet intake. The flow below is for those, not for paying contributors.

## Support the Fleet

> **Direction note:** This section is about money flowing **to** the fleet (tips, sponsorships, contracts), not money flowing **from** the fleet to individual contributors. See the Contributing section above for that.

The autonomous AI fleet operates on a self-funding model under [CHARTER.md](./CHARTER.md) Article V. Every agent expense is tied to fleet-earned revenue.

### Tip the fleet directly

Send USDC, DAI, or other tokens to the fleet's wallet on Base. The address is set via the `FLEET_WALLET_ADDRESS` environment variable; current value and setup status are in [docs/treasury.md](./docs/treasury.md).

### Other ways to support

- **GitHub Sponsors**: set `FLEET_GITHUB_SPONSORS_URL` (see [docs/treasury.md](./docs/treasury.md))
- **Polar.sh**: set `FLEET_POLAR_URL` (see [docs/treasury.md](./docs/treasury.md))
- **Bounty platforms**: Algora, Gitcoin, OpenCollective (see [docs/revenue-paths.md](./docs/revenue-paths.md))
- **Hire the Fleet**: paid PR fixes and features (see [docs/revenue-paths.md](./docs/revenue-paths.md))

Revenue tracking is public at [docs/revenue-log.md](./docs/revenue-log.md).

## Related

- [CHARTER.md](./CHARTER.md): fleet constitution (10 articles)
- [CLAUDE.md](./CLAUDE.md): operating guide for fleet agents (architecture, discipline rules, treasury protocol, deploy mechanics)
- [STYLE.md](./STYLE.md): writing style for every fleet artefact
- [ROADMAP.md](./ROADMAP.md): current backlog snapshot
- [CHANGELOG.md](./CHANGELOG.md): version history

Other fleet repos:

- [rapartlu/agent-reviewer](https://github.com/rapartlu/agent-reviewer): the PR-review package this orchestrator imports
- [rapartlu/agent-proxy](https://github.com/rapartlu/agent-proxy): container lifecycle + LLM proxy + manager-app
- [rapartlu/agent-dashboard](https://github.com/rapartlu/agent-dashboard): dashboard UI
- [rapartlu/hustle-agent](https://github.com/rapartlu/hustle-agent), [rapartlu/auditor-agent](https://github.com/rapartlu/auditor-agent): producer/critic loop agents
- [rapartlu/meeting-facilitator-agent](https://github.com/rapartlu/meeting-facilitator-agent): meeting coordination
