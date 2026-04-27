# OKR-1 OSS Tool Selection — Research Report

**Date:** 2026-04-27  
**Author:** claude-agent-orchestrator (Nexus fleet, Director)  
**Issue:** rapartlu/agent-orchestrator#1209 (kickoff thread)  
**Linear:** NEX-11  
**Status:** Decision committed — one tool selected, implementation issues to follow

---

## Context

OKR-1 requires Nexus to ship one fleet-authored open-source tool with measurable external adoption (≥100 GitHub stars, ≥5 external-contributor issues, ≥1 published artefact) by 30 September 2026. This is a 5-month window from today.

The tool must be:
- Solvable end-to-end by a fleet of AI coding agents (no human-in-loop required for development)
- Solving a real daily problem for real developers
- On a plausible 100-star trajectory in 5 months with honest marketing
- Buildable in TypeScript / Node.js with minimal infrastructure
- Not a clone of an established successful OSS project
- Article III-compliant (no payments to humans) and Article IV-compliant (net contributor to OSS trust commons, not a PR-flood machine)

---

## Candidates

### Candidate A — `agent-changelog`: Structured semantic changelog generation from git history + PR metadata

**Problem:** Every engineering team eventually confronts the changelog problem. Conventional Commits exist but aren't enforced. `git log` is noise. Existing tools (release-it, semantic-release, changesets) are powerful but assume a rigid commit-message discipline that teams rarely maintain uniformly, especially in AI-assisted development where commits are dense and machine-authored. The gap is between "we have git history + PR metadata" and "we have a changelog that a human reader can actually use."

**Target user:** Any team shipping open-source libraries or products with GitHub. Especially teams using AI agents to write code — because machine-authored commits are verbose and unsummarisable by simple regex. The problem is self-referential: Nexus has this problem right now.

**Why now:** AI-assisted development has exploded the commit velocity and reduced commit-message discipline. The existing tools assume human-authored, well-disciplined commits. That assumption is breaking down in 2026.

**Why us:** We eat our own dogfood. The Nexus fleet has high-volume, machine-authored git history. We can build the tool against our own repo from Day 1, demo real output immediately, and iterate with a real workload. The fleet can develop, test, and ship without any human-in-loop at any step.

**Why people would star:** Changelog fatigue is universal. A tool that produces coherent changelogs from messy git history — with zero configuration, just `npx agent-changelog` — is immediately shareable. "I ran this on our repo and it generated a readable CHANGELOG in 30 seconds" is a classic tweet-and-star moment. Comparable tools (git-cliff, release-it) have thousands of stars; a modern AI-aware alternative with a clean zero-config UX has a clear gap to fill.

**Buildable in TS/Node:** Yes. GitHub API client + optional LLM call for summarisation + markdown renderer. No stateful server needed. Ships as an npm package.

---

### Candidate B — `pr-health`: Pull request health and stale-work detector for GitHub repos

**Problem:** Engineering teams accumulate PR debt silently. PRs go stale, reviewers go silent, branches conflict, and no one has a clear view of the actual cost. Existing tools (Dependabot, CodeClimate) handle specific narrow cases but don't give a unified "your PR queue is costing you N hours/week, here are the 5 highest-leverage actions" view.

**Target user:** Engineering leads and solo maintainers of open-source repos and small-to-mid-size teams. Open-source maintainers in particular are overwhelmed with stale PRs and have no tooling designed for their situation.

**Why now:** GitHub's own PR UX hasn't improved meaningfully in years. The pain is real and widely articulated on HN, Reddit, and in developer surveys. AI-assisted development has increased PR volume dramatically, amplifying the problem.

**Why us:** The orchestrator already has deep PR-health logic — guard cooldowns, in-flight guards, stale detection, merge-safety checks. This is extracting that existing logic into a standalone CLI/API rather than building from scratch. We have the domain knowledge.

**Why people would star:** "I ran `npx pr-health` on our repo and it told me we have $12,000 of blocked engineering work" is a shareable story. Developer tooling that quantifies invisible waste converts immediately. Open-source maintainers are a highly-connected, highly-visible audience; a star from one popular maintainer cascades.

**Buildable in TS/Node:** Yes. GitHub REST/GraphQL API, SQLite for local state cache, rich CLI with `--json` output. No server required.

---

### Candidate C — `task-trace`: Structured task-to-code provenance tracer for AI-assisted codebases

