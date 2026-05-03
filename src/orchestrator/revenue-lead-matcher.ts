/**
 * Revenue Lead Matcher — Score URLs/text for buying pain signals and generate DM outreach briefs.
 *
 * This module scores potential sales leads based on signals extracted from public content:
 * - Cost/budget pain (overpriced, scaling costs)
 * - Operational friction (manual, slow, repeated work)
 * - Vendor lock-in risks
 * - Productivity loss
 * - Urgency indicators
 *
 * Output: Buying-pain score (0-100) + structured DM brief for outreach.
 */

export interface BuyingPainSignal {
  name: string;
  points: number;
  reason: string;
}

export interface BuyingPainScore {
  score: number;
  signals: BuyingPainSignal[];
  rationale: string;
  urgency: "high" | "medium" | "low";
}

/**
 * Analyze title + description for buying-pain signals and assign scores.
 *
 * Scoring dimensions:
 * - Cost/budget pain: 0-25 pts (expensive, overcharged, growing DevOps bills)
 * - Operational friction: 0-20 pts (manual, slow, repetitive, bottleneck)
 * - Vendor lock-in: 0-15 pts (proprietary, single point of failure)
 * - Productivity loss: 0-20 pts (lost time, context switching, unreliable)
 * - Urgency: 0-15 pts (critical, broken, urgent, overdue)
 * - Accessibility: 0-5 pts (founder/CTO voice, not generic)
 *
 * Final: 0-100, clamped.
 */
export function scoreRevenueLeadForBuyingPain(
  title: string,
  description: string,
  _url?: string,
): BuyingPainScore {
  const text = `${title} ${description}`.toLowerCase();
  const signals: BuyingPainSignal[] = [];
  let score = 0;

  // 1. Cost/Budget Pain (0-25)
  const costKeywords = [
    "expensive",
    "cost",
    "price",
    "overcharged",
    "license",
    "bill",
    "expensive",
    "scaling cost",
    "devops bill",
    "$",
  ];
  if (costKeywords.some((kw) => text.includes(kw))) {
    const costScore = 15;
    signals.push({
      name: "cost_pain",
      points: costScore,
      reason: "Cost/budget pain signals detected",
    });
    score += costScore;
  }

  if (text.match(/\$\d+[kK]/)) {
    const budgetScore = 10;
    signals.push({
      name: "large_budget_mentioned",
      points: budgetScore,
      reason: "$K+ spend mentioned",
    });
    score += budgetScore;
  }

  // 2. Operational Friction (0-20)
  const frictionKeywords = [
    "manual",
    "repetitive",
    "slow",
    "bottleneck",
    "inefficient",
    "overhead",
    "deployment",
    "takes hours",
    "takes days",
  ];
  if (frictionKeywords.some((kw) => text.includes(kw))) {
    const frictionScore = 12;
    signals.push({
      name: "operational_friction",
      points: frictionScore,
      reason: "Operational friction (manual, slow, repetitive work)",
    });
    score += frictionScore;
  }

  // 3. Vendor Lock-in (0-15)
  const lockinKeywords = [
    "lock-in",
    "vendor lock",
    "proprietary",
    "single point of failure",
    "trapped",
    "stuck with",
  ];
  if (lockinKeywords.some((kw) => text.includes(kw))) {
    const lockinScore = 15;
    signals.push({
      name: "vendor_lockin",
      points: lockinScore,
      reason: "Vendor lock-in or risk of platform dependency",
    });
    score += lockinScore;
  }

  // 4. Productivity Loss (0-20)
  const productivityKeywords = [
    "lost time",
    "delay",
    "context switch",
    "distraction",
    "unreliable",
    "downtime",
    "frustrat",
    "struggle",
  ];
  if (productivityKeywords.some((kw) => text.includes(kw))) {
    const productivityScore = 12;
    signals.push({
      name: "productivity_loss",
      points: productivityScore,
      reason: "Productivity loss or team friction",
    });
    score += productivityScore;
  }

  // Impact scope: "team", "company", "customers"
  const impactKeywords = ["team", "company", "customer", "org"];
  if (impactKeywords.some((kw) => text.includes(kw))) {
    const impactScore = 8;
    signals.push({
      name: "broad_impact",
      points: impactScore,
      reason: "Issue affects multiple people/teams",
    });
    score += impactScore;
  }

  // 5. Urgency (0-15)
  const urgencyKeywords = [
    "urgent",
    "critical",
    "broken",
    "down",
    "can't",
    "blocked",
    "halted",
    "stopped",
  ];
  if (urgencyKeywords.some((kw) => text.includes(kw))) {
    const urgencyScore = 15;
    signals.push({
      name: "urgent_signal",
      points: urgencyScore,
      reason: "Urgent/critical language present",
    });
    score += urgencyScore;
  }

  // 6. Accessibility (0-5) — founder/technical decision-maker voice
  // Heuristic: "we", "our", "my" in first-person (author is stakeholder, not generic issue)
  if (text.match(/\b(we|our|my|i|we're|we've|we'll)\b/)) {
    const accessScore = 5;
    signals.push({
      name: "stakeholder_voice",
      points: accessScore,
      reason: "First-person voice suggests decision-maker or key stakeholder",
    });
    score += accessScore;
  }

  // Clamp to 0-100
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));

  // Urgency classification
  let urgency: "high" | "medium" | "low" = "low";
  if (clampedScore >= 75 || urgencyKeywords.some((kw) => text.includes(kw))) {
    urgency = "high";
  } else if (clampedScore >= 50) {
    urgency = "medium";
  }

  const rationale = signals.map((s) => s.reason).join("; ");

  return {
    score: clampedScore,
    signals,
    rationale: rationale || "General interest signal",
    urgency,
  };
}

