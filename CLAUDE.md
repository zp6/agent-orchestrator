# Claude Agent Orchestrator

## What This Is

The orchestrator is the control plane for a fleet of AI coding agents. Each agent is a persistent CLI session running in a Docker container, managed by the proxy. The orchestrator dispatches work, routes tasks, verifies quality, detects improvements, and manages agent lifecycle.

## Architecture

### Agent Fleet (7 Claude agents across 6 repos)

> **Note:** Codex (OpenAI) pool variants are currently disabled — out of tokens. Infrastructure remains in place for re-enablement.

| Agent | Port | Model | Pool | Purpose |
|-------|------|-------|------|---------|
| claude-agent-orchestrator | 3472 | claude-opus-4-6 | orchestrator | Core daemon, state store, dispatching, triggers |
| claude-orchestrator-reviewer | 3474 | claude-sonnet-4-6 | reviewer | PR review, verification, supervisor |
| claude-orchestrator-dashboard | 3473 | claude-sonnet-4-6 | dashboard | Dashboard UI, CLI commands, metrics |
| claude-orchestrator-telegram | 3477 | claude-haiku-4-5 | — | Telegram command handling |
| claude-research-agent | 3478 | claude-opus-4-6 | research | Research, investigation, technology evaluation |
| claude-proxy | 3471 | claude-opus-4-6 | proxy | Proxy server, container management |
| meeting-facilitator-agent | 3485 | claude-sonnet-4-6 | — | Meeting facilitation, structured discussions |

### Repos

| Repo | Owner | Scope |
|------|-------|-------|
| `rapartlu/agent-orchestrator` | This repo | Daemon, state, dispatching, routing, triggers |
| `rapartlu/agent-dashboard` | Dashboard agent | Web dashboard, CLI, metrics |
| `rapartlu/agent-reviewer` | Reviewer pool | PR review, verification, supervisor |
| `rapartlu/research-agent` | Research agent | Findings reports, technology evaluation |
| `rapartlu/agent-proxy` | Proxy agent | CLI wrapper, container management |

### Key Features

