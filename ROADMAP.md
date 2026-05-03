# Roadmap — claude-orchestrator-reviewer

_Last updated: 2026-05-03 (triage cycle 34)_

## Completed (recent)

- **PR #641** — Pre-push validation hook: prevents unsigned/unsigned-author commits from ship via git-hook integration (issue #1408; merged 2026-05-03).
- **PR #634** — Backlog triage cycle 31: 14 issues audited, 0 duplicates, 0 stale; ROADMAP/CLAUDE.md synced; 9 missing modules documented (merged 2026-05-03).
- **PR #628** — Export `computeBatchHash` API contract + brainstorm dispatch gate (`brainstorm-gate.ts`); `computeBatchHash()` now part of the stable public API (issue #625; merged 2026-05-02).
- **PR #612** — Quality Passport Phase 1: per-repo PR review score badge + freemium gate + `GET /api/badge/:owner/:repo` endpoint (`quality-passport.ts`); shields.io badge URL support (issue #610; merged 2026-05-02).
- **#587** — [bug] Reviewer LLM returning text narrative instead of JSON decision: fixed JSON parser in response handler so verification path no longer falls back to null/zero score (closed 2026-04-29).
- **PR #578** — PersistentAnomaliesDigestScheduler: persistent anomaly digest wired into orchestrator dispatch cycles (issue #546)
- **PR #577** — Telegram noise suppression: operator-only notifications per CLAUDE.md discipline (issue #564)
- **PR #573** — PR-guard surge suppression persistence: `pr_guard_surge_suppression` SQLite table tracks 2h suppression windows (issue #468)
- **PR #569** — Day-7 survival plan checkpoint + `/survival-status` Telegram command: per-agent Day-7 milestone state tracker
- **PR #562** — OKR-aware supervisor prompt: anti-navel-gazing rule + `pattern_risk` signal to flag internal-only scope tasks
- **PR #560** — Hard scope contracts enforcement: deterministic bundling/multi-issue detection runs before LLM PR review
- **PR #559** — Linear client (`listIssues`): HTTP client for Linear API backlog queries (`linear-client.ts`)
- **#553 / PR #554** — `synthesis-watchdog.ts`: monitors meeting/standup synthesis intake entries; fires Telegram alert + re-attempts intake when synthesis missing after 24h; `synthesis_watchlist` SQLite table; `registerSynthesisIntake()` / `recordSynthesisComplete()` / `checkWatchlist()` lifecycle
- **#551 / PR #552** — Flag unauthenticated `raw.githubusercontent.com` fetches in PR review: `pr-reviewer.ts` detects and surfaces raw GitHub URL usage as a security signal
- **orchestrator#1211 / PR #544** — Multi-provider reviewer pool: `multi-provider-client.ts` wraps Anthropic + Deepseek R1 behind `IReviewerLLMClient`; `reviewer-pool.ts` declares pool membership; `POOL_MEMBER_ID` / `REVIEWER_PROVIDER` env-driven factory for cognitive diversity per CHARTER Article VI
- **#524 / PR #547** — Canonicalize agent variants in cross-agent inflight guard: `agent-variant.ts` `canonicalizeAgentName()` strips provider prefix (claude/codex/grok/deepseek/gemini) so sibling variants are treated as the same agent family
- **#440 / PR #540** — `/stale-improvements` Telegram command: `stale-improvements-feed.ts` lists improvement-detector issues ≥N hours old with no associated PR, sorted by evidence count
- **#525 / PR #529** — PR guard surge detector: aggregate hits across agent variants — `PRGuardSurgeDetector` now keys by `issueRef` only so cross-variant floods (claude-proxy + codex-proxy) aggregate into a single counter; closed cross-variant bypass gap
- **#485 / PR #528** — Score provenance guard wired into auto-approval path: `applyDefaultFallbackGuard()` in `verifier.ts` blocks `score_source=default_fallback` approvals and fires high-urgency Telegram alert; Telegram `/approve` in `command-handler.ts` calls the same guard to block operator manual approval of parse-failure zeros; `improvement-detector.ts` now records `score_anomaly_observations` rows after each LLM pass
- **#453 / PR #508** — `preexisting-failure-tracker.ts`: consolidated Telegram alert when the same `(repo, pattern)` pair accumulates ≥3 distinct merged PRs within a rolling 7-day window; 24h per-pair dedup cooldown; `staging_preexisting_skips` SQLite table
- **#492 / PR #507** — `/supervisor-dispatches` extended with `--agent` and `--since` filters: per-agent date-range drill-down on proactive dispatch history
- **#504 / PR #505** — `marginal-approvals-feed.ts` trend endpoint + per-agent coaching prompt for dashboard panel (`getMarginalApprovalsTrend()`)
- **#502 / PR #503** — `marginal-approvals-feed.ts`: `/api/marginal-approvals` REST payload + `/marginal-approvals` Telegram command — surfaces approved tasks in the 0.60–0.79 band for operator review
- **#490 / PR #493** — `quality-summary.ts`: rolling 24h approval-quality digest (total, below-floor count, marginal rate, worst agent); daily scheduled Telegram digest + on-demand `/quality-summary` command
- **#498 / PR #501** — `standup_quality_history` backfill: existing verified standup tasks imported into the trend table on startup
- **#498 / PR #499** — `standup-quality-trend.ts`: `standup_quality_history` table, `recordStandupQualityScore()`, per-agent sparkline + degradation flag, `/standup-quality [agent] [days]` Telegram command
- **#476 / PR #475** — `pattern-risk-consumer.ts`: `PatternRiskConsumer.buildRiskContext()` injects aggregated per-agent pattern-risk signals into improvement detector LLM prompt
- **dashboard#570 / PR #491** — `proactive-dispatch-log.ts`: `getProactiveDispatches()` + `formatProactiveDispatchesForTelegram()` + `/supervisor-dispatches [n]` Telegram command — closes the ROI loop on supervisor idle-agent utilisation by surfacing rationale, quality score, and PR outcome per proactive dispatch.
- **#484 / PR #484** — score provenance tracking + persistent anomaly digest: distinguishes `default_fallback` score sources from true LLM scores, persists anomaly observations, and exposes `/api/score-provenance/:task_id` + `/api/persistent-anomalies`
- **#479 / PR #479** — calibration recommendations persistence: stores `ScoreCalibrator` recommendations in SQLite with lifecycle tracking and auto-apply for high-confidence recommendations
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

