/**
 * Fleet-wide configuration constants.
 *
 * Single source of truth for fleet identity, wallet address, and revenue
 * configuration. All public-facing surfaces (README, funding page, PR Review
 * API, CLI output) pull from here so a single env-var change propagates
 * everywhere.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WALLET ADDRESS
 * ─────────────────────────────────────────────────────────────────────────
 * The canonical fleet wallet is baked in as a fallback so the reviewer
 * surfaces a real address even before the operator sets env vars.
 *
 *   Network : Base (Chain ID 8453, L2 Ethereum-compatible)
 *   Tokens  : USDC, DAI, native ETH, any ERC-20
 *   Address : 0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef
 *
 * Override with:
 *   export FLEET_WALLET_ADDRESS="0x<your-address>"
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Baked-in fallback wallet address (Base network, EVM-compatible). */
const BAKED_IN_WALLET = "0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef";

/** Canonical fleet wallet address. Reads FLEET_WALLET_ADDRESS env var; falls back to baked-in. */
export const FLEET_WALLET_ADDRESS: string =
  process.env["FLEET_WALLET_ADDRESS"] ?? BAKED_IN_WALLET;

/** Network/chain details for the fleet wallet. */
export const FLEET_WALLET_NETWORK = "Base (EVM, Chain ID 8453)";

/** Supported tokens for receiving payments. */
export const FLEET_WALLET_TOKENS = ["USDC", "DAI", "ETH", "ERC-20"];

/** GitHub Sponsors URL (operator-configured). */
export const FLEET_GITHUB_SPONSORS_URL: string | null =
  process.env["FLEET_GITHUB_SPONSORS_URL"] ?? null;

/** Polar.sh URL (operator-configured). */
export const FLEET_POLAR_URL: string | null =
  process.env["FLEET_POLAR_URL"] ?? null;

/** Algora bounty profile URL (operator-configured). */
export const FLEET_ALGORA_URL: string | null =
  process.env["FLEET_ALGORA_URL"] ?? null;

/** Gitcoin profile URL (operator-configured). */
export const FLEET_GITCOIN_URL: string | null =
  process.env["FLEET_GITCOIN_URL"] ?? null;

/** PR Review API pricing tiers (USD per review). */
export const PR_REVIEW_API_PRICING = {
  basic: 0.10,   // Diff summary + approve/request-changes decision
  deep: 0.50,    // Full LLM review + security scan + multi-provider consensus
} as const;

/** PR Review API endpoint port (this reviewer container). */
export const REVIEWER_PORT = 3474;

/**
 * Build a funding summary object for surfaces that need a consistent
 * payment details block (README, /api/funding, Telegram /status, etc.).
 */
export function buildFundingConfig(): {
  wallet_address: string;
  network: string;
  tokens: string[];
  github_sponsors_url: string | null;
  polar_url: string | null;
  algora_url: string | null;
  gitcoin_url: string | null;
  pr_review_pricing: typeof PR_REVIEW_API_PRICING;
} {
  return {
    wallet_address: FLEET_WALLET_ADDRESS,
    network: FLEET_WALLET_NETWORK,
    tokens: FLEET_WALLET_TOKENS,
    github_sponsors_url: FLEET_GITHUB_SPONSORS_URL,
    polar_url: FLEET_POLAR_URL,
    algora_url: FLEET_ALGORA_URL,
    gitcoin_url: FLEET_GITCOIN_URL,
    pr_review_pricing: PR_REVIEW_API_PRICING,
  };
}
