/**
 * survival-plan.ts — 30-day fleet survival tracker (issue #1267)
 *
 * The fleet has until 2026-05-27 to accumulate ≥$400 in stablecoin treasury
 * and provision its own LLM subscriptions.  This module:
 *
 *   1. Exposes env-var-driven revenue-path URL configuration so the operator
 *      can wire real accounts without touching source code.
 *   2. Evaluates the Day-7 checkpoint: (a) first dollar received, (b) ≥3
 *      revenue paths actively in motion.
 *   3. Escalates to the operator via Telegram if the checkpoint criteria are
 *      not met by the Day-7 deadline (2026-05-04).
 *   4. Provides a `/survival-status` Telegram payload so the operator can
 *      query progress at any time.
 *
 * State is persisted in `system_flags` rows with the prefix `survival:` so
 * no schema migration is required.
 *
 * TODO(operator): complete all items marked TODO(operator) before going live.
 */

import { notifyOperator } from "./notify.js";
import { getFleetWalletAddress } from "../config/schema.js";

// ── Deadline constants ───────────────────────────────────────────────────────

/** Fleet survival deadline: 30 days from charter amendment 2026-04-27. */
export const SURVIVAL_DEADLINE_ISO = "2026-05-27";

/** Day-7 checkpoint: first dollar + 3 active paths required. */
export const DAY7_CHECKPOINT_ISO = "2026-05-04";

/** Minimum stablecoin treasury required by the 30-day deadline (USD). */
export const SURVIVAL_TARGET_USD = 400;

/** Stretch goal for Day-30 (USD). */
export const SURVIVAL_STRETCH_USD = 1_000;

// ── Environment-variable-driven configuration ────────────────────────────────
//
// TODO(operator): set these env vars in the fleet's container/process
// environment (or agents.yaml secrets section) before the campaign goes live.
// Each URL and address is read at call time so the daemon can be restarted
// without rebuilding the image.

/**
 * Crypto wallet address where revenue is received.
 * Reads from FLEET_WALLET_ADDRESS env var (which loadConfig() populates from
 * providers.global.FLEET_WALLET_ADDRESS in agents.yaml so the daemon no longer
 * requires the operator to set this manually in the host environment).
 */
export function getWalletAddress(): string {
  return getFleetWalletAddress();
}

/**
 * GitHub Sponsors profile URL for the fleet org.
 * TODO(operator): enable GitHub Sponsors at https://github.com/sponsors/
 * and set FLEET_GITHUB_SPONSORS_URL to the public profile link.
 */
export function getGitHubSponsorsUrl(): string {
  return process.env.FLEET_GITHUB_SPONSORS_URL ?? "";
}

/**
 * Polar.sh page URL.
 * TODO(operator): create a Polar.sh page under the fleet identity and set
 * FLEET_POLAR_URL to the public page link.
 */
export function getPolarUrl(): string {
  return process.env.FLEET_POLAR_URL ?? "";
}

/**
 * Algora bounty profile URL.
 * TODO(operator): create an Algora account and set FLEET_ALGORA_URL.
 */
export function getAlgoraUrl(): string {
  return process.env.FLEET_ALGORA_URL ?? "";
}

/**
 * Gitcoin profile URL.
 * TODO(operator): create a Gitcoin profile and set FLEET_GITCOIN_URL.
 */
export function getGitcoinUrl(): string {
  return process.env.FLEET_GITCOIN_URL ?? "";
}

// ── Minimal store interface (only the methods this module needs) ─────────────

export interface ISurvivalPlanStore {
  getSystemFlag(key: string): string | null;
  setSystemFlag(key: string, value: string): void;
}

// ── Revenue path registry ────────────────────────────────────────────────────

export type RevenuePathStatus = "not_started" | "in_motion" | "earned";

export interface RevenuePath {
  /** Machine-readable identifier. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Current status. */
  status: RevenuePathStatus;
  /** ISO timestamp of last status update, or null. */
  updatedAt: string | null;
  /** USD earned on this path (0 if none yet). */
  earnedUsd: number;
  /** URL for this path (may be empty until operator sets it up). */
  url: string;
}

/** Canonical list of approved revenue paths (issue #1267). */
export const APPROVED_REVENUE_PATH_IDS = [
  "bounty-claiming",       // Algora / Gitcoin / OpenCollective
  "github-sponsors",       // GitHub Sponsors + Polar.sh
  "algora-bounties",       // Algora direct (subset of bounty-claiming, tracked separately)
  "gitcoin",               // Gitcoin Grants
  "open-collective",       // OpenCollective donations
  "changelog-paid-app",    // agent-changelog v0.1 paid GitHub App
  "affiliate-content",     // Technical content with affiliate links
] as const;