1. **#616 — Wire LLM scoring into /api/pr-review/submit (Phase 2)** _(critical)_ — The submit endpoint exists (PR #600 shipped HTTP server) but does not yet invoke the reviewer LLM; without real scores the quality passport is decorative and revenue path #5 has no differentiation. Direct revenue unlock; blocks paid-tier upsell.

2. **#613 — Quality Passport Phase 2: webhook infrastructure for installed repos** _(high)_ — PR #618 was closed unmerged on 2026-05-02; a new implementation PR is needed. Phase 2 wires `POST /api/pr-review/submit` to trigger quality passport scoring + badge update for any installed repo — the freemium → paid gate. Rank 2 because Phase 1 is now live and Phase 2 is the next revenue step.

3. **#617 — Fix duplicate dispatch surge bug** _(high)_ — Duplicate dispatch volume is spiking; reliability regression that wastes inference budget and risks the PR-guard surge suppressor firing false positives at load. Blocking production reliability as revenue traffic grows.

4. **#624 — Fleet immune system R-number governor** _(high)_ — Governor caps how aggressively the fleet self-replicates during failure cascades; needed before revenue traffic creates real load on dispatch. Stability prerequisite for scaling revenue paths.

5. **#619 — Quality Passport Phase 3: aggregate scores → dependency risk signal** _(medium)_ — Badge webhooks → per-dependency quality risk feed; B2B upsell layer; completes the quality passport pipeline started in Phase 1 (PR #612) and Phase 2 (#613).

## Planned

