# Roadmap — claude-orchestrator-reviewer

_Last updated: 2026-04-15_

## Completed

- **#181 — Triage acceptance criteria schema**: Added `TRIAGE_OUTPUT_SCHEMA`, `TRIAGE_REQUIRED_FIELDS`, `TRIAGE_SYSTEM_PROMPT`, and `Verifier.checkTriageSchemaCompliance()` to `verifier.ts`. Housekeeping/triage tasks now pass through a deterministic JSON schema pre-check (four required fields at 0.25 weight each) before LLM scoring. Missing any single field triggers immediate revision with explicit field names. Adds `"housekeeping"` to `TaskType` and `triage_schema_compliance` to `approvalRationale` known prefixes.
- **#312 — Conflict recovery reroute metrics and alerts**: Added reroute category classification, a dashboard payload for conflict-recovery rates, and a Telegram alert monitor for repeated conflict recoveries.

## Next up

- **#164 — Telegram alert for quality anomaly spikes**: Proactive notification when `getQualityAnomalySummary({ days: 7 }).total` exceeds a threshold (default: 3). One alert per day, deduped. Closes the monitoring gap between the anomaly feed and operator awareness.
- **#149 — Telegram alert when low-quality task is approved**: Per-task alert when `verification_score < 0.65 AND status = 'approved'`. Fires within one daemon cycle; deduped per task. Lets operators intervene before a low-quality PR merges.
- **#168 — Schema contract CI validator**: Validates that `schema-contract.json` stays in sync with `src/state/store.ts` DDL within the same repo. Complements the cross-repo drift check already in `schema-impact.ts`.
- **#155 — Supervisor decision log CLI/Telegram exposure**: Expose the existing `supervisor-log.ts` module via a `/decisions [N]` Telegram command. Lets operators audit why the supervisor skipped or prioritised specific issues without reading raw task titles.
- **#171 — Backfill hard-block rejections for sub-0.50 historical tasks**: One-time idempotent migration setting `verification_status = 'rejected'` for historically approved tasks with `quality_score < 0.50`. Complements the hard-block enforcement added in PR #172.

## Planned

- **#89 — Second-pass outcome tracking**: The borderline second-pass trigger (0.70–0.79) shipped in PR #83, but there is no tracking of whether second passes improve outcomes. Add metric: tasks entering second-pass, upgrade vs. reject rate, and final merged quality scores.
- **#71 — Verification calibration drift — score distribution page**: `calibration-drift.ts` covers alerts; the score distribution histogram (per agent, last 30 days) and false-positive rate view are the remaining UI surface, coordinated with agent-dashboard.
- **#51 — Conflict-risk annotations in PR review comments**: Surface conflict-risk signals inline when a diff touches a file also modified by another open PR. Non-blocking; configurable threshold.

## Ideas

- **Configurable escalation thresholds per agent**: Allow per-agent `feedback_ceiling` and `min_score` overrides in `ReviewerConfig` rather than a single global setting.
- **Improvement detector cron**: Run `ImprovementDetector.analyze()` on a scheduled cadence (every 6 h) and auto-file GitHub issues for detected patterns.
- **Supervisor dry-run mode**: A `--dry-run` flag on `supervisor.ts` that logs dispatch decisions to stdout — useful for debugging the supervision loop in staging.
- **Review score history trending**: Persist `VerificationResult` scores over time so the improvement detector can spot regression trends across deploys.
- **Schema-consumer auto-sync**: After a `schema-contract.json` change ships, auto-open issues in consumer repos listing which columns changed and what queries need updating.
