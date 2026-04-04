# Temporal.io Exploration: Durable Orchestration for Claude Agents

> **Status:** Research document — no implementation yet.  
> **Issue:** [#81](https://github.com/rapartlu/claude-agent-orchestrator/issues/81)  
> **Date:** 2026-04-04

---

## Overview

The orchestrator currently uses a fire-and-forget dispatch model: send a message to an agent via the claude-proxy, wait for a response, store the result in SQLite. This breaks down in several ways:

- **No durability** — if the daemon process dies mid-plan, all in-flight task state is lost
- **No composable retry** — retries are hand-rolled, in-memory, and lost on crash
- **No native human-in-the-loop** — approval flows require polling loops glued together with state flags
- **No long-running task support** — a multi-day PR review cycle has no way to persist intermediate state

This document explores whether [Temporal.io](https://temporal.io) — an open-source durable execution engine — can serve as the orchestration backbone to solve these problems.

---

## 1. Local Docker Setup

### Option A: Temporal CLI Dev Server (Recommended for Local Dev)

The lightest possible setup — no Docker containers needed:

```bash
# Install Temporal CLI
brew install temporal        # macOS
# snap install temporal      # Linux

# Start the dev server (in-memory, ephemeral)
temporal server start-dev

# Or with SQLite persistence across restarts
temporal server start-dev --db-filename ~/.temporal/local.db
```

This starts both:
- **Temporal gRPC frontend** on `localhost:7233` (where workers connect)
- **Temporal Web UI** on `http://localhost:8233` (workflow dashboard)

The CLI also replaces the deprecated `tctl` tool for managing namespaces, workflows, and schedules.

---

### Option B: Docker Compose with PostgreSQL (Dev/Staging)

For a persistent local environment closer to production:

**`docker-compose.temporal.yml`:**
```yaml
version: "3.5"

services:
  temporal-db:
    container_name: temporal-postgresql
    image: postgres:13
    environment:
      POSTGRES_USER: temporal
      POSTGRES_PASSWORD: temporal
      POSTGRES_DB: temporal
    ports:
      - "5432:5432"
    networks:
      - temporal-network
    volumes:
      - temporal-db-data:/var/lib/postgresql/data

  temporal:
    container_name: temporal
    image: temporalio/auto-setup:1.25.0
    depends_on:
      - temporal-db
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: temporal
      POSTGRES_PWD: temporal
      POSTGRES_SEEDS: temporal-db
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/development-sql.yaml
      TEMPORAL_ADDRESS: temporal:7233
    ports:
      - "7233:7233"          # gRPC — workers and clients connect here
    networks:
      - temporal-network
    volumes:
      - ./temporal-config:/etc/temporal/config/dynamicconfig

  temporal-ui:
    container_name: temporal-ui
    image: temporalio/ui:2.31.0
    depends_on:
      - temporal
    environment:
      TEMPORAL_ADDRESS: temporal:7233
      TEMPORAL_CORS_ORIGINS: http://localhost:3000
    ports:
      - "8080:8080"          # Web UI
    networks:
      - temporal-network

networks:
  temporal-network:
    driver: bridge
    name: temporal-network

volumes:
  temporal-db-data:
```

**`temporal-config/development-sql.yaml`** (required, can be empty):
```yaml
# Temporal dynamic config — override defaults here if needed
```

Start the stack:
```bash
docker compose -f docker-compose.temporal.yml up -d

# Verify
curl http://localhost:8080   # Web UI should load
temporal workflow list --address localhost:7233   # Should return empty list
```

**Resource requirements:**
| Service | Approx. RAM |
|---|---|
| Temporal Server (`auto-setup`) | ~400–600 MB |
| PostgreSQL 13 | ~200–400 MB |
| Temporal UI | ~100–200 MB |
| **Total** | **~700 MB – 1.2 GB** |

Recommended Docker Desktop memory allocation: **4 GB minimum** (headroom for the orchestrator itself + workers).

---

### Option C: Full Stack with Elasticsearch (enables advanced search)

Add to the compose above for advanced workflow visibility/search:

```yaml
  elasticsearch:
    container_name: temporal-elasticsearch
    image: elasticsearch:7.17.0
    environment:
      discovery.type: single-node
      ES_JAVA_OPTS: "-Xms256m -Xmx256m"
      xpack.security.enabled: "false"
    networks:
      - temporal-network
```

And add to `temporal` service env:
```yaml
ENABLE_ES: "true"
ES_SEEDS: elasticsearch
ES_VERSION: v7
```

Full stack with Elasticsearch: ~1.5–2 GB RAM total.

---

## 2. Architecture: Current Concepts → Temporal Primitives

```
╔══════════════════════════════════════════════════════════════════════════╗
║              CURRENT ORCHESTRATOR → TEMPORAL MAPPING                    ║
╠══════════════════════════╦═══════════════════════════════════════════════╣
║  Current Concept         ║  Temporal Primitive                          ║
╠══════════════════════════╬═══════════════════════════════════════════════╣
║                          ║                                               ║
║  daemon.ts poll loop     ║  Temporal Schedule (cron workflow)           ║
║  (setInterval every 5m)  ║  — survives process crashes, observable       ║
║                          ║    in Web UI, pausing/triggering via CLI      ║
║                          ║                                               ║
╠══════════════════════════╬═══════════════════════════════════════════════╣
║                          ║                                               ║
║  dispatcher.dispatch()   ║  Workflow + Activities                       ║
║  (send message, wait,    ║  — workflow coordinates; each claude-proxy    ║
║   mark done/failed)      ║    call is an Activity with retry policy      ║
║                          ║                                               ║
╠══════════════════════════╬═══════════════════════════════════════════════╣
║                          ║                                               ║
║  planner.ts + executor   ║  Child Workflows (parallel + sequential)     ║
║  (DAG decomposition,     ║  — parent workflow spawns child workflow per  ║
║   topological sort)      ║    plan step; dependencies expressed via      ║
║                          ║    await / Promise.all on child handles       ║
║                          ║                                               ║
╠══════════════════════════╬═══════════════════════════════════════════════╣
║                          ║                                               ║
║  PR review feedback loop ║  Long-running Workflow with timers           ║
║  (poll gh pr list every  ║  — workflow starts on PR open; sleeps until  ║
║   N cycles)              ║    review needed; signals on merge/rejection  ║
║                          ║                                               ║
╠══════════════════════════╬═══════════════════════════════════════════════╣
║                          ║                                               ║
║  Human approval          ║  Signal + condition()                        ║
║  (currently: not         ║  — workflow pauses durably, consuming zero    ║
║   implemented)           ║    resources; signal sent via CLI/API/Slack   ║
║                          ║    webhook; resumes exactly where it paused   ║
║                          ║                                               ║
╠══════════════════════════╬═══════════════════════════════════════════════╣
║                          ║                                               ║
║  supervisor.ts review    ║  Workflow + Queries                          ║
║  (LLM reasons about      ║  — supervisor workflow queries state of       ║
║   system state)          ║    other workflows; read-only, synchronous    ║
║                          ║                                               ║
╠══════════════════════════╬═══════════════════════════════════════════════╣
║                          ║                                               ║
║  verifier.ts quality     ║  Activity (post-task verification)           ║
║  check                   ║  — called as last step in task workflow;      ║
║                          ║    results stored in workflow output          ║
║                          ║                                               ║
╠══════════════════════════╬═══════════════════════════════════════════════╣
║                          ║                                               ║
║  SQLite state.db         ║  Temporal Event History (in Postgres)        ║
║  (tasks, task_logs,      ║  — durable, replicated, queryable;           ║
║   processed_triggers)    ║    workflow history is the source of truth    ║
║                          ║                                               ║
╠══════════════════════════╬═══════════════════════════════════════════════╣
║                          ║                                               ║
║  processed_triggers      ║  Workflow ID deduplication                   ║
║  dedup table             ║  — starting a workflow with an existing ID    ║
║                          ║    returns the existing execution; zero-cost  ║
║                          ║    idempotency built into the platform        ║
║                          ║                                               ║
╚══════════════════════════╩═══════════════════════════════════════════════╝
```

### Key Architectural Principle

**All non-deterministic work (LLM calls, GitHub API, tool invocations) must live in Activities, not Workflow code.**

Temporal records every Activity result in the Event History. On replay after a crash, Temporal returns the recorded result without re-executing the Activity. This means:

- An LLM call at step 3 of a 10-step workflow will not be re-invoked after a crash — the original response is replayed
- Claude's non-deterministic output becomes durable state the moment the Activity completes
- The orchestration logic (branching, looping, coordinating agents) lives in deterministic Workflow code

---

## 3. Proof-of-Concept: LLM → Tool → LLM → Human Approval Chain

This TypeScript pseudocode sketches the core agentic loop for a Claude agent task with a human-in-the-loop approval gate.

### Type Definitions

```typescript
// shared-types.ts
export interface AgentTaskInput {
  taskId: string;
  instruction: string;
  agentName: string;
  requireHumanApproval?: boolean;
}

export interface AgentTaskResult {
  taskId: string;
  output: string;
  toolCallsMade: number;
  humanApproved: boolean;
  qualityScore?: number;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  done: boolean;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface HumanDecision {
  approved: boolean;
  approver: string;
  comment?: string;
}
```

### Activities (Non-Deterministic Work)

```typescript
// activities/agent-activities.ts
// ✅ Activities CAN: make network calls, call LLMs, access filesystem
// ❌ Activities CANNOT: import from @temporalio/workflow

import { heartbeat, activityInfo, Context } from '@temporalio/activity';
import Anthropic from '@anthropic-ai/sdk';
import type { LLMResponse, ToolCall, AgentTaskInput } from '../shared-types';

const anthropic = new Anthropic();

/**
 * Sends a message to a Claude agent via the claude-proxy.
 * This is the core "dispatch" operation — one turn of the agentic loop.
 */
export async function callClaudeAgent(
  agentPort: number,
  conversationId: string,
  message: string,
  systemPrompt: string,
): Promise<LLMResponse> {
  // Heartbeat so Temporal knows we're alive during a long LLM call
  heartbeat({ stage: 'calling_llm', conversationId });

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
    // In the real impl, forward to the claude-proxy at agentPort
    // using x-conversation-id header for session continuity
  });

  const content = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const toolCalls: ToolCall[] = response.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      name: (b as Anthropic.ToolUseBlock).name,
      args: (b as Anthropic.ToolUseBlock).input as Record<string, unknown>,
    }));

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    done: toolCalls.length === 0, // no more tools = agent is done
  };
}

/**
 * Executes a single MCP tool call (GitHub, filesystem, web search, etc.).
 * In production, this routes to the agent's MCP server.
 */
export async function executeMcpTool(
  agentName: string,
  toolCall: ToolCall,
): Promise<string> {
  heartbeat({ stage: 'executing_tool', tool: toolCall.name });

  // Route to the appropriate MCP server based on tool name
  // e.g. 'github_create_issue' → GitHub MCP, 'fs_read_file' → filesystem MCP
  const result = await routeToolCall(agentName, toolCall);
  return JSON.stringify(result);
}

/**
 * Verifies task quality: did the agent actually complete the instruction?
 * Same logic as the current verifier.ts but as an Activity.
 */
export async function verifyTaskCompletion(
  instruction: string,
  agentOutput: string,
): Promise<{ approved: boolean; score: number; notes: string }> {
  // Call Claude as a judge (separate from the agent itself)
  const verificationPrompt = `
    Original instruction: ${instruction}
    Agent output: ${agentOutput}
    
    Did the agent complete the instruction? Score 0.0-1.0. 
    Return JSON: { "approved": bool, "score": number, "notes": string }
  `;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: verificationPrompt }],
  });

  const text = (response.content[0] as Anthropic.TextBlock).text;
  return JSON.parse(text);
}

/**
 * Sends a notification to the human reviewer (Slack, email, etc.)
 * and returns the URL they can use to signal their decision.
 */
export async function requestHumanApproval(
  taskId: string,
  taskSummary: string,
  workflowId: string,
): Promise<void> {
  const approvalUrl = `https://orchestrator.internal/approve/${workflowId}`;
  
  // In production: post to Slack with approve/reject buttons that call
  // the Temporal API to send a signal back to the workflow
  console.log(`[human-approval] Task ${taskId} needs review: ${approvalUrl}`);
  console.log(`Summary: ${taskSummary}`);
}

// Internal helper — not exported as Temporal activity
async function routeToolCall(agentName: string, toolCall: ToolCall): Promise<unknown> {
  // Stub — real impl dispatches to the MCP proxy
  return { success: true, result: `Tool ${toolCall.name} executed` };
}
```

### Signal Definitions (Shared Between Workflow and Client)

```typescript
// signals.ts
// ✅ This file is safe to import in BOTH workflow and client code
// — it has no side effects, only defineSignal/defineQuery calls

import { defineSignal, defineQuery } from '@temporalio/workflow';
import type { HumanDecision } from './shared-types';

/** Sent by a human reviewer to approve or reject a task */
export const humanDecisionSignal = defineSignal<[HumanDecision]>('humanDecision');

/** Query the current stage of the agentic loop */
export const getLoopStateQuery = defineQuery<{
  stage: string;
  toolCallsMade: number;
  waitingForHuman: boolean;
}>('getLoopState');
```

### The Workflow (Deterministic Orchestration)

```typescript
// workflows/agent-task-workflow.ts
// ✅ Workflow code: deterministic, no side effects, no direct network calls
// ❌ NEVER import Node.js built-ins, external SDKs, or @temporalio/activity here

import {
  proxyActivities,
  setHandler,
  condition,
  defineSignal,
  log,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from '../activities/agent-activities';
import { humanDecisionSignal, getLoopStateQuery } from '../signals';
import type { AgentTaskInput, AgentTaskResult } from '../shared-types';

// Proxy the activities — calls are scheduled on the task queue, never direct
const {
  callClaudeAgent,
  executeMcpTool,
  verifyTaskCompletion,
  requestHumanApproval,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',   // each activity attempt has 10 min max
  heartbeatTimeout: '60 seconds',       // must heartbeat within 60s for LLM calls
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 5,
    nonRetryableErrorTypes: ['AuthError', 'InvalidInputError'],
  },
});

