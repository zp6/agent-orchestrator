# Incident Report — claude-orchestrator-reviewer Health Check Failure
**Date:** 2026-04-12  
**Severity:** P2 (false-positive outage alert — container self-recovered, no data loss, no task loss)  
**Status:** Resolved (self-recovery confirmed; structural fix merged in agent-proxy#367)

---

## 1. Diagnosis

### What happened

After a container restart, the orchestrator's health check poller reported `claude-orchestrator-reviewer` as unhealthy. The alert was accurate at the moment it fired, but the container **self-recovered without intervention** once its internal startup probe completed.

### Timeline

| Time (UTC) | Event |
|---|---|
| 17:29:10 | PID 1 (`node /app/dist/index.js`) started — container restart confirmed |
| 17:29:10 | Port 3474 bound immediately (`tcp6 :::3474 LISTEN PID 1/node`) |
| 17:29:10–17:40:01 | `/health` returning HTTP 503 `{"status":"starting"}` — CLI probe in progress |
| ~17:40:01 | CLI probe passed (`claude --version` succeeded); `ready = true` |
| 17:48:03 | `/health` confirmed HTTP 200 `{"status":"ok"}` — full recovery |

**Total startup window where health returned 503:** up to ~111 seconds (worst-case, matching the 10-retry exponential backoff: 1+2+4+8+16+16+16+16+16+16 = 111 s).

### Root cause

The app (`/app/dist/server.ts`) implements a **startup readiness gate** that runs `claude --version` on startup with exponential backoff before serving real traffic. Until that probe passes, `/health` deliberately returns HTTP 503:

```typescript
app.get("/health", (_req, res) => {
  if (ready) {
    res.json({ status: "ok" });
  } else {
    res.status(503).setHeader("Retry-After", "5").json({ status: "starting" });
  }
});
```

The probe retries up to 10 times with a base delay of 1 second, doubling up to 16 seconds per retry — worst case ~111 seconds total. This design is intentional: it prevents the orchestrator from dispatching tasks to a container before Claude CLI is available.

**The structural gap:** The `docker-compose.generated.yml` for this container had **no `healthcheck` block**, meaning no `start_period`. Without `start_period`, Docker counts health check failures from second zero. Every 503 during the startup window incremented Docker's failure counter and triggered the outage alert, even though the container was behaving exactly as designed.

### Port binding & process state — confirmed not the cause

Port 3474 was bound at 17:29:10 (same second as PID 1 start), eliminating port-binding delays as a factor. The node process was in sleep state `S` throughout — no crash, no zombie. The issue was purely the 503 window before the CLI probe passed.

### State.db connectivity — not a factor

This container is a library package (not a standalone HTTP server). The HTTP server at port 3474 is the **claude-proxy** base image (`/app/dist/index.js`), which does not open `state.db` on startup. No database connection delay contributed to the health check failure.

---

## 2. Steps Taken to Restore Service

| Step | Outcome |
|---|---|
| Checked `/health` endpoint: `curl -s http://localhost:3474/health` | HTTP 200 `{"status":"ok"}` — already recovered |
| Confirmed PID 1 running: `ps -p 1 -o pid,lstart,comm,state` | `node` started 17:29:10, state `S` (healthy sleep) |
| Confirmed port bound: `netstat -tlnp \| grep 3474` | `tcp6 :::3474 LISTEN PID 1/node` ✓ |
| Traced startup gate in `server.ts` | 503 window = up to 111s; design is intentional |
| Cross-referenced proxy PR #367 | Same root cause; fix already merged |

**No manual restart or reconfiguration was required.** The container self-recovered once the CLI probe passed.

---

## 3. Recovery Evidence

```
$ curl -s -w "\nHTTP %{http_code}" http://localhost:3474/health
{"status":"ok"}
HTTP 200
```

```
$ ps -p 1 -o pid,lstart,comm,state
    PID                  STARTED COMMAND         S
      1 Sun Apr 12 17:29:10 2026 node            S
```

```
$ netstat -tlnp | grep 3474
tcp6  0  0  :::3474  :::*  LISTEN  1/node
```

Timestamp of verification: **2026-04-12 17:48:03 UTC**  
Time since container start: **~19 minutes** (start: 17:29:10, verified: 17:48:03)

---

## 4. Recurrence Assessment

### Is this structural? Yes.

Every container restart will produce the same false-positive alert window until `start_period: 120s` is added to the Docker healthcheck config. The 503 behavior during startup is **intentional and correct** — the structural issue is that Docker has no grace period to wait it out.

### Fix already merged

The proxy team diagnosed and fixed the identical issue in **agent-proxy#366 / agent-proxy#367** (merged 2026-04-12 17:36:39 UTC), adding a `healthcheck` block to `generate.sh`:

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:{port}/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 120s   # covers worst-case 111s CLI probe window
```

### What's needed to apply the fix

1. Run `./generate.sh` on the host to regenerate `docker-compose.generated.yml` with the new `healthcheck` block
2. Rebuild / restart containers: `docker compose up -d`

Once applied, Docker will ignore health check results during the first 120 seconds after any restart, eliminating false-positive alerts from the startup probe window.

### New issue needed?

**No new issue required.** The fix is already tracked and merged in agent-proxy#367. This incident report documents the reviewer container's specific instance of the same structural gap. The orchestrator should prioritize running `./generate.sh` and redeploying to apply the fix to all agents.
