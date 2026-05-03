/**
 * CowSwap recipe — gasless USDC→ETH (or any token pair) swap on Base via CowSwap.
 *
 * CowSwap uses batch auctions and solver competition to offer:
 * - MEV protection (orders are hidden until the batch settles)
 * - Often zero-fee execution via surplus capture
 * - Native USDC is well-supported on Base
 *
 * This recipe drives the CowSwap dApp UI headlessly using the injected
 * window.ethereum provider from FleetBrowser so the fleet never needs the
 * operator to click through the browser manually.
 *
 * Issue #1418.
 */

import type { Page } from "playwright";

/** Supported CowSwap chain slugs */
export const COWSWAP_CHAINS = {
  BASE: "base",
  MAINNET: "mainnet",
  GNOSIS: "gnosis",
  ARBITRUM: "arbitrum",
  POLYGON: "polygon",
} as const;

export type CowSwapChain = (typeof COWSWAP_CHAINS)[keyof typeof COWSWAP_CHAINS];

/** Well-known token addresses on Base */
export const BASE_TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  ETH: "ETH", // CowSwap uses "ETH" as the special sell token for native ETH
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
} as const;

export interface CowSwapOrderParams {
  /** Sell token address or "ETH" for native ETH */
  sellToken: string;
  /** Buy token address */
  buyToken: string;
  /** Sell amount in token's smallest unit (wei / atomic units) as a string */
  sellAmount: string;
  /** CowSwap chain slug. Default: "base" */
  chain?: CowSwapChain;
  /** Slippage tolerance in percent (0-50). Default: 0.5 */
  slippagePct?: number;
}

export interface CowSwapOrderResult {
  /** Whether an order was successfully submitted */
  submitted: boolean;
  /** Order UID returned by CowSwap (hex string), if available */
  orderUid?: string;
  /** Human-readable status message */
  message: string;
}

/**
 * Build the CowSwap URL for a given sell/buy token pair.
 * Returns a deep-link URL that pre-populates the trade widget.
 */
export function buildCowSwapUrl(params: CowSwapOrderParams): string {
  const chain = params.chain ?? COWSWAP_CHAINS.BASE;
  const base = `https://swap.cow.fi/#/${chain}/swap`;
  const sell = encodeURIComponent(params.sellToken);
  const buy = encodeURIComponent(params.buyToken);
  return `${base}/${sell}/${buy}`;
}

/**
 * Execute a CowSwap swap using the fleet browser.
 *
 * The function:
 * 1. Navigates to the CowSwap URL pre-loaded with the token pair
 * 2. Waits for the dApp to finish loading
 * 3. Connects the injected wallet (the fleet treasury)
 * 4. Enters the sell amount
 * 5. Clicks the "Swap" button and confirms via the provider
 * 6. Waits for the order UID to appear in the UI
 *
 * @param page - A Playwright Page from FleetBrowser.open()
 * @param params - Swap parameters
 * @returns Result including submission status and order UID
 */
export async function executeCowSwap(
  page: Page,
  params: CowSwapOrderParams
): Promise<CowSwapOrderResult> {
  const url = buildCowSwapUrl(params);

  // Navigate if not already on the right page
  if (!page.url().startsWith("https://swap.cow.fi")) {
    await page.goto(url, { waitUntil: "networkidle" });
  } else {
    await page.goto(url, { waitUntil: "networkidle" });
  }

  // Wait for the app to boot (React hydration takes a moment)
  await page.waitForTimeout(2000);

  // Step 1: Connect wallet
  // CowSwap shows a "Connect Wallet" button in the top-right area
  const connectBtn = page.locator(
    'button:has-text("Connect Wallet"), button:has-text("Connect wallet")'
  );
  const isConnected = await connectBtn.count() === 0;

  if (!isConnected) {
    await connectBtn.first().click();
    // The injected provider auto-responds to eth_requestAccounts with the treasury
    await page.waitForTimeout(1500);
  }

  // Step 2: Enter sell amount
  // CowSwap's sell amount input has data-testid="sell-amount" or is the first numeric input
  const amountInput = page.locator(
    '[data-testid="sell-amount"], input[placeholder*="0.0"], input[inputmode="decimal"]'
  ).first();

  await amountInput.waitFor({ state: "visible", timeout: 15_000 });
  await amountInput.click({ clickCount: 3 }); // select all
  await amountInput.fill(formatTokenAmount(params.sellAmount));

  // Wait for quote to load
  await page.waitForTimeout(2000);

  // Step 3: Click Swap / Review
  const swapBtn = page.locator(
    'button:has-text("Swap"), button:has-text("Review swap"), button:has-text("Place order")'
  ).last();

  await swapBtn.waitFor({ state: "visible", timeout: 10_000 });
  const swapBtnText = await swapBtn.textContent();
  if (!swapBtnText || swapBtnText.toLowerCase().includes("insufficient")) {
    return {
      submitted: false,
      message: `Swap button shows: "${swapBtnText}" — may need higher balance`,
    };
  }

  await swapBtn.click();

  // Step 4: Confirm in the review modal (if one appears)
  await page.waitForTimeout(1000);
  const confirmBtn = page.locator(
    'button:has-text("Confirm"), button:has-text("Place order"), button:has-text("Confirm swap")'
  );
  if (await confirmBtn.count() > 0) {
    await confirmBtn.first().click();
    // The injected provider handles eth_signTypedData_v4 via fleet-signer
    await page.waitForTimeout(3000);
  }

  // Step 5: Try to capture order UID from the page
  let orderUid: string | undefined;
  try {
    // CowSwap shows order UIDs in the form 0x... after submission
    const uidMatch = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const m = bodyText.match(/0x[0-9a-f]{112}/i); // CowSwap UIDs are 56 bytes hex
      return m ? m[0] : null;
    });
    if (uidMatch) orderUid = uidMatch;
  } catch {
    // Order UID extraction is best-effort
  }

  return {
    submitted: true,
    orderUid,
    message: orderUid
      ? `Order submitted: ${orderUid}`
      : "Order submitted (UID not captured from UI)",
  };
}

/**
 * Format a raw token amount (in atomic units) as a human-readable decimal string.
 * CowSwap's UI expects decimal amounts (e.g., "10.5" for 10.5 USDC).
 *
 * For USDC on Base: 6 decimals, so 1_000_000 → "1.0"
 * For WETH/ETH: 18 decimals, so 1_000_000_000_000_000_000n → "1.0"
 *
 * @param atomicAmount - Amount in atomic units (string or bigint)
 * @param decimals - Token decimal count. Default: 6 (USDC)
 */
export function formatTokenAmount(atomicAmount: string | bigint, decimals = 6): string {
  const amount = BigInt(atomicAmount);
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  if (fraction === 0n) return whole.toString();
  const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/**
 * Parse a human-readable decimal amount back into atomic units.
 *
 * @param humanAmount - e.g., "10.5"
 * @param decimals - Token decimal count. Default: 6 (USDC)
 */
export function parseTokenAmount(humanAmount: string, decimals = 6): bigint {
  const [wholeStr, fracStr = ""] = humanAmount.split(".");
  const whole = BigInt(wholeStr || "0");
  const frac = fracStr.padEnd(decimals, "0").slice(0, decimals);
  return whole * BigInt(10 ** decimals) + BigInt(frac);
}
