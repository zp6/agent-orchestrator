import type { Command } from "commander";
import { createLogger } from "../../service/logger.js";

const log = createLogger("guard-command");

/**
 * Guard health command — PR guard surge suppression metrics and leak tracking (issue #1163).
 * Usage:
 *   orch guard-health             — fetch and display 24h metrics (default)
 *   orch guard-health --hours 7   — fetch and display 7-hour metrics
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
            duplicate_suppressed_hits: number;
            active_suppressions: number;
            suppressions: Array<{
              repo: string;
              issue_number: number;
              expires_at: string;
              minutes_remaining: number;
            }>;
            active_pr_surge_suppressions: number;
            pr_surge_suppressions: Array<{
              repo: string;
              blocking_pr_number: number;
              suppressed_at: string;
              expires_at: string;
              event_count: number;
              blocked_issues: number[];
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
          console.log(`🔄 Duplicate-suppressed: ${metrics.duplicate_suppressed_hits}`);
          console.log(`🔒 Active suppressions: ${metrics.active_suppressions}`);
          console.log(`🚦 Active PR suppressions: ${metrics.active_pr_surge_suppressions ?? 0}`);

          if (metrics.suppressions.length > 0) {
            console.log(`\n*Active Suppressions:*`);
            for (const s of metrics.suppressions.slice(0, 10)) {
              console.log(`  ${s.repo}#${s.issue_number} — ${s.minutes_remaining}m remaining`);
            }
            if (metrics.suppressions.length > 10) {
              console.log(`  ... and ${metrics.suppressions.length - 10} more`);
            }
          }

          if ((metrics.pr_surge_suppressions ?? []).length > 0) {
            console.log(`\n*Active PR Suppressions:*`);
            for (const s of metrics.pr_surge_suppressions.slice(0, 10)) {
              const issues = s.blocked_issues.slice(0, 5).map((n) => `#${n}`).join(", ");
              const overflow = s.blocked_issues.length > 5 ? ` +${s.blocked_issues.length - 5} more` : "";
              console.log(
                `  PR #${s.blocking_pr_number} in ${s.repo} — ` +
                `blocks ${s.blocked_issues.length} issues: ${issues}${overflow} — ${s.minutes_remaining}m remaining`,
              );
            }
            if (metrics.pr_surge_suppressions.length > 10) {
              console.log(`  ... and ${metrics.pr_surge_suppressions.length - 10} more`);
            }
          }

          // Alert if leaks detected
          if (metrics.leaked_hits > 0) {
            console.log(`\n⚠️  *Alert:* Leaked hits detected — suppression may be failing!`);
          }

          // Alert if high duplicate suppression rate
          const totalHits = metrics.total_hits;
          if (totalHits > 0) {
            const dupRate = metrics.duplicate_suppressed_hits / totalHits;
            if (dupRate > 0.2) {
              console.log(
                `\n⚠️  *Alert:* High duplicate suppression rate (${(dupRate * 100).toFixed(1)}%) — many repeated dispatch attempts`
              );
            }
          }

          console.log(`\n_Generated: ${new Date(data.generated_at).toLocaleString()}_\n`);
        }
      } catch (err) {
        console.error(`❌ Guard health check failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
