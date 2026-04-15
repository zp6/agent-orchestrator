/**
 * `orch followup-chains` — follow-up chain cost explorer (issue #838).
 *
 * Traces the full tree of child issues spawned by a root GitHub issue,
 * showing agents, quality scores, token usage, and cost estimates.
 * Chains with depth > 3 render a warning badge.
 *
 * Usage:
 *   orch followup-chains show owner/repo#42
 *   orch followup-chains show owner/repo#42 --depth 3
 *   orch followup-chains show owner/repo#42 --json
 *   orch followup-chains list                          # top chains by issue count
 *   orch followup-chains list --limit 10 --min-depth 2
 *
 * Exit codes:
 *   0 — normal
 *   1 — database / argument error
 *   2 — root source ref not found in lineage_mappings or tasks
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import {
  buildFollowupChain,
  flattenChain,
  MAX_CHAIN_DEPTH,
  MAX_DEPTH_WARNING,
  COST_PER_1K_TOKENS_USD,
  type ChainNode,
  type ChainSummary,
  type FollowupChainResult,
} from "../../orchestrator/followup-chain-tracker.js";

// ── Rendering helpers ─────────────────────────────────────────────────────────

/** Format a quality score with colour coding. */
function fmtScore(score: number | null): string {
  if (score === null) return chalk.dim("  —  ");
  const s = score.toFixed(2);
  if (score >= 0.9) return chalk.green(s);
  if (score >= 0.7) return chalk.yellow(s);
  return chalk.red(s);
}

/** Format a token count in a compact human-readable form. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return chalk.cyan(`${(n / 1_000_000).toFixed(1)}M`);
  if (n >= 1_000) return chalk.cyan(`${(n / 1_000).toFixed(1)}k`);
  return chalk.cyan(String(n));
}

/** Format a USD cost. */
function fmtCost(usd: number): string {
  if (usd < 0.01) return chalk.dim(`$${usd.toFixed(4)}`);
  if (usd < 1) return chalk.yellow(`$${usd.toFixed(3)}`);
  return chalk.red(`$${usd.toFixed(2)}`);
}

/** Render depth warning badge. */
function depthBadge(depth: number): string {
  if (depth > MAX_DEPTH_WARNING) {
    return chalk.red.bold(` ⚠ depth=${depth} (>${MAX_DEPTH_WARNING})`);
  }
  return chalk.dim(` depth=${depth}`);
}

/** Render a single tree node line with tree-art prefix. */
function renderNode(node: ChainNode, prefix: string, isLast: boolean): string {
  const connector = isLast ? "└─" : "├─";
  const badge = depthBadge(node.depth);
  const score = fmtScore(node.avg_quality_score);
  const tokens = fmtTokens(node.total_tokens);
  const agents =
    node.agent_names.length > 0
      ? chalk.blue(node.agent_names.join(", "))
      : chalk.dim("no agent");
  const tasks =
    node.task_ids.length > 0
      ? chalk.dim(`${node.task_ids.length} task(s)`)
      : chalk.dim("0 tasks");
  const prs =
    node.pr_count > 0
      ? chalk.green(`${node.pr_count} PR(s)`)
      : chalk.dim("0 PRs");

  const ref = chalk.white(node.source_ref);

  return `${prefix}${connector} ${ref}${badge}  ${tasks}  ${prs}  quality:${score}  tokens:${tokens}  ${agents}`;
}

/** Recursively print the tree to stdout. */
function printTree(node: ChainNode, prefix: string, isLast: boolean): void {
  console.log(renderNode(node, prefix, isLast));

  const childPrefix = prefix + (isLast ? "   " : "│  ");
  for (let i = 0; i < node.children.length; i++) {
    const last = i === node.children.length - 1;
    printTree(node.children[i], childPrefix, last);
  }
}

