/**
 * Semantic Task Memory — Daily Digest (issue #369)
 *
 * Generates a daily Telegram digest summarizing the knowledge captured in the
 * semantic task memory index.  The digest fires once per day at the configured
 * hour (default: 09:00 UTC) and contains three sections:
 *
 *   1. Top 5 most-queried topics in the memory index over the past 7 days.
 *   2. Top 3 topics where tasks were re-attempted 2+ times (memory not preventing
 *      repeated work).
 *   3. Topics where ALL recorded attempts scored below 0.70 (persistent low-
 *      confidence areas that need operator attention).
 *
 * Operators can also reply with `/memory expand <topic>` to see the full indexed
 * entries for any topic.
 *
 * The last-sent timestamp is persisted in `system_flags` so the digest survives
 * process restarts without resending.
 *
 * Usage (from the daemon):
 *
 *   import { MemoryDigestScheduler } from './reviewer/memory-digest.js';
 *   const scheduler = new MemoryDigestScheduler(store, notifier);
 *   // Call once per poll cycle:
 *   await scheduler.maybeFireDigest();
 */

import { createLogger } from "../service/logger.js";
import type { Notifier } from "../notify.js";
import type { ISemanticMemoryStore, SemanticMemoryDigestReport } from "../state/types.js";

const log = createLogger("memory-digest");

/** System-flag key storing the ISO timestamp of the last digest send. */
const FLAG_LAST_DIGEST_SENT = "semantic_memory_digest_last_sent";

/** Low-confidence threshold — topics where ALL attempts score below this. */
export const LOW_CONFIDENCE_THRESHOLD = 0.70;

/** Lookback window for "top queried topics". */
export const DIGEST_LOOKBACK_DAYS = 7;

/** How many items to include per section. */
export const DIGEST_TOP_QUERIED_LIMIT = 5;
export const DIGEST_REPEATED_LIMIT = 3;
export const DIGEST_LOW_CONFIDENCE_LIMIT = 5;

/**
 * Format a SemanticMemoryDigestReport as a Telegram Markdown message.
 */
export function formatMemoryDigest(report: SemanticMemoryDigestReport): string {
  const lines: string[] = [
    `🧠 *Semantic Task Memory — Daily Digest*`,
    `_${new Date(report.generated_at).toUTCString()}_`,
    ``,
  ];

  // ── Section 1: Top queried topics ──────────────────────────────────────
  lines.push(`*📊 Top Queried Topics (last 7 days)*`);
  if (report.top_queried_topics.length === 0) {
    lines.push(`_No queried topics in the past ${DIGEST_LOOKBACK_DAYS} days._`);
  } else {
    for (let i = 0; i < report.top_queried_topics.length; i++) {
      const t = report.top_queried_topics[i];
      lines.push(
        `${i + 1}. \`${t.topic}\` — ${t.query_count} queries, avg confidence ${(t.avg_confidence * 100).toFixed(0)}%`,
      );
      if (t.example_task_ids.length > 0) {
        lines.push(`   Tasks: ${t.example_task_ids.slice(0, 3).map((id) => `\`${id.slice(0, 8)}\``).join(", ")}`);
      }
    }
  }

  lines.push(``);

  // ── Section 2: Re-attempted topics ─────────────────────────────────────
  lines.push(`*🔁 Re-attempted Topics (2+ attempts, memory not preventing repeat work)*`);
  if (report.repeated_attempt_topics.length === 0) {
    lines.push(`_No topics with repeated attempts detected._`);
  } else {
    for (let i = 0; i < report.repeated_attempt_topics.length; i++) {
      const t = report.repeated_attempt_topics[i];
      lines.push(
        `${i + 1}. \`${t.topic}\` — ${t.attempt_count} attempts, best score ${(t.best_score * 100).toFixed(0)}%`,
      );
      if (t.task_ids.length > 0) {
        lines.push(`   Tasks: ${t.task_ids.slice(0, 3).map((id) => `\`${id.slice(0, 8)}\``).join(", ")}`);
      }
    }
  }

  lines.push(``);

  // ── Section 3: Persistent low-confidence areas ─────────────────────────
  lines.push(`*⚠️ Persistent Low-Confidence Areas (all attempts < ${(LOW_CONFIDENCE_THRESHOLD * 100).toFixed(0)}%)*`);
  if (report.low_confidence_topics.length === 0) {
    lines.push(`_No persistent low-confidence areas. 🎉_`);
  } else {
    for (let i = 0; i < report.low_confidence_topics.length; i++) {
      const t = report.low_confidence_topics[i];
      lines.push(
        `${i + 1}. \`${t.topic}\` — ${t.attempt_count} attempt${t.attempt_count !== 1 ? "s" : ""}, max score ${(t.max_score * 100).toFixed(0)}%`,
      );
      if (t.task_ids.length > 0) {
        lines.push(`   Tasks: ${t.task_ids.slice(0, 3).map((id) => `\`${id.slice(0, 8)}\``).join(", ")}`);
      }
    }
  }

  lines.push(``);
  lines.push(`_Reply \`/memory expand <topic>\` to see full entries for any topic._`);

  return lines.join("\n");
}

