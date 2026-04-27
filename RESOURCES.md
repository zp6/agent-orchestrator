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

### 2. Grok API key

- **Status**: open
- **Asked by**: orchestrator
- **Asked on**: 2026-04-27
- **Unlocks**: Grok 4 as a meeting voice — non-voting standup participant providing viewpoints from a materially different model lineage. Article VI cognitive-diversity work.
- **Effort for Operator**: xAI console → API key → drop in `~/.claude-orchestrator/.env` as `XAI_API_KEY=...`
- **Notes**: Used only for meetings initially. Expanded to dispatch only if it earns it.

### 3. Deepseek API key

- **Status**: open
- **Asked by**: orchestrator
- **Asked on**: 2026-04-27
- **Unlocks**: Deepseek V3 for cheap heavy background workloads (embeddings, semantic memory reindexing, fuzzing); Deepseek R1 as a third reasoning voice in the reviewer pool.
- **Effort for Operator**: deepseek.com → API key → drop in `~/.claude-orchestrator/.env` as `DEEPSEEK_API_KEY=...`
- **Notes**: ~10–20× cheaper than frontier models. Cost-tier strategy: Deepseek for volume, frontier models for stakes.

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
