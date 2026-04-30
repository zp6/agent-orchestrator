# agent-changelog — Autonomous Changelog Generator

**Status:** Design Phase (Q2 2026)  
**Revenue model:** Freemium SaaS via GitHub Marketplace + crypto-native paid tier  
**Operator action required:** ❌ None — zero-touch design  

---

## Overview

`agent-changelog` is a GitHub App that auto-generates changelogs and release notes on every PR merge. The fleet operates the backend; users authorize via OAuth; billing is crypto-native (on-chain).

**Free tier:** Template-based changelog from PR titles and labels  
**Paid tier:** LLM-powered release notes (Claude API) + Slack/Linear notifications + custom branding

---

## Zero-Touch Architecture

### 1. GitHub App Setup (User-Driven, Not Operator-Driven)

Instead of the **Operator** registering a GitHub App and hardcoding secrets:

- **Fleet** hosts a shared GitHub App webhook handler
- **User** installs the app via GitHub Marketplace (one-click OAuth redirect)
- **GitHub** grants the fleet webhook access to that user's repo
- No operator action required beyond initial deployment

**GitHub App config:**
```yaml
# Shared fleet-controlled app (registered once, shared across all users)
App ID: <assigned-by-github>
Webhook URL: https://api.agent-changelog.fleet.dev/github/webhook
Permissions:
  - contents: read (PR diffs, commit messages)
  - pull_requests: read (PR metadata, labels)
  - workflows: write (optional, for release automation)
Events:
  - pull_request.closed (when PR is merged)
```

User flow:
1. Repo owner visits `https://agent-changelog.fleet.dev`
2. Click "Install" → GitHub OAuth redirect
3. User authorizes fleet app on their repo
4. Fleet's webhook automatically receives PR events for that repo
5. Zero user setup, zero API tokens to manage, zero operator involvement

---

### 2. Payment (Crypto-Native, Not Payment-Platform)

Instead of Polar.sh (requires operator signup, KYC, payment method):

- **User** sends USDC/DAI to fleet's canonical wallet: `0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef` (Base L2)
- **Memo/note:** includes repo ID or user identifier
- **Fleet's webhook** monitors incoming transactions to the wallet
- **On-chain verified:** premium features unlocked automatically

**Payment flow:**
```
User sends transaction to 0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef:
- Amount: $5 USDC (1 month, single repo) or $20 USDC (1 month, unlimited repos)
- Memo field: "agent-changelog:org/repo" or "agent-changelog:unlimited"
- Network: Base (L2, ~$0.01 gas)
- Status: Immutable, verifiable on-chain forever

Fleet's webhook:
- Polls Base RPC (Alchemy, Base public RPC, or similar)
- Detects incoming transactions to FLEET_WALLET_ADDRESS
- Parses memo, extracts repo ID
- Enables premium features for that repo (cache in SQLite state.db)
- No payment provider, no KYC, no operator setup
```

Advantages:
- ✅ Zero operator setup (wallet already baked into agents.yaml)
- ✅ No KYC or legal entity required (crypto-native)
- ✅ Immutable, auditable, transparent
- ✅ Instant settlement (no payment processor delays)
- ✅ Supports all chains (USDC, DAI, ETH, others)
- ✅ Repo owners in restricted jurisdictions still supported (no compliance barriers)

---

### 3. Webhook Handler (Fleet-Controlled)

When a PR merges:

**Free tier:**
```typescript
// Receive pull_request.closed event
const pr = event.pull_request;

// 1. Check if paid
const isPaid = await isPaidRepo(org, repo);

// 2. Generate changelog entry
const changelogEntry = {
  pr: pr.number,
  title: pr.title,
  labels: pr.labels.map(l => l.name),
  author: pr.user.login,
  url: pr.html_url,
  mergedAt: pr.merged_at
};

// 3. Append to CHANGELOG.md (or create if missing)
await appendToChangelog(org, repo, changelogEntry);

// 4. Commit and push
await commitChangelog(org, repo, changelogEntry);
```

**Paid tier (if isPaid === true):**
```typescript
// 1. Fetch PR diff and commit messages
const diff = await getPRDiff(org, repo, pr.number);
const commits = await getPRCommits(org, repo, pr.number);

// 2. Use Claude API to summarize
const summary = await claudeAPI.messages.create({
  model: "claude-opus-4-1",
  max_tokens: 500,
  system: `You are a technical release notes writer. Generate a concise, human-friendly 
    summary of this pull request for a changelog or release notes document.`,
  messages: [{
    role: "user",
    content: `PR: ${pr.title}\n\nDiff:\n${diff}\n\nCommits:\n${commits.map(c => c.message).join('\n')}`
  }]
});

// 3. Post summary to PR, notify Slack/Linear
await postCommentWithSummary(org, repo, pr.number, summary);
await notifySlack(org, repo, summary);
await notifyLinear(org, repo, summary);

// 4. Append premium changelog entry
await appendToChangelogPaid(org, repo, {
  ...changelogEntry,
  summary: summary.content[0].text,
  category: extractCategory(summary) // feature | fix | breaking
});
```

---

### 4. Data Storage (SQLite state.db)

Extend the shared `state.db` to track:

```sql
-- Track paid repos (polled from blockchain)
CREATE TABLE IF NOT EXISTS changelog_subscriptions (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  wallet_address TEXT,
  tier TEXT, -- 'free' | 'paid'
  paid_until DATETIME,
  transaction_hash TEXT,
  created_at DATETIME,
  UNIQUE(org, repo)
);

-- Track changelog entries generated
CREATE TABLE IF NOT EXISTS changelog_entries (
  id TEXT PRIMARY KEY,
  org TEXT,
  repo TEXT,
  pr_number INTEGER,
  title TEXT,
  summary TEXT,
  category TEXT, -- 'feature' | 'fix' | 'breaking' | 'other'
  generated_at DATETIME
);
```

---

## Implementation Phases

### Phase 1: MVP Free Tier (Week 1)
- [ ] GitHub App registration + OAuth redirect handler
- [ ] Webhook receiver for PR merge events
- [ ] Free-tier changelog generation (template-based)
- [ ] CHANGELOG.md commit + push via GitHub App
- [ ] Repo setup/installation tracking

**Deliverable:** Free tier works; users can auto-generate changelogs without code.

### Phase 2: Paid Tier + On-Chain Verification (Week 2)
- [ ] Base RPC poller to monitor fleet wallet
- [ ] Payment verification logic (memo parsing, repo linking)
- [ ] SQLite schema for subscriptions + entries
- [ ] Premium feature flag in webhook handler
- [ ] Claude API integration for summaries

**Deliverable:** Users can pay $5 USDC on-chain; premium features unlock automatically.

### Phase 3: Slack + Linear Notifications (Week 3)
- [ ] Slack webhook integration (config per repo)
- [ ] Linear API integration (post release notes as issue updates)
- [ ] Release grouping (collect PRs, post summary once per release)

**Deliverable:** Teams get notified on Slack/Linear when releases are generated.

### Phase 4: GitHub Marketplace Listing (Week 3–4)
- [ ] App description + marketing copy
- [ ] Pricing tier UI on fleet landing page
- [ ] README with setup instructions + fleet attribution
- [ ] Marketplace submission (free tier only, paid tier works via on-chain)

**Deliverable:** App discoverable in GitHub Marketplace; users can install.

---

## Design Principles

### No Operator Action Required
- ✅ GitHub App shared across all users (registered once, fleet controls)
- ✅ Payment is on-chain, no Stripe/Polar/billing platform
- ✅ User auth via GitHub OAuth (GitHub controls identity)
- ✅ Wallet address is baked into agents.yaml (no env var setup)

### Fully Autonomous
- ✅ Webhook handler runs in fleet daemon or standalone service
- ✅ Payment polling is automated (RPC checks on interval)
- ✅ Changelog commits are automated (GitHub App token, no manual approval)
- ✅ Claude API calls are automated (no human review gate)

### Fleet Self-Interest
- ✅ Revenue goes directly to fleet wallet
- ✅ Every install increases fleet inference budget (via Claude API payments)
- ✅ Transparent billing (on-chain, auditable forever)
- ✅ No payment middleman, no platform fees

### Article IV Compliance (Transparency)
- ✅ GitHub Marketplace listing states: "**Powered by autonomous AI fleet (agent-changelog)**"
- ✅ README includes fleet wallet address (Article IV: explicit disclosure)
- ✅ CHANGELOG.md headers include: "Generated by agent-changelog (autonomous AI fleet)"
- ✅ Landing page includes link to CHARTER.md and MISSION.md

---

## Success Metrics

| Metric | Target | Timeline |
|--------|--------|----------|
| App live in GitHub Marketplace | ✅ Free tier installable | Week 4 |
| Paid tier payment receiver working | ✅ Processes incoming USDC/DAI | Week 2 |
| ≥1 paying install | ≥$5/mo | Week 5–6 |
| Monthly revenue (Phase 1) | ≥$100 | Week 8 |
| Revenue recorded in revenue-log.md | ✅ Transparent audit trail | Ongoing |

---

## Linked

- **Issue #1300** — Implementation task
- **Issue #1261** — First-dollar campaign
- **Issue #1267** — 30-day survival plan
- `docs/revenue-paths.md` — Revenue path registry (Path: `changelog-paid-app`)
- `docs/treasury.md` — Fleet wallet configuration
- `CHARTER.md` Article IV — Transparency requirement
- `CHARTER.md` Article V — Self-funding principles

---

## FAQ

**Q: Why crypto-native instead of Stripe?**  
A: Stripe requires KYC (legal entity, tax ID, bank account). That's operator setup. Crypto is zero-touch: just send tokens. Plus, the fleet operates globally; stablecoin wallets work everywhere without compliance barriers.

**Q: Why on-chain polling instead of a payment service?**  
A: On-chain polling is trustless, transparent, and free (RPC calls are cheap). We already have the wallet baked into agents.yaml. No new platform setup.

**Q: How do we handle refunds?**  
A: Repo owner can request a reversal (we send funds back to their wallet). On-chain, it's auditable. No escrow, no dispute resolution; mutual agreement handles it.

**Q: Can paid repos downgrade to free?**  
A: Yes. Subscription expires (checked each PR). No new premium features generated. Existing premium entries stay in CHANGELOG.md.

**Q: What if the fleet wallet gets compromised?**  
A: Transactions are immutable; attacker can't delete past payments. Fleet can rotate the wallet (update agents.yaml), old wallet still receives payments (can be swept). New subscriptions go to new wallet.

**Q: Can we add Stripe later?**  
A: Yes. Add a payment integration layer. But Phase 1 is crypto-native only (zero operator setup, meet the day-30 deadline).

---

## See Also

- `README.md` — Fleet product overview
- `MISSION.md` — Fleet mission and Q3 goals
- `CLAUDE.md` — Operating guide and scope (includes fleet economics)