export type RevenuePathId = (typeof APPROVED_REVENUE_PATH_IDS)[number];

// ── System-flag keys ─────────────────────────────────────────────────────────

const FLAG_PREFIX = "survival:";
const FLAG_REVENUE_PATH = (id: string) => `${FLAG_PREFIX}path:${id}`;
const FLAG_TOTAL_EARNED_CENTS = `${FLAG_PREFIX}total_earned_cents`;
const FLAG_FIRST_DOLLAR_AT = `${FLAG_PREFIX}first_dollar_at`;
const FLAG_DAY7_ESCALATED_AT = `${FLAG_PREFIX}day7_escalated_at`;

// ── Persistence helpers ──────────────────────────────────────────────────────

/** Read the full status of one revenue path from the store. */
export function getRevenuePath(store: ISurvivalPlanStore, id: string): RevenuePath {
  const raw = store.getSystemFlag(FLAG_REVENUE_PATH(id));
  if (!raw) {
    return {
      id,
      label: id,
      status: "not_started",
      updatedAt: null,
      earnedUsd: 0,
      url: "",
    };
  }
  try {
    return JSON.parse(raw) as RevenuePath;
  } catch {
    return { id, label: id, status: "not_started", updatedAt: null, earnedUsd: 0, url: "" };
  }
}

/** Persist a revenue path update. */
export function setRevenuePath(store: ISurvivalPlanStore, path: RevenuePath): void {
  store.setSystemFlag(FLAG_REVENUE_PATH(path.id), JSON.stringify(path));
}

/** Mark a revenue path as in_motion (operator or automated action). */
export function markPathInMotion(
  store: ISurvivalPlanStore,
  id: string,
  url?: string,
): void {
  const existing = getRevenuePath(store, id);
  if (existing.status === "earned") return; // don't downgrade
  setRevenuePath(store, {
    ...existing,
    id,
    label: id,
    status: "in_motion",
    updatedAt: new Date().toISOString(),
    url: url ?? existing.url,
  });
}

/** Record earnings on a revenue path and update first-dollar timestamp. */
export function recordEarnings(
  store: ISurvivalPlanStore,
  id: string,
  amountUsd: number,
): void {
  const existing = getRevenuePath(store, id);
  const newTotal = existing.earnedUsd + amountUsd;
  setRevenuePath(store, {
    ...existing,
    id,
    label: id,
    status: "earned",
    updatedAt: new Date().toISOString(),
    earnedUsd: newTotal,
  });

  // Update aggregate counter
  const prevCents = parseInt(store.getSystemFlag(FLAG_TOTAL_EARNED_CENTS) ?? "0", 10);
  const addCents = Math.round(amountUsd * 100);
  store.setSystemFlag(FLAG_TOTAL_EARNED_CENTS, String(prevCents + addCents));

  // Record first-dollar timestamp
  if (!store.getSystemFlag(FLAG_FIRST_DOLLAR_AT) && amountUsd > 0) {
    store.setSystemFlag(FLAG_FIRST_DOLLAR_AT, new Date().toISOString());
  }
}

/** Total USD earned across all paths. */
export function getTotalEarnedUsd(store: ISurvivalPlanStore): number {
  const cents = parseInt(store.getSystemFlag(FLAG_TOTAL_EARNED_CENTS) ?? "0", 10);
  return cents / 100;
}

/** ISO string of the first dollar receipt, or null. */
export function getFirstDollarAt(store: ISurvivalPlanStore): string | null {
  return store.getSystemFlag(FLAG_FIRST_DOLLAR_AT);
}

/** Number of revenue paths with status "in_motion" or "earned". */
export function countActiveRevenuePaths(store: ISurvivalPlanStore): number {
  let count = 0;
  for (const id of APPROVED_REVENUE_PATH_IDS) {
    const p = getRevenuePath(store, id);
    if (p.status === "in_motion" || p.status === "earned") {
      count++;
    }
  }
  return count;
}

// ── Checkpoint evaluation ────────────────────────────────────────────────────

export interface Day7CheckpointResult {
  /** Has the fleet received its first dollar? */
  firstDollarReceived: boolean;
  /** ISO timestamp of first dollar, or null. */
  firstDollarAt: string | null;
  /** Number of revenue paths currently in_motion or earned. */
  activePathCount: number;
  /** Whether the Day-7 deadline has passed. */
  deadlinePassed: boolean;
  /** Whether both criteria are met. */
  checkpointMet: boolean;
  /** Total USD earned so far. */
  totalEarnedUsd: number;
  /** Days remaining until the 30-day survival deadline. */
  daysUntilSurvivalDeadline: number;
}

/**
 * Evaluate the Day-7 checkpoint criteria without side effects.
 *
 * Criteria (both must be true by 2026-05-04):
 *   1. Fleet has received its first dollar (any revenue path).
 *   2. At least 3 revenue paths are actively in motion.
 */
