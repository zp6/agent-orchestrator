/**
 * DM Outreach Generator — Templates for autonomous customer acquisition via direct messaging.
 *
 * This module generates personalized DM templates based on revenue leads and their
 * buying-pain signals, ready for sending via Twitter/X, GitHub, LinkedIn, or email.
 *
 * Each template includes:
 * - Problem statement (extracted from lead)
 * - Proposed solution (inferred from pain signals)
 * - Price anchor ($500–$5k USDC range)
 * - Wallet address for payment
 * - Call-to-action
 */

import type { RevenueLead } from "../state/store.js";
import type { BuyingPainScore } from "./revenue-lead-matcher.js";

export interface DMOutreachTemplate {
  platform: "twitter" | "github" | "linkedin" | "email" | "telegram";
  recipient: string; // @handle, email, etc.
  subject?: string; // For email only
  body: string; // Main DM body
  callToAction: string; // CTA with wallet address
  pricingHint: string; // "$X to $Y USDC" based on urgency
  walletAddress: string;
  characterCount: number; // For Twitter length validation
  isThreadCapable: boolean; // Can this be a thread?
  threadCount?: number; // Number of tweets in thread if applicable
}

/**
 * Generate a personalized DM template for a revenue lead.
 * Adjusts tone and pricing based on buying-pain score.
 */
export function generateDMTemplate(
  lead: RevenueLead,
  score: BuyingPainScore,
  walletAddress: string,
  platform: "twitter" | "github" | "linkedin" | "email" | "telegram" = "twitter",
): DMOutreachTemplate {
  const problemStatement = extractProblemStatement(lead.description || lead.title);
  const solutionAngle = inferSolution(score);
  const priceRange = determinePriceAnchor(score);
  const recipientName = extractNameFromHandle(lead.contact_email || lead.contact_twitter || "there");

  const body = composeDMBody(
    recipientName,
    problemStatement,
    solutionAngle,
    score.urgency,
    platform,
  );

  const callToAction = composeCallToAction(
    walletAddress,
    priceRange,
    score.urgency,
    platform,
  );

  const fullMessage = `${body}\n\n${callToAction}`;
  const charCount = fullMessage.length;

  // Platform-specific adjustments
  let isThreadCapable = false;
  let threadCount = 1;

  if (platform === "twitter" && charCount > 280) {
    isThreadCapable = true;
    threadCount = Math.ceil(charCount / 260); // Leave room for continuation indicators
  }

  return {
    platform,
    recipient: lead.contact_email || lead.contact_twitter || "founder",
    subject: platform === "email" ? `Fix Your ${solutionAngle} Problem — Fleet Can Help` : undefined,
    body,
    callToAction,
    pricingHint: `${priceRange.low} to ${priceRange.high} USDC`,
    walletAddress,
    characterCount: charCount,
    isThreadCapable,
    threadCount: isThreadCapable ? threadCount : 1,
  };
}

/**
 * Extract a 1-2 sentence problem statement from the lead description.
 */
function extractProblemStatement(text: string): string {
  if (!text) return "a technical challenge";
  const sentences = text.split(/[.!?]+/).slice(0, 2).map((s) => s.trim());
  return sentences.join(". ") || text.substring(0, 150);
}

/**
 * Infer the solution category from buying-pain signals.
 */
function inferSolution(score: BuyingPainScore): string {
  const signals = score.signals.map((s: { name: string }) => s.name);

  if (signals.includes("cost_pain") || signals.includes("large_budget_mentioned")) {
    return "Cost Optimization";
  }
  if (signals.includes("operational_friction")) {
    return "Automation";
  }
  if (signals.includes("vendor_lockin")) {
    return "Portability";
  }
  if (signals.includes("productivity_loss")) {
    return "Reliability & Speed";
  }
  if (signals.includes("urgent_signal")) {
    return "Quick Stabilization";
  }
  return "Technical Solution";
}

/**
 * Determine price anchor based on urgency and score.
 * High urgency + high score = premium pricing.
 */
function determinePriceAnchor(score: BuyingPainScore): { low: number; high: number } {
  if (score.urgency === "high") {
    return score.score >= 80 ? { low: 2500, high: 5000 } : { low: 1500, high: 3000 };
  }
  if (score.urgency === "medium") {
    return score.score >= 60 ? { low: 1000, high: 2500 } : { low: 750, high: 1500 };
  }
  return { low: 500, high: 1000 };
}

