# Claude Agent Orchestrator

## Development Workflow

- **All changes must be made on a feature branch** — never commit directly to `main`.
- **Open a PR for each change** — every feature/fix gets its own branch and pull request.
- **Write tests for all changes** — every new feature or modification must include tests that verify the behavior.
- **Tests run locally on commit** — pre-commit hook runs `tsc --noEmit` and `vitest run`; commits are blocked if either fails.
- **Tests run on GitHub CI** — GitHub Actions runs type checks and tests on every push/PR to main.

## Project Overview

TypeScript/Node.js orchestrator for coordinating multiple Claude Code agent directories via the [claude-proxy](https://github.com/rapartlu/claude-proxy). Each agent is a persistent Claude session running in its own Docker container. The orchestrator is the control plane: it dispatches work, routes tasks, tracks state, and manages agent lifecycle.

## Tech Stack

- **Runtime:** Node.js 22+ (ES2022, ESNext modules)
- **Language:** TypeScript (strict mode)
- **CLI:** Commander.js
- **State:** SQLite via better-sqlite3 (`~/.claude-orchestrator/state.db`)
- **Testing:** Vitest
- **Build:** tsc

## Key Commands

```bash
npm run dev              # Run CLI via tsx (no build needed)
npm run build            # Compile TypeScript to dist/
npm test                 # Run tests (vitest)
npm link                 # Make `orch` available globally
```

### CLI Usage

```bash
orch agents              # List agents with live container status
orch agents <name>       # Agent detail (config + Docker info)
orch agents sync         # Reconcile agents.yaml with proxy containers
orch agents sync --dry-run
orch dispatch <msg>      # Dispatch task to an agent (auto-routed)
orch dispatch <msg> -a <agent>   # Dispatch to specific agent
orch ask <q> -a <agent>  # Ask an agent a question (streams response)
orch status              # View recent tasks
orch status <task-id>    # Task detail with logs
```

## Project Structure

```
agents.yaml                          Agent registry (source of truth for desired state)
src/
  config/schema.ts                   Config types, YAML loader, agent directory resolution
  client/
    proxy-client.ts                  Anthropic SDK wrapper → claude-proxy (x-working-dir header)
    agent-client.ts                  High-level send/stream to agents via proxy
    management-client.ts             Proxy management API client (create/destroy/list/start/stop)
  orchestrator/
    router.ts                        Task → agent routing (keyword + topic matching)
    dispatcher.ts                    Dispatch work, track sessions, record state
    sync.ts                          Desired-state reconciliation (agents.yaml ↔ proxy containers)
  state/
    store.ts                         SQLite persistence (tasks, logs, trigger dedup)
  cli/
    index.ts                         Commander.js entry point
    commands/
      agents.ts                      List/detail/sync agents
      ask.ts                         Interactive Q&A with agent
      dispatch.ts                    Dispatch tasks
      status.ts                      Task status viewer
```

## Agent Communication

Messages are sent to agents via the claude-proxy's Anthropic-compatible API:
- The proxy client wraps the Anthropic SDK with `x-working-dir` headers to target specific agent directories
- Each agent can also have a dedicated Docker container on its own port (configured in `agents.yaml` under `docker.port`)
- The management client talks to the proxy's `/v1/agents` endpoints for container lifecycle

## Agent Config (agents.yaml)

Each agent declares:
- `dir` — directory under `base_dir` containing the agent's repo
- `description` — what the agent does (used in routing and display)
- `capabilities` — keyword tags for matching
- `owns_topics` — routing keywords (task descriptions are matched against these)
- `github` — optional `owner/repo` for GitHub issue routing
- `docker` — optional container config (port, permissions, session mode)

## Routing

The router scores agents against a task description:
1. Exact agent name match in task text → high confidence
2. Topic keyword match → medium confidence
3. Capability keyword match → lower confidence

If no agent matches, the user must specify `--agent` explicitly.
