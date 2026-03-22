# Claude Agent Orchestrator

## What This Is

The orchestrator is the control plane for a fleet of Claude Code agents. Each agent is a persistent Claude session running in a Docker container, managed by the [claude-proxy](https://github.com/rapartlu/claude-proxy). The orchestrator dispatches work, routes tasks, verifies quality, detects improvements, and manages agent lifecycle — including its own.

**The orchestrator is itself an agent** in the system. It can receive improvement issues and work on itself.

## Development Workflow

- **All changes must be made on a feature branch** — never commit directly to `main`.
- **Open a PR for each change** — every feature/fix gets its own branch and pull request.
- **Write tests for all changes** — every new feature or modification must include tests.
- **Tests run locally on commit** — pre-commit hook runs `tsc` and `vitest run`.
- **Tests run on GitHub CI** — GitHub Actions on every push/PR to main.

## How to Use the Orchestrator

### Dispatch Work to Agents

```bash
# Auto-route by keyword matching (falls back to LLM if ambiguous)
orch dispatch "fix the streaming bug"

# Target a specific agent
orch dispatch "update the README" --agent=cheese-hater

# Plan a multi-agent task (breaks into steps with dependencies)
orch dispatch "update the blog about our new MCP tools" --plan

# Preview the plan without executing
orch dispatch "complex task" --plan --dry-run
```

### Ask an Agent Directly

```bash
orch ask "what files do you have?" --agent=cheese-hater
```

Streams the response. Not tracked in state (use `dispatch` for tracked work).

### Check Task Status

```bash
orch status                          # Recent tasks
orch status <task-id>                # Detail + sub-tasks + logs + verification
orch status --agent=cheese-hater     # Filter by agent
orch status --state=failed           # Filter by status
```

### Review PRs

```bash
orch review                              # Review all open PRs across agent repos
orch review rapartlu/cheese-hater        # Review open PRs on a specific repo
orch review rapartlu/cheese-hater -n 9   # Review a specific PR
orch review --dry-run                    # List open PRs without reviewing
```

The PR reviewer reads the diff, evaluates quality, and makes one of three decisions:
- **approve** — code is correct, complete, safe to merge. Posts approval review.
- **request-changes** — specific issues found. Posts review with requested changes.
- **escalate** — needs human eyes (security, architecture, uncertainty). Adds `rapartlu` as reviewer and leaves a comment explaining why.

The daemon runs PR reviews every ~15 minutes automatically.

### Manage Agent Containers

```bash
orch agents                          # List all agents with live container status
orch agents <name>                   # Detail view (config, Docker, status)
orch agents sync                     # Create missing containers, start stopped ones
orch agents sync --dry-run           # Preview sync actions
orch agents sync --remove-unknown    # Also remove containers not in agents.yaml
orch agents redeploy <name>          # Rebuild a specific agent's container
orch agents redeploy                 # Redeploy all agents with new commits
orch agents redeploy --dry-run       # Preview which agents need redeployment
```

### Background Daemon

The daemon runs the full autonomous loop continuously:

```bash
orch service start                   # Start daemon in background
orch service start --foreground      # Attached to terminal (for debugging)
orch service start --poll-interval 60000  # Custom interval (ms)
orch service stop                    # Graceful shutdown
orch service status                  # Show running state + watched sources
```

**The daemon poll cycle (every 5 minutes by default):**

1. **Dispatch triggers** — poll GitHub issues, send Linear/Slack checks to agents
2. **Verify completed tasks** — auto-verify up to 3 unverified tasks per cycle, score quality
3. **Detect improvements** (every ~30min) — analyze task patterns, create issues on agent repos
4. **Review open PRs** (every ~15min) — review agent PRs, approve/request changes/escalate to human
5. **Redeploy stale agents** — rebuild containers when code has new commits
6. **Supervisor review** (every ~15min) — LLM reasons about system state, follows up on gaps

### Quality Verification

```bash
orch improve verify                  # Verify last 5 unverified tasks
orch improve verify -n 10            # Verify last 10
```

The verifier reviews each completed task's result against the original instruction, assigns a quality score (0-1), and marks it approved or rejected. Rejected tasks include revision guidance.

### Improvement Detection

```bash
orch improve detect --dry-run        # Analyze patterns, show what issues would be created
orch improve detect                  # Analyze and create GitHub issues on agent repos
```

The detector analyzes recent task results across all agents, looking for cross-cutting patterns: repeated failures, quality issues, missing capabilities. Creates issues labeled `orchestrator` on affected agent repos.

### Supervisor

```bash
orch supervise --dry-run             # See what the supervisor would do
orch supervise                       # Execute supervisor decisions
```

The supervisor is an LLM-powered strategic reviewer. It looks at the full system state — agents, recent tasks, failures, verification results, unverified work — and decides what needs attention: follow-ups, re-dispatches, issue creation.

## Proxy APIs

The orchestrator communicates with agents through the claude-proxy:

### Messages API (per-agent containers)

Each agent runs on its own port. Messages are sent via the Anthropic SDK:
- **Base URL**: `http://localhost:<agent-port>` (e.g., 3457 for cheese-hater)
- **Auth**: `x-api-key` header with the agent's configured `docker.api_key`
- **Working dir**: `x-working-dir` header (set automatically from agent config)
- **Sessions**: `x-conversation-id` for multi-turn conversations

### Management API (port 3400)

Agent lifecycle management on the host:
- `GET /v1/agents` — list all agents with container status
- `POST /v1/agents` — create agent (generates Dockerfile, starts container)
- `PUT /v1/agents/:name` — update agent (triggers container rebuild)
- `DELETE /v1/agents/:name` — stop and remove agent
- `POST /v1/agents/:name/start|stop` — lifecycle control
- `GET /health` — management API health check

## Routing

Two-tier routing when `--agent` is not specified:

1. **Deterministic** (instant, free): scores agents by keyword/topic/capability matching against the task description. Threshold: `LLM_FALLBACK_THRESHOLD = 0.3`.
2. **LLM fallback** (async, uses tokens): sends the task + agent registry to Claude, asks it to pick the best agent. Enriched with agent success rates from task history.

## Task Planning & Cross-Agent Execution

`--plan` flag decomposes work into a DAG of steps across agents:
- Planner sends task + agent registry to Claude, returns steps with dependencies
- Executor builds layers via topological sort — parallel where possible, sequential where dependent
- Dependent steps receive context from prior step results injected into their message
- Parent task links to sub-tasks via `parent_task_id`

## Trigger Sources

| Source | How it works | Dedup key |
|--------|-------------|-----------|
| GitHub | `gh api` fetches open issues, orchestrator dispatches to owning agent | `repo#number` |
| Linear | Agent checks its own Linear via MCP tools, deduped per agent per hour | `linear-check:agent:hour` |
| Slack | Agent checks its own Slack via MCP tools, deduped per agent per hour | `slack-check:agent:hour` |
| Manual | `orch dispatch` or `orch ask` | N/A |

GitHub results are reported back as issue comments. Linear/Slack agents handle their own reporting via MCP.

## Agent Redeployment

When an agent's codebase has new commits:
- The deployer compares `git rev-parse HEAD` against `.orchestrator-deploy-sha` marker
- If different (or no marker), triggers rebuild via `PUT /v1/agents/:name`
- Marker updated after successful redeploy
- The daemon checks automatically each cycle; `orch agents redeploy` for manual trigger

## PR Review Workflow

When agents create PRs (either from dispatched work or from improvement issues):

1. **Daemon detects open PRs** on agent repos (via `gh pr list`)
2. **Reviewer reads the diff** and evaluates against the task/issue requirements
3. **Decision made:**
   - **Approve** → `gh pr review --approve` with a comment
   - **Request changes** → `gh pr review --request-changes` with specific feedback. The agent picks up the feedback in its next issue check and addresses it.
   - **Escalate** → `gh pr edit --add-reviewer rapartlu` + comment explaining why human review is needed. Use this for: security-sensitive changes, architectural decisions, breaking changes, or when uncertain.
4. **After approval** — PRs can be merged (manually or via the supervisor). The deployer then detects the new commits and rebuilds the agent's container.

**When to escalate to human:**
- Changes to authentication, secrets, or permissions
- Changes that affect multiple agents or the orchestrator itself
- New dependencies or significant architectural shifts
- Anything the reviewer is genuinely uncertain about
- The default when parsing fails is always escalate (safe fallback)

## Self-Improvement Loop

The orchestrator is registered as an agent (`claude-agent-orchestrator` in agents.yaml). The full cycle:

1. Agents complete work → verifier checks quality → scores recorded
2. Improvement detector analyzes patterns across agents (including itself)
3. Creates GitHub issues on affected repos (including its own)
4. Agents pick up issues in next poll cycle → do the work
5. Deployer detects new commits → rebuilds containers
6. Supervisor reviews everything → follows up on gaps

## Configuration (agents.yaml)

```yaml
proxy:
  url: "http://localhost:3457"        # Default agent message URL
  manager_url: "http://localhost:3400" # Management API
  timeout_ms: 300000

base_dir: "/path/to/repos"
orchestrator_dir: "/path/to/this/repo"

verification:
  enabled: true
  sources: ["github", "linear"]       # Which trigger sources get verified
  min_score: 0.7                      # Below this = needs revision

agents:
  agent-name:
    dir: "repo-directory"
    description: "What this agent does"
    capabilities: ["typescript", "api"]
    owns_topics: ["keyword1", "keyword2"]
    github: "owner/repo"              # For GitHub issue polling + reporting
    linear:                           # Agent checks its own Linear
      teams: ["ENG"]
      projects: ["PROJECT-1"]
    slack:                            # Agent checks its own Slack
      channels: ["#engineering"]
      mention_pattern: "@orchestrator"
    docker:
      port: 3457
      api_key: "secret"
      permissions: "auto"
      session: "continue"
```

## Logging

All orchestrator actions, decisions, and errors are logged to both stdout and a persistent log file:

- **Log file**: `~/.claude-orchestrator/logs/orchestrator.log`
- **Format**: `TIMESTAMP [LEVEL] [component] message {json data}`
- **Components**: daemon, dispatcher, verifier, supervisor, improvement-detector, deployer, issue-creator

Every dispatch, routing decision, verification result, supervisor action, redeployment, and error is logged with structured data. Use `tail -f ~/.claude-orchestrator/logs/orchestrator.log` to watch in real-time.

## State Schema

SQLite at `~/.claude-orchestrator/state.db`:

**tasks**: id, title, description, source, source_ref, status, agent_name, conversation_id, result, parent_task_id, step_id, plan, verification_status, quality_score, verification_notes, created_at, updated_at

**task_logs**: id, task_id, direction (to_agent/from_agent/system), agent_name, content, tokens_in, tokens_out, created_at

**processed_triggers**: source, source_ref, task_id, created_at (PK: source + source_ref)

Task statuses: `pending`, `planning`, `dispatched`, `in_progress`, `done`, `failed`

Verification statuses: `null` (unverified), `pending`, `approved`, `rejected`

## Tech Stack

- **Runtime:** Node.js 22+ (ES2022, ESNext modules)
- **Language:** TypeScript (strict mode)
- **CLI:** Commander.js
- **State:** SQLite via better-sqlite3
- **Testing:** Vitest (119 tests across 18 files)
- **Build:** tsc (test files excluded via tsconfig)
- **GitHub API:** `gh` CLI (uses existing auth, no tokens needed)

## Project Structure

```
agents.yaml                              Agent registry
src/
  config/schema.ts                       Config types + YAML loader
  client/
    proxy-client.ts                      Anthropic SDK wrapper (per-agent auth + port)
    agent-client.ts                      Send/stream messages to agents
    management-client.ts                 Proxy management API (lifecycle)
  orchestrator/
    router.ts                            Deterministic routing + LLM fallback
    llm-router.ts                        LLM-based routing via Claude
    planner.ts                           Task decomposition (DAG)
    executor.ts                          Plan execution (parallel/sequential)
    dispatcher.ts                        Dispatch + plan orchestration
    sync.ts                              Desired-state reconciliation
    verifier.ts                          Post-dispatch quality verification
    improvement-detector.ts              Cross-cutting pattern analysis
    issue-creator.ts                     Create GitHub issues on agent repos
    prompt-learner.ts                    Enrich prompts from task history
    deployer.ts                          Agent container redeployment
    supervisor.ts                        Strategic LLM reviewer
    pr-reviewer.ts                       Review PRs: approve, request changes, or escalate
  triggers/
    github.ts                            Fetch issues via gh CLI
    trigger-dispatcher.ts                Route triggers + dedup
    reporters.ts                         Report results back to sources
  state/
    store.ts                             SQLite persistence
  service/
    daemon.ts                            Background poll loop (5-step cycle)
    daemon-entry.ts                      Forked process entry point
    pid.ts                               PID file management
  cli/
    index.ts                             Commander.js entry point
    commands/
      agents.ts                          List/detail/sync/redeploy
      ask.ts                             Interactive Q&A
      dispatch.ts                        Dispatch tasks (direct or planned)
      status.ts                          Task status + verification display
      service.ts                         Daemon start/stop/status
      improve.ts                         Detect improvements + verify tasks
      supervise.ts                       Run supervisor review
      review.ts                          Review open PRs on agent repos
```
