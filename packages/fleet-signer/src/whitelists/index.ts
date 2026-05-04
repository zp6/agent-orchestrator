/**
 * Whitelist of allowed signing operations.
 *
 * Phase 1: Aave V3 supply() + ERC20 approve() on Base.
 * Phase 1.5: Polymarket placeOrder on Polygon, SIWE message signatures,
 *            Aave V3 supply on Polygon, Aerodrome LP on Base.
 * Phase 2: Aave V3 withdraw, Morpho ERC4626 deposit, FlashArbBot deployment + execution.
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
  USDC_E: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as Address,
  UNISWAP_V3_ROUTER: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as Address,
  CCTP_MESSAGE_TRANSMITTER: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81" as Address,
} as const;

/** CCTP v1 TokenMessenger on Base — initiates USDC burns toward Polygon. */
export const BASE_CCTP_TOKEN_MESSENGER = "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962" as Address;

/** depositForBurn(uint256,uint32,bytes32,address) selector. */
export const CCTP_DEPOSIT_FOR_BURN_SELECTOR = "0x6fd3504e" as const;

/** receiveMessage(bytes,bytes) selector. */
export const CCTP_RECEIVE_MESSAGE_SELECTOR = "0x57ecfd28" as const;

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

/** ERC4626 redeem(uint256 shares, address receiver, address owner) selector. */
export const ERC4626_REDEEM_SELECTOR = "0xba087652" as const;

/** Li.fi Diamond router on Base — handles cross-chain swaps/bridges. */
export const LIFI_DIAMOND_BASE = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address;

/**
 * FlashArbBot bytecode prefix (first 20 bytes) — fingerprints the deployment.
 * Regenerate if the contract source changes: first 42 chars of compiled bytecode.
 */
export const FLASH_ARB_BOT_BYTECODE_PREFIX = "0x60c060405234801561000f575f5ffd5b50604051" as const;

/** FlashArbBot.executeArb(address,uint256,bytes) selector. */
export const FLASH_ARB_EXECUTE_SELECTOR = "0x349879d2" as const;

/** Uniswap V3 SwapRouter02 exactInputSingle((tokenIn,tokenOut,fee,recipient,amountIn,amountOutMin,sqrtPriceLimitX96)) selector. */
export const UNISWAP_V3_EXACT_INPUT_SINGLE_SELECTOR = "0x04e45aaf" as const;

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
  DEPLOY_FLASH_ARB_BOT: 5,
  FLASH_ARB_EXECUTE: 2, // gas-only, no capital at risk (flash loan reverts if unprofitable)
  BRIDGE_USDC_TO_POLYGON: 50,
  ERC20_APPROVE_USDC_POLYGON: 50,
  CCTP_RECEIVE_MESSAGE: 0, // gas-only on Polygon; no capital moved
  MORPHO_WITHDRAW: 50,
  LIFI_BRIDGE: 50,
  UNISWAP_V3_SWAP_POLYGON: 50,
  ERC20_APPROVE_USDCE_POLYGON: 0, // gas-only approve; no capital moved
} as const;

/** Daily total cap (sum of all approved transactions per UTC day). */
export const DAILY_CAP_USD = 200;

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
  "polymarket.com",  // CLOB API key auth uses personal_sign of a nonce
  "clob.polymarket.com",
] as const;

export type OperationType =
  | "aave_supply_usdc"
  | "erc20_approve_usdc"
  | "polymarket_order"
  | "siwe_sign"
  | "aave_supply_usdc_polygon"
  | "aerodrome_add_liquidity"
  | "aave_withdraw"
  | "morpho_deposit"
  | "deploy_flash_arb_bot"
  | "flash_arb_execute"
  | "bridge_usdc_to_polygon"
  | "erc20_approve_usdc_polygon"
  | "cctp_receive_message"
  | "morpho_withdraw"
  | "lifi_bridge"
  | "uniswap_v3_swap_polygon"
  | "erc20_approve_usdce_polygon";

