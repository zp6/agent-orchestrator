/**
 * Coverage gap detector — analyses routing data to find topics with no
 * owning agent, routing mismatches, and scope overload signals.
 *
 * Used to propose when new agents should be created. Runs periodically
 * (~4h) and on-demand via `orch agents gaps`.
 */
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("coverage-gap");

export interface CoverageGap {
  type: "unowned_topic" | "routing_mismatch" | "low_confidence" | "scope_overload";
  topic: string;
  frequency: number;
  affectedAgent?: string;
  details: string;
}

export interface AgentProposal {
  suggestedName: string;
  description: string;
  capabilities: string[];
  owns_topics: string[];
  reason: string;
  gaps: CoverageGap[];
}

/**
 * Detect coverage gaps by analysing recent task routing data.
 */
export function detectCoverageGaps(
  config: OrchestratorConfig,
  store: StateStore,
  windowDays = 14,
): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  gaps.push(...detectUnownedTopics(config, store, windowDays));
  gaps.push(...detectScopeOverload(config, store, windowDays));
  gaps.push(...detectLowConfidenceRouting(store, windowDays));

  log.info("Coverage gap detection complete", {
    total: gaps.length,
    byType: {
      unowned: gaps.filter((g) => g.type === "unowned_topic").length,
      overload: gaps.filter((g) => g.type === "scope_overload").length,
      lowConfidence: gaps.filter((g) => g.type === "low_confidence").length,
    },
  });

  return gaps;
}

/**
 * Suggest a new agent based on detected coverage gaps.
 * Returns null if gaps don't cluster enough to warrant a new agent.
 */
export function suggestNewAgent(
  gaps: CoverageGap[],
  config: OrchestratorConfig,
): AgentProposal | null {
  // Only consider unowned_topic gaps for agent proposals — scope_overload
  // gaps use agent names as topics which aren't valid for new agent creation.
  const candidateGaps = gaps.filter((g) => g.type === "unowned_topic");
  if (candidateGaps.length < 3) return null;

  // Find the most common topic across candidate gaps
  const topicCounts = new Map<string, number>();
  for (const gap of candidateGaps) {
    const count = topicCounts.get(gap.topic) ?? 0;
    topicCounts.set(gap.topic, count + gap.frequency);
  }

  const sortedTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedTopics.length === 0) return null;

  const primaryTopic = sortedTopics[0][0];
  const relatedGaps = candidateGaps.filter((g) => g.topic === primaryTopic);
  const totalFrequency = relatedGaps.reduce((sum, g) => sum + g.frequency, 0);

  // Need significant frequency to justify a new agent — must be a genuinely
  // recurring theme, not just a common word that slipped through the stoplist.
  if (totalFrequency < 30) return null;

  // Check no existing agent already owns this topic
  for (const agent of Object.values(config.agents)) {
    if (agent.owns_topics?.includes(primaryTopic)) return null;
  }

  const suggestedName = `claude-${primaryTopic.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-agent`;
  const relatedTopics = sortedTopics.slice(0, 5).map(([t]) => t);

  return {
    suggestedName,
    description: `Agent specialising in ${primaryTopic} — detected from ${totalFrequency} tasks with no owner`,
    capabilities: relatedTopics,
    owns_topics: relatedTopics,
    reason: `Topic "${primaryTopic}" appeared in ${totalFrequency} tasks over the analysis window with no owning agent. ${relatedGaps.length} coverage gap(s) detected.`,
    gaps: relatedGaps,
  };
}

// ── Gap detection strategies ────────────────────────────────────────────────

/**
 * Find topic keywords in recent tasks that no agent's owns_topics covers.
 */
