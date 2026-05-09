# Process supervision (monitor /loop session responsibility)

> **Scope:** Lifecycle of two host processes that the monitor /loop session owns and operates. Other sessions file issues if these are broken; they do not act.

The fleet's autonomy depends on two long-running host processes being up:

1. **`manager.js`** — `claude-proxy`'s agent management API on `localhost:3400`. The orchestrator daemon's `deployer.getRegisteredAgents()` calls this; if it's down, all dispatch triggers skip silently.
2. **`daemon-entry.js`** — `claude-agent-orchestrator`'s dispatch + trigger loop. Runs `dispatchTriggers` every poll cycle (`dispatchGitHubIssues`, `dispatchLinearChecks`, `dispatchSlackChecks`, `dispatchRevenueExecutor`). Without this, no work dispatches.

Neither process runs in a container. Both are spawned by the operator (or the monitor session) on the host. There is no supervisor (no launchd plist, no systemd unit), so when one dies it stays dead unless the monitor restarts it.

**Critical boundary:** Only the /loop monitor session restarts these processes. Chat-mode operator sessions and dispatched coder agents must NOT touch them — even when they spot a problem. The right action from a non-monitor session is to file a P1 issue.

This boundary was established 2026-05-09 after a chat-mode session killed the manager and could not reliably restart it from its bash environment, leaving the autonomy chain broken for hours. The monitor session has a clean shell, knows the canonical paths, and runs the restart logic codified here.

---

## Manager process

### What it is

| Field | Value |
|---|---|
| Process | `node dist/manager.js` |
| Working dir | `/Users/paultarr/Documents/Git/claude-proxy/` |
| Containerized? | No — host process. The `claude-proxy` Docker container only runs `index.js` (LLM proxy), not `manager.js`. |
| Port | 3400 (configurable via `MANAGER_PORT` env) |
| Auth | `x-api-key: cheese` (from `PROXY_API_KEY` in `~/.claude-orchestrator/.env`) |
| Routes | `/v1/agents`, `/v1/agents/:name/start`, `/v1/agents/:name/stop`, `/v1/agents/:name/rebuild`, etc. — full list in `claude-proxy/src/routes/agents.ts` |

### Symptom of manager-down

Daemon log shows `Triggers: no new items (X already processed)` cycle after cycle while real issues sit unaddressed in the GitHub queue. The daemon's `registeredAgents` Set is empty, every trigger function skips on the `if (!set.has(agentName))` guard.

### Liveness check

```sh
manager_alive() {
  pgrep -f "node.*dist/manager.js" >/dev/null \
    && curl -s --max-time 3 -H "x-api-key: cheese" \
      http://localhost:3400/v1/agents -o /dev/null -w "%{http_code}" \
      | grep -q "^200$"
}
```

Both conditions must hold. If either fails → restart.

### Restart procedure

```sh
pkill -f "node.*dist/manager.js"
sleep 3
pgrep -f "node.*dist/manager.js" >/dev/null && pkill -9 -f "node.*dist/manager.js" && sleep 2

cd /Users/paultarr/Documents/Git/claude-proxy
( set -a; source ~/.claude-orchestrator/.env; set +a; \
  nohup node dist/manager.js > ~/manager.log 2>&1 & disown )

# Verify port bound within 30s
for i in {1..15}; do
  sleep 2
  curl -s --max-time 2 -H "x-api-key: cheese" \
    http://localhost:3400/v1/agents -o /dev/null -w "%{http_code}" \
    | grep -q "^200$" && break
done
```

### Update flow (on new claude-proxy main)

```sh
cd /Users/paultarr/Documents/Git/claude-proxy
git stash --include-untracked
git pull origin main --no-edit
git stash pop || true
[ -n "$(git diff HEAD@{1} HEAD -- package.json package-lock.json)" ] && npm install
npm run build
# Then restart procedure
```

---

## Daemon process

### What it is

| Field | Value |
|---|---|
| Process | `node dist/service/daemon-entry.js --poll-interval 300000` |
| Working dir | `/Users/paultarr/Documents/Git/claude-agent-orchestrator/` |
| Containerized? | No — host process. Agent containers are separate, run only LLM proxy code. |
| Internal port | 3472 (some HTTP endpoints; not the primary interface) |
| Logs | `~/.claude-orchestrator/logs/orchestrator.log` |
| State DB | `~/.claude-orchestrator/state.db` (SQLite) |

### Required env vars (must be sourced from `~/.claude-orchestrator/.env`)

- `GH_TOKEN` — required for GitHub operations
- `LINEAR_API_KEY` — Linear integration
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — for `orch dns` / worker deploy
- `REVENUE_EXECUTOR_ENABLED=true` — Layer 1 of #1512 trigger gate
- `PROACTIVE_REBASE_DISABLED=true` — #1542 escape hatch for cycle starvation; can remove once #1541 ships a bounded scheduler

**The daemon does not auto-load `~/.claude-orchestrator/.env`.** Issue #1539 fixes this; until it lands, the start command must explicitly source the env file.

### Symptoms of daemon problems

| Symptom | Likely cause |
|---|---|
| Process alive, no log activity for >10 min | Cycle stuck on rebase scheduler or external HTTP call |
| Process alive, cycle # not advancing across two checks | Same as above |
| Triggers logging "no new items (N already processed)" cycle after cycle while issues sit | Manager API down (see Manager section, not a daemon problem) |
| Triggers firing but env-flag-gated triggers silently skip | Env not sourced on daemon startup |
| Repeated "Cannot retry: unknown agent" failures | Stale agent definitions; selfUpdate isn't pulling main |

