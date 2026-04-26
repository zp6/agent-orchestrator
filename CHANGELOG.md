# Changelog

All notable changes to `claude-orchestrator-reviewer` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- `MeetingPriorityDispatcher`: rule-based fast-path that auto-dispatches the top-ranked issue from a completed `MeetingOutcome` without LLM judgment when all 7 guards pass. Reduces meeting-to-implementation latency. Exported as `evaluateAutoDispatch()` and `MeetingPriorityDispatcher` from `src/index.ts`. (#464)

---

## [0.1.0] — 2026-04-05

### Added
- Initial public release of the orchestrator reviewer package.
- PR reviewer: review diffs, approve/request-changes/escalate, auto-rebase.
- Task verifier: score completed tasks, approve/reject, dispatch revisions.
- Supervisor: strategic reasoning about system state and dispatch decisions.
- Improvement detector: analyze task patterns, create issues for improvements.
- Escalation system: Telegram notifications and dashboard alert queue.
- GitHub Actions workflow to publish to npm on `v*` tag push, with npm provenance and automatic GitHub Release creation.
