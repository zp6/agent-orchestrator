# Claude Agent Orchestrator

## Development Workflow

- **All changes must be made on a feature branch** — never commit directly to `main`.
- **Open a PR for each change** — every feature/fix gets its own branch and pull request.
- **Write tests for all changes** — every new feature or modification must include tests that verify the behavior.
- **Tests run locally on commit** — pre-commit hook runs the test suite; commits are blocked if tests fail.
- **Tests run on GitHub CI** — a GitHub Actions pipeline runs tests on every push/PR.

## Project Overview

TypeScript/Node.js orchestrator for coordinating multiple Claude Code agent directories via the [claude-proxy](https://github.com/rapartlu/claude-proxy).

## Tech Stack

- **Runtime:** Node.js (ES2022, ESNext modules)
- **Language:** TypeScript (strict mode)
- **CLI:** Commander.js
- **State:** SQLite via better-sqlite3
- **Testing:** Vitest
- **Build:** tsc

## Key Commands

```bash
npm run dev          # Run CLI via tsx
npm run build        # Compile TypeScript
npm test             # Run tests (vitest)
orch agents          # List configured agents
orch dispatch <msg>  # Dispatch task to an agent
orch ask <q> -a <agent>  # Ask an agent a question
orch status          # View task status
```

## Project Structure

```
src/
  config/schema.ts           — Config types + YAML loader
  client/proxy-client.ts     — Anthropic SDK wrapper → claude-proxy
  client/agent-client.ts     — High-level agent interaction
  orchestrator/router.ts     — Task → agent routing
  orchestrator/dispatcher.ts — Dispatch + state recording
  state/store.ts             — SQLite persistence
  cli/                       — Commander.js CLI
agents.yaml                  — Agent registry
```
