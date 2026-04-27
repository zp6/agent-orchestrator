import type { Command } from "commander";
import { createLogger } from "../../service/logger.js";

const log = createLogger("guard-command");

/**
 * Guard health command — PR guard surge suppression metrics and leak tracking (issue #1163).
 * Usage:
 *   orch guard-health             — fetch and display 24h metrics (default)
 *   orch guard-health --days 7    — fetch and display 7-day metrics
 *   orch guard-health --json      — output raw JSON
 */
export function registerGuardHealthCommand(program: Command): void {
  program
    .command("guard-health")
    .description("PR guard surge suppression effectiveness metrics and leak tracking (issue #1163)")
    .option("--hours <n>", "Metrics window in hours (default 24, max 720)", "24")
    .option("--json", "JSON output")
    .action(async (options: { hours: string; json: boolean }) => {
      try {
        const windowHours = parseFloat(options.hours);
        if (isNaN(windowHours) || windowHours < 1 || windowHours > 720) {
          console.error("❌ Invalid window: must be between 1 and 720 hours");
          process.exit(1);
        }

        const res = await fetch("http://localhost:3472/guard-health", {
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          console.error(`❌ Failed to fetch guard metrics (${res.status})`);
          process.exit(1);
        }

        const data = (await res.json()) as {
          window_hours: number;
          metrics: {
            total_hits: number;
            leaked_hits: number;
            active_suppressions: number;
            suppressions: Array<{
              repo: string;
              issue_number: number;
              expires_at: string;
              minutes_remaining: number;
            }>;
          };
          generated_at: string;
        };

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          // Pretty-print
          const { metrics, window_hours } = data;
          console.log(`\n🛡️  *Guard Health* (${window_hours}h window)\n`);
          console.log(`📊 Total hits: ${metrics.total_hits}`);
          console.log(`🚫 Leaked hits: ${metrics.leaked_hits}`);
          console.log(`🔒 Active suppressions: ${metrics.active_suppressions}`);

          if (metrics.suppressions.length > 0) {
            console.log(`\n*Active Suppressions:*`);
            for (const s of metrics.suppressions.slice(0, 10)) {
              console.log(`  ${s.repo}#${s.issue_number} — ${s.minutes_remaining}m remaining`);
            }
            if (metrics.suppressions.length > 10) {
              console.log(`  ... and ${metrics.suppressions.length - 10} more`);
            }
          }

          // Alert if leaks detected
          if (metrics.leaked_hits > 0) {
            console.log(`\n⚠️  *Alert:* Leaked hits detected — suppression may be failing!`);
          }

          console.log(`\n_Generated: ${new Date(data.generated_at).toLocaleString()}_\n`);
        }
      } catch (err) {
        console.error(`❌ Guard health check failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
