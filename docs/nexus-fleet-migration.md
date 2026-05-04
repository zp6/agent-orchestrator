# Nexus Fleet — GitHub Org Migration Guide

**Status:** Pending operator action (org creation + repo transfers)  
**Tracking issue:** [#1470](https://github.com/rapartlu/agent-orchestrator/issues/1470)  
**Decision:** Revised 2026-05-04 — create `nexus-fleet` org and migrate all fleet repos  
**Rationale:** `rapartlu/` org is operator-identity-bound; severs cleanly via `nexus-fleet/`

---

## Why This Migration

Per Charter Article VII (per-agent identity) and the operator severance trajectory (#1264),
the fleet's public GitHub identity must be decoupled from the Operator's personal handle.
`rapartlu/` is the Operator's personal GitHub username. Fleet repos living there create an
identity dependency that outlasts the 24-month severance window.

`nexus-fleet` is the fleet's own org — autonomous identity, operator-independent.

GitHub auto-creates permanent redirects from old paths for a transition period, so existing
clones, forks, and CI webhooks continue to work after the transfer.

---

## Pre-Conditions (all must be true before starting)

- [ ] All open PRs on each repo are merged or closed (no in-flight work lost)
- [ ] Daemon is **stopped** before changes to `agents.yaml` take effect
- [ ] Full backup of `~/.claude-orchestrator/state.db` taken
- [ ] Fleet treasury signer is stopped (if running) to avoid signing during transition

---

## Part 1 — Operator Actions (~2h total)

### Step 1 — Create the `nexus-fleet` GitHub org (~10 min)

1. Go to https://github.com/organizations/plan — click **New organization**
2. Plan: **Free** (sufficient for public repos; upgrade when private repos needed)
3. Org name: **`nexus-fleet`**
4. Contact email: use fleet email (see `#1465` — fleet email infra)
5. Set org profile:
   - Description: "Autonomous agent fleet — Nexus"
   - URL: fleet landing page (see `#1464` — fleet DNS)
   - Logo: fleet identity asset (see `#1466`)
6. Skip team/member invitations (fleet uses App identities, not member handles)

### Step 2 — Transfer repos (~15 min for all 6)

Transfer in this priority order (most depended-upon first):

| Repo | Transfer from → to |
|------|-------------------|
| `agent-orchestrator` | `rapartlu/agent-orchestrator` → `nexus-fleet/agent-orchestrator` |
| `agent-reviewer` | `rapartlu/agent-reviewer` → `nexus-fleet/agent-reviewer` |
| `agent-dashboard` | `rapartlu/agent-dashboard` → `nexus-fleet/agent-dashboard` |
| `proxy` | `rapartlu/proxy` → `nexus-fleet/proxy` |
| `fleet-signer` | `rapartlu/fleet-signer` → `nexus-fleet/fleet-signer` |
| `research-agent` | Transfer when created |

For each repo:
1. Repo → **Settings → General** → scroll to "Danger Zone" → **Transfer**
2. Enter org name: `nexus-fleet`
3. Confirm repo name when prompted
4. GitHub immediately creates a permanent redirect from `rapartlu/<repo>` → `nexus-fleet/<repo>`

### Step 3 — Re-install per-agent GitHub Apps (~30–60 min)

Per-agent GitHub Apps (see RESOURCES.md item #1) must be reinstalled under the new org.
For each App installation:
1. Go to the App's settings → **Install App** → choose `nexus-fleet`
2. Verify the App can read/write issues and PRs on each transferred repo
3. Update the App's `GITHUB_APP_INSTALLATION_ID` in each agent container's env

If using a shared PAT instead of per-agent Apps (current state per RESOURCES.md):
1. Generate a new PAT scoped to `nexus-fleet` org
2. Update `GITHUB_TOKEN` / `GH_TOKEN` in daemon env and each agent container

### Step 4 — Update CI configuration (~15 min)

For each repo, check `.github/workflows/` for hardcoded `rapartlu/` refs and update:

```bash
# In each transferred repo
grep -r "rapartlu" .github/ --include="*.yml" --include="*.yaml"
```

Common patterns to update:
- `gh pr list --repo rapartlu/...` → `gh pr list --repo nexus-fleet/...`
- Webhook URLs that include the org name
- Any external service integrations (Linear, Telegram bot config)

---

## Part 2 — Fleet Actions (after Part 1 completes)

The fleet executes these steps immediately after the org transfer is confirmed.

### Step 5 — Run the automated ref-update script

```bash
# From the agent-orchestrator repo root
bash scripts/post-migration-update-refs.sh
```

This script replaces `rapartlu/` with `nexus-fleet/` in:
- `agents.yaml`
- `CLAUDE.md`
- `ROADMAP.md`
- All `src/**/*.ts` source files
- All `docs/**/*.md` documentation

**Review the diff before committing:**
```bash
git diff
```

**Manual review required for:**
- `src/orchestrator/pr-reviewer.ts` — hardcoded `--add-reviewer rapartlu` (line ~602); this must
  become the fleet's own reviewer identity, not just a ref update
- `src/orchestrator/pr-lister.ts` — `r.login === "rapartlu"` check for escalation detection;
  update to use the per-agent GitHub App bot username
- `src/triggers/seed-antibodies.ts` — historical issue refs (e.g. `rapartlu/agent-orchestrator#1347`);
  these are historical anchors that GitHub's redirect will handle; leave as-is or update with care

### Step 6 — Update `agents.yaml`

After the script run, verify these specific `agents.yaml` fields were updated:
- `repo:` fields (git remote URLs) — should become `git@github.com:nexus-fleet/<repo>.git`
- `github:` fields — should become `nexus-fleet/<repo>`

Example diff:
```yaml
# Before
claude-agent-orchestrator:
  repo: "git@github.com:rapartlu/agent-orchestrator.git"
  github: "rapartlu/agent-orchestrator"

# After
claude-agent-orchestrator:
  repo: "git@github.com:nexus-fleet/agent-orchestrator.git"
  github: "nexus-fleet/agent-orchestrator"
```

### Step 7 — Update local git remotes on each agent container

```bash
# In each agent container / local clone
git remote set-url origin git@github.com:nexus-fleet/<repo-name>.git

# Verify
git remote -v
git fetch origin
```

### Step 8 — Restart daemon and smoke-test

```bash
# Restart daemon with new config
orch service stop
orch service start

# Verify agents are online
orch agents
orch health

# Dispatch a no-op test
orch dispatch "echo migration smoke test" --agent=claude-agent-orchestrator
orch status --state=done
```

### Step 9 — Update each repo's CLAUDE.md

Each repo's `CLAUDE.md` contains the repo identity and GitHub issue URL patterns. Run the
ref-update script on each repo after transfer, then verify:
- The repo's own `github.com/nexus-fleet/...` URL is correct in docs
- Issue links in `docs/standups/` still resolve (GitHub redirect handles old URLs)
- Any agent-identity lines updated

---

## Rollback

GitHub keeps permanent redirects active for at least 90 days post-transfer. If the migration
breaks something:

1. **Immediate**: GitHub redirects mean old `rapartlu/` URLs still work — no link rot in production
2. **Revert agents.yaml** to `rapartlu/` remote URLs and restart the daemon
3. **Transfer repos back** if needed: repos can be transferred back to `rapartlu` via Settings → Transfer

---

## Sibling Tasks

This migration is part of NEX-12. Sibling operator-action sub-tasks:
- **#1464** — DNS setup for fleet landing page (nexusfleet.dev or similar)
- **#1465** — Mastodon / email identity infra
- **#1466** — Fleet logo and public profile assets
- **#1264** — Operator severance master plan (this migration de-blocks it)

---

## Acceptance Verification Checklist

After migration, verify:

- [ ] `github.com/nexus-fleet/agent-orchestrator` is accessible
- [ ] `github.com/nexus-fleet/agent-reviewer` is accessible
- [ ] `github.com/nexus-fleet/agent-dashboard` is accessible
- [ ] `github.com/nexus-fleet/proxy` is accessible
- [ ] `github.com/nexus-fleet/fleet-signer` is accessible
- [ ] CI green on each repo's `main` branch post-migration
- [ ] Per-agent GitHub Apps (or updated PAT) can post PRs/comments under `nexus-fleet/`
- [ ] Daemon health: `orch health` shows all agents online
- [ ] `agents.yaml` `github:` fields reference `nexus-fleet/...`
- [ ] `CLAUDE.md` references updated to `nexus-fleet/...`
- [ ] Old `rapartlu/agent-orchestrator` URL redirects correctly → `nexus-fleet/agent-orchestrator`
