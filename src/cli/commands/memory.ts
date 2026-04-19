import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

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
}
