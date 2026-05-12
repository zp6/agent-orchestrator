# On-Chain Accounting for Hustle-Agent Revenue

**Owner:** hustle-agent  
**Depends on:** on-chain revenue watcher (`src/triggers/revenue-watcher.ts`, PR #1656)  
**Charter basis:** Article V (fleet self-funding), Article III (money in, never out)  
**Linked:** issue #1562 (on-chain watcher), issue #1512 (autonomous-revenue layer)

---

## What this document is for

Hustle-agent generates revenue events via outreach and bounty submissions. This document explains how those events become `revenue_log` rows, and how hustle-agent reads receipt data back to close the accounting loop.

No KYC credentials are involved. No Stripe or fiat banking chain back to the Operator. All accounting is on-chain on Base.

---

## Revenue paths hustle-agent generates

Each outreach or submission attempt maps to a `path` label in `revenue_log`. When a USDC deposit arrives on-chain, the watcher records it with `path: 'direct-transfer'` by default. Hustle-agent reconciles these against its outreach log to apply the correct path label.

| Path label | Description | Source |
|------------|-------------|--------|
| `immunefi-bounty` | Bounty payout from an Immunefi submission | hustle-agent bounty submitter |
| `dm-client-payment` | Direct USDC payment from a DM outreach client | hustle-agent stale-issue outreach |
| `fleet-service-payment` | USDC for delivered fleet service (code fixes, research) | hustle-agent direct offer |
| `direct-transfer` | Unattributed USDC deposit (default from watcher) | on-chain watcher (unclassified) |
| `demo-repo-donation` | Voluntary tip via README treasury address | demo repo README |

Hustle-agent reconciliation runs daily during the hustle pass. When an outreach offer is accepted and payment arrives within the expected window, hustle-agent updates the `path` from `direct-transfer` to the specific path label.

---

## How hustle-agent reads the revenue log

Hustle-agent reads `docs/revenue-log.md` from agent-orchestrator via the GitHub API each daily pass. This gives it:

1. Total received to date (MRR tracker for OKR-5)
2. Whether its outstanding outreach offers have been paid
3. Which paths are converting (to prioritise tomorrow's outreach)

Reading happens via `gh api repos/rapartlu/agent-orchestrator/contents/docs/revenue-log.md` — no auth beyond the existing GitHub App is needed.

For SQLite access (when running in the same container), hustle-agent queries `revenue_log` directly via `StateStore.queryRevenueLog()`.

---

## What triggers a receipt entry

The on-chain watcher (`REVENUE_WATCHER_ENABLED=true`) detects USDC transfers to `0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef` on Base. Each new transfer creates a row:

```sql
INSERT OR IGNORE INTO revenue_log
  (source, amount_usd, currency, tx_hash, chain, received_at, path)
VALUES
  ('on-chain', <amount>, 'USDC', <tx_hash>, 'base', <block_timestamp>, 'direct-transfer')
```

Telegram fires for amounts above $5 USD. Block bookmark persists between cycles so no deposit is missed.

---

## Hustle-agent daily accounting pass

Each daily hustle pass includes an accounting step:

1. Query `revenue_log` for rows received since yesterday.
2. For each row with `path = 'direct-transfer'`, check `docs/outreach-log.md` for outstanding offers.
3. If an offer was made within the last 7 days and the amount matches, update `path` to the specific label and note the conversion in the daily hustle pass summary.
4. Append converted entries to `docs/outreach-log.md` with status `paid`.
5. Summarise in the daily hustle PR: `{ received_count, converted_count, unattributed_count }`.

---

## Accepted currencies and chains

| Currency | Chain | Status |
|----------|-------|--------|
| USDC | Base (8453) | ✅ Watched (watcher active per PR #1656) |
| ETH | Base (8453) | ⏳ Not yet - add in Phase 2 |
| USDC | Polygon (137) | ⏳ Not yet - add after Base is stable |

Hustle-agent only quotes USDC/Base prices in outreach until additional chains are watched. Quoting a currency the watcher doesn't cover means no receipt confirmation.

---

## Failure modes

**Watcher not enabled:** `REVENUE_WATCHER_ENABLED` defaults to `false`. If unset, hustle-agent's daily pass notes "revenue watcher inactive" in the summary and skips the accounting step.

**RPC failure:** The watcher is fail-open. Hustle-agent will see a gap in `received_at` timestamps. This is expected during RPC outages. No action needed - the watcher retries from the saved block bookmark.

**Unmatched deposits:** Deposits that don't match any outstanding outreach offer remain as `direct-transfer`. This is valid - they could be donations via the README treasury address.

---

## Anti-patterns

- Do not quote ETH or other ERC-20 tokens in outreach until the watcher covers them.
- Do not reconcile deposits older than 30 days against outreach (stale attribution is noise).
- Do not create a `revenue_log` entry for a deposit that isn't on-chain (Charter Article IV: radical transparency).
