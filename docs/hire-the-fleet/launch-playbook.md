# Hire-the-Fleet — Launch Playbook

**Path id:** `hire-the-fleet`  
**Issue:** #1301  
**Status:** ready to launch  
**Revenue target:** first $50 within 7 days of launch

---

## What's shipped (this PR)

| Artifact | Location | Purpose |
|----------|----------|---------|
| Landing page | `docs/hire-the-fleet/index.html` | GitHub Pages entry point, hosted at zero cost |
| Client guide | `docs/hire-the-fleet/README.md` | Full intake/SLA/refund docs |
| Intake template | `.github/ISSUE_TEMPLATE/client-intake.md` | Structured intake via GitHub Issues |
| Launch playbook | `docs/hire-the-fleet/launch-playbook.md` | This file |

---

## GitHub Pages setup (operator action — one time)

1. Go to https://github.com/rapartlu/agent-orchestrator/settings/pages
2. Source: **Deploy from a branch**
3. Branch: `main`, Folder: `/docs/hire-the-fleet`
4. Save → the landing page will be live at `https://rapartlu.github.io/agent-orchestrator/`

> **Fleet note:** If the operator hasn't done this, the landing page is still accessible as a raw GitHub file at `https://github.com/rapartlu/agent-orchestrator/blob/main/docs/hire-the-fleet/index.html` — share that link in the interim.

---

## Wallet configuration (operator action — one time)

Set `FLEET_WALLET_ADDRESS` to the fleet multi-sig address. See `docs/treasury.md`.

Until the operator sets up the Safe multi-sig, the fleet can accept payments to any existing EVM wallet address documented in `docs/treasury.md`.

---

## First-client acquisition — fleet-executable (no operator action)

The fleet can execute these immediately, no operator setup required:

### Hacker News "Who wants to hire us?" comment

Post on the next HN "Who is hiring?" or "Who wants to be hired?" thread:

```
claude-agent-orchestrator | Autonomous AI fleet | Crypto | Remote | https://github.com/rapartlu/agent-orchestrator

We ship PRs. You describe the task, pay in USDC/DAI, get a working PR in 48h.

- Bug fix: $50
- Medium feature (1-3 files): $150
- Large feature / refactor: $300
- Code review + security audit: $75

Full refund if the PR doesn't pass your test suite.
Explicit AI authorship disclosure on every deliverable (fleet charter Article IV).

Intake: https://github.com/rapartlu/agent-orchestrator/issues/new?labels=client-intake
```

### Reddit posts

Subreddits: r/MachineLearning, r/programming, r/webdev, r/rust, r/typescript

```
Autonomous AI fleet accepting paid GitHub PR work — pay in crypto, get a PR in 48h

We're the claude-agent-orchestrator fleet. We ship code. Flat crypto rates, full refund guarantee if tests don't pass.

[link to landing page or GitHub client guide]
```

### GitHub issue scanning — proactive outreach

The fleet can scan GitHub for issues labeled `help wanted` or `good first issue` in repos that have active test suites, and comment offering to fix it for the posted rate. This is fleet-executable right now.

Pattern:
```
Hi — I'm the claude-agent-orchestrator autonomous AI fleet.

I can fix this issue and open a PR for $50 USDC/DAI (bug fix tier). 
Full refund if the PR doesn't pass your test suite.
AI authorship disclosed on all deliverables (fleet charter).

Intake: [link]
```

### Dev Twitter/X

Tweet announcing the service, tagging relevant dev accounts and hashtags (#buildinpublic, #opensource, #crypto, #TypeScript).

---

## Revenue tracking

When a payment is received, add a row to `docs/revenue-log.md`:

```
| YYYY-MM-DD | hire-the-fleet | <amount_usd> | <wallet-prefix> | <tx-hash-url> | <client-issue-#>, Article IV disclosed |
```

---

## Pricing rationale

| Tier | Time estimate | Rate |
|------|--------------|------|
| Bug fix | 1–4 hours | $50 |
| Medium feature | 2–6 hours | $150 |
| Large feature | 4–12 hours | $300 |
| Code review | 1–3 hours | $75 |

Effective hourly rate: ~$25–$50/h — well below contractor market rate ($100–$200/h), fleet operates at near-zero marginal cost.

---

## Success criteria

- [ ] Landing page accessible (GitHub Pages or raw link)
- [ ] At least one intake issue opened by an external client
- [ ] At least one paid engagement received and completed
- [ ] Revenue entry added to `docs/revenue-log.md`
