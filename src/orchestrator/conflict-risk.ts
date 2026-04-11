/**
 * Conflict-risk scoring for pre-dispatch gating.
 *
 * Before the orchestrator dispatches a task to an agent, this module computes
 * a 0–1 overlap score between the issue's "likely touched files" (derived from
 * keywords in the title/body) and the files already modified by open PRs on the
 * same repo.  A high score means the new task would likely touch the same files
 * as in-flight work, increasing the chance of merge conflicts.
 *
 * The heat map (per-file PR count) is also stored in state.db so the dashboard
 * can display which files are "hot" and which queued tasks are waiting for a
 * clear lane.
 */

import { execFileSync } from "node:child_process";
import { createLogger } from "../service/logger.js";

const log = createLogger("conflict-risk");

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ConflictRiskResult {
  /** 0.0–1.0 score: fraction of the issue's fingerprint tokens that overlap
   *  with files changed in open PRs. Higher = more conflict-prone. */
  score: number;
  /** Files that appear in 2+ open PRs — currently "hot". */
  hotFiles: string[];
  /** Files that overlap between the issue fingerprint and open PR files. */
  overlappingFiles: string[];
  /** PR numbers that touch at least one overlapping file. */
  overlappingPRs: number[];
  /** Breakdown: map of PR number → list of files it changes. */
  prFiles: Record<number, string[]>;
}

export interface HeatMapEntry {
  repo: string;
  filePath: string;
  openPrCount: number;
  prNumbers: number[];
  assessedAt: string;
}

// ── File-fetching helpers ─────────────────────────────────────────────────────

/**
 * Fetch the changed file paths for a single open PR.
 * Uses `gh api` to get up to 100 files per PR.
 * Returns an empty array on any error (best-effort).
 */
