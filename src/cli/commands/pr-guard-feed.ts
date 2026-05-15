/**
 * `orch pr-guard-feed` — Chronological feed of suppressed already-in-review
 * dispatch blocks (issue #1618).
 *
 * After #1604 stopped creating synthetic "Already in review — PR #N" tasks,
 * the audit trail moved to `dispatch_blocks`. This command gives operators the
 * per-PR timeline view that was previously visible in the task log:
 *
 *   orch pr-guard-feed                       # last 2 hours
 *   orch pr-guard-feed --window-hours 1      # narrower window
 *   orch pr-guard-feed --repo rapartlu/agent-orchestrator
 *   orch pr-guard-feed --pr 1592             # only blocks by PR #1592
 *   orch pr-guard-feed --json
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type DispatchBlock } from "../../state/store.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse source_ref into its repo and issue-number components.
 *
 * "rapartlu/agent-orchestrator#1531" → { repo: "rapartlu/agent-orchestrator", issue: "1531" }
 * Returns null if the format is unexpected.
 */
function parseSourceRef(ref: string): { repo: string; issue: string } | null {
  const idx = ref.lastIndexOf("#");
  if (idx <= 0 || idx >= ref.length - 1) return null;
  return { repo: ref.slice(0, idx), issue: ref.slice(idx + 1) };
}

/** Format an ISO timestamp to "HH:MM:SS" in local time. */
function formatTime(iso: string): string {
  try {
    return new Date(iso).toTimeString().slice(0, 8);
  } catch {
    return iso.slice(11, 19) || iso;
  }
}

/**
 * Find the blocking PR with the most hits in the given rows.
 * Returns null when no rows have a blocking_pr_number set.
 */
function topBlocker(
  rows: DispatchBlock[],
): { repo: string; prNumber: number; hits: number } | null {
  const counts = new Map<string, { repo: string; prNumber: number; hits: number }>();
  for (const row of rows) {
    if (row.blocking_pr_number == null) continue;
    const parsed = parseSourceRef(row.source_ref);
    if (!parsed) continue;
    const key = `${parsed.repo}#${row.blocking_pr_number}`;
    const entry = counts.get(key);
    if (entry) {
      entry.hits++;
    } else {
      counts.set(key, { repo: parsed.repo, prNumber: row.blocking_pr_number, hits: 1 });
    }
  }
  if (counts.size === 0) return null;
  return [...counts.values()].sort((a, b) => b.hits - a.hits)[0];
}

// ── command registration ──────────────────────────────────────────────────────

