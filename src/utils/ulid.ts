/**
 * Monotonic ULID generator (issue #966).
 *
 * The bare `ulid()` function from the "ulid" package calls `Date.now()` on
 * every invocation and re-randomises the 80-bit random suffix each time.
 * When the daemon dispatches a batch of tasks in rapid succession — e.g.
 * three housekeeping follow-ups within the same millisecond — the random
 * suffix is the only differentiator. Under adversarial PRNG conditions or
 * a frozen clock, distinct calls can produce the same ULID, silently
 * overwriting or conflicting with earlier records in state.db.
 *
 * `monotonicFactory()` from the same package solves this: a single shared
 * factory instance increments the least-significant bit of the random
 * component when the wall-clock millisecond has not advanced since the
 * previous call. This guarantees both strict uniqueness and lexicographic
 * monotonicity across concurrent batch inserts, without sacrificing the
 * time-ordered properties that make ULIDs useful for pagination and audit.
 *
 * Usage:
 *   import { generateId } from "../utils/ulid.js";
 *   const id = generateId(); // always unique, even if Date.now() is frozen
 */

import { monotonicFactory } from "ulid";

/**
 * Module-level monotonic ULID factory. Shared across all callers within the
 * same process so that the monotonic counter is effective across rapid
 * successive calls (e.g. batch task dispatch).
 *
 * @internal — callers should use `generateId()` rather than this directly.
 */
const _factory = monotonicFactory();

/**
 * Generate a unique, time-ordered ULID.
 *
 * When called multiple times within the same millisecond (batch dispatch),
 * the generator increments the random component monotonically rather than
 * re-randomising it, guaranteeing that no two calls ever return the same ID.
 */
export function generateId(): string {
  return _factory();
}