function fetchPRFiles(repo: string, prNumber: number): string[] {
  try {
    const raw = execFileSync(
      "gh",
      ["api", `repos/${repo}/pulls/${prNumber}/files`, "--jq", "[.[].filename]"],
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/**
 * Fetch all open PRs for a repo and return a map of PR number → changed files.
 * Caps at 30 open PRs to keep the pre-dispatch latency bounded.
 */
export function fetchOpenPRFiles(repo: string): Map<number, string[]> {
  const result = new Map<number, string[]>();
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "list", "--repo", repo, "--state", "open", "--json", "number", "-L", "30"],
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    if (!raw) return result;
    const prs = JSON.parse(raw) as Array<{ number: number }>;
    for (const pr of prs) {
      const files = fetchPRFiles(repo, pr.number);
      if (files.length > 0) result.set(pr.number, files);
    }
  } catch {
    // gh not available or repo inaccessible — return empty map
  }
  return result;
}

// ── Fingerprint extraction ────────────────────────────────────────────────────

/**
 * Common orchestrator path-segment keywords that map from issue language
 * to file paths.  Extend as more patterns emerge.
 */
const KEYWORD_TO_PATHS: Array<[RegExp, string[]]> = [
  [/\bdispatch(er|ing|ed)?\b/i, ["src/orchestrator/dispatcher", "src/orchestrator/pre-dispatch"]],
  [/\bsupervis(or|ion)\b/i, ["src/orchestrator/supervisor", "src/orchestrator/router"]],
  [/\bdashboard\b/i, ["src/dashboard", "src/cli/commands/dashboard"]],
  [/\bstate\b|\bstore\b/i, ["src/state/store"]],
  [/\bverif(y|ier|ication)\b/i, ["src/orchestrator/verifier", "src/service/verify"]],
  [/\bpr[-\s]?review(er)?\b/i, ["src/orchestrator/pr-reviewer", "src/orchestrator/pr-lister"]],
  [/\bpre[-\s]?dispatch\b/i, ["src/orchestrator/pre-dispatch-validator"]],
  [/\bconflicts?\b/i, ["src/orchestrator/pr-reviewer", "src/orchestrator/pre-dispatch-validator"]],
  [/\bconfig\b|\bconfiguration\b/i, ["src/config/schema", "agents.yaml"]],
  [/\bnotif(y|ication)\b|\btelegram\b/i, ["src/service/notify", "src/triggers/telegram"]],
  [/\btrigger\b/i, ["src/triggers"]],
  [/\bduplicate\b/i, ["src/triggers/duplicate-guard"]],
  [/\bescalat(e|ion)\b/i, ["src/triggers/reporters"]],
  [/\bbudget\b/i, ["src/cli/commands/budget"]],
  [/\bdeamon\b|\bloop\b/i, ["src/service/daemon"]],
  [/\bmodel[-\s]?rout(e|er|ing)\b/i, ["src/orchestrator/model-router", "src/orchestrator/llm-router"]],
];

/**
 * Extract a set of path-segment tokens from an issue title and body.
 *
 * Strategy (in priority order):
 * 1. Any explicit file paths mentioned in the body (e.g. `src/foo/bar.ts`)
 * 2. Keyword-to-path mappings from the KEYWORD_TO_PATHS table above
 * 3. CamelCase / kebab-case words from the title that look like module names
 *
 * Returns normalised lowercase path prefix tokens.
 */
export function extractIssueFingerprint(title: string, body: string): string[] {
  const tokens = new Set<string>();

  const text = `${title}\n${body}`;

  // 1. Explicit file paths in the text (e.g. `src/foo/bar.ts` or `src/foo/bar`)
  const pathMatches = text.matchAll(/\bsrc\/[\w/.-]+/g);
  for (const m of pathMatches) {
    // normalise: strip extension, lowercase
    tokens.add(m[0].replace(/\.[a-z]+$/, "").toLowerCase());
  }

  // 2. Keyword → path mappings
  for (const [pattern, paths] of KEYWORD_TO_PATHS) {
    if (pattern.test(text)) {
      for (const p of paths) tokens.add(p.toLowerCase());
    }
  }

  // 3. CamelCase / kebab words from the title that look like TypeScript module names
  // e.g. "PreDispatchValidator" → "pre-dispatch-validator"
  const camelWords = title.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g);
  for (const m of camelWords) {
    const kebab = m[0]
      .replace(/([A-Z])/g, "-$1")
      .toLowerCase()
      .replace(/^-/, "");
    tokens.add(kebab);
  }

  return [...tokens];
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Compute the conflict-risk score for an issue against a set of open PR files.
 *
 * Score = number of fingerprint tokens that match at least one open PR file /
 *         total fingerprint tokens.  Returns 0 when there are no fingerprint
 *         tokens or no open PRs.
 */
export function scoreConflictRisk(
  fingerprint: string[],
  prFiles: Map<number, string[]>,
): ConflictRiskResult {
  if (fingerprint.length === 0 || prFiles.size === 0) {
    return {
      score: 0,
      hotFiles: [],
      overlappingFiles: [],
      overlappingPRs: [],
      prFiles: Object.fromEntries(prFiles),
    };
  }

  // Count how many open PRs touch each file
  const fileFrequency = new Map<string, Set<number>>();
  for (const [prNumber, files] of prFiles) {
    for (const f of files) {
      const key = f.toLowerCase();
      if (!fileFrequency.has(key)) fileFrequency.set(key, new Set());
      fileFrequency.get(key)!.add(prNumber);
    }
  }

  // Hot files: touched by 2+ open PRs
  const hotFiles: string[] = [];
  for (const [file, prs] of fileFrequency) {
    if (prs.size >= 2) hotFiles.push(file);
  }

  // Overlap: fingerprint tokens that prefix-match any open PR file
  const overlappingFiles = new Set<string>();
  const overlappingPRs = new Set<number>();
  let matchedTokens = 0;

  for (const token of fingerprint) {
    let tokenMatched = false;
    for (const [file, prs] of fileFrequency) {
      if (file.startsWith(token) || file.includes(token)) {
        overlappingFiles.add(file);
        for (const pr of prs) overlappingPRs.add(pr);
        tokenMatched = true;
      }
    }
    if (tokenMatched) matchedTokens++;
  }

  const score = matchedTokens / fingerprint.length;

  log.debug("Conflict risk scored", {
    fingerprint,
    score,
    hotFiles: hotFiles.length,
    overlappingPRs: [...overlappingPRs],
  });

  return {
    score,
    hotFiles,
    overlappingFiles: [...overlappingFiles],
    overlappingPRs: [...overlappingPRs],
    prFiles: Object.fromEntries(prFiles),
  };
}

// ── Top-level entry point ─────────────────────────────────────────────────────

/**
 * Assess the conflict risk for dispatching a task to work on a given GitHub
 * issue.  Fetches open PR files for the repo and scores the overlap against
 * the issue's fingerprint.
 *
 * This is the function called from the pre-dispatch validator.
 */
export function assessConflictRisk(
  repo: string,
  issueTitle: string,
  issueBody: string,
): ConflictRiskResult {
  const fingerprint = extractIssueFingerprint(issueTitle, issueBody);
  if (fingerprint.length === 0) {
    // No usable fingerprint — can't determine risk, return zero
    return {
      score: 0,
      hotFiles: [],
      overlappingFiles: [],
      overlappingPRs: [],
      prFiles: {},
    };
  }

  const prFiles = fetchOpenPRFiles(repo);
  return scoreConflictRisk(fingerprint, prFiles);
}

/**
 * Build the conflict heat map for a repo: a list of files currently touched by
 * open PRs, with a count of how many PRs touch each file.  Sorted by PR count
 * descending so the "hottest" files come first.
 *
 * Used by the dashboard to render the heat map panel and by the pre-dispatch
 * validator to surface context about which files are in-flight.
 */
export function buildConflictHeatMap(repo: string): HeatMapEntry[] {
  const prFiles = fetchOpenPRFiles(repo);
  if (prFiles.size === 0) return [];

  const fileFrequency = new Map<string, Set<number>>();
  for (const [prNumber, files] of prFiles) {
    for (const f of files) {
      const key = f.toLowerCase();
      if (!fileFrequency.has(key)) fileFrequency.set(key, new Set());
      fileFrequency.get(key)!.add(prNumber);
    }
  }

  const now = new Date().toISOString();
  return [...fileFrequency.entries()]
    .map(([filePath, prs]) => ({
      repo,
      filePath,
      openPrCount: prs.size,
      prNumbers: [...prs].sort((a, b) => a - b),
      assessedAt: now,
    }))
    .sort((a, b) => b.openPrCount - a.openPrCount);
}
