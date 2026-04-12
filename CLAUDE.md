# Claude Agent Orchestrator

## What This Is

The orchestrator is the control plane for a fleet of AI coding agents. Each agent is a persistent CLI session running in a Docker container, managed by the proxy. The orchestrator dispatches work, routes tasks, verifies quality, detects improvements, and manages agent lifecycle.

## Architecture

### Agent Fleet (8 agents across 6 repos)

| Agent | Port | Model | Pool | Purpose |
|-------|------|-------|------|---------|
| claude-agent-orchestrator | 3472 | Opus | — | Core daemon, state store, dispatching, triggers |
| claude-orchestrator-dashboard | 3473 | Sonnet | — | Dashboard UI, CLI commands, metrics |
| claude-orchestrator-reviewer | 3474 | Sonnet | reviewer | PR review, verification, supervisor (primary) |
| claude-orchestrator-reviewer-2 | 3475 | Sonnet | reviewer | Reviewer pool instance 2 |
| claude-orchestrator-telegram | 3477 | Haiku | — | Telegram command handling |
| claude-research-agent | 3478 | Opus | — | Research, investigation, technology evaluation |
| claude-proxy | 3471 | Opus | — | Proxy server, container management |

### Repos

| Repo | Owner | Scope |
|------|-------|-------|
| `rapartlu/agent-orchestrator` | This repo | Daemon, state, dispatching, routing, triggers |
| `rapartlu/agent-dashboard` | Dashboard agent | Web dashboard, CLI, metrics |
| `rapartlu/agent-reviewer` | Reviewer pool | PR review, verification, supervisor |
| `rapartlu/research-agent` | Research agent | Findings reports, technology evaluation |
| `rapartlu/agent-proxy` | Proxy agent | CLI wrapper, container management |

### Key Features

- **Agent pools** — multiple instances share workload via round-robin (reviewer pool: 2 instances)
- **Persistent sessions** — conversations resume across requests via `x-conversation-id` header
- **Per-agent models** — Opus for coding, Sonnet for reviews, Haiku for Telegram
- **Auto-rebase** — pre-submit validator auto-rebases stale branches before PR creation
- **Telegram bot** — two-way communication: `@TheSupervisor_rapartlu_bot`
- **Multi-provider ready** — OpenAI Codex CLI integration in progress

## CRITICAL: NEVER Push Directly to Main

**ALL changes MUST go through a PR.** No exceptions, no "quick fixes", no "just a config change."

1. Create a feature branch: `git checkout -b fix/description`
2. Commit your changes
3. Push and create a PR: `gh pr create`
4. Wait for review/merge

## CRITICAL: Scope Boundaries

This repo owns **core infrastructure only**:

**Owns:** daemon loop, state store (SQLite), task dispatching, trigger polling, agent deployment/sync, routing, planning, execution, Telegram bot.

**Does NOT own:**
- Dashboard, CLI UI → `rapartlu/agent-dashboard`
- PR reviewer, verifier, supervisor → `rapartlu/agent-reviewer`
- Proxy server, containers → `rapartlu/agent-proxy`
- Research reports → `rapartlu/research-agent`

## Management API

Agent lifecycle via the proxy management API (port 3400):

```bash
# List agents
curl http://localhost:3400/v1/agents

# Create agent
curl -X POST http://localhost:3400/v1/agents -H "Content-Type: application/json" \
  -d '{"name":"...", "project":"...", "port":3472, "session":"fresh", ...}'

# Update/rebuild agent
curl -X PUT http://localhost:3400/v1/agents/<name> -H "Content-Type: application/json" -d '{...}'

# Start/stop
curl -X POST http://localhost:3400/v1/agents/<name>/start
curl -X POST http://localhost:3400/v1/agents/<name>/stop

# Rebuild Docker image (all agents get new image on next recreate)
curl -X POST http://localhost:3400/v1/rebuild

# Delete
curl -X DELETE http://localhost:3400/v1/agents/<name>
```

**Important:** The management API is in-memory — registrations are lost on proxy restart. The daemon syncs agents on startup from `agents.yaml`.

## Telegram Bot

Two-way communication via `@TheSupervisor_rapartlu_bot`:

| Command | What it does |
|---------|-------------|
| `s` / `summary` | Executive briefing: health, shipped, attention, WIP |
| `stats` | Detailed metrics: throughput, backlog, pool distribution |
| `status` | Agent status |
| `health` | Ping all containers |
| `issues` | Open issues across repos |
| `prs` | Open PRs across repos |
| `chat <agent> <msg>` | Direct conversation (persistent) |
| `newchat <agent>` | Reset conversation |
| `issue <idea>` | Create issue from rough description |
| `dispatch <agent> <msg>` | Send task to agent |