function detectUnownedTopics(
  config: OrchestratorConfig,
  store: StateStore,
  windowDays: number,
): CoverageGap[] {
  // Build set of all owned topics
  const ownedTopics = new Set<string>();
  for (const agent of Object.values(config.agents)) {
    for (const topic of agent.owns_topics ?? []) {
      ownedTopics.add(topic.toLowerCase());
    }
    for (const cap of agent.capabilities ?? []) {
      ownedTopics.add(cap.toLowerCase());
    }
  }

  // Analyse recent task titles and descriptions for topic keywords
  const tasks = store.listTasks({ limit: 200 });
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const recentTasks = tasks.filter((t) => t.created_at >= cutoff);

  const topicCounts = new Map<string, number>();
  const commonWords = new Set([
    // English stopwords
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "about", "after",
    "before", "between", "through", "during", "without", "within",
    "and", "but", "or", "not", "no", "so", "if", "then", "than",
    "that", "this", "these", "those", "it", "its", "all", "each",
    "every", "both", "few", "more", "most", "other", "some", "such",
    "also", "just", "only", "already", "still", "when", "where", "which",
    "what", "how", "your", "they", "their", "there", "here", "very",
    "well", "been", "being", "over", "under", "any", "same", "need",
    // Dev action words
    "new", "old", "add", "fix", "update", "remove", "change", "make",
    "get", "set", "use", "run", "test", "check", "create", "delete",
    "ensure", "implement", "move", "show", "handle", "track", "send",
    "pass", "call", "return", "start", "stop", "skip", "allow", "block",
    "apply", "load", "save", "read", "write", "parse", "build", "match",
    // Orchestrator domain words (appear in nearly every task)
    "agent", "orchestrator", "task", "issue", "review", "deploy",
    "repo", "github", "branch", "merge", "commit", "push", "pull",
    "dispatch", "dispatcher", "daemon", "cycle", "store", "state",
    "config", "proxy", "docker", "container", "session",
    "reviewer", "verifier", "supervisor", "dashboard",
    "coordinated", "coordination", "closes", "issues", "open",
    "rapartlu", "claude", "claude-agent", "claude-orchestrator",
    "failed", "error", "timeout", "retry", "status", "result",
    "table", "column", "query", "schema", "migration",
    "file", "path", "function", "method", "class", "type", "interface",
    "true", "false", "null", "undefined", "string", "number",
    "http", "port", "endpoint", "route", "request", "response",
    // More domain words from task descriptions
    "title", "body", "description", "content", "text", "message", "label",
    "follow", "cross", "score", "quality", "auto", "automatically",
    "feedback", "pattern", "learned", "active", "pending", "done",
    "tasks", "items", "action", "item", "list", "count", "total",
    "data", "value", "field", "record", "entry", "node", "line",
    "source", "target", "owner", "pool", "model", "prompt", "token",
    "cycle", "batch", "queue", "rate", "limit", "threshold",
    "based", "specific", "current", "recent", "existing", "missing",
    "support", "added", "updated", "ensure", "properly", "correctly",
    "when", "after", "before", "instead", "between", "across",
    "first", "last", "next", "only", "already", "still",
    "using", "used", "like", "include", "including", "required",
    "does", "doesn", "didn", "isn", "aren", "wasn", "shouldn",
    "refs", "stash", "origin", "main", "head", "diff", "patch",
    "labels", "comment", "comments", "close", "closed", "merged",
    // Structural words from task/coordination descriptions
    "implementation", "changes", "housekeeping", "order", "identified",
    "affected", "created", "severity", "part", "https", "sibling",
    "parent", "child", "linked", "related", "original", "expected",
    "revision", "triage", "periodic", "backlog", "bootstrap",
    "detected", "proposed", "suggested", "recommended", "resolved",
    "verify", "validate", "confirm", "complete", "completed",
    // Pervasive fleet/charter vocabulary that leaks into every task
    // and should never trigger a new-agent proposal on its own.
    "fleet", "failure", "phase", "prose",
  ]);

  for (const task of recentTasks) {
    const text = `${task.title} ${task.description ?? ""}`.toLowerCase();
    const words = text.match(/\b[a-z]{4,}\b/g) ?? [];

    for (const word of words) {
      if (commonWords.has(word)) continue;
      if (ownedTopics.has(word)) continue;
      topicCounts.set(word, (topicCounts.get(word) ?? 0) + 1);
    }
  }

  // Flag topics appearing 20+ times with no owner (high threshold to filter noise
  // in a fleet doing 500+ tasks/day — low-frequency words aren't real gaps)
  const gaps: CoverageGap[] = [];
  for (const [topic, count] of topicCounts) {
    if (count >= 20) {
      gaps.push({
        type: "unowned_topic",
        topic,
        frequency: count,
        details: `"${topic}" appeared in ${count} task(s) but no agent owns this topic`,
      });
    }
  }

  // Sort by frequency and cap
  gaps.sort((a, b) => b.frequency - a.frequency);
  return gaps.slice(0, 10);
}

/**
 * Detect agents whose quality is declining while volume increases.
 */
function detectScopeOverload(
  config: OrchestratorConfig,
  store: StateStore,
  windowDays: number,
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const recentStats = store.getAgentStats(windowDays * 24);
  const priorStats = store.getAgentStats(windowDays * 48);

  for (const recent of recentStats) {
    const prior = priorStats.find((p) => p.agent_name === recent.agent_name);
    if (!prior || prior.total < 5 || recent.total < 5) continue;

    const recentRate = recent.done / recent.total;
    const priorRate = prior.done / prior.total;
    const volumeIncrease = recent.total / prior.total;

    // Flag if quality dropped >15% while volume increased >30%
    if (priorRate - recentRate > 0.15 && volumeIncrease > 1.3) {
      gaps.push({
        type: "scope_overload",
        topic: recent.agent_name,
        frequency: recent.total,
        affectedAgent: recent.agent_name,
        details: `Quality dropped ${Math.round((priorRate - recentRate) * 100)}% (${Math.round(priorRate * 100)}% → ${Math.round(recentRate * 100)}%) while volume increased ${Math.round((volumeIncrease - 1) * 100)}%`,
      });
    }
  }

  return gaps;
}

/**
 * Detect tasks where routing confidence was very low (< 0.3).
 * These indicate the router doesn't know where to send the work.
 */
function detectLowConfidenceRouting(
  store: StateStore,
  _windowDays: number,
): CoverageGap[] {
  // Low-confidence routing detection requires direct DB access or a store method.
  // For now, skip this detector — the unowned topics and scope overload detectors
  // cover the main gap detection use cases. A store.getLowConfidenceRoutings()
  // method can be added later.
  return [];
}

/**
 * Format coverage gaps for display.
 */
export function formatGapsForDisplay(gaps: CoverageGap[]): string {
  if (gaps.length === 0) return "No coverage gaps detected.";

  const lines: string[] = [`${gaps.length} coverage gap(s) detected:\n`];

  for (const gap of gaps) {
    const icon = gap.type === "unowned_topic" ? "🔍" :
      gap.type === "scope_overload" ? "⚠️" :
        gap.type === "low_confidence" ? "🎯" : "📊";
    lines.push(`  ${icon} [${gap.type}] ${gap.topic} (×${gap.frequency})`);
    lines.push(`    ${gap.details}`);
  }

  return lines.join("\n");
}
