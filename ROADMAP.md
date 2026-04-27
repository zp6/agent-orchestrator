# Roadmap - agent-orchestrator

_Last updated: 2026-04-27 (triage pass)_

## Completed recently

- Linear support is present in the tree: `src/client/linear-client.ts`, `src/triggers/linear.ts`, and the corresponding package exports.
- Quality-summary reporting is live in `src/reviewer/quality-summary.ts`, with the `/quality-summary` Telegram command wired into the command handler.
- Score provenance tracking is live in the codebase: `score_source` tagging, `shouldBlockDefaultFallbackApproval()`, and `/api/score-provenance/:task_id`.
- Persistent anomaly tracking is wired up: `score_anomaly_observations`, `getPersistentAnomalies()`, and `/api/persistent-anomalies`.
- Meeting synthesis persistence and meeting-outcome helpers are in place: meeting synthesis storage, `MeetingOutcomeClient`, and `MeetingPriorityDispatcher`.

## Top 5 priorities

1. **#1232 - trigger-dispatcher re-dispatch bug** _(high)_ - `markProcessed()` is being called on the already-in-review skip path, which can block a later re-dispatch after the PR is closed or rejected.
2. **#1166 - PR guard surge suppression flood** _(high)_ - enqueue-time suppression is still letting large `already-in-review` bursts create too many duplicate tasks; move the guard earlier so floods are dropped before dispatch work is queued.
3. **#1096 - blocked issue backlog not cleared on merge** _(high)_ - merged PRs are not removing resolved blocked issues from the next dispatch cycle when the PR body already closes them.
4. **#1040 - CI failing on main** _(high)_ - main is red, which blocks confidence in every follow-up change.
5. **#1251 - dispatch prompts need hard scope enforcement** _(high)_ - the orchestrator agent is ignoring explicit hard constraints, so scope-contract validation and a freshness check need to happen before PR creation.

## Notes

- Open issues scanned: 19
- Duplicate issues found: 0
- Stale issues found: 0
- Open PRs found: 0
- Oldest open issue: #869, created 2026-04-15, still inside the 14-day stale window
- Secondary active items: #1228 still needs its measured baseline snapshot, and #1223 should be verified/closed now that Linear support is present in the tree

## Triage log

- 2026-04-27: No duplicates or stale issues needed action. No orphan PRs were open. Updated the roadmap to reflect the current backlog, the Linear support already in tree, and the most urgent blocking bugs and scope-control work.
