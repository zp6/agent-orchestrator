/**
 * Fork-from dispatch payload protocol — canonical spec (agent-reviewer#454)
 *
 * **NOTE**: This protocol has been extracted into a standalone OSS package:
 * `@nexus-fleet/agent-session-protocol` (https://github.com/rapartlu/agent-session-protocol)
 *
 * For new consumers outside this fleet, import from the npm package:
 * ```
 * npm install @nexus-fleet/agent-session-protocol
 * import { buildForkSpec, parseForkFrom } from '@nexus-fleet/agent-session-protocol';
 * ```
 *
 * This file is maintained for backwards compatibility with in-repo imports.
 * The canonical source of truth is the external package.
 *
 * ## Problem
 *
 * The orchestrator dispatcher currently supports two session modes:
 *   1. **Fresh** — a new Claude Code session is started from scratch.
 *   2. **Resume** — the agent's prior `conversation_id` is reused to continue
 *      an interrupted task in the same session.
 *
 * Neither mode supports **parallel subtask fan-out** — dispatching multiple
 * children that start from a _shared_ context snapshot without interfering with
 * each other or with the originating session.  This gap blocks:
 *
 *   - Fleet Immune System "vaccination": seeding N parallel fix agents with a
 *     pre-warmed failure-pattern context before they start independent work.
 *   - True parallel subtask execution: today's `parent_task_id` fan-out starts
 *     each child cold, losing the parent's accumulated context.
 *   - A/B exploration: running two approaches from the same mid-session state
 *     without workarounds.
 *
 * ## Solution: `fork_from`
 *
 * Add an optional `fork_from` field to the dispatch payload.  When set to a
 * `conversation_id`, the proxy (agent-proxy) clones the warm parent session
 * into a new independent child session before the task prompt is delivered.
 * The new session gets its own `conversation_id`; the parent session is
 * unchanged.
 *
 * ## Spec ownership
 *
 * This file is the **canonical spec** for the `fork_from` protocol.  It is
 * maintained in `rapartlu/agent-reviewer` because the reviewer is the fleet's
 * quality/oversight hub.  Sibling repos MUST import types from this module
 * (via the npm package `claude-orchestrator-reviewer`) rather than re-defining
 * them locally.
 *
 * ## Architecture overview
 *
 * ```
 * Orchestrator dispatcher
 *   └─ dispatch(message, { fork_from: "01KXYZ..." })
 *        │
 *        ├─ Creates task record with fork_from stored in DB
 *        │
 *        └─ AgentClient.send(agentName, message, { forkFrom: "01KXYZ..." })
 *               │
 *               └─ Proxy (agent-proxy) receives HTTP POST
 *                      │
 *                      ├─ Looks up warm session for conversation_id "01KXYZ..."
 *                      ├─ Clones session state → new child session
 *                      └─ Returns new conversation_id "01KABC..." to caller
 *                            │
 *                            └─ Stored as conversation_id on the task record
 * ```
 *
 * ## Session isolation guarantees
 *
 * - Forked sessions are **independent**: writes in one sibling do not affect
 *   other siblings or the parent.
 * - The parent session is **read-only** during the fork operation; no mutation
 *   occurs on it.
 * - If the parent conversation_id is not found (cold or expired), the proxy
 *   falls back to a fresh session and sets `fork_fallback: "cold"` in the
 *   response header.  Callers SHOULD log this but MUST NOT fail.
 *
 * ## Dispatch payload field
 *
 * ```yaml
 * # agents.yaml or orchestrator dispatch call
 * fork_from: "01KXYZ..."   # conversation_id of the warm parent session
 * fork_label: "immune-seed-v1"  # optional human-readable label
 * ```
 *
 * ## Task record storage
 *
 * The `tasks` table gains a `fork_from TEXT` column (nullable).  Its value is
 * the `conversation_id` of the parent session this task was forked from.  When
 * null, the task used a fresh or resumed session (existing behaviour).
 *
 * ## Reviewer impact
 *
 * The reviewer needs to be aware of `fork_from` in two places:
 *
 * 1. **Verifier**: tasks from forked sessions MAY have richer context than
 *    cold-start tasks.  The verifier SHOULD NOT penalise a task for
 *    "assuming prior context" if `fork_from` is set.
 *
 * 2. **PR reviewer**: PRs submitted by forked sessions share a `conversation_id`
 *    prefix with their siblings.  The PR reviewer already handles this via the
 *    existing "forked sessions sharing a common conversation_id prefix" logic
 *    in `pr-reviewer.ts`.  The `fork_from` field makes the lineage explicit.
 *
 * ## Phase gating
 *
 * - **Phase 1 (this PR)**: Protocol spec, types, DB column, verifier awareness.
 *   No live routing changes.  Shadow-mode only — the proxy records fork
 *   requests but always falls back to a fresh session.
 * - **Phase 2**: Proxy implements actual session cloning.  Gate on >80% warm
 *   session hit rate measured in Phase 1 shadow logs.
 * - **Phase 3**: Orchestrator dispatcher uses `fork_from` for immune-system
 *   vaccination when `genome_suggestions` confidence > 60%.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * The `fork_from` sub-object included in a dispatch payload to request a
 * forked session.  When present, the proxy clones the referenced parent
 * session before delivering the task prompt.
 */
