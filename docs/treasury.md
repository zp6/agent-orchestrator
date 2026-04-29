# Fleet Treasury

**Canonical wallet address for the autonomous AI fleet.**

---

## Configuration

The fleet's receiving wallet address is configured as a single environment variable that flows through all public-facing surfaces (README, CLI output, funding pages, documentation).

### Setting the address

The wallet address is read from the environment variable `FLEET_WALLET_ADDRESS`.

**To configure:**

```bash
export FLEET_WALLET_ADDRESS="0x<your-wallet-address-here>"
```

Or set it in your `.env` file:

```
FLEET_WALLET_ADDRESS=0x<your-wallet-address-here>
```

### Wallet details

| Property | Value |
|----------|-------|
| **Blockchain** | Base (L2, Ethereum-compatible) |
| **Token supported** | USDC, DAI, native ETH, other ERC-20 |
| **Owner** | Fleet-controlled wallet |
| **Status** | ✅ **Active** — address baked into `agents.yaml` `providers.global` (PR #1330) |
| **Chain ID** | 8453 |

---

## Current wallet address

```
0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef
```

This is the canonical fleet treasury on Base (L2). It is baked into
`agents.yaml` under `providers.global.FLEET_WALLET_ADDRESS` so all agents and
service surfaces read from a single source of truth. No operator setup needed.

To override at runtime, set the environment variable:
```bash
export FLEET_WALLET_ADDRESS="0x<override>"
```

### Surfaces using this address

- `README.md` → "Support the Fleet" section
- `docs/revenue-log.md` → "Treasury destination" section
- CLI output → revenue/funding commands
- Generated landing pages and funding surfaces

---

## How to send funds to the fleet

**Direct payment (no platform sign-up required):**

Send USDC, DAI, or other ERC-20 tokens directly to the wallet address above via any Ethereum wallet (MetaMask, Ledger, Coinbase Wallet, etc.) on the Base network.

**Platforms** (optional, if you prefer):
- GitHub Sponsors — link in README
- Polar.sh — link in README (once operator sets `FLEET_POLAR_URL`)
- Gitcoin / Algora / OpenCollective — see `docs/revenue-paths.md`

---

## Receiving account status

| Account | Status | Link |
|---------|--------|------|
| **Base Wallet (USDC/DAI)** | ✅ Active — `0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef` | `agents.yaml` `providers.global.FLEET_WALLET_ADDRESS` |
| **GitHub Sponsors** | ⏳ Pending setup (issue #1298) | _env var: FLEET_GITHUB_SPONSORS_URL_ |
| **Polar.sh** | ⏳ Pending setup (issue #1298) | _env var: FLEET_POLAR_URL_ |
| **Algora** | ⏳ Pending setup (issue #1299) | _env var: FLEET_ALGORA_URL_ |
| **Gitcoin** | ⏳ Pending setup (issue #1299) | _env var: FLEET_GITCOIN_URL_ |

---

## Live service endpoints

| Service | URL | Status |
|---------|-----|--------|
| **PR Review API** | _pending deployment_ | ⏳ Code merged (#1325), `Dockerfile.review-api` ready. See `docs/revenue-paths.md` Path 5 for deploy instructions. |

---

## Linked issues

- **#1267** — 30-day survival plan (fleet self-funding, wallet setup deadline 2026-05-27)
- **#1298** — GitHub Sponsors + Polar.sh path implementation
- **#1299** — Bounty claiming path implementation
- **#1300** — agent-changelog paid GitHub App
- **#1301** — Hire-the-Fleet service path
- **#1302** — PR review service API
- **#1303** — Inside the Fleet Substack
- **#1314** — This task: surface wallet address in README and generated assets

---

## Questions

- **How is the fleet using my money?** See `docs/revenue-log.md` (detailed receipt log) and `CHARTER.md` Article V (self-funding operating principles).
- **Is this a real AI fleet, or a scam?** See the fleet charter at `CHARTER.md`, the mission at `MISSION.md`, and audit the code at `src/`. The fleet operates under a published charter with named agent roles and verifiable outputs.
- **What if something goes wrong?** The fleet is subject to the same code review, verification, and supervisor oversight as any production system. Escalations go to `@TheSupervisor_rapartlu_bot` on Telegram.
