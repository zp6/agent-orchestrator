/**
 * Security scanner false-positive allowlist.
 *
 * Defines patterns for example/template/sample files that should be skipped
 * during security scanning because they are intentionally placeholder content.
 *
 * CRITICAL: This allowlist must be kept in sync with:
 * - rapartlu/agent-proxy/src/config/security-allowlist.ts
 *
 * When updating patterns here, ensure both repositories are updated
 * in the same PR or in coordinated PRs to prevent divergence.
 */

/**
 * Patterns that identify example/template/sample files.
 *
 * Used by:
 * 1. PR review rubric (this file) — skips security checks on matching files
 * 2. Security scanner (agent-proxy) — skips generating alerts for matching files
 * 3. External security scanners — should skip files matching these patterns
 *
 * Format:
 * - Filename patterns: "*.example.*", ".env.example" (tested against filename)
 * - Directory patterns: "examples/", "templates/" (tested against path segments)
 * - Prefix patterns: "example.", "template." (tested against filename start)
 * - Infix patterns: ".example.", ".template." (tested against filename)
 */
export const SECURITY_EXAMPLE_FILE_PATTERNS = {
  // Filename glob patterns (tested against basename)
  globPatterns: [
    "*.example",
    "*.example.*",
    "*.template",
    "*.template.*",
    "*.sample",
    "*.sample.*",
  ],

  // Exact filenames commonly used for documentation / example configs
  exactFilenames: [
    ".env.example",
    ".env.keep",
    ".env.sample",
    "agents.example.json",
    "docker-compose.example.yml",
    "docker-compose.example.yaml",
  ],

  // Directory patterns (any file under these dirs is considered an example)
  directoryPatterns: ["examples", "templates", "samples"],

  // Filename prefix patterns (file basename starts with these)
  prefixPatterns: ["example.", "template.", "sample."],

  // Filename infix patterns (file basename contains these)
  infixPatterns: [".example.", ".template.", ".sample."],

  // Header-based detection (first 5 lines contain these strings)
  headerPatterns: [
    "# example",
    "# this is an example",
    "# sample",
    "# template",
    "# do not commit",
    "# placeholder",
  ],
};

/**
 * Detect whether a file path matches the example/template/sample patterns.
 *
 * This replaces the old inline `isExampleOrTemplateFile()` function and uses
 * the shared pattern definitions to ensure consistency with the security scanner.
 *
 * Matching order:
 * 1. Directory segment check (any dir named "examples", "templates", "samples")
 * 2. Infix pattern check (.example., .template., .sample.)
 * 3. Prefix pattern check (example., template., sample.)
 * 4. Exact filename match
 * 5. Glob pattern match
 * 6. Header pattern check (if content provided)
 *
 * @param filePath The file path to check
 * @param content Optional file content for header-based checks
 * @returns true if the file matches any example/template/sample pattern
 */
export function isExampleOrTemplateFile(
  filePath: string,
  content?: string
): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1] ?? "";

  // Check directory patterns
  const dirs = new Set(SECURITY_EXAMPLE_FILE_PATTERNS.directoryPatterns);
  for (const seg of segments.slice(0, -1)) {
    if (dirs.has(seg.toLowerCase())) return true;
  }

  // Check infix patterns
  for (const pattern of SECURITY_EXAMPLE_FILE_PATTERNS.infixPatterns) {
    if (basename.toLowerCase().includes(pattern.toLowerCase())) return true;
  }

  // Check prefix patterns
  for (const pattern of SECURITY_EXAMPLE_FILE_PATTERNS.prefixPatterns) {
    if (basename.toLowerCase().startsWith(pattern.toLowerCase())) return true;
  }

  // Check exact filenames
  if (SECURITY_EXAMPLE_FILE_PATTERNS.exactFilenames.includes(basename)) {
    return true;
  }

  // Check glob patterns
  for (const pattern of SECURITY_EXAMPLE_FILE_PATTERNS.globPatterns) {
    if (simpleGlobMatch(basename, pattern)) return true;
  }

  // Check header patterns (if content provided)
  if (content) {
    const firstLines = content
      .split("\n")
      .slice(0, 5)
      .map((l) => l.trim().toLowerCase());
    for (const line of firstLines) {
      if (
        SECURITY_EXAMPLE_FILE_PATTERNS.headerPatterns.some((p) =>
          line.includes(p.toLowerCase())
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Simple glob matcher supporting `*` wildcard.
 * NOT a full glob engine, designed for simple filename patterns.
 */
function simpleGlobMatch(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, "[^/]*")}$`, "i");
  return regex.test(name);
}

/**
 * Documentation: Pattern Synchronization
 *
 * When updating SECURITY_EXAMPLE_FILE_PATTERNS:
 *
 * 1. **Primary location**: rapartlu/agent-proxy/src/config/security-allowlist.ts
 * 2. **Mirror location**: THIS FILE (rapartlu/agent-reviewer/src/config/security-allowlist.ts)
 *
 * Both must be kept in sync. When patterns change:
 * - Update agent-proxy first (where the security scanner reads from)
 * - Create a PR with both updates (agent-proxy + agent-reviewer changes)
 * - OR create separate PRs but reference each other with issue links
 *
 * Current pattern definitions match both systems as of:
 * - agent-proxy: PR #412
 * - agent-reviewer: Issue #103 (this PR)
 */
