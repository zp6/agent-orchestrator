import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import {
  scanFleetMergeStalls,
  getMergeStallThresholdHours,
  setMergeStallThresholdHours,
  type MergeablePR,
} from "../../triggers/merge-stall-guard.js";

function formatStaleHours(hours: number): string {
  if (hours >= 48) return chalk.red(`${Math.round(hours / 24)}d`);
  if (hours >= 24) return chalk.red(`${hours.toFixed(0)}h`);
  if (hours >= 8) return chalk.yellow(`${hours.toFixed(0)}h`);
  return chalk.dim(`${hours.toFixed(1)}h`);
}

function printTable(prs: MergeablePR[]): void {
  if (prs.length === 0) {
    console.log(chalk.green("✓ No stale MERGEABLE PRs found — fleet merge backlog is clear."));
    return;
  }

  const repoWidth = Math.max(4, ...prs.map((pr) => pr.repo.length));
  const titleWidth = Math.min(55, Math.max(5, ...prs.map((pr) => pr.title.length)));

  const header =
    chalk.bold("REPO".padEnd(repoWidth)) +
    "  " +
    chalk.bold("PR#".padEnd(6)) +
    "  " +
    chalk.bold("STALE".padEnd(6)) +
    "  " +
    chalk.bold("TITLE".padEnd(titleWidth));

  console.log(header);
  console.log("─".repeat(repoWidth + 6 + 6 + titleWidth + 6));

  for (const pr of prs) {
    const repo = pr.repo.padEnd(repoWidth);
    const prNum = `#${pr.number}`.padEnd(6);
    const stale = formatStaleHours(pr.staleHours).padEnd(6);
    const title = pr.title.length > titleWidth ? pr.title.slice(0, titleWidth - 1) + "…" : pr.title.padEnd(titleWidth);

    console.log(`${chalk.cyan(repo)}  ${prNum}  ${stale}  ${title}`);
  }

  console.log();
  console.log(
    chalk.yellow(`⚠ ${prs.length} stale MERGEABLE PR(s) blocking dispatch.`) +
    ` Threshold: ${getMergeStallThresholdHours()}h`,
  );
}

export function registerMergeSweepCommand(program: Command): void {
  program
    .command("merge-sweep")
    .description("Scan fleet repos for stale MERGEABLE PRs that block dispatch")
    .option("--threshold <hours>", "Override stale threshold (hours)", parseFloat)
    .option("--json", "Output as JSON")
    .action(async (opts: { threshold?: number; json?: boolean }) => {
      const configPath = program.opts().config ?? "agents.yaml";

      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig(configPath);
      } catch {
        console.error(chalk.red("Failed to load agents.yaml — using empty repo list"));
        process.exit(1);
      }

      // Apply threshold from CLI flag or config
      if (opts.threshold) {
        setMergeStallThresholdHours(opts.threshold);
      } else {
        setMergeStallThresholdHours(config.triggers?.merge_stall_threshold_hours);
      }

      // Collect unique repos from all agents
      const repos = new Set<string>();
      for (const agent of Object.values(config.agents)) {
        if (agent.github) repos.add(agent.github);
      }

      if (repos.size === 0) {
        console.log(chalk.dim("No repos configured in agents.yaml."));
        return;
      }

      console.log(
        chalk.dim(
          `Scanning ${repos.size} repo(s) for stale MERGEABLE PRs (threshold: ${getMergeStallThresholdHours()}h)…`,
        ),
      );
      console.log();

      const stalePRs = scanFleetMergeStalls([...repos]);

      if (opts.json) {
        console.log(JSON.stringify(stalePRs, null, 2));
        return;
      }

      printTable(stalePRs);
    });
}
