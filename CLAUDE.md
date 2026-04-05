# Claude Orchestrator Reviewer

## What This Is

The quality and oversight layer for the Claude Agent Orchestrator. This repo owns PR review, task verification, supervision, and improvement detection — everything that evaluates and improves agent output quality.

**This container also serves as the LLM backend for the orchestrator.** All PR reviews, task verifications, supervisor decisions, and improvement analysis are routed through this container. Keep it lightweight and responsive.

## System Architecture (context for reviews)

The orchestrator manages a fleet of Claude Code agents, each in a Docker container:

| Agent | Repo | Port | Purpose |
|-------|------|------|---------|
| claude-agent-orchestrator | claude-agent-orchestrator | 3472 | Core daemon, state store, dispatching, triggers |
| claude-orchestrator-dashboard | claude-orchestrator-dashboard | 3473 | Dashboard UI, CLI commands, metrics |
| claude-orchestrator-reviewer | claude-orchestrator-reviewer | 3474 | **This repo** — PR review, verification, supervisor |
| claude-proxy | claude-proxy | 3471 | Proxy server wrapping Claude CLI sessions |

**Daemon loop** runs every 30s: poll GitHub issues → dispatch to agents → verify quality → review PRs → detect improvements → supervisor decisions.

**PR review flow**: reviewer reads diff → LLM evaluates → approve (merge via squash) / request-changes (dispatch feedback to agent) / escalate (notify human via Telegram).

**Task verification**: completed tasks are scored 0-1 by an LLM. Below min_score → revision feedback dispatched back to agent.

**Key conventions:**
- Every PR must have `Closes #N` in the body
- Agents use `Co-Authored-By: <agent-name> <agent-name@agent>` in commits
- One issue, one branch, one PR — no bundling
- PRs with merge conflicts get auto-rebased; if rebase fails, escalate

## Review Guidelines

When this container is used for LLM PR reviews:
- **Default to approve.** Most PRs that work correctly should be approved.
- Only request changes for **real bugs**: runtime failures, security vulnerabilities, data loss.
- **Never block** on style, naming, missing comments, or "could be cleaner" suggestions.
- If minor issues exist, include them in an approval comment.

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