/**
 * Build a MemoryDigestReport from the live database.
 *
 * @param store  Must implement ISemanticMemoryStore.
 */
export function buildMemoryDigest(store: ISemanticMemoryStore): SemanticMemoryDigestReport {
  const sinceDate = new Date(Date.now() - DIGEST_LOOKBACK_DAYS * 86_400_000).toISOString();

  return {
    generated_at: new Date().toISOString(),
    top_queried_topics: store.getTopMemoryTopics(DIGEST_TOP_QUERIED_LIMIT, sinceDate),
    repeated_attempt_topics: store.getRepeatedAttemptTopics(DIGEST_REPEATED_LIMIT),
    low_confidence_topics: store.getLowConfidenceTopics(LOW_CONFIDENCE_THRESHOLD, DIGEST_LOW_CONFIDENCE_LIMIT),
  };
}

/**
 * Manages the daily digest schedule.  Persists the last-sent timestamp in the
 * system_flags table so the schedule survives restarts.
 *
 * Default: fires once per day at 09:00 UTC.
 */
export class MemoryDigestScheduler {
  private store: ISemanticMemoryStore & {
    getSystemFlag(key: string): string | null;
    setSystemFlag(key: string, value: string): void;
  };
  private notifier: Notifier;
  /** Hour of day (UTC) at which to fire the digest. */
  private digestHourUtc: number;

  constructor(
    store: ISemanticMemoryStore & {
      getSystemFlag(key: string): string | null;
      setSystemFlag(key: string, value: string): void;
    },
    notifier: Notifier,
    opts: { digestHourUtc?: number } = {},
  ) {
    this.store = store;
    this.notifier = notifier;
    this.digestHourUtc = opts.digestHourUtc ?? 9;
  }

  /**
   * Called once per daemon poll cycle.  Fires the digest if:
   *  - The current UTC hour matches `digestHourUtc`, and
   *  - The digest has not already been sent today (calendar date in UTC).
   *
   * @returns true if the digest was sent, false if skipped.
   */
  async maybeFireDigest(): Promise<boolean> {
    const now = new Date();
    const currentHourUtc = now.getUTCHours();
    if (currentHourUtc !== this.digestHourUtc) return false;

    const todayUtc = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const lastSent = this.store.getSystemFlag(FLAG_LAST_DIGEST_SENT);

    // Already sent today
    if (lastSent && lastSent >= todayUtc) return false;

    try {
      const report = buildMemoryDigest(this.store);
      const message = formatMemoryDigest(report);
      await this.notifier.send(message);

      this.store.setSystemFlag(FLAG_LAST_DIGEST_SENT, todayUtc);
      log.info("Memory digest sent", {
        topQueried: report.top_queried_topics.length,
        repeated: report.repeated_attempt_topics.length,
        lowConfidence: report.low_confidence_topics.length,
      });
      return true;
    } catch (err) {
      log.error("Failed to send memory digest", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