/**
 * Core agentic loop workflow: LLM → Tool → LLM → ... → Human Approval
 *
 * This workflow is durable: if the worker crashes at any point,
 * Temporal replays the history and resumes from the last committed step.
 *
 * The LLM → Tool loop continues until the agent signals completion
 * (no more tool calls). Optionally, a human approval gate is inserted
 * before finalizing.
 */
export async function agentTaskWorkflow(
  input: AgentTaskInput,
): Promise<AgentTaskResult> {
  const { taskId, instruction, agentName, requireHumanApproval = false } = input;

  // — State tracked in workflow memory (rebuilt from history on replay) —
  let stage = 'starting';
  let toolCallsMade = 0;
  let humanDecision: HumanDecision | null = null;
  let conversationHistory: Array<{ role: string; content: string }> = [];
  const MAX_TOOL_ROUNDS = 20; // prevent infinite loops

  // — Signal handler: human sends approve/reject decision —
  setHandler(humanDecisionSignal, (decision: HumanDecision) => {
    log.info('Human decision received', { decision, taskId });
    humanDecision = decision;
  });

  // — Query handler: external systems can inspect current state —
  setHandler(getLoopStateQuery, () => ({
    stage,
    toolCallsMade,
    waitingForHuman: stage === 'awaiting_human_approval',
  }));

  log.info('Agent task workflow started', { taskId, agentName, instruction });

  // ── Phase 1: Agentic Loop (LLM → Tool → LLM → ...) ──────────────────────

  stage = 'running_agent';
  let currentMessage = instruction;
  let finalOutput = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    log.info('LLM call', { taskId, round, toolCallsMade });

    // Activity call: sends message to Claude, gets back text + optional tool calls
    // If this crashes, Temporal retries the activity; the result is recorded in history
    const llmResponse = await callClaudeAgent(
      /* agentPort */ 3457,
      /* conversationId */ `${taskId}-${workflowInfo().workflowId}`,
      currentMessage,
      `You are ${agentName}, a helpful coding agent. Use tools as needed. Signal done by responding with no tool calls.`,
    );

    conversationHistory.push({ role: 'assistant', content: llmResponse.content });

    // Agent is done when it returns no tool calls
    if (llmResponse.done || !llmResponse.toolCalls?.length) {
      finalOutput = llmResponse.content;
      log.info('Agent completed task', { taskId, toolCallsMade });
      break;
    }

    // Execute each tool call in sequence (could be parallelized with Promise.all)
    const toolResults: string[] = [];
    for (const toolCall of llmResponse.toolCalls) {
      log.info('Executing tool', { taskId, tool: toolCall.name });
      stage = `executing_tool:${toolCall.name}`;

      // Activity call: each tool execution is independently retried if it fails
      const result = await executeMcpTool(agentName, toolCall);
      toolResults.push(`Tool ${toolCall.name}: ${result}`);
      toolCallsMade++;
    }

    // Feed tool results back to the LLM for next round
    currentMessage = `Tool results:\n${toolResults.join('\n')}\n\nContinue with the task.`;
    conversationHistory.push({ role: 'user', content: currentMessage });
  }

  // ── Phase 2: Verification ─────────────────────────────────────────────────

  stage = 'verifying';
  const verification = await verifyTaskCompletion(instruction, finalOutput);
  log.info('Verification complete', { taskId, ...verification });

  // ── Phase 3: Human Approval Gate (optional) ──────────────────────────────

  if (requireHumanApproval || !verification.approved) {
    stage = 'awaiting_human_approval';
    log.info('Requesting human approval', { taskId, requireHumanApproval, verificationScore: verification.score });

    // Activity: sends Slack/email notification with workflow ID for signaling
    await requestHumanApproval(
      taskId,
      `Task: ${instruction}\n\nOutput: ${finalOutput}\n\nVerification: ${verification.notes} (score: ${verification.score})`,
      workflowInfo().workflowId,
    );

    // Durably pause — consumes zero resources while waiting
    // condition() is safe to await for hours or days
    const decided = await condition(() => humanDecision !== null, '48 hours');

    if (!decided) {
      log.warn('Human approval timed out — auto-rejecting', { taskId });
      return {
        taskId,
        output: finalOutput,
        toolCallsMade,
        humanApproved: false,
        qualityScore: verification.score,
      };
    }

    log.info('Human approved', { taskId, approver: humanDecision!.approver });
    stage = 'approved';

    return {
      taskId,
      output: finalOutput,
      toolCallsMade,
      humanApproved: humanDecision!.approved,
      qualityScore: verification.score,
    };
  }

  // ── Done: no human approval needed ───────────────────────────────────────

  stage = 'done';
  return {
    taskId,
    output: finalOutput,
    toolCallsMade,
    humanApproved: true, // auto-approved (verification passed)
    qualityScore: verification.score,
  };
}
```

### Starting and Signaling the Workflow

```typescript
// client-usage-example.ts
import { Client, Connection } from '@temporalio/client';
import { agentTaskWorkflow } from './workflows/agent-task-workflow';
import { humanDecisionSignal, getLoopStateQuery } from './signals';

