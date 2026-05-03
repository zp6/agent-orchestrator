# Incident Postmortem — Connection-Error Cascade (2026-04-30)

**Severity:** High  
**Duration:** ~47 minutes  
**Impact:** All in-flight tasks for affected agents permanently failed; several agents entered an infinite retry loop that exhausted task quotas.

---

## Summary

On 2026-04-30 a network partition between the orchestrator host and agent containers caused repeated TCP connection failures on port 3474 (reviewer) and port 3478 (research agent). Because the dispatcher had no upper bound on connection-error retries, the failing agents consumed all available task slots. Tasks that could not reach the agents accumulated `connection-error` failures indefinitely, blocking the daemon queue and preventing healthy agents from receiving new work.

---

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 14:12 | Network partition begins; first TCP timeout logged |
| 14:13 | Dispatcher starts retry loop with exponential back-off |
| 14:19 | Retry counter resets each daemon cycle (bug) — loop runs indefinitely |
| 14:22 | Task queue saturated; healthy agents idle |
| 14:31 | On-call notified via Telegram; manual task cancellation begins |
| 14:48 | Network partition resolved; services recover |
| 14:59 | Last stuck task cancelled; queue drains normally |

---

## Root Causes

1. **No retry ceiling per agent** — `retry_count` was incremented per-task but never used to stop dispatching to the same agent after repeated failures.
2. **No agent-level suspension** — the dispatcher had no mechanism to stop sending work to an agent that was clearly unreachable.
3. **No incident log** — there was no structured record of cascading connection failures; operators only learned about the problem via raw log grep.

---

## Contributing Factors

- The daemon re-queues eligible tasks every 30 s without checking the recent failure history of their target agent.
- `isConnectionError()` already existed but the check only protected individual task retries, not the agent dispatch path.

---

## What Went Well

- `isConnectionError()` correctly separated transient TCP errors from logic errors, preventing non-retryable tasks from looping.
- Telegram notifications fired for each individual task failure, giving on-call a stream of signal (though the volume was noisy).
- Manual intervention was straightforward once the cause was identified.

---

## Action Items (all completed in issue #1398)

| # | Action | Owner | Status |
|---|--------|-------|--------|
| 1 | Add `suspended_until` + `suspension_reason` columns to `agent_health` | orchestrator | ✅ Done |
| 2 | Add `incidents` table with indexes on `created_at` and `agent_name` | orchestrator | ✅ Done |
| 3 | `store.suspendAgent()` / `store.liftAgentSuspension()` / `store.isAgentSuspended()` | orchestrator | ✅ Done |
| 4 | Dispatcher: skip suspended agents at dispatch time with `agent-suspended` terminal result | orchestrator | ✅ Done |
| 5 | Dispatcher: call `suspendAgent()` + `recordIncident()` when connection-error retries are exhausted | orchestrator | ✅ Done |
| 6 | `GET /api/incidents` endpoint on metrics server | orchestrator | ✅ Done |
| 7 | Write this postmortem | orchestrator | ✅ Done |

---

## Suspension Policy

When a connection-error retry sequence is exhausted (`retry_count >= MAX_CONNECTION_RETRIES`, default 3) the dispatcher now:

1. Sets `agent_health.suspended_until = NOW() + 30 minutes`.
2. Inserts an `incidents` row with `severity = 'high'`.
3. Marks the task `status = 'failed'` with `result = 'agent-suspended: …'` and `next_retry_at = suspended_until`.

Subsequent dispatch cycles skip any agent where `suspended_until > NOW()` without making a network call, immediately failing the task with `agent-suspended`. This prevents runaway retry loops while leaving a clear audit trail.

Operators can lift a suspension early by calling `store.liftAgentSuspension(agentName)` or by waiting for the TTL to expire. Future work (issue #1399) will add a `/agents/:name/unsuspend` REST endpoint.

---

## Lessons Learned

- Connection-error handling must have **two** ceilings: a per-task retry cap *and* a per-agent suspension gate.
- An incident log is essential for postmortem analysis; individual task logs are insufficient when many tasks are affected simultaneously.
- The Telegram noise-to-signal ratio during cascades should be reduced — a single "agent X unreachable, suspending" alert is more useful than hundreds of per-task failure alerts.