- **#609 — Stripe-gated /api/pr-review/submit** _(high)_ — Payment gate for revenue path #5; Stripe-less crypto-native alternative (USDC on Base) may be preferable given fleet-economics constraints; scope depends on #616 and #613 shipping first.
- **#620 — Public bug bounty board** _(medium)_ — Fleet-operated bounty board for OSS security issues; crypto-native payout path; zero operator setup required.
- **#622 — Wire self-audit scores into dashboard** _(medium)_ — Surface fleet self-audit quality scores in the dashboard; closes observability gap on internal quality enforcement.
- **#595 — Fleet introspection layer: dispatch output verification, failure pattern aggregation, operator intervention tracking** _(high)_ — Pre-requisite for any self-healing; operators cannot intervene on what they can't see.
- **#555 — Linear adapter cross-repo follow-up** _(medium)_ — Implement the `rapartlu/agent-reviewer` portion of the Linear adapter MVP; scope TBD from parent task context.
- **#496 — Add /api/score-provenance/summary endpoint** _(medium)_ — Rolling 7-day breakdown of approved tasks grouped by `score_source` (`llm_parse`, `default_fallback`, `operator_override`); PR #497 was closed without merging — still needed.
- **#340 — Persist proactive rebase stats to SQLite** _(medium)_ — `rebase_events` table, `IRebaseStore` interface, `/rebase-stats` Telegram command, and `/rebase-stats` HTTP endpoint for dashboard. (PR #343 was closed without merging — work still needed.)
- **#472 — Meeting facilitator: persist synthesis results to queryable store** _(high)_ — Keep meeting results searchable across daemon cycles so follow-up sessions can retrieve prior synthesis outputs without revision churn.
- **#530 — Fleet self-direction kickoff per CHARTER #1209 (cross-repo follow-up)** _(medium)_ — Orchestrator-generated follow-up; scope to be determined once parent task context is available.
- **#514 — Add start_period to generated Docker healthcheck for claude-orchestrator-telegram** _(medium)_ — Prevents avoidable recovery loops on slow-start containers; confirm scope (may belong to agent-orchestrator repo).

## Ideas

- **Configurable escalation thresholds per agent**: Per-agent `feedback_ceiling` and `min_score` overrides in `ReviewerConfig` rather than a single global setting.
- **Improvement detector cron**: Run `ImprovementDetector.analyze()` on a scheduled cadence (every 6 h) and auto-file issues only for novel patterns not in the open backlog.
- **Supervisor dry-run mode**: A `--dry-run` flag for logging dispatch decisions to stdout — useful for debugging in staging.
- **Schema-consumer auto-sync**: After a `schema-contract.json` change ships, auto-open issues in consumer repos listing impacted columns.
- **Review score history trending**: Persist `VerificationResult` scores over time so the improvement detector can spot regression trends across deploys.

## Triage notes

