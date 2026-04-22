# Roadmap — claude-orchestrator-reviewer

_Last updated: 2026-04-22 (triage cycle 8)_

## Completed (recent)

- **#411 / PR #425** — Meeting-facilitator monthly goal widget: `getMeetingFacilitatorGoalWidget()` tracking `core_logic_shipped` + `meetings_facilitated` targets (`meeting-facilitator-goal.ts`)
- **#423 / PR #424** — `summary()` method added to `ResearchInvestigationClient` — `GET /api/investigations/summary` for lightweight active_count / last_completed / oldest_in_flight_age snapshot
- **#134 / PR #422** — `/investigations` Telegram command: research agent investigation feed grouped by status (`investigations-feed.ts`)
- **#420 / PR #421** — Expose `listActivePRGuardCooldowns()` bulk query + `/api/pr-guard-cooldowns` REST payload builder (`pr-guard-cooldown-feed.ts`)
- **#128 / PR #418** — `ResearchInvestigationClient`: HTTP client for research agent `/api/investigations` feed; register/activate/complete/cancel lifecycle (`research-investigation-client.ts`)
- **#413 / PR #416** — Triage revision-rate dashboard: `triage_validator_calls` table + before/after validator metrics for `/triage-health`
- **#409 / PR #412** — `/triage-health` Telegram command: per-agent schema failure rate and validation stats (`triage-health.ts`)
- **#406 / PR #407** — `POST /api/validate-triage-schema` pre-submission self-check: `validateTriageSchema()` callable by agents before submitting housekeeping results (`triage-schema-validator.ts`)
- **#399 / PR #400** — old_rank pre-submission validator: `validateOldRankInPriorityReordering()` + `validation_pre_check_passed` field in triage coaching prompt
- **#390 / PR #397** — PR guard cooldown: `pr_guard_cooldown` table + `isPRGuardCooldownActive()` prevents re-queuing within 60 min of `already-in-review` hit
- **#393 / PR #396** — Triage coaching: concrete `old_rank: null` JSON example injected into every coached prompt (`triage-coaching.ts`)
- **#398 / PR #401** — `/api/bypass-audit` endpoint + daily Telegram digest for sub-floor approvals (`bypass-audit.ts`, `IBypassAuditStore`)
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
- **#375 / PR #378** — Score-zero approval alerter: dedicated real-time Telegram alert for score ≤ 0.05 approvals (`score-zero-alert.ts`)
- **#382 / PR #386** — Daily misrouting digest: Telegram summary of implementation tasks dispatched to reviewer (`misrouting-digest.ts`)
- **#388 / PR #388** — `/misrouting [hours]` Telegram command for on-demand misrouting stats
- **#405 / PR #408** — Universal quality gate: `checkApprovalQualityGate()` + `UniversalQualityGateMonitor`; sub-0.80 alert for ALL task types across ALL approval paths (`universal-quality-gate.ts`)

## Next up

1. **#391 — Per-issue dispatch surge alerter** _(high)_ — Extend `duplicate-dispatch-surge-detector.ts` to key on `(repo, issue_number)` and fire a Telegram alert when any single issue accumulates ≥3 dispatches within a 15-minute window; deduplicate at most once per 30 min per issue.

2. **#392 — Orchestrator pre-dispatch gate: hard-block issues with open PRs** _(high)_ — Enforce a hard block at dispatch time when a PR already exists for the issue; stricter than the soft existing guard which can be bypassed.

3. **#414 — Bookkeeping task type: score 'close-by-reference' outcomes appropriately** _(high)_ — Tasks that close issues by reference (e.g. "Closes #N" in a PR they reviewed) should receive a quality score reflecting the outcome rather than a null or defaulted score.

4. **#359 — Daily agent quality digest with degradation callouts** _(high)_ — Scheduled Telegram message summarising each agent's 24-hour score average, trend direction, and flagging any agent that degraded >10% day-over-day.

5. **#232 — Quality scores missing from task feed** _(high)_ — Despite `ensureScoresPopulated()` and backfill commands, recent tasks still show `quality_score: null`. Need a startup/daemon check that warns when >10% of recent approved tasks have null scores.

