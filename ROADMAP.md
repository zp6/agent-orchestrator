# Roadmap — claude-orchestrator-reviewer

_Last updated: 2026-04-18 (triage cycle 3)_

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
- **#310 / PR #313** — `severity` + `category` metadata emitted on `request-changes` decisions for richer alert context

## Next up

1. **#292 — Quality floor bypass transparency** _(high)_ — Show operators *why* a sub-0.60 task was approved (marginal bypass, already-in-review, coordinator path). Essential for auditing the floor's actual effectiveness.

2. **#285 — Approved-below-floor Telegram alert with per-task breakdown** _(high)_ — Alert when a task scores below 0.60 but is still approved, with a breakdown of which bypass path fired.

3. **#232 — Quality scores missing from task feed** _(high)_ — Despite `ensureScoresPopulated()` and backfill commands, recent tasks still show `quality_score: null`. Need a startup/daemon check that warns when >10% of recent approved tasks have null scores.

4. **#278 — Dashboard panel: approved-but-low-score task feed** _(medium)_ — Surface the full list of below-floor approved tasks in the dashboard so operators can spot patterns without querying SQLite directly.

5. **#298 — Quality score credibility: bypass rate trending** _(medium)_ — Track bypass rate over time so operators can see whether the floor is becoming less effective (e.g., marginal-approval overuse creeping up).

## Planned

- **#221 — Improvement detector deduplication** _(medium)_ — `ImprovementDetector` creates GitHub issues without checking for existing open duplicates. Add a `gh issue list` pre-check before filing to prevent backlog spam.
- **#189 — PR-feedback task scoring model** _(medium)_ — PR-feedback tasks receive null scores because no `PR_FEEDBACK_SYSTEM_PROMPT` exists. Add scoring on three dimensions: correctness, completeness, approval-bias adherence.
- **#222 — `/help` Telegram command** _(low)_ — List all bot commands with one-line descriptions so operators can self-serve without reading docs.
- **#89 — Second-pass outcome tracking**: Record whether borderline (0.70–0.79) second-pass reviews improve final outcomes. Metric: upgrade rate, reject rate, merged quality delta.
- **#71 — Calibration drift score distribution**: `calibration-drift.ts` covers alerts; the histogram (per agent, last 30 days) and false-positive rate view still need the dashboard surface.

## Ideas

- **Configurable escalation thresholds per agent**: Per-agent `feedback_ceiling` and `min_score` overrides in `ReviewerConfig` rather than a single global setting.
- **Improvement detector cron**: Run `ImprovementDetector.analyze()` on a scheduled cadence (every 6 h) and auto-file issues only for novel patterns not in the open backlog.
- **Supervisor dry-run mode**: A `--dry-run` flag for logging dispatch decisions to stdout — useful for debugging in staging.
- **Schema-consumer auto-sync**: After a `schema-contract.json` change ships, auto-open issues in consumer repos listing impacted columns.
- **Review score history trending**: Persist `VerificationResult` scores over time so the improvement detector can spot regression trends across deploys.

## Triage notes

- **2026-04-18 cycle 3**: Closed #231 (healthcheck — misrouted, belongs to infra/proxy, 3 retries exhausted). Closed orphan PR #305 (no `Closes #N`). Added 5 missing `src/reviewer/` modules to CLAUDE.md. Quality-floor cluster (#278, #285, #292, #298) confirmed distinct: each covers a different channel or data layer — no duplicates. No issues > 14 days old.