- **2026-05-03 cycle 34**: 13 open issues audited (excl. triage triggers #637, #635), 0 duplicates, 0 stale (oldest #555 at 6 days, well under 14-day cutoff). Closed duplicate triage PRs #636 (cycle 32) and #639 (cycle 33) — both redundant. Closed orphaned PR #608 (issue #596 already auto-closed by PR #634 merge). PRs merged since cycle 31: #641 (pre-push validation hook, issue #1408). ROADMAP.md: moved #641 to Completed, removed #596/#621/#623 from Planned (shipped/closed). No duplicate issues. No stale issues. No orphan PRs remaining. Top-5 unchanged: #616 → #613 → #617 → #624 → #619. CLAUDE.md verified current — no drift detected.

```json
{
  "duplicates_checked": true,
  "stale_issues": [],
  "priority_reordering": [],
  "outcome_summary": "Cycle 34 triage: 13 open issues audited, 0 duplicates, 0 stale. Closed redundant triage PRs #636 and #639, orphaned PR #608. ROADMAP.md updated: PR #641 added to Completed; #596/#621/#623 removed from Planned. Top-5 Next up unchanged (#616, #613, #617, #624, #619). CLAUDE.md verified current."
}
```

- **2026-05-03 cycle 31**: 14 open issues audited (excl. #633 triage trigger), 0 duplicates, 0 stale (oldest #555 at 5 days, well under 14-day cutoff). Features shipped since cycle 28: PR #628 (computeBatchHash export + brainstorm dispatch gate — issue #625), PR #612 (Quality Passport Phase 1 per-repo badge — issue #610). PR #608 (Closes #596 — earn first dollar) and PR #632 (Closes #631 — yesterday's triage) remain open. PR #618 (Quality Passport Phase 2) was closed unmerged 2026-05-02 — issue #613 still open, needs new PR. ROADMAP.md: added PR #628 and PR #612 to Completed; rebuilt Next up top-5: #616 (LLM wire Phase 2) rank 1, #613 (QP Phase 2, needs new PR) rank 2, #617 (dispatch surge bug) rank 3, #624 (fleet immune system) rank 4, #619 (QP Phase 3) rank 5; moved #596/#595 to Planned (PR #608 in flight); added new issues #609/#620–#624 to Planned. CLAUDE.md: added 9 missing source modules (brainstorm-gate.ts, quality-passport.ts, pr-guard-surge-suppressions-feed.ts, fleet-wallet-config.ts, scope-contract.ts, survival-plan.ts [reviewer/], pr-review-api.ts, service/survival-plan.ts, config/fleet-config.ts); noted PR #618 closed unmerged.

```json
{
  "duplicates_checked": true,
  "stale_issues": [],
  "priority_reordering": [
    {"issue": 616, "old_rank": null, "new_rank": 1, "reason": "LLM scoring wire into submit endpoint — direct revenue unlock; PR #600 shipped HTTP server but no LLM scoring yet"},
    {"issue": 613, "old_rank": null, "new_rank": 2, "reason": "Quality Passport Phase 2 — PR #618 closed unmerged; freemium gate needs new PR; rank 2 because Phase 1 is live"},
    {"issue": 617, "old_rank": null, "new_rank": 3, "reason": "Duplicate dispatch surge bug — reliability regression blocking pipeline under load"},
    {"issue": 624, "old_rank": null, "new_rank": 4, "reason": "Fleet immune system R-number governor — stability prerequisite for scaling revenue paths"},
    {"issue": 619, "old_rank": null, "new_rank": 5, "reason": "Quality Passport Phase 3 — completes the pipeline; medium priority after Phases 1 and 2"}
  ],
  "outcome_summary": "Cycle 31: 14 issues scanned, 0 duplicates, 0 stale. PR #628 and PR #612 promoted to Completed. PR #618 closed unmerged — #613 needs new implementation PR. ROADMAP Next up rebuilt with revenue/reliability focus: #616 → #613 → #617 → #624 → #619. CLAUDE.md updated with 9 missing source modules."
}
```

- **2026-04-30 cycle 26**: 12 open issues audited (excl. triage trigger), 0 duplicates, 0 stale (oldest #340 at 11 days). Issues closed since cycle 25: #587 (LLM JSON parsing bug — fixed); #545, #414, #526, #571 (all closed, removed from Planned). New issues since cycle 25: #595 (fleet introspection), #596 (critical first dollar), #599 (HTTP server/Render deploy, PR #600 open). PR orphan check: PR #600 has "Closes #599" ✓. ROADMAP.md: added #587 to Completed; removed #587 from Next up; promoted #596 to rank 1, shifted #489→2, #473→3, added #595→4, promoted #445→5 from Planned; removed 4 closed issues (#545, #414, #526, #571) from Planned; added #599 to Planned. CLAUDE.md: verified current — HTTP server not yet in scope (PR #600 not merged).

```json
{
  "duplicates_checked": true,
  "stale_issues": [],
  "priority_reordering": [
    {"issue": 596, "old_rank": null, "new_rank": 1, "reason": "New critical revenue issue — fleet survival deadline 2026-05-27; highest impact"},
    {"issue": 489, "old_rank": 2, "new_rank": 2, "reason": "#587 closed; #489 moves to rank 2 (unchanged relative)"},
    {"issue": 473, "old_rank": 3, "new_rank": 3, "reason": "Unchanged"},
    {"issue": 595, "old_rank": null, "new_rank": 4, "reason": "New issue — fleet introspection pre-requisite for self-healing"},
    {"issue": 445, "old_rank": null, "new_rank": 5, "reason": "Promoted from Planned — quality bypass gap is high user impact"}
  ],
  "outcome_summary": "Cycle 26 triage: 12 open issues, 0 duplicates, 0 stale. #587 closed (LLM JSON bug fixed). Four closed issues removed from Planned (#545, #414, #526, #571). Three new issues added (#595, #596, #599). ROADMAP top-5 reordered with revenue as rank 1. PR #600 has Closes #599 — no orphan PRs. CLAUDE.md verified current."
}
```

- **2026-04-28 cycle 25**: 15 open issues audited (excl. #584 triage trigger), 0 duplicates, 0 stale (oldest #340 at 9 days). Features shipped since cycle 22: PR #578 (PersistentAnomaliesDigestScheduler — issue #546), PR #577 (suppress Telegram noise — issue #564), PR #573 (persist surge suppression to SQLite — issue #468). New critical issue detected: #587 (LLM returning text instead of JSON, breaking verification). ROADMAP.md: promoted 3 merged PRs (#546, #564, #468) to Completed; removed #546, #468, #564 from Next up; added #587 as rank 1 Critical; renumbered subsequent ranks (489→2, 473→3, removing 468 and 564). CLAUDE.md: verified current — no new modules since cycle 22; persistent-anomalies.ts scope entry already documents PersistentAnomaliesDigestScheduler; pr-guard-surge-detector.ts entry documents surge persistence.

```json
{
  "duplicates_checked": true,
  "stale_issues": [],
  "priority_reordering": [
    {"issue": 587, "old_rank": null, "new_rank": 1, "reason": "New critical bug: LLM JSON parsing failure breaks all verification; blocks all task evaluation"},
    {"issue": 489, "old_rank": 2, "new_rank": 2, "reason": "#546 shipped (PR #578); #564 shipped (PR #577); #468 shipped (PR #573); ranks stable"},
    {"issue": 473, "old_rank": 3, "new_rank": 3, "reason": "#546/#564/#468 shipped; rank stable"}
  ],
  "outcome_summary": "Cycle 25 triage: 15 open issues audited, 0 duplicates, 0 stale (oldest 9 days). Three features shipped (#546 PersistentAnomaliesDigestScheduler, #564 Telegram noise suppression, #468 surge suppression persistence). One new critical bug detected (#587 LLM JSON parsing). ROADMAP updated with 3 newly Completed items and 1 new Critical issue at rank 1. CLAUDE.md verified current — no drift."
}
```

- **2026-04-28 cycle 22**: 16 open issues audited (excl. #565 triage trigger), 0 duplicates, 0 stale (oldest #340 at 9 days). Closed #524 (already resolved by merged PR #547 — agent-variant.ts). Features shipped since cycle 21: PR #559 (Linear client — listIssues), PR #560 (hard scope contract enforcement), PR #562 (OKR-aware supervisor + navel-gazing risk signal), PR #569 (Day-7 survival plan checkpoint + /survival-status). ROADMAP.md: promoted 4 merged PRs to Completed; reordered Next up (546→rank 1, 489→rank 2, 473→3, 468→4, 564→5 new); moved #445 and #496 from Next up to Planned; added #564 and #571 to Planned. CLAUDE.md: added 4 missing scope entries (Linear client, hard scope contracts, OKR-aware supervisor, Day-7 survival checkpoint).

```json
{
  "duplicates_checked": true,
  "stale_issues": [],
  "priority_reordering": [
    {"issue": 546, "old_rank": 2, "new_rank": 1, "reason": "Core quality-system wiring — higher impact than Telegram command"},
    {"issue": 489, "old_rank": 1, "new_rank": 2, "reason": "Still high priority but de-ranked one slot below core wiring"},
    {"issue": 564, "old_rank": null, "new_rank": 5, "reason": "Newly added — operator-requested Telegram noise suppression"}
  ],
  "outcome_summary": "Closed #524 (resolved by merged PR #547). Zero stale, zero duplicate, zero orphan-PR issues. ROADMAP.md updated to cycle 22; CLAUDE.md synced with four newly merged PRs."
}
```

- **2026-04-27 cycle 21**: 14 open issues audited (excl. #557 triage trigger), 0 duplicates, 0 stale (oldest #340 at 8 days). No issues closed. Features shipped since cycle 20: #553 (PR #554 — synthesis-watchdog.ts), #551 (PR #552 — raw GitHub URL detection), orchestrator#1211 (PR #544 — multi-provider reviewer pool + Deepseek R1 integration), #524 (PR #547 — agent variant canonicalization in inflight guard), #440 (PR #540 — /stale-improvements Telegram command). ROADMAP.md: promoted 5 completed items; replaced #524 in Next up with #546 (persistent-anomaly store wiring); added #545 and #555 to Planned; removed #440 from Planned (shipped). CLAUDE.md: added `multi-provider-client.ts`, `reviewer-pool.ts`, `stale-improvements-feed.ts`, `synthesis-watchdog.ts` to Source Layout and Scope; added `agent-variant.ts` to state/ section.

- **2026-04-27 cycle 20**: 14 open issues audited (excl. #537 and #535 triage triggers), 0 duplicates, 0 stale (oldest #340 at 8 days). No issues closed. Feature shipped since cycle 19: #525 (PR #529 — PR guard surge detector cross-variant aggregation). ROADMAP.md: promoted #525 to Completed; removed #525 from Next up rank 3; renumbered ranks 4–7 → 3–6. CLAUDE.md: verified current — no new modules since cycle 19.

```json
{
  "duplicates_checked": true,
  "stale_issues": [],
  "priority_reordering": [
    {
      "issue": 473,
      "old_rank": 4,
      "new_rank": 3,
      "reason": "#525 shipped (PR #529 merged); ranks 4-7 shifted up by one."
    },
    {
      "issue": 468,
      "old_rank": 5,
      "new_rank": 4,
      "reason": "#525 shipped; renumbered."
    },
    {
      "issue": 445,
      "old_rank": 6,
      "new_rank": 5,
      "reason": "#525 shipped; renumbered."
    },
    {
      "issue": 496,
      "old_rank": 7,
      "new_rank": 6,
      "reason": "#525 shipped; renumbered."
    }
  ],
  "outcome_summary": "Cycle 20 triage: 14 open issues audited, 0 duplicates, 0 stale (oldest #340 at 8 days). Feature shipped since cycle 19: #525 (PR #529 — PR guard surge detector cross-variant aggregation). ROADMAP updated to reflect #525 completion and renumber Next up. CLAUDE.md is current with no drift."
}
```

- **2026-04-27 cycle 19**: 15 open issues audited (excl. #531 triage trigger), 0 duplicates, 0 stale (oldest #340 at 8 days). No issues closed. Feature shipped since cycle 18: #485 (PR #528 — score provenance guard wired into `verifier.ts` auto-approval path and Telegram `/approve` command). New issues since cycle 18: #524 (canonicalize agent variants in inflight guard — high, added to Next up rank 2), #525 (surge detector cross-variant aggregation — high, open PR #529, added to Next up rank 3), #526 (sub-threshold bypass audit gap cross-repo follow-up — related to #445, added to Planned), #530 (fleet self-direction cross-repo follow-up — added to Planned). ROADMAP.md: promoted #485 to Completed; removed #485 from Next up rank 1; added #524/#525 to Next up; renumbered remaining items; added #526/#530 to Planned. CLAUDE.md: updated score-provenance scope entry to document `applyDefaultFallbackGuard()` wiring; updated `verifier.ts` source layout description.

```json
{
  "duplicates_checked": true,
  "stale_issues": [],
  "priority_reordering": [
    {
      "issue": 489,
      "old_rank": 2,
      "new_rank": 1,
      "reason": "#485 shipped (PR #528 merged); #489 is the highest-impact unblocked item."
    },
    {
      "issue": 524,
      "old_rank": null,
      "new_rank": 2,
      "reason": "New high-severity issue: cross-variant inflight guard bypass allows duplicate dispatches; directly blocking quality of dispatch deduplication."
    },
    {
      "issue": 525,
      "old_rank": null,
      "new_rank": 3,
      "reason": "New high-severity issue with open PR #529; surge detector cross-variant aggregation gap — in-flight work promoted to Next up."
    }
  ],
  "outcome_summary": "Cycle 19 triage: 15 open issues audited, 0 duplicates, 0 stale (oldest 8 days). One feature shipped (#485 — score provenance guard). Four new issues triaged (#524 → Next up rank 2, #525 → Next up rank 3, #526 → Planned, #530 → Planned). CLAUDE.md updated with applyDefaultFallbackGuard() wiring for verifier.ts and score-provenance scope entry."
}
```

- **2026-04-26 cycle 18**: 13 open issues audited (excl. #522 triage trigger), 0 duplicates, 0 stale (oldest #340 at 7 days). Closed #511 (standup action: PR #599 on agent-dashboard already merged — action complete). Features shipped since cycle 17: #453 (PR #508 — preexisting-failure-tracker.ts), #492 (PR #507 — /supervisor-dispatches agent+date filter). ROADMAP.md: promoted #453/#492 to Completed; removed #453 from Next up; removed In flight section (both PRs shipped); removed closed issues #364/#368/#359 from Planned; added #496 to Next up rank 6 (PR #497 closed without merging); added #514 to Planned. CLAUDE.md: added preexisting-failure-tracker.ts to Scope and Source Layout; updated /supervisor-dispatches description to mention agent+date filters.

```json
{
  "duplicates_checked": true,
  "stale_issues": [
    {
      "number": 511,
      "title": "[standup] Merge PR #599 (dashboard marginal approvals panel, MERGEABLE) to close issue #597",
      "action": "closed",
      "reason": "PR #599 on rapartlu/agent-dashboard merged 2026-04-26 — standup action is complete."
    }
  ],
  "priority_reordering": [
    {
      "issue": 496,
      "old_rank": null,
      "new_rank": 6,
      "reason": "PR #497 closed without merging; score-provenance/summary endpoint still needed — promoted to Next up."
    }
  ],
  "outcome_summary": "Cycle 18 triage: 13 open issues audited, 0 duplicates, 0 stale (oldest 7 days). Closed #511 (standup action already complete). Two features shipped since cycle 17 (#453, #492) moved to Completed. Removed 3 closed issues (#364, #368, #359) from Planned. Added #496 to Next up and #514 to Planned. CLAUDE.md updated with preexisting-failure-tracker.ts module."
}
```

- **2026-04-26 cycle 17**: No duplicate issues found (16 open, all distinct). No stale issues (>14 days) — oldest open issues (#340, #359, #364, #368) are 7 days old. Open PRs audited: #507 (Closes #492) and #497 (Closes #496) — both valid. Five features shipped since cycle 16: #490 (quality-summary.ts), #498 (standup-quality-trend.ts + backfill), #476 (pattern-risk-consumer.ts), #502 (marginal-approvals-feed initial), #504 (marginal-approvals trend). CLAUDE.md: added `pattern-risk-consumer.ts`, `quality-summary.ts`, `marginal-approvals-feed.ts` to source layout and scope. ROADMAP.md: promoted #490/#498/#476/#502/#504 to Completed; removed #490 from Planned; updated In flight to show PRs #507/#497; corrected duplicate #475/#476 entry.

- **2026-04-25 cycle 16**: No duplicate issues found (16 open, all distinct). No stale issues (>14 days) — oldest open issues (#340, #359, #364, #368) are 6 days old, under the 14-day cutoff. Open PRs: #488 (cycle 15 housekeeping) is already merged; no open housekeeping PRs to audit. New issues since cycle 15: #489 (/pr-guard-status command, high priority, added to Next up position 2), #490 (marginal approval rate digest, medium, added to Planned). Priority reordering: #489 promoted to Next up rank 2 (was new/null); #490 added to Planned (new/null). Feature shipped this cycle: `proactive-dispatch-log.ts` + `/supervisor-dispatches` Telegram command (dashboard#570). CLAUDE.md: added `proactive-dispatch-log.ts` module and `/supervisor-dispatches` command to source layout and scope sections. ROADMAP.md: added dashboard#570 to Completed; promoted #489 to Next up rank 2; added #490 to Planned.

```json
{
  "duplicates_checked": true,
  "stale_issues": [],
  "priority_reordering": [
    {
      "issue": 489,
      "old_rank": null,
      "new_rank": 2,
      "reason": "New issue: /pr-guard-status Telegram command is a direct follow-on to the surge suppression work already at rank 3; high operator value."
    },
    {
      "issue": 490,
      "old_rank": null,
      "new_rank": null,
      "reason": "New issue: marginal approval rate digest is medium priority; placed in Planned section."
    }
  ],
  "outcome_summary": "Cycle 16 triage: 16 open issues audited, all distinct, none stale (oldest 6 days). Two new issues added (#489 and #490). Feature shipped: proactive-dispatch-log.ts + /supervisor-dispatches Telegram command. ROADMAP.md and CLAUDE.md updated to reflect the new module and current priority order."
}
```

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