### Liveness check

```sh
daemon_alive() {
  pgrep -f "daemon-entry" >/dev/null || return 1

  LAST_CYCLE=$(grep "Cycle complete" ~/.claude-orchestrator/logs/orchestrator.log 2>/dev/null \
    | tail -1 | grep -oE "20[0-9-]+T[0-9:.]+Z" | head -1)
  [ -z "$LAST_CYCLE" ] && return 1

  CYCLE_AGE_S=$(( $(date -u +%s) - $(date -u -j -f "%Y-%m-%dT%H:%M:%S" "${LAST_CYCLE%.*Z}" +%s 2>/dev/null) ))
  [ "$CYCLE_AGE_S" -lt 600 ]  # last cycle within 10 min
}
```

Three conditions:
1. Process named `daemon-entry` exists
2. Most recent `Cycle complete` log line within last 10 min
3. Optionally: cycle # is advancing across consecutive checks

### Restart procedure

**Critical:** env MUST be sourced before the node command. See "Required env vars" above.

```sh
# 1. Kill all daemon processes (multiple often accumulate from prior restarts)
pkill -f "daemon-entry"
sleep 3
pgrep -f "daemon-entry" >/dev/null && pkill -9 -f "daemon-entry" && sleep 2

# 2. Verify Documents/Git is on the right commit (latest main)
cd /Users/paultarr/Documents/Git/claude-agent-orchestrator
git fetch origin main --quiet
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/main)
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  # Update flow needed first — see "Daemon update flow" below
  echo "Daemon source is stale; running update flow first"
  return 1
fi

# 3. Start fresh WITH env sourced
( set -a; source ~/.claude-orchestrator/.env; set +a; \
  nohup node dist/service/daemon-entry.js --poll-interval 300000 \
  >> ~/.claude-orchestrator/logs/orchestrator.log 2>&1 & disown )

# 4. Smoke check: env actually loaded into the new process
sleep 6
NEW_PID=$(pgrep -f daemon-entry | head -1)
ps eww $NEW_PID 2>&1 | tr ' ' '\n' | grep -q "^GH_TOKEN=" \
  || { echo "ERROR: env not loaded"; return 1; }

# 5. Wait for first cycle to complete (up to 5 min — first cycle may be slow)
for i in {1..30}; do
  sleep 10
  tail -50 ~/.claude-orchestrator/logs/orchestrator.log 2>/dev/null \
    | grep -q "Cycle complete" && return 0
done
return 1
```

### Update flow (on new claude-agent-orchestrator main)

```sh
cd /Users/paultarr/Documents/Git/claude-agent-orchestrator
git stash --include-untracked
if ! git pull origin main --no-edit; then
  git fetch origin main
  git reset --hard origin/main  # operator's local agents.yaml customizations are recoverable from stash
fi
git stash pop || true
[ -n "$(git diff HEAD@{1} HEAD -- package.json package-lock.json)" ] && npm install
npm run build
# Then restart procedure
```

---

## Things that should NOT happen

- **Multiple processes of either type running simultaneously.** They race on shared state (port for manager; SQLite state.db for daemon). Liveness check should detect; pkill all and restart cleanly.
- **Either process started from the wrong working directory.** Both use `process.cwd()` for path resolution; wrong cwd causes silent misconfig.
- **Either process started without `~/.claude-orchestrator/.env` sourced.** Manager: auth fails for all callers. Daemon: feature flags lost (env-gated triggers silently skip).
- **Either process left running with stale code after a main update.** Always rebuild dist before restart when main has advanced.
- **Killing the daemon mid-cycle.** SIGTERM gives it ~30s to finish current work; SIGKILL leaves task state inconsistent. Prefer SIGTERM, escalate to SIGKILL only if it refuses to die.

---

## Cascade-recovery order

If both manager and daemon are down (cascade failure):

1. **Manager first** — daemon's `getRegisteredAgents()` depends on it. Daemon will appear "stuck/skipping" until manager is up.
2. **Then daemon** — once manager is up, restart daemon to pick up fresh registered-agent set and force trigger evaluation against the new state.

Verify both alive before declaring recovery done.

---

## Boundary enforcement

If a non-monitor session is observed touching either process, the monitor session should:

1. Run fresh liveness checks for both
2. Run the full restart procedure for whichever is broken (without trusting whatever state the chat session left)
3. Not retroactively "fix" what the chat session intended to do
4. Log the violation so the pattern can be addressed

The reverse also holds: monitor session does NOT do feature work in either repo. That's the dispatch system's job — chat sessions file issues, fleet coder agents ship PRs, monitor session keeps the lifecycle running.

---

## Connected issues

- `#1539` — when this lands, daemon auto-loads `~/.claude-orchestrator/.env`, removing the manual-source-env step from the restart procedure.
- `#1540` — when this lands, daemon's `selfUpdate` stops failing on dirty trees, reducing stale-source risk.
- `#1541` — when this lands (proper bounded rebase scheduler), `PROACTIVE_REBASE_DISABLED=true` becomes optional.
- `#1542` — env-gate for the rebase scheduler; the source of the `PROACTIVE_REBASE_DISABLED` flag.
- `agent-proxy#564` — when this lands, cloudflare creds propagate to agent containers (currently in env on host but not in containers).
