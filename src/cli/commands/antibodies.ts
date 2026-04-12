import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type AntibodyLogEntry, type DiffShape } from "../../state/store.js";

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Colour-coded decision badge for terminal output. */
function decisionColour(decision: string): string {
  switch (decision) {
    case "approve":
      return chalk.green(decision.padEnd(15));
    case "request-changes":
      return chalk.yellow(decision.padEnd(15));
    case "escalate":
      return chalk.red(decision.padEnd(15));
    default:
      return chalk.dim(decision.padEnd(15));
  }
}

/** Colour-coded outcome badge. */
function outcomeColour(outcome: string | null): string {
  if (outcome === null) return chalk.dim("pending".padEnd(10));
  if (outcome === "clean") return chalk.green(outcome.padEnd(10));
  if (outcome === "regression") return chalk.red(outcome.padEnd(10));
  return chalk.dim(outcome.padEnd(10));
}

/** Parse a JSON diff_shape string safely, returning null on failure. */
function parseDiffShape(raw: string): DiffShape | null {
  try {
    return JSON.parse(raw) as DiffShape;
  } catch {
    return null;
  }
}

/** Compact one-line summary of a DiffShape. */
function formatDiffShape(raw: string): string {
  const shape = parseDiffShape(raw);
  if (!shape) return chalk.dim("unknown");
  const parts: string[] = [];
  if (shape.files_changed) parts.push(`${shape.files_changed}f`);
  if (shape.diff_size_bytes) parts.push(`${(shape.diff_size_bytes / 1024).toFixed(1)}kb`);
  if (shape.extensions?.length) parts.push(shape.extensions.slice(0, 3).join(","));
  if (shape.touches_schema) parts.push(chalk.yellow("schema"));
  if (shape.touches_tests) parts.push(chalk.cyan("tests"));
  return parts.join(" ") || chalk.dim("—");
}

/** Format a single antibody log row for terminal display. */
function formatRow(entry: AntibodyLogEntry): string {
  const ts = entry.timestamp.slice(0, 16).replace("T", " ");
  const repo = entry.repo.split("/")[1] ?? entry.repo;
  const pr = `#${entry.pr_number}`;
  const agent = entry.agent ? entry.agent.replace("claude-orchestrator-", "").replace("claude-", "") : "—";
  const reason = entry.reason
    ? entry.reason.length > 70 ? entry.reason.slice(0, 67) + "..." : entry.reason
    : chalk.dim("—");

  let line =
    `  ${chalk.dim(ts)}  ${decisionColour(entry.decision)} ` +
    `${outcomeColour(entry.outcome)} ` +
    `${chalk.cyan(repo.padEnd(20))} ${chalk.dim(pr.padEnd(6))} ` +
    `${String(agent).padEnd(20)} ${formatDiffShape(entry.diff_shape)}`;

  if (entry.reason) {
    line += `\n  ${" ".repeat(18)}${chalk.dim(reason)}`;
  }

  return line;
}

/** Format the stats summary block. */
function formatStats(stats: Array<{ decision: string; count: number; with_outcome: number }>): string {
  if (stats.length === 0) return chalk.dim("  No entries recorded yet.");
  const lines = stats.map((s) => {
    const pct = s.count > 0 ? Math.round((s.with_outcome / s.count) * 100) : 0;
    return `  ${decisionColour(s.decision)} count=${chalk.bold(String(s.count))} ` +
      `outcome_filed=${s.with_outcome} (${pct}%)`;
  });
  return lines.join("\n");
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerAntibodiesCommand(program: Command): void {
  program
    .command("antibodies")
    .description("Operator panel: self-learned failure immunity from the antibody log")
    .option("-n, --limit <n>", "Number of entries to show", "30")
    .option("--repo <slug>", "Filter by repo slug (e.g. rapartlu/agent-orchestrator)")
    .option(
      "--decision <type>",
      "Filter by decision type: approve | request-changes | escalate",
    )
    .option("--stats", "Show summary statistics only (grouped by decision type)")
    .option("--json", "Output raw JSON instead of formatted table")
    .action(
      (opts: {
        limit: string;
        repo?: string;
        decision?: string;
        stats?: boolean;
        json?: boolean;
      }) => {
        const limit = Math.max(1, parseInt(opts.limit, 10) || 30);

        if (opts.decision && !["approve", "request-changes", "escalate"].includes(opts.decision)) {
          console.error(
            chalk.red(
              `Error: --decision must be one of: approve, request-changes, escalate (got '${opts.decision}')`,
            ),
          );
          process.exit(1);
        }

        let store: StateStore;
        try {
          store = new StateStore();
        } catch (err) {
          console.error(
            chalk.red("Could not open state database:"),
            err instanceof Error ? err.message : String(err),
          );
          process.exit(1);
        }

        try {
          if (opts.stats) {
            const stats = store.getAntibodyStats();
            if (opts.json) {
              console.log(JSON.stringify(stats, null, 2));
              return;
            }
            console.log(chalk.bold("\n🧬 Antibody Log — Statistics\n"));
            console.log(formatStats(stats));
            console.log();
            return;
          }

          const entries = store.getAntibodyEntries({
            repo: opts.repo,
            decision: opts.decision as AntibodyLogEntry["decision"] | undefined,
            limit,
          });

          if (opts.json) {
            for (const e of entries) console.log(JSON.stringify(e));
            return;
          }

          console.log(chalk.bold("\n🧬 Antibody Log — Failure Immunity Panel\n"));
          console.log(
            chalk.dim(
              "  Each entry is one PR review decision. " +
              "Patterns here represent what the system has learned to approve, change, or escalate.\n",
            ),
          );

          if (entries.length === 0) {
            console.log(chalk.dim("  No entries recorded yet. Entries appear after the first PR review cycle."));
            console.log();
            return;
          }

          // Header
          console.log(
            chalk.dim(
              `  ${"Timestamp".padEnd(18)} ${"Decision".padEnd(15)} ${"Outcome".padEnd(10)} ` +
              `${"Repo".padEnd(20)} ${"PR".padEnd(6)} ${"Agent".padEnd(20)} Diff Shape`,
            ),
          );
          console.log(chalk.dim("  " + "─".repeat(130)));

          for (const entry of entries) {
            console.log(formatRow(entry));
          }

          console.log();

          // Inline stats summary
          const stats = store.getAntibodyStats();
          if (stats.length > 0) {
            console.log(chalk.bold("  Summary by decision type:"));
            for (const s of stats) {
              const pct = s.count > 0 ? Math.round((s.with_outcome / s.count) * 100) : 0;
              console.log(
                `    ${decisionColour(s.decision)} ${chalk.bold(String(s.count))} decision(s), ` +
                `${s.with_outcome} with outcome (${pct}% coverage)`,
              );
            }
            console.log();
          }

          const filterDesc = [
            opts.repo && `repo=${opts.repo}`,
            opts.decision && `decision=${opts.decision}`,
          ].filter(Boolean).join(", ");
          console.log(
            chalk.dim(
              `  Showing ${entries.length} entr${entries.length === 1 ? "y" : "ies"}` +
              `${filterDesc ? ` (filtered: ${filterDesc})` : ""}.  ` +
              `Run \`orch antibodies --stats\` for aggregate view.`,
            ),
          );
          console.log();
        } finally {
          store.close();
        }
      },
    );
}
