# `@nexus-fleet/fleet-signer`

Local HTTP signer service for the Nexus fleet treasury wallet. Holds the private key in memory after passphrase decryption, signs only whitelisted transactions, enforces per-tx and daily caps, audits every decision.

Issue: rapartlu/agent-orchestrator#1412

## Why

The fleet has a treasury wallet (`0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef` on Base), but no programmatic signing capability. Every revenue path that requires moving funds out of the wallet (Aave deposit, Polymarket position, airdrop registrations, Hypersub setup, Mirror/Paragraph publishing, NFT mints) is gated on this. This service is the missing link.

The Operator runs the signer locally on their host. The fleet daemon calls the signer via localhost HTTP. The key never leaves the Operator's machine; the signer enforces a whitelist; the fleet gets autonomous deployment of treasury funds within strict bounds.

## Phase 1 capabilities (this package version)

- ✅ Aave V3 `supply()` USDC on Base (max **$50/tx**, **$100/day**)
- ✅ ERC20 `approve()` USDC on Base (max **$50/tx**, **$100/day**)
- 🔜 Polymarket `placeOrder` (Phase 1.5)
- 🔜 SIWE message signatures (Phase 2)
- 🔜 Hardware-key integration (Phase 3)

## Setup

```bash
# Once, from the operator's host:
cd packages/fleet-signer
npm install
npm run build

# Encrypt the seed/key with a passphrase. The seed is hidden during entry;
# the encrypted envelope is written to ~/.fleet-signer/key.enc (mode 0600).
node dist/cli.js setup
# > Seed or key: ************************************************************
# > Derived address: 0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef
# > Set a passphrase (used to decrypt at start time): ************
# > Confirm passphrase: ************
# > Encrypted key stored at ~/.fleet-signer/key.enc
```

## Run

```bash
node dist/cli.js start
# > Passphrase: ************
# > Fleet signer listening on http://127.0.0.1:7521
# > Address: 0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef
```

Or pass the passphrase via env (less secure but useful for unattended restart):

```bash
FLEET_SIGNER_PASSPHRASE=... node dist/cli.js start
```

## API

### `GET /health`

```json
{ "status": "ok", "address": "0x468EC325..." }
```

### `POST /sign`

Body:

```json
{
  "operation": "aave_supply_usdc",
  "chainId": 8453,
  "to": "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  "data": "0x617ba037...",
  "value": "0",
  "usdValue": 20
}
```

Response (approved):

```json
{
  "approved": true,
  "reason": "all checks passed",
  "signedTx": "0x02f8..."
}
```

Response (rejected):

```json
{
  "approved": false,
  "reason": "to 0x... not Aave V3 Pool"
}
```

The fleet broadcasts the signed transaction itself. The signer never broadcasts.

## Audit

Every sign decision is appended to `~/.fleet-signer/audit.log` (JSONL). Operator can grep / tail / review:

```bash
tail -f ~/.fleet-signer/audit.log
```

Sample entry:

```json
{ "timestamp": "2026-05-03T12:34:56Z", "operation": "aave_supply_usdc", "decision": "approve", "reason": "all checks passed", "daySpendUsd": 20, "payload": { "to": "0xA238...", "chainId": 8453, "usdValue": 20 } }
```

## Security model

- Key is encrypted at rest with **scrypt + AES-256-GCM** using a passphrase the Operator enters at setup.
- Key is decrypted into memory only at start time, after the Operator enters the passphrase.
- HTTP listener binds to **`127.0.0.1` only** — never reachable from outside the host.
- Whitelist rejects anything not explicitly allowed.
- Per-tx and daily caps prevent runaway loss even if the whitelist is too generous.
- Every decision (approve, reject, error) is audited to disk.
- The signer never broadcasts — the fleet does. Separating sign from broadcast means the signer's only privilege is producing signatures, not initiating network state changes.

## Tests

```bash
npm test
```

Covers whitelist evaluation, encrypted-key round-trip, and the on-disk envelope's permissions and plaintext-leakage properties.
