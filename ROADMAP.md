# Roadmap — claude-orchestrator-reviewer

_Last updated: 2026-04-13_

## Next up

- **#129 — Structured output schema for research tasks** (PR #130 open): Add a typed output schema so research agent results are validated at review time, catching malformed or incomplete research output before it reaches the supervisor.
- **#89 — Second-pass outcome tracking**: The borderline second-pass review trigger (0.70–0.79) shipped in PR #83, but there is no tracking of whether second passes improve outcomes. Add a metric: tasks entering second-pass, upgrade vs. reject rate, and final merged quality scores.
- **#99 — SCHEMA_CONSUMER_MAP auto-discovery**: Replace the hardcoded static registry in `schema-impact.ts` with a live discovery query against state.db access logs. Keeps schema-consumer impact detection accurate as the fleet evolves without manual file updates.

## Planned

- **#107 — Reroute quality tracking**: Flag agents where rerouting degrades outcomes. Per-agent quality metrics already exist in `routing-accuracy.ts`; needs outcome comparison logic for rerouted vs. original-agent tasks.
- **#51 — Conflict-risk annotations in PR review comments**: Surface conflict-risk signals inline in PR review comments (e.g. when a diff touches a file also modified by another open PR), giving reviewers more context before approving.
- **#103 — Security scanner allowlist sync**: Keep the PR review rubric's credential false-positive allowlist (example/template files) in sync with the security scanner allowlist to prevent independent drift.

## Ideas

- **Second-pass effectiveness Telegram card**: Surface second-pass upgrade/reject rates in `/status` summary so operators can tune the 0.70 threshold based on data.
- **Supervisor dry-run mode**: A `--dry-run` flag on `supervisor.ts` that logs dispatch decisions to stdout without writing to state.db — useful for debugging the supervision loop in staging.
- **Configurable escalation thresholds**: Allow per-agent `feedback_ceiling` and `min_score` overrides in `ReviewerConfig` rather than a single global setting.
- **Improvement detector cron**: Run `ImprovementDetector.analyze()` on a scheduled cadence (every 6h) and auto-file GitHub issues for detected patterns.
- **Review score history**: Persist `VerificationResult` scores in state.db so the improvement detector can spot regression trends across deploys.
