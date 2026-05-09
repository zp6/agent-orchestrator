/**
 * CLI command: orch connection-errors (issue #1521)
 *
 * Diagnostic command that pulls connection-error and connection-error-exhausted
 * failures from state.db, buckets them by hour-of-day (UTC), agent, and error
 * subtype, and prints an analysis table.
 *
 * This command was introduced to investigate the 490 connection-error failures
 * (37% of all task failures) reported in issue #1521.  It helps distinguish:
 *   - Genuine infrastructure failures (ECONNREFUSED, ETIMEDOUT, socket hang up)
 *   - Quota/rate-limit errors mis-classified as connection errors
 *   - Proxy spawn failures (E2BIG, EAGAIN, ENOENT)
 *
 * Usage:
 *   orch connection-errors [--days N] [--json]
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

// ── Error sub-classification ──────────────────────────────────────────────────

type ErrorSubtype =
  | "quota-mis-classified" // "out of extra usage", "extra usage", quota 500
  | "spawn-failure"        // "failed to spawn", E2BIG, EAGAIN, ENOENT
  | "network"              // ECONNREFUSED, ETIMEDOUT, ECONNRESET, ENOTFOUND
  | "socket-hangup"        // "socket hang up"
  | "http-5xx"             // generic HTTP 5xx from proxy/Anthropic
  | "generic";             // "Connection error." with no further detail

function classifyError(msg: string): ErrorSubtype {
  const lower = msg.toLowerCase();

  // Quota/rate-limit errors that previously landed in the connection-error bucket
  if (
    lower.includes("out of extra usage") ||
    lower.includes("extra usage") ||
    lower.includes("out of daily") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("usage limit") ||
    lower.includes("quota") ||
    lower.includes("too many requests") ||
    lower.includes("overloaded") ||
    lower.includes("hit your limit") ||
    // Raw 429 embedded in message
    lower.includes("429")
  ) {
    return "quota-mis-classified";
  }

  if (
    lower.includes("failed to spawn") ||
    lower.includes("spawn enoent") ||
    lower.includes("e2big") ||
    lower.includes("eagain")
  ) {
    return "spawn-failure";
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("ehostunreach")
  ) {
    return "network";
  }

  if (lower.includes("socket hang up")) {
    return "socket-hangup";
  }

  // HTTP 5xx embedded as a status code in the message text (e.g. "500 {…}")
  if (/\b5\d{2}\b/.test(msg)) {
    return "http-5xx";
  }

  return "generic";
}

// ── Analysis helpers ─────────────────────────────────────────────────────────

interface FailureRow {
  task_id: string;
  agent_name: string | null;
  result: string | null;
  created_at: string;
  subtype: ErrorSubtype;
  hour_utc: number;
}

interface HourBucket {
  hour: number;
  count: number;
}

interface AgentBucket {
  agent: string;
  count: number;
  subtypes: Record<ErrorSubtype, number>;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function subtypeColour(s: ErrorSubtype): string {
  switch (s) {
    case "quota-mis-classified": return chalk.red(s);
    case "spawn-failure":        return chalk.yellow(s);
    case "network":              return chalk.cyan(s);
    case "socket-hangup":        return chalk.cyan(s);
    case "http-5xx":             return chalk.magenta(s);
    default:                     return chalk.dim(s);
  }
}

function sparkline(buckets: HourBucket[]): string {
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const cells: string[] = [];
  for (let h = 0; h < 24; h++) {
    const bucket = buckets.find((b) => b.hour === h);
    const count = bucket?.count ?? 0;
    const idx = count === 0 ? 0 : Math.ceil((count / maxCount) * (bars.length - 1));
    cells.push(count > 0 ? chalk.cyan(bars[idx]) : chalk.dim("·"));
  }
  return cells.join("");
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerConnectionErrorsCommand(program: Command): void {
  program
    .command("connection-errors")
    .description(
      "Diagnose connection-error failures: bucket by hour, agent, and subtype (issue #1521)",
    )
    .option("--days <n>", "Look-back window in days", "7")
    .option("--limit <n>", "Max rows to fetch from DB", "2000")
    .option("--json", "Output raw JSON instead of formatted table")
    .action((opts: { days: string; limit: string; json?: boolean }) => {
      const days = Math.max(1, parseInt(opts.days, 10) || 7);
      const rowLimit = Math.max(100, parseInt(opts.limit, 10) || 2000);

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
        // Pull all tasks whose result starts with "connection-error" or "Connection error"
        const rows = store.getConnectionErrorFailures(days, rowLimit);

        const failures: FailureRow[] = rows.map((r) => {
          const msg = r.result ?? "";
          const dt = new Date(r.created_at);
          return {
            task_id: r.task_id,
            agent_name: r.agent_name,
            result: r.result,
            created_at: r.created_at,
            subtype: classifyError(msg),
            hour_utc: dt.getUTCHours(),
          };
        });

        // ── Hour-of-day distribution ──────────────────────────────────────────
        const hourMap = new Map<number, number>();
        for (const f of failures) {
          hourMap.set(f.hour_utc, (hourMap.get(f.hour_utc) ?? 0) + 1);
        }
        const hourBuckets: HourBucket[] = Array.from(hourMap.entries())
          .map(([hour, count]) => ({ hour, count }))
          .sort((a, b) => a.hour - b.hour);

        // ── Per-agent distribution ────────────────────────────────────────────
        const agentMap = new Map<string, AgentBucket>();
        for (const f of failures) {
          const agent = f.agent_name ?? "(unknown)";
          if (!agentMap.has(agent)) {
            agentMap.set(agent, {
              agent,
              count: 0,
              subtypes: {
                "quota-mis-classified": 0,
                "spawn-failure": 0,
                network: 0,
                "socket-hangup": 0,
                "http-5xx": 0,
                generic: 0,
              },
            });
          }
          const bucket = agentMap.get(agent)!;
          bucket.count += 1;
          bucket.subtypes[f.subtype] += 1;
        }
        const agentBuckets = Array.from(agentMap.values()).sort(
          (a, b) => b.count - a.count,
        );

        // ── Subtype summary ───────────────────────────────────────────────────
        const subtypeTotals: Record<ErrorSubtype, number> = {
          "quota-mis-classified": 0,
          "spawn-failure": 0,
          network: 0,
          "socket-hangup": 0,
          "http-5xx": 0,
          generic: 0,
        };
        for (const f of failures) {
          subtypeTotals[f.subtype] += 1;
        }

        if (opts.json) {
          console.log(
            JSON.stringify(
              { total: failures.length, hourBuckets, agentBuckets, subtypeTotals },
              null,
              2,
            ),
          );
          return;
        }

        // ── Human-readable output ─────────────────────────────────────────────
        console.log(chalk.bold(`\n🔌  Connection-Error Diagnostic — last ${days} day(s)\n`));
        console.log(
          chalk.dim(
            "  Investigates the connection-error failure bucket (issue #1521).\n" +
              "  Distinguishes genuine network failures from quota-exhaustion errors\n" +
              "  that were previously mis-classified as connection errors.\n",
          ),
        );

        if (failures.length === 0) {
          console.log(chalk.green("  No connection-error failures in the selected window. ✓\n"));
          return;
        }

        // ── Subtype breakdown ─────────────────────────────────────────────────
        console.log(chalk.bold("  Error subtype breakdown\n"));
        const subtypeOrder: ErrorSubtype[] = [
          "quota-mis-classified",
          "spawn-failure",
          "network",
          "socket-hangup",
          "http-5xx",
          "generic",
        ];
        for (const st of subtypeOrder) {
          const n = subtypeTotals[st];
          if (n === 0) continue;
          const pct = ((n / failures.length) * 100).toFixed(1);
          const bar = "█".repeat(Math.round((n / failures.length) * 30));
          console.log(
            `  ${subtypeColour(st).padEnd(30)}  ${chalk.bold(String(n).padStart(5))}  ${pct.padStart(5)}%  ${chalk.dim(bar)}`,
          );
        }
        console.log();

        // ── Hour-of-day sparkline ─────────────────────────────────────────────
        console.log(chalk.bold("  Hour-of-day distribution (UTC)"));
        console.log(chalk.dim("  00  04  08  12  16  20  23"));
        console.log("  " + sparkline(hourBuckets));
        const peakHour = hourBuckets.reduce(
          (best, h) => (h.count > best.count ? h : best),
          { hour: 0, count: 0 },
        );
        if (peakHour.count > 0) {
          console.log(
            chalk.dim(
              `  Peak: ${String(peakHour.hour).padStart(2, "0")}:00 UTC ` +
                `(${peakHour.count} failures — ` +
                (peakHour.hour === 0 || peakHour.hour % 4 === 0
                  ? chalk.yellow("possible cron/scheduler alignment")
                  : "no obvious scheduling pattern") +
                ")",
            ),
          );
        }
        console.log();

        // ── Per-agent table ───────────────────────────────────────────────────
        console.log(chalk.bold("  Per-agent failures (top 10)\n"));
        console.log(
          chalk.dim(
            `  ${"Agent".padEnd(40)} ${"Total".padStart(6)}  ${"Quota".padStart(6)}  ${"Spawn".padStart(6)}  ${"Network".padStart(8)}  ${"5xx".padStart(4)}  ${"Generic".padStart(7)}`,
          ),
        );
        console.log(chalk.dim("  " + "─".repeat(90)));
        for (const ab of agentBuckets.slice(0, 10)) {
          const q = ab.subtypes["quota-mis-classified"];
          const sp = ab.subtypes["spawn-failure"];
          const net = ab.subtypes["network"] + ab.subtypes["socket-hangup"];
          const fivexx = ab.subtypes["http-5xx"];
          const gen = ab.subtypes["generic"];
          console.log(
            `  ${ab.agent.padEnd(40)} ${String(ab.count).padStart(6)}  ${String(q).padStart(6)}  ${String(sp).padStart(6)}  ${String(net).padStart(8)}  ${String(fivexx).padStart(4)}  ${String(gen).padStart(7)}`,
          );
        }
        console.log();

        // ── Diagnosis + recommendation ────────────────────────────────────────
        const quotaPct = (subtypeTotals["quota-mis-classified"] / failures.length) * 100;
        const spawnPct = (subtypeTotals["spawn-failure"] / failures.length) * 100;
        const genericPct = (subtypeTotals["generic"] / failures.length) * 100;

        console.log(chalk.bold("  Diagnosis\n"));

        if (quotaPct >= 10) {
          console.log(
            chalk.red(
              `  ⚠  ${quotaPct.toFixed(0)}% of connection-errors are quota-exhaustion errors.\n` +
                "     These were being mis-classified and retried as connection errors.\n" +
                "     FIX: isRateLimitError now catches 'out of extra usage' (issue #1521).\n",
            ),
          );
        }
        if (spawnPct >= 10) {
          console.log(
            chalk.yellow(
              `  ⚠  ${spawnPct.toFixed(0)}% are proxy spawn failures (E2BIG/EAGAIN/ENOENT).\n` +
                "     These are transient container start-up failures — review container\n" +
                "     resource limits and memory pressure at peak dispatch times.\n",
            ),
          );
        }
        if (genericPct >= 50) {
          console.log(
            chalk.cyan(
              `  ℹ  ${genericPct.toFixed(0)}% are plain 'Connection error.' with no detail.\n` +
                "     Check proxy logs around failure timestamps to identify the TCP/TLS layer.\n",
            ),
          );
        }
        if (peakHour.count > 0 && peakHour.hour % 4 === 0) {
          console.log(
            chalk.yellow(
              `  ⚠  Failures cluster at ${String(peakHour.hour).padStart(2, "0")}:00 UTC.\n` +
                "     Possible cause: cron job or scheduler waking up and flooding the proxy.\n",
            ),
          );
        }
        if (quotaPct < 10 && spawnPct < 10 && genericPct < 50) {
          console.log(chalk.green("  ✓  No dominant failure pattern detected. Likely upstream transient.\n"));
        }

        console.log(chalk.bold(`  Total: ${chalk.red(String(failures.length))} connection-error failures in ${days}d\n`));
      } finally {
        store.close();
      }
    });
}
