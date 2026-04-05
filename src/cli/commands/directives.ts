import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

export function registerDirectivesCommand(program: Command): void {
  const directives = program
    .command("directives")
    .description(
      "Manage persistent behavioral directives injected into every agent dispatch",
    );

  // ── list ───────────────────────────────────────────────────────────────────
  directives
    .command("list")
    .description("List all stored behavioral directives")
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
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
        items = store.listDirectives();
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      console.log(chalk.bold("\n● Persistent Behavioral Directives\n"));

      if (items.length === 0) {
        console.log(
          chalk.dim(
            '  No directives stored. Use `orch directives add "<text>"` to add one.',
          ),
        );
        console.log();
        return;
      }

      for (const d of items) {
        const date = new Date(d.created_at).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
        console.log(
          `  ${chalk.dim(`#${d.id}`)}  ${d.text}  ${chalk.dim(`(added ${date})`)}`,
        );
      }
      console.log();
      console.log(
        chalk.dim(`  ${items.length} directive${items.length === 1 ? "" : "s"} active — injected into every agent dispatch.`),
      );
      console.log();
    });

  // ── add ────────────────────────────────────────────────────────────────────
  directives
    .command("add <text>")
    .description(
      'Store a new behavioral directive (e.g. "always use plain text, no markdown")',
    )
    .action((text: string) => {
      if (!text || !text.trim()) {
        console.error(chalk.red("Error: directive text cannot be empty."));
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

      let directive;
      try {
        directive = store.addDirective(text);
      } finally {
        store.close();
      }

      console.log(
        chalk.green(`✓ Directive #${directive.id} stored:`),
        directive.text,
      );
      console.log(
        chalk.dim(
          "  This will be injected into every future agent dispatch.",
        ),
      );
    });

  // ── remove ─────────────────────────────────────────────────────────────────
  directives
    .command("remove <id>")
    .description("Remove a stored directive by its ID")
    .action((idStr: string) => {
      const id = parseInt(idStr, 10);
      if (isNaN(id) || id <= 0) {
        console.error(
          chalk.red("Error: id must be a positive integer. Run `orch directives list` to see IDs."),
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
        store.removeDirective(id);
      } finally {
        store.close();
      }

      console.log(chalk.green(`✓ Directive #${id} removed.`));
    });
}
