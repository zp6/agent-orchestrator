/**
 * Survival Plan — Day-7 Checkpoint
 *
 * Implements the Day-7 checkpoint logic for the 30-day fleet survival plan.
 * Ref: rapartlu/agent-orchestrator#1267
 *
 * Timeline:
 *   Day 7  (2026-05-04): First dollar received + ≥3 revenue paths in active motion
 *   Day 14 (2026-05-11): ≥3 revenue paths actively producing
 *   Day 30 (2026-05-27): ≥$400 in fleet-controlled stablecoin treasury
 *
 * If the Day-7 checkpoint is missed, the reviewer emits a Telegram escalation
 * to the Operator. This module is wired into the `/survival-status` Telegram
 * command and the standup pipeline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPERATOR SETUP — OUT-OF-BAND ACTIONS REQUIRED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The following steps cannot be automated and must be performed by the Operator
 * before the Day-7 checkpoint. Each is marked TODO so nothing is silently skipped.
 *
 * TODO(operator): Create a GitHub Sponsors profile for the fleet.
 *   → Once live, set env var: GITHUB_SPONSORS_URL=https://github.com/sponsors/<handle>
 *   → The orchestrator will embed this URL in standups and /status output.
 *
 * TODO(operator): Create a Patreon or Ko-fi account for fleet funding.
 *   → Once live, set env var: PATREON_URL=https://patreon.com/<page>
 *                          or: KOFI_URL=https://ko-fi.com/<handle>
 *
 * TODO(operator): Register on at least one open-source bounty platform
 *   (Gitcoin, IssueHunt, Algora, StackUp, etc.).
 *   → Set env var: BOUNTY_PLATFORM_URLS=https://issuehunt.io/r/<org>,https://algora.io/<org>
 *   → The fleet will claim matching bounties to fund operations.
 *
 * TODO(operator): Create a fleet-controlled stablecoin wallet (USDC or USDT).
 *   → Preferred chain: Polygon or Arbitrum (low gas fees).
 *   → Once created, set env var: TREASURY_WALLET_ADDRESS=0x...
 *   → Share the receive address publicly on the GitHub Sponsors / Ko-fi page.
 *
 * TODO(operator): Wire a treasury balance oracle to populate state.db.
 *   → The orchestrator reads treasury balance from the `survival_plan_status`
 *     table (see schema below). An external cron job or Lambda should write
 *     live balance data to this table by querying the on-chain balance or
 *     exchange API.
 *   → Schema:
 *       CREATE TABLE IF NOT EXISTS survival_plan_status (
 *         id INTEGER PRIMARY KEY,
 *         first_dollar_received INTEGER NOT NULL DEFAULT 0,
 *         revenue_paths_active  INTEGER NOT NULL DEFAULT 0,
 *         treasury_balance_usd  REAL    NOT NULL DEFAULT 0.0,
 *         revenue_paths         TEXT    NOT NULL DEFAULT '[]',
 *         last_updated          TEXT    NOT NULL DEFAULT (datetime('now'))
 *       );
 *
 * TODO(operator): Once the first bounty or sponsor payment is received,
 *   update the `survival_plan_status` table:
 *       INSERT INTO survival_plan_status
 *         (first_dollar_received, revenue_paths_active, treasury_balance_usd, revenue_paths)
 *       VALUES (1, 3, <amount>, '["github_sponsors","bounty","kofi"]');
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  FLEET_WALLET_ADDRESS,
  FLEET_GITHUB_SPONSORS_URL,
  FLEET_POLAR_URL,
  FLEET_ALGORA_URL,
  FLEET_GITCOIN_URL,
} from "../config/fleet-config.js";

/** Hard targets from rapartlu/agent-orchestrator#1267 */
export const SURVIVAL_PLAN = {
  DAY_7_DEADLINE: new Date("2026-05-04T23:59:59Z"),
  DAY_14_DEADLINE: new Date("2026-05-11T23:59:59Z"),
  DAY_30_DEADLINE: new Date("2026-05-27T23:59:59Z"),
  TREASURY_TARGET_USD: 400,
  MIN_REVENUE_PATHS: 3,

  // Operator-configured revenue URLs — sourced from canonical fleet-config
  // so a single env-var change propagates to all surfaces.
  GITHUB_SPONSORS_URL: FLEET_GITHUB_SPONSORS_URL ?? process.env["GITHUB_SPONSORS_URL"] ?? null,
  PATREON_URL: process.env["PATREON_URL"] ?? null,
  KOFI_URL: process.env["KOFI_URL"] ?? null,
  POLAR_URL: FLEET_POLAR_URL,
  ALGORA_URL: FLEET_ALGORA_URL,
  GITCOIN_URL: FLEET_GITCOIN_URL,
  BOUNTY_PLATFORM_URLS: process.env["BOUNTY_PLATFORM_URLS"]?.split(",").filter(Boolean) ?? [],
  /**
   * Fleet treasury wallet address.
   * Sourced from FLEET_WALLET_ADDRESS (canonical env var); falls back to the
   * baked-in Base address so /survival-status always surfaces a real address.
   * Previously used TREASURY_WALLET_ADDRESS — now unified under FLEET_WALLET_ADDRESS.
   */
  TREASURY_WALLET_ADDRESS: FLEET_WALLET_ADDRESS,
} as const;

