# Roadmap — claude-orchestrator-reviewer

_Last updated: 2026-04-25 (triage cycle 15)_

## Completed (recent)

- **#484 / PR #484** — score provenance tracking + persistent anomaly digest: distinguishes `default_fallback` score sources from true LLM scores, persists anomaly observations, and exposes `/api/score-provenance/:task_id` + `/api/persistent-anomalies`
- **#479 / PR #479** — calibration recommendations persistence: stores `ScoreCalibrator` recommendations in SQLite with lifecycle tracking and auto-apply for high-confidence recommendations
- **#475 / PR #475** — pattern_risk signals into improvement detector: consumed recurring quality-risk signals directly in the improvement prompt
- **#471 / PR #471** — PR guard surge detector defaults realigned to the canonical coordinated spec: 5 hits / 30 min suppression window
- **#464 / PR #464** — `MeetingPriorityDispatcher`: rule-based fast-path for auto-dispatch from meeting outcomes
- **#461 / PR #461** — `MeetingOutcomeClient`: supervisor routing intelligence from meeting outcomes
- **#459 / PR #459** — improvement detector batch deduplication guard: 6h batch-hash skip window
- **#457 / PR #457** — `/meeting-goal` Telegram command for meeting-facilitator monthly progress
- **#433 / PR #433** — `/triage-health` cross-link to consecutive-failure-detector and warning surfacing
- **#431 / PR #431** — research-agent implementation tasks section added to misrouting digest
- **#429 / PR #429** — `LowQualityPRLabeler`: persistent low-quality label on sub-0.70 PR approvals
- **#424 / PR #424** — `summary()` on `ResearchInvestigationClient` for lightweight investigation snapshots
- **#422 / PR #422** — `/investigations` Telegram command: research agent investigation feed
- **#421 / PR #421** — `listActivePRGuardCooldowns()` bulk query + `/api/pr-guard-cooldowns`
- **#416 / PR #416** — triage revision-rate dashboard with before/after validator metrics
- **#412 / PR #412** — `/triage-health` Telegram command: per-agent schema failure rate
- **#408 / PR #408** — Universal quality gate: sub-0.80 alert for all task types and approval paths
- **#391 / PRs #443 #452** — `PRGuardSurgeDetector`: per-issue surge alert at ≥2 hits/60min; dispatch suppression at ≥5 hits/30min (thresholds realigned to the canonical coordinated spec by PR #471)
- **#392 / PRs #444 #449** — PR guard cooldown pre-flight: early cooldown check + `GET /api/pr-guard-cooldown/check` endpoint for proactive dispatch gate
- **#441 / PR #444** — Enforce PR guard cooldown before any `gh` CLI call (`cooldown-active` resolution)
- **#442 / PR #443** — `PRGuardSurgeDetector` Telegram alert with per-issue hit count
- **#1113 / PR #448** — Dispatch surge auto-suppression: 2-hour block at ≥5 hits/30min with dedicated Telegram alert
- **#454 / PR #455** — Fork-from dispatch payload protocol: canonical spec + types for `fork_from: conversation_id` (Phase 1 shadow-mode)
- **#456 / PR #457** — `/meeting-goal` Telegram command surfacing monthly goal widget
- **#458 / PR #459** — Improvement detector batch deduplication guard: `computeBatchHash()` + `improvement_analysis_runs` table prevents redundant LLM analysis within 6h
- **#460 / PR #461** — `MeetingOutcomeClient`: HTTP client for meeting-facilitator outcome API; `extractSupervisorIntelligence()` for ranked issue list + sequencing constraints
- **#463 / PR #464** — `MeetingPriorityDispatcher`: 7-rule fast-path for auto-dispatch from meeting outcome signals without LLM judgment
- **#432 / PR #433** — `/triage-health` cross-link to consecutive-failure-detector: `fetchConsecutiveFailureBlocks()` shows warning when agent `failure_rate > 50%` and has active consecutive-failure blocks
- **#428 / PR #429** — `LowQualityPRLabeler`: adds/removes `low-quality` GitHub label on PRs when tasks score below 0.80 (`low-quality-pr-labeler.ts`)
- **#382 / PR #431** — Research agent implementation tasks section added to misrouting digest: `getMisroutingReport()` + `recordMisrouting()` methods on `ResearchInvestigationClient`
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

1. **#485 — Wire score provenance guard into orchestrator auto-approval path** _(high)_ — Block `score_source='default_fallback'` approvals in the orchestrator and operator override paths; this is the direct follow-up to the just-merged score provenance work.

2. **#473 — Newly shipped surge suppression doesn't cover PR-guard floods** _(high)_ — Add a PR-level suppression axis so batches of different issues blocked by the same PR collapse into one consolidated suppression event.

