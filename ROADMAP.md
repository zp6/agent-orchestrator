# Roadmap — claude-orchestrator-reviewer

_Last updated: 2026-04-19 (triage cycle 5)_

## Completed (recent)

- **#331 / PR #332** — Real-time Telegram alerts for low-score approvals (`low-score-approval-alerter.ts`)
- **#325 / PR #327** — Capability-check to reject foreign implementation tasks (`capability-check.ts`, `pre-dispatch-capability-enforcer.ts`)
- **#278 / PR #328** — Dashboard panel: approved-but-low-score task feed (`low-score-feed.ts`)
- **#326 / PR #329** — Cap cross-repo follow-up issues to 1 per PR review cycle
- **#330 / PR #333** — Reviewer routing boundary enforcement (pre-dispatch)
- **#336 / PR #342** — Cross-agent in-flight duplicate dispatch guard (`cross-agent-inflight-guard.ts`)
- **#344 / PR #345** — Dispatch cascade analyzer for supervisor visibility (`dispatch-cascade-analyzer.ts`)
- **#335 / PR #348** — Proactive rebase scheduler (`proactive-rebase-scheduler.ts`)
- **#358 / PR #361** — PR scope pre-flight check (`pr-scope-checker.ts`)
- **#357 / PR #362** — Meta-quality gate: stricter floor for quality-enforcement tasks (`meta-quality-gate.ts`)
- **#356 / PR #363** — Score-bypass violation report page API payload (`score-violations.ts`)
- **#367 / PR #372** — Quality floor bypass detector (`quality-floor-bypass-detector.ts`)
- **#369 / PR #370** — Semantic task memory: daily digest + `/memory` Telegram command (`memory-digest.ts`)
- **#366 / PR #373** — PRAGMA foreign_keys=ON + startup integrity check
- **#374 / PR #376** — Proposal-tag dispatch routing with dedicated verification

## Next up

1. **#375 — Real-time Telegram alert when a score-0 task is approved** _(high)_ — A separate, higher-urgency alert distinct from the general low-score alerter. Score-0 indicates catastrophic failure and warrants an immediate, dedicated notification with full dimension breakdown.

2. **#359 — Daily agent quality digest with degradation callouts** _(high)_ — Scheduled Telegram message summarising each agent's 24-hour score average, trend direction, and flagging any agent that degraded >10% day-over-day.

3. **#232 — Quality scores missing from task feed** _(high)_ — Despite `ensureScoresPopulated()` and backfill commands, recent tasks still show `quality_score: null`. Need a startup/daemon check that warns when >10% of recent approved tasks have null scores.

4. **#368 — Auto-file GitHub issues for improvements identified across 3+ consecutive batches** _(medium)_ — `ImprovementRecurrenceTracker` that records patterns by normalized title hash across distinct batches and auto-files a `chronic` + `improvement` tagged issue when threshold is reached.

5. **#221 — Improvement detector deduplication against existing GitHub issues** _(medium)_ — `ImprovementDetector` creates GitHub issues without checking for existing open duplicates. Add `gh issue list` pre-check with title-similarity filter before filing.

## Planned

- **#364 — Hard quality floor with mandatory override audit trail** _(high)_ — Hard floor at 0.10 blocking sub-floor approvals; Telegram escalation with `/approve-override` and `/reject-override`; `score_floor_overrides` audit table.
- **#340 — Persist proactive rebase stats to SQLite** _(medium)_ — `rebase_events` table, `IRebaseStore` interface, `/rebase-stats` Telegram command, and `/rebase-stats` HTTP endpoint for dashboard.
- **#222 — `/help` Telegram command** _(medium)_ — List all 20+ bot commands with one-line descriptions so operators can self-serve during incidents without reading source code.
- **#189 — PR-feedback task scoring model** _(medium)_ — PR-feedback tasks receive null scores because no `PR_FEEDBACK_SYSTEM_PROMPT` exists. Add scoring on three dimensions: correctness, completeness, approval-bias adherence.
- **#89 — Second-pass outcome tracking** _(low)_ — Record whether borderline (0.70–0.79) second-pass reviews improve final outcomes. Metric: upgrade rate, reject rate, merged quality delta.

## Ideas

- **Configurable escalation thresholds per agent**: Per-agent `feedback_ceiling` and `min_score` overrides in `ReviewerConfig` rather than a single global setting.
- **Improvement detector cron**: Run `ImprovementDetector.analyze()` on a scheduled cadence (every 6 h) and auto-file issues only for novel patterns not in the open backlog.
- **Supervisor dry-run mode**: A `--dry-run` flag for logging dispatch decisions to stdout — useful for debugging in staging.
- **Schema-consumer auto-sync**: After a `schema-contract.json` change ships, auto-open issues in consumer repos listing impacted columns.
- **Review score history trending**: Persist `VerificationResult` scores over time so the improvement detector can spot regression trends across deploys.

## Triage notes

- **2026-04-19 cycle 5**: Closed #351 (CLAUDE.md update delivered in this triage PR). Closed #353 (unclear/no actionable reviewer changes specified). Added 11 missing `src/reviewer/` modules to CLAUDE.md source layout; added 13 scope entries for recently shipped features. Moved completed items (#278, #285, #292, #325–#376 batch) from Next-up to Completed. Promoted #375 and #359 to Next-up (1, 2). Confirmed #364 and #340 (PRs closed unmerged) remain valid backlog items. No duplicate issues. No stale issues (all open issues are ≤ 3 days old).
- **2026-04-19 cycle 4**: Closed #315 (CLAUDE.md sync already done in PR #316). Closed #298 (bypass rate trending fully implemented by `quality-system-health.ts` in PR #306). No stale issues (oldest open are #71 and #89, both 7 days old). No orphan PRs. CLAUDE.md verified current — no drift since cycle 3. Promoted #221 (improvement-detector dedup) from Planned to Next-up (5).
- **2026-04-18 cycle 3**: Closed #231 (healthcheck — misrouted, belongs to infra/proxy, 3 retries exhausted). Closed orphan PR #305 (no `Closes #N`). Added 5 missing `src/reviewer/` modules to CLAUDE.md. Quality-floor cluster (#278, #285, #292, #298) confirmed distinct: each covers a different channel or data layer — no duplicates. No issues > 14 days old.
