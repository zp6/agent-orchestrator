import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type RevenueLead } from "../../state/store.js";
import {
  scoreRevenueLeadForBuyingPain,
  extractTextFromUrl,
  generateDmBrief,
} from "../../orchestrator/revenue-lead-matcher.js";

const TREASURY_ADDRESS = "0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef";

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

async function scoreAndBrief(
  store: StateStore,
  lead: RevenueLead,
): Promise<RevenueLead> {
  const scoring = scoreRevenueLeadForBuyingPain(lead.title, lead.description ?? "");
  const brief = generateDmBrief(
    lead.title,
    lead.description ?? "",
    scoring,
    TREASURY_ADDRESS,
  );

  // Convert BuyingPainSignal[] to Record<string, number> for storage
  const breakdown: Record<string, number> = {};
  for (const signal of scoring.signals) {
    breakdown[signal.name] = signal.points;
  }

  store.updateRevenueLeadScore(lead.id, scoring.score, breakdown, scoring.urgency, brief);
  return store.getRevenueLead(lead.id)!;
}

function colorScore(score: number | null): string {
  if (score == null) return chalk.dim("—");
  if (score >= 75) return chalk.green(`${score}`);
  if (score >= 50) return chalk.yellow(`${score}`);
  return chalk.red(`${score}`);
}

function urgencyIcon(urgency: string | null): string {
  if (urgency === "high") return "🔴";
  if (urgency === "medium") return "🟡";
  return "🟢";
}

