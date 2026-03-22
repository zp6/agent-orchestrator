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
- **Routing** matches tasks to agents by keyword/topic or explicit targeting
- **Dispatch** sends work to agents via the claude-proxy's Anthropic-compatible API
- **Sync** reconciles `agents.yaml` against the proxy's running containers — creating missing agents, starting stopped ones, and detecting drift
- **State** is persisted in SQLite so tasks and logs survive restarts

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

base_dir: "/path/to/your/repos"

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
| `docker.port` | no | Dedicated port for the agent's container |
| `docker.permissions` | no | Claude Code permission mode (`auto`, `plan`, etc.) |
| `docker.session` | no | Session mode (`fresh`, `continue`, `resume`) |

## CLI

### List agents

```bash
orch agents                    # list all agents with live container status
orch agents claude-proxy       # detailed view for one agent
```

### Dispatch a task

```bash
orch dispatch "fix the streaming bug" --agent=claude-proxy
orch dispatch "update the blog post about AI"    # auto-routes to blog-articles
```

When `--agent` is omitted, the router matches the task description against agent topics and capabilities to pick the best target.

### Ask an agent

```bash
orch ask "what open issues do you have?" --agent=claude-proxy
```

Streams the response to the terminal.

### Check task status

```bash
orch status                    # list recent tasks
orch status 01HXY...          # detail + logs for a specific task (prefix match)
orch status --agent=temporal   # filter by agent
orch status --state=failed     # filter by status
```

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
  client/proxy-client.ts         Anthropic SDK wrapper targeting claude-proxy
  client/agent-client.ts         Send/stream messages to agents
  client/management-client.ts    Proxy management API (agent lifecycle)
  orchestrator/router.ts         Task → agent routing (keyword matching)
  orchestrator/dispatcher.ts     Dispatch tasks, record state
  orchestrator/sync.ts           Desired-state reconciliation
  state/store.ts                 SQLite persistence (tasks, logs, triggers)
  cli/                           Commander.js CLI
```

### Key Concepts

**Routing** — The router scores each agent against the task description using topic keywords, capability tags, and agent name mentions. The highest-confidence match wins. When no agent matches, the user must specify `--agent` explicitly.

**Dispatch** — Creates a task in SQLite, sends the message to the agent via the proxy, logs the interaction, and updates the task status (done/failed).

**Sync** — Compares agents defined in `agents.yaml` against what the proxy reports via `GET /v1/agents`. Produces a plan of actions (create, start, update, remove, skip) and executes it.

**State** — SQLite database at `~/.claude-orchestrator/state.db` with three tables:
- `tasks` — dispatched work with status tracking
- `task_logs` — message exchange logs (to/from agent)
- `processed_triggers` — deduplication for automated triggers

## Development

```bash
npm run dev          # run CLI via tsx (no build needed)
npm run build        # compile TypeScript
npm test             # run tests
```

Tests run automatically on commit (pre-commit hook) and on push (GitHub Actions CI).

## Roadmap

- [ ] LLM-based routing fallback (ask Claude to pick the right agent)
- [ ] Cross-agent coordination (sequential pipelines, parallel fan-out)
- [ ] Task planner (break complex tasks into multi-agent sub-tasks)
- [ ] GitHub issue polling trigger
- [ ] Background daemon with automated poll loop
- [ ] Linear and Slack triggers

## License

MIT
