/**
 * Claude Agent Orchestrator
 *
 * Public API surface for the orchestrator package.
 * Exports core classes, helpers, and integration points for fleet coordination.
 */

// Activity reporting (for changelog generation)
export {
  generateWeeklyActivityReport,
  getWeeklyMergedPRs,
  getWeeklyClosedLinearIssues,
  getDirectorHighlights,
  formatActivityReportAsMarkdown,
  type WeeklyActivityReport,
  type WeeklyPR,
  type WeeklyLinearIssue,
  type DirectorHighlight,
} from "./orchestrator/activity-generator.js";

// PR preflight URL gate — external dependency reachability checks before
// `gh pr create` / `orch preflight` submission.
export {
  formatPreflightHelp,
  parsePreflightArgs,
  scanPreflightUrlCandidates,
  checkUrlsInDiff,
  formatPreflightFailureReport,
} from "./reviewer/preflight.js";
export type {
  PreflightCliOptions,
  PreflightCliResult,
  PreflightFailure,
  PreflightReport,
} from "./reviewer/preflight.js";
export { runPreflightCli } from "./cli/preflight.js";