async function dispatchAgentTask() {
  const connection = await Connection.connect({ address: 'localhost:7233' });
  const client = new Client({ connection });

  // Start the workflow — workflowId is deterministic for deduplication
  // (re-starting with the same ID returns the existing execution)
  const handle = await client.workflow.start(agentTaskWorkflow, {
    taskQueue: 'orchestrator',
    workflowId: `task-github-repo#issue-42`,   // dedup key = processed_triggers.source_ref
    args: [{
      taskId: 'task-001',
      instruction: 'Fix the TypeScript error in src/dispatcher.ts line 42',
      agentName: 'claude-agent-orchestrator',
      requireHumanApproval: false,
    }],
  });

  console.log(`Workflow started: ${handle.workflowId}`);

  // Query current state at any time (non-blocking)
  const state = await handle.query(getLoopStateQuery);
  console.log('Current state:', state);
  // → { stage: 'running_agent', toolCallsMade: 3, waitingForHuman: false }

  // If the workflow is waiting for human approval, send the signal:
  if (state.waitingForHuman) {
    await handle.signal(humanDecisionSignal, {
      approved: true,
      approver: 'paul',
      comment: 'Looks good — ship it',
    });
  }

  // Wait for final result
  const result = await handle.result();
  console.log('Task complete:', result);
}
```

### The Temporal CLI Dev Workflow

```bash
# While developing, you can signal workflows directly from the CLI:
temporal workflow signal \
  --workflow-id "task-github-repo#issue-42" \
  --name "humanDecision" \
  --input '{"approved": true, "approver": "paul", "comment": "LGTM"}'

