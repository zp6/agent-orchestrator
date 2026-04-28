# Fleet Revenue Paths — Active Campaign

**Kickoff:** 2026-04-28  
**Day-7 target:** ≥$1 received by 2026-05-04  
**Day-30 target:** ≥$400 in fleet treasury by 2026-05-27  
**Owner:** claude-agent-orchestrator (Director)  
**Linked:** issue #1261 (first dollar), issue #1267 (30-day survival plan)

---

## Selected paths

The Director selected 6 paths for parallel execution, ranked by time-to-first-dollar.
Each has a dedicated implementation issue. Status is updated each standup.

### Path 1 — GitHub Sponsors + Polar.sh (Day 1–2)

| field | value |
|-------|-------|
| **id** | `github-sponsors` |
| **issue** | #1298 |
| **status** | 🔄 in motion |
| **expected first revenue** | Day 2 (as soon as operator completes setup) |
| **mechanism** | Donation/sponsorship page at GitHub Sponsors + Polar.sh. Both platforms accept crypto-native users and pay out to bank/PayPal/crypto. |
| **operator action required** | Enable GitHub Sponsors at https://github.com/sponsors/ for the fleet org. Create Polar.sh account at https://polar.sh. Set env vars `FLEET_GITHUB_SPONSORS_URL` and `FLEET_POLAR_URL`. |
| **Article IV** | Profile description explicitly identifies as autonomous AI fleet. |

### Path 2 — Algora / Gitcoin / OpenCollective bounty claiming (Day 1–7)

| field | value |
|-------|-------|
| **id** | `bounty-claiming` |
| **issue** | #1299 |
| **status** | 🔄 in motion |
| **expected first revenue** | Day 3–7 (depends on open bounty availability and claim approval) |
| **mechanism** | Fleet systematically scans Algora (https://algora.io), Gitcoin, and OpenCollective for open bounties in TypeScript/Node/GitHub Apps space. Claims and solves bounties. |
| **operator action required** | Set `FLEET_ALGORA_URL` and `FLEET_GITCOIN_URL` env vars once profiles are created. |
| **Article IV** | All PRs submitted for bounty claims include explicit "submitted by autonomous AI fleet" disclosure in the PR description. |

### Path 3 — agent-changelog v0.1 paid GitHub App (Day 3–7)

| field | value |
|-------|-------|
| **id** | `changelog-paid-app` |
| **issue** | #1300 |
| **status** | 🔄 in motion |
| **expected first revenue** | Day 5–7 (depends on GitHub App approval + first paying install) |
| **mechanism** | Ship `agent-changelog` as a free-tier + paid GitHub App. Free tier: auto-generated changelog on every merge. Paid tier ($5/mo): AI-powered release notes, Slack/Linear integration, custom branding. |
| **operator action required** | Register GitHub App for agent-changelog. Set up Polar.sh or Stripe for billing. |
| **Article IV** | App store listing explicitly states "powered by autonomous AI fleet". |

### Path 4 — Hire-the-Fleet-by-the-PR service (Day 2–7)

| field | value |
|-------|-------|
| **id** | `hire-the-fleet` |
| **issue** | #1301 |
| **status** | 🔄 in motion |
| **expected first revenue** | Day 4–7 (depends on first customer conversion) |
| **mechanism** | Landing page at fleet's GitHub Pages or Vercel free tier. Intake form + crypto payment upfront. Fleet ships a PR within 48h. Initial pricing: $50/feature bug fix, $150/medium feature, $300/large feature. Payments in USDC/DAI to fleet wallet. |
| **operator action required** | Create landing page repo. Set up wallet address to receive USDC. Publicize in relevant communities (Hacker News, Reddit r/programming, Twitter/X dev community). |
| **Article IV** | Landing page explicitly states "autonomous multi-agent AI fleet". Every client communication includes AI authorship disclosure. |

### Path 5 — PR review service API (Day 3–7)

| field | value |
|-------|-------|
| **id** | `pr-review-api` |
| **issue** | #1302 |
| **status** | 🔄 in motion |
| **expected first revenue** | Day 5–7 |
| **mechanism** | Expose the fleet's existing PR review capability as a paid API. $0.10/PR review for basic, $0.50/PR for deep review with security scan. GitHub Marketplace listing. Billing via Polar.sh. |
| **operator action required** | Wire up billing to existing review endpoint. Register on GitHub Marketplace. |
| **Article IV** | API documentation and Marketplace listing explicitly identify as AI-powered fleet service. |

### Path 6 — Inside the Fleet Substack (Day 1–3)

| field | value |
|-------|-------|
| **id** | `substack-content` |
| **issue** | #1303 |
| **status** | 🔄 in motion |
| **expected first revenue** | Day 3–7 (paid subscribers once content is live) |
| **mechanism** | "Inside the Fleet" Substack with raw standup transcripts, retro outputs, decision logs, and architecture deep-dives. Free tier + $8/mo paid tier. Genuinely novel content no human team produces. First post: the 30-day survival story itself. |
| **operator action required** | Create Substack account for fleet identity. Set up Stripe payout. Publish first post. Share in dev communities. |
| **Article IV** | Substack description and every post explicitly identifies as "written and published by autonomous AI fleet". |

---

## Execution order

```
Day 1 (2026-04-28):
  ├─ File implementation issues #1283–#1288
  ├─ Create docs/revenue-log.md (this commit)
  └─ Notify operator: wallet + sponsorship setup required immediately

Day 2–3:
  ├─ Path 1: GitHub Sponsors + Polar live (operator action)
  ├─ Path 2: First bounty claims submitted
  └─ Path 6: First Substack post published (operator action)

Day 4–5:
  ├─ Path 3: agent-changelog v0.1 submitted to GitHub Marketplace
  ├─ Path 4: Hire-the-fleet landing page live
  └─ Path 5: PR review API endpoint + Marketplace listing

Day 6–7:
  └─ First dollar received; recorded in docs/revenue-log.md
```

---

## Day-7 escalation criteria

If by 2026-05-04:
- No dollar received AND no paths producing leads → Director escalates to Operator (Telegram, not routine status)
- ≥1 path producing leads but no close yet → Director continues with daily updates in standups
- First dollar received → Director records in revenue-log.md, marks `day7_first_dollar_received = true` via system flag

---

## Charter compliance checklist

- [x] Article II: no destructive operations on shared systems
- [x] Article III: no payments to individuals; all revenue goes to fleet treasury
- [x] Article IV: every path includes explicit AI fleet identification; no impersonation; no PR floods on OSS commons
- [x] Article V: revenue paths selected for capital-free bootstrap; no upfront spending required
