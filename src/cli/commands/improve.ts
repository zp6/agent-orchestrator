import type { Command } from "commander";
import chalk from "chalk";
import { ReviewerClient } from "../../client/reviewer-client.js";
import { loadConfig } from "../../config/schema.js";
import { StateStore } from "../../state/store.js";
import { IssueCreator } from "../../orchestrator/issue-creator.js";
import { detectImprovements, verifyTask } from "../../service/reviewer-ops.js";
import {
  detectHighIterationAgents,
  ITERATION_COST_THRESHOLD,
  ITERATION_COST_MIN_TASKS,
  ITERATION_COST_WINDOW_DAYS,
} from "../../orchestrator/iteration-cost-detector.js";

export function registerImproveCommand(program: Command): void {
  const improveCmd = program
    .command("improve")
    .description("Detect improvements and manage verification");

  improveCmd
    .command("detect")
    .description("Analyze recent tasks for cross-cutting improvements")
    .option("--dry-run", "Show improvements without creating issues")
    .option("-n, --limit <n>", "Number of recent tasks to analyze", "20")
    .action(async (opts: { dryRun?: boolean; limit: string }) => {
      const config = loadConfig(program.opts().config);
      const store = new StateStore();
      const reviewerClient = new ReviewerClient(config);

      const tasks = store.getRecentCompleted(parseInt(opts.limit, 10));

      if (tasks.length === 0) {
        console.log(chalk.dim("No completed tasks to analyze."));
        store.close();
        return;
      }

      console.log(chalk.dim(`Analyzing ${tasks.length} recent tasks...\n`));
      const improvements = await detectImprovements(reviewerClient, tasks);

      if (improvements.length === 0) {
        console.log(chalk.green("No improvements detected."));
        store.close();
        return;
      }

      console.log(chalk.bold(`${improvements.length} improvement(s) detected:\n`));
      for (const imp of improvements) {
        const severity = imp.severity === "high" ? chalk.red(imp.severity) :
          imp.severity === "medium" ? chalk.yellow(imp.severity) : chalk.dim(imp.severity);
        console.log(`  ${severity} ${chalk.bold(imp.title)}`);
        console.log(`    ${imp.description}`);
        console.log(`    Agents: ${imp.affected_agents.map((a) => chalk.cyan(a)).join(", ")}`);
        console.log();
      }

      if (opts.dryRun) {
        console.log(chalk.dim("Dry run — no issues created."));
        store.close();
        return;
      }

      const creator = new IssueCreator(config);
      let totalCreated = 0;

      for (const imp of improvements) {
        const created = creator.createAcrossRepos(imp);
        for (const issue of created) {
          console.log(chalk.green(`  Created: ${issue.url}`));
          totalCreated++;
        }
      }

      console.log(chalk.bold(`\n${totalCreated} issue(s) created.`));
      store.close();
    });

  improveCmd
    .command("iteration-cost")
    .description(
      "Check per-agent PR iteration cost and file improvement issues for agents above threshold",
    )
    .option("--dry-run", "Show flagged agents without creating issues")
    .option(
      "--threshold <n>",
      `Avg revision rounds above which to flag an agent (default: ${ITERATION_COST_THRESHOLD})`,
      String(ITERATION_COST_THRESHOLD),
    )
    .action((opts: { dryRun?: boolean; threshold: string }) => {
      const config = loadConfig(program.opts().config);
      const store = new StateStore();

      const threshold = parseFloat(opts.threshold) || ITERATION_COST_THRESHOLD;

      console.log(
        chalk.bold(
          `\n📊 PR Iteration Cost Check\n` +
          chalk.dim(
            `  Threshold: >${threshold} avg rounds/PR over last ${ITERATION_COST_WINDOW_DAYS} days ` +
            `(min ${ITERATION_COST_MIN_TASKS} tasks)\n`,
          ),
        ),
      );

      // Surface all metrics for display even if below threshold
      const allMetrics = store.getAgentIterationCostMetrics(
        ITERATION_COST_WINDOW_DAYS,
        ITERATION_COST_MIN_TASKS,
      );

      if (allMetrics.length === 0) {
        console.log(
          chalk.dim(
            `  No agents have >= ${ITERATION_COST_MIN_TASKS} completed implementation tasks ` +
            `in the last ${ITERATION_COST_WINDOW_DAYS} days yet.`,
          ),
        );
        store.close();
        return;
      }

      // Display metrics table
      console.log(
        chalk.dim(
          `  ${"Agent".padEnd(40)} ${"Tasks".padEnd(8)} ${"Avg Rounds".padEnd(12)} Status`,
        ),
      );
      console.log(chalk.dim("  " + "─".repeat(80)));

      for (const m of allMetrics) {
        const overThreshold = m.avg_revision_count > threshold;
        const avgStr = m.avg_revision_count.toFixed(2).padEnd(12);
        const status = overThreshold
          ? chalk.red("⚠ ABOVE THRESHOLD")
          : chalk.green("✓ OK");
        const avgColoured = overThreshold ? chalk.red(avgStr) : chalk.green(avgStr);
        console.log(
          `  ${chalk.cyan(m.agent_name.padEnd(40))} ${String(m.task_count).padEnd(8)} ${avgColoured} ${status}`,
        );
        if (overThreshold && m.sample_task_ids.length > 0) {
          console.log(
            chalk.dim(`    Example tasks: ${m.sample_task_ids.map((id) => id.slice(0, 8)).join(", ")}`),
          );
        }
      }

      // Run the detector to get improvement objects
      const improvements = detectHighIterationAgents(store, config);

      if (improvements.length === 0) {
        console.log(chalk.green(`\n  All agents are within the iteration cost threshold.`));
        store.close();
        return;
      }

      console.log(
        chalk.bold(
          `\n  ${improvements.length} agent(s) above threshold — ` +
          (opts.dryRun ? chalk.dim("dry run, no issues created.") : "filing improvement issues..."),
        ),
      );

      if (opts.dryRun) {
        for (const imp of improvements) {
          console.log(`\n  ${chalk.yellow("⚠")} ${chalk.bold(imp.title)}`);
          console.log(chalk.dim(`    Severity: ${imp.severity}`));
          console.log(chalk.dim(`    ${imp.description.slice(0, 200)}...`));
        }
        store.close();
        return;
      }

      const creator = new IssueCreator(config);
      let totalCreated = 0;
      for (const imp of improvements) {
        const created = creator.createAcrossRepos(imp, ["iteration-cost-triggered"]);
        for (const issue of created) {
          console.log(chalk.green(`  Created: ${issue.url}`));
          totalCreated++;
        }
      }
      console.log(chalk.bold(`\n  ${totalCreated} issue(s) created.`));
      store.close();
    });

  improveCmd
    .command("verify")
    .description("Verify recent unverified tasks")
    .option("-n, --limit <n>", "Number of tasks to verify", "5")
    .action(async (opts: { limit: string }) => {
      const config = loadConfig(program.opts().config);
      const store = new StateStore();
      const reviewerClient = new ReviewerClient(config);

      const tasks = store.getUnverified(parseInt(opts.limit, 10));

      if (tasks.length === 0) {
        console.log(chalk.dim("No unverified tasks."));
        store.close();
        return;
      }

      console.log(chalk.bold(`Verifying ${tasks.length} task(s)...\n`));

      for (const task of tasks) {
        const agent = task.agent_name ? chalk.cyan(task.agent_name) : chalk.dim("unknown");
        process.stdout.write(`  ${chalk.dim(task.id.slice(0, 8))} ${agent} ${task.title.slice(0, 50)}... `);

        try {
          const result = await verifyTask(store, reviewerClient, task.id);
          const scoreColor = result.score >= 0.7 ? chalk.green : result.score >= 0.5 ? chalk.yellow : chalk.red;
          const status = result.approved ? chalk.green("approved") : chalk.red("rejected");
          console.log(`${status} ${scoreColor(`(${result.score.toFixed(1)})`)}`);
          if (!result.approved && result.revision) {
            console.log(`    ${chalk.dim("Revision:")} ${result.revision.slice(0, 100)}`);
          }
        } catch (err) {
          console.log(chalk.red(`error: ${err instanceof Error ? err.message : err}`));
        }
      }

      store.close();
    });
}
