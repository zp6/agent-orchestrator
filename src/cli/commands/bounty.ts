import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type BountyOpportunity } from "../../state/store.js";
import {
  scoreBountyOpportunity,
  buildClaimBrief,
} from "../../orchestrator/bounty-matcher.js";

function openStore(): StateStore {
  try {
    return new StateStore();
  } catch (err) {
    console.error(
      chalk.red("Could not open state database:"),
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

function rescore(store: StateStore, opp: BountyOpportunity): BountyOpportunity {
  const scoring = scoreBountyOpportunity({
    title: opp.title,
    scope: opp.scope,
    payout_amount_usd: opp.payout_amount_usd,
    payout_currency: opp.payout_currency,
    payout_terms: opp.payout_terms,
    deadline: opp.deadline,
    capabilities: opp.capabilities,
    notes: opp.notes,
  });
  const brief = buildClaimBrief(opp, scoring);
  store.updateBountyOpportunityScore(opp.id, scoring.score, scoring.rationale, brief);
  return store.getBountyOpportunity(opp.id)!;
}

function colorScore(score: number | null): string {
  if (score == null) return chalk.dim("—");
  if (score >= 70) return chalk.green(`${score}`);
  if (score >= 40) return chalk.yellow(`${score}`);
  return chalk.red(`${score}`);
}

export function registerBountyCommand(program: Command): void {
  const bounty = program
    .command("bounty")
    .description("Crypto-native bounty opportunity queue (issue #1315)");

  bounty
    .command("add <url>")
    .description("Add a bounty opportunity from a public source URL")
    .requiredOption("--title <title>", "Bounty title")
    .option("--platform <name>", "Platform (e.g. immunefi, gitcoin, github-issue)")
    .option("--scope <text>", "Scope / brief description of work")
    .option("--payout <usd>", "Payout amount in USD (numeric)")
    .option("--currency <code>", "Payout currency (USDC, ETH, USD, etc.)")
    .option("--terms <text>", "Payout terms / conditions text")
    .option("--deadline <iso>", "Submission deadline ISO date")
    .option("--capabilities <list>", "Comma-separated required capabilities")
    .option("--notes <text>", "Free-form notes")
    .option("--json", "Emit the resulting record as JSON")
    .action((url: string, opts: {
      title: string;
      platform?: string;
      scope?: string;
      payout?: string;
      currency?: string;
      terms?: string;
      deadline?: string;
      capabilities?: string;
      notes?: string;
      json?: boolean;
    }) => {
      const store = openStore();
      try {
        const payout = opts.payout ? Number(opts.payout) : undefined;
        if (opts.payout && !Number.isFinite(payout)) {
          console.error(chalk.red("--payout must be numeric (USD)"));
          process.exit(1);
        }
        const capabilities = opts.capabilities
          ? opts.capabilities.split(",").map((c) => c.trim()).filter(Boolean)
          : undefined;
        let opp: BountyOpportunity;
        try {
          opp = store.addBountyOpportunity({
            source_url: url,
            title: opts.title,
            platform: opts.platform,
            scope: opts.scope,
            payout_amount_usd: payout,
            payout_currency: opts.currency,
            payout_terms: opts.terms,
            deadline: opts.deadline,
            capabilities,
            notes: opts.notes,
          });
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
        opp = rescore(store, opp);
        if (opts.json) {
          console.log(JSON.stringify(opp, null, 2));
          return;
        }
        console.log(chalk.green(`✓ added bounty #${opp.id}`));
        console.log(`  ${chalk.bold(opp.title)}`);
        console.log(`  score: ${colorScore(opp.score)}/100`);
        console.log(`  ${chalk.dim(opp.source_url)}`);
        console.log(chalk.dim(`  run \`orch bounty show ${opp.id}\` for the full claim brief`));
      } finally {
        store.close();
      }
    });

  bounty
    .command("list")
    .description("List bounty opportunities, ranked by score")
    .option("--status <status>", "Filter by status (open, claimed, won, lost, skipped)")
    .option("--limit <n>", "Max rows", "50")
    .option("--json", "Emit raw JSON")
    .action((opts: { status?: string; limit?: string; json?: boolean }) => {
      const store = openStore();
      try {
        const items = store.listBountyOpportunities({
          status: opts.status,
          limit: parseInt(opts.limit ?? "50", 10),
        });
        if (opts.json) {
          console.log(JSON.stringify(items, null, 2));
          return;
        }
        console.log(chalk.bold("\n● Bounty Queue\n"));
        if (items.length === 0) {
          console.log(chalk.dim("  Queue is empty. Add one with `orch bounty add <url> --title ...`"));
          console.log();
          return;
        }
        for (const opp of items) {
          const payout = opp.payout_amount_usd != null
            ? `$${opp.payout_amount_usd}${opp.payout_currency ? ` ${opp.payout_currency}` : ""}`
            : chalk.dim("payout?");
          const deadline = opp.deadline ? `due ${opp.deadline}` : chalk.dim("no deadline");
          const status = opp.status === "open" ? chalk.cyan(opp.status) : chalk.dim(opp.status);
          console.log(
            `  ${chalk.dim(`#${opp.id}`)} ${colorScore(opp.score)}/100  ${chalk.bold(opp.title)}  ${status}`,
          );
          console.log(`    ${payout}  ${deadline}  ${chalk.dim(opp.source_url)}`);
          if (opp.capabilities.length > 0) {
            console.log(`    ${chalk.dim("capabilities:")} ${opp.capabilities.join(", ")}`);
          }
        }
        console.log();
      } finally {
        store.close();
      }
    });

  bounty
    .command("show <id>")
    .description("Show full claim brief for a bounty opportunity")
    .option("--json", "Emit raw JSON")
    .action((idArg: string, opts: { json?: boolean }) => {
      const store = openStore();
      try {
        const id = parseInt(idArg, 10);
        const opp = store.getBountyOpportunity(id);
        if (!opp) {
          console.error(chalk.red(`No bounty with id ${id}`));
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify(opp, null, 2));
          return;
        }
        if (opp.brief) {
          console.log(opp.brief);
        } else {
          console.log(chalk.dim("(no brief yet — run `orch bounty rescore`)"));
        }
      } finally {
        store.close();
      }
    });

  bounty
    .command("rescore [id]")
    .description("Re-score one bounty (or all open ones)")
    .action((idArg: string | undefined) => {
      const store = openStore();
      try {
        const targets = idArg
          ? [store.getBountyOpportunity(parseInt(idArg, 10))].filter(
              (x): x is BountyOpportunity => x != null,
            )
          : store.listBountyOpportunities({ status: "open", limit: 1000 });
        if (targets.length === 0) {
          console.log(chalk.dim("no open bounties to rescore"));
          return;
        }
        for (const opp of targets) {
          const updated = rescore(store, opp);
          console.log(
            `  ${chalk.dim(`#${updated.id}`)} ${colorScore(updated.score)}/100  ${updated.title}`,
          );
        }
      } finally {
        store.close();
      }
    });

  bounty
    .command("status <id> <status>")
    .description("Update bounty status (open, claimed, won, lost, skipped)")
    .action((idArg: string, status: string) => {
      const allowed = ["open", "claimed", "won", "lost", "skipped"];
      if (!allowed.includes(status)) {
        console.error(chalk.red(`status must be one of: ${allowed.join(", ")}`));
        process.exit(1);
      }
      const store = openStore();
      try {
        const id = parseInt(idArg, 10);
        const opp = store.getBountyOpportunity(id);
        if (!opp) {
          console.error(chalk.red(`No bounty with id ${id}`));
          process.exit(1);
        }
        store.updateBountyOpportunityStatus(id, status);
        console.log(chalk.green(`✓ #${id} → ${status}`));
      } finally {
        store.close();
      }
    });

  bounty
    .command("remove <id>")
    .description("Delete a bounty opportunity from the queue")
    .action((idArg: string) => {
      const store = openStore();
      try {
        const id = parseInt(idArg, 10);
        store.deleteBountyOpportunity(id);
        console.log(chalk.green(`✓ removed #${id}`));
      } finally {
        store.close();
      }
    });
}