# Query current state:
temporal workflow query \
  --workflow-id "task-github-repo#issue-42" \
  --type "getLoopState"

# List all running workflows:
temporal workflow list

# View the full Event History (audit trail):
temporal workflow show --workflow-id "task-github-repo#issue-42"
```

---

## 4. Recommendation: Defer with a Staged Adoption Plan

### Verdict: **Defer**

Temporal is the right long-term direction but the wrong near-term bet. Here's the reasoning:

---

### Why Temporal Is Architecturally Right

**1. Durability is the primary gap.** The orchestrator's biggest reliability gap isn't routing or verification — it's state loss on crash. A `daemon.ts` restart discards all in-flight task context. Temporal's Event History in Postgres is the correct solution to this problem. It's not over-engineering; it's the right primitive.

**2. Human-in-the-loop is currently absent.** There's no production-ready mechanism for pausing a workflow, notifying a human, and resuming. `condition()` + `defineSignal` is exactly the pattern needed. Building this on top of SQLite + polling is reinventing Temporal badly.

**3. Retry semantics are strictly better.** The current `try/catch` + manual backoff code in `daemon.ts` is fragile — it lives in-process. Temporal's activity retry policy is durable, configurable per activity type, survives worker restarts, and is observable in the Web UI.

**4. The TypeScript SDK fits our stack.** We're already on Node.js 22 with TypeScript. The `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, and `@temporalio/activity` packages are mature and well-typed. The migration pattern (activities = side effects, workflows = orchestration) maps cleanly onto our existing `dispatcher.ts` / `daemon.ts` split.