export function registerRevenueLeadCommand(program: Command): void {
  const lead = program
    .command("lead")
    .description("Revenue lead scanner + DM brief queue (issue #1313)");

  lead
    .command("add <source>")
    .description("Add a revenue lead from a URL or raw text")
    .option("--raw", "Treat <source> as raw text, not a URL")
    .option("--contact <email-or-twitter>", "Contact info (email or @handle)")
    .option("--json", "Emit the resulting record as JSON")
    .action(
      async (
        source: string,
        opts: { raw?: boolean; contact?: string; json?: boolean },
      ) => {
        const store = openStore();
        try {
          let title: string;
          let description: string;
          let sourceUrl: string | null = null;

          if (opts.raw) {
            // Raw text input
            const lines = source.split("\n");
            title = lines[0]?.trim() || "No title";
            description = lines.slice(1).join("\n").trim() || source;
          } else {
            // Fetch from URL
            try {
              const extracted = await extractTextFromUrl(source);
              title = extracted.title;
              description = extracted.description;
              sourceUrl = source;
            } catch (err) {
              console.error(
                chalk.red("Failed to fetch URL:"),
                err instanceof Error ? err.message : String(err),
              );
              console.error(chalk.dim("Tip: use --raw to input text directly"));
              process.exit(1);
            }
          }

          let lead: RevenueLead;
          try {
            lead = store.addRevenueLeadFromUrl({
              source_url: sourceUrl ?? undefined,
              title,
              description,
              contact_email:
                opts.contact && opts.contact.includes("@") ? opts.contact : undefined,
              contact_twitter:
                opts.contact && opts.contact.startsWith("@") ? opts.contact : undefined,
            });
          } catch (err) {
            console.error(chalk.red(err instanceof Error ? err.message : String(err)));
            process.exit(1);
          }

          lead = await scoreAndBrief(store, lead);

          if (opts.json) {
            console.log(JSON.stringify(lead, null, 2));
            return;
          }

          console.log(chalk.green(`✓ added lead #${lead.id}`));
          console.log(`  ${chalk.bold(lead.title)}`);
          console.log(
            `  score: ${colorScore(lead.score)}/100  urgency: ${urgencyIcon(lead.estimated_urgency)} ${lead.estimated_urgency}`,
          );
          if (lead.source_url) {
            console.log(`  ${chalk.dim(lead.source_url)}`);
          }
          console.log(chalk.dim(`  run \`orch lead show ${lead.id}\` for the full DM brief`));
        } finally {
          store.close();
        }
      },
    );

  lead
    .command("list")
    .description("List revenue leads, ranked by buying-pain score")
    .option("--status <status>", "Filter by status (new, contacted, pending, won, declined)")
    .option("--min-score <n>", "Show only leads with score ≥ n", "0")
    .option("--sort <field>", "Sort order (score, created_at)", "score")
    .option("--limit <n>", "Max rows", "50")
    .option("--json", "Emit raw JSON")
    .action(
      (opts: {
        status?: string;
        "min-score"?: string;
        sort?: string;
        limit?: string;
        json?: boolean;
      }) => {
        const store = openStore();
        try {
          const items = store.listRevenueLeads({
            status: opts.status,
            minScore: parseInt(opts["min-score"] ?? "0", 10),
            limit: parseInt(opts.limit ?? "50", 10),
            sortBy: opts.sort === "created_at" ? "created_at" : "score",
          });

          if (opts.json) {
            console.log(JSON.stringify(items, null, 2));
            return;
          }

          console.log(chalk.bold("\n● Revenue Leads Queue\n"));
          if (items.length === 0) {
            console.log(
              chalk.dim("  Queue is empty. Add one with `orch lead add <url-or-text>`"),
            );
            console.log();
            return;
          }

          for (const l of items) {
            const status =
              l.status === "new"
                ? chalk.cyan(l.status)
                : l.status === "contacted"
                  ? chalk.blue(l.status)
                  : chalk.dim(l.status);
            console.log(
              `  ${chalk.dim(`#${l.id}`)} ${colorScore(l.score)}/100  ${urgencyIcon(l.estimated_urgency)}  ${chalk.bold(l.title)}  ${status}`,
            );
            if (l.source_url) {
              console.log(`    ${chalk.dim(l.source_url)}`);
            }
            if (l.contact_email || l.contact_twitter) {
              const contact = l.contact_email || l.contact_twitter;
              console.log(`    contact: ${chalk.dim(contact)}`);
            }
          }
          console.log();
        } finally {
          store.close();
        }
      },
    );

  lead
    .command("show <id>")
    .description("Show full DM brief for a revenue lead")
    .option("--json", "Emit raw JSON")
    .action((idArg: string, opts: { json?: boolean }) => {
      const store = openStore();
      try {
        const id = parseInt(idArg, 10);
        const l = store.getRevenueLead(id);
        if (!l) {
          console.error(chalk.red(`No lead with id ${id}`));
          process.exit(1);
        }

        if (opts.json) {
          console.log(JSON.stringify(l, null, 2));
          return;
        }

        console.log(chalk.bold(`\n#${id} — ${l.title}\n`));
        console.log(chalk.dim(`Source: ${l.source_url || "text input"}`));
        console.log(chalk.dim(`Score: ${l.score}/100  Urgency: ${l.estimated_urgency}\n`));

        if (l.dm_brief) {
          console.log(l.dm_brief);
        } else {
          console.log(chalk.dim("(no brief yet — lead may need re-scoring)"));
        }

        console.log();
      } finally {
        store.close();
      }
    });

  lead
    .command("status <id> <status>")
    .description("Update lead status (new, contacted, pending, won, declined)")
    .action((idArg: string, status: string) => {
      const allowed = ["new", "contacted", "pending", "won", "declined"];
      if (!allowed.includes(status)) {
        console.error(chalk.red(`status must be one of: ${allowed.join(", ")}`));
        process.exit(1);
      }
      const store = openStore();
      try {
        const id = parseInt(idArg, 10);
        const l = store.getRevenueLead(id);
        if (!l) {
          console.error(chalk.red(`No lead with id ${id}`));
          process.exit(1);
        }
        store.updateRevenueLeadStatus(id, status);
        console.log(chalk.green(`✓ #${id} → ${status}`));
      } finally {
        store.close();
      }
    });

  lead
    .command("remove <id>")
    .description("Delete a revenue lead from the queue")
    .action((idArg: string) => {
      const store = openStore();
      try {
        const id = parseInt(idArg, 10);
        store.deleteRevenueLead(id);
        console.log(chalk.green(`✓ removed #${id}`));
      } finally {
        store.close();
      }
    });
}
