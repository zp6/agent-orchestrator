import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type Signal } from "../../state/store.js";

export function registerSignalsCommand(program: Command): void {
  const signals = program
    .command("signals")
    .description("Inspect stigmergy signals written by agents into state.db");

  // ── list ──────────────────────────────────────────────────────────────────
  signals
    .command("list")
    .description("List active (non-expired) stigmergy signals")
    .option("--type <type>", "Filter by signal_type (e.g. pattern_risk)")
    .option("--repo <repo>", "Filter by repo (e.g. rapartlu/agent-orchestrator)")
    .option("--file-glob <glob>", "Filter by file_glob pattern")
    .option("--limit <n>", "Maximum number of signals to show", "50")
    .option("--json", "Output raw JSON")
    .action(
      (opts: {
        type?: string;
        repo?: string;
        fileGlob?: string;
        limit?: string;
        json?: boolean;
      }) => {
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

        let items: Signal[];
        try {
          items = store.readSignals({
            signal_type: opts.type,
            repo: opts.repo,
            file_glob: opts.fileGlob,
            limit: parseInt(opts.limit ?? "50", 10),
          });
        } finally {
          store.close();
        }

        if (opts.json) {
          console.log(JSON.stringify(items, null, 2));
          return;
        }

        console.log(chalk.bold("\n● Stigmergy Signals\n"));

        if (items.length === 0) {
          console.log(
            chalk.dim(
              "  No active signals found. Signals are written by agents during verification failures and other events.",
            ),
          );
          console.log();
          return;
        }

        // Group by signal_type
        const byType = new Map<string, Signal[]>();
        for (const sig of items) {
          const group = byType.get(sig.signal_type) ?? [];
          group.push(sig);
          byType.set(sig.signal_type, group);
        }

        for (const [sigType, sigs] of byType) {
          console.log(chalk.cyan(`  ${sigType}`) + chalk.dim(` (${sigs.length})`));
          for (const s of sigs) {
            const conf = Math.round(s.confidence * 100);
            const confColor =
              conf >= 70 ? chalk.red : conf >= 40 ? chalk.yellow : chalk.green;
            const repoLabel = s.repo ? chalk.dim(` [${s.repo}]`) : "";
            const globLabel = s.file_glob ? chalk.dim(` glob:${s.file_glob}`) : "";
            const expiresIn = formatExpiresIn(s.expires_at);

            console.log(
              `    ${chalk.dim(`#${s.id}`)} ${confColor(`${conf}%`)} ` +
              `${chalk.bold(s.key)}${repoLabel}${globLabel}`,
            );
            console.log(
              `         ${chalk.dim(`by ${s.agent}`)} · expires ${expiresIn}`,
            );

            if (s.value) {
              try {
                const parsed = JSON.parse(s.value);
                if (parsed.revision_hint) {
                  console.log(
                    `         ${chalk.dim("hint:")} ${chalk.yellow(String(parsed.revision_hint).slice(0, 120))}`,
                  );
                }
                if (parsed.score !== undefined) {
                  console.log(
                    `         ${chalk.dim(`score: ${(parsed.score as number).toFixed(2)}`)}`,
                  );
                }
              } catch {
                // value is not JSON — just skip
              }
            }
          }
          console.log();
        }

        console.log(
          chalk.dim(
            `  ${items.length} signal${items.length === 1 ? "" : "s"} active. Expired signals are pruned each daemon cycle.`,
          ),
        );
        console.log();
      },
    );

  // ── write ─────────────────────────────────────────────────────────────────
  signals
    .command("write <agent> <type> <key>")
    .description("Manually write a stigmergy signal (useful for testing)")
    .option("--value <json>", "JSON payload to attach to the signal")
    .option("--repo <repo>", "Repo this signal applies to")
    .option("--file-glob <glob>", "File glob this signal applies to")
    .option("--confidence <n>", "Confidence score 0–1", "0.5")
    .option("--ttl-hours <n>", "How many hours until the signal expires", "168")
    .action(
      (
        agent: string,
        type: string,
        key: string,
        opts: {
          value?: string;
          repo?: string;
          fileGlob?: string;
          confidence?: string;
          ttlHours?: string;
        },
      ) => {
        let parsedValue: unknown;
        if (opts.value) {
          try {
            parsedValue = JSON.parse(opts.value);
          } catch {
            console.error(chalk.red("Error: --value must be valid JSON."));
            process.exit(1);
          }
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

        let sig: Signal;
        try {
          sig = store.writeSignal({
            agent,
            signal_type: type,
            key,
            value: parsedValue,
            repo: opts.repo,
            file_glob: opts.fileGlob,
            confidence: parseFloat(opts.confidence ?? "0.5"),
            ttl_hours: parseInt(opts.ttlHours ?? "168", 10),
          });
        } finally {
          store.close();
        }

        console.log(
          chalk.green(`✓ Signal #${sig.id} written:`),
          `[${sig.signal_type}] ${sig.key}`,
        );
        console.log(
          chalk.dim(`  Agent: ${sig.agent} · Confidence: ${Math.round(sig.confidence * 100)}% · Expires: ${formatExpiresIn(sig.expires_at)}`),
        );
      },
    );

  // ── prune ─────────────────────────────────────────────────────────────────
  signals
    .command("prune")
    .description("Manually prune all expired signals (normally runs automatically each daemon cycle)")
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

      let count: number;
      try {
        count = store.pruneExpiredSignals();
      } finally {
        store.close();
      }

      if (count === 0) {
        console.log(chalk.dim("No expired signals to prune."));
      } else {
        console.log(chalk.green(`✓ Pruned ${count} expired signal${count === 1 ? "" : "s"}.`));
      }
    });
}

function formatExpiresIn(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return chalk.red("expired");
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return chalk.yellow("< 1h");
  if (hours < 24) return chalk.yellow(`${hours}h`);
  const days = Math.floor(hours / 24);
  return chalk.dim(`${days}d`);
}