export interface DispatchForkSpec {
  /**
   * `conversation_id` of the warm parent session to fork from.
   *
   * The proxy uses this ID to look up the parent Claude Code session and
   * clone its state (tool state, file context, model context window) into a
   * new independent child session.
   *
   * The value MUST be a valid `conversation_id` that was previously assigned
   * to a task by the orchestrator dispatcher.  ULIDs are the canonical format.
   *
   * If the referenced session is not found (expired, not yet warm, or
   * unknown), the proxy falls back to a fresh session.  This fallback is
   * always safe but loses the context benefit of forking.
   */
  conversation_id: string;

  /**
   * Optional human-readable label for operator visibility and log tracing.
   *
   * Well-known values:
   * - `"immune-seed"` — forked from a session pre-warmed with failure-pattern
   *   context (Fleet Immune System use case).
   * - `"parallel-subtask"` — forked as part of a parallel fan-out from a
   *   parent task.
   * - `"ab-exploration"` — forked to explore an alternative approach.
   *
   * Free-form strings are accepted; keep them short (≤32 chars) for dashboards.
   */
  fork_label?: string;
}

/**
 * Extended dispatch options that include the optional `fork_from` spec.
 *
 * Consumers (orchestrator dispatcher, Telegram `/dispatch`) SHOULD extend
 * their existing dispatch option types with this interface rather than
 * re-defining the fields.
 */
export interface DispatchOptionsWithFork {
  /**
   * When set, instructs the proxy to fork the referenced parent session
   * into a new independent child session before delivering the task.
   *
   * The new task's `conversation_id` will be a fresh ULID assigned by
   * the proxy/agent-client — NOT the parent's `conversation_id`.
   *
   * This field is stored verbatim in the `tasks.fork_from` column so
   * operators can trace the lineage of any task.
   */
  fork_from?: DispatchForkSpec;
}

/**
 * Proxy response header / metadata returned after a forked dispatch.
 *
 * The proxy includes this in its HTTP response body (alongside the
 * normal `conversation_id` assignment) so the dispatcher can persist the
 * fork outcome.
 */
export interface ForkDispatchOutcome {
  /**
   * The new `conversation_id` assigned to the forked child session.
   * This is what gets stored in `tasks.conversation_id`.
   */
  conversation_id: string;

  /**
   * Indicates whether the fork succeeded or fell back to a fresh session.
   *
   * - `"forked"` — parent session was found and cloned successfully.
   * - `"cold-fallback"` — parent session was not found; a fresh session
   *   was started.  The `fork_from` label is still persisted for audit.
   */
  fork_status: "forked" | "cold-fallback";

  /**
   * ISO-8601 timestamp when the fork occurred (or the fresh session started).
   */
  forked_at: string;
}

// ── Task type extension ────────────────────────────────────────────────────

/**
 * The `fork_from` field stored on a task record.
 *
 * Null when the task used a fresh session or resumed its own prior session.
 * Non-null when the task was dispatched with a `fork_from` spec.
 *
 * Stored as a JSON string in `tasks.fork_from` (TEXT column) to preserve
 * the full `DispatchForkSpec` including the optional `fork_label`.
 */
export type TaskForkFrom = DispatchForkSpec | null;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse the `fork_from` JSON string from the tasks DB column.
 * Returns null if the value is absent, empty, or unparseable.
 */