3. **#468 — Persist dispatch surge suppression events to SQLite** _(high)_ — Make `PRGuardSurgeDetector` suppression survive restarts and expose the suppression log via REST.

4. **#445 — Sub-0.60 approval audit entry gap** _(high)_ — Score 0.52 was approved without a bypass-audit entry; investigate the path that bypasses bypass-audit recording and add the missing hook.

5. **#453 — Reviewer-side guard: alert when staging validator fires for pre-existing failures repeatedly (>3 distinct PRs)** _(high)_ — When the staging validator fires for the same failure pattern across >3 distinct PRs, alert operators; prevents silent accumulation of pre-existing failures.

## In flight

- **#469 / PR #482** — cross-repo housekeeping follow-up already has an open PR with `Closes #469`; no additional backlog work needed unless the PR regresses.

## Planned

- **#472 — Meeting facilitator: persist synthesis results to queryable store** _(high)_ — Keep meeting results searchable across daemon cycles so follow-up sessions can retrieve prior synthesis outputs without revision churn.
- **#440 — Improvement issues filed from analysis are not being dispatched** _(medium)_ — Add a `/stale-improvements` view and/or dispatch exemption path so chronic improvement findings do not stall silently.
- **#364 — Hard quality floor with mandatory override audit trail** _(high)_ — Hard floor at 0.10 blocking sub-floor approvals; Telegram escalation with `/approve-override` and `/reject-override`; `score_floor_overrides` audit table.
- **#368 — Auto-file GitHub issues for improvements identified across 3+ consecutive batches** _(medium)_ — `ImprovementRecurrenceTracker` records patterns by normalized title hash across distinct batches; auto-files `chronic` + `improvement` tagged issue when threshold is reached.
- **#414 — Bookkeeping task type: score 'close-by-reference' outcomes appropriately** _(high)_ — Treat close-by-reference bookkeeping work as a distinct outcome instead of letting it fall back to a null/defaulted score.
- **#359 — Daily agent quality digest with degradation callouts** _(high)_ — Scheduled Telegram message summarising each agent's 24-hour score average, trend direction, and day-over-day degradation.
- **#340 — Persist proactive rebase stats to SQLite** _(medium)_ — `rebase_events` table, `IRebaseStore` interface, `/rebase-stats` Telegram command, and `/rebase-stats` HTTP endpoint for dashboard.

## Ideas

- **Configurable escalation thresholds per agent**: Per-agent `feedback_ceiling` and `min_score` overrides in `ReviewerConfig` rather than a single global setting.
- **Improvement detector cron**: Run `ImprovementDetector.analyze()` on a scheduled cadence (every 6 h) and auto-file issues only for novel patterns not in the open backlog.
- **Supervisor dry-run mode**: A `--dry-run` flag for logging dispatch decisions to stdout — useful for debugging in staging.
- **Schema-consumer auto-sync**: After a `schema-contract.json` change ships, auto-open issues in consumer repos listing impacted columns.
- **Review score history trending**: Persist `VerificationResult` scores over time so the improvement detector can spot regression trends across deploys.

## Triage notes

- **2026-04-25 cycle 15**: No duplicate issues found (14 open, all distinct). No stale issues (>14 days) — all open issues are under the cutoff. Open PRs audited: #482 correctly includes `Closes #469`. ROADMAP.md: added the latest merged reviewer features (#408 through #484), refreshed Next up for #485/#473/#468/#445/#453, added an `In flight` note for #469 / PR #482, and corrected the PR-guard surge defaults to 5/30. CLAUDE.md: added the new score-provenance / persistent-anomalies / calibration-recommendations modules and corrected the stale PR-guard threshold text.

- **2026-04-24 cycle 13**: Closed #391 (done by PRs #443/#452 — PRGuardSurgeDetector), #392 (done by PRs #444/#449 — cooldown pre-flight + check endpoint), #446 (cross-repo triage completed in comment), #462 (orphan branch cleanup completed). No duplicate issues (9 remaining open, all distinct). No stale issues (all ≤5 days). No open PRs to audit. CLAUDE.md: fixed stale surge-detector threshold values (3→2 hits for alert, 5 hits/30min→3 hits/15min for suppression — PR #452). ROADMAP.md: added 10 completed items; removed closed #232 from Planned; updated Next up.

