/**
 * PR guard surge suppressions feed — /pr-guard-surge-suppressions payload (issue #468).
 *
 * Returns all currently active PR guard surge suppression entries so operators
 * can see which (repo, issue) pairs are in a 2-hour dispatch suppression window,
 * and so entries can be inspected by the dashboard or CLI without needing direct
 * DB access.  Suppression entries survive container restarts because they are
 * backed by the `pr_guard_surge_suppressions` table in state.db.
 *
 * Mount in the orchestrator or dashboard server:
 *
 *   app.get('/pr-guard-surge-suppressions', (req, res) => res.json(
 *     getPRGuardSurgeSuppressionsFeedPayload(store, req.query.repo as string | undefined)
 *   ));
 */

export interface PRGuardSurgeSuppressionEntry {
  /** Repository slug in "owner/repo" format. */
  repo: string;
  /** GitHub issue number whose dispatch is suppressed. */
  issueNumber: number;
  /** ISO-8601 timestamp when the suppression expires. */
  suppressedUntil: string;
}

export interface PRGuardSurgeSuppressionsFeedPayload {
  /** ISO-8601 timestamp when this payload was generated. */
  generated_at: string;
  /** Repository filter applied, or null if all repos are included. */
  repo_filter: string | null;
  /** Total number of active suppression entries returned. */
  total: number;
  /** Active suppression entries ordered by suppressed_until ascending. */
  suppressions: PRGuardSurgeSuppressionEntry[];
}

export interface IPRGuardSurgeSuppressionsFeedStore {
  listActivePRGuardSurgeSuppressions(
    repo?: string,
  ): Array<{ repo: string; issueNumber: number; suppressedUntil: string }>;
}

/**
 * Build the `/pr-guard-surge-suppressions` REST payload.
 *
 * Returns all non-expired surge suppression entries from the
 * `pr_guard_surge_suppressions` table, optionally filtered to a specific repo.
 * Entries are ordered by `suppressed_until` ascending so the soonest-expiring
 * entry appears first.
 *
 * @param store       Any store implementing IPRGuardSurgeSuppressionsFeedStore
 * @param repoFilter  Optional "owner/repo" filter; null/undefined = all repos
 */
export function getPRGuardSurgeSuppressionsFeedPayload(
  store: IPRGuardSurgeSuppressionsFeedStore,
  repoFilter?: string,
): PRGuardSurgeSuppressionsFeedPayload {
  const normalizedRepo = repoFilter?.trim() || undefined;
  const suppressions = store.listActivePRGuardSurgeSuppressions(normalizedRepo);

  return {
    generated_at: new Date().toISOString(),
    repo_filter: normalizedRepo ?? null,
    total: suppressions.length,
    suppressions,
  };
}