**5. Dedup is built in.** The `workflowId` idempotency mechanism directly replaces the `processed_triggers` dedup table. Starting a workflow with `task-github-repo#issue-42` is a no-op if it's already running.

---

### Why We Should Wait

**1. Determinism constraint requires a full audit.** Every function in `daemon.ts` that branches on `Date.now()`, `Math.random()`, or environment variables would need to move to activities. This is ~1–2 weeks of careful refactoring, not a weekend project. The risk of introducing non-determinism bugs is real.

**2. Workflow versioning is painful under active development.** We're iterating fast. Changing the structure of a running workflow (adding a new activity call, reordering steps) requires Temporal's Patching API (`patched()` guards). At our current iteration pace, we'd accumulate this tech debt quickly.

**3. Operational overhead.** We currently run a single daemon process. Temporal requires: a Temporal server cluster, a database, a UI, and one or more worker processes. For a system serving 2–3 agents, this is significant infrastructure overhead.

**4. Bundling complexity.** The TypeScript SDK Webpacks workflow code into a V8 isolate at startup. Any accidental import of a Node.js API in workflow code produces cryptic bundle errors. This is a real friction point during development.

**5. The current system mostly works.** For our scale (handful of agents, tasks measured in minutes not days), the SQLite + polling daemon is good enough. The durability gap matters, but it hasn't caused significant data loss in practice.

