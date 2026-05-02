/**
 * Dispatch-time antibody injection (issue #1392).
 *
 * Queries the `signals` table and `learned_patterns` table for failure-prevention
 * hints relevant to the dispatch target (repo, labels, error history).  Matching
 * hints are formatted and appended to the dispatch message so the agent has
 * pre-tested remediation context before it starts work.
 *
 * This is the fleet's adaptive immune system: every past failure that produced a
 * signal or learned pattern can prevent the same class of failure from recurring.
 */

import { StateStore, type Signal, type LearnedPattern } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("dispatch-antibodies");

/** Feature flag: set ANTIBODY_ENRICHMENT=1 to enable dispatch-time injection. */
const ANTIBODY_ENRICHMENT_ENABLED =
  process.env.ANTIBODY_ENRICHMENT !== "0" &&
  process.env.ANTIBODY_ENRICHMENT !== "false";

/** Maximum number of antibody hints to inject per dispatch (to limit prompt bloat). */
const MAX_ANTIBODY_HINTS = 5;

/** Minimum confidence threshold for signal injection. */
const MIN_SIGNAL_CONFIDENCE = 0.3;

/** Signal types that are treated as dispatch-time antibodies. */
const ANTIBODY_SIGNAL_TYPES = [
  "failure_antibody",
  "failure_pattern",
  "connection_error_fix",
  "duplicate_dispatch_prevention",
];

export interface AntibodyInjectionResult {
  /** Whether any antibodies were injected. */
  injected: boolean;
  /** Number of antibody hints injected into the dispatch message. */
  count: number;
  /** IDs of injected signals (for fitness tracking). */
  signalIds: number[];
  /** IDs of injected learned patterns. */
  patternIds: number[];
  /** The enriched message (or original if nothing was injected). */
  message: string;
}

/**
 * Query and inject relevant antibody hints into a dispatch message.
 *
 * This is the core dispatch-time immune function.  It:
 * 1. Queries `signals` for active antibody-type signals matching the target repo
 * 2. Queries `learned_patterns` for relevant patterns
 * 3. Formats matching hints and appends them to the dispatch message
 * 4. Records signal reads for consumption tracking
 *
 * When the feature flag is off or no signals match, returns the original message unchanged.
 */
export function injectDispatchAntibodies(
  store: StateStore,
  message: string,
  context: {
    repo: string;
    agentName: string;
    issueNumber: number;
    labels?: string[];
    sourceRef: string;
  },
): AntibodyInjectionResult {
  if (!ANTIBODY_ENRICHMENT_ENABLED) {
    return { injected: false, count: 0, signalIds: [], patternIds: [], message };
  }

  const hints: Array<{ source: "signal" | "pattern"; text: string; confidence: number; id: number }> = [];

  // 1. Query signals table for antibody-type signals
  try {
    for (const signalType of ANTIBODY_SIGNAL_TYPES) {
      const signals = store.readSignals({
        signal_type: signalType,
        repo: context.repo,
        reader_agent: context.agentName,
        reader_context: `dispatch:${context.sourceRef}`,
        limit: MAX_ANTIBODY_HINTS,
      });

      for (const signal of signals) {
        if (signal.confidence < MIN_SIGNAL_CONFIDENCE) continue;
        const hint = formatSignalHint(signal);
        if (hint) {
          hints.push({ source: "signal", text: hint, confidence: signal.confidence, id: signal.id });
        }
      }
    }
  } catch (err) {
    // Non-blocking: signal query failures must not prevent dispatch
    log.warn("Failed to query antibody signals", {
      repo: context.repo,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Query learned_patterns for relevant patterns
  try {
    const patterns = store.getLearnedPatterns(context.repo, MAX_ANTIBODY_HINTS);
    for (const pattern of patterns) {
      if (pattern.confidence < MIN_SIGNAL_CONFIDENCE) continue;
      // Only inject workflow and bug patterns at dispatch time
      // (architecture/security patterns are more relevant at review time)
      if (pattern.pattern_type !== "workflow" && pattern.pattern_type !== "bug") continue;
      const hint = formatPatternHint(pattern);
      if (hint) {
        hints.push({ source: "pattern", text: hint, confidence: pattern.confidence, id: pattern.id });
      }
    }
  } catch (err) {
    log.warn("Failed to query learned patterns", {
      repo: context.repo,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (hints.length === 0) {
    return { injected: false, count: 0, signalIds: [], patternIds: [], message };
  }

  // Sort by confidence descending, take top N
  hints.sort((a, b) => b.confidence - a.confidence);
  const topHints = hints.slice(0, MAX_ANTIBODY_HINTS);

  // Format the antibody block
  const antibodyBlock = formatAntibodyBlock(topHints.map((h) => h.text));

  const signalIds = topHints.filter((h) => h.source === "signal").map((h) => h.id);
  const patternIds = topHints.filter((h) => h.source === "pattern").map((h) => h.id);

  log.info("Injected dispatch antibodies", {
    sourceRef: context.sourceRef,
    agentName: context.agentName,
    repo: context.repo,
    signalCount: signalIds.length,
    patternCount: patternIds.length,
    totalHints: topHints.length,
  });

  return {
    injected: true,
    count: topHints.length,
    signalIds,
    patternIds,
    message: message + antibodyBlock,
  };
}

/** Format a signal into a dispatch hint string. */
function formatSignalHint(signal: Signal): string | null {
  let payload: Record<string, unknown> | null = null;
  if (signal.value) {
    try {
      payload = JSON.parse(signal.value) as Record<string, unknown>;
    } catch {
      // value is a plain string
      return `- ${signal.key}: ${signal.value}`;
    }
  }

  const fixHint = payload?.fix_hint ?? payload?.hint ?? payload?.description;
  if (fixHint && typeof fixHint === "string") {
    return `- **${signal.key}**: ${fixHint}`;
  }

  return signal.value ? `- ${signal.key}: ${signal.value}` : null;
}

/** Format a learned pattern into a dispatch hint string. */
function formatPatternHint(pattern: LearnedPattern): string | null {
  if (!pattern.description) return null;
  // Truncate long descriptions to keep the prompt lean
  const desc =
    pattern.description.length > 200
      ? pattern.description.slice(0, 197) + "..."
      : pattern.description;
  return `- **${pattern.title}**: ${desc}`;
}

/** Format the full antibody injection block appended to the dispatch message. */
function formatAntibodyBlock(hints: string[]): string {
  return (
    "\n\n---\n" +
    "⚠️ **Fleet Antibodies** — Known failure patterns for this repo (auto-injected):\n" +
    "The following issues have caused failures in past dispatches. Be aware of them and apply the suggested fixes:\n\n" +
    hints.join("\n") +
    "\n"
  );
}
