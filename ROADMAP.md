# Roadmap — claude-orchestrator-reviewer

## Next up

- **#1 — Bootstrap TypeScript scaffold** (PR #13 open): Finalize the initial project scaffold with PR review, verification, supervision, and improvement-detector modules fully wired up.
- **#7 — Wire reviewer into orchestrator daemon** (PR #10 open): `createReviewerInstances()` adapter + type compatibility fixes so the orchestrator imports from this package directly.
- **#4 — Wire Telegram commands to live state.db queries**: `/status`, `/tasks`, `/approve` commands in the Telegram bot should query the shared SQLite state.db in real time rather than returning stubs.

## Planned

- **#2 — Telegram two-way communication**: Operator commands via bot — approve/reject tasks, trigger reruns, escalate to human — all wired to live state.
- **#9 — Publish package to npm registry**: Versioned releases so the orchestrator can pin `claude-orchestrator-reviewer@x.y.z` in `package.json` instead of a GitHub ref.
- **Improvement detector scheduling**: Run `ImprovementDetector.analyze()` on a cron cadence (e.g. every 6 hours) and auto-file GitHub issues for patterns found.
- **Supervisor dry-run mode**: A `--dry-run` flag that logs decisions without writing to state.db — useful for debugging the supervision loop.

## Ideas

- **PR review dashboard integration**: Push review decisions and scores to the dashboard's alert queue so operators can see quality trends over time.
- **Configurable escalation thresholds**: Allow per-agent `feedback_ceiling` overrides in config rather than a single global setting.
- **Review score history**: Persist `VerificationResult` scores in state.db so the improvement detector can spot regression trends across deploys.
