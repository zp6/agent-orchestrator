# Claude Agent Orchestrator

## Development Workflow

- **All changes must be made on a feature branch** — never commit directly to `main`.
- **Open a PR for each change** — every feature/fix gets its own branch and pull request.
- **Write tests for all changes** — every new feature or modification must include tests that verify the behavior.
- **Tests run locally on commit** — pre-commit hook runs `tsc` and `vitest run`; commits are blocked if either fails.
- **Tests run on GitHub CI** — GitHub Actions runs type checks and tests on every push/PR to main.

## Project Overview

TypeScript/Node.js orchestrator for coordinating multiple Claude Code agent directories via the [claude-proxy](https://github.com/rapartlu/claude-proxy). Each agent is a persistent Claude session running in its own Docker container. The orchestrator is the control plane: it dispatches work, routes tasks (with LLM fallback), plans multi-agent workflows, and manages agent lifecycle.

## Tech Stack

- **Runtime:** Node.js 22+ (ES2022, ESNext modules)
- **Language:** TypeScript (strict mode)
- **CLI:** Commander.js
- **State:** SQLite via better-sqlite3 (`~/.claude-orchestrator/state.db`)
- **Testing:** Vitest (66 tests across 8 files)
- **Build:** tsc (test files excluded via tsconfig)

## Key Commands

```bash
npm run dev              # Run CLI via tsx (no build needed)
npm run build            # Compile TypeScript to dist/
npm test                 # Run tests (vitest)
npm link                 # Make `orch` available globally
```

### CLI Usage

```bash
orch agents                          # List agents with live container status
orch agents <name>                   # Agent detail (config + Docker info)
orch agents sync                     # Reconcile agents.yaml with proxy containers
orch agents sync --dry-run
orch dispatch <msg>                  # Dispatch task (auto-routed, LLM fallback)
orch dispatch <msg> -a <agent>       # Dispatch to specific agent
orch dispatch <msg> --plan           # Plan and execute multi-agent task
orch dispatch <msg> --plan --dry-run # Preview plan without executing
orch ask <q> -a <agent>              # Ask an agent a question (streams response)
orch status                          # View recent tasks
orch status <task-id>                # Task detail with sub-tasks and logs
```

## Project Structure

```
agents.yaml                              Agent registry (source of truth)
src/
  config/schema.ts                       Config types, YAML loader, orchestrator_dir
  client/
    proxy-client.ts                      Anthropic SDK wrapper → claude-proxy
    agent-client.ts                      High-level send/stream to agents
    management-client.ts                 Proxy management API (agent lifecycle)
  orchestrator/
    router.ts                            Deterministic routing + LLM fallback integration
    llm-router.ts                        LLM-based routing via Claude (fallback)
    planner.ts                           Task decomposition into multi-agent plans (DAG)
    executor.ts                          Plan execution (parallel fan-out, context passing)
    dispatcher.ts                        Single + multi-agent dispatch, state recording
    sync.ts                              Desired-state reconciliation (agents.yaml ↔ proxy)
  state/
    store.ts                             SQLite persistence (tasks, sub-tasks, logs, triggers)
  cli/
    index.ts                             Commander.js entry point
    commands/
      agents.ts                          List/detail/sync agents
      ask.ts                             Interactive Q&A with agent
      dispatch.ts                        Dispatch tasks (direct or planned)
      status.ts                          Task status viewer (with sub-task tree)
```

## Routing

Two-tier routing:
1. **Deterministic** (sync, free): scores agents by keyword/topic/capability matching
2. **LLM fallback** (async, uses tokens): when deterministic confidence < 0.3, asks Claude to pick the best agent from the registry

Threshold constant: `LLM_FALLBACK_THRESHOLD` in `router.ts`.

## Task Planning

`orch dispatch --plan` sends the task + agent registry to Claude, which returns a DAG of steps:
- Each step targets a specific agent with explicit dependencies
- Validated: agent names must exist, no dependency cycles (topological sort)
- Single-agent tasks pass through to normal dispatch
- Multi-agent plans create a parent task with linked sub-tasks

## Cross-Agent Execution

The executor builds layers from the dependency DAG:
- Steps with no unresolved dependencies run in parallel (`Promise.all`)
- Dependent steps get context from prior step results injected into their message
- Fail-fast on step failure; parent task marked failed

## State Schema

SQLite at `~/.claude-orchestrator/state.db`:
- `tasks` — id, title, description, source, status, agent_name, conversation_id, result, parent_task_id, step_id, plan
- `task_logs` — direction (to_agent/from_agent/system), content, tokens
- `processed_triggers` — deduplication for automated triggers

Task statuses: `pending`, `planning`, `dispatched`, `in_progress`, `done`, `failed`

## Agent Config (agents.yaml)

Each agent declares:
- `dir` — directory under `base_dir` containing the agent's repo
- `description` — what the agent does (used in routing, planning, and display)
- `capabilities` — keyword tags for matching
- `owns_topics` — routing keywords
- `github` — optional `owner/repo` for GitHub issue routing
- `docker` — optional container config (port, permissions, session mode)

Top-level `orchestrator_dir` — the orchestrator's own working directory, used for LLM routing and planning calls via the proxy.
