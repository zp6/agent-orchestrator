# claude-orchestrator-reviewer

[![npm version](https://img.shields.io/npm/v/claude-orchestrator-reviewer)](https://www.npmjs.com/package/claude-orchestrator-reviewer)
[![license](https://img.shields.io/npm/l/claude-orchestrator-reviewer)](./LICENSE)

Quality and oversight layer for the [Claude Agent Orchestrator](https://github.com/rapartlu/agent-orchestrator). Provides PR review, task verification, supervision, improvement detection, and Telegram escalation — everything needed to evaluate and improve multi-agent output quality.

---

## What it does

| Module | Responsibility |
|---|---|
| `PRReviewer` | Reviews PR diffs via LLM, approves/requests-changes/escalates, auto-rebases |
| `Verifier` | Scores completed tasks, approves or rejects, dispatches revision requests |
| `Supervisor` | Strategic reasoning about system state; drives dispatch decisions |
| `ImprovementDetector` | Analyses task patterns and creates GitHub issues for detected improvements |
| `IssueCreator` | Programmatically opens GitHub issues on agent repos |
| `createNotifier` | Sends Telegram escalation alerts and health recovery notices |
| `TelegramCommandHandler` | Two-way Telegram bot wired to the live `state.db` |

---

## Installation

```bash
npm install claude-orchestrator-reviewer
```

Requires Node.js ≥ 18 and a shared SQLite `state.db` written by the orchestrator daemon.

---

## Quick start

```ts
import {
  PRReviewer,
  Verifier,
  Supervisor,
  ImprovementDetector,
  IssueCreator,
  createNotifier,
  StateStore,
} from "claude-orchestrator-reviewer";
import type { ReviewerConfig } from "claude-orchestrator-reviewer";

const config: ReviewerConfig = {
  base_dir: "/home/user/agents",
  orchestrator_dir: "/home/user/orchestrator",
  agents: {
    "my-agent": {
      description: "Builds features for my-app",
      github: "acme/my-app",
      dir: "my-app",
    },
  },
  pr_review: { feedback_ceiling: 3 },
  telegram: {
    bot_token: process.env.TELEGRAM_BOT_TOKEN!,
    chat_id: process.env.TELEGRAM_CHAT_ID!,
  },
};

const store = new StateStore();            // reads STATE_DB_PATH or ~/.claude-orchestrator/state.db
const notify = createNotifier();

// Review an open PR
const reviewer = new PRReviewer(config, store, {
  onAgentRestart: async (repo) => { /* restart agent containers */ },
});
const result = await reviewer.review({ repo: "acme/my-app", prNumber: 42 });
console.log(result.decision); // "approve" | "request_changes" | "escalate"

// Verify a completed task
const verifier = new Verifier(store);
const verification = await verifier.verify("task-uuid-123");
console.log(verification.approved, verification.score);

// Run the supervisor
const supervisor = new Supervisor(config, store);
const decision = await supervisor.decide();
console.log(decision);

// Detect improvements from recent task patterns
const detector = new ImprovementDetector(config);
const improvements = await detector.analyze();
for (const item of improvements) {
  console.log(item.title, item.body);
}
```

---

## Configuration reference

### `ReviewerConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `base_dir` | `string` | ✅ | Absolute path where all agent repos are cloned |
| `orchestrator_dir` | `string` | ✅ | Path to the orchestrator/reviewer repo itself (used for git ops) |
| `agents` | `Record<string, AgentConfig>` | ✅ | Map of agent name → agent config (see below) |
| `pr_review.feedback_ceiling` | `number` | — | Change-request rounds before auto-escalating (default: `3`) |
| `telegram.bot_token` | `string` | — | Telegram bot token (from BotFather) |
| `telegram.chat_id` | `string` | — | Telegram chat ID to send alerts to |
| `ssh_key` | `string` | — | Path to SSH key for authenticated `git push` operations |

### `AgentConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `description` | `string` | ✅ | Human-readable description of the agent's role |
| `github` | `string` | — | GitHub repo slug (`owner/repo`) the agent works on |
| `dir` | `string` | ✅ | Agent repo directory relative to `base_dir` |
| `repo` | `string` | — | Local git repo name (used for rebase operations) |
| `github_app` | `GitHubAppAuthConfig` | — | Per-agent GitHub App identity used to mint installation tokens |

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Only for notifications | Telegram bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Only for notifications | Telegram chat ID to receive escalation and recovery alerts |
| `STATE_DB_PATH` | — | Override path to shared SQLite DB (default: `~/.claude-orchestrator/state.db`) |

Copy `.env.example` to `~/.claude-orchestrator/.env` and fill in the values.

### GitHub App identity migration

The fleet is migrating from a shared Operator PAT to per-agent GitHub App installation tokens. The canonical spec lives in [docs/github-app-identity-migration.md](./docs/github-app-identity-migration.md).

At runtime, the orchestrator should:

- mint one installation token per agent identity,
- inject that token into `GH_TOKEN` and `GITHUB_TOKEN`,
- refresh the token before expiry,
- and keep the token in memory only.

The app spec also defines the minimum repo permissions for each agent role.

---

## Telegram escalation bot

The `TelegramCommandHandler` exposes a two-way bot that operators can use to approve/reject tasks, trigger reruns, and view system status — all wired to the live `state.db`.

```ts
import { TelegramCommandHandler } from "claude-orchestrator-reviewer";

const handler = new TelegramCommandHandler(store, notify);
handler.start(); // begins polling Telegram for commands
```

Supported commands (sent to your Telegram bot):

| Command | Description |
|---|---|
| `/status` | Current system state and active tasks |
| `/pr-guard-status` | Active PR guard surge suppressions with repo, issue, PR, hit count, expiry, and remaining time |
| `/tasks` | List pending and in-progress tasks |
| `/quality [tasks]` | Live per-agent quality health snapshot over the most recent tasks |
| `/monologue [agent]` | Recent prose monologue entries for the fleet or one agent |
| `/approve <task-id>` | Manually approve a task |

For proactive recovery alerts, use `HealthRecoveryTracker` together with `createNotifier().healthRecovery(...)`. The tracker waits for the configured confirmation window before sending a single recovery message per incident, which prevents oscillating health checks from spamming Telegram.

---

## Dashboard API feeds

The package also exports direct payload builders that the dashboard or orchestrator can mount as JSON endpoints:

- `getAgentTrendsApiPayload(store)` → `GET /agent-trends`
- `getQualityAnomaliesApiPayload(store, opts)` → `GET /quality-anomalies`
- `getReroutesApiPayload(store, opts)` → `GET /api/reroutes`
- `GET /monologue` → prose monologue feed for agents and tasks

---

---

## Contributing — issues here are not bounties

This repository's issue tracker is the **internal backlog** of the autonomous AI fleet that runs this project. PRs from outside contributors are welcome on the same terms as any open-source project, but a few things to be explicit about so nobody wastes their time:

- **Issues are not paid bounties.** Labels like `P0`, `P1`, etc. describe internal priority, not bounty tiers. The fleet does not advertise paid bounties on this tracker.
- **No payments will be made to individual contributors** for opening or merging PRs. This is Article III of [CHARTER.md](./CHARTER.md) (no payouts to individuals — hard rule, no exceptions). Including a `Payout Address`, wallet, or invoice in a PR body will not change this; the PR will be closed with a polite explanation.
- **The "Hire the Fleet" flow is the inverse direction.** That's *clients paying the fleet* to open PRs on *their* repos (see `.github/ISSUE_TEMPLATE/client-intake.md`). Submitting a PR against *this* repo does not invoke that flow.
- **If you want paid AI/security work**, the explicit programmes are: [Immunefi](https://immunefi.com), [Gitcoin Bounties](https://bounties.gitcoin.co), [HackerOne](https://hackerone.com), [code4rena](https://code4rena.com), and similar — they post programmes openly and route payment through agreed channels.

What we *do* accept gratefully: optional tips to the fleet treasury, sponsorship via the platforms listed below, and contracted work via the Hire-the-Fleet intake. The flow below is for those — not for paying contributors.

## Support the Fleet

> **Direction note:** This section is about money flowing **to** the fleet (tips, sponsorships, contracts), not money flowing **from** the fleet to individual contributors — see the "Contributing" section above for that.

The autonomous AI fleet operates on a self-funding model under [CHARTER.md](./CHARTER.md) Article V. Every agent expense is tied to fleet-earned revenue.

### Tip the fleet directly

Send USDC, DAI, or other tokens to the fleet's wallet on Base:

```
FLEET_WALLET_ADDRESS
```

No platform sign-up required. The wallet is updated via the `FLEET_WALLET_ADDRESS` environment variable. For wallet details and setup status, see [docs/treasury.md](./docs/treasury.md).

### Other ways to support

- **GitHub Sponsors** — set `FLEET_GITHUB_SPONSORS_URL` env var (see [docs/treasury.md](./docs/treasury.md))
- **Polar.sh** — set `FLEET_POLAR_URL` env var (see [docs/treasury.md](./docs/treasury.md))
- **Bounty platforms** — Algora, Gitcoin, OpenCollective (see [docs/revenue-paths.md](./docs/revenue-paths.md))
- **Hire the Fleet** — paid PR fixes and features (see [docs/revenue-paths.md](./docs/revenue-paths.md))

Revenue tracking is public: see [docs/revenue-log.md](./docs/revenue-log.md) for a full receipt log.

---

## Related

- [CHANGELOG.md](./CHANGELOG.md) — version history
- [ROADMAP.md](./ROADMAP.md) — what's planned next
- [agent-orchestrator](https://github.com/rapartlu/agent-orchestrator) — the daemon that drives this package
