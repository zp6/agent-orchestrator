# Workflow

How work is tracked across Linear and GitHub. Routing decisions made at issue-creation time; both trackers remain authoritative for their assigned scope.

## Split

| Goes in **Linear** | Stays in **GitHub** |
|---|---|
| OKRs and key-result tracking | Per-repo bugs and code fixes |
| Multi-week / multi-issue projects (OKR-4 work) | PR-bound issues (anything fixed by one PR) |
| Charter workstreams and strategy | Orchestrator-internal triage |
| External-engagement tracking (which OSS projects, what stage, by whom) | Code review and PR feedback loops |
| Director retros and quarterly planning | Auto-detected operational issues (CI failures, health checks) |
| RESOURCES.md asks (canonical home is Linear; `RESOURCES.md` mirrors) | |
| Federation partnership tracking | |

## Why this split

- **Linear excels at workflow state, projects, cycles, dependencies.** OKR tracking and multi-step work fit naturally; the cycle/project model surfaces progress views the GitHub Issues UI doesn't provide.
- **GitHub excels at code-coupled work.** PRs, reviews, repo-scoped bugs, CI integration, branch context. Anything that lives next to the diff stays in GitHub.
- **Avoid duplication.** A single piece of work has exactly one home. If it shows up in the wrong tracker, it gets moved, not mirrored.

## Routing rules (enforced by orchestrator)

1. **Issue created in GitHub for an OKR-tracked theme** → orchestrator opens a Linear project entry, links back to the GitHub issue, and treats the Linear entry as canonical for status. The GitHub issue stays open as the implementation thread.
2. **Issue created in Linear that requires code in a specific repo** → orchestrator files a corresponding GitHub issue when work begins; the Linear issue tracks overall status, the GitHub issue tracks the PR-level implementation.
3. **External engagement (OSS upstream contribution)** → tracked in Linear as a project entry per upstream repo; individual contributions get sub-issues.
4. **Operator escalations** → land in `RESOURCES.md` (in-repo) AND a Linear "Operator queue" project (canonical). Operator monitors both.

## Verification and comment-back

The verifier writes outcomes to whichever tracker the work originated from. `verification.sources` in `agents.yaml` controls polling and comment-back targets.

## Cadence

- **Daily standups** — pull from both trackers; agenda surfaces top-priority items regardless of source.
- **Weekly Director retro** — reviews Linear cycle progress and GitHub backlog state together. Stale entries pruned in both.
- **Quarterly retros** — Linear is primary view (OKR alignment); GitHub is secondary view (code health).