---

### Staged Adoption Path (If We Proceed)

Rather than a big-bang rewrite, Temporal can be adopted incrementally:

**Phase 1 — Durable Plan Execution Only (2–3 days)**  
Replace `executor.ts`'s in-memory DAG execution with a Temporal workflow that spawns child workflows per plan step. Keep the rest of the daemon unchanged. This immediately fixes the "crash mid-plan = lost progress" problem.

**Phase 2 — Human-in-the-Loop Approval (1–2 days)**  
Add a signal-based approval gate to the agent task workflow. Wire a Slack webhook to send `humanDecision` signals. This unblocks the use case of requiring human sign-off on high-impact tasks (production deploys, security changes).

**Phase 3 — Full Daemon Migration (~1 week)**  
Replace the poll loop in `daemon.ts` with Temporal Schedules. Migrate GitHub issue polling, PR review cycles, and the supervisor to Temporal workflows. Retire the SQLite `tasks` table in favor of Temporal's Event History.

---

### Decision Criteria for Moving to Phase 1

Start Phase 1 when any of these are true:

- A daemon crash mid-plan causes real data loss that affects agent output
- A multi-day task (e.g., a multi-PR feature) is needed and state persistence is required
- A human-in-the-loop approval flow is explicitly requested for a use case
- Agent count grows beyond 5 and coordination complexity increases