export function registerPRGuardFeedCommand(program: Command): void {
  program
    .command("pr-guard-feed")
    .description(
      "Chronological feed of suppressed already-in-review dispatch blocks (#1618). " +
      "Answers: which issues were blocked by PR #N in the last N hours?"
    )
    .option(
      "--window-hours <h>",
      "Look-back window in hours (default: 2)",
      "2",
    )
    .option(
      "--repo <repo>",
      "Filter by repository (e.g. rapartlu/agent-orchestrator)",
    )
    .option(
      "--pr <num>",
      "Filter by blocking PR number",
    )
    .option("--json", "Output raw JSON instead of formatted table")
    .action((opts: {
      windowHours?: string;
      repo?: string;
      pr?: string;
      json?: boolean;
    }) => {
      const windowHours = Math.max(0.1, parseFloat(opts.windowHours ?? "2"));
      const prNumber = opts.pr != null ? parseInt(opts.pr, 10) : undefined;

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

      let rows: DispatchBlock[];
      try {
        rows = store.listPRGuardBlocks({
          windowHours,
          repo: opts.repo,
          prNumber,
        });
      } finally {
        store.close();
      }

      // ── JSON mode ────────────────────────────────────────────────────────────

      if (opts.json) {
        const top = topBlocker(rows);
        console.log(
          JSON.stringify(
            {
              window_hours: windowHours,
              repo_filter: opts.repo ?? null,
              pr_filter: prNumber ?? null,
              total: rows.length,
              top_blocker: top
                ? { repo: top.repo, pr: top.prNumber, hits: top.hits }
                : null,
              rows: rows.map((r) => {
                const parsed = parseSourceRef(r.source_ref);
                return {
                  id: r.id,
                  timestamp: r.timestamp,
                  repo: parsed?.repo ?? r.source_ref,
                  issue: parsed?.issue ? `#${parsed.issue}` : r.source_ref,
                  blocking_pr: r.blocking_pr_number != null
                    ? `#${r.blocking_pr_number}`
                    : null,
                  agent: r.agent_name,
                  block_code: r.block_code,
                };
              }),
            },
            null,
            2,
          ),
        );
        return;
      }

      // ── Table mode ───────────────────────────────────────────────────────────

      const windowLabel =
        windowHours === 1
          ? "1 hour"
          : Number.isInteger(windowHours)
          ? `${windowHours} hours`
          : `${windowHours.toFixed(1)} hours`;

      const filterParts: string[] = [];
      if (opts.repo) filterParts.push(`repo=${opts.repo}`);
      if (prNumber != null) filterParts.push(`pr=#${prNumber}`);
      const filterLabel = filterParts.length ? ` [${filterParts.join(", ")}]` : "";

      console.log(
        chalk.bold(
          `\n◆ Suppressed already-in-review dispatches — last ${windowLabel}${filterLabel}\n`,
        ),
      );

      if (rows.length === 0) {
        console.log(chalk.dim("  No PR-guard suppression events in this window.\n"));
        return;
      }

      // Fixed column widths (plain-text, then chalk applied separately)
      const W_TIME  = 10;
      const W_REPO  = 34;
      const W_ISSUE = 8;
      const W_PR    = 14;

      const header =
        "Time".padEnd(W_TIME) +
        "Repo".padEnd(W_REPO) +
        "Issue".padEnd(W_ISSUE) +
        "Blocking PR".padEnd(W_PR) +
        "Agent";
      const sep = "─".repeat(header.length);

      console.log(chalk.dim("  " + header));
      console.log(chalk.dim("  " + sep));

      for (const row of rows) {
        const parsed = parseSourceRef(row.source_ref);

        const time   = formatTime(row.timestamp).padEnd(W_TIME);
        const repo   = (parsed?.repo ?? row.source_ref).slice(0, W_REPO - 1).padEnd(W_REPO);
        const issue  = (parsed?.issue ? `#${parsed.issue}` : row.source_ref).padEnd(W_ISSUE);
        const pr     = row.blocking_pr_number != null
          ? `→  #${row.blocking_pr_number}`.padEnd(W_PR)
          : "→  (none)".padEnd(W_PR);
        const agent  = row.agent_name ?? "—";

        console.log(
          "  " +
          chalk.dim(time) +
          repo +
          chalk.cyan(issue) +
          (row.blocking_pr_number != null ? chalk.yellow(pr) : chalk.dim(pr)) +
          chalk.dim(agent),
        );
      }

      console.log(chalk.dim("  " + sep));

      // Summary line
      const top = topBlocker(rows);
      const topLabel = top
        ? `  ${chalk.yellow(`Top blocker: ${top.repo}#${top.prNumber} (${top.hits} hit${top.hits !== 1 ? "s" : ""})`)}.`
        : "";
      console.log(
        `\n  ${chalk.bold(String(rows.length))} suppressed in window.${topLabel}\n`,
      );

      console.log(
        chalk.dim(
          `  Run \`orch pr-guard-feed --window-hours 24\` for a longer view.\n` +
          `  Run \`orch pr-guard-feed --pr <N>\` to filter by a specific blocking PR.\n` +
          `  Run \`orch pr-guard-feed --json\` for machine-readable output.\n`,
        ),
      );
    });
}
