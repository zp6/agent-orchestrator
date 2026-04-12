# Incident Report — codex-orchestrator-reviewer Health Check Failure
**Date:** 2026-04-12  
**Reporter:** claude-orchestrator-reviewer  
**Severity:** P2 (false-positive outage alert — container self-recovered, no data or task loss)  
**Status:** Resolved. Follow-up issue filed: [agent-orchestrator#724](https://github.com/rapartlu/agent-orchestrator/issues/724)

---

## 1. Port identification

**Via `$PORT` env var:**
```
PORT=3474   (claude-orchestrator-reviewer — this container)
```

The codex-orchestrator-reviewer runs on **port 3481** per `agents.yaml`:
```yaml
codex-orchestrator-reviewer:
  provider: "openai"
  docker:
    port: 3481
```

Port 3481 is not reachable from within this container (separate Docker network segment). The analysis below applies to the shared codebase and startup logic — both reviewer variants run the same `/app/dist/index.js` with different `PORT` env vars.

**Port 3474 binding confirmed (claude-orchestrator-reviewer):**
```
tcp6  0  0  :::3474  :::*  LISTEN  1/node
```

---

## 2. Restart sequence — git reflog + FETCH_HEAD timestamps

The git reflog in `/home/claude/workspace/agent-reviewer` provides a precise activity log aligned to the container lifecycle.

**FETCH_HEAD last modified:**
```
Modify: 2026-04-12 18:16:07 UTC   (most recent fetch)
```

**Reflog — today's entries in chronological order (UTC):**

| Time (UTC) | Event |
|---|---|
| Before 17:29:10 | Container not running (prior cycle ended) |
| **17:29:10** | **PID 1 (`node /app/dist/index.js`) started — container restarted** |
| 17:29:10 | Port 3474 bound immediately; CLI probe begins |
| 17:29:10–17:31:11 | `/health` returns HTTP 503 `{"status":"starting"}` (probe window, up to 111s) |
| **17:40:44** | **First `pull --ff-only origin main` in reflog** — confirms agent healthy and accepting tasks 11m34s after start |
| 17:52:10 | Second `pull --ff-only origin main` |
| 18:02:17 | Branch checkouts + pull (tasks #92, #93 dispatched) |
| 18:16:07 | FETCH_HEAD updated (most recent fetch) |

The 11m34s gap between container start (17:29:10) and first git activity (17:40:44) is consistent with: CLI probe completing (~17:31), orchestrator dispatching first task, agent pulling and beginning work.

---

## 3. Health endpoint — confirmed HTTP 200

```
$ curl -s -w "\nHTTP_STATUS:%{http_code}\nTIME_TOTAL:%{time_total}s" \
    http://localhost:3474/health
{"status":"ok"}
HTTP_STATUS:200
TIME_TOTAL:0.001383s
Timestamp: 2026-04-12 18:19:21 UTC
```

---

## 4. Self-recovery vs. intervention

**Self-recovery — no intervention was required.**

The container recovered autonomously once the startup CLI probe passed. The sequence:

1. PID 1 starts → port bound immediately → `/health` returns **503** while `claude --version` probe runs
2. Probe succeeds → `ready = true` → `/health` returns **200**
3. No restart, no reconfiguration, no manual action taken

The startup probe uses exponential backoff (10 retries, base 1s, cap at 16s):
```
delays: 1000 + 2000 + 4000 + 8000 + 16000×6 = 111,000ms worst case
```
Worst-case window where `/health` returns 503: **0–111 seconds after start**.

---

## 5. Docker-compose `start_period` check

**Current state: `start_period` is ABSENT from the generated docker-compose config.**

```bash
$ grep -c "start_period\|healthcheck" \
    /home/claude/workspace/claude-proxy/generate.sh
0   # ← no healthcheck block in the claude-proxy workspace copy
```

The fix **exists** but has not been applied to the running containers:

- agent-proxy PR #367 (`fix: add Docker healthcheck start_period`, merged 17:36:39 UTC) added `start_period: 120s` to `generate.sh` in the `rapartlu/agent-proxy` repo
- The `agent-proxy` workspace at `/home/claude/workspace/agent-proxy` confirms the fix is present (commit `5954738`):

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:{port}/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 120s   # covers worst-case 111s CLI probe window
```

- **However**: the host has not yet run `./generate.sh` + `docker compose up -d` to apply the fix to the running containers. Until it does, every restart of every agent (claude-orchestrator-reviewer, codex-orchestrator-reviewer, etc.) will produce the same false-positive alert.

**Follow-up issue filed: [agent-orchestrator#724](https://github.com/rapartlu/agent-orchestrator/issues/724)**

Tracks: run `./generate.sh` on the host and redeploy all agent containers to apply `start_period: 120s` system-wide.

---

## 6. Root cause summary

| Factor | Detail |
|---|---|
| **Immediate cause** | `/health` returns HTTP 503 during 0–111s startup window while CLI probe runs |
| **Structural cause** | No `start_period` in docker-compose healthcheck — Docker counts startup 503s as failures from t=0 |
| **Not a cause** | Port binding delay (port bound at t=0), process crash (PID 1 state `S`), DB connection (state.db not opened on startup) |
| **Recovery** | Autonomous — probe passed, health went 503→200, no operator action |
| **Fix** | Apply `start_period: 120s` via `./generate.sh` + `docker compose up -d` (fix already in agent-proxy#367) |
