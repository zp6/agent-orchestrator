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
