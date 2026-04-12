import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import { seedDefaultPatterns } from "../../orchestrator/learned-patterns.js";

export function registerLearnedPatternsCommand(program: Command): void {
  const cmd = program
    .command("learned-patterns")
    .description(
      "Manage the immune-system anti-pattern registry (learned_patterns table)",
    );

  // ── list ───────────────────────────────────────────────────────────────────
  cmd
    .command("list")
    .description("List all learned patterns")
    .option("--repo <repo>", "Filter to patterns relevant to this repo")
    .option("--active-only", "Show only active patterns (default: all)")
    .option("--json", "Output raw JSON")
    .action(
      (opts: { repo?: string; activeOnly?: boolean; json?: boolean }) => {
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

        let items;
        try {
          items = opts.repo
            ? store.getLearnedPatterns(opts.repo, 100)
            : store.listAllLearnedPatterns(100);

          if (opts.activeOnly) {
            items = items.filter((p) => p.active === 1);
          }
        } finally {
          store.close();
        }

        if (opts.json) {
          console.log(JSON.stringify(items, null, 2));
          return;
        }

        console.log(chalk.bold("\n🛡  Learned Patterns — Immune System\n"));

        if (items.length === 0) {
          console.log(
            chalk.dim(
              "  No patterns found. Run `orch learned-patterns seed` to seed defaults.",
            ),
          );
          console.log();
          return;
        }

        for (const p of items) {
          const conf = Math.round(p.confidence * 100);
          const confColor =
            conf >= 80 ? chalk.green : conf >= 50 ? chalk.yellow : chalk.red;
          const status = p.active === 1 ? chalk.green("active") : chalk.dim("retired");
          const saveRate =
            p.hit_count > 0
              ? `${Math.round((p.first_pass_saves / p.hit_count) * 100)}%`
              : "n/a";

          console.log(
            `  ${chalk.dim(`#${p.id}`)} ${status} ${confColor(`${conf}%`)} ${chalk.bold(p.title)}`,
          );
          console.log(
            `       ${chalk.dim(`[${p.pattern_type}]`)} hits: ${p.hit_count}  saves: ${p.first_pass_saves}  save-rate: ${saveRate}  source: ${p.source}`,
          );
          console.log(`       ${chalk.dim(p.description.slice(0, 100))}${p.description.length > 100 ? "…" : ""}`);
          console.log();
        }
      },
    );

  // ── seed ───────────────────────────────────────────────────────────────────
  cmd
    .command("seed")
    .description("Seed the 3 default anti-patterns from issue #693")
    .action(() => {
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

      let inserted: number;
      try {
        inserted = seedDefaultPatterns(store);
      } finally {
        store.close();
      }

      if (inserted === 0) {
        console.log(chalk.dim("All default patterns already seeded (no changes)."));
      } else {
        console.log(chalk.green(`✓ Seeded ${inserted} default pattern(s).`));
      }
    });

  // ── stats ──────────────────────────────────────────────────────────────────
  cmd
    .command("stats")
    .description("Show immune-system effectiveness metrics")
    .action(() => {
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

      let items;
      try {
        items = store.listAllLearnedPatterns(100);
      } finally {
        store.close();
      }

      const active = items.filter((p) => p.active === 1);
      const totalHits = items.reduce((s, p) => s + p.hit_count, 0);
      const totalSaves = items.reduce((s, p) => s + p.first_pass_saves, 0);
      const overallSaveRate =
        totalHits > 0 ? `${Math.round((totalSaves / totalHits) * 100)}%` : "n/a";

      console.log(chalk.bold("\n🛡  Immune System — Effectiveness Metrics\n"));
      console.log(
        `  Total patterns : ${items.length}  (${active.length} active, ${items.length - active.length} retired)`,
      );
      console.log(`  Total injections : ${totalHits}`);
      console.log(`  First-pass saves : ${totalSaves}`);
      console.log(`  Overall save rate : ${overallSaveRate}`);
      console.log();

      if (active.length > 0) {
        console.log(chalk.dim("  Per-pattern breakdown:\n"));
        for (const p of active) {
          const saveRate =
            p.hit_count > 0
              ? `${Math.round((p.first_pass_saves / p.hit_count) * 100)}%`
              : "n/a";
          console.log(
            `  #${p.id}  ${chalk.bold(p.title)}`,
          );
          console.log(
            `       hits: ${p.hit_count}  saves: ${p.first_pass_saves}  save-rate: ${saveRate}  conf: ${Math.round(p.confidence * 100)}%`,
          );
        }
        console.log();
      }
    });

  // ── retire ─────────────────────────────────────────────────────────────────
  cmd
    .command("retire <id>")
    .description("Retire a pattern by ID (soft-delete — stops injection)")
    .action((id: string) => {
      const numId = parseInt(id, 10);
      if (isNaN(numId)) {
        console.error(chalk.red("Invalid ID — must be a number"));
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
        const pattern = store.getLearnedPattern(numId);
        if (!pattern) {
          console.error(chalk.red(`Pattern #${numId} not found`));
          process.exit(1);
        }
        store.retireLearnedPattern(numId);
        console.log(chalk.yellow(`⚠  Pattern #${numId} retired: "${pattern.title}"`));
      } finally {
        store.close();
      }
    });
}
