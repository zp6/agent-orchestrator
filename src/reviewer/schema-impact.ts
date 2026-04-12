/**
 * Schema-consumer impact detection for PR reviews.
 *
 * When a PR touches shared schema files (state.db table definitions, API
 * response shapes, TypeScript interfaces used across repos, enum values),
 * the reviewer injects a consumer-impact notice into the LLM review prompt.
 *
 * This catches the class of bug where a schema change ships without updating
 * downstream consumers — e.g. a new `dispatched` status in state.db breaking
 * the dashboard's test layer because only the orchestrator was updated.
 *
 * Design:
 *   1. `SCHEMA_CONSUMER_MAP` — a static map from file-path patterns to the
 *      list of repos that consume that schema. Kept in code (not config) so
 *      it can be reviewed and versioned alongside the detection logic.
 *   2. `detectSchemaChanges(diff, changedFiles)` — pure function that
 *      identifies which schema patterns are touched in a diff and returns
 *      the affected consumer repos.
 *   3. `buildSchemaImpactNotice(hits)` — formats the consumer list into a
 *      prompt section that the LLM can act on.
 *
 * Rules for the LLM (injected into the review prompt):
 *   - Schema changes without consumer updates are a **flagged risk**, not a
 *     hard block. The LLM includes a callout in its review comment but still
 *     approves if the code is otherwise correct.
 *   - If the PR description explicitly mentions updating consumers, or the
 *     diff includes consumer-side changes, the notice is suppressed.
 */

// ── Schema consumer map ───────────────────────────────────────────────────────

/**
 * A single entry in the schema-consumer map.
 *
 * `filePattern`  — glob-style path fragment; matches if a changed file's path
 *                  includes this string (case-insensitive).
 * `schemaLabel`  — human-readable name shown in the review comment.
 * `consumers`    — repos (owner/repo) that read or depend on this schema.
 * `indicators`   — optional diff-content patterns that confirm this is a
 *                  schema-level change (e.g. "CREATE TABLE", "ALTER TABLE").
 *                  When present, at least one must match the diff text.
 *                  When absent, any change to matching files triggers detection.
 */
export interface SchemaConsumerEntry {
  filePattern: string;
  schemaLabel: string;
  consumers: string[];
  indicators?: string[];
}

/**
 * The canonical schema-consumer map for the orchestrator fleet.
 *
 * Add entries here when a new shared schema is introduced. Each entry maps a
 * file path pattern to the repos that must stay in sync with it.
 */
export const SCHEMA_CONSUMER_MAP: SchemaConsumerEntry[] = [
  // ── state.db (SQLite schema shared by all agents via the orchestrator) ───
  {
    filePattern: "state/store",
    schemaLabel: "state.db schema (SQLite tables / columns)",
    consumers: [
      "rapartlu/agent-orchestrator",
      "rapartlu/agent-dashboard",
      "rapartlu/agent-reviewer",
    ],
    indicators: [
      "CREATE TABLE",
      "ALTER TABLE",
      "DROP TABLE",
      "CREATE INDEX",
      "DROP INDEX",
      "INTEGER PRIMARY KEY",
      "TEXT NOT NULL",
      "UNIQUE(",
    ],
  },
  {
    filePattern: "state/types",
    schemaLabel: "state.db TypeScript types (IStateStore / task/PR shapes)",
    consumers: [
      "rapartlu/agent-orchestrator",
      "rapartlu/agent-dashboard",
      "rapartlu/agent-reviewer",
    ],
  },
  // ── Proxy HTTP API (consumed by orchestrator and dashboard) ──────────────
  {
    filePattern: "routes/",
    schemaLabel: "proxy HTTP API route shapes",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
    indicators: ["res.json(", "interface ", "type ", ": Response", ": Request"],
  },
  {
    filePattern: "openapi.yaml",
    schemaLabel: "proxy OpenAPI spec",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
  },
  // ── Reviewer package public API (consumed by orchestrator) ───────────────
  {
    filePattern: "src/index",
    schemaLabel: "reviewer package public API (exports)",
    consumers: ["rapartlu/agent-orchestrator"],
    indicators: ["export ", "export {", "export type", "export interface"],
  },
  // ── Task / verification result shapes ────────────────────────────────────
  {
    filePattern: "verifier",
    schemaLabel: "task verification result shape (VerificationResult)",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
    indicators: [
      "VerificationResult",
      "quality_score",
      "quality_explanation",
      "interface Verification",
    ],
  },
  // ── Supervisor decision shape ─────────────────────────────────────────────
  {
    filePattern: "supervisor",
    schemaLabel: "supervisor decision shape (SupervisorDecision)",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
    indicators: [
      "SupervisorDecision",
      "interface Supervisor",
      "decision:",
      "action:",
      "agentName:",
    ],
  },
  // ── Agents config (agents.yaml) ──────────────────────────────────────────
  {
    filePattern: "agents.yaml",
    schemaLabel: "agents.yaml fleet config (agent names, ports, repos)",
    consumers: [
      "rapartlu/agent-orchestrator",
      "rapartlu/agent-dashboard",
      "rapartlu/agent-proxy",
    ],
  },
  // ── Dashboard API endpoints ───────────────────────────────────────────────
  {
    filePattern: "src/api",
    schemaLabel: "dashboard API endpoint shapes",
    consumers: ["rapartlu/agent-orchestrator"],
    indicators: ["res.json(", "interface ", "type ", ": Response"],
  },
];

