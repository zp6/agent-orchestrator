#!/usr/bin/env tsx
/**
 * Off-chain arb monitor for FlashArbBot on Base.
 *
 * Polls quoteArb() on each configured pair every POLL_MS milliseconds.
 * When profit exceeds MIN_PROFIT_USDC, fires executeArb() through the fleet-signer.
 *
 * Usage:
 *   FLASH_ARB_BOT_ADDRESS=0x... npx tsx scripts/arb-monitor.ts
 *
 * Required env:
 *   FLASH_ARB_BOT_ADDRESS  - deployed FlashArbBot contract address
 *   FLEET_SIGNER_URL       - fleet-signer base URL (default: http://127.0.0.1:7521)
 *   BASE_RPC_URL           - Base RPC endpoint (default: https://mainnet.base.org)
 *
 * Optional env:
 *   MIN_PROFIT_USDC        - minimum profit threshold in USDC (default: 0.50)
 *   POLL_MS                - polling interval in ms (default: 12000 = ~1 block)
 *   BORROW_AMOUNT_USDC     - USDC amount to borrow per arb attempt (default: 1000)
 */

import { createPublicClient, encodeAbiParameters, http, parseAbi, parseAbiParameters, type Hex } from "viem";
import { base } from "viem/chains";
import { TreasuryClient } from "../src/services/treasury.js";

const FLASH_ARB_BOT_ADDRESS = process.env.FLASH_ARB_BOT_ADDRESS as `0x${string}` | undefined;
const MIN_PROFIT_USDC = parseFloat(process.env.MIN_PROFIT_USDC ?? "0.50");
const POLL_MS = parseInt(process.env.POLL_MS ?? "12000");
const BORROW_AMOUNT_USDC = parseFloat(process.env.BORROW_AMOUNT_USDC ?? "1000");
const USDC_DECIMALS = 6;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as const;

// Uniswap-compatible routers on Base
const UNISWAP_V2_STYLE_ROUTERS = {
  // Aerodrome (volatile pools) — used as DEX A
  AERODROME: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as const,
  // BaseSwap — used as DEX B
  BASESWAP: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86" as const,
} as const;

const ARB_PAIRS = [
  {
    name: "USDC/WETH Aerodrome→BaseSwap",
    dexA: UNISWAP_V2_STYLE_ROUTERS.AERODROME,
    dexB: UNISWAP_V2_STYLE_ROUTERS.BASESWAP,
    pathAtoB: [USDC, WETH],
    pathBtoA: [WETH, USDC],
  },
  {
    name: "USDC/WETH BaseSwap→Aerodrome",
    dexA: UNISWAP_V2_STYLE_ROUTERS.BASESWAP,
    dexB: UNISWAP_V2_STYLE_ROUTERS.AERODROME,
    pathAtoB: [USDC, WETH],
    pathBtoA: [WETH, USDC],
  },
] as const;

const FLASH_ARB_BOT_ABI = parseAbi([
  "function quoteArb(address dexA, address dexB, address[] calldata pathAtoB, address[] calldata pathBtoA, uint256 amount) external view returns (uint256 profit)",
  "function executeArb(address asset, uint256 amount, bytes calldata params) external",
]);

interface ArbParams {
  dexA: `0x${string}`;
  dexB: `0x${string}`;
  pathAtoB: `0x${string}`[];
  pathBtoA: `0x${string}`[];
  minProfit: bigint;
}

function encodeArbParams(params: ArbParams): Hex {
  return encodeAbiParameters(
    parseAbiParameters("(address dexA, address dexB, address[] pathAtoB, address[] pathBtoA, uint256 minProfit)"),
    [params],
  );
}

async function main() {
  if (!FLASH_ARB_BOT_ADDRESS) {
    console.error("FLASH_ARB_BOT_ADDRESS not set. Run `orch treasury arb-deploy` first.");
    process.exit(1);
  }

  const rpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const treasury = new TreasuryClient({ rpcUrl });

  const borrowAmount = BigInt(Math.round(BORROW_AMOUNT_USDC * 10 ** USDC_DECIMALS));
  const minProfitUnits = BigInt(Math.round(MIN_PROFIT_USDC * 10 ** USDC_DECIMALS));

  console.log(`FlashArbBot monitor started`);
  console.log(`  Contract: ${FLASH_ARB_BOT_ADDRESS}`);
  console.log(`  Borrow: ${BORROW_AMOUNT_USDC} USDC`);
  console.log(`  Min profit: ${MIN_PROFIT_USDC} USDC`);
  console.log(`  Poll: ${POLL_MS}ms`);
  console.log(`  Pairs: ${ARB_PAIRS.length}`);

  let executing = false;

  async function poll() {
    if (executing) return;

    for (const pair of ARB_PAIRS) {
      try {
        const profit = await publicClient.readContract({
          address: FLASH_ARB_BOT_ADDRESS!,
          abi: FLASH_ARB_BOT_ABI,
          functionName: "quoteArb",
          args: [pair.dexA, pair.dexB, [...pair.pathAtoB], [...pair.pathBtoA], borrowAmount],
        }) as bigint;

        const profitUsdc = Number(profit) / 10 ** USDC_DECIMALS;

        if (profit > 0n) {
          console.log(`[${new Date().toISOString()}] ${pair.name}: profit=$${profitUsdc.toFixed(4)}`);
        }

        if (profit >= minProfitUnits) {
          executing = true;
          console.log(`[${new Date().toISOString()}] OPPORTUNITY: ${pair.name} profit=$${profitUsdc.toFixed(4)} — executing arb`);

          try {
            const params = encodeArbParams({
              dexA: pair.dexA,
              dexB: pair.dexB,
              pathAtoB: [...pair.pathAtoB],
              pathBtoA: [...pair.pathBtoA],
              minProfit: minProfitUnits,
            });

            // executeArb calldata
            const { encodeFunctionData } = await import("viem");
            const calldata = encodeFunctionData({
              abi: FLASH_ARB_BOT_ABI,
              functionName: "executeArb",
              args: [USDC, borrowAmount, params],
            });

            const receipt = await treasury.signAndBroadcast({
              operation: "flash_arb_execute",
              to: FLASH_ARB_BOT_ADDRESS!,
              data: calldata,
              usdValue: 0.01, // gas-only cost (~$0.01 on Base)
            });

            console.log(`[${new Date().toISOString()}] ARB SUCCESS tx=${receipt.transactionHash}`);
          } catch (err) {
            console.error(`[${new Date().toISOString()}] ARB FAILED:`, err instanceof Error ? err.message : err);
          } finally {
            executing = false;
          }
          break; // don't try more pairs in same poll after execution attempt
        }
      } catch (err) {
        // quoteArb reverts if DEX has no liquidity for the path — expected for some pairs
        if (!(err instanceof Error && err.message.includes("revert"))) {
          console.error(`[${new Date().toISOString()}] quote error ${pair.name}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  // First poll immediately
  await poll();
  setInterval(poll, POLL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