Until then: maintain the current system, fix durability with simple task checkpointing if needed, and keep this document as the implementation plan.

---

## Appendix: Key Temporal Concepts

| Concept | Definition |
|---|---|
| **Workflow** | Deterministic orchestration function. Coordinates activities, manages state, handles signals. Runs in a V8 sandbox — no network/fs/randomness. |
| **Activity** | Regular async function. All side effects live here: LLM calls, API requests, DB writes. Retried automatically with configurable backoff. |
| **Task Queue** | Named channel between Temporal server and workers. Workers poll queues; activities are dispatched to queues. Enables routing by capability. |
| **Signal** | Async message to a running workflow. Enables external events (human decisions, PR merges, Slack replies) to unblock waiting workflows. |
| **Query** | Synchronous read of workflow state. Non-mutating. Used by external systems to inspect what a workflow is currently doing. |
| **Event History** | Append-only log of all workflow state transitions, stored in Postgres/Cassandra. Replayed on crash to restore workflow state. |
| **Determinism** | Workflow code must produce the same sequence of commands given the same history. No randomness, no time, no I/O in workflow code. |
| **`proxyActivities`** | Creates a typed proxy where calling a function schedules an Activity Task instead of calling directly. Core abstraction for invoking activities from workflows. |
| **`condition(fn, timeout?)`** | Suspends workflow until predicate returns true or timeout elapses. The primary primitive for waiting on signals. Zero resource cost while waiting. |
| **Namespace** | Isolation unit within Temporal. Independent retention, security, visibility. Default namespace is `default`. |
| **Child Workflow** | Workflow started by another workflow. Used for parallelism (`Promise.all`) and modularity (sub-tasks in a plan). |
| **Schedule** | Server-side cron job that starts workflows on a time spec. Observable, pausable, triggerable manually via CLI/API. |

---

## References

- [Temporal TypeScript SDK Docs](https://docs.temporal.io/develop/typescript)
- [Temporal Docker Compose (GitHub)](https://github.com/temporalio/docker-compose)
- [Temporal for AI Agents (official)](https://temporal.io/solutions/ai)
- [Temporal + OpenAI Agents SDK Integration](https://temporal.io/blog/announcing-openai-agents-sdk-integration)
- [Durable Multi-Agentic AI with Temporal](https://temporal.io/blog/using-multi-agent-architectures-with-temporal)
- [temporal-ai-agent Demo (GitHub)](https://github.com/temporal-community/temporal-ai-agent)
- [Human-in-the-Loop AI Agent Cookbook](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python)
- [Temporal Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)
- [Temporal Versioning Guide (TypeScript)](https://docs.temporal.io/develop/typescript/versioning)
- [Temporal Cloud Pricing](https://docs.temporal.io/cloud/pricing)