// ── Detection logic ───────────────────────────────────────────────────────────

/**
 * A detected schema impact: which schema was touched and which repos consume it.
 */
export interface SchemaImpactHit {
  schemaLabel: string;
  consumers: string[];
  /** File path(s) in the PR that triggered this hit. */
  matchedFiles: string[];
}

/**
 * Detects schema-level changes in a PR diff and returns the list of affected
 * consumer repos.
 *
 * @param diff          Full diff text from `gh pr diff`
 * @param changedFiles  List of file paths changed in the PR (from PR metadata)
 * @returns             Array of schema impact hits (empty if no schema changes detected)
 */
export function detectSchemaChanges(diff: string, changedFiles: string[]): SchemaImpactHit[] {
  const hits: SchemaImpactHit[] = [];
  const diffUpper = diff.toUpperCase();

  for (const entry of SCHEMA_CONSUMER_MAP) {
    const patternLower = entry.filePattern.toLowerCase();

    // Find which changed files match this entry's path pattern
    const matchedFiles = changedFiles.filter((f) => f.toLowerCase().includes(patternLower));
    if (matchedFiles.length === 0) continue;

    // If the entry has content indicators, at least one must appear in the diff
    if (entry.indicators && entry.indicators.length > 0) {
      const hasIndicator = entry.indicators.some((ind) => diffUpper.includes(ind.toUpperCase()));
      if (!hasIndicator) continue;
    }

    hits.push({
      schemaLabel: entry.schemaLabel,
      consumers: entry.consumers,
      matchedFiles,
    });
  }

  return hits;
}

/**
 * Extracts the list of changed file paths from a unified diff.
 *
 * Parses `diff --git a/<path> b/<path>` header lines.
 * Falls back to `+++ b/<path>` lines if git diff headers are absent.
 */
export function extractChangedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();

  // Primary: git diff headers
  for (const match of diff.matchAll(/^diff --git a\/(.+) b\/.+$/gm)) {
    files.add(match[1]);
  }

  // Fallback: +++ b/<path> lines (patch format without git headers)
  if (files.size === 0) {
    for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
      const path = match[1];
      if (path !== "/dev/null") files.add(path);
    }
  }

  return [...files];
}

/**
 * Formats the schema impact hits into a prompt section that the LLM reviewer
 * can act on. Returns an empty string if there are no hits.
 *
 * The section is deliberately non-blocking: it asks the LLM to flag the risk
 * in its comment rather than auto-requesting changes, consistent with the
 * "default to approve" policy.
 */
export function buildSchemaImpactNotice(hits: SchemaImpactHit[]): string {
  if (hits.length === 0) return "";

  const lines: string[] = [
    "",
    "### ⚠️ Schema-Consumer Impact Warning",
    "",
    "This PR modifies shared schema(s) consumed by multiple repos/agents.",
    "Check whether each consumer repo has a corresponding update or is already compatible.",
    "If no consumer updates exist and the change is breaking, note this in your review comment.",
    "(This is a **flagged risk**, not an auto-block — approve if the change is otherwise correct.)",
    "",
  ];

  for (const hit of hits) {
    lines.push(`**Schema:** ${hit.schemaLabel}`);
    lines.push(`**Changed files:** ${hit.matchedFiles.join(", ")}`);
    lines.push(`**Consumers to check:** ${hit.consumers.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Builds a collapsible "Downstream Impact" section for posting in PR review comments.
 * Returns an empty string if there are no hits.
 *
 * The section lists affected consumer repos and the schema changes that touch them,
 * formatted as a GitHub details/summary collapsible element with links to each consumer.
 */
export function buildDownstreamImpactSection(hits: SchemaImpactHit[]): string {
  if (hits.length === 0) return "";

  const lines: string[] = [
    "",
    "<details>",
    "<summary><b>📦 Downstream Impact</b></summary>",
    "",
    "This PR modifies shared schema(s) with known downstream consumers:",
    "",
  ];

  // Build a map of consumer to affected schemas for a cleaner display
  const consumerSchemaMap = new Map<string, { schemaLabel: string; files: string[] }[]>();

  for (const hit of hits) {
    for (const consumer of hit.consumers) {
      if (!consumerSchemaMap.has(consumer)) {
        consumerSchemaMap.set(consumer, []);
      }
      consumerSchemaMap.get(consumer)!.push({
        schemaLabel: hit.schemaLabel,
        files: hit.matchedFiles,
      });
    }
  }

  // Format each consumer with its affected schemas
  for (const [consumer, schemas] of consumerSchemaMap) {
    const [owner, repo] = consumer.split("/");
    const repoLink = `https://github.com/${consumer}`;
    lines.push(`- **[${consumer}](${repoLink})**`);

    for (const schema of schemas) {
      lines.push(`  - ${schema.schemaLabel}`);
      lines.push(`    - Changed files: \`${schema.files.join("`, `")}\``);
    }
    lines.push("");
  }

  lines.push("</details>");

  return lines.join("\n");
}
