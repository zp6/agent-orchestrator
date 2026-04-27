/**
 * MeetingOutcomeClient — HTTP client for the meeting-facilitator agent's
 * structured outcome API.
 *
 * Introduced as part of the coordinated change for
 * rapartlu/meeting-facilitator-agent#427 (issue #460 in agent-reviewer):
 * the meeting-facilitator agent exposes `/api/meeting/:id/outcome` so the
 * supervisor can retrieve the structured result of a completed meeting — in
 * particular the priority ranking, sequencing constraints, and
 * follow-up recommendation produced by the discussion session.
 *
 * ## What the supervisor needs
 *
 * After the dispatch-storm / guard-bounce meeting (task 01KQ08FB, score 0.9),
 * the supervisor requires three pieces of structured intelligence:
 *
 *   1. **Priority ranking** — which of agent-reviewer #427, agent-reviewer
 *      #391, and agent-orchestrator #1113 was agreed as the highest
 *      implementation priority.
 *   2. **Sequencing constraints** — e.g. "#1113 must merge before #391 because
 *      the surge-suppression table is a prerequisite".
 *   3. **Follow-up recommendation** — whether a second coordination meeting is
 *      needed before implementation begins, and why.
 *
 * ## Meeting-facilitator agent HTTP API (port 3485)
 *
 *   GET  /api/meeting/:id/outcome        → MeetingOutcome
 *   GET  /api/meetings/outcomes          → MeetingOutcome[]
 *   GET  /api/meetings/outcomes/summary  → MeetingOutcomeSummary
 *
 * ## Example usage (in the supervisor)
 *
 *   const client = new MeetingOutcomeClient();
 *
 *   // After a meeting task is approved:
 *   const outcome = await client.fetchOutcome('mtg-01KQ08FB');
 *   if (outcome?.priority_ranking.length) {
 *     const top = outcome.priority_ranking[0];
 *     log.info('top priority', { issue: top.issue, rationale: top.rationale });
 *   }
 *
 *   // Lightweight status check for dashboards / Telegram:
 *   const snapshot = await client.summary();
 *   if (snapshot) {
 *     log.info('meeting outcomes', { completed: snapshot.completed_count });
 *   }
 *
 * All methods are fail-safe — network or parse errors are caught and logged;
 * the orchestrator daemon continues even when the meeting-facilitator is
 * unreachable.
 *
 * ## Meeting outcome lifecycle
 *
 *   pending → in_progress → complete
 *                         ↘ failed
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("meeting-outcome-client");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MeetingOutcomeStatus =
  | "pending"
  | "in_progress"
  | "complete"
  | "failed";

/**
 * A reference to a specific GitHub issue — the building block for priority
 * rankings and sequencing constraints.
 */
export interface IssueRef {
  /** GitHub org/repo slug, e.g. "rapartlu/agent-reviewer". */
  repo: string;
  /** Issue number. */
  number: number;
  /** Optional short human-readable title for display. */
  title?: string;
}

/**
 * One entry in the priority ranking produced by the meeting discussion.
 *
 * Rank 1 = highest priority (implement first).
 */
export interface PriorityRankingEntry {
  /** 1-based rank; rank 1 should be implemented first. */
  rank: number;
  /** The GitHub issue that this entry refers to. */
  issue: IssueRef;
  /**
   * Why this issue was placed at this rank — verbatim from the meeting
   * discussion or summarised by the facilitator.
   */
  rationale: string;
  /**
   * Estimated relative implementation effort agreed during the meeting.
   * One of "low" | "medium" | "high".  `null` when not discussed.
   */
  effort?: "low" | "medium" | "high" | null;
}

/**
 * A hard implementation dependency identified during the meeting:
 * `successor` cannot be merged until `predecessor` has landed.
 */
export interface SequencingConstraint {
  /** Must be implemented and merged first. */
  predecessor: IssueRef;
  /** Depends on the predecessor. */
  successor: IssueRef;
  /**
   * Why this ordering is required — e.g. "surge-suppression table introduced
   * in #1113 is a prerequisite for the issue-scoped alert logic in #391".
   */
  reason: string;
}

/**
 * The full structured outcome returned by
 * GET /api/meeting/:id/outcome on the meeting-facilitator agent.
 */
