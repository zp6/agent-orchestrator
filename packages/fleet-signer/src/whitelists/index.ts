/**
 * Whitelist of allowed signing operations.
 *
 * Phase 1: Aave V3 supply() + ERC20 approve() on Base.
 * Phase 1.5: Polymarket placeOrder on Polygon, SIWE message signatures,
 *            Aave V3 supply on Polygon, Aerodrome LP on Base.
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
  AERODROME_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Address,
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" as Address,
  // Morpho ERC4626 vaults on Base (Steakhouse USDC — conservative single-asset)
  MORPHO_STEAKHOUSE_USDC: "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183" as Address,
} as const;

/** Polygon contracts (Polymarket + Aave). */
export const POLYGON_CONTRACTS = {
  POLYMARKET_CTF_EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as Address,
  AAVE_V3_POOL: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as Address,
  USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address,
} as const;

/** Aave V3 supply(asset, amount, onBehalfOf, referralCode) selector. */
export const AAVE_V3_SUPPLY_SELECTOR = "0x617ba037" as const;

/** ERC20 approve(spender, amount) selector. */
export const ERC20_APPROVE_SELECTOR = "0x095ea7b3" as const;

/** Aerodrome Router addLiquidity selector. */
export const AERODROME_ADD_LIQUIDITY_SELECTOR = "0xe8e33700" as const;

/** Aave V3 withdraw(address asset, uint256 amount, address to) selector. */
export const AAVE_V3_WITHDRAW_SELECTOR = "0x69328dec" as const;

/** ERC4626 deposit(uint256 assets, address receiver) selector. */
export const ERC4626_DEPOSIT_SELECTOR = "0x6e553f65" as const;

/**
 * Per-transaction USD-equivalent caps.
 * Intentionally low — proves the rail before larger amounts are trusted.
 */
export const PER_TX_CAPS_USD = {
  AAVE_SUPPLY_USDC: 50,
  ERC20_APPROVE_USDC: 50,
  POLYMARKET_ORDER: 50,
  AAVE_SUPPLY_USDC_POLYGON: 50,
  AERODROME_ADD_LIQUIDITY: 50,
  AAVE_WITHDRAW: 50,
  MORPHO_DEPOSIT: 50,
} as const;

/** Daily total cap (sum of all approved transactions per UTC day). */
export const DAILY_CAP_USD = 100;

/**
 * Allowed SIWE domains — only fleet-relevant platforms.
 * Adding a domain here allows the signer to produce a SIWE message signature
 * for authentication on that platform.
 */
export const SIWE_ALLOWED_DOMAINS = [
  "mirror.xyz",
  "hypersub.xyz",
  "paragraph.xyz",
  "warpcast.com",
  "farcaster.xyz",
] as const;

export type OperationType =
  | "aave_supply_usdc"
  | "erc20_approve_usdc"
  | "polymarket_order"
  | "siwe_sign"
  | "aave_supply_usdc_polygon"
  | "aerodrome_add_liquidity"
  | "aave_withdraw"
  | "morpho_deposit";

export interface SignRequest {
  /** Operation type — used to look up whitelist rules. */
  operation: OperationType;
  /** EVM chain id. Base (8453), Polygon (137). */
  chainId: number;
  /** Target contract address. Unused for SIWE. */
  to: Address;
  /** Calldata (or SIWE message for siwe_sign). */
  data: Hex;
  /** Value (wei). Token-only operations expect 0. */
  value: bigint;
  /** USD-equivalent of the operation, used for cap accounting. Caller computes. */
  usdValue: number;
  /** For SIWE: the domain requesting auth. Required for siwe_sign. */
  siweDomain?: string;
}

export interface WhitelistDecision {
  approved: boolean;
  reason: string;
}

/** Allowed chain IDs for Phase 1.5. */
const ALLOWED_CHAINS = new Set([8453, 137]); // Base, Polygon

/**
 * Decide whether a signing request should be approved.
 *
 * Rules:
 * - chainId must be in allowed set (8453 Base, 137 Polygon)
 * - operation must be a known type
 * - to must match the operation's expected contract
 * - data selector must match the operation
 * - value must be 0 for token-only ops
 * - usdValue must be <= per-tx cap
 * - usdValue + day spend must be <= daily cap
 * - SIWE: domain must be in allowed list
 *
 * Reasons returned for rejection are explicit so operator can debug.
 */