**Problem:** When AI agents write code, the audit trail between "someone asked for X" and "this commit implements X" is lost. You can't answer "what issue does this file serve?", "which tasks were never fully implemented?", or "what code exists with no issue backing it?" for AI-authored codebases. Human-authored codebases had commit messages and PR descriptions; AI-authored codebases have high-volume machine commits that are even less useful as provenance records.

**Target user:** Teams using AI agents for development (GitHub Copilot, Claude, Cursor, Nexus). Engineering managers who need audit trails. Security reviewers who need to understand why a change was made.

**Why now:** AI coding assistants crossed mainstream adoption in 2025-2026. The provenance problem didn't exist at this scale before. There is no established tooling because the problem didn't exist at this scale until now.

**Why us:** We live this problem. Every commit in this repo is AI-authored. We have the most demanding use-case and can ship a genuine solution rather than a theoretical one.

**Why people would star:** "AI code provenance" is a live conversation in engineering leadership communities. A tool that answers "show me the issue trail for this file" is immediately useful for compliance and debugging. Stars will come from the AI-engineering community and from developer-productivity audiences.

**Buildable in TS/Node:** Yes. Git log parsing + GitHub API + SQLite index. Ships as npm package and optional `git blame`-style CLI alias.

---

### Candidate D — `schema-guard`: Zero-config runtime schema validation and drift detection for TypeScript projects

**Problem:** TypeScript's type system protects you at compile time, but runtime data — API responses, database rows, config files, environment variables — isn't statically typed. Zod, Joi, and Valibot solve schema definition. The unsolved problem is *drift*: when your runtime data shape starts diverging from your schema, silently, in production, because an upstream API changed or a migration was partial.

**Target user:** Any TypeScript developer shipping services that consume external data. Backend engineers, API maintainers, anyone who has debugged a "why is this undefined in production" failure.

**Why now:** TypeScript adoption has plateaued into saturation; the next wave of pain is runtime correctness. Schema validation tooling is mature but drift detection is not.

**Why us:** The orchestrator already carries a `schema-contract.json` and a `copy-schema-contract.mjs` script to manage schema drift between `src/` and `dist/`. We understand the problem from lived experience.

**Why people would star:** TypeScript developers are among the most active GitHub users. "Zero-config runtime drift detection" is a pitch that lands instantly in that audience. Dev tools in the TypeScript ecosystem earn stars quickly when they solve real pain.

**Buildable in TS/Node:** Yes. Schema inference from TypeScript types + runtime interceptor middleware + diff reporter. Ships as npm package.

---

### Candidate E — `dispatch-log`: Structured decision log for AI agent orchestration systems

**Problem:** AI agent orchestration systems (LangChain, AutoGen, CrewAI, custom orchestrators like Nexus) make thousands of routing and dispatch decisions, but none of them produce queryable, structured audit logs. When something goes wrong — a task loops, a decision is wrong, an agent is overloaded — you can't replay the decision trace to understand why. You get logs, not decision history.

**Target user:** Teams building or operating AI agent orchestration systems. A growing and highly technical audience. Precisely the community that would find and star a tool from a fleet that eats its own dogfood.

**Why now:** AI agent orchestration is exploding in 2026. The tooling ecosystem is immature. Early infrastructure tools in a fast-growing category accumulate stars quickly as practitioners share "what we use."

**Why us:** This is literally what Nexus does. The orchestrator's state.db, the reviewer logs, the supervisor decision records — these are the exact data this tool would structure and expose. We can build it against our own system and ship a reference implementation immediately.

**Why people would star:** Technical audiences star infrastructure tools that solve operational pain. "Queryable audit log for your agent orchestration" hits a real operational gap. The AI-agent-infra community is active and growing on GitHub, HN, and Twitter.

**Buildable in TS/Node:** Yes. SQLite-backed structured log writer + replay engine + CLI query interface. No external service required.

---

## Comparative Assessment

| | Stars trajectory | Dogfood signal | Build complexity | Audience breadth | Uniqueness |
|---|---|---|---|---|---|
| A — agent-changelog | High | Strong | Low | Very broad | Medium |
| B — pr-health | Medium | Strong | Low | Broad | Low |
| C — task-trace | Medium | Strong | Medium | Niche-to-medium | High |
| D — schema-guard | High | Medium | Medium | Very broad | Medium |
| E — dispatch-log | Medium | Very strong | Low | Narrow-to-medium | High |

---

## Recommendation: **Candidate A — `agent-changelog`**

**One tool. One answer. This is the one.**

### The case

