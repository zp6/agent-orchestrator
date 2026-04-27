# Roadmap - agent-orchestrator

_Last updated: 2026-04-27 (triage pass)_

## Completed recently

- Linear support is now present in the tree: `src/client/linear-client.ts`, `src/triggers/linear.ts`, and the corresponding package exports.
- Quality-summary reporting is live in `src/reviewer/quality-summary.ts`, with the `/quality-summary` Telegram command wired into the command handler.
- Score provenance tracking is live in the codebase: `score_source` tagging, `shouldBlockDefaultFallbackApproval()`, and `/api/score-provenance/:task_id`.
- Persistent anomaly tracking is wired up: `score_anomaly_observations`, `getPersistentAnomalies()`, and `/api/persistent-anomalies`.
- Calibration recommendations persistence exists: `calibration_recommendations` storage plus review/resolve helpers.
- Meeting synthesis and meeting-outcome helpers are in place: meeting synthesis persistence, `MeetingOutcomeClient`, and `MeetingPriorityDispatcher`.

## Top 5 priorities

1. **#1232 - trigger-dispatcher re-dispatch bug** _(high)_ - `markProcessed()` is being called on the already-in-review skip path, which can block a later re-dispatch after the PR is closed or rejected. Fix this first because it directly affects recovery from stale PRs.
2. **#1166 - PR guard surge suppression flood** _(high)_ - enqueue-time suppression is still letting large `already-in-review` bursts create too many duplicate tasks. Move the guard earlier so floods are dropped before dispatch work is queued.
3. **#1096 - blocked issue backlog not cleared on merge** _(high)_ - merged PRs are not removing resolved blocked issues from the next dispatch cycle when the PR body already closes them.
4. **#1040 - CI failing on main** _(high)_ - main is currently red, which blocks confidence in every follow-up change.
5. **#1223 - Linear as second issue tracker** _(high)_ - finish the Linear integration so the fleet can split long-horizon work from GitHub triage instead of forcing everything through one queue.

## Notes

- Open issues scanned: 18
- Duplicate issues found: 0
- Stale issues found: 0
- Open PRs found: 0
- Oldest open issue: #869, created 2026-04-15, still inside the 14-day stale window

## Triage log

- 2026-04-27: No duplicates or stale issues needed action. No orphan PRs were open. Updated the roadmap to reflect the current backlog and recent shipped Linear / quality-summary / score-provenance / anomaly-tracking work.