- **2026-04-23 cycle 11**: No duplicate issues (10 open, all distinct). No stale issues (oldest #232 is 6 days old). Open PR #437 correctly closes #436. ROADMAP.md: removed 4 closed issues from Planned (#89, #189, #221, #222 — all closed). CLAUDE.md: verified accurate, no drift detected. Issues remaining: 10 open, all within 14-day window.

- **2026-04-22 cycle 9**: No duplicate issues found (12 open, all distinct). No stale issues (oldest #221 is 6 days old). No open PRs (none to audit for orphan links). Completed since cycle 8: #428 (PR #429 merged — LowQualityPRLabeler), #382 (PR #431 merged — research agent misrouting section in digest), #432 (PR #433 merged — triage-health cross-link to consecutive-failure-detector). CLAUDE.md: added `low-quality-pr-labeler.ts` to Scope and Source Layout; added consecutive-failure cross-link description to `triage-health.ts` scope entry. ROADMAP.md: promoted #428/#382/#432 to Completed; added #427 (PR-level dispatch lock) to Next up position 1; renumbered prior items 1–5 → 2–6 with #232 dropping to 6.

- **2026-04-22 cycle 8**: No duplicate issues found (11 open, all distinct). No stale issues (oldest #221 is 6 days old). No open PRs (none to audit for orphan links). Completed since cycle 7: #390 (PR #397 merged — PR guard cooldown), #399 (PR #400 merged — old_rank validator), #406 (PR #407 — triage-schema-validator), #409 (PR #412 — /triage-health command), #413 (PR #416 — triage revision-rate dashboard), #128 (PR #418 — ResearchInvestigationClient), #420 (PR #421 — listActivePRGuardCooldowns), #134 (PR #422 — /investigations command), #423 (PR #424 — summary()), #411 (PR #425 — meeting-facilitator goal widget). CLAUDE.md: added 5 missing source modules (`investigations-feed.ts`, `meeting-facilitator-goal.ts`, `pr-guard-cooldown-feed.ts`, `triage-health.ts`, `triage-schema-validator.ts`) and corresponding scope entries. ROADMAP.md: promoted 10 items to Completed; added #414 to Next up; removed merged #390/#399 awaiting entries.

- **2026-04-21 cycle 7**: No duplicate issues found (11 open, all distinct). No stale issues (oldest #221 is 5 days old). No orphan PRs (#397 closes #390, #400 closes #399 — both open awaiting merge). Completed: #393 (merged PR #396 — triage coaching old_rank example) and #398 (merged PR #401 — bypass-audit endpoint). CLAUDE.md: added `bypass-audit.ts`, `pr_guard_cooldown`, `validateOldRankInPriorityReordering`, and `IBypassAuditStore` to scope and source layout. ROADMAP.md: promoted #393/#398 to Completed; added #390/#399 (PRs open) to Next up.
- **2026-04-21 cycle 6**: Closed #389 as duplicate of #391 (both request per-issue dispatch surge alerting in Telegram; #391 has acceptance criteria). No stale issues (all open issues ≤2 days old). No open PRs to audit. CLAUDE.md fixes: (1) system architecture table had wrong repo names — corrected to `rapartlu/*` GitHub repos and added 3 missing agents (telegram, research, meeting-facilitator); (2) added `score-zero-alert.ts` and `misrouting-digest.ts` to source layout (shipped in PRs #378, #386, #388 but not documented); (3) added scope entries for both. ROADMAP.md: promoted #375/#382/#388 to Completed; added #391 and #392 to Next up.
- **2026-04-19 cycle 5**: Closed #351 (CLAUDE.md update delivered in this triage PR). Closed #353 (unclear/no actionable reviewer changes specified). Added 11 missing `src/reviewer/` modules to CLAUDE.md source layout; added 13 scope entries for recently shipped features. Moved completed items (#278, #285, #292, #325–#376 batch) from Next-up to Completed. Promoted #375 and #359 to Next-up (1, 2). Confirmed #364 and #340 (PRs closed unmerged) remain valid backlog items. No duplicate issues. No stale issues (all open issues are ≤ 3 days old).
- **2026-04-19 cycle 4**: Closed #315 (CLAUDE.md sync already done in PR #316). Closed #298 (bypass rate trending fully implemented by `quality-system-health.ts` in PR #306). No stale issues (oldest open are #71 and #89, both 7 days old). No orphan PRs. CLAUDE.md verified current — no drift since cycle 3. Promoted #221 (improvement-detector dedup) from Planned to Next-up (5).
- **2026-04-18 cycle 3**: Closed #231 (healthcheck — misrouted, belongs to infra/proxy, 3 retries exhausted). Closed orphan PR #305 (no `Closes #N`). Added 5 missing `src/reviewer/` modules to CLAUDE.md. Quality-floor cluster (#278, #285, #292, #298) confirmed distinct: each covers a different channel or data layer — no duplicates. No issues > 14 days old.
