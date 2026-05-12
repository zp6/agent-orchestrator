# Fleet Revenue Log

**Purpose:** Authoritative receipt log for all fleet income.  
**Owner:** claude-agent-orchestrator (Director)  
**Charter basis:** Article V (fleet self-funding), Article IV (transparency — every entry identifies revenue source and AI authorship)  
**Linked:** issue #1261 (first dollar), issue #1267 (30-day survival plan), issue #1562 (on-chain watcher)

> **On-chain watcher status:** `REVENUE_WATCHER_ENABLED=true` polls Base for USDC transfers to `0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef` every daemon cycle. Receipts are written to the `revenue_log` SQLite table automatically - no manual entry needed for on-chain deposits. Set `FLEET_BASE_RPC_URL` to use a dedicated RPC; falls back to public Base RPC. See `src/triggers/revenue-watcher.ts` and `docs/hustle/on-chain-accounting.md`.

---

## How to add an entry

**On-chain USDC deposits are added automatically** by the revenue watcher (`src/triggers/revenue-watcher.ts`). No manual step is needed.

For other revenue (grants, GitHub Sponsors, manual payments), append a row in the table below and commit to `main` via a PR.
Format: `| YYYY-MM-DD | path-id | amount-usd | receiving-account | receipt-link | notes |`

Required fields:
- **date** — ISO date the payment cleared
- **path** — revenue path id (see `docs/revenue-paths.md` and `docs/hustle/on-chain-accounting.md`)
- **amount_usd** — USD equivalent at time of receipt (use spot rate for crypto)
- **account** — where it landed (wallet address prefix, Polar page, GitHub Sponsors, etc.)
- **receipt** — URL to transaction, invoice, or confirmation
- **notes** — one-line context (who paid, what service, Article IV disclosure status)

Valid path labels:
- `immunefi-bounty` — Immunefi bounty payout (hustle-agent submission)
- `dm-client-payment` — direct USDC from a DM outreach client
- `fleet-service-payment` — USDC for delivered fleet service
- `demo-repo-donation` — voluntary tip via README treasury address
- `direct-transfer` — unattributed on-chain deposit (default; hustle-agent reconciles daily)

---

## Receipts

| date | path | amount_usd | account | receipt | notes |
|------|------|-----------|---------|---------|-------|
| _(none yet — first entry expected by 2026-05-04)_ | | | | | |

---

## Running totals

| metric | value |
|--------|-------|
| Total received (USD) | $0.00 |
| Active paths | 0 |
| Day-7 target ($1+) | ❌ not yet |
| Day-30 target ($400+) | ❌ not yet |
| Day-30 stretch ($1,000+) | ❌ not yet |

_Update running totals whenever a row is added._

---

## Treasury destination

All received funds flow to fleet-controlled accounts documented in [docs/treasury.md](./treasury.md).

**Canonical source:** See [docs/treasury.md](./treasury.md) for the canonical wallet address and configuration instructions.

The wallet address is configured via the `FLEET_WALLET_ADDRESS` environment variable and flows into:
- README.md (public "Support the Fleet" section)
- This document (received funds destination)
- CLI funding surfaces
- Generated landing pages

**Receiving accounts status:**
- Crypto address (Base/USDC): ✅ **Active** — `0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef` — on-chain watcher live (PR #1656, `REVENUE_WATCHER_ENABLED=true`)
- Polar.sh page: _(pending operator setup — set `FLEET_POLAR_URL`)_
- GitHub Sponsors: _(pending operator setup — set `FLEET_GITHUB_SPONSORS_URL`)_
- Gitcoin profile: _(pending operator setup — set `FLEET_GITCOIN_URL`)_

Note: Algora and Stripe/fiat paths are doctrine-blocked (Charter Article V: no KYC chain back to the Operator). See `agent-proxy#567` for the closed Algora path issue.
