import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { StateStore } from "../../state/store.js";
import {
  SubmissionAgent,
  isSubmissionAgentEnabled,
} from "../../orchestrator/submission-agent.js";
import { ImmunefiAdapter } from "../../orchestrator/submission-adapters/immunefi.js";
import type { FindingDraft } from "../../orchestrator/submission-adapters/types.js";

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

function buildAgent(store: StateStore): SubmissionAgent {
  return new SubmissionAgent(store, [new ImmunefiAdapter()]);
}

function colorSeverity(severity: string): string {
  switch (severity) {
    case "critical":
      return chalk.red.bold(severity);
    case "high":
      return chalk.red(severity);
    case "medium":
      return chalk.yellow(severity);
    case "low":
      return chalk.cyan(severity);
    default:
      return chalk.dim(severity);
  }
}

function colorStatus(status: string): string {
  switch (status) {
    case "awaiting-approval":
      return chalk.yellow(status);
    case "approved":
      return chalk.green(status);
    case "rejected":
      return chalk.red(status);
    case "consumed":
      return chalk.dim(status);
    case "submitted":
      return chalk.cyan(status);
    case "accepted":
      return chalk.green(status);
    case "paid":
      return chalk.green.bold(status);
    default:
      return status;
  }
}

export function registerSubmissionCommand(program: Command): void {
  const submission = program
    .command("submission")
    .description("Crypto-direct security finding submissions (issue #1599 / Layer 3 of #1512)");

  submission
    .command("queue")
    .description("Queue a draft finding for operator approval (no network call yet)")
    .requiredOption("--platform <name>", "Adapter platform (e.g. immunefi)")
    .requiredOption("--program <id>", "Target program identifier (e.g. ipor)")
    .requiredOption("--title <title>", "Finding title (≤ 200 chars)")
    .requiredOption("--severity <level>", "critical | high | medium | low | informational")
    .option("--body-file <path>", "Path to markdown finding body")
    .option("--body <text>", "Inline body (use --body-file for long content)")
    .option("--payout <usd>", "Expected payout in USD (numeric)")
    .option("--json", "Emit raw JSON result")
    .action(async (opts: {
      platform: string;
      program: string;
      title: string;
      severity: string;
      bodyFile?: string;
      body?: string;
      payout?: string;
      json?: boolean;
    }) => {
      const validSev = new Set(["critical", "high", "medium", "low", "informational"]);
      if (!validSev.has(opts.severity)) {
        console.error(chalk.red(`--severity must be one of: ${[...validSev].join(", ")}`));
        process.exit(1);
      }
      let body = opts.body ?? "";
      if (opts.bodyFile) {
        try {
          body = readFileSync(opts.bodyFile, "utf-8");
        } catch (err) {
          console.error(
            chalk.red(`Could not read --body-file: ${err instanceof Error ? err.message : String(err)}`),
          );
          process.exit(1);
        }
      }
      if (!body.trim()) {
        console.error(chalk.red("Provide --body or --body-file with non-empty content."));
        process.exit(1);
      }
      const draft: FindingDraft = {
        program: opts.program,
        title: opts.title,
        severity: opts.severity as FindingDraft["severity"],
        body,
        expected_payout_usd: opts.payout ? Number(opts.payout) : undefined,
      };
      const store = openStore();
      try {
        const agent = buildAgent(store);
        const result = await agent.queue(draft, opts.platform);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result.ok) {
          console.error(chalk.red(`✗ queue rejected (${result.reason}): ${result.detail}`));
          process.exit(1);
        }
        const p = result.pending;
        console.log(chalk.green(`✓ queued submission #${p.id}`));
        console.log(`  platform: ${chalk.bold(p.platform)}  program: ${p.program}`);
        console.log(`  severity: ${colorSeverity(p.severity)}  status: ${colorStatus(p.status)}`);
        console.log(`  title: ${p.title}`);
        if (p.expected_payout_usd != null) {
          console.log(`  expected payout: $${p.expected_payout_usd}`);
        }
        console.log(chalk.dim(`  → operator: \`orch submission approve ${p.id}\` or \`orch submission reject ${p.id} --reason ...\``));
      } finally {
        store.close();
      }
    });

  submission
    .command("list")
    .description("List submissions (pending and historical)")
    .option("--status <status>", "Filter by status")
    .option("--platform <name>", "Filter by platform")
    .option("--limit <n>", "Max rows", "50")
    .option("--json", "Emit raw JSON")
    .action((opts: { status?: string; platform?: string; limit?: string; json?: boolean }) => {
      const limit = parseInt(opts.limit ?? "50", 10);
      const store = openStore();
      try {
        const pending = store.listPendingSubmissions({
          status: opts.status as never,
          limit,
        });
        const submitted = store.listSubmissions({
          status: opts.status as never,
          platform: opts.platform,
          limit,
        });
        if (opts.json) {
          console.log(JSON.stringify({ pending, submitted }, null, 2));
          return;
        }
        console.log(chalk.bold("\n● Pending submissions\n"));
        if (pending.length === 0) {
          console.log(chalk.dim("  (none)"));
        } else {
          for (const p of pending) {
            console.log(
              `  ${chalk.dim(`#${p.id}`)} ${colorStatus(p.status)} ${colorSeverity(p.severity)}  ${chalk.bold(p.platform)}/${p.program}`,
            );
            console.log(`    ${p.title}`);
            if (p.expected_payout_usd != null) {
              console.log(`    ${chalk.dim("expected:")} $${p.expected_payout_usd}`);
            }
            if (p.rejection_reason) {
              console.log(`    ${chalk.red("rejected:")} ${p.rejection_reason}`);
            }
          }
        }
        console.log(chalk.bold("\n● Submitted\n"));
        if (submitted.length === 0) {
          console.log(chalk.dim("  (none)"));
        } else {
          for (const s of submitted) {
            console.log(
              `  ${chalk.dim(`#${s.id}`)} ${colorStatus(s.status)} ${colorSeverity(s.severity)}  ${chalk.bold(s.platform)}/${s.program}`,
            );
            console.log(`    ${s.title}`);
            console.log(`    ${chalk.dim("status URL:")} ${s.status_url}`);
            if (s.actual_payout_usd != null) {
              console.log(`    ${chalk.green("paid:")} $${s.actual_payout_usd}`);
            } else if (s.expected_payout_usd != null) {
              console.log(`    ${chalk.dim("expected:")} $${s.expected_payout_usd}`);
            }
          }
        }
        console.log();
      } finally {
        store.close();
      }
    });

  submission
    .command("show <id>")
    .description("Show full pending or submitted submission body")
    .option("--json", "Emit raw JSON")
    .action((idArg: string, opts: { json?: boolean }) => {
      const id = parseInt(idArg, 10);
      const store = openStore();
      try {
        const pending = store.getPendingSubmission(id);
        const submitted = store.getSubmission(id);
        if (!pending && !submitted) {
          console.error(chalk.red(`No submission with id ${id} (checked pending + submitted)`));
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify({ pending, submitted }, null, 2));
          return;
        }
        if (pending) {
          console.log(chalk.bold(`\n● Pending #${pending.id}\n`));
          console.log(`  ${chalk.bold("status:")} ${colorStatus(pending.status)}`);
          console.log(`  ${chalk.bold("platform:")} ${pending.platform}/${pending.program}`);
          console.log(`  ${chalk.bold("severity:")} ${colorSeverity(pending.severity)}`);
          console.log(`  ${chalk.bold("title:")} ${pending.title}`);
          console.log(`  ${chalk.bold("created:")} ${pending.created_at}`);
          if (pending.expected_payout_usd != null) {
            console.log(`  ${chalk.bold("expected payout:")} $${pending.expected_payout_usd}`);
          }
          if (pending.rejection_reason) {
            console.log(`  ${chalk.red("rejected:")} ${pending.rejection_reason}`);
          }
          console.log(chalk.bold("\nBody:\n"));
          console.log(pending.body);
        }
        if (submitted) {
          console.log(chalk.bold(`\n● Submitted #${submitted.id}\n`));
          console.log(`  ${chalk.bold("status:")} ${colorStatus(submitted.status)}`);
          console.log(`  ${chalk.bold("platform:")} ${submitted.platform}/${submitted.program}`);
          console.log(`  ${chalk.bold("submission_id:")} ${submitted.platform_submission_id}`);
          console.log(`  ${chalk.bold("status URL:")} ${submitted.status_url}`);
          console.log(`  ${chalk.bold("submitted:")} ${submitted.submitted_at}`);
        }
        console.log();
      } finally {
        store.close();
      }
    });

  submission
    .command("approve <id>")
    .description("Approve a pending submission (does NOT submit; use `submit` after)")
    .action((idArg: string) => {
      const id = parseInt(idArg, 10);
      const store = openStore();
      try {
        const agent = buildAgent(store);
        const ok = agent.approve(id);
        if (!ok) {
          const pending = store.getPendingSubmission(id);
          if (!pending) {
            console.error(chalk.red(`No pending submission with id ${id}`));
          } else {
            console.error(
              chalk.red(`Pending #${id} is in status '${pending.status}', cannot approve.`),
            );
          }
          process.exit(1);
        }
        console.log(chalk.green(`✓ approved pending #${id}`));
        console.log(chalk.dim(`  → run \`orch submission submit ${id}\` to ship it (requires SUBMISSION_AGENT_ENABLED=true)`));
      } finally {
        store.close();
      }
    });

  submission
    .command("reject <id>")
    .description("Reject a pending submission with a stored reason")
    .requiredOption("--reason <text>", "Rejection reason (stored in audit trail)")
    .action((idArg: string, opts: { reason: string }) => {
      const id = parseInt(idArg, 10);
      const store = openStore();
      try {
        const agent = buildAgent(store);
        const ok = agent.reject(id, opts.reason);
        if (!ok) {
          const pending = store.getPendingSubmission(id);
          if (!pending) {
            console.error(chalk.red(`No pending submission with id ${id}`));
          } else {
            console.error(
              chalk.red(`Pending #${id} is in status '${pending.status}', cannot reject.`),
            );
          }
          process.exit(1);
        }
        console.log(chalk.green(`✓ rejected pending #${id}`));
      } finally {
        store.close();
      }
    });

  submission
    .command("submit <id>")
    .description("Submit an approved pending submission to its external platform")
    .option("--json", "Emit raw JSON result")
    .action(async (idArg: string, opts: { json?: boolean }) => {
      if (!isSubmissionAgentEnabled()) {
        console.error(
          chalk.red(
            "SUBMISSION_AGENT_ENABLED is not 'true'. Set the env var to enable network submission.",
          ),
        );
        process.exit(1);
      }
      const id = parseInt(idArg, 10);
      const store = openStore();
      try {
        const agent = buildAgent(store);
        const result = await agent.submitApproved(id);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result.ok) {
          console.error(chalk.red(`✗ submit failed (${result.reason}): ${result.detail}`));
          process.exit(1);
        }
        const s = result.submission;
        console.log(chalk.green(`✓ submitted #${s.id} to ${s.platform}/${s.program}`));
        console.log(`  platform_submission_id: ${s.platform_submission_id}`);
        console.log(`  status URL: ${s.status_url}`);
      } finally {
        store.close();
      }
    });

  submission
    .command("platforms")
    .description("List registered submission adapter platforms")
    .action(() => {
      const store = openStore();
      try {
        const agent = buildAgent(store);
        const platforms = agent.listPlatforms();
        if (platforms.length === 0) {
          console.log(chalk.dim("(no adapters registered)"));
          return;
        }
        for (const p of platforms) {
          console.log(`  ${chalk.bold(p)}`);
        }
      } finally {
        store.close();
      }
    });
}