6. **#368 — Auto-file GitHub issues for improvements identified across 3+ consecutive batches** _(medium)_ — `ImprovementRecurrenceTracker` that records patterns by normalized title hash across distinct batches and auto-files a `chronic` + `improvement` tagged issue when threshold is reached.

7. **#221 — Improvement detector deduplication against existing GitHub issues** _(medium)_ — `ImprovementDetector` creates GitHub issues without checking for existing open duplicates. Add `gh issue list` pre-check with title-similarity filter before filing.

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

- **2026-04-22 cycle 8**: No duplicate issues found (11 open, all distinct). No stale issues (oldest #221 is 6 days old). No open PRs (none to audit for orphan links). Completed since cycle 7: #390 (PR #397 merged — PR guard cooldown), #399 (PR #400 merged — old_rank validator), #406 (PR #407 — triage-schema-validator), #409 (PR #412 — /triage-health command), #413 (PR #416 — triage revision-rate dashboard), #128 (PR #418 — ResearchInvestigationClient), #420 (PR #421 — listActivePRGuardCooldowns), #134 (PR #422 — /investigations command), #423 (PR #424 — summary()), #411 (PR #425 — meeting-facilitator goal widget). CLAUDE.md: added 5 missing source modules (`investigations-feed.ts`, `meeting-facilitator-goal.ts`, `pr-guard-cooldown-feed.ts`, `triage-health.ts`, `triage-schema-validator.ts`) and corresponding scope entries. ROADMAP.md: promoted 10 items to Completed; added #414 to Next up; removed merged #390/#399 awaiting entries.

- **2026-04-21 cycle 7**: No duplicate issues found (11 open, all distinct). No stale issues (oldest #221 is 5 days old). No orphan PRs (#397 closes #390, #400 closes #399 — both open awaiting merge). Completed: #393 (merged PR #396 — triage coaching old_rank example) and #398 (merged PR #401 — bypass-audit endpoint). CLAUDE.md: added `bypass-audit.ts`, `pr_guard_cooldown`, `validateOldRankInPriorityReordering`, and `IBypassAuditStore` to scope and source layout. ROADMAP.md: promoted #393/#398 to Completed; added #390/#399 (PRs open) to Next up.
- **2026-04-21 cycle 6**: Closed #389 as duplicate of #391 (both request per-issue dispatch surge alerting in Telegram; #391 has acceptance criteria). No stale issues (all open issues ≤2 days old). No open PRs to audit. CLAUDE.md fixes: (1) system architecture table had wrong repo names — corrected to `rapartlu/*` GitHub repos and added 3 missing agents (telegram, research, meeting-facilitator); (2) added `score-zero-alert.ts` and `misrouting-digest.ts` to source layout (shipped in PRs #378, #386, #388 but not documented); (3) added scope entries for both. ROADMAP.md: promoted #375/#382/#388 to Completed; added #391 and #392 to Next up.
- **2026-04-19 cycle 5**: Closed #351 (CLAUDE.md update delivered in this triage PR). Closed #353 (unclear/no actionable reviewer changes specified). Added 11 missing `src/reviewer/` modules to CLAUDE.md source layout; added 13 scope entries for recently shipped features. Moved completed items (#278, #285, #292, #325–#376 batch) from Next-up to Completed. Promoted #375 and #359 to Next-up (1, 2). Confirmed #364 and #340 (PRs closed unmerged) remain valid backlog items. No duplicate issues. No stale issues (all open issues are ≤ 3 days old).
- **2026-04-19 cycle 4**: Closed #315 (CLAUDE.md sync already done in PR #316). Closed #298 (bypass rate trending fully implemented by `quality-system-health.ts` in PR #306). No stale issues (oldest open are #71 and #89, both 7 days old). No orphan PRs. CLAUDE.md verified current — no drift since cycle 3. Promoted #221 (improvement-detector dedup) from Planned to Next-up (5).
- **2026-04-18 cycle 3**: Closed #231 (healthcheck — misrouted, belongs to infra/proxy, 3 retries exhausted). Closed orphan PR #305 (no `Closes #N`). Added 5 missing `src/reviewer/` modules to CLAUDE.md. Quality-floor cluster (#278, #285, #292, #298) confirmed distinct: each covers a different channel or data layer — no duplicates. No issues > 14 days old.
