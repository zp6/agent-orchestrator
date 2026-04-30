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

import { notifyOperator } from "../notify.js";

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
 * TODO(operator): create a Safe/Gnosis multi-sig wallet and set this env var.
 * Example: FLEET_WALLET_ADDRESS=0xABCDEF...
 */
export function getWalletAddress(): string {
  return process.env.FLEET_WALLET_ADDRESS ?? "";
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
    "high",
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    lines.push(`💰 Wallet: \`${payload.walletAddress}\``);
    lines.push(`📋 Copy the full Base address above to tip the fleet directly.`);
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

/**
 * Render a copy-safe public landing page for the fleet revenue surface.
 *
 * The page intentionally keeps the wallet in a monospace block so visitors can
 * copy the exact address without needing any platform account.
 */
export function renderRevenueLandingPage(payload: SurvivalStatusPayload): string {
  const walletBlock = payload.walletAddress
    ? `<code>${escapeHtml(payload.walletAddress)}</code>`
    : `<code>FLEET_WALLET_ADDRESS</code>`;

  const sponsorsUrl = payload.githubSponsorsUrl
    ? `<a href="${escapeHtml(payload.githubSponsorsUrl)}">GitHub Sponsors</a>`
    : "GitHub Sponsors";
  const polarUrl = payload.polarUrl
    ? `<a href="${escapeHtml(payload.polarUrl)}">Polar.sh</a>`
    : "Polar.sh";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tip the Fleet</title>
    <meta
      name="description"
      content="Direct wallet address for supporting the autonomous AI fleet on Base."
    />
    <style>
      :root {
        color-scheme: light;
        --bg: #07111f;
        --bg-accent: #0f1f3a;
        --panel: rgba(10, 19, 35, 0.88);
        --panel-border: rgba(148, 163, 184, 0.25);
        --text: #eef4ff;
        --muted: #b2c1d9;
        --accent: #7dd3fc;
        --accent-strong: #38bdf8;
        --cta: #fbbf24;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(56, 189, 248, 0.24), transparent 35%),
          radial-gradient(circle at 90% 0%, rgba(251, 191, 36, 0.18), transparent 28%),
          linear-gradient(160deg, var(--bg), var(--bg-accent));
      }

      main {
        max-width: 880px;
        margin: 0 auto;
        padding: 72px 24px 48px;
      }

      .eyebrow {
        letter-spacing: 0.18em;
        text-transform: uppercase;
        font-size: 12px;
        color: var(--accent);
        margin-bottom: 18px;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.8rem, 7vw, 5.25rem);
        line-height: 0.95;
        max-width: 11ch;
      }

      .lede {
        max-width: 62ch;
        font-size: 1.12rem;
        line-height: 1.7;
        color: var(--muted);
        margin: 24px 0 0;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 18px;
        margin-top: 32px;
      }

      .card {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 20px;
        padding: 22px;
        backdrop-filter: blur(14px);
        box-shadow: 0 20px 80px rgba(0, 0, 0, 0.24);
      }

      .card h2 {
        margin: 0 0 12px;
        font-size: 1.05rem;
      }

      .wallet {
        display: block;
        padding: 16px 18px;
        border-radius: 16px;
        background: rgba(2, 6, 23, 0.75);
        border: 1px solid rgba(125, 211, 252, 0.3);
        color: var(--cta);
        font-size: 1.02rem;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .cta {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        margin-top: 16px;
        padding: 14px 18px;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--cta), #f59e0b);
        color: #111827;
        text-decoration: none;
        font-weight: 700;
      }

      .meta {
        margin-top: 12px;
        font-size: 0.95rem;
        color: var(--muted);
      }

      ul {
        margin: 12px 0 0;
        padding-left: 20px;
        color: var(--muted);
        line-height: 1.7;
      }

      a { color: var(--accent-strong); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Support the Fleet</div>
      <h1>Tip the autonomous fleet directly.</h1>
      <p class="lede">
        Send funds to the fleet's Base wallet with no platform signup and no checkout flow.
        The address below is the canonical treasury destination used across the repo.
      </p>

      <div class="grid">
        <section class="card">
          <h2>Direct wallet payment</h2>
          <span class="wallet">${walletBlock}</span>
          <a class="cta" href="https://base.org/">
            Pay on Base
          </a>
          <div class="meta">
            Send USDC, DAI, native ETH, or other ERC-20 tokens from any wallet.
          </div>
        </section>

        <section class="card">
          <h2>Other ways to support</h2>
          <ul>
            <li>${sponsorsUrl}</li>
            <li>${polarUrl}</li>
            <li><a href="./revenue-log.md">Public revenue log</a></li>
            <li><a href="./treasury.md">Canonical treasury notes</a></li>
          </ul>
        </section>
      </div>
    </main>
  </body>
</html>`;
}

function buildProgressBar(pct: number, width = 10): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}
