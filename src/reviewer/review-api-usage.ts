/**
 * Review API — Usage tracking
 *
 * Records each API review call in the `review_api_usage` table so that billing
 * tier limits can be enforced and revenue can be reported.
 *
 * Schema (DDL emitted by ensureReviewApiUsageTable()):
 *
 *   CREATE TABLE IF NOT EXISTS review_api_usage (
 *     id          INTEGER PRIMARY KEY AUTOINCREMENT,
 *     client_id   TEXT NOT NULL,           -- stable identifier (from API key)
 *     tier        TEXT NOT NULL,           -- 'free' | 'basic' | 'pro'
 *     pr_url      TEXT,                    -- PR URL submitted for review
 *     repo        TEXT,                    -- owner/repo derived from pr_url
 *     review_type TEXT NOT NULL,           -- 'basic' | 'deep'
 *     score       REAL,                    -- quality score (null on free tier)
 *     duration_ms INTEGER,                 -- wall-clock review latency
 *     created_at  TEXT NOT NULL            -- ISO-8601 UTC timestamp
 *   )
 */

import Database from "better-sqlite3";

export interface ReviewApiUsageRecord {
  id?: number;
  client_id: string;
  tier: string;
  pr_url?: string | null;
  repo?: string | null;
  review_type: "basic" | "deep";
  score?: number | null;
  duration_ms?: number | null;
  created_at: string;
}

export interface MonthlyUsageSummary {
  client_id: string;
  tier: string;
  month: string; // "YYYY-MM"
  count: number;
  avg_score: number | null;
  total_duration_ms: number | null;
}

/**
 * Ensure the `review_api_usage` table exists in the given database.
 * Safe to call on every startup — uses CREATE TABLE IF NOT EXISTS.
 */
export function ensureReviewApiUsageTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_api_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   TEXT    NOT NULL,
      tier        TEXT    NOT NULL,
      pr_url      TEXT,
      repo        TEXT,
      review_type TEXT    NOT NULL DEFAULT 'basic',
      score       REAL,
      duration_ms INTEGER,
      created_at  TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_api_usage_client_month
      ON review_api_usage (client_id, substr(created_at, 1, 7));
  `);
}

/**
 * Insert a completed review record.
 */
export function recordReviewUsage(
  db: Database.Database,
  record: Omit<ReviewApiUsageRecord, "id">
): void {
  db.prepare(`
    INSERT INTO review_api_usage
      (client_id, tier, pr_url, repo, review_type, score, duration_ms, created_at)
    VALUES
      (@client_id, @tier, @pr_url, @repo, @review_type, @score, @duration_ms, @created_at)
  `).run(record);
}

/**
 * Return the number of reviews this calendar month for a given client.
 * Month is determined by the first 7 chars of created_at ("YYYY-MM").
 */
export function getMonthlyUsageCount(
  db: Database.Database,
  clientId: string,
  yearMonth?: string // defaults to current month "YYYY-MM"
): number {
  const month = yearMonth ?? new Date().toISOString().slice(0, 7);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt
         FROM review_api_usage
        WHERE client_id = ?
          AND substr(created_at, 1, 7) = ?`
    )
    .get(clientId, month) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * Return per-month usage aggregates for a given client (most recent 3 months).
 */
export function getClientUsageHistory(
  db: Database.Database,
  clientId: string,
  limitMonths = 3
): MonthlyUsageSummary[] {
  const rows = db
    .prepare(
      `SELECT
          client_id,
          tier,
          substr(created_at, 1, 7) AS month,
          COUNT(*)                 AS count,
          AVG(score)               AS avg_score,
          SUM(duration_ms)         AS total_duration_ms
        FROM review_api_usage
       WHERE client_id = ?
       GROUP BY client_id, tier, substr(created_at, 1, 7)
       ORDER BY month DESC
       LIMIT ?`
    )
    .all(clientId, limitMonths) as MonthlyUsageSummary[];
  return rows;
}

/**
 * Return fleet-wide usage stats across all clients for a given month.
 * Used by `orch review-api stats` and the revenue log.
 */
export function getFleetUsageStats(
  db: Database.Database,
  yearMonth?: string
): { tier: string; count: number; clients: number }[] {
  const month = yearMonth ?? new Date().toISOString().slice(0, 7);
  const rows = db
    .prepare(
      `SELECT
          tier,
          COUNT(*)           AS count,
          COUNT(DISTINCT client_id) AS clients
        FROM review_api_usage
       WHERE substr(created_at, 1, 7) = ?
       GROUP BY tier
       ORDER BY count DESC`
    )
    .all(month) as { tier: string; count: number; clients: number }[];
  return rows;
}