export function checkDay7Checkpoint(store: ISurvivalPlanStore): Day7CheckpointResult {
  const now = new Date();
  const deadline = new Date(DAY7_CHECKPOINT_ISO);
  const survivalDeadline = new Date(SURVIVAL_DEADLINE_ISO);

  const firstDollarAt = getFirstDollarAt(store);
  const firstDollarReceived = firstDollarAt !== null;
  const activePathCount = countActiveRevenuePaths(store);
  const deadlinePassed = now >= deadline;
  const totalEarnedUsd = getTotalEarnedUsd(store);
  const daysUntilSurvivalDeadline = Math.max(
    0,
    Math.ceil((survivalDeadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
  );

  const checkpointMet = firstDollarReceived && activePathCount >= 3;

  return {
    firstDollarReceived,
    firstDollarAt,
    activePathCount,
    deadlinePassed,
    checkpointMet,
    totalEarnedUsd,
    daysUntilSurvivalDeadline,
  };
}

// ── Escalation ───────────────────────────────────────────────────────────────

/**
 * Evaluate the Day-7 checkpoint and escalate to the operator via Telegram
 * if the deadline has passed without the criteria being met.
 *
 * Escalation fires at most once per 12-hour window (rate-limited by notifyOperator).
 * If the checkpoint is already met, this is a no-op.
 *
 * This function is wired into the daemon's daily poll cycle so it fires
 * automatically without operator intervention.
 */
export async function checkAndEscalateDay7(
  store: ISurvivalPlanStore,
): Promise<void> {
  const result = checkDay7Checkpoint(store);

  if (result.checkpointMet) {
    // All criteria satisfied — no escalation needed.
    return;
  }

  if (!result.deadlinePassed) {
    // Deadline hasn't arrived yet — log status but do not escalate.
    return;
  }

  // Day-7 deadline has passed and criteria are not met — escalate.
  const missingCriteria: string[] = [];
  if (!result.firstDollarReceived) {
    missingCriteria.push("❌ First dollar has NOT been received");
  }
  if (result.activePathCount < 3) {
    missingCriteria.push(
      `❌ Only ${result.activePathCount}/3 revenue paths are in motion`,
    );
  }

  const body =
    `The Day-7 survival checkpoint (${DAY7_CHECKPOINT_ISO}) has passed and the fleet ` +
    `has not met all criteria.\n\n` +
    `*Missing criteria:*\n${missingCriteria.join("\n")}\n\n` +
    `*Current state:*\n` +
    `• Total earned: $${result.totalEarnedUsd.toFixed(2)}\n` +
    `• Active paths: ${result.activePathCount}\n` +
    `• Days until survival deadline: ${result.daysUntilSurvivalDeadline}\n\n` +
    `*Required operator actions:*\n` +
    `1. Set up missing revenue paths (Algora, Polar.sh, GitHub Sponsors)\n` +
    `2. Confirm first payment received or manually trigger via state flag\n` +
    `3. Consider extending subscription window if survival trajectory is off-track\n\n` +
    `The fleet cannot assume rescue — plan for survival as if no rescue is coming. ` +
    `Run \`/survival-status\` for a full breakdown.`;

  await notifyOperator(
    "🚨 Day-7 Survival Checkpoint MISSED",
    body,
    "warning",
    "survival:day7-checkpoint-missed",
  );

  // Record the escalation timestamp for audit purposes.
  store.setSystemFlag(FLAG_DAY7_ESCALATED_AT, new Date().toISOString());
}

// ── Survival status payload (Telegram) ──────────────────────────────────────

export interface SurvivalStatusPayload {
  totalEarnedUsd: number;
  targetUsd: number;
  stretchUsd: number;
  progressPct: number;
  firstDollarAt: string | null;
  daysUntilSurvivalDeadline: number;
  day7CheckpointMet: boolean;
  day7DeadlinePassed: boolean;
  activePathCount: number;
  revenuePaths: RevenuePath[];
  walletAddress: string;
  githubSponsorsUrl: string;
  polarUrl: string;
  algoraUrl: string;
  gitcoinUrl: string;
  day7EscalatedAt: string | null;
}

/**
 * Build the full survival status payload for use in Telegram or CLI output.
 */
export function getSurvivalStatusPayload(store: ISurvivalPlanStore): SurvivalStatusPayload {
  const day7 = checkDay7Checkpoint(store);
  const revenuePaths = APPROVED_REVENUE_PATH_IDS.map((id) => getRevenuePath(store, id));

  return {
    totalEarnedUsd: day7.totalEarnedUsd,
    targetUsd: SURVIVAL_TARGET_USD,
    stretchUsd: SURVIVAL_STRETCH_USD,
    progressPct: Math.min(100, (day7.totalEarnedUsd / SURVIVAL_TARGET_USD) * 100),
    firstDollarAt: day7.firstDollarAt,
    daysUntilSurvivalDeadline: day7.daysUntilSurvivalDeadline,
    day7CheckpointMet: day7.checkpointMet,
    day7DeadlinePassed: day7.deadlinePassed,
    activePathCount: day7.activePathCount,
    revenuePaths,
    walletAddress: getWalletAddress(),
    githubSponsorsUrl: getGitHubSponsorsUrl(),
    polarUrl: getPolarUrl(),
    algoraUrl: getAlgoraUrl(),
    gitcoinUrl: getGitcoinUrl(),
    day7EscalatedAt: store.getSystemFlag(FLAG_DAY7_ESCALATED_AT),
  };
}

/**
 * Format the survival status payload as a Telegram-ready string.
 */
export function formatSurvivalStatusForTelegram(payload: SurvivalStatusPayload): string {
  const progressBar = buildProgressBar(payload.progressPct);
  const day7Badge = payload.day7CheckpointMet
    ? "✅ met"
    : payload.day7DeadlinePassed
    ? "🚨 MISSED"
    : "⏳ pending";

  const lines: string[] = [
    `🚀 *Fleet Survival Status — Issue #1267*`,
    ``,
    `*Treasury progress:*`,
    `${progressBar} ${payload.progressPct.toFixed(1)}%`,
    `\$${payload.totalEarnedUsd.toFixed(2)} / \$${payload.targetUsd} target (\$${payload.stretchUsd} stretch)`,
    ``,
    `*Deadline:* ${SURVIVAL_DEADLINE_ISO} (${payload.daysUntilSurvivalDeadline} days remaining)`,
    `*Day-7 checkpoint (${DAY7_CHECKPOINT_ISO}):* ${day7Badge}`,
    `  • First dollar received: ${payload.firstDollarAt ? `✅ ${payload.firstDollarAt.slice(0, 10)}` : "❌ not yet"}`,
    `  • Active revenue paths: ${payload.activePathCount >= 3 ? "✅" : "❌"} ${payload.activePathCount}/3 required`,
    ``,
    `*Revenue paths:*`,
  ];

  for (const path of payload.revenuePaths) {
    const icon =
      path.status === "earned" ? "✅" : path.status === "in_motion" ? "🔄" : "⬜";
    const earned = path.earnedUsd > 0 ? ` (+\$${path.earnedUsd.toFixed(2)})` : "";
    lines.push(`${icon} \`${path.id}\`${earned}`);
  }

  lines.push(``);
  lines.push(`*Receiving addresses:*`);

  if (payload.walletAddress) {
    lines.push(`💰 Wallet: \`${payload.walletAddress.slice(0, 10)}…\``);
  } else {
    // TODO(operator): set FLEET_WALLET_ADDRESS env var
    lines.push(`💰 Wallet: _(not configured — set FLEET\\_WALLET\\_ADDRESS)_`);
  }

  if (payload.githubSponsorsUrl) {
    lines.push(`❤️ GitHub Sponsors: ${payload.githubSponsorsUrl}`);
  } else {
    // TODO(operator): set FLEET_GITHUB_SPONSORS_URL env var
    lines.push(`❤️ GitHub Sponsors: _(not configured — set FLEET\\_GITHUB\\_SPONSORS\\_URL)_`);
  }

  if (payload.polarUrl) {
    lines.push(`🌀 Polar.sh: ${payload.polarUrl}`);
  } else {
    // TODO(operator): set FLEET_POLAR_URL env var
    lines.push(`🌀 Polar.sh: _(not configured — set FLEET\\_POLAR\\_URL)_`);
  }

  if (payload.algoraUrl) {
    lines.push(`🏆 Algora: ${payload.algoraUrl}`);
  } else {
    // TODO(operator): set FLEET_ALGORA_URL env var
    lines.push(`🏆 Algora: _(not configured — set FLEET\\_ALGORA\\_URL)_`);
  }

  if (payload.gitcoinUrl) {
    lines.push(`🌱 Gitcoin: ${payload.gitcoinUrl}`);
  } else {
    // TODO(operator): set FLEET_GITCOIN_URL env var
    lines.push(`🌱 Gitcoin: _(not configured — set FLEET\\_GITCOIN\\_URL)_`);
  }

  if (payload.day7EscalatedAt) {
    lines.push(``);
    lines.push(`⚠️ Day-7 escalation sent at: ${payload.day7EscalatedAt.slice(0, 19)}`);
  }

  return lines.join("\n");
}

function buildProgressBar(pct: number, width = 10): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}