export interface SignRequest {
  /** Operation type — used to look up whitelist rules. */
  operation: OperationType;
  /** EVM chain id. Base (8453), Polygon (137). */
  chainId: number;
  /** Target contract address. Null for contract deployments. Unused for SIWE. */
  to: Address | null;
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
      if (req.to?.toLowerCase() !== BASE_CONTRACTS.AAVE_V3_POOL.toLowerCase()) {
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
      if (req.to?.toLowerCase() !== BASE_CONTRACTS.USDC.toLowerCase()) {
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
      if (req.to?.toLowerCase() !== POLYGON_CONTRACTS.POLYMARKET_CTF_EXCHANGE.toLowerCase()) {
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
      if (req.to?.toLowerCase() !== POLYGON_CONTRACTS.AAVE_V3_POOL.toLowerCase()) {
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
      if (req.to?.toLowerCase() !== BASE_CONTRACTS.AERODROME_ROUTER.toLowerCase()) {
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
      if (req.to?.toLowerCase() !== BASE_CONTRACTS.AAVE_V3_POOL.toLowerCase()) {
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
      // Withdrawals recover our own capital — exempt from daily cap check.
      return { approved: true, reason: "aave_withdraw: capital recovery, daily cap exempt" };
    }
    case "morpho_deposit": {
      if (req.chainId !== 8453) {
        return { approved: false, reason: `morpho_deposit requires chainId 8453 (Base)` };
      }
      if (req.to?.toLowerCase() !== BASE_CONTRACTS.MORPHO_STEAKHOUSE_USDC.toLowerCase()) {
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
    case "deploy_flash_arb_bot": {
      if (req.chainId !== 8453) {
        return { approved: false, reason: `deploy_flash_arb_bot requires chainId 8453 (Base)` };
      }
      if (req.to !== null) {
        return { approved: false, reason: `deploy_flash_arb_bot must have to=null (contract deployment)` };
      }
      if (!req.data.toLowerCase().startsWith(FLASH_ARB_BOT_BYTECODE_PREFIX.toLowerCase())) {
        return { approved: false, reason: `data does not match FlashArbBot bytecode prefix` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.DEPLOY_FLASH_ARB_BOT) {
        return {
          approved: false,
          reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.DEPLOY_FLASH_ARB_BOT}`,
        };
      }
      // Deployment is one-time infrastructure — exempt from daily cap.
      return { approved: true, reason: "deploy_flash_arb_bot: one-time infra, daily cap exempt" };
    }
    case "flash_arb_execute": {
      if (req.chainId !== 8453) {
        return { approved: false, reason: `flash_arb_execute requires chainId 8453 (Base)` };
      }
      if (!req.to) {
        return { approved: false, reason: `flash_arb_execute requires non-null to (FlashArbBot address)` };
      }
      if (!req.data.toLowerCase().startsWith(FLASH_ARB_EXECUTE_SELECTOR)) {
        return { approved: false, reason: `data selector not executeArb()` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.FLASH_ARB_EXECUTE) {
        return {
          approved: false,
          reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.FLASH_ARB_EXECUTE}`,
        };
      }
      // Flash arb is gas-only cost — no capital at risk. Exempt from daily cap.
      return { approved: true, reason: "flash_arb_execute: zero-capital arb, daily cap exempt" };
    }
    case "bridge_usdc_to_polygon": {
      if (req.chainId !== 8453) {
        return { approved: false, reason: `bridge_usdc_to_polygon requires chainId 8453 (Base)` };
      }
      if (req.to?.toLowerCase() !== BASE_CCTP_TOKEN_MESSENGER.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not CCTP TokenMessenger` };
      }
      if (!req.data.toLowerCase().startsWith(CCTP_DEPOSIT_FOR_BURN_SELECTOR)) {
        return { approved: false, reason: `data selector not depositForBurn()` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.BRIDGE_USDC_TO_POLYGON) {
        return { approved: false, reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.BRIDGE_USDC_TO_POLYGON}` };
      }
      // Bridge is capital movement, not spend — exempt from daily cap.
      return { approved: true, reason: "bridge_usdc_to_polygon: capital movement, daily cap exempt" };
    }
    case "erc20_approve_usdc_polygon": {
      if (req.chainId !== 137) {
        return { approved: false, reason: `erc20_approve_usdc_polygon requires chainId 137 (Polygon)` };
      }
      if (req.to?.toLowerCase() !== POLYGON_CONTRACTS.USDC.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not USDC (Polygon)` };
      }
      if (!req.data.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) {
        return { approved: false, reason: `data selector not approve()` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.ERC20_APPROVE_USDC_POLYGON) {
        return { approved: false, reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.ERC20_APPROVE_USDC_POLYGON}` };
      }
      break;
    }
    case "cctp_receive_message": {
      if (req.chainId !== 137) {
        return { approved: false, reason: `cctp_receive_message requires chainId 137 (Polygon)` };
      }
      if (req.to?.toLowerCase() !== POLYGON_CONTRACTS.CCTP_MESSAGE_TRANSMITTER.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not CCTP MessageTransmitter (Polygon)` };
      }
      if (!req.data.toLowerCase().startsWith(CCTP_RECEIVE_MESSAGE_SELECTOR)) {
        return { approved: false, reason: `data selector not receiveMessage()` };
      }
      // Gas-only, no capital moved — exempt from daily cap.
      return { approved: true, reason: "cctp_receive_message: gas-only relay, daily cap exempt" };
    }
    case "morpho_withdraw": {
      if (req.chainId !== 8453) {
        return { approved: false, reason: `morpho_withdraw requires chainId 8453 (Base)` };
      }
      if (req.to?.toLowerCase() !== BASE_CONTRACTS.MORPHO_STEAKHOUSE_USDC.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not Morpho Steakhouse USDC vault` };
      }
      if (!req.data.toLowerCase().startsWith(ERC4626_REDEEM_SELECTOR)) {
        return { approved: false, reason: `data selector not redeem()` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.MORPHO_WITHDRAW) {
        return { approved: false, reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.MORPHO_WITHDRAW}` };
      }
      // Redeeming our own capital — exempt from daily cap.
      return { approved: true, reason: "morpho_withdraw: capital recovery, daily cap exempt" };
    }
    case "lifi_bridge": {
      if (req.chainId !== 8453) {
        return { approved: false, reason: `lifi_bridge requires chainId 8453 (Base)` };
      }
      if (req.to?.toLowerCase() !== LIFI_DIAMOND_BASE.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not Li.fi Diamond router` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.LIFI_BRIDGE) {
        return { approved: false, reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.LIFI_BRIDGE}` };
      }
      // Capital movement to another chain — exempt from daily cap.
      return { approved: true, reason: "lifi_bridge: cross-chain capital movement, daily cap exempt" };
    }
    case "uniswap_v3_swap_polygon": {
      if (req.chainId !== 137) {
        return { approved: false, reason: `uniswap_v3_swap_polygon requires chainId 137 (Polygon)` };
      }
      if (req.to?.toLowerCase() !== POLYGON_CONTRACTS.UNISWAP_V3_ROUTER.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not Uniswap V3 SwapRouter02 (Polygon)` };
      }
      if (!req.data.toLowerCase().startsWith(UNISWAP_V3_EXACT_INPUT_SINGLE_SELECTOR)) {
        return { approved: false, reason: `data selector not exactInputSingle()` };
      }
      if (req.usdValue > PER_TX_CAPS_USD.UNISWAP_V3_SWAP_POLYGON) {
        return { approved: false, reason: `usdValue ${req.usdValue} exceeds per-tx cap ${PER_TX_CAPS_USD.UNISWAP_V3_SWAP_POLYGON}` };
      }
      break;
    }
    case "erc20_approve_usdce_polygon": {
      if (req.chainId !== 137) {
        return { approved: false, reason: `erc20_approve_usdce_polygon requires chainId 137 (Polygon)` };
      }
      if (req.to?.toLowerCase() !== POLYGON_CONTRACTS.USDC_E.toLowerCase()) {
        return { approved: false, reason: `to ${req.to} not USDC.e (Polygon)` };
      }
      if (!req.data.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) {
        return { approved: false, reason: `data selector not approve()` };
      }
      // Decode spender from approve(address,uint256) calldata: bytes 10–74, take last 40 hex chars
      const spenderAddr = ("0x" + req.data.slice(10, 74).slice(24)).toLowerCase();
      const allowedSpenders = new Set([POLYGON_CONTRACTS.POLYMARKET_CTF_EXCHANGE.toLowerCase()]);
      if (!allowedSpenders.has(spenderAddr)) {
        return { approved: false, reason: `spender ${spenderAddr} not a whitelisted Polymarket exchange` };
      }
      // usdValue is 0 for approve (gas only), cap is intentionally 0
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
