import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type SecurityFpExemption } from "../../state/store.js";

function openStore(): StateStore {
  try {
    return new StateStore();
  } catch (err) {
    console.error(
      chalk.red("Could not open state database:"),
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function cell(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

export function renderSecurityExemptionsTable(rows: SecurityFpExemption[]): string {
  const widths = {
    id: 5,
    repo: 22,
    filePath: 30,
    pattern: 30,
    createdAt: 19,
  } as const;

  const header = [
    cell("ID", widths.id),
    cell("Repo", widths.repo),
    cell("File", widths.filePath),
    cell("Pattern", widths.pattern),
    cell("Created", widths.createdAt),
    "Reason",
  ].join("  ");

  const separator = "─".repeat(header.length);
  const lines = [header, separator];

  for (const row of rows) {
    lines.push(
      [
        cell(String(row.id), widths.id),
        cell(row.repo, widths.repo),
        cell(row.file_path, widths.filePath),
        cell(row.pattern_name, widths.pattern),
        cell(row.created_at.slice(0, 19).replace("T", " "), widths.createdAt),
        row.reason,
      ].join("  "),
    );
  }

  return lines.join("\n");
}

function renderEmptyMessage(repo?: string): string {
  return repo
    ? `No security FP exemptions found for ${repo}.`
    : "No security FP exemptions found.";
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid exemption ID: ${value}`);
  }
  return id;
}

export function registerSecurityExemptionsCommand(program: Command): void {
  const security = program
    .command("security-exemptions")
    .description("Inspect and manage security false-positive exemptions");

  security
    .command("list")
    .description("List all security false-positive exemptions")
    .option("--repo <repo>", "Filter by repo")
    .option("--json", "Emit JSON instead of a table")
    .action((opts: { repo?: string; json?: boolean }) => {
      const store = openStore();
      try {
        const rows = store.listSecurityFpExemptions(opts.repo);
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        console.log(chalk.bold("\n● Security FP Exemptions\n"));
        if (rows.length === 0) {
          console.log(chalk.dim(`  ${renderEmptyMessage(opts.repo)}`));
          console.log();
          return;
        }
        console.log(renderSecurityExemptionsTable(rows));
        console.log();
      } finally {
        store.close();
      }
    });

  security
    .command("add <repo> <file_path> <pattern_name> <reason...>")
    .description("Register a new security false-positive exemption")
    .action((repo: string, filePath: string, patternName: string, reasonParts: string[]) => {
      const reason = reasonParts.join(" ").trim();
      if (!reason) {
        console.error(chalk.red("Error: reason must not be empty."));
        process.exit(1);
      }

      const store = openStore();
      try {
        const row = store.addSecurityFpExemption({
          repo,
          file_path: filePath,
          pattern_name: patternName,
          reason,
        });
        console.log(chalk.green(`✓ added exemption #${row.id}`));
        console.log(`  ${chalk.bold(row.repo)} / ${row.file_path}`);
        console.log(`  pattern: ${row.pattern_name}`);
        console.log(`  reason: ${row.reason}`);
      } finally {
        store.close();
      }
    });

  security
    .command("remove")
    .description("Remove a security false-positive exemption")
    .option("--id <id>", "Remove by row ID")
    .argument("[repo]", "Repo for triple removal")
    .argument("[file_path]", "File path for triple removal")
    .argument("[pattern_name]", "Pattern name for triple removal")
    .action((repo: string | undefined, filePath: string | undefined, patternName: string | undefined, opts: { id?: string }) => {
      const store = openStore();
      try {
        if (opts.id) {
          const id = parseId(opts.id);
          const removed = store.removeSecurityFpExemptionById(id);
          if (!removed) {
            console.error(chalk.red(`No exemption found with id ${id}.`));
            process.exit(1);
          }
          console.log(chalk.green(`✓ removed exemption #${id}`));
          return;
        }

        if (!repo || !filePath || !patternName) {
          console.error(chalk.red("Error: remove requires either --id <id> or <repo> <file_path> <pattern_name>."));
          process.exit(1);
        }

        const removed = store.removeSecurityFpExemption(repo, filePath, patternName);
        if (!removed) {
          console.error(chalk.red(`No exemption found for ${repo} / ${filePath} / ${patternName}.`));
          process.exit(1);
        }

        console.log(chalk.green(`✓ removed exemption for ${repo} / ${filePath} / ${patternName}`));
      } finally {
        store.close();
      }
    });
}
