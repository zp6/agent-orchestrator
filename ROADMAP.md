# Roadmap — claude-orchestrator-reviewer

_Last updated: 2026-04-18_

## Completed (recent)

- **#149 / PR #159** — Telegram alert when low-quality task is approved (`LOW_QUALITY_ALERT_THRESHOLD = 0.65`, deduped per task)
- **#205 / PR #207** — Reconciliation outcomes exposed via Telegram `/reconciliation` command and `reconciliation_events` table
- **#210 / PR #211** — Audit and fix historically approved tasks with `quality_score < 0.50` via `fixApprovedTasksBelowThreshold()` and `/audit-scores` CLI
- **#215 / PR #216** — Per-agent routing confidence in Telegram `/routing [days]` with 🟢/🟡/🔴 badges
- **#212 / PR #219** — `quality_score` always populated on approved tasks via `ensureScoresPopulated()` daemon hook
- **#229 / PR #230** — Score backfill extended to rejected tasks; `getVerifiedTasksWithNullScores()` covers full verified set
- **#258 / PR #260** — Hard score floor: `quality_score < 0.60` blocked at store write path (`SUB_THRESHOLD_REJECTION_LIMIT`)
- **#181** — Triage acceptance criteria schema: `TRIAGE_OUTPUT_SCHEMA`, `TRIAGE_REQUIRED_FIELDS`, housekeeping pre-check gate
- **#312** — Conflict recovery reroute metrics and Telegram alerts

## Next up

1. **#266 — Hard score floor bypasses** _(high)_ — PR #260 closed one path but the orchestrator still observes sub-0.60 approvals. Audit marginal-approval, already-in-review short-circuit, and multi-repo coordinator paths for remaining bypasses.

2. **#232 — Quality scores missing from task feed** _(high)_ — Despite `ensureScoresPopulated()` and backfill commands, 20 recent tasks still show `quality_score: null`. Need a startup/daemon check that warns when >10% of recent approved tasks have null scores.

3. **#221 — Improvement detector deduplication** _(medium)_ — `ImprovementDetector` creates GitHub issues without checking for existing open duplicates. Add a `gh issue list` pre-check before filing to prevent backlog spam.

4. **#189 — PR-feedback task scoring model** _(medium)_ — PR-feedback tasks receive null scores because no `PR_FEEDBACK_SYSTEM_PROMPT` exists. Add scoring on three dimensions: correctness, completeness, approval-bias adherence.

5. **#222 — `/help` Telegram command** _(low)_ — List all bot commands with one-line descriptions so operators can self-serve without reading docs.

## Planned

- **#89 — Second-pass outcome tracking**: Record whether borderline (0.70–0.79) second-pass reviews improve final outcomes. Metric: upgrade rate, reject rate, merged quality delta.
- **#71 — Calibration drift score distribution**: `calibration-drift.ts` covers alerts; the histogram (per agent, last 30 days) and false-positive rate view still need the dashboard surface.
- **#231 — Healthcheck start_period**: Add Docker `start_period` to prevent premature unhealthy states during cold-start. Note: 3 automated retries failed — may require manual investigation of the agent container setup.

## Ideas

- **Configurable escalation thresholds per agent**: Per-agent `feedback_ceiling` and `min_score` overrides in `ReviewerConfig` rather than a single global setting.
- **Improvement detector cron**: Run `ImprovementDetector.analyze()` on a scheduled cadence (every 6 h) and auto-file issues only for novel patterns not in the open backlog.
- **Supervisor dry-run mode**: A `--dry-run` flag for logging dispatch decisions to stdout — useful for debugging in staging.
- **Schema-consumer auto-sync**: After a `schema-contract.json` change ships, auto-open issues in consumer repos listing impacted columns.
- **Review score history trending**: Persist `VerificationResult` scores over time so the improvement detector can spot regression trends across deploys.
