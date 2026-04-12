/**
 * Cross-task learning: extract actionable rules from PR review feedback
 * and inject per-repo conventions into future dispatches.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LearnedRule, LearnedRuleCategory, StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLogger } from "../service/logger.js";

const execFileAsync = promisify(execFile);

const log = createLogger("learned-rules");

/** Categories and their keyword signals for classification. */
const CATEGORY_SIGNALS: Record<LearnedRuleCategory, RegExp[]> = {
  style: [/naming|format|indent|camelCase|snake_case|lint|spacing|whitespace|import order/i],
  architecture: [/structure|module|separate|decouple|layer|pattern|abstraction|dependency|interface/i],
  testing: [/test|spec|coverage|assert|mock|fixture|unit test|integration/i],
  security: [/secret|credential|env|token|auth|sanitize|escape|inject|xss|csrf/i],
  convention: [/convention|always|never|must|should|rule|require|migration|commit message/i],
  workflow: [/branch|PR|commit|rebase|merge|deploy|CI|pipeline|hook/i],
};

/**
 * Classify a rule into a category based on keyword signals.
 */
function classifyRule(ruleText: string): LearnedRuleCategory {
  for (const [category, patterns] of Object.entries(CATEGORY_SIGNALS) as [LearnedRuleCategory, RegExp[]][]) {
    for (const pattern of patterns) {
      if (pattern.test(ruleText)) return category;
    }
  }
  return "convention";
}

/**
 * Lightweight extraction: split review feedback into actionable rule candidates.
 * Looks for imperative statements, "should"/"must"/"always"/"never" patterns,
 * and bullet points that describe conventions.
 */
export function extractRulesFromFeedback(feedbackText: string): string[] {
  if (!feedbackText || feedbackText.length < 20) return [];

  const rules: string[] = [];
  const lines = feedbackText.split("\n");

  // Pattern: imperative/prescriptive statements
  const actionablePattern = /\b(always|never|must|should|ensure|make sure|remember to|don't forget|avoid|prefer|use|add|include|require)\b/i;

  for (const line of lines) {
    const trimmed = line.replace(/^[\s*\->#]+/, "").trim();
    if (trimmed.length < 15 || trimmed.length > 300) continue;

    // Skip purely descriptive/question lines
    if (/^(why|what|where|when|how|is |are |was |does |did |can |could )/i.test(trimmed)) continue;
    // Skip code blocks
    if (/^```|^`[^`]+`$/.test(trimmed)) continue;

    if (actionablePattern.test(trimmed)) {
      // Clean up to make it a standalone rule
      let rule = trimmed;
      // Remove leading "You should" / "Please" etc.
      rule = rule.replace(/^(you\s+)?(should|need to|please|must)\s+/i, "");
      // Capitalize first letter
      rule = rule.charAt(0).toUpperCase() + rule.slice(1);
      // Remove trailing period if present, then re-add for consistency
      rule = rule.replace(/\.+$/, "");

      if (rule.length >= 15 && !rules.includes(rule)) {
        rules.push(rule);
      }
    }
  }

  // Cap at 5 rules per feedback to avoid noise
  return rules.slice(0, 5);
}

/**
 * Build the "Repo Conventions" block to inject into a dispatch message.
 * Returns empty string if no rules apply.
 */
export function buildLearnedRulesBlock(rules: LearnedRule[]): string {
  if (rules.length === 0) return "";

  const items = rules.map(
    (r) => `- ${r.rule} _(confidence: ${Math.round(r.confidence * 100)}%, from ${r.source})_`,
  );

  return (
    `\n\n## Repo Conventions (learned from prior PR reviews)\n` +
    `Follow these conventions when working on this repo:\n` +
    items.join("\n") +
    `\n`
  );
}

/**
 * Extract rules from review feedback and store them as learned rules.
 * Called after PR review or verification feedback is received.
 */
export function extractAndStoreRules(
  store: StateStore,
  repo: string,
  feedbackText: string,
  source: string,
  sourceTaskId?: string,
): LearnedRule[] {
  const ruleTexts = extractRulesFromFeedback(feedbackText);
  const stored: LearnedRule[] = [];

  for (const ruleText of ruleTexts) {
    const category = classifyRule(ruleText);
    const rule = store.addLearnedRule({
      repo,
      rule: ruleText,
      category,
      source,
      source_task_id: sourceTaskId,
      confidence: 0.8,
    });
    stored.push(rule);
  }

  return stored;
}

/**
 * Get rules for a repo and mark them as applied. Returns the block to inject.
 */
export function getAndApplyRules(
  store: StateStore,
  repo: string,
  limit = 10,
): { block: string; ruleIds: number[] } {
  const rules = store.getLearnedRulesForRepo(repo, limit);
  if (rules.length === 0) return { block: "", ruleIds: [] };

  const ruleIds = rules.map((r) => r.id);
  for (const id of ruleIds) {
    store.markRuleApplied(id);
  }

  return { block: buildLearnedRulesBlock(rules), ruleIds };
}

/**
 * Fetch CLAUDE.md from a GitHub repo and return its content.
 * Returns null if the file doesn't exist or can't be fetched.
 *
 * Uses execFileAsync (no shell) to prevent shell injection — `repo` is passed
 * as a discrete argument, never interpolated into a shell string.
 */
async function fetchClaudeMd(repo: string): Promise<string | null> {
  try {
    // Fetch the base64-encoded content via gh API (no shell — safe against injection).
    // `repo` is passed as a discrete argument, never interpolated into a shell string.
    const { stdout: b64 } = await execFileAsync(
      "gh",
      ["api", `repos/${repo}/contents/CLAUDE.md`, "--jq", ".content"],
      { encoding: "utf-8", timeout: 15000 },
    );
    const trimmed = b64.trim();
    if (!trimmed) return null;

    // Decode base64 in-process — no additional subprocess or shell involvement.
    const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
    return decoded.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Seed the learned rules database from CLAUDE.md files across all repos.
 * Parses convention-like statements and stores them as high-confidence rules.
 *
 * Only adds rules that don't already exist (deduplicates by rule text + repo).
 * Safe to call multiple times — idempotent.
 */
export async function seedFromClaudeMd(
  config: OrchestratorConfig,
  store: StateStore,
): Promise<{ seeded: number; repos: string[] }> {
  const repos = new Set<string>();
  for (const agent of Object.values(config.agents)) {
    if (agent.github) repos.add(agent.github);
  }

  let totalSeeded = 0;
  const seededRepos: string[] = [];

  for (const repo of repos) {
    const content = await fetchClaudeMd(repo);
    if (!content) {
      log.info("No CLAUDE.md found", { repo });
      continue;
    }

    const existingRules = store.getLearnedRulesForRepo(repo, 100);
    const existingTexts = new Set(existingRules.map((r) => r.rule.toLowerCase()));

    const ruleTexts = extractRulesFromFeedback(content);
    let repoSeeded = 0;

    for (const ruleText of ruleTexts) {
      // Skip if already exists
      if (existingTexts.has(ruleText.toLowerCase())) continue;

      const category = classifyRule(ruleText);
      store.addLearnedRule({
        repo,
        rule: ruleText,
        category,
        source: "CLAUDE.md",
        confidence: 0.95, // high confidence — operator-authored
      });
      repoSeeded++;
    }

    if (repoSeeded > 0) {
      totalSeeded += repoSeeded;
      seededRepos.push(repo);
      log.info("Seeded rules from CLAUDE.md", { repo, count: repoSeeded });
    }
  }

  return { seeded: totalSeeded, repos: seededRepos };
}