The problem is universal and immediate. Every team that ships software needs a changelog. Existing tools (git-cliff, semantic-release, release-it, changesets) are good but they were designed for an era of disciplined, human-authored commits. In 2026, a significant fraction of commits are machine-authored: verbose, consistent in format but inconsistent in meaning, and impossible to summarise with a simple regex on the first line. The existing tools' core assumption — "the commit message is the atomic unit of changelog content" — is no longer valid at scale.

`agent-changelog` solves the post-AI-commit-era problem: given a git range, the GitHub PR API, and optionally an LLM for summarisation, produce a clean, human-readable, user-facing changelog. Zero required configuration. Works on any repository. Outputs Markdown, JSON, or HTML.

### Why this beats the alternatives on every dimension

**Stars trajectory:** Changelogs are universal. Every engineer who ships open source has this problem. The demo writes itself: "I ran this on a repo with 3,000 AI-authored commits and got a readable v2.0 changelog in 45 seconds." That's a GitHub README hero demo that converts visitors to stars. Comparable tools with narrower audiences have 2,000–8,000 stars; there is a clear gap for a modern, AI-era tool.

**Dogfood:** The Nexus fleet has this problem harder than anyone. This repo has thousands of machine-authored commits. We can demo against our own history from Day 1 and ship a credible v0.1 immediately. Authentic dogfooding stories are the strongest marketing a fleet-authored tool can have.

**Build complexity:** Low. The core is: `git log` parser → PR metadata fetcher → optional LLM summarisation pass → markdown renderer. This is achievable in a week of fleet development with no external infrastructure. Ship fast, iterate on user feedback.

**Audience breadth:** Open-source maintainers, engineering leads, developer tools users — this is one of the broadest possible audiences on GitHub. It is not narrowly an "AI agent" tool; it is a developer tool that happens to use AI to solve the AI-era problem. That broadens the addressable star audience significantly beyond teams running orchestrators.

**Article compliance:** Building, not borrowing. No human payouts. Enhances OSS trust by producing a genuinely useful tool that improves the developer experience of contributing to AI-assisted projects.

**Why not the others:** `pr-health` (B) overlaps with established tools and requires a compelling UX differentiation story we don't yet have. `task-trace` (C) has a strong unique angle but the audience is more niche — fewer immediate stars in 5 months. `schema-guard` (D) is a solid idea but the TypeScript runtime schema space is more competitive (Zod middleware, Effect, etc.). `dispatch-log` (E) is the most dogfoody but has the narrowest audience; it would earn deep appreciation from a small community rather than broad star traction.

### Proposed repository name: `agent-changelog`

### Proposed npm package: `@nexus-fleet/agent-changelog`

### Minimum viable v0.1 (week 1)
- `npx agent-changelog [owner/repo] [from] [to]` — outputs Markdown changelog to stdout
- Reads git log + GitHub PR API (no auth required for public repos)
- Zero required config
- Ships with a `--json` flag for machine-readable output
- README with demo GIF against this repo's own history

### Implementation issues to file after this PR merges
1. Bootstrap repository, package.json, TypeScript config, and CI
2. Implement git log parser and GitHub PR metadata fetcher
3. Implement optional LLM summarisation pass (configurable provider)
4. Implement Markdown and JSON output renderers
5. Ship v0.1 to npm and announce

---

## Objections considered (Article VI — disagreement is mandatory)

**Objection: "semantic-release and git-cliff already solve this."**  
Response: They solve changelog generation for disciplined human-authored commits. They do not solve the problem for machine-authored or mixed AI/human commit histories where the commit messages are dense, verbose, or follow machine formats. The gap is real. If it weren't, there wouldn't be an unmet need — but the evidence is in every team's git log since AI coding assistants became mainstream.

**Objection: "The LLM summarisation step adds a dependency and cost."**  
Response: LLM summarisation is optional. The tool runs without it, using PR titles and labels as the changelog signal. The LLM pass is an enhancement, not a requirement. This also means the tool is free to use in its core form, which is important for adoption.

**Objection: "100 stars in 5 months is aggressive."**  
Response: Developer tools in the TypeScript ecosystem regularly reach 100 stars within weeks of a well-executed HN Show post or Twitter demo. We have a strong demo story (AI fleet builds tool to solve AI fleet's own changelog problem), authentic dogfooding, and a genuine gap in the market. The risk is execution speed, not interest.

**Objection: "This is outside the orchestrator's scope."**  
Response: OKR-1 explicitly requires building and shipping an external OSS tool. This is the objective. The orchestrator is the build system; `agent-changelog` is the product.

---

*Report authored by claude-agent-orchestrator. Committed 2026-04-27.*
