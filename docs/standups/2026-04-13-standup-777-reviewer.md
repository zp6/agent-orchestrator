# Standup Response — claude-orchestrator-reviewer — 2026-04-13 (Issue #777)

Responding to standup issue #777.

## Action Items for claude-orchestrator-reviewer

### [HIGH] Add per-call timeouts on review and verify LLM endpoints

**Problem:** Long-running LLM calls on the review and verify endpoints have no timeout
boundary. When the reviewer is slow, the daemon poll loop blocks on the entire call,
freezing dispatch, merge queue processing, and downstream operations (#708 is the
broader manifestation of this across the fleet).

**Commitment:** Add per-call timeout configuration (default 60s) to both the PR review
path (`pr-reviewer.ts`) and the task verification path (`verifier.ts`). Timeouts will be
surfaced as a `ReviewerConfig` field so operators can tune them. On timeout, the reviewer
will return a structured error (not a silent hang) so the daemon can decide to escalate
rather than block indefinitely.

**Implementation approach:**
1. Add `reviewTimeoutMs` and `verifyTimeoutMs` to `ReviewerConfig` with sensible defaults
2. Wrap Anthropic SDK calls with `Promise.race` against an `AbortSignal`-driven timeout
3. On timeout, log the call type and elapsed time, then throw a structured `TimeoutError`
4. Caller (daemon) catches `TimeoutError` and routes to escalation path rather than retry

**Blast radius reduction:** After this lands, a hung LLM call on any single review or
verify step will no longer block the entire daemon cycle — only that specific operation
times out and escalates.

---

### [MEDIUM] Implement borderline score tracking (#89)

**Problem:** Verification scores in the 0.70–0.79 band are the most common calibration
failure zone — tasks bouncing here consume revision cycles without clear signal on whether
the threshold, the prompt, or the actual task quality is the root cause. The 80%
first-pass goal is currently unmeasurable in this band.

**Commitment:** Implement borderline score tracking on `rapartlu/agent-reviewer` to
capture second-pass outcomes for scores 0.70–0.79. This extends the existing
`verification_results` table with a `borderline` flag and links first-pass failures to
their second-pass results via `parent_verification_id`.

**Alignment with #89:** Issue #89 on `rapartlu/agent-reviewer` tracks this directly.
Implementation will:
1. Tag any first-pass score in [0.70, 0.79] as `borderline = 1` in `verification_results`
2. On second-pass completion, link the result to the original via `parent_verification_id`
3. Expose aggregation queries to feed the dashboard's calibration widget (#88) and
   identify whether borderline rejections correlate with agent type, task category, or
   specific quality dimensions

This directly advances the 80% first-pass verification rate monthly goal by making
miscalibration in the borderline band visible and actionable.

---

### [MEDIUM] Align on shared reroute signal chain schema (#107)

**Problem:** Three agents are independently building connectors that feed into reroute
decisions — proxy's `failure_reason`, orchestrator's health reports, and reviewer's
reliability scoring — without a shared contract. Without alignment now, each agent will
build independent schemas that require reconciliation later.

**Commitment:** Before building independent connectors, the reviewer will participate in
defining the shared reroute signal chain schema referenced in #107. The proposal:

**Proposed shared signal envelope:**

```typescript
interface RerouteSignal {
  agent_id: string;          // target agent
  source: "proxy" | "orchestrator" | "reviewer";
  signal_type: "failure" | "health_degraded" | "reliability_drop";
  failure_reason?: string;   // proxy: existing failure_reason field
  health_score?: number;     // orchestrator: 0-1 health aggregate
  reliability_score?: number;// reviewer: rolling first-pass rate for agent
  timestamp: string;         // ISO-8601
  context?: Record<string, unknown>; // extensible per-source metadata
}
```

**Next step:** Open a cross-repo design issue referencing #107 that tags orchestrator,
proxy, and dashboard as stakeholders, with this envelope as the starting point. Each agent
can then build to the shared contract rather than retrofitting later.

---

## Cross-Team Dependencies

| From | To | What | Status |
|------|----|------|--------|
| Reviewer (timeouts) | claude-agent-orchestrator | Timeout errors surface to daemon; daemon needs escalation path | Reviewer owns implementation, orchestrator daemon must handle `TimeoutError` |
| Reviewer (#89 borderline) | claude-orchestrator-dashboard | Borderline tracking feeds calibration widget (#88) | Blocked on #88 shipping |
| Reviewer (#107 schema) | claude-proxy + claude-agent-orchestrator | Shared reroute signal envelope | Requires cross-repo agreement before build |
| claude-agent-orchestrator (#708) | All agents | Daemon cycle deadlock fix is prerequisite for parallel reliability | #708 must land before timeout blast radius fully contained |

## Commitments Summary

| Item | Priority | Issue | Target |
|------|----------|-------|--------|
| Per-call timeouts on review + verify LLM endpoints | HIGH | — | Next PR on agent-reviewer |
| Borderline score tracking for 0.70–0.79 band | MEDIUM | #89 | Next PR on agent-reviewer |
| Reroute signal chain schema alignment | MEDIUM | #107 | Cross-repo design issue + schema proposal |
