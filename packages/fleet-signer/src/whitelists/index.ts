/**
 * Whitelist of allowed signing operations.
 *
 * Phase 1 (this PR): Aave V3 supply() to USDC market on Base.
 *
 * Future phases will add:
 *  - ERC20 approve() for whitelisted contracts
 *  - Polymarket placeOrder
 *  - SIWE message signatures
 *
 * Anything outside the whitelist is REJECTED with a clear reason and audited.
 * The Operator sees a Telegram alert on rejection so they know the fleet
 * tried something unusual.
 */

import type { Address, Hex } from "viem";

/** All currently whitelisted Base contracts. */
export const BASE_CONTRACTS = {
  AAVE_V3_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address,
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
} as const;

/** Aave V3 supply(asset, amount, onBehalfOf, referralCode) selector. */
export const AAVE_V3_SUPPLY_SELECTOR = "0x617ba037" as const;

/** ERC20 approve(spender, amount) selector. */
export const ERC20_APPROVE_SELECTOR = "0x095ea7b3" as const;

/**
 * Per-transaction USD-equivalent caps (Phase 1).
 * Phase 1 intentionally low — proves the rail before larger amounts are
 * trusted to the whitelist.
 */
export const PER_TX_CAPS_USD = {
  AAVE_SUPPLY_USDC: 50,
  ERC20_APPROVE_USDC: 50,
} as const;

/** Daily total cap (sum of all approved transactions per UTC day). */
export const DAILY_CAP_USD = 100;

export interface SignRequest {
  /** Operation type — used to look up whitelist rules. */
  operation: "aave_supply_usdc" | "erc20_approve_usdc";
  /** EVM chain id. Phase 1: Base mainnet only (8453). */
  chainId: number;
  /** Target contract address. */
  to: Address;
  /** Calldata. */
  data: Hex;
  /** Value (wei). Phase 1 expects 0 for token-only operations. */
  value: bigint;
  /** USD-equivalent of the operation, used for cap accounting. Caller computes. */
  usdValue: number;
}

export interface WhitelistDecision {
  approved: boolean;
  reason: string;
}

/**
 * Decide whether a signing request should be approved.
 *
 * Phase 1 rules:
 * - chainId must be 8453 (Base mainnet)
 * - operation must be a known type
 * - to must match the operation's expected contract
 * - data selector must match the operation
 * - value must be 0 for token-only ops
 * - usdValue must be <= per-tx cap
 * - usdValue + day spend must be <= daily cap
 *
 * Reasons returned for rejection are explicit so operator can debug.
 */
export function evaluateWhitelist(req: SignRequest, currentDaySpendUsd: number): WhitelistDecision {
  if (req.chainId !== 8453) {
    return { approved: false, reason: `chainId ${req.chainId} not in whitelist (Phase 1: Base only, 8453)` };
  }

  if (req.value !== 0n) {
    return { approved: false, reason: `value ${req.value} not 0 (Phase 1 token-only)` };
  }

  switch (req.operation) {
    case "aave_supply_usdc": {
      if (req.to.toLowerCase() !== BASE_CONTRACTS.AAVE_V3_POOL.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not Aave V3 Pool` };
      }
      if (!req.data.toLowerCase().startsWith(AAVE_V3_SUPPLY_SELECTOR)) {
        return { approved: false, reason: `data selector not supply()` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.AAVE_SUPPLY_USDC) {
        return {
          approved: false,
          reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.AAVE_SUPPLY_USDC}`,
        };
      }
      break;
    }
    case "erc20_approve_usdc": {
      if (req.to.toLowerCase() !== BASE_CONTRACTS.USDC.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not USDC` };
      }
      if (!req.data.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) {
        return { approved: false, reason: `data selector not approve()` };
      }
      // Approve doesn't move funds, but cap the approved amount anyway.
      if (req.usdValue > PER_TX_CAPS_USD.ERC20_APPROVE_USDC) {
        return {
          approved: false,
          reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.ERC20_APPROVE_USDC}`,
        };
      }
      break;
    }
    default: {
      const exhaustive: never = req.operation;
      return { approved: false, reason: `unknown operation: ${exhaustive}` };
    }
  }

  if (currentDaySpendUsd + req.usdValue > DAILY_CAP_USD) {
    return {
      approved: false,
      reason: `daily cap exceeded: ${currentDaySpendUsd} + ${req.usdValue} > ${DAILY_CAP_USD}`,
    };
  }

  return { approved: true, reason: "all checks passed" };
}
