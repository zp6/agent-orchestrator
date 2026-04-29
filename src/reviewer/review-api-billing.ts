/**
 * Review API — Billing tier definitions and enforcement
 *
 * Manages access gates for the paid PR review service (Path 5 in revenue-paths.md).
 * Tiers:
 *   Free:  5 reviews/month, basic review only
 *   Basic: 50 reviews/month, quality score + actionable feedback
 *   Pro:   unlimited reviews, deep security scan, inline comments, SLA ≤2h
 */

export type ReviewTier = "free" | "basic" | "pro";

export interface TierConfig {
  name: ReviewTier;
  /** Monthly review limit. -1 means unlimited. */
  monthlyLimit: number;
  /** Whether the deep security scan feature is enabled. */
  deepSecurityScan: boolean;
  /** Whether inline review comments are generated. */
  inlineComments: boolean;
  /** Whether a numeric quality score is returned. */
  qualityScore: boolean;
  /** SLA in hours, or null for no SLA. */
  slahours: number | null;
  /** Monthly price in USD cents, 0 for free. */
  priceUSDCents: number;
  /** Human-readable price label. */
  priceLabel: string;
}

export const TIER_CONFIGS: Record<ReviewTier, TierConfig> = {
  free: {
    name: "free",
    monthlyLimit: 5,
    deepSecurityScan: false,
    inlineComments: false,
    qualityScore: false,
    slahours: null,
    priceUSDCents: 0,
    priceLabel: "Free",
  },
  basic: {
    name: "basic",
    monthlyLimit: 50,
    deepSecurityScan: false,
    inlineComments: false,
    qualityScore: true,
    slahours: null,
    priceUSDCents: 1000,
    priceLabel: "$10/mo",
  },
  pro: {
    name: "pro",
    monthlyLimit: -1,
    deepSecurityScan: true,
    inlineComments: true,
    qualityScore: true,
    slahours: 2,
    priceUSDCents: 4900,
    priceLabel: "$49/mo",
  },
};

export interface BillingCheckResult {
  allowed: boolean;
  tier: ReviewTier;
  tierConfig: TierConfig;
  /** Usage count this calendar month. */
  usageThisMonth: number;
  /** Remaining reviews this month (-1 for unlimited). */
  remaining: number;
  /** Human-readable reason if not allowed. */
  reason?: string;
}

/**
 * Check whether the given client is allowed to perform a review based on their
 * tier and current usage.
 */
export function checkBillingAllowance(
  tier: ReviewTier,
  usageThisMonth: number
): BillingCheckResult {
  const tierConfig = TIER_CONFIGS[tier];
  const { monthlyLimit } = tierConfig;

  if (monthlyLimit === -1) {
    return {
      allowed: true,
      tier,
      tierConfig,
      usageThisMonth,
      remaining: -1,
    };
  }

  if (usageThisMonth >= monthlyLimit) {
    return {
      allowed: false,
      tier,
      tierConfig,
      usageThisMonth,
      remaining: 0,
      reason:
        tier === "free"
          ? `Free tier limit reached (${monthlyLimit}/month). Upgrade to Basic ($10/mo) for 50 reviews/month.`
          : `Monthly limit of ${monthlyLimit} reviews reached. Upgrade to Pro ($49/mo) for unlimited reviews.`,
    };
  }

  return {
    allowed: true,
    tier,
    tierConfig,
    usageThisMonth,
    remaining: monthlyLimit - usageThisMonth,
  };
}

/**
 * Parse the billing tier from an API key prefix.
 * API key format: `rr_<tier>_<uuid>` e.g. `rr_pro_abc123`
 * Falls back to "free" if unrecognised.
 */
export function parseTierFromApiKey(apiKey: string): ReviewTier {
  const match = /^rr_(free|basic|pro)_/.exec(apiKey);
  if (!match) return "free";
  return match[1] as ReviewTier;
}

/**
 * Extract a client ID from an API key (the UUID suffix after the tier prefix).
 * Used as the stable identifier for usage tracking.
 */
export function clientIdFromApiKey(apiKey: string): string {
  const match = /^rr_(?:free|basic|pro)_(.+)$/.exec(apiKey);
  return match ? match[1] : apiKey;
}