/** Print the full chain result with summary header and tree. */
function printChainResult(result: FollowupChainResult): void {
  const { root, summary } = result;

  console.log();
  console.log(
    chalk.bold.white("  Follow-up Chain Explorer") +
      chalk.dim(` — ${summary.root_source_ref}`),
  );

  if (summary.depth_warning) {
    console.log(
      chalk.red.bold(
        `  ⚠  Cascade depth ${summary.max_depth} exceeds warning threshold (>${MAX_DEPTH_WARNING}). Review chain for runaway follow-ups.`,
      ),
    );
  }
  console.log();

  // Summary stats
  const statsLine = [
    `${chalk.bold(summary.total_issues)} issue(s)`,
    `${chalk.bold(summary.total_tasks)} task(s)`,
    `${chalk.bold(summary.total_prs)} merged PR(s)`,
    `${chalk.bold(summary.agent_names.length)} agent(s)`,
    `tokens: ${fmtTokens(summary.total_tokens)}`,
    `est. cost: ${fmtCost(summary.estimated_cost_usd)}`,
    summary.avg_quality_score !== null
      ? `avg quality: ${fmtScore(summary.avg_quality_score)}`
      : chalk.dim("no quality scores"),
  ].join(chalk.dim("  ·  "));
  console.log("  " + statsLine);
  console.log();

  // Tree
  console.log(
    chalk.bold("  ◆ ") +
      chalk.white(root.source_ref) +
      depthBadge(root.depth) +
      chalk.dim(
        `  ${root.task_ids.length} task(s)  ${root.pr_count} PR(s)  quality:${fmtScore(root.avg_quality_score)}  tokens:${fmtTokens(root.total_tokens)}`,
      ) +
      (root.agent_names.length > 0
        ? "  " + chalk.blue(root.agent_names.join(", "))
        : ""),
  );

  for (let i = 0; i < root.children.length; i++) {
    const last = i === root.children.length - 1;
    printTree(root.children[i], "  ", last);
  }

  if (root.children.length === 0) {
    console.log(chalk.dim("    (no follow-up issues recorded)"));
  }

  console.log();
}

// ── CLI registration ──────────────────────────────────────────────────────────

