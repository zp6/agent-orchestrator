import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type MonologueKind, type MonologueEntry } from "../../state/store.js";

function formatTimestamp(ts: string): string {
  return ts.replace("T", " ").replace("Z", "Z");
}

function formatEntry(entry: MonologueEntry): string {
  const shortTask = entry.task_id ? entry.task_id.slice(0, 8) : "no-task";
  const prose = entry.prose.split("\n").map((line) => `  ${line}`).join("\n");
  return (
    `[${formatTimestamp(entry.created_at)}] ${entry.agent_name} [task ${shortTask}] (${entry.kind})\n` +
    `${prose}`
  );
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}

function parseOffset(raw: string | undefined): number {
  const parsed = parseInt(raw ?? "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function registerMonologueCommand(program: Command): void {
  const monologue = program
    .command("monologue")
    .description("Inspect prose monologue logs written by agents");

  monologue
    .command("tail")
    .description("Show the latest monologue entries, optionally following new writes")
    .option("--agent <name>", "Filter by agent name")
    .option("--task <task_id>", "Filter by task ID")
    .option("--kind <kind>", "Filter by monologue kind")
    .option("--limit <n>", "Maximum number of entries to show", "20")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--watch", "Keep polling and print new entries as they arrive")
    .option("--interval <s>", "Poll interval in seconds when --watch is enabled", "5")
    .option("--json", "Output raw JSON")
    .action(
      (opts: {
        agent?: string;
        task?: string;
        kind?: string;
        limit?: string;
        offset?: string;
        watch?: boolean;
        interval?: string;
        json?: boolean;
      }) => {
        const limit = parseLimit(opts.limit, 20);
        const offset = parseOffset(opts.offset);
        const intervalMs = Math.max(1, parseInt(opts.interval ?? "5", 10)) * 1000;
        const kind = opts.kind as MonologueKind | undefined;

        let store: StateStore;
        try {
          store = new StateStore();
        } catch (err) {
          console.error(chalk.red("Could not open state database:"), err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        const readEntries = (): MonologueEntry[] => store.getMonologue({
          agent_name: opts.agent,
          task_id: opts.task,
          kind,
          limit,
          offset,
        });

        const seenIds = new Set<number>();
        const render = (): void => {
          const entries = readEntries();
          const ordered = entries.slice().reverse();
          if (opts.json) {
            console.log(JSON.stringify(entries, null, 2));
            return;
          }

          if (opts.watch) {
            const fresh = ordered.filter((entry) => !seenIds.has(entry.id));
            if (fresh.length === 0) return;
            for (const entry of fresh) {
              console.log(formatEntry(entry));
              console.log();
              seenIds.add(entry.id);
            }
            return;
          }

          console.log(chalk.bold("\n● Monologue Tail\n"));
          if (ordered.length === 0) {
            console.log(chalk.dim("  No monologue entries found."));
            console.log();
            return;
          }

          for (const entry of ordered) {
            console.log(formatEntry(entry));
            console.log();
          }
        };

        if (!opts.watch) {
          try {
            render();
          } catch (err) {
            console.error(chalk.red("Failed to read monologue entries:"), err instanceof Error ? err.message : String(err));
            process.exit(1);
          } finally {
            store.close();
          }
          return;
        }

        try {
          render();
          const timer = setInterval(render, intervalMs);
          const shutdown = (): void => {
            clearInterval(timer);
            store.close();
            process.exit(0);
          };
          process.on("SIGINT", shutdown);
          process.on("SIGTERM", shutdown);
        } catch (err) {
          store.close();
          console.error(chalk.red("Failed to read monologue entries:"), err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      },
    );
}
