import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type Signal, type SignalActivityEvent } from "../../state/store.js";

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

  // ── feed ──────────────────────────────────────────────────────────────────
  signals
    .command("feed")
    .description("Show a real-time activity feed of stigmergy signal writes and reads")
    .option("--limit <n>", "Maximum number of events to show", "50")
    .option(
      "--since <iso>",
      "Only show events at or after this ISO timestamp (e.g. 2026-04-12T00:00:00Z)",
    )
    .option(
      "--watch",
      "Auto-refresh the feed every --interval seconds",
    )
    .option(
      "--interval <s>",
      "Refresh interval in seconds (requires --watch)",
      "10",
    )
    .option("--json", "Output raw JSON")
    .action(
      (opts: {
        limit?: string;
        since?: string;
        watch?: boolean;
        interval?: string;
        json?: boolean;
      }) => {
        const limit = parseInt(opts.limit ?? "50", 10);
        const intervalMs = parseInt(opts.interval ?? "10", 10) * 1000;

        const renderFeed = (): void => {
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

          let events: SignalActivityEvent[];
          try {
            events = store.getSignalActivityFeed(limit, opts.since);
          } finally {
            store.close();
          }

          if (opts.json) {
            console.log(JSON.stringify(events, null, 2));
            return;
          }

          if (opts.watch) {
            // Clear terminal on refresh
            process.stdout.write("\x1Bc");
          }

          console.log(
            chalk.bold("\n● Stigmergy Signal Activity Feed") +
            chalk.dim(`  (${events.length} event${events.length === 1 ? "" : "s"})\n`),
          );

          if (events.length === 0) {
            console.log(
              chalk.dim(
                "  No signal activity yet. Signals are written during verification failures and read by agents\n  before dispatching tasks to inform routing decisions.\n",
              ),
            );
            return;
          }

          for (const ev of events) {
            renderEvent(ev);
          }

          if (opts.watch) {
            console.log(
              chalk.dim(`\n  Auto-refreshing every ${opts.interval ?? 10}s — Ctrl+C to stop`),
            );
          }
        };

        renderFeed();

        if (opts.watch) {
          const timer = setInterval(renderFeed, intervalMs);
          // Keep the process alive; clean up on SIGINT
          process.on("SIGINT", () => {
            clearInterval(timer);
            process.exit(0);
          });
        }
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

// ── Activity feed helpers ────────────────────────────────────────────────────

/** Format an ISO timestamp as HH:MM:SS in local time. */
function formatWallClock(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "??:??:??";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Return a coloured, fixed-width event-type badge. */
function formatEventBadge(eventType: "write" | "read"): string {
  if (eventType === "write") return chalk.green("WRITE".padEnd(5));
  return chalk.cyan("READ ".padEnd(5));
}

/** Format a confidence score as a coloured percentage string. */
function formatConfidence(confidence: number): string {
  const pct = Math.round(confidence * 100);
  const label = `${pct}%`.padStart(4);
  if (pct >= 70) return chalk.red(label);
  if (pct >= 40) return chalk.yellow(label);
  return chalk.green(label);
}

/**
 * Render a single SignalActivityEvent to the terminal.
 *
 * Format (two lines):
 *   HH:MM:SS  WRITE  <agent>  [signal_type] <key>  [repo]  conf:XX%
 *             hint: <revision_hint (truncated)>    ← only for write events with hints
 *
 * Read events additionally show the context if present:
 *   HH:MM:SS  READ   <reader>  ← signal_type <key>  [context]
 */
function renderEvent(ev: SignalActivityEvent): void {
  const time = chalk.dim(formatWallClock(ev.at));
  const badge = formatEventBadge(ev.event_type);
  const agent = chalk.bold(ev.agent);
  const sigType = chalk.cyan(ev.signal_type);
  const key = ev.key.length > 60 ? ev.key.slice(0, 57) + "…" : ev.key;
  const repo = ev.repo ? chalk.dim(` [${ev.repo}]`) : "";
  const conf = formatConfidence(ev.confidence);
  const arrow = ev.event_type === "read" ? chalk.dim("←") : chalk.dim("→");

  console.log(
    `  ${time}  ${badge}  ${agent}  ${arrow}  ${sigType} ${chalk.white(key)}${repo}  ${chalk.dim("conf:")}${conf}`,
  );

  // For write events, show a value hint if present
  if (ev.event_type === "write" && ev.value) {
    try {
      const parsed = JSON.parse(ev.value) as Record<string, unknown>;
      if (parsed.revision_hint) {
        const hint = String(parsed.revision_hint).slice(0, 120);
        console.log(`           ${chalk.dim("hint:")} ${chalk.yellow(hint)}`);
      }
    } catch {
      // value is not JSON — skip
    }
  }

  // For read events, show the context if available
  if (ev.event_type === "read" && ev.context) {
    console.log(`           ${chalk.dim("ctx:")} ${chalk.dim(ev.context)}`);
  }
}