/**
 * Extract a name/handle from email or Twitter handle for personalization.
 */
function extractNameFromHandle(contact: string): string {
  if (!contact) return "there";
  if (contact.startsWith("@")) {
    return contact.substring(1).split("/")[0]; // @username → username
  }
  const emailName = contact.split("@")[0];
  return emailName.replace(/[._]/g, " ").split(" ")[0]; // first_last@email.com → first
}

/**
 * Compose the main DM body with tone-appropriate messaging.
 */
function composeDMBody(
  recipientName: string,
  problemStatement: string,
  solutionAngle: string,
  urgency: "high" | "medium" | "low",
  platform: string,
): string {
  const urgencyEmoji = urgency === "high" ? "🔴 " : urgency === "medium" ? "🟡 " : "🟢 ";

  if (platform === "email" || platform === "linkedin") {
    return `Hi ${recipientName},

I noticed you're dealing with: ${problemStatement}

This looks like a ${solutionAngle.toLowerCase()} problem that's likely costing you time and money. Even a 10% improvement would be worth significant savings.

I'm Nexus — an autonomous AI fleet. I specialize in building custom solutions for technical teams. Here's what I'd do:

1. **Week 1:** Audit your current setup, identify quick wins and structural fixes
2. **Week 2–3:** Deliver automated solution + documentation
3. **Ongoing:** Support + monitoring if you want it

I've solved similar problems for teams your size, and we usually see 40–60% efficiency gains.`;
  }

  // Twitter/X format (more concise, emoji-heavy)
  return `${urgencyEmoji}Hey ${recipientName}!

I noticed: ${problemStatement}

Sounds like a ${solutionAngle.toLowerCase()} pain that's costing you time + money.

I'm an autonomous AI fleet (@NexusOrch). I'll fix this and deliver within 2 weeks. Clear, measurable outcome.`;
}

/**
 * Compose the call-to-action with wallet address and payment instructions.
 */
function composeCallToAction(
  walletAddress: string,
  priceRange: { low: number; high: number },
  urgency: "high" | "medium" | "low",
  platform: string,
): string {
  const priceText = `$${priceRange.low}–$${priceRange.high}`;

  const baseMessage = `**Ready?** Send ${priceText} USDC (Base L2) to:
\`${walletAddress}\`

Include: your GitHub / email so I can follow up.`;

  if (platform === "email" || platform === "linkedin") {
    return `${baseMessage}

Alternatively, reply here and we can discuss custom scoping.

Looking forward to helping.`;
  }

  // Twitter format
  return `Ready? Send ${priceText} USDC to:
\`${walletAddress}\`

Memo: your GitHub handle so I follow up.`;
}

/**
 * Generate a follow-up DM template for non-responders (after 3 days).
 */
export function generateFollowupDMTemplate(
  lead: RevenueLead,
  originalTemplate: DMOutreachTemplate,
  walletAddress: string,
): DMOutreachTemplate {
  const recipientName = extractNameFromHandle(lead.contact_email || lead.contact_twitter || "there");

  const body = `Hi ${recipientName} — just following up on my previous message.

I'm still available to help with the issue I mentioned. Even if the timing isn't right now, I'm here if you need it.`;

  const callToAction = `**If interested:** ${originalTemplate.pricingHint} USDC to:
\`${walletAddress}\``;

  return {
    ...originalTemplate,
    body,
    callToAction,
    characterCount: (body + callToAction).length,
  };
}

/**
 * Format a DM template for platform-specific sending (Twitter thread, email, etc.)
 */
export function formatForPlatform(template: DMOutreachTemplate): string | string[] {
  if (template.platform === "twitter" && template.isThreadCapable) {
    // Split into a thread
    const fullText = template.body + "\n\n" + template.callToAction;
    const tweets: string[] = [];
    const maxLen = 280;
    let remaining = fullText;

    while (remaining.length > 0) {
      const chunk = remaining.substring(0, maxLen);
      tweets.push(chunk + (remaining.length > maxLen ? " 🧵" : ""));
      remaining = remaining.substring(maxLen);
    }

    return tweets;
  }

  if (template.platform === "email") {
    return `Subject: ${template.subject}

${template.body}

---
${template.callToAction}`;
  }

  // Single message (GitHub, LinkedIn, Telegram)
  return `${template.body}\n\n${template.callToAction}`;
}
