/**
 * Duplicate Task ID Detector (issue #935)
 *
 * Detects when the same task ID appears more than once within a daemon cycle
 * or is inserted into the state store when a record with that ID already exists.
 * Fires a Telegram alert and logs at WARN level when a collision is detected.
 *
 * Because task IDs are ULIDs (cryptographically unique), genuine collisions are
 * astronomically unlikely — but defensively detecting them protects audit trails
 * and operator trust.  The detector also surfaces any existing duplicates found
 * in the database so the dashboard can flag them visually.
 */

import { createLogger } from "../service/logger.js";
import { notifyOperator } from "../service/notify.js";
import type { StateStore } from "./store.js";

const log = createLogger("duplicate-id-detector");

// ── Types ─────────────────────────────────────────────────────────────────────

/** A pair of tasks that share the same ID. */
export interface DuplicateIdIncident {
  /** The colliding task ID. */
  id: string;
  /** Title of the first task seen with this ID. */
  firstTitle: string;
  /** Title of the second (colliding) task. */
  secondTitle: string;
  /** ISO timestamp when the collision was detected. */
  detectedAt: string;
}

// ── Detector class ────────────────────────────────────────────────────────────

/**
 * Per-cycle duplicate ID detector.
 *
 * Usage:
 *   const detector = new DuplicateIdDetector();
 *   detector.startCycle();
 *   // ... for each task created in the cycle:
 *   detector.recordId(task.id, task.title);
 *   // At end of cycle:
 *   const flagged = detector.getFlaggedIds();
 */
export class DuplicateIdDetector {
  /** Task IDs seen in the current cycle: id → title of first occurrence. */
  private cycleIds = new Map<string, string>();

  /** All incidents detected across cycles (capped at 100 for memory safety). */
  private incidents: DuplicateIdIncident[] = [];

  /** Total collision count for metrics. */
  private totalCollisions = 0;

  /**
   * Optional state store for persisting incidents so the CLI/dashboard can
   * surface a warning icon next to affected task IDs across daemon restarts.
   * Injected via `attachStore()`.
   */
  private store: StateStore | null = null;

  /**
   * Attach the state store so incidents are persisted to `duplicate_id_incidents`
   * in addition to being tracked in memory.  Call once after construction.
   */
  attachStore(store: StateStore): void {
    this.store = store;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Reset the per-cycle tracking set.  Call at the start of each daemon cycle
   * before recording task IDs.
   */
  startCycle(): void {
    this.cycleIds.clear();
  }

  // ── Recording ───────────────────────────────────────────────────────────────

  /**
   * Record a task ID seen in the current cycle.
   *
   * If this ID was already recorded in the current cycle, an incident is logged
   * at WARN level and a Telegram alert is fired (rate-limited per colliding ID).
   *
   * @returns `true` if the ID is new (no collision), `false` if a collision was detected.
   */
  async recordId(id: string, title: string): Promise<boolean> {
    const existing = this.cycleIds.get(id);
    if (existing === undefined) {
      this.cycleIds.set(id, title);
      return true;
    }

    // Collision detected
    await this.handleCollision(id, existing, title);
    return false;
  }

  /**
   * Handle a detected ID collision: log at WARN, fire Telegram alert, record incident.
   */
  async handleCollision(id: string, firstTitle: string, secondTitle: string): Promise<void> {
    this.totalCollisions++;

    const incident: DuplicateIdIncident = {
      id,
      firstTitle,
      secondTitle,
      detectedAt: new Date().toISOString(),
    };

    // Cap incident list at 100 entries
    if (this.incidents.length >= 100) {
      this.incidents.shift();
    }
    this.incidents.push(incident);

    // Persist to state.db so the CLI/dashboard can surface warning icons
    // across daemon restarts.
    if (this.store) {
      try {
        this.store.recordDuplicateIdIncident({ taskId: id, firstTitle, secondTitle });
      } catch (err) {
        log.warn("Failed to persist duplicate-ID incident to store", {
          task_id: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.warn("Duplicate task ID detected", {
      task_id: id,
      first_title: firstTitle,
      second_title: secondTitle,
    });

    console.warn(
      `⚠  Duplicate task ID detected: ${id}\n` +
      `   First:  "${firstTitle}"\n` +
      `   Second: "${secondTitle}"`,
    );

    await notifyOperator(
      "⚠️ Duplicate Task ID Detected",
      `Task ID \`${id}\` was inserted twice in the same daemon cycle.\n\n` +
      `• First:  "${firstTitle}"\n` +
      `• Second: "${secondTitle}"\n\n` +
      `Audit trails may be corrupted. Check the ULID generator and state store logs immediately.`,
      "warning",
      `duplicate-task-id:${id}`,
    );
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  /**
   * Return all task IDs that collided in the current cycle.
   * Used by the dashboard to visually flag duplicate IDs.
   */
  getFlaggedIds(): ReadonlySet<string> {
    const flagged = new Set<string>();
    for (const incident of this.incidents) {
      flagged.add(incident.id);
    }
    return flagged;
  }

  /** Return the full list of recorded incidents, most recent first. */
  getIncidents(): readonly DuplicateIdIncident[] {
    return [...this.incidents].reverse();
  }

  /** Total number of collisions detected since the detector was created. */
  getTotalCollisions(): number {
    return this.totalCollisions;
  }
}

// ── Standalone DB scanner ─────────────────────────────────────────────────────

/**
 * Run the DB scan via `StateStore.getDuplicateTaskIds()` and fire a Telegram
 * alert if any duplicates are found.  Intended to be called once at daemon startup.
 *
 * @param store - The daemon's StateStore instance.
 * @returns Array of duplicate task ID strings (empty if DB is healthy).
 */
export async function checkDbForDuplicateIds(store: StateStore): Promise<string[]> {
  let duplicates: string[];
  try {
    duplicates = store.getDuplicateTaskIds();
  } catch (err) {
    log.warn("Failed to scan DB for duplicate task IDs at startup", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (duplicates.length === 0) return [];

  log.warn("Duplicate task IDs found in database at startup", {
    count: duplicates.length,
    ids: duplicates,
  });

  await notifyOperator(
    "🚨 Duplicate Task IDs in Database",
    `Found ${duplicates.length} duplicate task ID(s) in state.db at startup:\n\n` +
    duplicates.map((id) => `• \`${id}\``).join("\n") +
    `\n\nAudit trails are corrupted. Immediate investigation required.`,
    "critical",
    "duplicate-task-ids-startup",
  );

  return duplicates;
}
