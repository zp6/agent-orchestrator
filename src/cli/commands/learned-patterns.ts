/**
 * `orch learned-patterns` — Immune System Pattern Browser (issue #698)
 *
 * Sub-commands:
 *   list      — browse all patterns with status badges (active/suppressed/promoted/retired)
 *   show <id> — full detail view of a single pattern (trigger conditions, stats, history)
 *   seed      — insert the three canonical seed patterns
 *   stats     — effectiveness metrics (save rate, hit counts)
 *   suppress <id>   — mark a pattern as false positive; stops injection, keeps history
 *   unsuppress <id> — re-enable a previously suppressed pattern
 *   promote <id>    — boost a pattern to top of injection list (critical patterns)
 *   demote <id>     — return a promoted pattern to normal priority
 *   retire <id>     — soft-delete a pattern (stops injection, archived forever)
 *   restore <id>    — reactivate a retired pattern
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type LearnedPattern } from "../../state/store.js";
import { seedDefaultPatterns } from "../../orchestrator/learned-patterns.js";

// ── Display helpers ───────────────────────────────────────────────────────────

/** Compute human-readable status badges for a pattern. */
function statusBadges(p: LearnedPattern): string {
  const badges: string[] = [];
  if (p.active === 0) {
    badges.push(chalk.dim("retired"));
  } else if (p.suppressed_at) {
    badges.push(chalk.yellow("suppressed"));
  } else {
    badges.push(chalk.green("active"));
  }
  if (p.promoted_at) {
    badges.push(chalk.cyan("promoted"));
  }
  return badges.join(" ");
}

/** Format a confidence percentage with colour. */
function colorConf(conf: number): string {
  const pct = Math.round(conf * 100);
  const s = `${pct}%`;
  if (pct >= 80) return chalk.green(s);
  if (pct >= 50) return chalk.yellow(s);
  return chalk.red(s);
}

/** Return "n/a" or a percentage string for save rate. */
function saveRate(p: LearnedPattern): string {
  if (p.hit_count === 0) return chalk.dim("n/a");
  const rate = Math.round((p.first_pass_saves / p.hit_count) * 100);
  return `${rate}%`;
}

/** Print a compact one-pattern summary (for list view). */
function printPatternRow(p: LearnedPattern): void {
  const idStr = chalk.dim(`#${p.id}`);
  const confStr = colorConf(p.confidence);
  const statusStr = statusBadges(p);
  const typeStr = chalk.dim(`[${p.pattern_type}]`);
  const hitsStr = `hits:${p.hit_count}`;
  const savesStr = `saves:${saveRate(p)}`;

  console.log(`  ${idStr} ${statusStr} ${confStr} ${chalk.bold(p.title)}`);
  console.log(
    `       ${typeStr} ${hitsStr}  ${savesStr}  source:${p.source}  id:${p.id}`,
  );
  const desc = p.description.length > 120
    ? p.description.slice(0, 117) + "…"
    : p.description;
  console.log(`       ${chalk.dim(desc)}`);
  console.log();
}

/** Print the full detail view of one pattern. */
function printPatternDetail(p: LearnedPattern): void {
  const divider = chalk.dim("─".repeat(70));

  console.log(chalk.bold(`\n● Pattern #${p.id} — ${p.title}`));
  console.log(divider);

  console.log(`  ${"Status".padEnd(20)} ${statusBadges(p)}`);
  console.log(`  ${"Type".padEnd(20)} ${p.pattern_type}`);
  console.log(`  ${"Source".padEnd(20)} ${p.source}${p.source_ref ? ` (${p.source_ref})` : ""}`);
  console.log(`  ${"Originating agent".padEnd(20)} ${p.agent ?? chalk.dim("—")}`);
  console.log(`  ${"Scope (repos)".padEnd(20)} ${p.repos ?? chalk.dim("all repos")}`);
  console.log(divider);

  console.log(`  ${"Confidence".padEnd(20)} ${colorConf(p.confidence)}`);
  console.log(`  ${"Injections (hits)".padEnd(20)} ${p.hit_count}`);
  console.log(`  ${"First-pass saves".padEnd(20)} ${p.first_pass_saves}  (save-rate: ${saveRate(p)})`);
  console.log(divider);

  if (p.promoted_at) {
    console.log(`  ${"Promoted at".padEnd(20)} ${chalk.cyan(p.promoted_at)}`);
  }
  if (p.suppressed_at) {
    console.log(`  ${"Suppressed at".padEnd(20)} ${chalk.yellow(p.suppressed_at)}`);
  }
  console.log(`  ${"Created".padEnd(20)} ${p.created_at}`);
  console.log(`  ${"Last updated".padEnd(20)} ${p.updated_at}`);
  console.log(divider);

  console.log(`\n  ${chalk.bold("Trigger description:")}\n`);
  // Word-wrap at 70 chars for readability
  const words = p.description.split(/\s+/);
  let line = "  ";
  for (const word of words) {
    if (line.length + word.length + 1 > 72) {
      console.log(line);
      line = "  " + word;
    } else {
      line += (line === "  " ? "" : " ") + word;
    }
  }
  if (line.trim().length > 0) console.log(line);
  console.log();

  console.log(chalk.dim("  Operator actions:"));
  if (p.active === 0) {
    console.log(chalk.dim(`  orch learned-patterns restore ${p.id}    # reactivate`));
  } else if (p.suppressed_at) {
    console.log(chalk.dim(`  orch learned-patterns unsuppress ${p.id}  # re-enable injection`));
    console.log(chalk.dim(`  orch learned-patterns retire ${p.id}      # fully archive`));
  } else {
    console.log(chalk.dim(`  orch learned-patterns suppress ${p.id}    # mark as false positive`));
    if (!p.promoted_at) {
      console.log(chalk.dim(`  orch learned-patterns promote ${p.id}     # boost to top of injection list`));
    } else {
      console.log(chalk.dim(`  orch learned-patterns demote ${p.id}      # return to normal priority`));
    }
    console.log(chalk.dim(`  orch learned-patterns retire ${p.id}      # soft-delete`));
  }
  console.log();
}