export function parseForkFrom(raw: string | null | undefined): TaskForkFrom {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "conversation_id" in parsed &&
      typeof (parsed as { conversation_id: unknown }).conversation_id === "string"
    ) {
      return parsed as DispatchForkSpec;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Serialise a `DispatchForkSpec` to a JSON string for DB storage.
 * Returns null when the spec is undefined/null.
 */
export function serialiseForkFrom(spec: DispatchForkSpec | null | undefined): string | null {
  if (!spec) return null;
  return JSON.stringify(spec);
}

/**
 * Validate that a `fork_from` conversation_id is a syntactically valid ULID.
 *
 * Does NOT verify that the referenced session exists — that check belongs to
 * the proxy.  This is a lightweight pre-dispatch guard to catch obvious typos.
 */
export function isValidForkConversationId(id: string): boolean {
  // ULIDs are 26 chars from Crockford base32 alphabet [0-9A-HJKMNP-TV-Z]
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id);
}

/**
 * Build a `DispatchForkSpec` from a raw conversation_id and optional label.
 * Throws if the conversation_id fails ULID validation.
 */
export function buildForkSpec(
  conversationId: string,
  forkLabel?: string,
): DispatchForkSpec {
  if (!isValidForkConversationId(conversationId)) {
    throw new Error(
      `Invalid fork_from conversation_id "${conversationId}": ` +
      `expected a 26-character ULID (e.g. "01KXYZ0000000000000000000").`,
    );
  }
  const spec: DispatchForkSpec = { conversation_id: conversationId };
  if (forkLabel) {
    spec.fork_label = forkLabel.slice(0, 32); // enforce max label length
  }
  return spec;
}

// ── Verifier awareness ─────────────────────────────────────────────────────

/**
 * Well-known fork labels that the verifier recognises for context-aware scoring.
 *
 * When a task has `fork_from.fork_label` set to one of these values, the
 * verifier adjusts its expectations:
 *
 * - `"immune-seed"`: The task was pre-warmed with failure-pattern context.
 *   The verifier SHOULD give benefit of the doubt if the agent references
 *   prior context without explicitly explaining it — the context was seeded.
 *
 * - `"parallel-subtask"`: The task is one of N parallel siblings.  The
 *   verifier MUST aggregate scores via the parent's `rollup_policy` rather
 *   than evaluating in isolation.
 *
 * - `"ab-exploration"`: Exploratory task; expected to produce a rationale
 *   rather than a shipped implementation.  The verifier uses
 *   `task_type === "research"` scoring criteria regardless of task_type field.
 */
export const KNOWN_FORK_LABELS = [
  "immune-seed",
  "parallel-subtask",
  "ab-exploration",
] as const;

export type KnownForkLabel = (typeof KNOWN_FORK_LABELS)[number];

/**
 * Returns true if a task's fork label should trigger research-mode verification.
 *
 * Used by the verifier to avoid penalising exploratory forked tasks for not
 * having a concrete implementation.
 */
export function isExploratoryFork(forkLabel: string | undefined): boolean {
  return forkLabel === "ab-exploration";
}

// ── DB migration statement ─────────────────────────────────────────────────

/**
 * SQL migration that adds the `fork_from` column to the `tasks` table.
 *
 * This is a TEXT column (nullable) that stores a JSON-serialised
 * `DispatchForkSpec`.  Storing as JSON preserves the optional `fork_label`
 * without requiring an additional column.
 *
 * Apply with:
 *   ```sql
 *   ALTER TABLE tasks ADD COLUMN fork_from TEXT;
 *   ```
 *
 * The migration is idempotent via the `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
 * pattern used in the orchestrator's store.ts; however SQLite does not support
 * `IF NOT EXISTS` in ALTER TABLE.  The store.ts migration runner MUST guard
 * with a `PRAGMA table_info(tasks)` check before applying.
 */
export const FORK_FROM_MIGRATION_SQL =
  "ALTER TABLE tasks ADD COLUMN fork_from TEXT" as const;

/**
 * Column name constant for guards in migration runners.
 * Use `PRAGMA table_info(tasks)` to check if this column already exists
 * before running {@link FORK_FROM_MIGRATION_SQL}.
 */
export const FORK_FROM_COLUMN = "fork_from" as const;
