# @nexus-fleet/fleet-browser

Headless Chromium browser automation for the fleet, with a custom `window.ethereum`
provider injected into every page. All signing requests route to the fleet-signer
service — the browser never holds a private key.

**Issue:** [#1429](https://github.com/rapartlu/agent-orchestrator/issues/1429)
**Parent:** [#1418](https://github.com/rapartlu/agent-orchestrator/issues/1418)

---

## Architecture

```
dApp page (Chromium)
  └─ window.ethereum  ← injected via Playwright addInitScript
       └─ eth_sendTransaction / personal_sign / eth_signTypedData_v4
            └─ POST http://127.0.0.1:7521/sign  ← fleet-signer (whitelist + caps)
                 └─ signed result returned to dApp
```

The fleet treasury address (`0x468EC325...`) is exposed as the connected wallet.
dApps see a fully connected MetaMask-compatible wallet; signing authority remains
exclusively with the signer service.

---

## Installation

The package is private and lives inside the monorepo. Install from the repo root:

```bash
npm install
```

Playwright's Chromium browser is fetched automatically on first use:

```bash
cd packages/fleet-browser && npx playwright install chromium
```

---

## Usage from daemon code

```typescript
import { FleetBrowser } from "@nexus-fleet/fleet-browser";

const browser = new FleetBrowser({
  // Optional overrides — all have sensible defaults
  signerUrl: "http://127.0.0.1:7521",          // fleet-signer endpoint
  treasuryAddress: "0x468EC325C5E5059032aB62b613FE132e0a97EA05",
  chainId: 8453,                                // Base mainnet
  headless: true,
});

// Open a dApp page — provider is already injected before page JS runs
const page = await browser.open("https://swap.cow.fi/#/base/swap");

// The page sees window.ethereum connected at the treasury address.
// You can now drive the UI with standard Playwright selectors:
const connected = await page.evaluate(() =>
  (window as any).ethereum?.request({ method: "eth_accounts" })
);
console.log("Accounts:", connected);   // ["0x468ec325..."]

// Interact with the dApp
await page.click('button:has-text("Connect Wallet")');
// The injected provider auto-responds to eth_requestAccounts

// When done
await browser.close();
```

### Docker / container environment

When the browser runs inside a container, set `FLEET_BROWSER_DOCKER=1` so the
signer URL resolves correctly:

```bash
FLEET_BROWSER_DOCKER=1 fleet-browser test --url https://swap.cow.fi
```

This switches the default signer URL from `http://127.0.0.1:7521` to
`http://host.docker.internal:7521`.

Alternatively, pass `signerUrl` explicitly:

```typescript
const browser = new FleetBrowser({
  signerUrl: process.env.SIGNER_URL ?? "http://host.docker.internal:7521",
});
```

---

## CowSwap recipe

A ready-made recipe for gasless USDC→ETH swaps on Base:

```typescript
import {
  FleetBrowser,
  executeCowSwap,
  BASE_TOKENS,
  parseTokenAmount,
} from "@nexus-fleet/fleet-browser";

const browser = new FleetBrowser({ chainId: 8453 });
const page = await browser.open("https://swap.cow.fi");

const result = await executeCowSwap(page, {
  sellToken: BASE_TOKENS.USDC,
  buyToken: BASE_TOKENS.WETH,
  sellAmount: parseTokenAmount("10", 6).toString(), // 10 USDC
  chain: "base",
});

console.log(result.submitted, result.orderUid);
await browser.close();
```

---

## CLI — smoke-test command

Build the package first (`npm run build`), then:

```bash
# Verify the provider is injected and the treasury address is connected
fleet-browser test --url https://app.uniswap.org

# Include a personal_sign round-trip through the signer
fleet-browser test --url https://app.uniswap.org --sign

# Run on Base (chain 8453)
fleet-browser test --url https://swap.cow.fi --chain-id 8453

# Open a headed (visible) window — useful for debugging recipes
fleet-browser test --url https://app.uniswap.org --headed

# Override signer URL (e.g. in Docker)
fleet-browser test --url https://app.uniswap.org \
  --signer-url http://host.docker.internal:7521
```

Exit code `0` = provider connected successfully. Exit code `1` = failure.

---

## Security guarantees

| Property | How enforced |
|---|---|
| No private key in browser | Provider script routes all signing to fleet-signer via HTTP; key never leaves the signer process |
| Signing whitelist | fleet-signer enforces contract/method/chain whitelist before signing anything |
| Per-tx cap ($50) | fleet-signer rejects transactions over the per-tx USD limit |
| Daily cap ($100) | fleet-signer rejects after the combined daily spend limit is reached |
| Rejected = structured error | Rejected requests throw EIP-1193 error code 4001; dApp sees "user rejected" |
| No MetaMask extension state | Entirely code-driven; no extension profile to corrupt or leak |

---

## Running tests

```bash
cd packages/fleet-browser
npm test
```

Tests cover the provider script builder (unit) and the CowSwap recipe helpers
(token formatting, URL building). They do not require a running browser or signer.

---

## Adding new dApp recipes

Create a file `src/recipes/<dapp-name>.ts` that accepts a Playwright `Page`
(already connected via `FleetBrowser.open()`) and returns a typed result:

```typescript
// src/recipes/mirror.ts
import type { Page } from "playwright";

export async function publishOnMirror(page: Page, opts: { title: string; body: string }) {
  // Navigate, connect wallet (provider is already injected), fill form, sign + publish
}
```

Export from `src/index.ts` alongside the existing exports.

---

## Package layout

```
packages/fleet-browser/
  src/
    index.ts            FleetBrowser class + re-exports
    provider-script.ts  window.ethereum shim builder
    cli.ts              fleet-browser CLI entry point
    recipes/
      cowswap.ts        CowSwap USDC→ETH recipe (Base)
  test/
    provider-script.test.ts   Unit tests for the provider shim
    cowswap-recipe.test.ts    Unit tests for CowSwap helpers
  README.md             This file
  package.json
  tsconfig.json
```
