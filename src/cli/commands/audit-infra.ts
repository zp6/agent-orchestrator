/**
 * Infrastructure activation audit — detect modules that are built but
 * never wired into the daemon or CLI.
 *
 * Scans src/ for exported functions/classes and checks if they're imported
 * anywhere else. Reports "dead code" that was implemented but never activated.
 *
 * Usage: orch audit-infra
 */
import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

interface UnwiredExport {
  file: string;
  exportName: string;
  type: "function" | "class" | "const";
}

export function registerAuditInfraCommand(program: Command): void {
  program
    .command("audit-infra")
    .description("Detect built-but-unwired features (exported but never imported)")
    .option("--fix", "File GitHub issues for unwired features")
    .action((opts: { fix?: boolean }) => {
      const srcDir = resolve(process.cwd(), "src");
      const unwired = findUnwiredExports(srcDir);

      if (unwired.length === 0) {
        console.log(chalk.green("✓ All exported functions/classes are imported somewhere."));
        return;
      }

      console.log(chalk.yellow(`⚠ ${unwired.length} exported symbol(s) not imported anywhere:\n`));

      // Group by file
      const byFile = new Map<string, UnwiredExport[]>();
      for (const u of unwired) {
        const list = byFile.get(u.file) ?? [];
        list.push(u);
        byFile.set(u.file, list);
      }

      for (const [file, exports] of byFile) {
        const shortFile = file.replace(srcDir + "/", "");
        console.log(chalk.cyan(`  ${shortFile}`));
        for (const e of exports) {
          console.log(`    ${chalk.dim(e.type)} ${e.exportName}`);
        }
      }

      if (opts.fix) {
        console.log(chalk.dim("\n--fix: filing issues for unwired features is not yet implemented."));
      }
    });
}

function findUnwiredExports(srcDir: string): UnwiredExport[] {
  const unwired: UnwiredExport[] = [];

  // Find all exported symbols
  let exportLines: string;
  try {
    exportLines = execSync(
      `grep -rn "^export \\(function\\|class\\|const\\|async function\\)" "${srcDir}" --include="*.ts" | grep -v ".test.ts" | grep -v "node_modules" | grep -v ".d.ts"`,
      { encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    return [];
  }

  for (const line of exportLines.trim().split("\n")) {
    if (!line) continue;

    const match = line.match(/^(.+?):(\d+):export (?:async )?(function|class|const) (\w+)/);
    if (!match) continue;

    const [, file, , type, name] = match;

    // Skip test helpers, type exports, and internal module-level constants
    if (name.startsWith("_")) continue;
    if (name === "default") continue;
    if (type === "const" && name === name.toUpperCase()) continue; // CONSTANTS are often config, not features

    // Check if this symbol is imported anywhere else
    try {
      const importCount = execSync(
        `grep -rn "import.*${name}" "${srcDir}" --include="*.ts" | grep -v "${file}" | grep -v ".test.ts" | grep -v "node_modules" | wc -l`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();

      // Also check for direct usage (non-import references in other files)
      const usageCount = execSync(
        `grep -rn "\\b${name}\\b" "${srcDir}" --include="*.ts" | grep -v "${file}" | grep -v ".test.ts" | grep -v "node_modules" | wc -l`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();

      if (parseInt(importCount, 10) === 0 && parseInt(usageCount, 10) === 0) {
        unwired.push({
          file,
          exportName: name,
          type: type as UnwiredExport["type"],
        });
      }
    } catch {
      continue;
    }
  }

  return unwired;
}
