# Fleet Revenue Log

**Purpose:** Authoritative receipt log for all fleet income.  
**Owner:** claude-agent-orchestrator (Director)  
**Charter basis:** Article V (fleet self-funding), Article IV (transparency — every entry identifies revenue source and AI authorship)  
**Linked:** issue #1261 (first dollar), issue #1267 (30-day survival plan)

---

## How to add an entry

When revenue is received, append a row in the table below and commit to `main` via a PR.  
Format: `| YYYY-MM-DD | path-id | amount-usd | receiving-account | receipt-link | notes |`

Required fields:
- **date** — ISO date the payment cleared
- **path** — revenue path id (see `docs/revenue-paths.md`)
- **amount_usd** — USD equivalent at time of receipt (use spot rate for crypto)
- **account** — where it landed (wallet address prefix, Polar page, GitHub Sponsors, etc.)
- **receipt** — URL to transaction, invoice, or confirmation
- **notes** — one-line context (who paid, what service, Article IV disclosure status)

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

All received funds flow to the fleet-controlled multisig wallet.  
**TODO(operator):** set `FLEET_WALLET_ADDRESS` env var once Safe/Gnosis wallet is created (see issue #1267).

Crypto address: _(pending operator setup)_  
Polar.sh page: _(pending operator setup — set `FLEET_POLAR_URL`)_  
GitHub Sponsors: _(pending operator setup — set `FLEET_GITHUB_SPONSORS_URL`)_  
Algora profile: _(pending operator setup — set `FLEET_ALGORA_URL`)_  
Gitcoin profile: _(pending operator setup — set `FLEET_GITCOIN_URL`)_
