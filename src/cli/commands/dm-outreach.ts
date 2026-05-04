import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import { generateDMTemplate, formatForPlatform } from "../../orchestrator/dm-outreach-generator.js";
import { scoreRevenueLeadForBuyingPain } from "../../orchestrator/revenue-lead-matcher.js";

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

export function registerDMOutreachCommand(program: Command): void {
  const outreach = program
    .command("outreach")
    .description("DM outreach to revenue leads (issue #1447)");

  outreach
    .command("draft <lead-id>")
    .description("Generate DM template for a revenue lead")
    .option("--platform <name>", "Platform (twitter, github, email, linkedin)", "twitter")
    .option("--json", "Emit template as JSON")
    .action((leadIdArg: string, opts: { platform?: string; json?: boolean }) => {
      const store = openStore();
      try {
        const leadId = parseInt(leadIdArg, 10);
        const lead = store.getRevenueLead(leadId);
        if (!lead) {
          console.error(chalk.red(`No lead with id ${leadId}`));
          process.exit(1);
        }

        // Re-score the lead to get buying-pain signals
        const score = scoreRevenueLeadForBuyingPain(lead.title, lead.description ?? "");

        // Generate template
        const template = generateDMTemplate(
          lead,
          score,
          TREASURY_ADDRESS,
          opts.platform as "twitter" | "github" | "linkedin" | "email" | "telegram",
        );

        if (opts.json) {
          console.log(JSON.stringify(template, null, 2));
          return;
        }

        console.log(chalk.bold(`\n📧 DM Template for #${lead.id} — ${lead.title}\n`));
        console.log(`Platform: ${chalk.cyan(template.platform)}`);
        console.log(`Recipient: ${chalk.cyan(template.recipient)}`);
        console.log(`Pricing: ${chalk.yellow(template.pricingHint)}`);
        console.log(`Character count: ${template.characterCount} (fits: ${template.isThreadCapable ? "thread" : "single"})\n`);

        const formatted = formatForPlatform(template);
        if (Array.isArray(formatted)) {
          console.log(chalk.dim("─ Tweet Thread ─"));
          formatted.forEach((tweet, i) => {
            console.log(`\n[${i + 1}/${formatted.length}]\n${tweet}\n`);
          });
        } else {
          console.log(chalk.dim("─ Message ─"));
          console.log(formatted);
        }

        console.log(chalk.dim("\nℹ️  To send this: orch outreach send <lead-id> --platform <name>"));
        console.log();
      } finally {
        store.close();
      }
    });

  outreach
    .command("send <lead-id>")
    .description("Record DM outreach attempt (send DM manually, then confirm here)")
    .option("--platform <name>", "Platform (twitter, github, email, linkedin)", "twitter")
    .option("--recipient <handle>", "Recipient handle/email (override from lead)")
    .option("--dry-run", "Generate template but don't record attempt")
    .option("--json", "Emit record as JSON")
    .action((leadIdArg: string, opts: {
      platform?: string;
      recipient?: string;
      "dry-run"?: boolean;
      json?: boolean;
    }) => {
      const store = openStore();
      try {
        const leadId = parseInt(leadIdArg, 10);
        const lead = store.getRevenueLead(leadId);
        if (!lead) {
          console.error(chalk.red(`No lead with id ${leadId}`));
          process.exit(1);
        }

        const score = scoreRevenueLeadForBuyingPain(lead.title, lead.description ?? "");
        const template = generateDMTemplate(
          lead,
          score,
          TREASURY_ADDRESS,
          opts.platform as "twitter" | "github" | "linkedin" | "email" | "telegram",
        );

        const recipient = opts.recipient || template.recipient;

        if (opts["dry-run"]) {
          console.log(chalk.dim("(dry-run mode — no record created)"));
          console.log(chalk.bold("\nPreview:"));
          const formatted = formatForPlatform(template);
          if (Array.isArray(formatted)) {
            formatted.forEach((t, i) => {
              console.log(`\n[Tweet ${i + 1}]\n${t}`);
            });
          } else {
            console.log(formatted);
          }
          return;
        }

        const attemptId = store.recordDMOutreachAttempt({
          leadId,
          platform: opts.platform || "twitter",
          recipient,
          templateJson: JSON.stringify(template),
          status: "pending",
        });

        // Update lead status to 'contacted'
        store.updateRevenueLeadStatus(leadId, "contacted");

        if (opts.json) {
          console.log(JSON.stringify({ attemptId, leadId, platform: opts.platform, recipient }, null, 2));
          return;
        }

        console.log(chalk.green(`✓ recorded outreach attempt #${attemptId}`));
        console.log(`  to: ${recipient} via ${opts.platform}`);
        console.log(`  lead: #${leadId} (${lead.title})`);
        console.log(`  status: pending response`);
        console.log();
        console.log(chalk.dim("Next: Track responses with `orch outreach list-responses`"));
      } finally {
        store.close();
      }
    });

  outreach
    .command("list-attempts")
    .description("Show outreach campaign status")
    .option("--lead-id <n>", "Filter by lead ID")
    .option("--platform <name>", "Filter by platform (twitter, github, email, linkedin)")
    .option("--status <status>", "Filter by status (pending, sent, responded, converted)")
    .option("--limit <n>", "Max rows", "50")
    .option("--json", "Emit raw JSON")
    .action((opts: {
      "lead-id"?: string;
      platform?: string;
      status?: string;
      limit?: string;
      json?: boolean;
    }) => {
      const store = openStore();
      try {
        const attempts = store.listDMOutreachAttempts({
          leadId: opts["lead-id"] ? parseInt(opts["lead-id"], 10) : undefined,
          platform: opts.platform,
          status: opts.status,
          limit: parseInt(opts.limit ?? "50", 10),
        });

        if (opts.json) {
          console.log(JSON.stringify(attempts, null, 2));
          return;
        }

        console.log(chalk.bold("\n● DM Outreach Attempts\n"));
        if (attempts.length === 0) {
          console.log(chalk.dim("  No outreach attempts yet. Start with `orch outreach send <lead-id>`"));
          console.log();
          return;
        }

        for (const attempt of attempts) {
          const statusColor = attempt.status === "pending" ? chalk.yellow(attempt.status) :
                            attempt.responseStatus === "converted" ? chalk.green(attempt.responseStatus) :
                            chalk.dim(attempt.responseStatus || attempt.status);

          console.log(
            `  ${chalk.dim(`#${attempt.id}`)}  ${chalk.bold(`#${attempt.leadId}`)}  ${attempt.platform}  ${attempt.recipient}  ${statusColor}`,
          );
        }
        console.log();
      } finally {
        store.close();
      }
    });

  outreach
    .command("mark-responded <attempt-id>")
    .description("Mark an outreach attempt as having received a response")
    .option("--response <status>", "Response status (interested, not-interested, will-follow-up)", "interested")
    .option("--notes <text>", "Notes on the response")
    .action((attemptIdArg: string, opts: { response?: string; notes?: string }) => {
      const store = openStore();
      try {
        const attemptId = parseInt(attemptIdArg, 10);
        store.updateDMOutreachStatus(
          attemptId,
          "responded",
          opts.response || "interested",
          opts.notes,
        );
        console.log(chalk.green(`✓ #${attemptId} marked as ${opts.response || "interested"}`));
      } finally {
        store.close();
      }
    });

  outreach
    .command("convert <attempt-id>")
    .description("Mark outreach attempt as converted to paid engagement")
    .option("--notes <text>", "Notes on the conversion")
    .action((attemptIdArg: string, opts: { notes?: string }) => {
      const store = openStore();
      try {
        const attemptId = parseInt(attemptIdArg, 10);
        store.updateDMOutreachStatus(
          attemptId,
          "converted",
          "converted",
          opts.notes || "Converted to paid engagement",
        );
        console.log(chalk.green(`✓ #${attemptId} marked as converted 🎉`));
      } finally {
        store.close();
      }
    });
}
