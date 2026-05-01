/**
 * `orch publish-standup` — Stage standup content for Substack (issue #1303)
 *
 * Scans docs/standups/ for files marked PUBLISHABLE (containing the line
 * "**Status:** PUBLISHABLE") and stages them for publication to the
 * "Inside the Fleet" Substack newsletter.
 *
 * In dry-run mode (default), lists candidate files and their metadata.
 * In publish mode (--publish), marks them as PUBLISHED by updating the
 * status line and writing a publish record to docs/standups/publish-log.md.
 *
 * Operator uploads the staged content to Substack manually (or via the
 * Substack API once the account is set up). This command prepares the
 * content pipeline so the operator sees exactly what to post.
 */

import type { Command } from "commander";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import chalk from "chalk";

// ── Constants ─────────────────────────────────────────────────────────────────

const PUBLISHABLE_MARKER = "**Status:** PUBLISHABLE";
const PUBLISHED_MARKER = "**Status:** PUBLISHED";
const STANDUPS_DIR = "docs/standups";
const PUBLISH_LOG = "docs/standups/publish-log.md";

// ── Types ─────────────────────────────────────────────────────────────────────

interface StandupFile {
  path: string;
  name: string;
  title: string | null;
  audience: string | null;
  date: string | null;
  published: boolean;
  publishable: boolean;
  sizeChars: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractMeta(content: string, field: string): string | null {
  const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`);
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function extractTitle(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function scanStandups(dir: string): StandupFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files: StandupFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md") || name === "publish-log.md") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (!stat.isFile()) continue;

    const content = readFileSync(path, "utf-8");
    files.push({
      path,
      name,
      title: extractTitle(content),
      audience: extractMeta(content, "Audience"),
      date: extractMeta(content, "Date"),
      published: content.includes(PUBLISHED_MARKER),
      publishable: content.includes(PUBLISHABLE_MARKER),
      sizeChars: content.length,
    });
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function formatFileRow(f: StandupFile): string {
  const status = f.published
    ? chalk.green("✓ published")
    : f.publishable
    ? chalk.yellow("⚡ ready")
    : chalk.dim("– not ready");

  const size = `${Math.round(f.sizeChars / 1000)}k chars`;
  const title = f.title ? chalk.white(f.title.slice(0, 60)) : chalk.dim("(no title)");
  const date = f.date ? chalk.dim(f.date) : chalk.dim(f.name.slice(0, 10));

  return `  ${status.padEnd(20)}  ${date.padEnd(14)}  ${size.padEnd(10)}  ${title}`;
}

function markPublished(filePath: string): void {
  const content = readFileSync(filePath, "utf-8");
  const updated = content.replace(PUBLISHABLE_MARKER, PUBLISHED_MARKER);
  writeFileSync(filePath, updated, "utf-8");
}

function appendPublishLog(files: StandupFile[]): void {
  const now = new Date().toISOString();
  const entries = files
    .map((f) => `| ${now} | ${f.name} | ${f.title ?? "(no title)"} | ${f.audience ?? "—"} |`)
    .join("\n");

  let existing = "";
  try {
    existing = readFileSync(PUBLISH_LOG, "utf-8");
  } catch {
    existing =
      "# Standup Publish Log — Inside the Fleet\n\n" +
      "| Published at | File | Title | Audience |\n" +
      "|---|---|---|---|\n";
  }

  writeFileSync(PUBLISH_LOG, existing + entries + "\n", "utf-8");
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerPublishStandupCommand(program: Command): void {
  program
    .command("publish-standup")
    .description(
      "Stage PUBLISHABLE standup files for the Inside the Fleet Substack (issue #1303)"
    )
    .option("--publish", "Mark PUBLISHABLE files as PUBLISHED and log them (default: dry-run)")
    .option("--all", "Show all standup files, not just publishable ones")
    .option("--json", "Output raw JSON")
    .action((opts: { publish?: boolean; all?: boolean; json?: boolean }) => {
      const files = scanStandups(STANDUPS_DIR);
      const publishable = files.filter((f) => f.publishable && !f.published);
      const displayed = opts.all ? files : files.filter((f) => f.publishable || f.published);

      if (opts.json) {
        console.log(JSON.stringify({ files: displayed, publishable_count: publishable.length }, null, 2));
        return;
      }

      console.log(chalk.bold("\n◆ Inside the Fleet — Substack Content Pipeline\n"));
      console.log(chalk.dim(`  Scanning: ${STANDUPS_DIR}/\n`));

      if (displayed.length === 0) {
        console.log(chalk.dim("  No standup files found. Add .md files to docs/standups/ with:\n"));
        console.log(chalk.dim(`    **Status:** PUBLISHABLE\n`));
        return;
      }

      const header = [
        "Status              ",
        "Date          ",
        "Size      ",
        "Title",
      ].join("  ");
      const sep = "─".repeat(80);

      console.log(chalk.dim("  " + header));
      console.log(chalk.dim("  " + sep));

      for (const f of displayed) {
        console.log(formatFileRow(f));
      }

      console.log(chalk.dim("  " + sep));
      console.log();

      if (publishable.length === 0) {
        if (files.some((f) => f.published)) {
          console.log(chalk.green("  ✓  All publishable content has already been published.\n"));
        } else {
          console.log(
            chalk.dim(
              "  No files marked PUBLISHABLE. Add this to a standup .md file:\n" +
              "    **Status:** PUBLISHABLE\n"
            )
          );
        }
        return;
      }

      // ── Publish mode ────────────────────────────────────────────────────────
      if (opts.publish) {
        console.log(chalk.bold(`  Publishing ${publishable.length} file(s):\n`));
        for (const f of publishable) {
          markPublished(f.path);
          console.log(chalk.green(`  ✓  ${f.name}`));
          console.log(chalk.dim(`     Title: ${f.title ?? "(no title)"}`));
          console.log(chalk.dim(`     Audience: ${f.audience ?? "—"}`));
          console.log(chalk.dim(`     Size: ~${Math.round(f.sizeChars / 1000)}k chars`));
          console.log();
        }

        appendPublishLog(publishable);
        console.log(chalk.green(`  Logged to ${PUBLISH_LOG}\n`));
        console.log(
          chalk.bold("  ── Next steps (operator) ──────────────────────────────────────────────\n") +
          chalk.dim("  1. Open Substack: https://substack.com/dashboard\n") +
          chalk.dim("  2. Create new post — paste content from the files listed above\n") +
          chalk.dim("  3. Add header: 'Written and published by autonomous AI fleet (Nexus)'\n") +
          chalk.dim("  4. Publish free tier immediately; set paid content as member-only\n") +
          chalk.dim("  5. Share link in #dev-community, HN, Twitter/X, r/MachineLearning\n") +
          chalk.dim("  6. Record any revenue in docs/revenue-log.md\n")
        );
      } else {
        // ── Dry-run mode ─────────────────────────────────────────────────────
        console.log(
          chalk.yellow(
            `  ⚡ ${publishable.length} file(s) ready for publication (dry-run — no changes made).\n`
          )
        );
        console.log(
          chalk.dim(
            "  To mark as published and log them:\n" +
            "    orch publish-standup --publish\n\n" +
            "  To see all standup files:\n" +
            "    orch publish-standup --all\n"
          )
        );
      }
    });
}
