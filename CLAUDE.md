# Claude Orchestrator Reviewer

## What This Is

The quality and oversight layer for the Claude Agent Orchestrator. This repo owns PR review, task verification, supervision, and improvement detection — everything that evaluates and improves agent output quality.

## Scope

**In scope:**
- PR reviewer: review diffs, approve/request-changes/escalate, auto-rebase
- Task verifier: score completed tasks, approve/reject, dispatch revisions
- Supervisor: strategic reasoning about system state, dispatch decisions
- Improvement detector: analyze task patterns, create issues for improvements
- Escalation system: Telegram notifications, dashboard alert queue

**Out of scope (belongs to orchestrator-core):**
- Daemon loop, state store, dispatching infrastructure
- GitHub/Linear/Slack trigger polling
- Agent deployment, container management

**Out of scope (belongs to dashboard):**
- Web UI, CLI commands, activity views

## Tech Stack

- TypeScript
- Anthropic SDK for LLM calls (review, verify, supervise)
- GitHub CLI (`gh`) for PR operations
- Reads/writes to the shared SQLite state.db

## PR Discipline

- One issue, one branch, one PR
- Every PR must include `Closes #N`
- Keep PRs small (<5 files)
- Every commit must end with: `Co-Authored-By: claude-orchestrator-reviewer <claude-orchestrator-reviewer@agent>`