Telegram polls independently every 3 seconds (not tied to daemon cycles).
Config: `~/.claude-orchestrator/.env` (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).

## Daemon Poll Cycle

Every 30s:
1. **Telegram polling** (independent 3s loop)
2. **Stale task watchdog** — kill tasks stuck >10 min (configurable per agent)
3. **Retry failed tasks** — exponential backoff, 3 retries max
4. **Dispatch triggers** — poll GitHub issues, dispatch to agents (pool-aware)
5. **Verify completed tasks** — LLM scores quality, dispatches revisions
6. **Create orphan PRs** — auto-rebase stale branches, create PRs
7. **Review open PRs** — approve/merge, request changes, or escalate
8. **Merge queue** — sequential merges per repo to avoid conflicts
9. **Redeploy stale agents** — skip busy agents, health check after deploy
10. **Preventive restart** — every ~50 min, restart idle containers
11. **Supervisor** — strategic reasoning, dispatch decisions
12. **Backlog triage** — every ~5h, dispatch housekeeping to agents

## Pool Routing

Agents with the same `pool` field in `agents.yaml` share workload:

- **LLM calls** (reviews, verification, supervisor): round-robin across pool members
- **Dispatched tasks**: picks first idle pool member
- **Router**: scores one agent per pool, dispatcher resolves to idle instance
- **Dedup**: source_ref-based (pool-safe)

## Session Persistence

Conversations persist across requests:
- Orchestrator generates `conversation_id` per task (stored in DB)
- Passed as `x-conversation-id` header to proxy
- Proxy maps to CLI session UUID via `--resume`
- Session map persisted to disk (`~/.claude/session-map.json`)
- Telegram chat conversations persisted to `~/.claude-orchestrator/telegram-chats.json`

## Configuration (agents.yaml)

```yaml
proxy:
  url: "http://localhost:3457"
  manager_url: "http://localhost:3400"
  timeout_ms: 900000
  ssh_key: "~/.ssh/claude-proxy-agents"

agents:
  agent-name:
    dir: "repo-directory"
    repo: "git@github.com:owner/repo.git"  # enables auto-deploy + volume isolation
    pool: "pool-name"                       # optional: pool for load balancing
    model: "claude-opus-4-6"                # per-agent model selection
    description: "What this agent does"
    capabilities: ["typescript", "api"]
    owns_topics: ["keyword1", "keyword2"]
    github: "owner/repo"                    # for GitHub issue polling
    docker:
      port: 3472
      api_key: "secret"
      permissions: "bypassPermissions"
      session: "fresh"
```

## Tech Stack

- **Runtime:** Node.js 22+ (ES2022, ESNext modules)
- **Language:** TypeScript (strict mode)
- **CLI:** Commander.js
- **State:** SQLite via better-sqlite3
- **Build:** tsc (test files excluded via tsconfig)
- **GitHub API:** `gh` CLI

## Monitoring Session — Proactive Recovery

This session runs the health monitoring loop and **owns the daemon lifecycle**. When something is broken and a fix is available, execute it immediately — do not report the same issue across multiple checks.

### Automated recovery actions (no confirmation needed)

| Condition | Action |
|-----------|--------|
| Daemon PID missing or process dead | Start: `cd /Users/paultarr/Local/Git/claude-agent-orchestrator && nohup node dist/service/daemon-entry.js --poll-interval 300000 > /dev/null 2>&1 &` |
| Stale PID file (file exists, process dead) | `rm ~/.claude-orchestrator/daemon.pid` then start daemon |
| Daemon running but no new log lines for >15 min | Kill PID and restart |
| Same agents failing deployer health checks 2+ consecutive cycles | `curl -X POST http://localhost:3400/v1/rebuild` |

### After any recovery action
- Verify it worked: check PID alive, agents healthy, new log activity
- Report what was done and the result
- If the issue recurs after recovery, file a GitHub issue in `rapartlu/agent-orchestrator`

### Health check cadence
Each check must verify all 6 points: daemon PID, latest cycle timestamp, ERROR lines in last 2 min, task status counts (done/failed/in_progress/escalated), agent health via `curl http://localhost:3400/v1/agents`, and report issues or confirm healthy.

## PR Discipline

- One issue, one branch, one PR
- Every PR must include `Closes #N`
- Keep PRs small (<5 files)
- Every commit: `Co-Authored-By: <agent-name> <agent-name@agent>`
- Don't fix unrelated things — create new issues
- Don't add meta-tooling unless asked
