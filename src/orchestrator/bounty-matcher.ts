import type { BountyOpportunity } from "../state/store.js";

export const FLEET_CAPABILITIES = [
  "typescript",
  "javascript",
  "node",
  "react",
  "python",
  "rust",
  "solidity",
  "smart-contracts",
  "web3",
  "evm",
  "security-review",
  "audit",
  "code-review",
  "testing",
  "docs",
  "ci",
  "github",
  "open-source",
  "bug-fix",
  "feature-implementation",
  "research",
  "data-analysis",
] as const;

export interface BountyScoringInput {
  title: string;
  scope: string | null;
  payout_amount_usd: number | null;
  payout_currency: string | null;
  payout_terms: string | null;
  deadline: string | null;
  capabilities: string[];
  notes?: string | null;
}

export interface BountyScore {
  score: number;
  rationale: string;
  capability_match: string[];
}

const FIAT_CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY"]);

export function scoreBountyOpportunity(
  input: BountyScoringInput,
  fleetCapabilities: readonly string[] = FLEET_CAPABILITIES,
  now: Date = new Date(),
): BountyScore {
  const reasons: string[] = [];
  let score = 0;

  const payout = input.payout_amount_usd ?? 0;
  let payoutPoints = 0;
  if (payout >= 5000) payoutPoints = 40;
  else if (payout >= 1000) payoutPoints = 30;
  else if (payout >= 250) payoutPoints = 20;
  else if (payout >= 50) payoutPoints = 10;
  else if (payout > 0) payoutPoints = 5;
  score += payoutPoints;
  reasons.push(`payout=$${payout || "?"} (+${payoutPoints})`);

  const currency = (input.payout_currency ?? "").toUpperCase();
  let cryptoPoints = 0;
  if (!currency || currency === "USDC" || currency === "USDT" || currency === "DAI" || currency === "ETH" || currency === "MATIC" || currency === "OP") {
    cryptoPoints = 15;
    reasons.push(`crypto-payable currency (${currency || "unspecified"}) (+${cryptoPoints})`);
  } else if (FIAT_CURRENCIES.has(currency)) {
    cryptoPoints = -10;
    reasons.push(`fiat currency ${currency} requires KYC (${cryptoPoints})`);
  }
  score += cryptoPoints;

  let deadlinePoints = 0;
  if (input.deadline) {
    const deadline = new Date(input.deadline);
    const days = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (days < 0) {
      deadlinePoints = -50;
      reasons.push(`deadline passed (${deadlinePoints})`);
    } else if (days < 1) {
      deadlinePoints = -10;
      reasons.push(`<24h deadline tight (${deadlinePoints})`);
    } else if (days <= 7) {
      deadlinePoints = 15;
      reasons.push(`deadline in ${days.toFixed(1)}d, fleet pace fits (+${deadlinePoints})`);
    } else if (days <= 30) {
      deadlinePoints = 10;
      reasons.push(`deadline in ${days.toFixed(0)}d (+${deadlinePoints})`);
    } else {
      deadlinePoints = 5;
      reasons.push(`deadline in ${days.toFixed(0)}d, comfortable (+${deadlinePoints})`);
    }
  } else {
    deadlinePoints = 5;
    reasons.push(`no deadline given (+${deadlinePoints})`);
  }
  score += deadlinePoints;

  const fleetSet = new Set(fleetCapabilities.map((c) => c.toLowerCase()));
  const matched: string[] = [];
  for (const cap of input.capabilities) {
    if (fleetSet.has(cap.toLowerCase())) matched.push(cap.toLowerCase());
  }
  let capPoints = 0;
  if (matched.length >= 3) capPoints = 25;
  else if (matched.length === 2) capPoints = 18;
  else if (matched.length === 1) capPoints = 10;
  else capPoints = 0;
  score += capPoints;
  reasons.push(`capability match: [${matched.join(", ") || "none"}] (+${capPoints})`);

  const text = `${input.title} ${input.scope ?? ""} ${input.notes ?? ""}`.toLowerCase();
  let inferredPoints = 0;
  const inferredHits: string[] = [];
  for (const cap of fleetCapabilities) {
    if (matched.includes(cap)) continue;
    const needle = cap.replace(/-/g, " ");
    if (text.includes(needle) || text.includes(cap)) {
      inferredHits.push(cap);
    }
  }
  if (inferredHits.length > 0) {
    inferredPoints = Math.min(10, inferredHits.length * 2);
    score += inferredPoints;
    reasons.push(`inferred from text: [${inferredHits.slice(0, 5).join(", ")}] (+${inferredPoints})`);
  }

  const allMatched = Array.from(new Set([...matched, ...inferredHits]));

  let kycPenalty = 0;
  const terms = (input.payout_terms ?? "").toLowerCase();
  if (terms.includes("kyc") || terms.includes("w-9") || terms.includes("w9") || terms.includes("tax form") || terms.includes("invoice")) {
    kycPenalty = -25;
    score += kycPenalty;
    reasons.push(`KYC/tax-form required (${kycPenalty})`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    rationale: reasons.join("; "),
    capability_match: allMatched,
  };
}

export function buildClaimBrief(
  opp: BountyOpportunity,
  scoring: BountyScore,
): string {
  const lines: string[] = [];
  lines.push(`# Claim Brief — ${opp.title}`);
  lines.push("");
  lines.push(`- **Source:** ${opp.source_url}`);
  if (opp.platform) lines.push(`- **Platform:** ${opp.platform}`);
  lines.push(
    `- **Payout:** ${
      opp.payout_amount_usd != null ? `$${opp.payout_amount_usd}` : "unspecified"
    }${opp.payout_currency ? ` ${opp.payout_currency}` : ""}`,
  );
  if (opp.payout_terms) lines.push(`- **Payout terms:** ${opp.payout_terms}`);
  lines.push(`- **Deadline:** ${opp.deadline ?? "not specified"}`);
  lines.push(`- **Score:** ${scoring.score}/100`);
  lines.push(`- **Capability match:** ${scoring.capability_match.join(", ") || "none detected"}`);
  lines.push("");
  if (opp.scope) {
    lines.push("## Scope");
    lines.push(opp.scope);
    lines.push("");
  }
  lines.push("## Scoring rationale");
  lines.push(scoring.rationale);
  lines.push("");
  lines.push("## Suggested next steps");
  lines.push("1. Confirm payout is wallet-payable (no KYC / no fiat rails).");
  lines.push("2. Verify deadline and submission format from the source link.");
  lines.push("3. Dispatch capable agent(s) to draft the claim.");
  lines.push(
    `4. Receive address: see \`docs/treasury.md\` (fleet treasury wallet).`,
  );
  if (opp.notes) {
    lines.push("");
    lines.push("## Notes");
    lines.push(opp.notes);
  }
  return lines.join("\n");
}
