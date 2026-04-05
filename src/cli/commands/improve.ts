import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { StateStore } from "../../state/store.js";
import { Verifier } from "../../orchestrator/verifier.js";
import { ImprovementDetector } from "../../orchestrator/improvement-detector.js";
import { IssueCreator } from "../../orchestrator/issue-creator.js";

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
      const detector = new ImprovementDetector(config);

      const tasks = store.getRecentCompleted(parseInt(opts.limit, 10));

      if (tasks.length === 0) {
        console.log(chalk.dim("No completed tasks to analyze."));
        store.close();
        return;
      }

      console.log(chalk.dim(`Analyzing ${tasks.length} recent tasks...\n`));
      const improvements = await detector.analyze(tasks);

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
    .command("verify")
    .description("Verify recent unverified tasks")
    .option("-n, --limit <n>", "Number of tasks to verify", "5")
    .action(async (opts: { limit: string }) => {
      const config = loadConfig(program.opts().config);
      const store = new StateStore();
      const verifier = new Verifier(config, store);

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
          const result = await verifier.verify(task.id);
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
