# Claude Agent Orchestrator

Control plane for coordinating multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents. Each agent is a persistent Claude session running in its own Docker container, managed by the [claude-proxy](https://github.com/rapartlu/claude-proxy). The orchestrator dispatches work, routes tasks to the right agent, tracks state, and synchronises desired agent config with running containers.

## How It Works

```
                          ┌─────────────────┐
                          │  Orchestrator    │
                          │  (this repo)     │
                          └───┬─────────┬───┘
                   tasks &    │         │   lifecycle
                   messages   │         │   (create/start/stop)
                              │         │
                ┌─────────────▼─────────▼──────────────┐
                │          claude-proxy                  │
                │  ┌─────────────────────────────────┐  │
                │  │  Management API (/v1/agents)     │  │
                │  │  Agent lifecycle, config, status  │  │
                │  └─────────────────────────────────┘  │
                │  ┌─────────────────────────────────┐  │
                │  │  Messages API (/v1/messages)     │  │
                │  │  Anthropic-compatible, per-agent  │  │
                │  └─────────────────────────────────┘  │
                └──────┬───────────┬───────────┬───────┘
                       │           │           │
                  ┌────▼───┐ ┌────▼───┐ ┌────▼───┐
                  │Agent A │ │Agent B │ │Agent C │
                  │:3460   │ │:3461   │ │:3462   │
                  │(Docker)│ │(Docker)│ │(Docker)│
                  └────────┘ └────────┘ └────────┘
```

- **`agents.yaml`** declares the desired set of agents — their directories, capabilities, topics, and Docker config
- **Routing** matches tasks to agents by keyword/topic, with LLM fallback for ambiguous tasks
- **Planning** decomposes complex tasks into multi-agent plans with dependency ordering
- **Execution** runs plans with parallel fan-out for independent steps, context passing between dependent steps
- **Sync** reconciles `agents.yaml` against the proxy's running containers
- **State** is persisted in SQLite so tasks, logs, and sub-tasks survive restarts

## Prerequisites

- Node.js 22+
- [claude-proxy](https://github.com/rapartlu/claude-proxy) running (for agent communication and management)
- Docker (for containerised agents)

## Setup

```bash
git clone git@github.com:rapartlu/claude-agent-orchestrator.git
cd claude-agent-orchestrator
npm install
npm run build
npm link   # makes `orch` available globally
```

## Configuration

Edit `agents.yaml` at the project root:

```yaml
proxy:
  url: "http://localhost:3457"
  timeout_ms: 300000

llm:
  provider: "auto"                       # optional: auto | claude | codex
  preferred_agent: "claude-orchestrator-reviewer"
  default_model: "claude-sonnet-4-6"     # override to a Codex-compatible model if using a codex reviewer agent
  models:
    reviewer: "claude-sonnet-4-6"
    planner: "claude-sonnet-4-6"
    router: "claude-sonnet-4-6"

base_dir: "/path/to/your/repos"
orchestrator_dir: "/path/to/this/repo"   # used for LLM routing/planning calls

agents:
  my-agent:
    dir: "my-agent-repo"
    description: "What this agent does"
    capabilities: ["typescript", "api-server"]
    owns_topics: ["my-agent", "api"]
    github: "owner/repo"          # optional: for GitHub issue routing
    docker:
      port: 3460
      permissions: "auto"
      session: "continue"
```

### Agent Config Fields

| Field | Required | Description |
|-------|----------|-------------|
| `dir` | yes | Directory name under `base_dir` |
| `description` | yes | What the agent does (used for routing) |
| `capabilities` | yes | Keyword tags for capability matching |
| `owns_topics` | yes | Keywords for task routing |
| `github` | no | `owner/repo` for GitHub issue routing |
| `github_app` | no | Per-agent GitHub App identity used to mint installation tokens |
| `docker.port` | no | Dedicated port for the agent's container |
| `docker.permissions` | no | Claude Code permission mode (`auto`, `plan`, etc.) |
| `docker.session` | no | Session mode (`fresh`, `continue`, `resume`) |

`llm` is optional. It controls orchestrator-side LLM work such as routing, planning, PR review, verification, and supervisor decisions. To switch those calls from Claude to Codex, point `llm.preferred_agent` at a Codex-backed reviewer agent and set Codex-compatible model IDs under `llm.default_model` or `llm.models.*`.

### GitHub App identity migration

The fleet is migrating from a shared Operator PAT to per-agent GitHub App installation tokens. The canonical spec lives in [docs/github-app-identity-migration.md](./docs/github-app-identity-migration.md).

At runtime, the orchestrator should:

- mint one installation token per agent identity,
- inject that token into `GH_TOKEN` and `GITHUB_TOKEN`,
- refresh the token before expiry,
- and keep the token in memory only.

The app spec also defines the minimum repo permissions for each agent role.

## CLI

### List agents

```bash
orch agents                    # list all agents with live container status
orch agents claude-proxy       # detailed view for one agent
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Only for notifications | Telegram bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Only for notifications | Telegram chat ID to receive escalation and recovery alerts |
| `STATE_DB_PATH` | — | Override path to shared SQLite DB (default: `~/.claude-orchestrator/state.db`) |

Copy `.env.example` to `~/.claude-orchestrator/.env` and fill in the values.

## Telegram escalation bot

The `TelegramCommandHandler` exposes a two-way bot that operators can use to approve/reject tasks, trigger reruns, and view system status — all wired to the live `state.db`.

```ts
import { TelegramCommandHandler } from "claude-orchestrator-reviewer";

const handler = new TelegramCommandHandler(store, notify);
handler.start(); // begins polling Telegram for commands
```

### Dispatch a task

```bash
orch dispatch "fix the streaming bug" --agent=claude-proxy
orch dispatch "update the blog post about AI"    # auto-routes to blog-articles
```

When `--agent` is omitted, the router matches the task description against agent topics and capabilities. If confidence is low, it falls back to LLM-based routing (asks Claude to pick the best agent).

### Plan and execute multi-agent tasks

```bash
orch dispatch "update the blog about our new MCP tools" --plan --dry-run   # preview the plan
orch dispatch "update the blog about our new MCP tools" --plan             # plan and execute
```

The `--plan` flag sends the task to Claude to decompose it into steps targeting different agents. Steps with dependencies run sequentially (with context from prior steps injected); independent steps run in parallel.

### Ask an agent

```bash
orch ask "what open issues do you have?" --agent=claude-proxy
```

Streams the response to the terminal.

### Check task status

```bash
orch status                    # list recent tasks
orch status 01HXY...          # detail + sub-tasks + logs (prefix match)
orch status --agent=temporal   # filter by agent
orch status --state=failed     # filter by status
```

Parent tasks from `--plan` dispatches show their sub-task tree with per-step status.

### Sync agents with proxy

```bash
orch agents sync               # create missing, start stopped containers
orch agents sync --dry-run     # preview what would happen
orch agents sync --remove-unknown  # also remove agents not in agents.yaml
```

## Architecture

```
src/
  config/schema.ts               Config types + YAML loader
  client/
    proxy-client.ts              Anthropic SDK wrapper targeting claude-proxy
    agent-client.ts              Send/stream messages to agents
    management-client.ts         Proxy management API (agent lifecycle)
  orchestrator/
    router.ts                    Task → agent routing (deterministic + LLM fallback)
    llm-router.ts                LLM-based routing via Claude
    planner.ts                   Task decomposition into multi-agent plans
    executor.ts                  Plan execution (parallel/sequential, context passing)
    dispatcher.ts                Dispatch tasks, record state, plan orchestration
    sync.ts                      Desired-state reconciliation
  state/
    store.ts                     SQLite persistence (tasks, sub-tasks, logs, triggers)
  cli/                           Commander.js CLI
```

### Key Concepts

**Routing** — Two-tier: deterministic keyword/topic matching runs first (free, fast). If confidence is below 0.3 or there are no matches, the LLM router asks Claude to pick the right agent from the registry.

**Planning** — The planner sends the task + agent registry to Claude and gets back a DAG of steps. Each step targets an agent with explicit dependencies. The plan is validated (agent names exist, no dependency cycles via topological sort).

**Execution** — The executor builds layers from the dependency graph. Steps in the same layer run in parallel (`Promise.all`). Dependent steps receive context from their prerequisites injected into the message. Fails fast on step failure.

**Dispatch** — Single-agent dispatch creates a task, sends the message, logs the exchange. Plan-based dispatch creates a parent task with sub-tasks linked via `parent_task_id`.

**Sync** — Compares agents defined in `agents.yaml` against what the proxy reports via `GET /v1/agents`. Produces actions (create, start, update, remove, skip) and executes them.

**State** — SQLite database at `~/.claude-orchestrator/state.db`:
- `tasks` — dispatched work with status tracking, sub-task linking, plan storage
- `task_logs` — message exchange logs (to/from agent)
- `processed_triggers` — deduplication for automated triggers

## Development

```bash
npm run dev          # run CLI via tsx (no build needed)
npm run build        # compile TypeScript
npm test             # run tests (66 tests across 8 files)
```

Tests run automatically on commit (pre-commit hook) and on push (GitHub Actions CI).

## Roadmap

- [x] Deterministic keyword/topic routing
- [x] LLM-based routing fallback
- [x] Cross-agent coordination (sequential pipelines, parallel fan-out)
- [x] Task planner (break complex tasks into multi-agent sub-tasks)
- [x] Agent sync with Docker containers
- [ ] GitHub issue polling trigger
- [ ] Background daemon with automated poll loop
- [ ] Linear and Slack triggers

## License

MIT
