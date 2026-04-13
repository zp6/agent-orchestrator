import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { StateStore } from "../../state/store.js";
import { detectCoverageGaps, suggestNewAgent, formatGapsForDisplay } from "../../orchestrator/coverage-gap-detector.js";

export function registerAgentGapsCommand(program: Command): void {
  program
    .command("agent-gaps")
    .description("Detect coverage gaps: unowned topics, scope overload, low-confidence routing")
    .option("--days <n>", "Analysis window in days", "14")
    .option("--propose", "Also suggest a new agent based on detected gaps")
    .action((opts: { days: string; propose?: boolean }) => {
      const config = loadConfig();
      const store = new StateStore();

      try {
        const gaps = detectCoverageGaps(config, store, parseInt(opts.days, 10));
        console.log(formatGapsForDisplay(gaps));

        if (opts.propose && gaps.length > 0) {
          const proposal = suggestNewAgent(gaps, config);
          if (proposal) {
            console.log(chalk.bold("\nProposed new agent:"));
            console.log(chalk.cyan(`  Name: ${proposal.suggestedName}`));
            console.log(`  Description: ${proposal.description}`);
            console.log(`  Capabilities: ${proposal.capabilities.join(", ")}`);
            console.log(`  Topics: ${proposal.owns_topics.join(", ")}`);
            console.log(chalk.dim(`  Reason: ${proposal.reason}`));
            console.log(chalk.dim(`\n  Create with: orch create ${proposal.suggestedName} --capabilities "${proposal.capabilities.join(",")}" --scope-owns "${proposal.owns_topics.join(",")}"`));
          } else {
            console.log(chalk.dim("\nNo agent proposal — gaps don't cluster enough to warrant a new agent."));
          }
        }
      } finally {
        store.close();
      }
    });
}