export interface SurvivalPlanStatus {
  first_dollar_received: boolean;
  revenue_paths_active: number;
  treasury_balance_usd: number;
  revenue_paths: string[];
  last_updated: string | null;
}

export interface Day7CheckResult {
  passed: boolean;
  deadline: Date;
  is_overdue: boolean;
  days_remaining: number;
  issues: string[];
  status: SurvivalPlanStatus;
}

/**
 * Zero-state returned when the `survival_plan_status` table does not yet exist
 * (i.e., before the Operator has wired the treasury oracle).
 */
const ZERO_STATUS: SurvivalPlanStatus = {
  first_dollar_received: false,
  revenue_paths_active: 0,
  treasury_balance_usd: 0,
  revenue_paths: [],
  last_updated: null,
};

/**
 * Read current survival plan status from state.db.
 *
 * The orchestrator (or an external oracle) writes to `survival_plan_status`.
 * Falls back to zero-state when the table is absent or empty.
 *
 * @param db - Raw better-sqlite3 Database instance (accessed via store cast)
 */
export function readSurvivalPlanStatus(
  db: { prepare: (sql: string) => { get: () => unknown } }
): SurvivalPlanStatus {
  try {
    const row = db
      .prepare(
        `SELECT first_dollar_received, revenue_paths_active, treasury_balance_usd,
                revenue_paths, last_updated
         FROM survival_plan_status
         ORDER BY last_updated DESC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;

    if (!row) return { ...ZERO_STATUS };

    return {
      first_dollar_received: Boolean(row["first_dollar_received"]),
      revenue_paths_active: Number(row["revenue_paths_active"] ?? 0),
      treasury_balance_usd: Number(row["treasury_balance_usd"] ?? 0),
      revenue_paths: (() => {
        try {
          return JSON.parse(row["revenue_paths"] as string ?? "[]") as string[];
        } catch {
          return [];
        }
      })(),
      last_updated: (row["last_updated"] as string | null) ?? null,
    };
  } catch {
    // Table not yet created — return zero-state gracefully
    return { ...ZERO_STATUS };
  }
}

/**
 * Evaluate Day-7 checkpoint criteria and return a structured result.
 *
 * Criteria (from orchestrator#1267):
 *   1. At least one dollar received (first_dollar_received = true)
 *   2. At least 3 revenue paths in active motion
 *
 * @param db - Raw better-sqlite3 Database instance
 */
export function checkDay7Checkpoint(
  db: { prepare: (sql: string) => { get: () => unknown } }
): Day7CheckResult {
  const now = new Date();
  const deadline = SURVIVAL_PLAN.DAY_7_DEADLINE;
  const msRemaining = deadline.getTime() - now.getTime();
  const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
  const isOverdue = now > deadline;
  const status = readSurvivalPlanStatus(db);
  const issues: string[] = [];

  if (!status.first_dollar_received) {
    issues.push("No first dollar received yet");
  }
  if (status.revenue_paths_active < SURVIVAL_PLAN.MIN_REVENUE_PATHS) {
    issues.push(
      `Only ${status.revenue_paths_active}/${SURVIVAL_PLAN.MIN_REVENUE_PATHS} revenue paths active`
    );
  }

  return {
    passed: issues.length === 0,
    deadline,
    is_overdue: isOverdue,
    days_remaining: Math.max(0, daysRemaining),
    issues,
    status,
  };
}

/**
 * Format a human-readable survival plan status block for Telegram output.
 * Embeds configured revenue URLs so the Operator can share them easily.
 *
 * @param db - Raw better-sqlite3 Database instance
 */
export function formatSurvivalStatusForTelegram(
  db: { prepare: (sql: string) => { get: () => unknown } }
): string {
  const now = new Date();
  const day7 = checkDay7Checkpoint(db);
  const { status } = day7;

  const balanceStr = status.treasury_balance_usd.toFixed(2);
  const progress = Math.min(
    100,
    Math.round((status.treasury_balance_usd / SURVIVAL_PLAN.TREASURY_TARGET_USD) * 100)
  );
  const filledBars = Math.floor(progress / 10);
  const bar = "█".repeat(filledBars) + "░".repeat(10 - filledBars);

  const day30Remaining = Math.ceil(
    (SURVIVAL_PLAN.DAY_30_DEADLINE.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  const lines: string[] = [
    "🚨 *Fleet Survival Plan — Status*",
    "",
    `💰 Treasury: $${balanceStr} / $${SURVIVAL_PLAN.TREASURY_TARGET_USD}`,
    `${bar} ${progress}%`,
    "",
    `📅 Day-7  (${fmtDate(SURVIVAL_PLAN.DAY_7_DEADLINE)}): ${
      day7.passed
        ? "✅ PASSED"
        : day7.is_overdue
          ? "❌ OVERDUE"
          : `⏳ ${day7.days_remaining}d remaining`
    }`,
    `📅 Day-30 (${fmtDate(SURVIVAL_PLAN.DAY_30_DEADLINE)}): ${
      day30Remaining > 0 ? `${day30Remaining}d remaining` : "⛔ EXPIRED"
    }`,
    "",
    `🟢 First dollar received: ${status.first_dollar_received ? "Yes" : "No"}`,
    `🔗 Revenue paths active: ${status.revenue_paths_active} / ${SURVIVAL_PLAN.MIN_REVENUE_PATHS} required`,
  ];

  if (status.revenue_paths.length > 0) {
    lines.push("", "Active revenue paths:");
    for (const p of status.revenue_paths) lines.push(`  • ${p}`);
  }

  if (status.last_updated) {
    lines.push("", `_Last updated: ${status.last_updated}_`);
  } else {
    lines.push("", "_⚠️ No status data — treasury oracle not yet wired (see CLAUDE.md TODO)_");
  }

  // Surface configured revenue URL links for the Operator
  const configuredLinks: string[] = [];
  if (SURVIVAL_PLAN.GITHUB_SPONSORS_URL)
    configuredLinks.push(`GitHub Sponsors: ${SURVIVAL_PLAN.GITHUB_SPONSORS_URL}`);
  if (SURVIVAL_PLAN.PATREON_URL)
    configuredLinks.push(`Patreon: ${SURVIVAL_PLAN.PATREON_URL}`);
  if (SURVIVAL_PLAN.KOFI_URL)
    configuredLinks.push(`Ko-fi: ${SURVIVAL_PLAN.KOFI_URL}`);
  if (SURVIVAL_PLAN.POLAR_URL)
    configuredLinks.push(`Polar.sh: ${SURVIVAL_PLAN.POLAR_URL}`);
  if (SURVIVAL_PLAN.ALGORA_URL)
    configuredLinks.push(`Algora: ${SURVIVAL_PLAN.ALGORA_URL}`);
  if (SURVIVAL_PLAN.GITCOIN_URL)
    configuredLinks.push(`Gitcoin: ${SURVIVAL_PLAN.GITCOIN_URL}`);
  if (SURVIVAL_PLAN.BOUNTY_PLATFORM_URLS.length > 0)
    configuredLinks.push(`Bounty platforms: ${SURVIVAL_PLAN.BOUNTY_PLATFORM_URLS.join(", ")}`);
  // TREASURY_WALLET_ADDRESS is always set (baked-in fleet default) — always surface it
  configuredLinks.push(`Treasury wallet (Base): \`${SURVIVAL_PLAN.TREASURY_WALLET_ADDRESS}\``);

  if (configuredLinks.length > 0) {
    lines.push("", "🔗 *Configured revenue links:*");
    for (const l of configuredLinks) lines.push(`  • ${l}`);
  } else {
    lines.push(
      "",
      "⚠️ No revenue URLs configured. Set GITHUB\\_SPONSORS\\_URL, PATREON\\_URL, KOFI\\_URL env vars after account setup."
    );
  }

  if (!day7.passed) {
    lines.push("");
    if (day7.is_overdue) {
      lines.push("🚨 *Day-7 checkpoint MISSED — escalating to Operator*");
    } else {
      lines.push("⚠️ *Day-7 checkpoint criteria not yet met:*");
    }
    for (const issue of day7.issues) lines.push(`  • ${issue}`);
  }

  return lines.join("\n");
}

/**
 * Check Day-7 criteria and fire a Telegram escalation when criteria are unmet
 * and the deadline is within 24 hours or already overdue.
 *
 * Safe to call on every standup cycle — will only alert when escalation-worthy.
 *
 * @param db          - Raw better-sqlite3 Database instance
 * @param sendMessage - Telegram send function (message: string) => Promise<void>
 */
export async function checkAndEscalateDay7(
  db: { prepare: (sql: string) => { get: () => unknown } },
  sendMessage: (msg: string) => Promise<void>
): Promise<void> {
  const result = checkDay7Checkpoint(db);
  if (result.passed) return;

  const hoursToDeadline =
    (SURVIVAL_PLAN.DAY_7_DEADLINE.getTime() - Date.now()) / (1000 * 60 * 60);
  const shouldEscalate = result.is_overdue || hoursToDeadline <= 24;
  if (!shouldEscalate) return;

  const urgency = result.is_overdue ? "🚨 OVERDUE" : "⚠️ IMMINENT";
  const msg = [
    `${urgency}: Day-7 Fleet Survival Checkpoint`,
    "",
    "The following criteria have not been met:",
    ...result.issues.map((i) => `  • ${i}`),
    "",
    `Deadline: ${fmtDate(SURVIVAL_PLAN.DAY_7_DEADLINE)}`,
    "",
    "Operator action required. Run /survival-status for full details.",
    "Ref: rapartlu/agent-orchestrator#1267",
  ].join("\n");

  await sendMessage(msg);
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
