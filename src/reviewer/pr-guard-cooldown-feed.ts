/**
 * PR guard cooldown feed — /api/pr-guard-cooldowns payload (issue #420).
 *
 * Returns all currently active PR guard cooldowns so operators can see which
 * issues are in the 60-minute suppression window, and so the orchestrator
 * dispatcher can pre-filter a dispatch batch in one DB call.
 *
 * Mount in the orchestrator or dashboard server:
 *   app.get('/api/pr-guard-cooldowns', (req, res) => res.json(
 *     getPRGuardCooldownFeedPayload(store, req.query.repo as string | undefined)
 *   ));
 */

export interface PRGuardCooldownEntry {
  repo: string;
  issueNumber: number;
  expiresAt: string;
}

export interface PRGuardCooldownFeedPayload {
  generated_at: string;
  repo_filter: string | null;
  total: number;
  cooldowns: PRGuardCooldownEntry[];
}

export interface IPRGuardCooldownFeedStore {
  listActivePRGuardCooldowns(repo?: string): Array<{ repo: string; issueNumber: number; expiresAt: string }>;
}

/**
 * Build the `/api/pr-guard-cooldowns` REST payload.
 *
 * Returns all non-expired PR guard cooldown entries, optionally filtered to a
 * specific repo.  Callers can use this to pre-filter an entire dispatch batch
 * in a single DB round-trip instead of calling `isPRGuardCooldownActive()`
 * per issue.
 *
 * @param store       Any store implementing IPRGuardCooldownFeedStore
 * @param repoFilter  Optional "owner/repo" filter; null/undefined = all repos
 */
export function getPRGuardCooldownFeedPayload(
  store: IPRGuardCooldownFeedStore,
  repoFilter?: string,
): PRGuardCooldownFeedPayload {
  const normalizedRepo = repoFilter?.trim() || undefined;
  const cooldowns = store.listActivePRGuardCooldowns(normalizedRepo);

  return {
    generated_at: new Date().toISOString(),
    repo_filter: normalizedRepo ?? null,
    total: cooldowns.length,
    cooldowns,
  };
}
