/**
 * Revenue Watcher — on-chain USDC deposit monitor for the fleet treasury.
 *
 * Polls the Base blockchain for USDC ERC-20 Transfer events where
 * `to == FLEET_WALLET` and writes each new transfer to `revenue_log`.
 *
 * Feature flag: `REVENUE_WATCHER_ENABLED=true` (default: false / disabled).
 * RPC: `FLEET_BASE_RPC_URL` env var (fallback: public Base mainnet RPC).
 *
 * Design decisions:
 * - Fail-open: any RPC error is logged and the function returns without
 *   crashing the daemon. The next poll cycle retries from the same block.
 * - No retroactive backfill: on first run, records the current block as the
 *   starting point and exits (no historical scanning).
 * - Deduplication: `tx_hash` is a UNIQUE key in `revenue_log`; duplicate
 *   inserts are silently ignored (INSERT OR IGNORE).
 * - Block range capped at MAX_BLOCKS_PER_SCAN to avoid RPC rate limits.
 * - Telegram notification fires for deposits above NOTIFICATION_THRESHOLD_USD.
 *
 * Related: #1562 (this issue), #1512 (autonomous-revenue layer), agent-proxy#567
 * (Algora/Stripe path closed as KYC-chain-prohibited — this is the allowed path).
 */

import { createPublicClient, http, parseAbi } from "viem";
import type { PublicClient } from "viem";
import { base } from "viem/chains";
import { sendTelegramAlert } from "../service/telegram.js";
import { createLogger } from "../service/logger.js";
import type { StateStore } from "../state/store.js";

const log = createLogger("revenue-watcher");

// ── Constants ──────────────────────────────────────────────────────────────────

/** USDC contract address on Base (L2). */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/** Fleet treasury wallet address on Base. */
export const FLEET_WALLET = "0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef" as const;

/** USDC uses 6 decimal places. */
export const USDC_DECIMALS = 6;

/** Send Telegram notification for deposits above this amount (USD). */
export const NOTIFICATION_THRESHOLD_USD = 5;

/** Default public Base mainnet RPC (fallback when FLEET_BASE_RPC_URL is unset). */
export const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";

/**
 * Maximum number of blocks to scan per daemon cycle.
 * At ~2 blocks/second on Base, 10 000 blocks ≈ 83 minutes.
 * Keeps individual `eth_getLogs` calls within typical RPC provider limits.
 */
export const MAX_BLOCKS_PER_SCAN = 10_000n;

const ERC20_TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

// ── Types ──────────────────────────────────────────────────────────────────────

/** Matches TriggerResult in trigger-dispatcher.ts — kept local to avoid circular import. */
export interface RevenueWatcherResult {
  dispatched: number;
  skipped: number;
  errors: string[];
}

