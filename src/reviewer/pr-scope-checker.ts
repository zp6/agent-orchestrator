/**
 * PR Scope Pre-Flight Checker — issue #358
 *
 * Proactively detects bundled / multi-issue pull requests **before** the LLM
 * review round is triggered.  Catching scope violations deterministically at
 * this stage saves one full LLM review cycle for every bundled PR.
 *
 * ## Detection signals (in priority order)
 *
 * 1. **multi-issue** — The PR body contains two or more distinct
 *    `Closes #N` / `Fixes #N` / `Resolves #N` references.  This is the
 *    strongest, most reliable signal: an agent that intentionally (or
 *    accidentally) bundled work will almost always produce multiple close
 *    keywords.
 *
 * 2. **triage-feature-mix** — The diff touches both documentation / admin
 *    files (CLAUDE.md, README, docs/, .github/) **and** implementation files
 *    (src/, lib/, test files, config files).  These belong in separate PRs
 *    per the one-issue-one-PR rule.
 *
 * 3. **multi-module** — The feature files span two or more *unrelated*
 *    top-level source directories (e.g. `src/reviewer/` AND `src/telegram/`)
 *    and each directory has at least `minFilesPerGroup` files touched.  A
 *    single cohesive change that touches both directories is fine (e.g. a new
 *    type that needs wiring in both layers), so this check uses a higher bar
 *    of at least 3 files per module group and at least 3 groups before
 *    flagging — enough signal to confidently call it bundled without
 *    false-positives on normal cross-cutting changes.
 *
 * ## Output
 *
 * `checkPRScope()` returns a `PRScopeCheckResult` with:
 * - `violation`       — true if any signal fired
 * - `violation_type`  — which signal fired (first match wins)
 * - `closes_refs`     — all `#N` numbers found in the PR body
 * - `feature_groups`  — inferred semantic groups to help the agent split the PR
 * - `reason`          — human-readable summary
 * - `split_suggestion`— structured markdown block suitable for a PR comment
 *
 * `formatScopeViolationComment()` builds a complete PR review comment from the
 * result, ready to post directly via `gh pr review --comment`.
 *
 * ## Integration
 *
 * Called inside `PRReviewer.reviewPR()` after the diff-size gate (line ~635),
 * before the LLM review call:
 *
 * ```typescript
 * import { checkPRScope, formatScopeViolationComment } from "./pr-scope-checker.js";
 *
 * const scopeResult = checkPRScope(pr.body, pr.diff);
 * if (scopeResult.violation) {
 *   const result: PRReviewResult = {
 *     decision: "request-changes",
 *     comment: formatScopeViolationComment(scopeResult, prNumber),
 *     reason: `PR scope violation (${scopeResult.violation_type}): ${scopeResult.reason}`,
 *     redispatchCategory: "quality-revision",
 *     severity: "minor",
 *   };
 *   await this.executeDecision(repo, prNumber, result);
 *   return result;
 * }
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The primary scope-violation category detected in a PR.
 *
 * - `multi-issue`        — 2+ distinct `Closes #N` references in PR body
 * - `triage-feature-mix` — docs/admin files mixed with implementation files
 * - `multi-module`       — implementation files span 3+ unrelated source dirs
 * - `clean`              — no scope violation detected
 */
export type PRScopeViolationType =
  | "multi-issue"
  | "triage-feature-mix"
  | "multi-module"
  | "clean";

/**
 * One inferred "feature group" within a bundled PR.
 *
 * Used to generate a structured split suggestion so the agent knows exactly
 * which files to move into each separate branch/PR.
 */
export interface FeatureGroup {
  /**
   * Short label describing this group.
   * Examples:  "src/reviewer/ (5 files)", "docs/ (2 files)",
   *            "Closes #42 — src/telegram/ changes"
   */
  label: string;
  /** Sorted list of file paths belonging to this group. */
  files: string[];
  /**
   * The issue number this group is most likely associated with, if inferable
   * from branch name + closes references.  Null when not determinable.
   */
  closes_hint: number | null;
}

/**
 * Full result returned by `checkPRScope()`.
 */
export interface PRScopeCheckResult {
  /** True when at least one scope-violation signal fired. */
  violation: boolean;
  /** The primary violation type (first match in priority order). */
  violation_type: PRScopeViolationType;
  /**
   * All issue numbers referenced via close keywords in the PR body.
   * Empty array when no references are found.
   */
  closes_refs: number[];
  /**
   * Inferred feature groups.  Non-empty only when `violation === true`.
   * Ordered from largest to smallest (most-changed group first).
   */
  feature_groups: FeatureGroup[];
  /** Human-readable one-line summary of why the violation fired. */
  reason: string;
  /**
   * Markdown-formatted split suggestion block.
   * Suitable for embedding directly in a PR review comment.
   */
  split_suggestion: string;
}

