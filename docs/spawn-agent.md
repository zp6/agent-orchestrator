# Spawning a new fleet agent

This is the runbook for adding a new agent to the fleet. It exists because containers cannot bootstrap themselves: creating a GitHub repo, writing to the host filesystem, and editing the proxy's compose stack all require operator-level access. Until those gaps close (issue #1264 severance, GitHub-App identity migration), agent spawning is an operator-attended workstream.

The audience is whoever (operator, or a Claude Code session with host access) is doing the spawn. Follow the steps in order; each one is small.

## When to spawn

Add a new agent when there is a coherent, recurring fleet capability that:

- Doesn't fit the scope of any existing agent (reviewer = code, verifier = task quality, supervisor = decisions, Director = dispatch, dashboard = observability, research = investigation, meeting-facilitator = coordination).
- Has structured inputs and structured outputs (so it can be tested and dispatched).
- Earns its quota cost — the binding constraint is daily rate-limit ceiling, not dollars; an agent that runs once a week for $0.30 is fine, an agent that runs every cycle and burns 50k tokens may not be.

Don't spawn for: one-off tasks (use direct dispatch), product features (build them in an existing agent), or roles that overlap with an existing agent (extend the existing one instead).

## Prerequisites on the host

- `gh` authenticated as the operator account (currently `rapartlu`) with `repo` scope.
- `git` configured.
- Node 20+ (for the husky pre-push hook).
- Working directory `~/Documents/Git/` (or wherever the operator's fleet repos live).

## Steps

### 1. Pick a template

Two templates exist:

- `rapartlu/meeting-facilitator-agent` — TypeScript with `src/`, `tsconfig.json`, vitest, husky. **Use this for new agents.**
- `rapartlu/research-agent` — older plain-JS layout with capability-check HTTP server. Use this only if you specifically need the capability-check pattern; the TypeScript template is cleaner.

### 2. Create the GitHub repo

All fleet agent repos are private and live under `rapartlu`. Naming convention is `<topic>-agent` (matching `meeting-facilitator-agent`, `claude-research-agent`).

```bash
gh repo create rapartlu/<name>-agent --private --description "<one-line role description>"
```

Don't initialize via the gh flag — we want to push from a local clone of the template.

### 3. Clone the template and rename

```bash
cd ~/Documents/Git
git clone git@github.com:rapartlu/meeting-facilitator-agent.git <name>-agent
cd <name>-agent

# strip the template's history; the new agent gets its own
rm -rf .git
git init
git remote add origin git@github.com:rapartlu/<name>-agent.git
```

### 4. Adapt the skeleton

These files always need changing:

- `package.json` — set `"name"` and `"description"` to match the new agent.
- `CLAUDE.md` — rewrite the "What this agent does", "Scope" (owns / does not own), and behavioural-rules sections. Keep the writing-style block as-is (UK English, no emdashes, no LLM-isms — these are fleet-wide rules).
- `ROADMAP.md` — clear it. The new agent's roadmap starts empty.
- `README.md` — one-paragraph description. Optional.
- `SPEC.md` — if the agent has a public schema (like meeting-facilitator's MeetingOutcome), define it here. Otherwise delete.
- `src/` — replace the meeting-facilitator-specific modules with skeleton modules for the new agent's role. Keep `src/index.ts` as the entry point.
- `test/` — replace tests; keep husky + vitest config.

These files almost never change:

- `.husky/pre-push` — runs `tsc --noEmit && npm test`. Keep it.
- `.gitignore` — generic Node ignores. Keep it.
- `tsconfig.json` — keep it; tweak only if the new agent has unusual module needs.

### 5. Initial commit and push

```bash
git add -A
git commit -m "feat: initial scaffolding for <name>-agent"
git push -u origin main
```

### 6. Register in the orchestrator

In `rapartlu/agent-orchestrator` (this repo), add a block to `agents.yaml`:

```yaml
  <name>-agent:
    dir: "<name>-agent"
    repo: "git@github.com:rapartlu/<name>-agent.git"
    provider: "claude"           # or "openai" for codex variants
    model: "claude-sonnet-4-6"   # or whichever is appropriate
    description: "<one-line role description>"
    capabilities: ["<capability1>", "<capability2>"]
    capability_tags: ["<routing-tag1>"]
    github: "rapartlu/<name>-agent"
    owns_topics: ["<topic1>", "<topic2>"]
    # Pick a housekeeping_offset_cycles slot that doesn't collide with existing
    # agents. Existing slots: research=30, reviewer=10, dashboard=20,
    # meeting-facilitator=50. New agents take the next free 10-cycle slot.
    housekeeping_offset_cycles: <unused-slot>
    docker:
      port: <next-free-port>     # check existing entries; ports go 3476, 3477, ...
      api_key: "cheese"
      permissions: "bypassPermissions"
      session: "fresh"
```

Then open a PR against `agent-orchestrator` with the registration. Tag the originating spawn issue.

### 7. Wire the container in `claude-proxy`

This step is in the `claude-proxy` repo, separate PR. It involves:

- A new `Dockerfile.<name>-agent` (clone of an existing one, swap the repo name).
- An entry in the compose generator (`docker-compose.generated.yml` is generated from agents.yaml; check the generator script in `claude-proxy/scripts/` or `src/`).
- Secrets entries: `<name>-agent_gh_token`, `<name>-agent_oauth_token`, etc., wired through the proxy's secret-fleet system.

If the compose generator is fully wired to read agents.yaml, this step may collapse to: regenerate the compose file and rebuild the proxy stack.

If not, this is the most operator-heavy step. File a follow-up issue if the compose generator is incomplete; that gap should close before more agents are spawned.

### 8. Build and verify

```bash
cd ~/Documents/Git/claude-proxy
docker compose build <name>-agent
docker compose up -d <name>-agent
docker logs claude-proxy-<name>-agent-1
curl http://127.0.0.1:<port>/health
```

Confirm the daemon picks it up:

```bash
curl -H "x-api-key: cheese" http://localhost:3400/v1/agents | jq '.[] | select(.name == "<name>-agent")'
```

### 9. First-run smoke test

Dispatch a trivial task to the new agent via the orchestrator daemon (or `orch dispatch <name>-agent "<test prompt>"`). Confirm the task lands in `state.db` and completes. Until this works, the spawn is not finished.

## Operator actions to log

Per `docs/operator-actions.md`, append a row for the spawn:

```
| YYYY-MM-DD | infra | Spawned <name>-agent (repo + container + agents.yaml registration) | #<issue> | Spawned manually — repo-create + compose-edit are operator-level capabilities, see #1264 |
```

This makes the spawn visible to the Auditor agent's daily pass and to the operator-actions trailing-30d KR.

## Failure modes seen

- **Compose stack not regenerating after `agents.yaml` change.** If the compose generator is incomplete, the new agent won't appear. Check `docker-compose.generated.yml` after the generator runs; if the new entry is missing, the generator needs fixing.
- **Secrets not provisioned.** Each agent needs its own `gh_token`, `oauth_token`, etc. If the secret-fleet system isn't auto-creating these, the container will start but every dispatch will fail with auth errors. Check `docker logs` for `Connection error` or 401s.
- **Port collision.** Always pick the next free port; don't reuse one. `docker compose up` will fail loudly if the port is taken, but it's faster to check first.
- **iCloud eviction.** `~/Documents/Git/` is iCloud-synced. After cloning the template, run `npm install` immediately to materialize `node_modules` locally; otherwise the husky pre-push hook may hang on first push (see `MEMORY.md` `icloud_node_modules_hang`).

## Why this is a runbook and not a script

A `scripts/spawn-agent.sh` would be the right end state, but it's not the right starting point. Each spawn so far has had unique adaptations (research-agent's HTTP capability-check, meeting-facilitator's SPEC.md schema). Codifying the pattern prematurely would constrain agents that don't fit it. Once three more agents are spawned using this runbook and the diffs converge, a script becomes worth writing.

Until then: follow the runbook, log what's special about the new agent, and update this document when you find something the runbook missed.
