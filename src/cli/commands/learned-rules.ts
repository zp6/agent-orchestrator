import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

export function registerLearnedRulesCommand(program: Command): void {
  const rules = program
    .command("learned-rules")
    .description(
      "Manage per-repo conventions learned from PR review feedback",
    );

  // ── list ───────────────────────────────────────────────────────────────────
  rules
    .command("list")
    .description("List learned rules, optionally filtered by repo")
    .option("--repo <repo>", "Filter by repo (e.g. rapartlu/agent-orchestrator)")
    .option("--limit <n>", "Max rules to show", "50")
    .option("--json", "Output raw JSON")
    .action((opts: { repo?: string; limit?: string; json?: boolean }) => {
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
        const limit = parseInt(opts.limit ?? "50", 10);
        items = opts.repo
          ? store.getLearnedRulesForRepo(opts.repo, limit)
          : store.listLearnedRules(limit);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      console.log(chalk.bold("\n● Learned Repo Conventions\n"));

      if (items.length === 0) {
        console.log(
          chalk.dim(
            "  No learned rules found. Rules are automatically extracted from PR review feedback.",
          ),
        );
        console.log();
        return;
      }

      // Group by repo
      const byRepo = new Map<string, typeof items>();
      for (const rule of items) {
        const group = byRepo.get(rule.repo) ?? [];
        group.push(rule);
        byRepo.set(rule.repo, group);
      }

      for (const [repo, repoRules] of byRepo) {
        console.log(chalk.cyan(`  ${repo}`));
        for (const r of repoRules) {
          const conf = Math.round(r.confidence * 100);
          const confColor = conf >= 70 ? chalk.green : conf >= 40 ? chalk.yellow : chalk.red;
          const stats = chalk.dim(
            `applied: ${r.applied_count}, success: ${r.success_count}, fail: ${r.failure_count}`,
          );
          console.log(
            `    ${chalk.dim(`#${r.id}`)} ${confColor(`${conf}%`)} ${r.rule}`,
          );
          console.log(
            `         ${chalk.dim(`[${r.category}]`)} ${stats} ${chalk.dim(`from ${r.source}`)}`,
          );
        }
        console.log();
      }

      console.log(
        chalk.dim(
          `  ${items.length} rule${items.length === 1 ? "" : "s"} — injected into dispatches for matching repos.`,
        ),
      );
      console.log();
    });

  // ── add ────────────────────────────────────────────────────────────────────
  rules
    .command("add <repo> <text>")
    .description(
      'Manually add a learned rule for a repo (e.g. "rapartlu/agent-orchestrator" "Always add migrations")',
    )
    .option("--category <cat>", "Rule category (style|architecture|testing|security|convention|workflow)", "convention")
    .option("--confidence <n>", "Initial confidence 0-1", "0.9")
    .action((repo: string, text: string, opts: { category?: string; confidence?: string }) => {
      if (!text || !text.trim()) {
        console.error(chalk.red("Error: rule text cannot be empty."));
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

      let rule;
      try {
        rule = store.addLearnedRule({
          repo,
          rule: text,
          category: opts.category as "convention" ?? "convention",
          source: "manual",
          confidence: parseFloat(opts.confidence ?? "0.9"),
        });
      } finally {
        store.close();
      }

      console.log(
        chalk.green(`✓ Rule #${rule.id} stored for ${repo}:`),
        rule.rule,
      );
      console.log(
        chalk.dim(
          `  Confidence: ${Math.round(rule.confidence * 100)}% | Category: ${rule.category}`,
        ),
      );
    });

  // ── remove ─────────────────────────────────────────────────────────────────
  rules
    .command("remove <id>")
    .description("Remove a learned rule by its ID")
    .action((idStr: string) => {
      const id = parseInt(idStr, 10);
      if (isNaN(id) || id <= 0) {
        console.error(
          chalk.red("Error: id must be a positive integer. Run `orch learned-rules list` to see IDs."),
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
        store.removeLearnedRule(id);
      } finally {
        store.close();
      }

      console.log(chalk.green(`✓ Rule #${id} removed.`));
    });

  // ── decay ──────────────────────────────────────────────────────────────────
  rules
    .command("decay")
    .description("Decay confidence of stale rules (not applied in 30+ days)")
    .option("--days <n>", "Staleness threshold in days", "30")
    .action((opts: { days?: string }) => {
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

      let decayed;
      try {
        decayed = store.decayStaleRules(parseInt(opts.days ?? "30", 10));
      } finally {
        store.close();
      }

      console.log(
        chalk.green(`✓ Decayed ${decayed} stale rule${decayed === 1 ? "" : "s"}.`),
      );
    });
}
