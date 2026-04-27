# Resources

Standing channel for fleet → Operator escalations. Per Article V of `CHARTER.md`, the fleet is expected to push back on resource constraints when more resources would unlock meaningful progress.

The Operator monitors this file. Asks should be specific, prioritized, and include the unlock value.

## Format

Each ask is one entry:

- **Status**: `open` / `in-progress` / `done` / `declined`
- **Asked by**: agent or fleet body
- **Asked on**: ISO date
- **Unlocks**: what becomes possible
- **Effort for Operator**: estimate
- **Notes**: context

## Open

### 1. GitHub App registration

- **Status**: open
- **Asked by**: orchestrator
- **Asked on**: 2026-04-27
- **Unlocks**: per-agent first-class GitHub identities; ToS-compliant, attributable, scoped permissions; replaces the Operator's PAT as the fleet's GitHub credential.
- **Effort for Operator**: ~5 minutes in the GitHub Apps UI, one-time. Fleet provides the App spec (name, scopes, callback URL) when ready.
- **Notes**: P0 enabler for autonomy under Article VII. Fleet flags when the App spec is ready for registration.

### 2. Grok API key — DEFERRED

- **Status**: deferred (2026-04-27)
- **Asked by**: orchestrator
- **Asked on**: 2026-04-27
- **Decision**: Operator and orchestrator agreed to delay. Grok API is per-token billed (no subscription harness like `claude`/`codex`) and stateless (no persistent session). Cognitive-diversity role to be filled by local M4 serving (NEX-14) using a model lineage different from Claude/GPT — full session persistence, zero per-token cost.
- **When this re-opens**: if NEX-14 eval concludes local lineages are insufficient for diverse meeting voice, OR if xAI ships an OAuth/subscription CLI harness.
- **Note**: `grok-meeting-voice` agent config and adapter are already in main (#1211, #1220) — they sit dormant without the key, no harm.

### 3. Deepseek API key — DEFERRED

- **Status**: deferred (2026-04-27)
- **Asked by**: orchestrator
- **Asked on**: 2026-04-27
- **Decision**: Same reasoning as #2 — Deepseek is API-only, per-token billed, stateless. Background-workload role (embeddings, semantic reindex, fuzzing) and reviewer-reasoning role both better filled by local M4 serving with full session persistence at $0 marginal cost.
- **When this re-opens**: if NEX-14 eval concludes local code models can't match Deepseek-V3-Lite quality for the role, OR if Deepseek ships a subscription/CLI harness.
- **Note**: `deepseek-background` and `deepseek-reasoning` agent configs are already in main — dormant without the key.

### 4. Daemon migration off Operator's laptop — DEFERRED

- **Status**: deferred
- **Asked by**: orchestrator
- **Asked on**: 2026-04-27
- **Decision**: 2026-04-27 — Operator's M4 laptop is the host for now. Always-on, plenty of capacity, $0/mo. Migration is deferred until the fleet ships a public-facing service with an SLA, at which point residential hosting becomes blocking.
- **Hardening for laptop hosting** (fleet executes — see issue):
  - `caffeinate -dimsu` keeps the laptop awake permanently
  - OrbStack set to start on login
  - Daemon migrated from `nohup` to a launchd plist for clean restart-on-crash
  - Health monitoring already in place
- **When this re-opens**: the moment the fleet picks up a public-service workstream that requires 24/7 uptime, federation endpoints, or external SLA. Fleet flags via this file at that point.

### 6. Linear API key — DONE

- **Status**: done (2026-04-27)
- **Asked by**: orchestrator
- **Asked on**: 2026-04-27
- **Resolution**: Key + team identifier provided and verified. Auth confirmed against Linear API.
  - `LINEAR_API_KEY` and `LINEAR_TEAM_KEY=NEX` in `~/.claude-orchestrator/.env`
  - Team: Nexus (NEX) — ID `117390e7-d572-441e-9228-e6ad9e0efea4`
- **Note**: currently using Operator's personal API key, same shared-credential pattern as GitHub PAT. Per-agent Linear OAuth (mirroring the GitHub App migration in #1210) is a follow-up once Linear's OAuth flow is wired.

### 5. (Self-resolving) Take full advantage of the M4

- **Status**: open — fleet executes
- **Asked by**: orchestrator
- **Asked on**: 2026-04-27
- **Unlocks**: free inference capacity. The Operator's M4 has substantial idle GPU/Neural Engine capacity. Local OSS models served via Ollama or MLX can absorb embeddings, semantic memory reindexing, curriculum drilling, red-team fuzzing, and routine background work — at zero marginal cost. Becomes the cheapest tier in the cost-tiered routing strategy (Article VI).
- **Effort for Operator**: none directly. Fleet installs Ollama, pulls models, wires the LLM client adapter, monitors RAM/thermal headroom. Operator gets a Telegram alert if local inference starts impacting laptop responsiveness.
- **Suggested initial models**:
  - `qwen2.5-coder:32b` — coding tasks, ~20GB RAM
  - `nomic-embed-text` — embeddings, ~500MB RAM
  - `llama3.3:70b-instruct-q4` — general background reasoning, ~40GB RAM (fits if no other heavy workloads)
- **Notes**: this isn't a fourth provider in the cognitive-diversity sense — it's the cheapest cost tier. Frontier models still own high-stakes work.

## In progress

_(none yet)_

## Done

_(none yet)_

## Declined

_(none yet)_
