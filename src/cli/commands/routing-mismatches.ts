/**
 * `orch routing-mismatches` — Routing Mismatches Audit (issue #861)
 *
 * Shows tasks where the executed agent doesn't match the intended agent
 * (extracted from the task title [agent-name] prefix).
 *
 * Usage:
 *   orch routing-mismatches              # last 30 days, formatted table
 *   orch routing-mismatches --days 7     # 7-day window
 *   orch routing-mismatches --intended claude-research-agent  # filter by intended
 *   orch routing-mismatches --actual claude-orchestrator-dashboard  # filter by actual
 *   orch routing-mismatches --json       # machine-readable JSON
 */

import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { StateStore } from "../../state/store.js";

export function registerRoutingMismatchesCommand(program: Command): void {
  program
    .command("routing-mismatches")
    .description(
      "Audit routing mismatches: tasks executed by agent ≠ intended agent",
    )
    .option("--days <number>", "Time window in days (default 30)", "30")
    .option(
      "--intended <agent>",
      "Filter to specific intended agent",
      undefined,
    )
    .option(
      "--actual <agent>",
      "Filter to specific actual agent",
      undefined,
    )
    .option("--json", "Output as JSON", false)
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const store = new StateStore();

        const days = parseInt(options.days as string, 10) || 30;
        const intended = options.intended as string | undefined;
        const actual = options.actual as string | undefined;
        const jsonOutput = options.json as boolean;

        // Get mismatch stats
        const stats = store.getRoutingMismatchStats(config, days);

        // Get detailed mismatches
        const mismatches = store.getRoutingMismatches(config, {
          days,
          intendedAgent: intended,
          actualAgent: actual,
          limit: 100,
        });

        if (jsonOutput) {
          console.log(
            JSON.stringify(
              {
                summary: stats,
                mismatches,
              },
              null,
              2,
            ),
          );
          process.exit(0);
        }

        // Human-readable output
        console.log();
        console.log(
          chalk.bold(`Routing Mismatches Audit (Last ${days} days)`),
        );
        console.log();

        // Summary section
        console.log(chalk.cyan("📊 Summary"));
        console.log(`  Total tasks analyzed: ${stats.totalTasksAnalyzed}`);
        console.log(
          `  Mismatches found: ${chalk.red(String(stats.mismatchCount))}`,
        );
        console.log(
          `  Mismatch rate: ${chalk.yellow((stats.mismatchRate * 100).toFixed(1) + "%")}`,
        );
        console.log();

        // Grouped by agent pair
        if (stats.byAgentPair.length > 0) {
          console.log(chalk.cyan("🔀 Mismatches by Agent Pair"));
          console.log();

          const COL = {
            intended: 32,
            actual: 32,
            count: 8,
            quality: 10,
            recent: 30,
          };

          const header = [
            "Intended Agent".padEnd(COL.intended),
            "Actual Agent".padEnd(COL.actual),
            "Count".padStart(COL.count),
            "Avg Quality".padStart(COL.quality),
            "Most Recent".padStart(COL.recent),
          ].join("  ");

          console.log(header);
          console.log("─".repeat(header.length));

          for (const pair of stats.byAgentPair) {
            const intendedStr = chalk.blue(pair.intendedAgent).padEnd(
              COL.intended - 10,
            );
            const actualStr = chalk.red(pair.actualAgent).padEnd(
              COL.actual - 10,
            );
            const countStr = chalk.yellow(String(pair.count)).padStart(
              COL.count - 3,
            );
            const qualityStr = (
              pair.avgQualityScore !== null
                ? pair.avgQualityScore.toFixed(2)
                : "—"
            ).padStart(COL.quality - 2);
            const recentDate = new Date(pair.mostRecentAt).toLocaleDateString();
            const recentStr = recentDate.padStart(COL.recent - 4);

            console.log(
              `${intendedStr}  ${actualStr}  ${countStr}  ${qualityStr}  ${recentStr}`,
            );
          }

          console.log();
        }

        // Detailed mismatches
        if (mismatches.length > 0) {
          console.log(chalk.cyan("📋 Detailed Mismatches"));
          console.log();

          const COL = {
            taskId: 12,
            intended: 28,
            actual: 28,
            quality: 10,
            status: 12,
          };

          const header = [
            "Task ID".padEnd(COL.taskId),
            "Intended".padEnd(COL.intended),
            "Actual".padEnd(COL.actual),
            "Quality".padStart(COL.quality),
            "Status".padStart(COL.status),
          ].join("  ");

          console.log(header);
          console.log("─".repeat(header.length));

          for (const m of mismatches.slice(0, 20)) {
            const taskIdStr = chalk.dim(m.taskId.substring(0, 11)).padEnd(
              COL.taskId - 4,
            );
            const intentedStr = chalk.blue(m.intendedAgent || "—").padEnd(
              COL.intended - 4,
            );
            const actualStr = chalk.red(m.actualAgent || "—").padEnd(
              COL.actual - 4,
            );
            const qualityStr = (
              m.qualityScore !== null
                ? chalk.yellow(m.qualityScore.toFixed(2))
                : chalk.dim("—")
            ).padStart(COL.quality - 2);
            const statusStr = m.taskStatus.padStart(COL.status - 2);

            console.log(
              `${taskIdStr}  ${intentedStr}  ${actualStr}  ${qualityStr}  ${statusStr}`,
            );
          }

          if (mismatches.length > 20) {
            console.log(
              chalk.dim(
                `  ... and ${mismatches.length - 20} more (use --json for full list)`,
              ),
            );
          }

          console.log();
        } else {
          console.log(chalk.green("✓ No routing mismatches found!"));
          console.log();
        }

        process.exit(0);
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });
}
