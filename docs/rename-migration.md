# Repo Rename Migration: `claude-*` → Provider-Agnostic Names

**Status:** Pending — execute after multi-provider support is tested and stable.
**Tracking issue:** [#402](https://github.com/rapartlu/agent-orchestrator/issues/402)

## Motivation

With OpenAI Codex, Gemini, and other providers coming online, the `claude-` prefix on infrastructure
repos is misleading. These repos are provider-agnostic agent infrastructure, not Claude-specific.

## Rename Map

| Current Name                    | New Name               | GitHub URL (after rename)                                     |
|---------------------------------|------------------------|---------------------------------------------------------------|
| `claude-agent-orchestrator`     | `agent-orchestrator`   | `github.com/rapartlu/agent-orchestrator`                      |
| `claude-orchestrator-dashboard` | `agent-dashboard`      | `github.com/rapartlu/agent-dashboard`                         |
| `claude-orchestrator-reviewer`  | `agent-reviewer`       | `github.com/rapartlu/agent-reviewer`                          |
| `claude-proxy`                  | `agent-proxy`          | `github.com/rapartlu/agent-proxy`                             |
| `claude-research-agent`         | `research-agent`       | `github.com/rapartlu/research-agent`                          |

GitHub supports repo renames with automatic redirects — old URLs keep working.

## Pre-Conditions (must all be true before starting)

- [ ] Multi-provider support (issue #392) is merged and tested in production
- [ ] All open PRs on the repos to be renamed are merged or closed
- [ ] The daemon is **stopped** before making changes to `agents.yaml`
- [ ] A full backup of `~/.claude-orchestrator/state.db` is taken

## Migration Checklist (execute in order)

### Step 1 — Rename repos on GitHub

For each repo in the rename map above:
1. Go to **Settings → General → Repository name**
2. Type the new name and click **Rename**
3. GitHub creates a permanent redirect from the old URL — no link rot

### Step 2 — Update `agents.yaml` in `agent-orchestrator`

Update agent keys, `dir`, `repo`, and `github` fields:

```yaml
# Before
claude-agent-orchestrator:
  dir: "claude-agent-orchestrator"
  repo: "git@github.com:rapartlu/agent-orchestrator.git"
  github: "rapartlu/agent-orchestrator"

# After
agent-orchestrator:
  dir: "agent-orchestrator"
  repo: "git@github.com:rapartlu/agent-orchestrator.git"
  github: "rapartlu/agent-orchestrator"
```

Apply equivalent updates for all renamed repos. Also update:
- `orchestrator_dir` (top-level key) if the directory is renamed locally
- `base_dir` is unaffected (user-local)

### Step 3 — Update `CLAUDE.md` cross-repo references

Files that reference other repos by name:
- `claude-agent-orchestrator/CLAUDE.md` — references to `claude-orchestrator-dashboard`, `claude-orchestrator-reviewer`, `claude-proxy`
- `claude-orchestrator-dashboard/CLAUDE.md` — agent identity, issue URLs
- `claude-orchestrator-reviewer/CLAUDE.md` (if exists)
- `claude-proxy/CLAUDE.md` (if exists)

Use `grep -r "claude-orchestrator\|claude-proxy\|claude-research" . --include="*.md" --include="*.yaml" --include="*.ts"` to find all references.

### Step 4 — Update Docker container names

The Docker containers are named after agent keys in `agents.yaml`. After renaming keys:

```bash
# Stop all agent containers
orch service stop
docker ps -a | grep claude- | awk '{print $1}' | xargs docker stop
docker ps -a | grep claude- | awk '{print $1}' | xargs docker rm

# Update agents.yaml (Step 2 above)
# Then re-create containers under new names
orch agents sync
orch service start
```

### Step 5 — Update local git remotes

On each developer machine:

```bash
# In each repo directory, update the remote URL
git remote set-url origin git@github.com:rapartlu/agent-orchestrator.git
# (substitute the correct new repo name)

# Verify
git remote -v
```

### Step 6 — Update any CI/CD references

Search for old repo names in:
- GitHub Actions workflow files (`.github/workflows/`)
- Any external services (Telegram bot configs, webhook URLs)
- The `generate.sh` agent bootstrap script (if it references repo names)

### Step 7 — Verify and smoke-test

```bash
# Start the daemon and verify all agents come online
orch service start
orch agents
orch health

# Dispatch a test task
orch dispatch "echo hello" --agent=agent-orchestrator
orch status --state=done
```

## Rollback

If anything breaks, the GitHub redirects mean the old URLs still work. To roll back:
1. Revert `agents.yaml` changes (restore old agent keys)
2. Rename repos back on GitHub (Settings → rename)
3. Restart containers with old names

## Agent Identity Updates (per-agent CLAUDE.md)

Each agent's `CLAUDE.md` contains its own repo identity string (e.g., `[claude-orchestrator-dashboard]`). After renaming, each agent's CLAUDE.md should be updated to use the new name so issue/PR prefixes are consistent.