// ── Shared store helper ───────────────────────────────────────────────────────

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

function requirePattern(store: StateStore, id: number): LearnedPattern {
  const p = store.getLearnedPattern(id);
  if (!p) {
    console.error(chalk.red(`Pattern #${id} not found.`));
    store.close();
    process.exit(1);
  }
  return p;
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerLearnedPatternsCommand(program: Command): void {
  const cmd = program
    .command("learned-patterns")
    .description(
      "Immune-system pattern browser: inspect, suppress, promote, or retire learned patterns",
    );

  // ── list ───────────────────────────────────────────────────────────────────
  cmd
    .command("list")
    .description("List all learned patterns with status badges")
    .option("--repo <repo>", "Filter to patterns relevant to this repo")
    .option("--active-only", "Show only active, non-suppressed patterns")
    .option("--suppressed", "Show only suppressed patterns")
    .option("--promoted", "Show only promoted patterns")
    .option("--retired", "Show only retired patterns")
    .option("--json", "Output raw JSON")
    .action(
      (opts: {
        repo?: string;
        activeOnly?: boolean;
        suppressed?: boolean;
        promoted?: boolean;
        retired?: boolean;
        json?: boolean;
      }) => {
        const store = openStore();
        let items: LearnedPattern[];
        try {
          items = opts.repo
            ? store.getLearnedPatterns(opts.repo, 100)
            : store.listAllLearnedPatterns(100);

          if (opts.activeOnly) {
            items = items.filter((p) => p.active === 1 && !p.suppressed_at);
          } else if (opts.suppressed) {
            items = items.filter((p) => p.suppressed_at !== null);
          } else if (opts.promoted) {
            items = items.filter((p) => p.promoted_at !== null);
          } else if (opts.retired) {
            items = items.filter((p) => p.active === 0);
          }
        } finally {
          store.close();
        }

        if (opts.json) {
          console.log(JSON.stringify(items, null, 2));
          return;
        }

        const activeCount = items.filter((p) => p.active === 1 && !p.suppressed_at).length;
        const suppressedCount = items.filter((p) => p.suppressed_at !== null).length;
        const promotedCount = items.filter((p) => p.promoted_at !== null).length;
        const retiredCount = items.filter((p) => p.active === 0).length;

        console.log(chalk.bold("\n🛡  Learned Patterns — Immune System Browser\n"));
        console.log(
          chalk.dim(
            `  ${items.length} pattern(s)  ` +
              `${chalk.green(String(activeCount))} active  ` +
              `${chalk.yellow(String(suppressedCount))} suppressed  ` +
              `${chalk.cyan(String(promotedCount))} promoted  ` +
              `${chalk.dim(String(retiredCount))} retired\n`,
          ),
        );

        if (items.length === 0) {
          console.log(
            chalk.dim(
              "  No patterns match the filter. Run `orch learned-patterns seed` to seed defaults.",
            ),
          );
          console.log();
          return;
        }

        for (const p of items) {
          printPatternRow(p);
        }

        console.log(
          chalk.dim(
            "  Run `orch learned-patterns show <id>` for full detail.\n" +
              "  Run `orch learned-patterns suppress <id>` to suppress a false positive.\n" +
              "  Run `orch learned-patterns promote <id>` to boost a critical pattern.\n",
          ),
        );
      },
    );

  // ── show ───────────────────────────────────────────────────────────────────
  cmd
    .command("show <id>")
    .description(
      "Show full detail for a single pattern (trigger conditions, stats, operator actions)",
    )
    .option("--json", "Output raw JSON")
    .action((id: string, opts: { json?: boolean }) => {
      const numId = parseInt(id, 10);
      if (isNaN(numId)) {
        console.error(chalk.red("Invalid ID — must be a number"));
        process.exit(1);
      }

      const store = openStore();
      let pattern: LearnedPattern;
      try {
        pattern = requirePattern(store, numId);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(pattern, null, 2));
        return;
      }

      printPatternDetail(pattern);
    });

  // ── suppress ───────────────────────────────────────────────────────────────
  cmd
    .command("suppress <id>")
    .description(
      "Suppress a false-positive pattern: stops injection but keeps history intact",
    )
    .action((id: string) => {
      const numId = parseInt(id, 10);
      if (isNaN(numId)) {
        console.error(chalk.red("Invalid ID — must be a number"));
        process.exit(1);
      }

      const store = openStore();
      try {
        const p = requirePattern(store, numId);
        if (p.suppressed_at) {
          console.log(
            chalk.dim(
              `Pattern #${numId} is already suppressed (since ${p.suppressed_at}).`,
            ),
          );
          return;
        }
        store.suppressLearnedPattern(numId);
        console.log(
          chalk.yellow(
            `⊘  Pattern #${numId} suppressed: "${p.title}"\n` +
              "   The pattern will no longer be injected into review prompts.\n" +
              `   To re-enable: orch learned-patterns unsuppress ${numId}`,
          ),
        );
      } finally {
        store.close();
      }
    });

  // ── unsuppress ─────────────────────────────────────────────────────────────
  cmd
    .command("unsuppress <id>")
    .description("Re-enable a previously suppressed pattern")
    .action((id: string) => {
      const numId = parseInt(id, 10);
      if (isNaN(numId)) {
        console.error(chalk.red("Invalid ID — must be a number"));
        process.exit(1);
      }

      const store = openStore();
      try {
        const p = requirePattern(store, numId);
        if (!p.suppressed_at) {
          console.log(
            chalk.dim(`Pattern #${numId} is not suppressed — nothing to do.`),
          );
          return;
        }
        if (p.active === 0) {
          console.log(
            chalk.yellow(
              `Pattern #${numId} is retired. Run \`orch learned-patterns restore ${numId}\` to fully reactivate.`,
            ),
          );
          return;
        }
        store.unsuppressLearnedPattern(numId);
        console.log(
          chalk.green(
            `✓  Pattern #${numId} unsuppressed: "${p.title}"\n` +
              "   The pattern will now be injected into review prompts again.",
          ),
        );
      } finally {
        store.close();
      }
    });

  // ── promote ────────────────────────────────────────────────────────────────
  cmd
    .command("promote <id>")
    .description(
      "Promote a pattern to the top of the injection list (always injected first)",
    )
    .action((id: string) => {
      const numId = parseInt(id, 10);
      if (isNaN(numId)) {
        console.error(chalk.red("Invalid ID — must be a number"));
        process.exit(1);
      }

      const store = openStore();
      try {
        const p = requirePattern(store, numId);
        if (p.active === 0) {
          console.error(
            chalk.red(
              `Pattern #${numId} is retired. Restore it first: orch learned-patterns restore ${numId}`,
            ),
          );
          process.exit(1);
        }
        if (p.promoted_at) {
          console.log(
            chalk.dim(
              `Pattern #${numId} is already promoted (since ${p.promoted_at}).`,
            ),
          );
          return;
        }
        store.promoteLearnedPattern(numId);
        console.log(
          chalk.cyan(
            `▲  Pattern #${numId} promoted: "${p.title}"\n` +
              "   This pattern will always sort first in injection lists.\n" +
              `   To revert: orch learned-patterns demote ${numId}`,
          ),
        );
      } finally {
        store.close();
      }
    });

  // ── demote ─────────────────────────────────────────────────────────────────
  cmd
    .command("demote <id>")
    .description(
      "Remove promotion — return a pattern to normal confidence-based priority",
    )
    .action((id: string) => {
      const numId = parseInt(id, 10);
      if (isNaN(numId)) {
        console.error(chalk.red("Invalid ID — must be a number"));
        process.exit(1);
      }

      const store = openStore();
      try {
        const p = requirePattern(store, numId);
        if (!p.promoted_at) {
          console.log(
            chalk.dim(`Pattern #${numId} is not promoted — nothing to do.`),
          );
          return;
        }
        store.demoteLearnedPattern(numId);
        console.log(
          chalk.dim(
            `▼  Pattern #${numId} demoted: "${p.title}"\n` +
              "   Returned to normal confidence-based ordering.",
          ),
        );
      } finally {
        store.close();
      }
    });

  // ── retire ─────────────────────────────────────────────────────────────────
  cmd
    .command("retire <id>")
    .description(
      "Retire a pattern (soft-delete — stops injection, archived for history)",
    )
    .action((id: string) => {
      const numId = parseInt(id, 10);
      if (isNaN(numId)) {
        console.error(chalk.red("Invalid ID — must be a number"));
        process.exit(1);
      }

      const store = openStore();
      try {
        const p = requirePattern(store, numId);
        if (p.active === 0) {
          console.log(chalk.dim(`Pattern #${numId} is already retired.`));
          return;
        }
        store.retireLearnedPattern(numId);
        console.log(
          chalk.dim(
            `⊘  Pattern #${numId} retired: "${p.title}"\n` +
              `   To reactivate: orch learned-patterns restore ${numId}`,
          ),
        );
      } finally {
        store.close();
      }
    });

  // ── restore ────────────────────────────────────────────────────────────────
  cmd
    .command("restore <id>")
    .description("Reactivate a retired pattern — re-enables injection")
    .action((id: string) => {
      const numId = parseInt(id, 10);
      if (isNaN(numId)) {
        console.error(chalk.red("Invalid ID — must be a number"));
        process.exit(1);
      }

      const store = openStore();
      try {
        const p = requirePattern(store, numId);
        if (p.active === 1 && !p.suppressed_at) {
          console.log(
            chalk.dim(`Pattern #${numId} is already active — nothing to do.`),
          );
          return;
        }
        store.reactivateLearnedPattern(numId);
        console.log(
          chalk.green(
            `✓  Pattern #${numId} restored: "${p.title}"\n` +
              "   The pattern is now active and will be injected into review prompts.",
          ),
        );
      } finally {
        store.close();
      }
    });

  // ── seed ───────────────────────────────────────────────────────────────────
  cmd
    .command("seed")
    .description("Seed the 3 default anti-patterns from issue #693")
    .action(() => {
      const store = openStore();
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
      const store = openStore();
      let items: LearnedPattern[];
      try {
        items = store.listAllLearnedPatterns(200);
      } finally {
        store.close();
      }

      const active = items.filter((p) => p.active === 1 && !p.suppressed_at);
      const suppressed = items.filter((p) => p.suppressed_at !== null);
      const promoted = items.filter((p) => p.promoted_at !== null);
      const retired = items.filter((p) => p.active === 0);
      const totalHits = items.reduce((s, p) => s + p.hit_count, 0);
      const totalSaves = items.reduce((s, p) => s + p.first_pass_saves, 0);
      const overallRate =
        totalHits > 0
          ? `${Math.round((totalSaves / totalHits) * 100)}%`
          : chalk.dim("n/a");

      console.log(chalk.bold("\n🛡  Immune System — Effectiveness Metrics\n"));
      console.log(
        `  Total patterns  : ${items.length}  ` +
          `(${chalk.green(String(active.length))} active, ` +
          `${chalk.yellow(String(suppressed.length))} suppressed, ` +
          `${chalk.cyan(String(promoted.length))} promoted, ` +
          `${chalk.dim(String(retired.length))} retired)`,
      );
      console.log(`  Total injections : ${totalHits}`);
      console.log(`  First-pass saves : ${totalSaves}`);
      console.log(`  Overall save rate : ${overallRate}`);
      console.log();

      if (active.length > 0) {
        console.log(chalk.dim("  Per-pattern breakdown (active only):\n"));
        for (const p of active) {
          const sr = saveRate(p);
          const badge = p.promoted_at ? chalk.cyan(" [promoted]") : "";
          console.log(`  #${p.id}  ${chalk.bold(p.title)}${badge}`);
          console.log(
            `       hits:${p.hit_count}  saves:${p.first_pass_saves}  save-rate:${sr}  conf:${colorConf(p.confidence)}`,
          );
        }
        console.log();
      }

      if (suppressed.length > 0) {
        console.log(
          chalk.yellow(
            `  ${suppressed.length} suppressed pattern(s) — run \`orch learned-patterns list --suppressed\` to review.`,
          ),
        );
        console.log();
      }
    });
}
