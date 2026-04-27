/**
 * Smart model routing — select the cheapest model tier that can handle a task.
 *
 * Complexity is scored 0–1 based on heuristics (no LLM call needed).
 * The score maps to a model tier, and the tier maps to a concrete model
 * per provider. If verification fails, the task can be re-dispatched at
 * the next tier up (natural escalation).
 */
import { createLogger } from "../service/logger.js";

const log = createLogger("model-router");

export type ModelTier = "light" | "standard" | "heavy";

/** Model names per provider per tier. */
const MODEL_MAP: Record<string, Record<ModelTier, string>> = {
  claude: {
    light: "claude-haiku-4-5",
    standard: "claude-sonnet-4-6",
    heavy: "claude-opus-4-6",
  },
  openai: {
    light: "gpt-5.4-mini",
    standard: "gpt-5.4-mini",
    heavy: "gpt-5.4",
  },
  grok: {
    light: "grok-3-mini",
    standard: "grok-3",
    heavy: "grok-4",
  },
  deepseek: {
    light: "deepseek-chat",
    standard: "deepseek-chat",
    heavy: "deepseek-reasoner",
  },
  gemini: {
    light: "gemini-2.0-flash",
    standard: "gemini-2.5-flash-preview-04-17",
    heavy: "gemini-2.5-pro",
  },
};

/** Complexity thresholds for tier selection. */
const TIER_THRESHOLDS = {
  light: 0.3,    // score < 0.3 → light
  standard: 0.7, // score < 0.7 → standard
  // score >= 0.7 → heavy
};

/**
 * Score task complexity on a 0–1 scale using fast heuristics.
 * No LLM call — purely based on task metadata.
 */
export function scoreComplexity(message: string, options?: {
  taskType?: string;
  isRevision?: boolean;
  sourceRef?: string;
}): number {
  let score = 0.4; // baseline: standard

  const msgLen = message.length;
  const taskType = options?.taskType ?? "implementation";

  // ── Message length (proxy for scope) ──────────────────────────
  if (msgLen < 500) score -= 0.15;        // short issue = simple
  else if (msgLen > 3000) score += 0.15;  // long issue = complex
  else if (msgLen > 5000) score += 0.25;

  // ── Task type ─────────────────────────────────────────────────
  if (taskType === "research") score -= 0.2;  // research = read-heavy, not code-heavy

  // ── Revisions are simpler (context already exists) ────────────
  if (options?.isRevision) score -= 0.15;

  // ── PR feedback is typically small fixes ───────────────────────
  if (message.includes("[PR feedback]") || message.includes("pr-feedback")) {
    score -= 0.2;
  }

  // ── Keywords suggesting complexity ────────────────────────────
  const complexPatterns = [
    /refactor/i, /architect/i, /redesign/i, /migration/i,
    /breaking change/i, /cross.?repo/i, /multi.?file/i,
    /performance/i, /security/i, /race condition/i,
  ];
  const simplePatterns = [
    /typo/i, /rename/i, /config/i, /update.*version/i,
    /fix.*test/i, /add.*comment/i, /lint/i, /format/i,
    /bump/i, /changelog/i, /readme/i, /documentation/i,
  ];

  const complexHits = complexPatterns.filter((p) => p.test(message)).length;
  const simpleHits = simplePatterns.filter((p) => p.test(message)).length;
  score += Math.min(complexHits * 0.08, 0.25); // cap at +0.25
  score -= Math.min(simpleHits * 0.08, 0.2);   // cap at -0.2

  // ── Multiple file references suggest larger scope ─────────────
  const fileRefs = message.match(/\b\w+\.(ts|js|tsx|jsx|py|go|rs)\b/g);
  if (fileRefs && fileRefs.length > 5) score += 0.1;

  return Math.max(0, Math.min(1, score));
}

/**
 * Map a complexity score to a model tier.
 */
export function selectTier(score: number): ModelTier {
  if (score < TIER_THRESHOLDS.light) return "light";
  if (score < TIER_THRESHOLDS.standard) return "standard";
  return "heavy";
}

/**
 * Get the next tier up (for re-dispatch after verification failure).
 */
export function escalateTier(current: ModelTier): ModelTier | null {
  if (current === "light") return "standard";
  if (current === "standard") return "heavy";
  return null; // already at max
}

/**
 * Resolve a concrete model name for a provider and tier.
 */
export function resolveModel(provider: string, tier: ModelTier): string {
  return MODEL_MAP[provider]?.[tier] ?? MODEL_MAP.claude[tier];
}

/**
 * Full routing decision: score complexity → pick tier → resolve model.
 * Returns the model to use and metadata for logging.
 */
export function routeModel(
  provider: string,
  message: string,
  options?: {
    taskType?: string;
    isRevision?: boolean;
    sourceRef?: string;
  },
): { model: string; tier: ModelTier; complexity: number } {
  const complexity = scoreComplexity(message, options);
  const tier = selectTier(complexity);
  const model = resolveModel(provider, tier);

  log.info("Model routing decision", {
    provider,
    tier,
    complexity: complexity.toFixed(2),
    model,
    taskType: options?.taskType,
    isRevision: options?.isRevision,
  });

  return { model, tier, complexity };
}
