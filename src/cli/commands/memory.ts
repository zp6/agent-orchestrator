import type { Command } from "commander";
import chalk from "chalk";
import {
  StateStore,
  type SemanticMemoryCohortStats,
  type PerAgentSemanticMemoryStats,
} from "../../state/store.js";

/**
 * CLI command: `orch memory` — inspect and query the semantic task memory.
 *
 * Sub-commands:
 *   orch memory stats          Show index size and configuration
 *   orch memory query <text>   Find similar past tasks by keyword
 *   orch memory reindex        Force re-index of approved tasks
 */
export function registerMemoryCommand(program: Command): void {
  const mem = program
    .command("memory")
    .description("Semantic task memory: inspect, query, and manage the FTS5 knowledge store");

  // ── stats ──────────────────────────────────────────────────────────────────

  mem
    .command("stats")
    .description("Show semantic memory index statistics")
    .action(() => {
      const store = new StateStore();
      const size = store.getSemanticMemorySize();
      console.log(chalk.bold("Semantic Task Memory"));
      console.log(`  Indexed tasks: ${chalk.cyan(String(size))}`);
      console.log(`  Index type:    SQLite FTS5 (BM25 ranking)`);
      console.log(
        `  Tokenizer:     porter unicode61 (stemming + unicode normalization)`,
      );
    });

  // ── query ──────────────────────────────────────────────────────────────────

  mem
    .command("query <text...>")
    .description("Find semantically similar past tasks")
    .option("-k, --top-k <n>", "Number of results", "3")
    .option("--json", "Output raw JSON")
    .action(
      (
        textParts: string[],
        opts: { topK: string; json?: boolean },
      ) => {
        const store = new StateStore();
        const text = textParts.join(" ");
        const topK = Math.max(1, parseInt(opts.topK, 10) || 3);

        const matches = store.querySemanticMemory(text, topK);

        if (opts.json) {
          console.log(JSON.stringify(matches, null, 2));
          return;
        }

        if (matches.length === 0) {
          console.log(chalk.dim("No matching tasks found in semantic memory."));
          return;
        }

        console.log(
          chalk.bold(`Top ${matches.length} semantic matches for: `) +
            chalk.dim(`"${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`),
        );
        console.log();

        for (const [i, m] of matches.entries()) {
          const scoreColor =
            m.qualityScore >= 0.9
              ? chalk.green
              : m.qualityScore >= 0.8
                ? chalk.yellow
                : chalk.red;

          console.log(
            `  ${chalk.bold(`${i + 1}.`)} ${chalk.white(m.title)}`,
          );
          console.log(
            `     ID: ${chalk.dim(m.taskId)}  Score: ${scoreColor(m.qualityScore.toFixed(2))}` +
              (m.sourceRef
                ? `  Source: ${chalk.cyan(m.sourceRef)}`
                : ""),
          );
          if (m.reviewerNotes) {
            const notes =
              m.reviewerNotes.length > 120
                ? m.reviewerNotes.slice(0, 117) + "…"
                : m.reviewerNotes;
            console.log(`     Notes: ${chalk.dim(notes)}`);
          }
          console.log();
        }
      },
    );

  // ── reindex ────────────────────────────────────────────────────────────────

  mem
    .command("reindex")
    .description("Force re-index of approved tasks into semantic memory")
    .option(
      "--min-score <n>",
      "Minimum quality score threshold",
      "0.80",
    )
    .action((opts: { minScore: string }) => {
      const store = new StateStore();
      const minScore = parseFloat(opts.minScore) || 0.80;

      const before = store.getSemanticMemorySize();
      const indexed = store.indexApprovedTasksIntoMemory(minScore);
      const after = store.getSemanticMemorySize();

      if (indexed === 0) {
        console.log(
          chalk.dim(
            `No new tasks to index (${before} tasks already in memory).`,
          ),
        );
      } else {
        console.log(
          chalk.green(`Indexed ${indexed} new task(s) into semantic memory.`) +
            ` Total: ${chalk.cyan(String(after))}`,
        );
      }
    });

  // ── effectiveness ─────────────────────────────────────────────────────────

  mem
    .command("effectiveness")
    .description("Show semantic memory effectiveness: hit rate and first-pass verification comparison")
    .option("-d, --days <n>", "Rolling window in days", "30")
    .option("--json", "Output raw JSON")
    .action((opts: { days: string; json?: boolean }) => {
      const store = new StateStore();
      const days = Math.max(1, parseInt(opts.days, 10) || 30);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const result = store.getSemanticMemoryEffectiveness(since);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.bold(`\nSemantic Memory Effectiveness (${days}-day window)`));
      console.log(chalk.dim(`─`.repeat(55)));

      // Hit rate
      const hitPct = result.memory_hit_rate !== null
        ? `${(result.memory_hit_rate * 100).toFixed(1)}%`
        : "N/A";
      console.log(`  Dispatches:   ${chalk.cyan(String(result.total_dispatches))}`);
      console.log(`  Memory hits:  ${chalk.cyan(String(result.memory_hit_count))} (${hitPct})`);
      console.log();

      // Side-by-side comparison
      const formatCohort = (label: string, c: SemanticMemoryCohortStats): void => {
        console.log(chalk.bold(`  ${label}`));
        console.log(`    Tasks:             ${chalk.cyan(String(c.total_tasks))}`);
        const fpr = c.first_pass_rate !== null
          ? `${(c.first_pass_rate * 100).toFixed(1)}%`
          : "N/A";
        const fprColor = c.first_pass_rate !== null && c.first_pass_rate >= 0.8
          ? chalk.green : c.first_pass_rate !== null && c.first_pass_rate >= 0.6
            ? chalk.yellow : chalk.red;
        console.log(`    First-pass rate:   ${c.first_pass_rate !== null ? fprColor(fpr) : chalk.dim(fpr)}`);
        const qs = c.avg_quality_score !== null
          ? c.avg_quality_score.toFixed(3)
          : "N/A";
        console.log(`    Avg quality score: ${c.avg_quality_score !== null ? chalk.cyan(qs) : chalk.dim(qs)}`);
        const ar = c.avg_revision_count !== null
          ? c.avg_revision_count.toFixed(2)
          : "N/A";
        console.log(`    Avg revisions:     ${c.avg_revision_count !== null ? chalk.cyan(ar) : chalk.dim(ar)}`);
        console.log(`    Revision dist:     0=${c.revision_distribution.zero}  1=${c.revision_distribution.one}  2+=${c.revision_distribution.two_plus}`);
      };

      formatCohort("Memory-assisted tasks", result.matched);
      console.log();
      formatCohort("No-match tasks", result.unmatched);
      console.log();

      // Improvement delta
      if (result.improvement_delta !== null) {
        const deltaPct = `${(result.improvement_delta * 100).toFixed(1)}%`;
        const deltaColor = result.improvement_delta >= 0.15
          ? chalk.green
          : result.improvement_delta > 0
            ? chalk.yellow
            : chalk.red;
        console.log(`  ${chalk.bold("Improvement delta:")} ${deltaColor(deltaPct)}`);
        const target = result.meets_target ? chalk.green("✓ MET") : chalk.red("✗ NOT MET");
        console.log(`  ${chalk.bold("Target (≥15%):")}     ${target}`);
      } else {
        console.log(chalk.dim("  Insufficient data to compute improvement delta."));
      }

      // Weekly trend
      if (result.weekly.length > 0) {
        console.log();
        console.log(chalk.bold("  Weekly Trend"));
        console.log(chalk.dim(`  ${"Week".padEnd(12)} ${"Matched FPR".padEnd(14)} ${"Unmatched FPR".padEnd(14)} Delta`));
        for (const w of result.weekly) {
          const mFpr = w.matched.first_pass_rate !== null
            ? `${(w.matched.first_pass_rate * 100).toFixed(1)}%` : "—";
          const uFpr = w.unmatched.first_pass_rate !== null
            ? `${(w.unmatched.first_pass_rate * 100).toFixed(1)}%` : "—";
          const delta = w.matched.first_pass_rate !== null && w.unmatched.first_pass_rate !== null
            ? `${((w.matched.first_pass_rate - w.unmatched.first_pass_rate) * 100).toFixed(1)}%`
            : "—";
          console.log(`  ${w.week_start.padEnd(12)} ${mFpr.padEnd(14)} ${uFpr.padEnd(14)} ${delta}`);
        }
      }

      console.log();
    });

  // ── autotune ───────────────────────────────────────────────────────────────

  mem
    .command("autotune")
    .description("Show (or apply) the auto-tune recommendation for min_quality_score")
    .option("--apply", "Apply the recommended threshold adjustment")
    .option("--reset", "Clear the tuned threshold and revert to config default")
    .option("--json", "Output raw JSON")
    .action((opts: { apply?: boolean; reset?: boolean; json?: boolean }) => {
      const store = new StateStore();

      if (opts.reset) {
        store.setTunedMinQualityScore(null);
        console.log(chalk.green("Tuned threshold cleared. Will use config default on next dispatch."));
        return;
      }

      const tunedThreshold = store.getTunedMinQualityScore();
      // Use a sentinel default so we can show "from config" in output
      const CONFIG_DEFAULT = 0.80;
      const currentThreshold = tunedThreshold ?? CONFIG_DEFAULT;
      const rec = store.computeAutoTuneRecommendation(currentThreshold);

      if (opts.json) {
        console.log(JSON.stringify({ tuned_threshold: tunedThreshold, recommendation: rec }, null, 2));
        return;
      }

      console.log(chalk.bold("\nSemantic Memory Auto-tune"));
      console.log(chalk.dim("─".repeat(55)));
      console.log(
        `  Current threshold:     ${chalk.cyan(String(currentThreshold))}` +
        (tunedThreshold !== null ? chalk.dim(" (auto-tuned)") : chalk.dim(" (config default)")),
      );
      console.log();

      // Basis data
      const b = rec.basis;
      console.log(chalk.bold("  Effectiveness basis (30-day window)"));
      const hitPct = b.hit_rate !== null ? `${(b.hit_rate * 100).toFixed(1)}%` : "N/A";
      const deltaPct = b.improvement_delta !== null
        ? `${(b.improvement_delta * 100).toFixed(1)}%` : "N/A";
      console.log(`    Hit rate:          ${chalk.cyan(hitPct)}`);
      console.log(`    Improvement delta: ${chalk.cyan(deltaPct)}`);
      console.log(`    Matched tasks:     ${chalk.cyan(String(b.matched_tasks))}`);
      console.log(`    Unmatched tasks:   ${chalk.cyan(String(b.unmatched_tasks))}`);
      console.log();

      // Recommendation
      const actionColor = rec.action === "keep"
        ? chalk.green
        : rec.action === "lower"
          ? chalk.yellow
          : chalk.magenta;

      console.log(chalk.bold("  Recommendation"));
      console.log(`    Action:            ${actionColor(rec.action.toUpperCase())}`);
      console.log(`    New threshold:     ${chalk.cyan(String(rec.recommended_threshold))}`);
      console.log(`    Reason:            ${chalk.dim(rec.reason)}`);
      console.log();

      if (opts.apply) {
        const result = store.applyAutoTuneIfBeneficial(currentThreshold);
        if (result.action !== "keep") {
          console.log(
            chalk.green(
              `Applied: min_quality_score set to ${result.recommended_threshold}. ` +
              `Re-indexed semantic memory.`,
            ),
          );
        } else {
          console.log(chalk.dim("No change applied (current threshold is already optimal)."));
        }
      } else if (rec.action !== "keep") {
        console.log(
          chalk.dim(`Run with --apply to apply this recommendation.`),
        );
      }
    });

  // ── query-stats ────────────────────────────────────────────────────────────

  mem
    .command("query-stats")
    .description("Show FTS5 query quality statistics (zero-match rates, noisy patterns)")
    .option("-d, --days <n>", "Rolling window in days", "30")
    .option("--json", "Output raw JSON")
    .action((opts: { days: string; json?: boolean }) => {
      const store = new StateStore();
      const days = Math.max(1, parseInt(opts.days, 10) || 30);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const stats = store.getSemanticMemoryQueryStats(since);

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(chalk.bold(`\nSemantic Memory Query Quality (${days}-day window)`));
      console.log(chalk.dim("─".repeat(55)));
      console.log(`  Total queries:     ${chalk.cyan(String(stats.total_queries))}`);
      console.log(`  Zero-match queries:${chalk.cyan(` ${stats.zero_match_queries}`)}` +
        (stats.zero_match_rate !== null
          ? chalk.dim(` (${(stats.zero_match_rate * 100).toFixed(1)}%)`)
          : ""));
      const avgM = stats.avg_matches_returned !== null
        ? stats.avg_matches_returned.toFixed(2) : "N/A";
      console.log(`  Avg matches/query: ${chalk.cyan(avgM)}`);

      if (stats.top_empty_patterns.length > 0) {
        console.log();
        console.log(chalk.bold("  Top zero-match query patterns (improve stopwords or index)"));
        for (const p of stats.top_empty_patterns) {
          const sample = p.query_sample.length > 80
            ? p.query_sample.slice(0, 77) + "…" : p.query_sample;
          console.log(`    [${String(p.count).padStart(3)}x]  ${chalk.dim(sample)}`);
        }
      } else if (stats.total_queries > 0) {
        console.log(chalk.green("\n  All queries returned at least one match."));
      }

      console.log();
    });

  // ── per-agent ──────────────────────────────────────────────────────────────

  mem
    .command("per-agent")
    .description("Per-agent semantic memory effectiveness breakdown")
    .option("-d, --days <n>", "Rolling window in days", "30")
    .option("--json", "Output raw JSON")
    .action((opts: { days: string; json?: boolean }) => {
      const store = new StateStore();
      const days = Math.max(1, parseInt(opts.days, 10) || 30);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const agents = store.getPerAgentSemanticMemoryEffectiveness(since);

      if (opts.json) {
        console.log(JSON.stringify(agents, null, 2));
        return;
      }

      console.log(chalk.bold(`\nPer-Agent Semantic Memory Effectiveness (${days}-day window)`));
      console.log(chalk.dim("─".repeat(65)));

      if (agents.length === 0) {
        console.log(chalk.dim("  No agents with ≥5 tasks in this window."));
        console.log();
        return;
      }

      const formatRecommendation = (r: PerAgentSemanticMemoryStats["recommended_threshold_adjustment"]): string => {
        switch (r) {
          case "lower": return chalk.yellow("LOWER threshold");
          case "raise": return chalk.magenta("RAISE threshold");
          case "keep": return chalk.green("KEEP threshold");
          case "insufficient_data": return chalk.dim("insufficient data");
        }
      };

      for (const a of agents) {
        const hitPct = a.memory_hit_rate !== null
          ? `${(a.memory_hit_rate * 100).toFixed(1)}%` : "N/A";
        const deltaPct = a.improvement_delta !== null
          ? `${(a.improvement_delta * 100).toFixed(1)}%` : "N/A";
        const deltaColor = a.improvement_delta === null
          ? chalk.dim
          : a.improvement_delta >= 0.15
            ? chalk.green
            : a.improvement_delta > 0
              ? chalk.yellow
              : chalk.red;

        console.log(`  ${chalk.bold(a.agent_name)}`);
        console.log(`    Dispatches:     ${chalk.cyan(String(a.total_dispatches))}` +
          `  Memory hits: ${chalk.cyan(String(a.memory_hit_count))} (${hitPct})`);
        console.log(`    Improvement Δ:  ${deltaColor(deltaPct)}`);
        console.log(`    Recommendation: ${formatRecommendation(a.recommended_threshold_adjustment)}`);
        console.log();
      }
    });
}
