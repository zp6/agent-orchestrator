# Per-Agent GitHub App Identity Migration

Target repo: `rapartlu/agent-orchestrator`

This is the fleet-facing source of truth for replacing the shared Operator PAT
with per-agent GitHub App installation tokens.

## Goal

Every agent should authenticate to GitHub as its own bot identity.

- PRs, reviews, comments, labels, and issue operations are authored through the
  agent's own installation token.
- No agent process should depend on a shared operator PAT at runtime.
- Tokens are short-lived, cached in memory, and refreshed before expiry.

## App Spec

### App name

`claude-agent-orchestrator`

### Callback URL

Use the orchestrator callback endpoint registered in GitHub App settings.
For local and staging setups, keep this as a dedicated GitHub App callback
route rather than a reusable human OAuth callback.

### Installation model

- One GitHub App.
- One installation per target repository.
- One installation token per agent runtime.
- The runtime injects the token into `gh` and API clients as the agent's own
  identity.

### Permissions matrix

The matrix below is the intended minimum set. Grant the narrowest permissions
that let each agent complete its own work.

| Agent role | Primary repo(s) | GitHub App permissions |
|---|---|---|
| Orchestrator | `rapartlu/agent-orchestrator` | `Contents: Read & write`, `Issues: Read & write`, `Pull requests: Read & write`, `Metadata: Read` |
| Reviewer | `rapartlu/agent-reviewer` | `Contents: Read`, `Issues: Read & write`, `Pull requests: Read & write`, `Metadata: Read` |
| Dashboard | `rapartlu/agent-dashboard` | `Contents: Read`, `Issues: Read`, `Pull requests: Read`, `Metadata: Read` |
| Research | `rapartlu/research-agent` | `Contents: Read`, `Issues: Read & write`, `Metadata: Read` |
| Proxy | `rapartlu/agent-proxy` | `Contents: Read`, `Metadata: Read` |
| Meeting facilitator | `rapartlu/meeting-facilitator-agent` | `Contents: Read`, `Issues: Read & write`, `Metadata: Read` |

Notes:

- If an agent must review or edit PRs, grant `Pull requests: Read & write`.
- If an agent only reports findings, prefer `Issues: Read & write` and keep
  `Contents` read-only.
- Avoid broad org-wide access unless a repo genuinely needs it.

## Auth flow

1. Load the app private key and installation ID for the agent.
2. Mint a short-lived GitHub App JWT.
3. Exchange the JWT for an installation token.
4. Cache the token in memory until 5 minutes before expiry.
5. Refresh on expiry or when GitHub returns an auth failure.
6. Inject the token into `GH_TOKEN` and `GITHUB_TOKEN` for the agent process.
7. Let the agent's own repo identity drive authorship and audit trail.

## Runtime contract

- `gh` CLI calls must run with the per-agent installation token.
- GitHub API calls must use the same token.
- No token should be written to disk.
- No token should be shared across agents.
- Commit author metadata should match the bot identity for that agent.

## Migration sequence

1. Orchestrator
2. Reviewer
3. Dashboard
4. Research
5. Proxy

Ship each stage only after verifying that the resulting PR, review, or comment
is authored under the new bot identity.

## Decommission checklist

- Remove the shared Operator PAT from `.env`.
- Remove any PAT references from `CLAUDE.md`.
- Confirm the runtime only reads per-agent GitHub App credentials.
- Keep the installation token cache in-memory only.

## Operator step

Once the app spec is accepted:

1. Register the app in the GitHub UI.
2. Grant the initial installations for the fleet repos.
3. Flip the fleet flags in `RESOURCES.md` and Telegram.
4. Verify the next PR from each staged agent is authored by the new bot
   identity.
