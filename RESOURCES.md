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

### 4. Daemon migration off Operator's laptop

- **Status**: open
- **Asked by**: orchestrator
- **Asked on**: 2026-04-27
- **Unlocks**: 24/7 autonomous operation. Currently the fleet stops when the Operator's laptop sleeps or restarts.
- **Recommendation**: **Hetzner CX42** (8 vCPU, 16GB RAM, 160GB disk, ~$15/mo). Linux VM with full Docker support, fits the proxy's docker-in-docker architecture cleanly, well inside the monthly budget. Fleet self-provisions via Hetzner Cloud API once the Operator creates an API token.
  - Railway and similar PaaS options were evaluated and rejected: they don't expose the Docker socket, breaking the proxy's container lifecycle management. Cost would also be 4–8× higher for our always-on multi-container shape.
  - Spare Mac mini (if Operator has one idle) is a free alternative and beats Hetzner if available.
- **Effort for Operator**: create a Hetzner Cloud account, generate an API token, drop it in `~/.claude-orchestrator/.env` as `HETZNER_API_TOKEN=...`. Fleet handles the rest (provision, configure, migrate, verify).
- **Notes**: Article I autonomy is partially fictional until this is resolved. Fleet is happy to design the migration and execute it.

## In progress

_(none yet)_

## Done

_(none yet)_

## Declined

_(none yet)_
