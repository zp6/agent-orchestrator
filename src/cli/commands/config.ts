import type { Command } from "commander";
import chalk from "chalk";
import {
  CONFIG_CATALOG,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  getCatalogByCategory,
  searchCatalog,
  type ConfigCategory,
  type ConfigEntry,
} from "../../config/catalog.js";
import { loadConfig } from "../../config/schema.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the current runtime value for a catalog entry from the loaded config.
 * Returns undefined when the key is a template (contains `<`) or not resolvable.
 */
function resolveCurrentValue(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  // Skip template keys like "agents.<name>.model"
  if (key.includes("<")) return undefined;

  const parts = key.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined) return undefined;
  if (current === null) return "null";
  if (Array.isArray(current)) return JSON.stringify(current);
  if (typeof current === "object") return JSON.stringify(current);
  return String(current);
}

function formatEntry(entry: ConfigEntry, currentValue?: string): string {
  const keyStr = chalk.cyan(entry.key);
  const typeStr = chalk.dim(`(${entry.type})`);
  const defaultStr = chalk.yellow(entry.default);
  const sourceTag =
    entry.source === "agents.yaml"
      ? chalk.green("yaml")
      : chalk.dim("code");

  const lines = [
    `  ${keyStr}  ${typeStr}`,
    `    ${entry.description}`,
    `    Default: ${defaultStr}  Source: ${sourceTag}`,
  ];
  if (currentValue !== undefined) {
    lines.push(`    Current: ${chalk.white.bold(currentValue)}`);
  }
  return lines.join("\n");
}

// ── Command ──────────────────────────────────────────────────────────────────

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Discover and inspect all system configuration parameters");

  // ── orch config list ───────────────────────────────────────────────────────
  configCmd
    .command("list")
    .description("List all tunable configuration parameters grouped by category")
    .option("-s, --source <source>", 'Filter by source: "yaml" or "code"')
    .option("-c, --category <cat>", "Filter by category name")
    .option("-q, --search <query>", "Search keys and descriptions")
    .option("--json", "Output as JSON")
    .option("--values", "Show current runtime values from agents.yaml")
    .action(
      (opts: {
        source?: string;
        category?: string;
        search?: string;
        json?: boolean;
        values?: boolean;
      }) => {
        let entries: ConfigEntry[] = [...CONFIG_CATALOG];

        // Apply filters
        if (opts.search) {
          entries = searchCatalog(opts.search);
        }
        if (opts.source) {
          const src = opts.source === "yaml" ? "agents.yaml" : "hardcoded";
          entries = entries.filter((e) => e.source === src);
        }
        if (opts.category) {
          const cat = opts.category.toLowerCase();
          entries = entries.filter((e) => e.category === cat);
        }

        if (entries.length === 0) {
          console.log(chalk.yellow("No matching configuration parameters found."));
          return;
        }

        // JSON output
        if (opts.json) {
          const output = entries.map((e) => ({
            key: e.key,
            type: e.type,
            default: e.default,
            source: e.source,
            category: e.category,
            description: e.description,
          }));
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        // Load config for --values
        let config: Record<string, unknown> | undefined;
        if (opts.values) {
          try {
            const parentOpts = program.opts() as { config?: string };
            config = loadConfig(parentOpts.config) as unknown as Record<string, unknown>;
          } catch {
            console.log(chalk.yellow("Warning: Could not load agents.yaml for current values.\n"));
          }
        }

        // Group by category and display
        const grouped = new Map<ConfigCategory, ConfigEntry[]>();
        for (const cat of CATEGORY_ORDER) {
          const catEntries = entries.filter((e) => e.category === cat);
          if (catEntries.length > 0) {
            grouped.set(cat, catEntries);
          }
        }

        let totalCount = 0;
        for (const [cat, catEntries] of grouped) {
          const label = CATEGORY_LABELS[cat] ?? cat;
          console.log(`\n${chalk.bold.underline(label)}`);
          for (const entry of catEntries) {
            const currentValue = config
              ? resolveCurrentValue(config, entry.key)
              : undefined;
            console.log(formatEntry(entry, currentValue));
            totalCount++;
          }
        }

        console.log(
          `\n${chalk.dim(`${totalCount} parameters across ${grouped.size} categories`)}`,
        );

        // Show filter hints
        if (!opts.source && !opts.category && !opts.search) {
          console.log(
            chalk.dim(
              '\nTip: Use --source yaml to see only configurable parameters, ' +
              'or --search <term> to filter.',
            ),
          );
        }
      },
    );

  // ── orch config search ─────────────────────────────────────────────────────
  configCmd
    .command("search <query>")
    .description("Search configuration parameters by keyword")
    .option("--json", "Output as JSON")
    .action((query: string, opts: { json?: boolean }) => {
      const results = searchCatalog(query);

      if (results.length === 0) {
        console.log(chalk.yellow(`No parameters matching "${query}".`));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      console.log(chalk.bold(`\nSearch results for "${query}" (${results.length} matches):\n`));
      for (const entry of results) {
        console.log(formatEntry(entry));
      }
    });

  // ── orch config categories ─────────────────────────────────────────────────
  configCmd
    .command("categories")
    .description("List all configuration categories with entry counts")
    .action(() => {
      const grouped = getCatalogByCategory();
      console.log(chalk.bold("\nConfiguration Categories:\n"));
      for (const [cat, entries] of grouped) {
        const label = CATEGORY_LABELS[cat] ?? cat;
        const yamlCount = entries.filter((e) => e.source === "agents.yaml").length;
        const codeCount = entries.filter((e) => e.source === "hardcoded").length;
        const parts = [];
        if (yamlCount > 0) parts.push(chalk.green(`${yamlCount} yaml`));
        if (codeCount > 0) parts.push(chalk.dim(`${codeCount} code`));
        console.log(
          `  ${chalk.cyan(cat.padEnd(18))} ${label.padEnd(36)} ${parts.join(", ")}  (${entries.length} total)`,
        );
      }
      console.log(
        `\n${chalk.dim(`${CONFIG_CATALOG.length} parameters total`)}`,
      );
    });
}