export interface MeetingOutcome {
  /** Stable meeting identifier, prefixed with "mtg-" (e.g. "mtg-01KQ08FB"). */
  meeting_id: string;
  /** Short description of the meeting topic. */
  topic: string;
  /** Current lifecycle status of the meeting outcome record. */
  status: MeetingOutcomeStatus;
  /**
   * Ordered list of issues ranked by implementation priority (rank 1 = first).
   * Empty when the meeting did not produce a priority ranking.
   */
  priority_ranking: PriorityRankingEntry[];
  /**
   * Hard ordering constraints between issues.
   * Empty when no sequencing dependencies were identified.
   */
  sequencing_constraints: SequencingConstraint[];
  /**
   * Whether the meeting recommended scheduling a follow-up coordination
   * session before implementation begins.
   */
  follow_up_recommended: boolean;
  /**
   * Explanation of why a follow-up meeting is (or is not) recommended.
   * `null` when `follow_up_recommended` is false and no rationale was noted.
   */
  follow_up_rationale: string | null;
  /**
   * Free-form list of decisions captured verbatim from the discussion.
   * Useful for audit trails and supervisor logs.
   */
  decisions: string[];
  /**
   * Action items assigned during the meeting (free-form strings, e.g.
   * "Implement #1113 (assignee: claude-agent-orchestrator)").
   */
  action_items: string[];
  /**
   * Meeting quality score (0–100) produced by the verifier when the parent
   * meeting task was verified.  `null` when not yet verified or not available.
   */
  verifier_score: number | null;
  /** ISO 8601 timestamp of when the meeting outcome was recorded. */
  decided_at: string;
  /** ISO 8601 timestamp of when this record was created. */
  created_at: string;
  /** ISO 8601 timestamp of the most recent update. */
  updated_at: string;
}

/**
 * Concise snapshot returned by GET /api/meetings/outcomes/summary.
 *
 * Useful for dashboard headers and Telegram status lines where full outcome
 * detail is too verbose.
 */
export interface MeetingOutcomeSummary {
  /** Number of outcomes with status "pending" or "in_progress". */
  in_flight_count: number;
  /** Total number of completed meeting outcomes stored. */
  completed_count: number;
  /**
   * The most recently completed outcome, or `null` when none exist yet.
   */
  last_completed: {
    meeting_id: string;
    topic: string;
    top_priority_issue: IssueRef | null;
    decided_at: string;
  } | null;
  /**
   * Age in milliseconds of the oldest in-flight (pending/in_progress) outcome.
   * `null` when there are no in-flight outcomes.
   */
  oldest_in_flight_age: number | null;
}

/** Options for constructing a `MeetingOutcomeClient`. */
export interface MeetingOutcomeClientOptions {
  /**
   * Base URL of the meeting-facilitator agent's HTTP server.
   * Defaults to `http://localhost:3485` (the standard fleet port).
   */
  baseUrl?: string;
  /** Fetch timeout in ms.  Defaults to 10 000 ms. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "http://localhost:3485";
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MeetingOutcomeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: MeetingOutcomeClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Fetch the structured outcome for a specific meeting by its ID.
   *
   * Returns the full `MeetingOutcome` object, or `null` if the meeting does
   * not exist, the outcome is not yet available, or the request fails.
   *
   * @example
   *   const outcome = await client.fetchOutcome('mtg-01KQ08FB');
   *   if (outcome?.status === 'complete') {
   *     const topIssue = outcome.priority_ranking[0]?.issue;
   *     log.info('top priority', { repo: topIssue?.repo, number: topIssue?.number });
   *   }
   */
  async fetchOutcome(meetingId: string): Promise<MeetingOutcome | null> {
    return this.request<MeetingOutcome>(
      "GET",
      `/api/meeting/${encodeURIComponent(meetingId)}/outcome`,
    );
  }