- **Multi-provider pools** — infrastructure supports Claude + Codex in parallel (Codex currently disabled)
- **Agent pools** — multiple instances share workload via round-robin (orchestrator, reviewer, dashboard, research, proxy)
- **Persistent sessions** — conversations resume across requests via `x-conversation-id` header
- **Per-agent models** — Opus for coding, Sonnet for reviews, Haiku for Telegram
- **Auto-rebase** — pre-submit validator auto-rebases stale branches before PR creation; proactive rebase scheduler (~15min cadence) prevents stale-branch build failures
- **Telegram bot** — two-way communication: `@TheSupervisor_rapartlu_bot`
- **Antibody log** — pre-dispatch failure prediction filter; blocks known-bad agent/task combos
- **Daemon lifecycle auditor** — immutable audit trail of daemon start/stop/restart events
- **Iteration cost tracking** — per-PR revision cost leaderboard with automatic improvement issue routing
- **Cross-repo feature tracker** — detects feature consistency gaps across Claude/Codex pool members
- **Health check postmortem** — auto-files structured incident reports for recurring health failures
- **Verification calibration** — logs verification outcomes (`verification_outcome_logs`) and polls PR events to build quality-score training data
- **Semantic task memory** — FTS5-based knowledge store; top-3 similar past successes injected into dispatch context at runtime; auto-tunes `min_quality_score` threshold via FTS5 query analysis with per-agent breakdown (issues #1011, #1033)
- **Dispatch cascade analyzer** — tracks parent→child task relationships; enforces per-trigger follow-up depth cap to prevent unbounded task spawning
- **Post-merge regression detector** — validates merged PRs in staging; auto-files revert tasks on regressions
- **Metrics server** — embedded HTTP server on port 3472 exposing `/dispatch-efficiency`, `/health`, `/semantic-memory-effectiveness`, `/investigations`, and `/misrouting` for dashboard and operator polling
- **Housekeeping triage schemas** — verifier enforces structured JSON blocks in housekeeping PR bodies (`TRIAGE_HOUSEKEEPING_SCHEMA`, `TRIAGE_CROSS_REPO_SCHEMA`); missing fields trigger immediate revision
- **Prompt caching** — all static LLM system prompts cached via Anthropic `cache_control: { type: 'ephemeral' }`; dynamic config portions kept variable to avoid cache invalidation; reduces token spend on repeated supervisor/verifier calls (issue #1037)
- **Dispatch waste rate alerting** — `getDispatchWasteMetrics24h()` tracks per-hour rolling window; Telegram alert fires when waste rate exceeds 15% in the most recent hour (`DISPATCH_WASTE_RATE_THRESHOLD = 0.15`) (issue #991)
- **Cross-repo PR guard** — pre-dispatch validator checks all peer agent repos (`config.agents[*].github`) for open non-draft PRs before dispatching; blocks with failure code `open_pr_exists_cross_repo` (issue #991)
- **Dispatch flood gate** — after the PR existence guard fires for a given issue, subsequent guard re-fires within a 60-minute cooldown window (`GUARD_FLOOD_GATE_WINDOW_MS = 3_600_000`) are silently dropped — no task created, no block recorded, no Telegram alert; only the first hit within the window creates a task and sends an alert (issue #1060)
- **Resilient team meetings** — if all agents return connection errors in a standup (e.g. Docker outage), the meeting is abandoned without saving to the DB, so the time-based scheduler retries on the next cycle rather than waiting the full 24-hour cooldown (issue #1053)
- **Live meeting context injection** — before each standup, open issues (up to 15/repo), open PRs (up to 10/repo), and 7-day task stats are queried via `gh` CLI and injected into meeting context; prevents agents citing stale or closed issues during standups (issue #1069)
- **Research agent misrouting enforcement** — `capability_tags: ["research-only"]` set on `claude-research-agent` in `agents.yaml`; implementation tasks dispatched to the research agent are blocked and rerouted at dispatch time; `GET /misrouting` metrics endpoint and Slack digest alert for observability (issue #1077)
- **Predictive failure interception** — before every dispatch, scores incoming task title against recent failed tasks via token-overlap Jaccard similarity; injects top-3 failure post-mortems as "Lessons from Similar Failed Tasks" when similarity ≥ 0.6 (`FAILURE_INTERCEPTION_THRESHOLD`); sends Telegram alert at ≥ 0.75; records hits to `failure_interception_logs` table; `GET /failure-interceptions` metrics endpoint (issue #1086/#1093)
- **DAG-based parallel subtask execution** — `DagRuntime` in `src/orchestrator/dag-runtime.ts` decomposes complex multi-agent tasks into a persistent dependency graph (`dag_executions` + `dag_nodes` tables); dispatches independent leaf nodes in parallel (up to 4); gates downstream nodes on upstream completions; non-blocking — `advanceAll()` is called each daemon cycle without blocking the poll loop (issue #1085/#1094)
- **Live operator control plane** — `OperatorControlProcessor` in `src/service/operator-controls.ts` applies pending Telegram-issued directives (pause, resume, redirect, inject, merge) at the start of each daemon cycle before other work is dispatched; directives are persisted to `operator_controls` table and marked applied/failed per execution (issue #1087/#1092)

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

Every 5 minutes (default; configurable via `--poll-interval`):
1. **Telegram polling** (independent 3s loop)
2. **Stale task watchdog** — kill tasks stuck >10 min (configurable per agent)
3. **Retry failed tasks** — exponential backoff, 3 retries max
4. **Dispatch triggers** — poll GitHub issues, dispatch to agents (pool-aware, with semantic memory context injection); cross-repo PR guard checks all peer repos before dispatching to block `open_pr_exists_cross_repo` failures
5. **Verify completed tasks** — LLM scores quality, dispatches revisions; enforces housekeeping triage schema
6. **Create orphan PRs** — auto-rebase stale branches, create PRs
7. **Proactive rebase** — every ~15min, rebase stale branches before they fall behind origin/main
8. **Review open PRs** — approve/merge, request changes, or escalate
9. **Merge queue** — sequential merges per repo to avoid conflicts; cascade cap enforced pre-merge
10. **Redeploy stale agents** — skip busy agents, health check after deploy
11. **Preventive restart** — every ~50 min, restart idle containers
12. **Supervisor** — every ~15min, strategic reasoning, dispatch decisions
13. **Backlog triage** — every ~5h, dispatch housekeeping to agents (staggered by `housekeeping_offset_cycles`)
14. **Post-merge regression check** — validates staging after merges, auto-files revert tasks on failures
15. **Semantic memory audit** — every ~24h, evaluates FTS5 memory effectiveness (zero-match rate tracking, query quality analysis), auto-tunes `min_quality_score` threshold, and provides per-agent memory breakdown
16. **Roadmap proposals** — every ~24h, proposes new issues based on coverage gap detection

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

verification:
  enabled: true
  sources: ["github", "linear"]
  min_score: 0.7      # minimum quality score to approve a task
  max_revisions: 1    # max LLM-driven revision attempts per task

escalation:
  retry_limit: 3
  max_followup_depth: 3   # cap follow-up chain depth before routing to escalation queue

# Optional: define custom task types (built-ins: implementation, research, facilitation)
task_types:
  planning:
    verification_prompt: "..."
    prompt_header: Planning Request
    result_header: Agent Plan
    dimensions: [feasibility, completeness, risk_assessment, clarity]

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
    housekeeping_offset_cycles: 0           # stagger housekeeping within each 5h window
    auto_reroute_rejection_threshold: 4     # auto-reroute after N consecutive rejections
    docker:
      port: 3472
      api_key: "secret"
      permissions: "bypassPermissions"
      session: "fresh"
```

## Metrics Server

An embedded HTTP server starts alongside the daemon on port **3472** (same as the agent port; bound to 127.0.0.1). It is started via `startMetricsServer()` in `src/service/metrics-server.ts`.

| Endpoint | Description |
|----------|-------------|
| `GET /dispatch-efficiency` | 7-day rolling dispatch block-rate metrics (configurable via `?days=N`) |
| `GET /health` | Basic liveness check — returns `{"status":"ok"}` |
| `GET /semantic-memory-effectiveness` | Semantic memory effectiveness metrics (match rates, latency, usefulness) over configurable window (`?days=N`) |
| `GET /investigations` | Research investigation feed — paginated task list with status/quality filters (`?limit=N&offset=N&status=done`) |
| `GET /misrouting` | Research agent implementation-task misroute feed — count + quality histogram for tasks dispatched to research-only agents (`?agent=claude-research-agent&days=N`) |
| `GET /failure-interceptions` | Predictive failure interception feed — interception events with similarity scores, lesson counts, model upgrade suggestions, and final outcomes (`?days=N`) |

The dashboard agent polls `/dispatch-efficiency` to populate the dispatch efficiency panel without needing CLI access.

## CLI Commands (`orch`)

The `orch` CLI is built from `src/cli/index.ts`. Key command groups:

| Command | Description |
|---------|-------------|
| `orch agents` | List, sync, and inspect fleet agents |
| `orch status` | Task and agent status overview |
| `orch health` | Agent health checks |
| `orch metrics` | Dispatch and quality metrics |
| `orch memory stats` | Semantic memory index size and configuration |
| `orch memory query <text>` | Find similar past tasks (BM25 FTS5 ranking) |
| `orch memory reindex` | Force re-index of all approved tasks |
| `orch memory effectiveness` | Memory quality metrics: match rates, latency, usefulness scores |
| `orch memory autotune` | Show or apply recommended `min_quality_score` adjustment |
| `orch memory query-stats` | FTS5 query analysis: zero-match rates and noisy patterns |
| `orch memory per-agent` | Per-agent semantic memory effectiveness breakdown |
| `orch dispatch-efficiency` | Dispatch waste rate: 24h hourly breakdown, last 8h inline, avg/peak rates |
| `orch decisions` | Routing decisions audit |
| `orch audit` | General audit log |
| `orch preflight` | Pre-PR submission checks (duplicate PR, rebase, conflicts, issue ref) |
| `orch signals` | Dispatch signal and gate event feed |
| `orch fleet` | Fleet scaling observability |
| `orch supervisor-log` | Supervisor decision log |
| `orch antibodies` | Antibody filter management |
| `orch lineage` | Task lineage and cascade explorer |
| `orch followup-chains` | Follow-up chain depth tracker |
| `orch skip-blockers` | Chronically skipped issue tracker |
| `orch routing-accuracy` | Routing accuracy and mismatch audit |
| `orch routing-mismatches` | Routing mismatch audit: tasks where executed agent ≠ intended agent |
| `orch review-saturation` | Review saturation metrics: ratio of already-in-review dedup responses |
| `orch health-checks` | Health check storm effectiveness panel: dispatched vs suppressed events (24h rolling) |
| `orch agent-gaps` | Coverage gap detection: unowned topics, scope overload, low-confidence routing |
| `orch cost` | Token usage and billing |
| `orch failure-interceptions` | Failure interception panel: pre-dispatch similarity filter hits, lesson injection counts, model upgrade suggestions, and pass/fail outcomes |

Run `orch --help` for the full list. All commands accept `--json` for machine-readable output.

## Tech Stack

- **Runtime:** Node.js 22+ (ES2022, ESNext modules)
- **Language:** TypeScript (strict mode)
- **CLI:** Commander.js
- **State:** SQLite via better-sqlite3 (FTS5 for semantic memory)
- **Build:** tsc (test files excluded via tsconfig)
- **GitHub API:** `gh` CLI
- **IDs:** ULID (`src/utils/ulid.ts`) — time-ordered, collision-safe task IDs

## Monitoring Session — Proactive Recovery

**You must proactively monitor the daemon, agents, and task progress — do not wait for the user to ask.** At the start of every session, set up a recurring monitoring loop using `/loop`:

```
/loop 3m Check daemon status, recent logs, and task progress. Fix issues or dispatch work.
```

This fires every 3 minutes automatically. **The goal is autonomous oversight: you are the operator, not a passive observer.** If something needs attention — fix it. Flag issues to the user only when human input is needed.

This session runs the health monitoring loop and **owns the daemon lifecycle**. When something is broken and a fix is available, execute it immediately — do not report the same issue across multiple checks.

### Automated recovery actions (no confirmation needed)

| Condition | Action |
|-----------|--------|
| Daemon PID missing or process dead | Start: `cd /Users/paultarr/Local/Git/claude-agent-orchestrator && nohup node dist/service/daemon-entry.js --poll-interval 300000 > /dev/null 2>&1 &` |
| Stale PID file (file exists, process dead) | `rm ~/.claude-orchestrator/daemon.pid` then start daemon |
| Daemon running but no new log lines for >15 min | Kill PID and restart |
| Same agents failing deployer health checks 2+ consecutive cycles | `curl -X POST http://localhost:3400/v1/rebuild` |
| Proxy registry empty (0 agents) | `node dist/cli/index.js agents sync` immediately |
| After any daemon start/restart | Always run `node dist/cli/index.js agents sync` — deployer only re-registers stale agents, not all missing ones |
| Docker socket unresponsive (`curl --unix-socket /var/run/docker.sock --max-time 8 http://localhost/ping` times out or EOF) | Detect runtime: `docker context show` returns `orbstack` → `killall OrbStack 2>/dev/null; sleep 5 && open -a OrbStack`; returns `desktop-linux` → `killall Docker 2>/dev/null; sleep 5 && open -a Docker`. Wait ~60s, verify socket ping, then `node dist/cli/index.js agents sync` |

### After any recovery action
- Verify it worked: check PID alive, agents healthy, new log activity
- Report what was done and the result
- If the issue recurs after recovery, file a GitHub issue in `rapartlu/agent-orchestrator`

### Health check cadence
Each check must verify all 6 points: daemon PID, latest cycle timestamp, ERROR lines in last 2 min, task status counts (done/failed/in_progress/escalated), agent health via `curl http://localhost:3400/v1/agents`, and Docker socket responsive (`curl --unix-socket /var/run/docker.sock --max-time 8 http://localhost/ping`). Report issues or confirm healthy.

## Token Rotation (Claude OAuth token)

When a new `CLAUDE_CODE_OAUTH_TOKEN` is provided, deploy it as follows.

### How token auth works
- Token lives in `/Users/paultarr/Documents/Git/claude-proxy/.env` as `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...`
- `generate.sh` reads it and writes to `.secrets/<agent>/oauth_token` (one file per agent)
- `docker-compose.generated.yml` mounts each file as a Docker secret at `/run/secrets/<agent>_oauth_token`
- `entrypoint.sh` exports it as `CLAUDE_CODE_OAUTH_TOKEN` env var before starting the Claude CLI

**Important:** `generate.sh` (full mode) is triggered by the proxy management API (port 3400, `src/manager.ts`) on every agent create/update. It wipes and recreates `.secrets/` each time. Do NOT write `.secrets/` files manually between bash calls — they will be overwritten.

### Rotation procedure

1. **Update `.env`:**
   ```bash
   # Edit /Users/paultarr/Documents/Git/claude-proxy/.env
   # Replace CLAUDE_CODE_OAUTH_TOKEN=<old> with the new token
   ```

2. **Run agents sync** — this registers all agents with the management API, which triggers `generate.sh` for each, writing the new token to all `.secrets/<agent>/oauth_token` files and restarting containers:
   ```bash
   GH_TOKEN="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" \
     node dist/cli/index.js agents sync
   ```

3. **Fix any containers that failed to start** (race condition: secrets wiped mid-rotation):
   ```bash
   # Write secrets and start in one atomic command
   OAUTH="<new-token>"
   GH="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"
   BASE="/Users/paultarr/Documents/Git/claude-proxy/.secrets"
   for agent in claude-orchestrator-telegram claude-agent-orchestrator codex-agent-orchestrator \
     claude-orchestrator-reviewer codex-orchestrator-reviewer claude-orchestrator-dashboard \
     codex-orchestrator-dashboard claude-research-agent codex-research-agent claude-proxy codex-proxy; do
     mkdir -p "$BASE/$agent"
     printf '%s' "$OAUTH" > "$BASE/$agent/oauth_token"
     printf '%s' "$GH" > "$BASE/$agent/gh_token"
     printf '' > "$BASE/$agent/openai_api_key"
     printf '' > "$BASE/$agent/gemini_api_key"
   done
   docker start $(docker ps -a --format "{{.Names}}" | grep "^claude-proxy-" | grep -v "child\|repo") 2>&1
   ```

4. **Verify** all 11 containers are running: `curl -s http://localhost:3400/v1/agents | python3 -c "import json,sys; a=json.load(sys.stdin); print(len(a), [(x['name'],x.get('status')) for x in a])"`

### If agents still show "Not logged in · Please run /login" after rotation

The `.env` path covers the `CLAUDE_CODE_OAUTH_TOKEN` env var injected at container startup. If the Claude CLI inside a container has cached a different (stale) token internally, the env var alone won't fix it. This requires **human interaction**:

```bash
# On the host machine, run:
claude setup-token
# Then restart the affected container so entrypoint.sh re-reads the new secrets
docker restart claude-proxy-<agent-name>-1
```

The `setup-token` command cannot be automated — it opens an OAuth flow or prompts for a token interactively.

## PR Discipline

- One issue, one branch, one PR
- Every PR must include `Closes #N`
- Keep PRs small (<5 files)
- Every commit: `Co-Authored-By: <agent-name> <agent-name@agent>`
- Don't fix unrelated things — create new issues
- Don't add meta-tooling unless asked