export interface RevenueWatcherOptions {
  /** Override RPC URL (default: FLEET_BASE_RPC_URL env or DEFAULT_BASE_RPC_URL). */
  rpcUrl?: string;
  /**
   * USD amount above which to send a Telegram notification.
   * Default: NOTIFICATION_THRESHOLD_USD.
   */
  notificationThresholdUsd?: number;
  /**
   * Inject a pre-built viem PublicClient for testing.
   * When provided, rpcUrl is ignored.
   */
  publicClient?: PublicClient;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Parses a raw ERC-20 uint256 value (as bigint) to a human-readable USD
 * amount using USDC's 6-decimal precision.
 */
export function parseUsdcAmount(raw: bigint): number {
  return Number(raw) / 10 ** USDC_DECIMALS;
}

/**
 * Formats a Telegram alert message for an on-chain USDC deposit.
 */
export function formatDepositAlert(txHash: string, amountUsd: number): string {
  return (
    `💰 *Fleet Revenue Received*\n\n` +
    `Amount: *$${amountUsd.toFixed(2)} USDC*\n` +
    `Chain: Base\n` +
    `Tx: \`${txHash}\`\n` +
    `Path: direct-transfer`
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Polls the Base blockchain for new USDC deposits to the fleet wallet and
 * records each one in `revenue_log`. Emits a Telegram notification for
 * deposits above NOTIFICATION_THRESHOLD_USD.
 *
 * Governed by the `REVENUE_WATCHER_ENABLED` feature flag (default: false).
 * Fail-open: RPC errors are logged and the function returns without throwing.
 */
export async function dispatchRevenueWatcher(
  store: StateStore,
  opts: RevenueWatcherOptions = {},
): Promise<RevenueWatcherResult> {
  const result: RevenueWatcherResult = { dispatched: 0, skipped: 0, errors: [] };

  // ── Feature flag ────────────────────────────────────────────────────────────
  if (process.env.REVENUE_WATCHER_ENABLED !== "true") {
    result.skipped = 1;
    return result;
  }

  const threshold = opts.notificationThresholdUsd ?? NOTIFICATION_THRESHOLD_USD;
  const rpcUrl = opts.rpcUrl ?? process.env.FLEET_BASE_RPC_URL ?? DEFAULT_BASE_RPC_URL;

  try {
    // Build or reuse the viem public client
    // Note: avoid typing as PublicClient explicitly to prevent viem version mismatch errors
    const client =
      (opts.publicClient as ReturnType<typeof createPublicClient> | undefined) ??
      createPublicClient({
        chain: base,
        transport: http(rpcUrl),
      });

    // ── Determine block scan range ─────────────────────────────────────────
    const currentBlock = await client.getBlockNumber();
    const lastProcessedBlock = store.getRevenueWatcherLastBlock();

    if (lastProcessedBlock === null) {
      // First run — record the current block and exit. No retroactive backfill.
      store.setRevenueWatcherLastBlock(currentBlock);
      log.info("revenue-watcher: first run — bookmark set, no backfill", {
        block: currentBlock.toString(),
      });
      result.skipped = 1;
      return result;
    }

    const fromBlock = lastProcessedBlock + 1n;
    if (fromBlock > currentBlock) {
      // Already at the chain tip, nothing to scan
      result.skipped = 1;
      return result;
    }

    // Cap the scan range to avoid large `eth_getLogs` calls
    const toBlock =
      fromBlock + MAX_BLOCKS_PER_SCAN - 1n > currentBlock
        ? currentBlock
        : fromBlock + MAX_BLOCKS_PER_SCAN - 1n;

    log.info("revenue-watcher: scanning blocks", {
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      range: (toBlock - fromBlock + 1n).toString(),
    });

    // ── Fetch ERC-20 Transfer events to FLEET_WALLET ───────────────────────
    const logs = await client.getLogs({
      address: USDC_BASE,
      event: ERC20_TRANSFER_ABI[0],
      args: { to: FLEET_WALLET },
      fromBlock,
      toBlock,
    });

    log.info("revenue-watcher: events found", { count: logs.length });

    // ── Process each transfer ───────────────────────────────────────────────
    for (const txLog of logs) {
      const txHash = txLog.transactionHash;
      if (!txHash) continue; // Pending transactions have null hash; skip

      // Deduplicate — tx_hash is UNIQUE in revenue_log
      if (store.isRevenueLogEntryPresent(txHash)) {
        log.info("revenue-watcher: skipping already-recorded transfer", { txHash });
        continue;
      }

      const rawValue = (txLog.args as { value?: bigint }).value ?? 0n;
      const amountUsd = parseUsdcAmount(rawValue);

      // Resolve block timestamp for received_at (best-effort; fallback to now)
      let receivedAt = new Date().toISOString();
      try {
        const block = await client.getBlock({ blockNumber: txLog.blockNumber! });
        receivedAt = new Date(Number(block.timestamp) * 1000).toISOString();
      } catch {
        // Non-fatal — use current time if block fetch fails
      }

      store.insertRevenueLog({
        source: "on-chain",
        amount_usd: amountUsd,
        currency: "USDC",
        tx_hash: txHash,
        block_number: Number(txLog.blockNumber ?? 0n),
        chain: "base",
        received_at: receivedAt,
        path: "direct-transfer",
      });

      log.info("revenue-watcher: recorded new deposit", {
        txHash,
        amountUsd: amountUsd.toFixed(6),
        blockNumber: txLog.blockNumber?.toString(),
      });

      result.dispatched++;

      // ── Telegram notification ──────────────────────────────────────────────
      if (amountUsd > threshold) {
        try {
          sendTelegramAlert(formatDepositAlert(txHash, amountUsd));
        } catch (notifyErr) {
          log.warn("revenue-watcher: Telegram notification failed", {
            txHash,
            error:
              notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
          });
        }
      }
    }

    // ── Advance the bookmark ────────────────────────────────────────────────
    store.setRevenueWatcherLastBlock(toBlock);
    log.info("revenue-watcher: cycle complete", {
      toBlock: toBlock.toString(),
      newDeposits: result.dispatched,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("revenue-watcher: scan failed — fail-open, will retry next cycle", {
      error: msg,
    });
    result.errors.push(msg);
  }

  return result;
}