  /**
   * List all meeting outcomes, optionally filtered by status.
   *
   * Returns an empty array on failure so callers can degrade gracefully.
   *
   * @param status  Optional filter: "pending" | "in_progress" | "complete" | "failed".
   * @param limit   Maximum number of results (default: 20).
   */
  async listOutcomes(
    opts: { status?: MeetingOutcomeStatus; limit?: number } = {},
  ): Promise<MeetingOutcome[]> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));

    const qs = params.toString();
    const path = `/api/meetings/outcomes${qs ? `?${qs}` : ""}`;
    const result = await this.request<MeetingOutcome[]>("GET", path);
    return result ?? [];
  }

  /**
   * Fetch a concise summary snapshot from GET /api/meetings/outcomes/summary.
   *
   * Returns a `MeetingOutcomeSummary` on success, or `null` when the
   * meeting-facilitator agent is unreachable or returns a non-2xx status.
   *
   * Callers should degrade gracefully on `null` — the full `listOutcomes()`
   * endpoint is always available as a fallback.
   *
   * @example
   *   const snapshot = await client.summary();
   *   if (snapshot) {
   *     log.info('meeting outcomes', { completed: snapshot.completed_count });
   *   }
   */
  async summary(): Promise<MeetingOutcomeSummary | null> {
    return this.request<MeetingOutcomeSummary>(
      "GET",
      "/api/meetings/outcomes/summary",
    );
  }

  /**
   * Extract the supervisor's priority intelligence from a completed outcome.
   *
   * Returns a structured object that is ready for the supervisor to act on:
   *   - `topPriority`: the highest-ranked issue (rank 1), or `null`.
   *   - `orderedIssues`: all issues in priority order (lowest rank = first).
   *   - `constraints`: all sequencing constraints.
   *   - `followUpRecommended`: whether a follow-up meeting was recommended.
   *   - `followUpRationale`: the reason, or `null`.
   *
   * Returns `null` when the outcome is not yet complete or has no ranking.
   *
   * @example
   *   const intel = client.extractSupervisorIntelligence(outcome);
   *   if (intel) {
   *     // Dispatch the top-priority issue first.
   *     await dispatcher.dispatch(intel.topPriority);
   *   }
   */
  extractSupervisorIntelligence(outcome: MeetingOutcome): {
    topPriority: IssueRef | null;
    orderedIssues: IssueRef[];
    constraints: SequencingConstraint[];
    followUpRecommended: boolean;
    followUpRationale: string | null;
  } | null {
    if (outcome.status !== "complete") return null;
    if (outcome.priority_ranking.length === 0) return null;

    const sorted = [...outcome.priority_ranking].sort(
      (a, b) => a.rank - b.rank,
    );
    const orderedIssues = sorted.map((e) => e.issue);

    return {
      topPriority: orderedIssues[0] ?? null,
      orderedIssues,
      constraints: outcome.sequencing_constraints,
      followUpRecommended: outcome.follow_up_recommended,
      followUpRationale: outcome.follow_up_rationale,
    };
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const init: RequestInit = {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        signal: controller.signal,
      };

      if (body !== undefined && method !== "GET") {
        init.body = JSON.stringify(body);
      }

      const res = await fetch(url, init);

      if (!res.ok) {
        const text = await res.text().catch(() => "(unreadable)");
        log.warn("Meeting outcome API returned non-2xx", {
          method,
          url,
          status: res.status,
          body: text.slice(0, 200),
        });
        return null;
      }

      return (await res.json()) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("signal")) {
        log.warn("Meeting outcome API timed out", {
          method,
          url,
          timeoutMs: this.timeoutMs,
        });
      } else {
        log.warn("Meeting outcome API request failed", {
          method,
          url,
          error: msg,
        });
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a `MeetingOutcomeClient` pointing at the default meeting-facilitator
 * agent port (3485), or override via the `MEETING_FACILITATOR_URL` environment
 * variable.
 *
 * @example
 *   const client = createMeetingOutcomeClient();
 *   // or, in tests / staging:
 *   const client = createMeetingOutcomeClient('http://localhost:9999');
 */
export function createMeetingOutcomeClient(
  baseUrl?: string,
  opts?: Omit<MeetingOutcomeClientOptions, "baseUrl">,
): MeetingOutcomeClient {
  const resolved =
    baseUrl ?? process.env["MEETING_FACILITATOR_URL"] ?? DEFAULT_BASE_URL;
  return new MeetingOutcomeClient({ ...opts, baseUrl: resolved });
}
