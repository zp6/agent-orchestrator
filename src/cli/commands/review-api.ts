/**
 * `orch review-api` — CLI commands for the paid PR Review API service
 *
 * Subcommands:
 *   review-api serve        Start the HTTP server
 *   review-api stats        Show usage stats by tier
 *   review-api test <url>   Test a PR review locally (no billing deducted)
 *   review-api pricing      Show tier pricing table
 *   review-api gen-key      Generate a test API key for a tier
 */

import type { Command } from "commander";
import chalk from "chalk";
import { ReviewApiService, ARTICLE_IV_DISCLOSURE, parsePrUrl } from "../../reviewer/review-api-service.js";
import { TIER_CONFIGS, type ReviewTier } from "../../reviewer/review-api-billing.js";
import { getFleetUsageStats } from "../../reviewer/review-api-usage.js";
import Database from "better-sqlite3";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export function registerReviewApiCommand(program: Command): void {
  const cmd = program
    .command("review-api")
    .description("Manage the paid PR Review API service (Path 5 — revenue)");

  // -------------------------------------------------------------------------
  // review-api serve
  // -------------------------------------------------------------------------
  cmd
    .command("serve")
    .description("Start the PR Review API HTTP server")
    .option("-p, --port <port>", "Port to listen on", "3100")
    .option("--db <path>", "Path to state.db", process.env.STATE_DB_PATH ?? "./state.db")
    .action(async (opts: { port: string; db: string }) => {
      const port = parseInt(opts.port, 10);
      const service = new ReviewApiService({ dbPath: opts.db });

      const server = createServer(async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("X-Fleet-Agent", "claude-agent-orchestrator");

        // Health check
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200);
          res.end(JSON.stringify({ status: "ok", service: "pr-review-api" }));
          return;
        }

        // Pricing info
        if (req.method === "GET" && req.url === "/pricing") {
          res.writeHead(200);
          res.end(JSON.stringify(service.getPricingInfo(), null, 2));
          return;
        }

        // POST /review
        if (req.method === "POST" && req.url === "/review") {
          const authHeader = req.headers["authorization"] ?? "";
          const apiKey = authHeader.startsWith("Bearer ")
            ? authHeader.slice(7)
            : undefined;

          let body = "";
          for await (const chunk of req) body += chunk;

          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Invalid JSON body", code: "INVALID_JSON" }));
            return;
          }

          const request = parsed as { pr_url?: string; review_depth?: string };
          if (!request.pr_url) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Missing required field: pr_url", code: "MISSING_PR_URL" }));
            return;
          }

          const result = await service.handleReview(apiKey, {
            pr_url: request.pr_url,
            review_depth: request.review_depth as "basic" | "deep" | undefined,
          });

          const isError = "code" in result;
          const statusCode = isError
            ? result.code === "MISSING_AUTH" ? 401
              : result.code === "TIER_LIMIT_REACHED" ? 429
              : result.code === "TIER_FEATURE_GATED" ? 402
              : result.code === "INVALID_PR_URL" ? 400
              : 500
            : 200;

          res.writeHead(statusCode);
          res.end(JSON.stringify(result, null, 2));
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found", code: "NOT_FOUND" }));
      });

      server.listen(port, () => {
        console.log(chalk.green(`\n✅ PR Review API server running on port ${port}`));
        console.log(chalk.dim(`\nEndpoints:`));
        console.log(`  GET  http://localhost:${port}/health`);
        console.log(`  GET  http://localhost:${port}/pricing`);
        console.log(`  POST http://localhost:${port}/review`);
        console.log(chalk.dim(`\nExample request:`));
        console.log(
          chalk.cyan(
            `  curl -X POST http://localhost:${port}/review \\\n` +
            `    -H "Authorization: Bearer rr_free_test-key" \\\n` +
            `    -H "Content-Type: application/json" \\\n` +
            `    -d '{"pr_url":"https://github.com/owner/repo/pull/1"}'`
          )
        );
        console.log(chalk.dim(`\nDisclosure: ${ARTICLE_IV_DISCLOSURE}`));
      });

      process.on("SIGTERM", () => {
        console.log(chalk.yellow("\nShutting down review-api server…"));
        server.close(() => {
          service.close();
          process.exit(0);
        });
      });
    });

  // -------------------------------------------------------------------------
  // review-api stats
  // -------------------------------------------------------------------------
  cmd
    .command("stats")
    .description("Show fleet-wide usage stats by tier")
    .option("--month <YYYY-MM>", "Month to report (default: current month)")
    .option("--db <path>", "Path to state.db", process.env.STATE_DB_PATH ?? "./state.db")
    .action((opts: { month?: string; db: string }) => {
      const db = new Database(opts.db, { readonly: true });
      const month = opts.month ?? new Date().toISOString().slice(0, 7);

      // Ensure table exists before querying (might be a fresh db)
      try {
        const stats = getFleetUsageStats(db, month);

        console.log(chalk.bold(`\n📊 PR Review API — Usage Stats (${month})\n`));

        if (stats.length === 0) {
          console.log(chalk.dim("  No reviews recorded this month."));
          db.close();
          return;
        }

        const header = `${"Tier".padEnd(10)} ${"Reviews".padStart(8)} ${"Clients".padStart(8)}`;
        console.log(chalk.dim(header));
        console.log(chalk.dim("─".repeat(header.length)));

        let totalReviews = 0;
        let totalClients = 0;

        for (const row of stats) {
          const tierLabel = row.tier.padEnd(10);
          const countLabel = String(row.count).padStart(8);
          const clientLabel = String(row.clients).padStart(8);
          console.log(`${chalk.cyan(tierLabel)} ${countLabel} ${clientLabel}`);
          totalReviews += row.count;
          totalClients += row.clients;
        }

        console.log(chalk.dim("─".repeat(header.length)));
        console.log(
          `${"TOTAL".padEnd(10)} ${String(totalReviews).padStart(8)} ${String(totalClients).padStart(8)}`
        );

        // Revenue estimate
        const basicStats = stats.find((s) => s.tier === "basic");
        const proStats = stats.find((s) => s.tier === "pro");
        const estimatedMRR =
          (basicStats?.clients ?? 0) * 10 + (proStats?.clients ?? 0) * 49;
        if (estimatedMRR > 0) {
          console.log(chalk.green(`\n💵 Estimated MRR from active subscribers: $${estimatedMRR}`));
        }
      } finally {
        db.close();
      }
    });

  // -------------------------------------------------------------------------
  // review-api test
  // -------------------------------------------------------------------------
  cmd
    .command("test <pr_url>")
    .description("Perform a local test review (uses free-tier logic, no usage recorded)")
    .option("--db <path>", "Path to state.db", process.env.STATE_DB_PATH ?? "./state.db")
    .action(async (prUrl: string, opts: { db: string }) => {
      const parsed = parsePrUrl(prUrl);
      if (!parsed) {
        console.error(chalk.red("Invalid PR URL. Expected: https://github.com/owner/repo/pull/N"));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.dim(`\nTest-reviewing ${prUrl}…\n`));

      const service = new ReviewApiService({ dbPath: opts.db });
      // Use a test key that maps to free tier — the test method doesn't record usage
      const result = await service.handleReview("rr_free_test-local-cli", { pr_url: prUrl });

      if ("code" in result) {
        console.error(chalk.red(`\nError (${result.code}): ${result.error}`));
        process.exitCode = 1;
        service.close();
        return;
      }

      const decisionColor =
        result.decision === "approve"
          ? chalk.green
          : result.decision === "request-changes"
          ? chalk.yellow
          : chalk.red;

      console.log(`${chalk.bold("Decision:")}  ${decisionColor(result.decision.toUpperCase())}`);
      console.log(`${chalk.bold("Reason:")}    ${result.reason}`);
      if (result.score !== null) {
        console.log(`${chalk.bold("Score:")}     ${(result.score * 100).toFixed(0)}%`);
      }
      console.log(`\n${chalk.bold("Comment:")}`);
      console.log(result.comment);
      console.log(chalk.dim(`\n${result.disclosure}`));
      service.close();
    });

  // -------------------------------------------------------------------------
  // review-api pricing
  // -------------------------------------------------------------------------
  cmd
    .command("pricing")
    .description("Show tier pricing and feature table")
    .action(() => {
      console.log(chalk.bold("\n💳 PR Review API — Pricing\n"));
      console.log(chalk.dim("All reviews include AI authorship disclosure per Article IV.\n"));

      for (const [tierName, cfg] of Object.entries(TIER_CONFIGS)) {
        const icon = tierName === "pro" ? "⭐" : tierName === "basic" ? "✅" : "🆓";
        console.log(`${icon} ${chalk.bold(tierName.toUpperCase())} — ${chalk.green(cfg.priceLabel)}`);
        const limit =
          cfg.monthlyLimit === -1 ? "Unlimited" : `${cfg.monthlyLimit}/month`;
        console.log(`   Reviews:          ${limit}`);
        console.log(`   Quality score:    ${cfg.qualityScore ? "✓" : "—"}`);
        console.log(`   Security scan:    ${cfg.deepSecurityScan ? "✓" : "—"}`);
        console.log(`   Inline comments:  ${cfg.inlineComments ? "✓" : "—"}`);
        console.log(`   SLA:              ${cfg.slahours ? `≤${cfg.slahours}h` : "—"}`);
        console.log();
      }

      console.log(
        chalk.dim(
          "Subscriptions: https://polar.sh  |  GitHub Marketplace listing coming soon\n"
        )
      );
    });

  // -------------------------------------------------------------------------
  // review-api gen-key
  // -------------------------------------------------------------------------
  cmd
    .command("gen-key")
    .description("Generate a test API key for a given tier")
    .argument("<tier>", "Tier: free | basic | pro")
    .action((tier: string) => {
      const validTiers: ReviewTier[] = ["free", "basic", "pro"];
      if (!validTiers.includes(tier as ReviewTier)) {
        console.error(
          chalk.red(`Invalid tier "${tier}". Choose from: ${validTiers.join(", ")}`)
        );
        process.exitCode = 1;
        return;
      }
      const key = `rr_${tier}_${randomUUID()}`;
      console.log(chalk.bold("\n🔑 Test API Key\n"));
      console.log(`Tier:  ${chalk.cyan(tier)}`);
      console.log(`Key:   ${chalk.green(key)}`);
      console.log(
        chalk.dim(
          "\nUsage:\n" +
          `  curl -X POST http://localhost:3100/review \\\n` +
          `    -H "Authorization: Bearer ${key}" \\\n` +
          `    -H "Content-Type: application/json" \\\n` +
          `    -d '{"pr_url":"https://github.com/owner/repo/pull/1"}'`
        )
      );
    });
}