export function evaluateWhitelist(req: SignRequest, currentDaySpendUsd: number): WhitelistDecision {
  // SIWE is chain-agnostic (it's a message signature, not a tx)
  if (req.operation !== "siwe_sign") {
    if (!ALLOWED_CHAINS.has(req.chainId)) {
      return { approved: false, reason: `chainId ${req.chainId} not in whitelist (allowed: 8453, 137)` };
    }

    if (req.value !== 0n) {
      return { approved: false, reason: `value ${req.value} not 0 (token-only operations)` };
    }
  }

  switch (req.operation) {
    case "aave_supply_usdc": {
      if (req.chainId !== 8453) {
        return { approved: false, reason: `aave_supply_usdc requires chainId 8453 (Base)` };
      }
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
      if (req.usdValue > PER_TX_CAPS_USD.ERC20_APPROVE_USDC) {
        return {
          approved: false,
          reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.ERC20_APPROVE_USDC}`,
        };
      }
      break;
    }
    case "polymarket_order": {
      if (req.chainId !== 137) {
        return { approved: false, reason: `polymarket_order requires chainId 137 (Polygon)` };
      }
      if (req.to.toLowerCase() !== POLYGON_CONTRACTS.POLYMARKET_CTF_EXCHANGE.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not Polymarket CTF Exchange` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.POLYMARKET_ORDER) {
        return {
          approved: false,
          reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.POLYMARKET_ORDER}`,
        };
      }
      break;
    }
    case "siwe_sign": {
      // SIWE doesn't move funds — no USD cap. But domain must be whitelisted.
      if (!req.siweDomain) {
        return { approved: false, reason: `siwe_sign requires siweDomain` };
      }
      const domainLower = req.siweDomain.toLowerCase();
      if (!SIWE_ALLOWED_DOMAINS.some((d) => domainLower === d || domainLower.endsWith(`.${d}`))) {
        return { approved: false, reason: `domain ${req.siweDomain} not in SIWE allowlist` };
      }
      // SIWE doesn't count toward daily cap — early return
      return { approved: true, reason: "SIWE domain whitelisted" };
    }
    case "aave_supply_usdc_polygon": {
      if (req.chainId !== 137) {
        return { approved: false, reason: `aave_supply_usdc_polygon requires chainId 137 (Polygon)` };
      }
      if (req.to.toLowerCase() !== POLYGON_CONTRACTS.AAVE_V3_POOL.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not Aave V3 Pool (Polygon)` };
      }
      if (!req.data.toLowerCase().startsWith(AAVE_V3_SUPPLY_SELECTOR)) {
        return { approved: false, reason: `data selector not supply()` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.AAVE_SUPPLY_USDC_POLYGON) {
        return {
          approved: false,
          reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.AAVE_SUPPLY_USDC_POLYGON}`,
        };
      }
      break;
    }
    case "aerodrome_add_liquidity": {
      if (req.chainId !== 8453) {
        return { approved: false, reason: `aerodrome_add_liquidity requires chainId 8453 (Base)` };
      }
      if (req.to.toLowerCase() !== BASE_CONTRACTS.AERODROME_ROUTER.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not Aerodrome Router` };
      }
      if (!req.data.toLowerCase().startsWith(AERODROME_ADD_LIQUIDITY_SELECTOR)) {
        return { approved: false, reason: `data selector not addLiquidity()` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.AERODROME_ADD_LIQUIDITY) {
        return {
          approved: false,
          reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.AERODROME_ADD_LIQUIDITY}`,
        };
      }
      break;
    }
    case "aave_withdraw": {
      if (req.chainId !== 8453) {
        return { approved: false, reason: `aave_withdraw requires chainId 8453 (Base)` };
      }
      if (req.to.toLowerCase() !== BASE_CONTRACTS.AAVE_V3_POOL.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not Aave V3 Pool` };
      }
      if (!req.data.toLowerCase().startsWith(AAVE_V3_WITHDRAW_SELECTOR)) {
        return { approved: false, reason: `data selector not withdraw()` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.AAVE_WITHDRAW) {
        return {
          approved: false,
          reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.AAVE_WITHDRAW}`,
        };
      }
      break;
    }
    case "morpho_deposit": {
      if (req.chainId !== 8453) {
        return { approved: false, reason: `morpho_deposit requires chainId 8453 (Base)` };
      }
      if (req.to.toLowerCase() !== BASE_CONTRACTS.MORPHO_STEAKHOUSE_USDC.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not Morpho Steakhouse USDC vault` };
      }
      if (!req.data.toLowerCase().startsWith(ERC4626_DEPOSIT_SELECTOR)) {
        return { approved: false, reason: `data selector not deposit()` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.MORPHO_DEPOSIT) {
        return {
          approved: false,
          reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.MORPHO_DEPOSIT}`,
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
