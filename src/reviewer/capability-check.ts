/**
 * Capability check for the reviewer agent — declares which task types this
 * agent is eligible to receive and rejects everything else.
 *
 * The orchestrator's dispatcher calls each agent's `/capability-check` endpoint
 * before dispatching a task. When the reviewer rejects a task, the orchestrator
 * reroutes it to the repo's home agent (the one whose `github` field matches
 * the issue's repo).
 *
 * ## Reviewer scope
 *
 * The reviewer agent is **implementation-ineligible**. Its capacity must be
 * reserved for quality and oversight work:
 *
 * - PR review (approve / request-changes / escalate)
 * - Task verification (quality scoring, revision dispatch)
 * - Supervision (strategic reasoning, dispatch decisions)
 * - Improvement detection (pattern analysis, issue creation)
 * - Housekeeping / triage (for its own repo only)
 *
 * ## Accepted task sources
 *
 * Tasks are accepted when they match ANY of these criteria:
 *
 * 1. **Task type** is one of the reviewer's known work types:
 *    `review`, `verification`, `supervision`, `improvement`, `triage`,
 *    `housekeeping`, `research` (research about review patterns / quality).
 *
 * 2. **Source** is `pr-feedback` or `manual` — these are follow-up tasks from
 *    PR review rounds or operator-initiated work.
 *
 * 3. **Source ref** points to the reviewer's own repo (`rapartlu/agent-reviewer`)
 *    — the reviewer may implement features in its own codebase.
 *
 * Everything else — especially `implementation` tasks targeting foreign repos
 * like `agent-orchestrator`, `agent-dashboard`, etc. — is rejected.
 *
 * @see https://github.com/rapartlu/agent-reviewer/issues/325
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("capability-check");

// ── Constants ────────────────────────────────────────────────────────────

/** The reviewer's own GitHub repo slug. */
export const REVIEWER_REPO = "rapartlu/agent-reviewer";

/**
 * Task types the reviewer is allowed to handle.
 * These map to the `task_type` field set by the orchestrator dispatcher.
 */
export const ALLOWED_TASK_TYPES: ReadonlySet<string> = new Set([
  "review",
  "verification",
  "supervision",
  "improvement",
  "triage",
  "housekeeping",
  "research",
  "escalation",
]);

/**
 * Task sources that are always accepted regardless of task type.
 * `pr-feedback` = follow-up from a PR review round.
 * `manual` = operator-initiated via Telegram `/dispatch` or `/chat`.
 */
export const ALLOWED_SOURCES: ReadonlySet<string> = new Set([
  "pr-feedback",
  "manual",
]);

/**
 * Title patterns that indicate reviewer-appropriate work, even when the
 * task type is ambiguously set to "implementation".
 */
const REVIEWER_WORK_PATTERNS: RegExp[] = [
  /\bPR review\b/i,
  /\breview\b.*\bPR\b/i,
  /\bverif(y|ication)\b/i,
  /\bsupervis(or|ion)\b/i,
  /\bimprovement\s+detect/i,
  /\bcalibration\b/i,
  /\bquality\s+(score|anomal|system|floor)/i,
  /\brouting\s+(violation|accuracy)/i,
  /\bscore\s+(calibrat|integrit)/i,
  /\bhousekeeping\b/i,
  /\btriage\b/i,
];

// ── Types ────────────────────────────────────────────────────────────────

export interface CapabilityCheckRequest {
  /** Human-readable task title. */
  title: string;
  /** Task type string (e.g. "implementation", "review", "research"). */
  task_type: string;
  /** Source reference e.g. "rapartlu/agent-orchestrator#965". */
  source_ref?: string;
  /** How the task was sourced (e.g. "github", "pr-feedback", "manual"). */
  source?: string;
}

export interface CapabilityCheckResult {
  /** Whether the reviewer accepts this task. */
  accept: boolean;
  /** Human-readable rejection reason (present when accept is false). */
  reason?: string;
}

// ── Core logic ───────────────────────────────────────────────────────────

/**
 * Extract the GitHub repo slug (owner/repo) from a source_ref like
 * "owner/repo#123". Returns null if the format doesn't match.
 */
function extractRepo(sourceRef: string | undefined | null): string | null {
  if (!sourceRef) return null;
  const hashIdx = sourceRef.lastIndexOf("#");
  if (hashIdx <= 0) return null;
  return sourceRef.slice(0, hashIdx);
}

/**
 * Check whether a task title matches reviewer-appropriate work patterns.
 */
function titleMatchesReviewerWork(title: string): boolean {
  return REVIEWER_WORK_PATTERNS.some((pattern) => pattern.test(title));
}

/**
 * Evaluate whether the reviewer agent should accept a given task.
 *
 * This is the core decision function — it has no side effects and can be
 * called from both HTTP handlers and local enforcement code.
 */
export function evaluateCapability(req: CapabilityCheckRequest): CapabilityCheckResult {
  const { title, task_type, source_ref, source } = req;

  // 1. Always accept tasks from allowed sources (pr-feedback, manual).
  if (source && ALLOWED_SOURCES.has(source)) {
    return { accept: true };
  }

  // 2. Accept tasks whose type is in the reviewer's allowed set.
  if (ALLOWED_TASK_TYPES.has(task_type)) {
    return { accept: true };
  }

  // 3. Accept tasks targeting the reviewer's own repo — it can implement
  //    features in its own codebase.
  const targetRepo = extractRepo(source_ref);
  if (targetRepo === REVIEWER_REPO) {
    return { accept: true };
  }

  // 4. Accept tasks whose title matches reviewer work patterns, even if
  //    the task_type is incorrectly set to "implementation".
  if (title && titleMatchesReviewerWork(title)) {
    return { accept: true };
  }

  // 5. Reject everything else — this is an implementation task for a
  //    foreign repo that should go to the repo's home agent.
  const repoHint = targetRepo ? ` targeting ${targetRepo}` : "";
  const reason =
    `Reviewer agent is implementation-ineligible. ` +
    `Task type "${task_type}"${repoHint} does not match reviewer scope ` +
    `(review, verification, supervision, improvement detection). ` +
    `Reroute to the repo's home agent.`;

  log.info("Capability check: rejecting task", {
    title: title?.slice(0, 80),
    task_type,
    source_ref,
    source,
    reason,
  });

  return { accept: false, reason };
}

// ── HTTP handler ─────────────────────────────────────────────────────────

/**
 * Parse query-string parameters from a `/capability-check` GET request
 * into a `CapabilityCheckRequest`.
 *
 * Compatible with the orchestrator's `callCapabilityCheck()` client which
 * sends `title`, `task_type`, and `source_ref` as URL query params.
 */
export function parseCapabilityCheckQuery(params: Record<string, string | undefined>): CapabilityCheckRequest {
  return {
    title: params.title ?? "",
    task_type: params.task_type ?? "implementation",
    source_ref: params.source_ref ?? undefined,
    source: params.source ?? undefined,
  };
}

/**
 * Handle an incoming capability-check request and return the JSON response
 * body. Designed to be mounted as:
 *
 *   app.get('/capability-check', (req, res) => {
 *     res.json(handleCapabilityCheck(req.query));
 *   });
 *
 * The response shape matches what the orchestrator's capability-check
 * client expects: `{ accept: boolean, reason?: string }`.
 */
export function handleCapabilityCheck(
  queryParams: Record<string, string | undefined>,
): CapabilityCheckResult {
  const req = parseCapabilityCheckQuery(queryParams);
  return evaluateCapability(req);
}