/**
 * Fetch and extract text from a public URL (GitHub issue, Twitter, blog, etc.)
 *
 * For MVP, use simple patterns without external API keys:
 * - GitHub: fetch raw issue/discussion body
 * - Twitter: fetch and extract text
 * - General: fetch and extract h1 + first 500 chars of article body
 *
 * Returns {title, description} or throws if fetch fails.
 */
export async function extractTextFromUrl(
  url: string,
): Promise<{ title: string; description: string }> {
  try {
    // Use global fetch (Node 18+) with AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; RevenueLeadScanner/1.0; +https://github.com/rapartlu/agent-orchestrator)",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // GitHub issue pattern: look for issue title and body
    if (url.includes("github.com")) {
      const titleMatch = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
      const bodyMatch = html.match(
        /<div class="comment-body"[^>]*>([\s\S]*?)<\/div>/,
      );

      if (titleMatch && bodyMatch) {
        const title = titleMatch[1].trim();
        const description = bodyMatch[1]
          .replace(/<[^>]*>/g, "")
          .trim()
          .substring(0, 1000);
        return { title, description };
      }
    }

    // Fallback: extract h1 or first heading + article text
    const headingMatch = html.match(/<h[1-2][^>]*>([^<]*)<\/h[1-2]>/);
    const title = headingMatch
      ? headingMatch[1].trim()
      : "Content from " + new URL(url).hostname;

    // Extract article/body text (rough)
    const bodyMatch = html.match(
      /<(?:article|main|div class="content")[^>]*>([\s\S]*?)<\/(?:article|main|div)>/,
    );
    const rawBody = bodyMatch ? bodyMatch[1] : html;
    const description = rawBody
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 1000);

    if (!description) {
      throw new Error("Could not extract content from URL");
    }

    return { title, description };
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch ${url}: ${msg}`);
  }
}

/**
 * Generate a DM brief for outreach to the lead.
 *
 * Format: Markdown with problem statement, proposed solution, price anchor, proof link.
 * Tone: Direct, concrete, not salesy.
 */
export function generateDmBrief(
  title: string,
  description: string,
  score: BuyingPainScore,
  treasuryAddress: string,
): string {
  const urgencyEmoji = score.urgency === "high" ? "🔴 " : "🟡 ";

  // Extract 1-2 sentence problem statement
  const firstSentence = description.split(/[.!?]+/)[0].trim();

  // Infer suggested solution based on signals
  const solutionAngle = score.signals
    .slice(0, 2)
    .map((s) => {
      if (s.name === "cost_pain") return "cost optimization";
      if (s.name === "operational_friction") return "automation";
      if (s.name === "vendor_lockin") return "portability";
      if (s.name === "productivity_loss") return "reliability";
      if (s.name === "urgent_signal") return "quick stabilization";
      return "optimization";
    })
    .join(" + ");

  // Price anchor (simple heuristic based on urgency + score)
  let priceAnchor = "$500";
  if (score.urgency === "high") {
    priceAnchor = score.score >= 80 ? "$5k" : "$2.5k";
  } else if (score.urgency === "medium") {
    priceAnchor = "$1.5k";
  }

  const brief = `${urgencyEmoji}Hey!

I noticed: ${firstSentence}

**The pain:** This sounds like it's costing you time and money. Even 10% improvement would be worth the fix.

**What we'd do:** We'd start with a 1-week audit, then deliver a concrete ${solutionAngle} plan with proof of concept.

**Price:** Starting at ${priceAnchor} for the full engagement (or hourly if you prefer to pilot first).

**Recent case:** We shipped a similar fix for a team at your scale — took 3 weeks, cut their overhead by 60%. Happy to share details.

---
Fleet Treasury: ${treasuryAddress}

DM me if this resonates. Happy to jump on a quick call.`;

  return brief;
}