export function registerFollowupChainsCommand(program: Command): void {
  const chains = program
    .command("followup-chains")
    .description(
      "Follow-up chain cost explorer — trace all child issues spawned by a root issue",
    );

  // ── show <sourceRef> ───────────────────────────────────────────────────────
  chains
    .command("show <sourceRef>")
    .description(
      "Show the full follow-up chain tree rooted at the given issue (e.g. owner/repo#42)",
    )
    .option(
      "-d, --depth <n>",
      `Max traversal depth (1–${MAX_CHAIN_DEPTH}, default ${MAX_CHAIN_DEPTH})`,
      String(MAX_CHAIN_DEPTH),
    )
    .option("--json", "Output raw JSON instead of a formatted tree")
    .action((sourceRef: string, opts: { depth?: string; json?: boolean }) => {
      const maxDepth = opts.depth !== undefined ? parseInt(opts.depth, 10) : MAX_CHAIN_DEPTH;
      if (isNaN(maxDepth) || maxDepth < 1 || maxDepth > MAX_CHAIN_DEPTH) {
        console.error(
          chalk.red(`Error: --depth must be between 1 and ${MAX_CHAIN_DEPTH}`),
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

      let result: FollowupChainResult;
      try {
        result = buildFollowupChain(store, sourceRef, maxDepth);
      } catch (err) {
        console.error(
          chalk.red("Failed to build follow-up chain:"),
          err instanceof Error ? err.message : String(err),
        );
        store.close();
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        store.close();
        return;
      }

      printChainResult(result);
      store.close();
    });

  // ── list ───────────────────────────────────────────────────────────────────
  chains
    .command("list")
    .description(
      "List root issues that have the most follow-up children (high blast-radius)",
    )
    .option("-l, --limit <n>", "Maximum root issues to show", "20")
    .option(
      "--min-depth <n>",
      `Only show chains with depth >= n (default 1)`,
      "1",
    )
    .option("--json", "Output raw JSON")
    .action(
      (opts: { limit?: string; minDepth?: string; json?: boolean }) => {
        const limit = parseInt(opts.limit ?? "20", 10);
        const minDepth = parseInt(opts.minDepth ?? "1", 10);

        if (isNaN(limit) || limit < 1) {
          console.error(chalk.red("Error: --limit must be a positive integer"));
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

        // Get all multi-task lineage groups; use them as candidate roots.
        // Then build chains and filter by minDepth.
        const groups = store.getMultiTaskLineageGroups(limit * 3);

        if (groups.length === 0) {
          if (!opts.json) {
            console.log(
              chalk.dim("No multi-issue lineage groups found yet."),
            );
          } else {
            console.log("[]");
          }
          store.close();
          return;
        }

        // Build chain summary for each root group
        type ListRow = ChainSummary & { root_title: string | null };
        const rows: ListRow[] = [];

        for (const g of groups) {
          // Derive root source_ref from the root task
          const rootTasks = store.findAllTasksBySourceRef(
            g.lineage_group_id,
          );
          const rootSourceRef =
            rootTasks[0]?.source_ref ?? g.lineage_group_id;

          try {
            const result = buildFollowupChain(store, rootSourceRef, MAX_CHAIN_DEPTH);
            if (result.summary.max_depth < minDepth) continue;
            rows.push({ ...result.summary, root_title: g.root_title });
          } catch {
            // Skip groups that error during chain building
          }

          if (rows.length >= limit) break;
        }

        // Sort by total issues descending
        rows.sort((a, b) => b.total_issues - a.total_issues);

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          store.close();
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim(`No chains with depth >= ${minDepth} found.`));
          store.close();
          return;
        }

        console.log();
        console.log(
          chalk.bold.white("  Follow-up Chain Index") +
            chalk.dim(` — top ${rows.length} chain(s) by issue count`),
        );
        console.log();

        const header = [
          chalk.dim("  Root Source Ref".padEnd(40)),
          chalk.dim("Issues".padStart(7)),
          chalk.dim("Tasks".padStart(6)),
          chalk.dim("PRs".padStart(5)),
          chalk.dim("Depth".padStart(6)),
          chalk.dim("Tokens".padStart(10)),
          chalk.dim("Est Cost".padStart(10)),
          chalk.dim("Agents"),
        ].join("  ");
        console.log(header);
        console.log(chalk.dim("  " + "─".repeat(100)));

        for (const row of rows) {
          const refTrunc =
            row.root_source_ref.length > 38
              ? `…${row.root_source_ref.slice(-37)}`
              : row.root_source_ref.padEnd(40);
          const depthStr =
            row.max_depth > MAX_DEPTH_WARNING
              ? chalk.red.bold(String(row.max_depth).padStart(6))
              : chalk.dim(String(row.max_depth).padStart(6));
          const agentsStr = chalk.blue(
            row.agent_names.slice(0, 3).join(", ") +
              (row.agent_names.length > 3
                ? ` +${row.agent_names.length - 3}`
                : ""),
          );
          console.log(
            [
              `  ${chalk.white(refTrunc)}`,
              chalk.bold(String(row.total_issues).padStart(7)),
              chalk.dim(String(row.total_tasks).padStart(6)),
              chalk.green(String(row.total_prs).padStart(5)),
              depthStr,
              fmtTokens(row.total_tokens).padStart(10),
              fmtCost(row.estimated_cost_usd).padStart(10),
              agentsStr,
            ].join("  "),
          );
          if (row.depth_warning) {
            console.log(
              chalk.red(
                `    ⚠ cascade depth ${row.max_depth} — review for runaway follow-ups`,
              ),
            );
          }
        }
        console.log();
        store.close();
      },
    );
}