// ── File-categorisation (mirrors Verifier logic) ──────────────────────────────

const TRIAGE_FILE_PATTERNS: RegExp[] = [
  /^CLAUDE\.md$/i,
  /^README\.md$/i,
  /^README\.[a-z]+\.md$/i,
  /^ROADMAP\.md$/i,
  /^CHANGELOG\.md$/i,
  /^CHANGES\.md$/i,
  /^CONTRIBUTING\.md$/i,
  /^LICENSE$/i,
  /^docs\//i,
  /^\.github\//i,
];

const FEATURE_FILE_PATTERNS: RegExp[] = [
  /^src\//i,
  /^lib\//i,
  /^dist\//i,
  /\.test\.(ts|js|tsx|jsx)$/i,
  /\.spec\.(ts|js|tsx|jsx)$/i,
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^yarn\.lock$/i,
  /^tsconfig.*\.json$/i,
  /^vite\.config\./i,
  /^webpack\.config\./i,
  /^jest\.config\./i,
  /\.eslintrc/i,
  /^\.prettierrc/i,
  /^babel\.config\./i,
];

function categorizeFile(filePath: string): "triage" | "feature" | "neutral" {
  const lower = filePath.toLowerCase();
  for (const p of TRIAGE_FILE_PATTERNS) {
    if (p.test(lower)) return "triage";
  }
  for (const p of FEATURE_FILE_PATTERNS) {
    if (p.test(lower)) return "feature";
  }
  return "neutral";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract all unique issue numbers from GitHub close keywords in `text`.
 *
 * Recognises:  closes, fixes, resolves  (case-insensitive)
 * Formats:     `#42`,  `owner/repo#42`
 */
export function extractClosesRefs(text: string): number[] {
  const seen = new Set<number>();
  // Match: (closes|fixes|resolves) [owner/repo]#N
  const re = /(?:closes|fixes|resolves)\s+(?:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)?#(\d+)/gi;
  for (const m of text.matchAll(re)) {
    seen.add(parseInt(m[1]!, 10));
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Extract changed file paths from a raw unified diff.
 *
 * Supports both `git diff` and plain patch format.
 */
export function extractFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();

  // Primary: git diff headers  →  "diff --git a/<path> b/<path>"
  for (const m of diff.matchAll(/^diff --git a\/(.+) b\/.+$/gm)) {
    files.add(m[1]!);
  }

  // Fallback: "+++ b/<path>" lines
  if (files.size === 0) {
    for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
      const path = m[1]!;
      if (path !== "/dev/null") files.add(path);
    }
  }

  return [...files].sort();
}

/**
 * Derive the top-level "module key" from a source file path.
 *
 * Examples:
 *   `src/reviewer/pr-reviewer.ts`   → `src/reviewer`
 *   `src/state/store.ts`            → `src/state`
 *   `src/index.ts`                  → `src`
 *   `lib/utils/helper.ts`           → `lib/utils`
 *   `package.json`                  → `(root)`
 */
function moduleKey(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return "(root)";
  if (parts.length === 2) return parts[0]!;
  return `${parts[0]}/${parts[1]}`;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface PRScopeCheckerOptions {
  /**
   * Minimum number of files per module group before the multi-module check
   * treats that group as a distinct concern.
   *
   * Default: 3.  Raise this to reduce false positives on legitimate
   * cross-cutting changes.
   */
  minFilesPerGroup?: number;
  /**
   * Minimum number of qualifying module groups required before the
   * multi-module check fires a violation.
   *
   * Default: 3.  Two groups is common for cohesive changes (e.g. "add a new
   * type to `src/state/` and wire it in `src/reviewer/`"), so we require 3+
   * groups before calling it bundled.
   */
  minGroupsForViolation?: number;
}

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * Run the PR scope pre-flight check.
 *
 * @param prBody  - Raw PR body text (markdown).
 * @param diff    - Raw unified diff string (from `gh pr diff`).
 * @param opts    - Tuning options (see `PRScopeCheckerOptions`).
 * @returns       A `PRScopeCheckResult` describing any violation found.
 */
export function checkPRScope(
  prBody: string,
  diff: string,
  opts: PRScopeCheckerOptions = {},
): PRScopeCheckResult {
  const minFilesPerGroup = opts.minFilesPerGroup ?? 3;
  const minGroupsForViolation = opts.minGroupsForViolation ?? 3;

  const closesRefs = extractClosesRefs(prBody);
  const allFiles = extractFilesFromDiff(diff);

  // ── Signal 1: multiple Closes #N references ───────────────────────────────
  if (closesRefs.length >= 2) {
    const groups = buildClosesGroups(closesRefs, allFiles);
    const reason =
      `PR body references ${closesRefs.length} separate issues ` +
      `(${closesRefs.map((n) => `#${n}`).join(", ")}). ` +
      `Each issue must be addressed in its own branch and PR.`;
    return {
      violation: true,
      violation_type: "multi-issue",
      closes_refs: closesRefs,
      feature_groups: groups,
      reason,
      split_suggestion: buildSplitSuggestion("multi-issue", groups, closesRefs),
    };
  }

  // Categorise every file for signals 2 and 3
  const triageFiles: string[] = [];
  const featureFiles: string[] = [];
  for (const f of allFiles) {
    const cat = categorizeFile(f);
    if (cat === "triage") triageFiles.push(f);
    else if (cat === "feature") featureFiles.push(f);
  }

  // ── Signal 2: triage + feature mix ────────────────────────────────────────
  if (triageFiles.length > 0 && featureFiles.length > 0) {
    const groups: FeatureGroup[] = [
      { label: `Documentation / admin files (${triageFiles.length})`, files: triageFiles, closes_hint: null },
      { label: `Implementation files (${featureFiles.length})`, files: featureFiles, closes_hint: closesRefs[0] ?? null },
    ];
    const reason =
      `PR mixes documentation/admin files (${triageFiles.length}) with ` +
      `implementation files (${featureFiles.length}). ` +
      `These should be separate PRs — one for the housekeeping update, ` +
      `one for the feature implementation.`;
    return {
      violation: true,
      violation_type: "triage-feature-mix",
      closes_refs: closesRefs,
      feature_groups: groups,
      reason,
      split_suggestion: buildSplitSuggestion("triage-feature-mix", groups, closesRefs),
    };
  }

  // ── Signal 3: multiple unrelated source modules ───────────────────────────
  // Group feature files by their top-level source directory
  const byModule = new Map<string, string[]>();
  for (const f of featureFiles) {
    const key = moduleKey(f);
    if (!byModule.has(key)) byModule.set(key, []);
    byModule.get(key)!.push(f);
  }

  // Keep only modules that meet the minimum file threshold
  const qualifyingModules = [...byModule.entries()]
    .filter(([, files]) => files.length >= minFilesPerGroup)
    .sort((a, b) => b[1].length - a[1].length); // largest first

  if (qualifyingModules.length >= minGroupsForViolation) {
    const groups: FeatureGroup[] = qualifyingModules.map(([key, files]) => ({
      label: `${key}/ (${files.length} files)`,
      files,
      closes_hint: closesRefs[0] ?? null,
    }));
    const moduleNames = qualifyingModules.map(([key]) => `\`${key}/\``).join(", ");
    const reason =
      `PR touches ${qualifyingModules.length} unrelated source modules ` +
      `(${moduleNames}), each with ≥${minFilesPerGroup} files changed. ` +
      `This is a strong signal of bundled independent features.`;
    return {
      violation: true,
      violation_type: "multi-module",
      closes_refs: closesRefs,
      feature_groups: groups,
      reason,
      split_suggestion: buildSplitSuggestion("multi-module", groups, closesRefs),
    };
  }

  // ── Clean ─────────────────────────────────────────────────────────────────
  return {
    violation: false,
    violation_type: "clean",
    closes_refs: closesRefs,
    feature_groups: [],
    reason: "No scope violation detected — PR addresses a single concern.",
    split_suggestion: "",
  };
}

// ── Comment formatter ─────────────────────────────────────────────────────────

/**
 * Build a complete PR review comment for a scope violation.
 *
 * Suitable for posting directly via the `comment` field of `PRReviewResult`.
 *
 * @param result    - The `PRScopeCheckResult` from `checkPRScope()`.
 * @param prNumber  - The PR number (used in the suggested `gh pr create` examples).
 */
export function formatScopeViolationComment(
  result: PRScopeCheckResult,
  prNumber: number,
): string {
  const { violation_type, closes_refs, feature_groups, reason, split_suggestion } = result;

  const VIOLATION_HEADER: Record<PRScopeViolationType, string> = {
    "multi-issue":
      "🚫 **Scope violation: this PR addresses multiple issues**",
    "triage-feature-mix":
      "🚫 **Scope violation: PR mixes documentation changes with feature implementation**",
    "multi-module":
      "🚫 **Scope violation: PR bundles changes across unrelated modules**",
    clean: "",
  };

  const lines: string[] = [
    VIOLATION_HEADER[violation_type],
    "",
    reason,
    "",
    "**Rule:** Each PR must address exactly one issue (one branch, one PR, one `Closes #N`).",
    "",
    split_suggestion,
    "",
    "---",
    "",
    `> 🤖 Detected by the PR scope pre-flight check (issue #358).`,
    `> This check runs before LLM review to save one revision cycle.`,
    `> Re-open after splitting: create a separate PR for each concern listed above.`,
  ];

  // Append convenience commands when there are explicit closes refs
  if (closes_refs.length >= 2) {
    lines.push("", "**Suggested split commands:**");
    for (const ref of closes_refs) {
      lines.push(`\`\`\`\ngit checkout -b issue-${ref}-description\n# cherry-pick or move files for issue #${ref}\ngit push -u origin issue-${ref}-description\ngh pr create --title "..." --body "Closes #${ref}"\n\`\`\``);
    }
  }

  // Suppress unused-variable lint warning for prNumber — it can be used in
  // future enhancements (e.g. deep links back to this PR).
  void prNumber;

  return lines.join("\n");
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Build feature groups when signal 1 (multi-issue) fired.
 *
 * We attempt to map each changed file to the most "nearby" closes ref by
 * looking for the ref number in the file path or nearby commit context.
 * Because we only have the diff at this point (no commit messages), we fall
 * back to assigning all files to the first ref as a conservative default.
 */
function buildClosesGroups(closesRefs: number[], allFiles: string[]): FeatureGroup[] {
  // Attempt to assign files to refs via path heuristics
  const assigned = new Map<number, string[]>(closesRefs.map((r) => [r, []]));
  const unassigned: string[] = [];

  for (const file of allFiles) {
    let matched = false;
    for (const ref of closesRefs) {
      // Heuristic: does the file path contain the issue number?
      if (file.includes(`${ref}`) || file.includes(`issue-${ref}`)) {
        assigned.get(ref)!.push(file);
        matched = true;
        break;
      }
    }
    if (!matched) unassigned.push(file);
  }

  // Distribute unassigned files evenly across refs (round-robin)
  unassigned.forEach((f, i) => {
    const ref = closesRefs[i % closesRefs.length]!;
    assigned.get(ref)!.push(f);
  });

  return closesRefs
    .map((ref) => ({
      label: `Issue #${ref} (${assigned.get(ref)!.length} files)`,
      files: assigned.get(ref)!.sort(),
      closes_hint: ref,
    }))
    .filter((g) => g.files.length > 0);
}

/**
 * Build the markdown `split_suggestion` block embedded in review comments.
 */
function buildSplitSuggestion(
  violationType: PRScopeViolationType,
  groups: FeatureGroup[],
  closesRefs: number[],
): string {
  if (groups.length === 0) return "";

  const lines: string[] = ["**Suggested split:**", ""];

  for (const group of groups) {
    const issueHint =
      group.closes_hint != null
        ? ` → PR for issue #${group.closes_hint}`
        : "";
    lines.push(`**${group.label}**${issueHint}`);
    // Show up to 8 files per group to keep the comment readable
    const shown = group.files.slice(0, 8);
    for (const f of shown) {
      lines.push(`  - \`${f}\``);
    }
    if (group.files.length > 8) {
      lines.push(`  - _…and ${group.files.length - 8} more_`);
    }
    lines.push("");
  }

  switch (violationType) {
    case "multi-issue":
      lines.push(
        `Each of the ${closesRefs.length} issues above should become its own branch + PR.`,
        `The file groupings are approximate — use your judgement on the exact split.`,
      );
      break;
    case "triage-feature-mix":
      lines.push(
        `Create two separate PRs:`,
        `  1. A housekeeping PR with just the documentation / admin files`,
        `  2. A feature PR with the implementation files (linked to the relevant issue)`,
      );
      break;
    case "multi-module":
      lines.push(
        `Each module group above likely represents an independent change.`,
        `Create a separate branch + PR for each, each with its own \`Closes #N\`.`,
      );
      break;
    default:
      break;
  }

  return lines.join("\n");
}
