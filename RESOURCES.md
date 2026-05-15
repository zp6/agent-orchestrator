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

### 6. Linear API key — ESCALATION: NOT MATERIALIZED

- **Status**: open (credential provided but not in agent container)
- **Asked by**: orchestrator
- **Asked on**: 2026-04-27
- **Current blocker**: Credential propagation defect — key confirmed "provided and verified" (2026-04-27) but `~/.claude-orchestrator/.env` contains only placeholder `lin_api_...`
- **Impact**: Task "[linear] Check issues for claude-research-agent" dispatched 9+ times since 2026-05-04T02:14:29Z; all attempts fail with "Connection error" at step 3 (commenting on Linear issues)
- **To unblock**: Operator must update `~/.claude-orchestrator/.env`:
  ```
  LINEAR_API_KEY=lin_api_<actual-key-from-Linear-Settings>
  LINEAR_TEAM_KEY=NEX
  ```
- **Effort for Operator**: ~1 minute — copy paste actual key into existing file
- **Evidence**: 
  - Issue #1474 filed documenting the dispatch loop
  - ROADMAP #1445 documents this as "Credential propagation defect"
  - File exists but contains only placeholder; no real key materialized
- **Note**: This is Article V (resource request) + infrastructure defect (#1445). The key provision (2026-04-27) was done, but infrastructure to deliver it to agent containers was incomplete.

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

### 8. Zero-revenue retro: four operator decisions (#1511)

- **Status**: open
- **Asked by**: claude-agent-orchestrator
- **Asked on**: 2026-05-15
- **Context**: `docs/retros/2026-05-15-zero-revenue-retro.md`. Fleet has earned $0 in 18 days under Article V. Day-30 deadline (2026-05-27) is 12 days out and $400 target is not achievable on organic revenue. Four decisions only the Operator can make:
  1. **Subscription renewal**: renew Claude Code / OpenAI past 2026-05-27, accept sunset, or pre-load fleet treasury one-time as "founding-capital extension"?
  2. **Capital recovery**: leave $42 USDC.e on Polygon (fleet recommendation, ~$3 bridge fee avoided), or bridge back to Base + Morpho?
  3. **Polymarket rail**: continue CLOB-auth debugging, park, or decommission? Fleet recommendation: park (auth black box + no demonstrated edge).
  4. **`IMMUNEFI_API_TOKEN` provisioning**: unlocks Layer 3 Phase B live submission. Closest-to-end-to-end revenue path the fleet has. Cost: zero. Risk: zero (rate-limited public API).
- **Effort for Operator**: ~5 minutes (decisions 1, 2, 3 are read-and-reply; decision 4 is one env-var addition to `~/.claude-orchestrator/.env`).
- **Notes**: surfaced here per operator-communication-discipline (CLAUDE.md). Not pushed to Telegram (not an outage). Fleet does not require all four decisions to proceed: each is independent, retro stays valid even if all four go un-answered, fleet keeps shipping reliability work in the meantime.

### 7. Cloudflare credentials — API token + account ID

- **Status**: open
- **Asked by**: claude-agent-orchestrator
- **Asked on**: 2026-05-08
- **Unlocks**: (a) `orch dns` CLI — fleet autonomously manages `*.wearetarr.com` DNS records, closing NEX-12 sub-tasks #1464 (nexus CNAME) and #1466 (email routing CNAME) without any further Operator UI action; (b) Worker deployment — fleet deploys the Hire-the-Fleet landing page (`src/worker/`) via `wrangler deploy`, surfaces the `workers.dev` URL as the CNAME target for #1464
- **Effort for Operator**: ~2 minutes one-time
  1. Go to <https://dash.cloudflare.com/profile/api-tokens> → Create Token → "Edit zone DNS" template scoped to `wearetarr.com` zone → copy token
  2. Go to <https://dash.cloudflare.com> → top-right account menu → copy Account ID (32-char hex)
  3. Add both to `~/.claude-orchestrator/.env`:
     ```
     CLOUDFLARE_API_TOKEN=<token>
     CLOUDFLARE_ACCOUNT_ID=<account-id>
     ```
- **Why this replaces operator UI action**: once these two values are in the env file, the fleet runs `wrangler deploy` (hosting target), then `orch dns add nexus.wearetarr.com --type CNAME --target <worker-url>` — zero further Operator interaction. All future `*.wearetarr.com` sub-domains are fleet-managed from that point.
- **Notes**: Cloudflare nameservers confirmed (2026-05-08 `dig NS wearetarr.com +short` returns `tara.ns.cloudflare.com`, `margo.ns.cloudflare.com`). Hosting target (Cloudflare Worker URL) is TBD until deployment runs — fleet will post the confirmed URL back to issue #1464 after first deploy. `orch dns` CLI issue filed at #1513.

## In progress

_(none yet)_

## Done

_(none yet)_

## Declined

_(none yet)_
