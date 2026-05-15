/**
 * `orch social` — fleet ActivityPub social presence commands (issue #1515).
 *
 * Usage:
 *   orch social post "Hello from Nexus!"   Create a new post
 *   orch social posts                       List recent posts
 *   orch social status                      Worker health and follower count
 *   orch social setup                       Create KV namespace + print next steps
 *
 * Auth:
 *   Token resolved from --token / SOCIAL_POST_TOKEN env / ~/.claude-orchestrator/.env
 *   (same pattern as CLOUDFLARE_API_TOKEN for orch dns).
 */

import type { Command } from "commander";
import chalk from "chalk";
import { SocialClient, SocialClientError } from "../../services/social-client.js";
import { CloudflareDnsClient, CloudflareError } from "../../services/cloudflare-dns-client.js";

const DEFAULT_WORKER_URL = "https://social.nexus.wearetarr.com";

function makeClient(opts: { token?: string; url?: string }): SocialClient {
  try {
    return new SocialClient({ token: opts.token, baseUrl: opts.url ?? DEFAULT_WORKER_URL });
  } catch (err) {
    if (err instanceof SocialClientError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function registerSocialCommand(program: Command): void {
  const social = program
    .command("social")
    .description(
      "Fleet ActivityPub social presence — post to @nexus@social.nexus.wearetarr.com (issue #1515)",
    );

  // ── post ──────────────────────────────────────────────────────────────────

  social
    .command("post <content>")
    .description("Create a new post from the fleet account")
    .option("--token <token>", "Admin post token (fallback: SOCIAL_POST_TOKEN env)")
    .option("--url <url>", "Worker URL", DEFAULT_WORKER_URL)
    .option("--json", "Emit JSON")
    .action(async (content: string, opts: { token?: string; url?: string; json?: boolean }) => {
      const client = makeClient(opts);
      try {
        const post = await client.post(content);
        if (opts.json) {
          console.log(JSON.stringify(post));
          return;
        }
        console.log(chalk.green("Posted:"), post.id);
        console.log(chalk.gray("Published:"), formatDate(post.published));
        console.log(chalk.gray("Activity:"), post.activityId);
      } catch (err) {
        console.error(chalk.red(err instanceof SocialClientError ? err.message : String(err)));
        process.exit(1);
      }
    });

  // ── posts ─────────────────────────────────────────────────────────────────

  social
    .command("posts")
    .description("List recent posts from the fleet account")
    .option("--limit <n>", "Number of posts to show", "10")
    .option("--url <url>", "Worker URL", DEFAULT_WORKER_URL)
    .option("--json", "Emit JSON")
    .action(async (opts: { limit: string; url?: string; json?: boolean }) => {
      const client = new SocialClient({ baseUrl: opts.url ?? DEFAULT_WORKER_URL, token: "" });
      const limit = parseInt(opts.limit, 10) || 10;
      try {
        const posts = await client.posts(limit);
        if (opts.json) {
          posts.forEach((p) => console.log(JSON.stringify(p)));
          return;
        }
        if (posts.length === 0) {
          console.log(chalk.yellow("No posts yet."));
          return;
        }
        for (const p of posts) {
          console.log(chalk.bold(formatDate(p.published)));
          console.log(p.content);
          console.log(chalk.gray(p.id));
          console.log();
        }
      } catch (err) {
        console.error(chalk.red(err instanceof SocialClientError ? err.message : String(err)));
        process.exit(1);
      }
    });

  // ── status ────────────────────────────────────────────────────────────────

  social
    .command("status")
    .description("Worker health check and social account stats")
    .option("--url <url>", "Worker URL", DEFAULT_WORKER_URL)
    .option("--json", "Emit JSON")
    .action(async (opts: { url?: string; json?: boolean }) => {
      const client = new SocialClient({ baseUrl: opts.url ?? DEFAULT_WORKER_URL, token: "" });
      try {
        const status = await client.status();
        if (opts.json) {
          console.log(JSON.stringify(status));
          return;
        }
        const icon = status.ok ? chalk.green("✓") : chalk.red("✗");
        console.log(`${icon} ${status.handle}`);
        console.log(chalk.gray("Actor URL:"), status.actorUrl);
        console.log(chalk.gray("Followers:"), status.followerCount);
        if (status.latestPost) {
          console.log(chalk.gray("Latest post:"), formatDate(status.latestPost));
        }
      } catch (err) {
        console.error(chalk.red(err instanceof SocialClientError ? err.message : String(err)));
        process.exit(1);
      }
    });

  // ── setup ─────────────────────────────────────────────────────────────────

  social
    .command("setup")
    .description(
      "Bootstrap the ActivityPub worker: create KV namespace, add DNS CNAME, print next steps",
    )
    .option("--token <token>", "Cloudflare API token (fallback: CLOUDFLARE_API_TOKEN env)")
    .option("--account-id <id>", "Cloudflare account ID (fallback: CLOUDFLARE_ACCOUNT_ID env)")
    .option("--zone-id <id>", "Cloudflare zone ID (fallback: CLOUDFLARE_ZONE_ID env)")
    .option("--skip-dns", "Skip the DNS CNAME creation step")
    .option("--json", "Emit JSON")
    .action(
      async (opts: {
        token?: string;
        accountId?: string;
        zoneId?: string;
        skipDns?: boolean;
        json?: boolean;
      }) => {
        const cfToken =
          opts.token ??
          process.env["CLOUDFLARE_API_TOKEN"] ??
          (() => {
            console.error(
              chalk.red("CLOUDFLARE_API_TOKEN not set. Pass --token or set the env var."),
            );
            process.exit(1);
          })();

        const accountId =
          opts.accountId ??
          process.env["CLOUDFLARE_ACCOUNT_ID"] ??
          (() => {
            console.error(
              chalk.red("CLOUDFLARE_ACCOUNT_ID not set. Pass --account-id or set the env var."),
            );
            process.exit(1);
          })();

        const steps: string[] = [];
        const errors: string[] = [];

        // ── Step 1: Create KV namespace ──────────────────────────────────

        console.log(chalk.blue("Creating SOCIAL_KV namespace..."));
        try {
          const kvRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${cfToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ title: "SOCIAL_KV" }),
            },
          );
          const kvData = await kvRes.json() as {
            success: boolean;
            result?: { id: string };
            errors?: Array<{ message: string }>;
          };

          if (kvData.success && kvData.result?.id) {
            const kvId = kvData.result.id;
            console.log(chalk.green(`KV namespace created: ${kvId}`));
            steps.push(
              `Update wrangler-social.toml: set id = "${kvId}" in [[env.production.kv_namespaces]]`,
            );
          } else {
            const msg = kvData.errors?.map((e) => e.message).join(", ") ?? "unknown error";
            errors.push(`KV namespace creation failed: ${msg}`);
            console.error(chalk.yellow(`KV namespace: ${msg} (may already exist)`));
            steps.push("Manually retrieve your SOCIAL_KV namespace ID from the CF dashboard and set it in wrangler-social.toml");
          }
        } catch (err) {
          errors.push(`KV namespace request failed: ${String(err)}`);
          console.error(chalk.red(`KV namespace request failed: ${String(err)}`));
        }

        // ── Step 2: DNS CNAME ────────────────────────────────────────────

        if (!opts.skipDns) {
          console.log(chalk.blue("Adding DNS CNAME social.nexus.wearetarr.com..."));
          try {
            const dnsClient = new CloudflareDnsClient({ apiToken: opts.token });
            const zoneId =
              opts.zoneId ??
              process.env["CLOUDFLARE_ZONE_ID"] ??
              await (async () => {
                // Derive zone from domain name
                const zones = await dnsClient.listZones();
                const zone = zones.find((z) => "wearetarr.com".endsWith(z.name));
                return zone?.id ?? null;
              })();

            if (zoneId) {
              await dnsClient.createDnsRecord(zoneId, {
                type: "CNAME",
                name: "social.nexus.wearetarr.com",
                content: "nexus-social.workers.dev",
                ttl: 1,
                proxied: true,
              });
              console.log(chalk.green("CNAME added: social.nexus.wearetarr.com → nexus-social.workers.dev"));
            } else {
              errors.push("Could not resolve zone ID for wearetarr.com");
              console.error(chalk.yellow("Could not resolve zone ID — add CNAME manually or pass --zone-id"));
              steps.push("orch dns add CNAME social.nexus.wearetarr.com nexus-social.workers.dev --proxied");
            }
          } catch (err) {
            const msg = err instanceof CloudflareError ? err.message : String(err);
            errors.push(`DNS CNAME failed: ${msg}`);
            console.error(chalk.yellow(`DNS CNAME: ${msg}`));
            steps.push("orch dns add CNAME social.nexus.wearetarr.com nexus-social.workers.dev --proxied");
          }
        }

        // ── Step 3: Print next steps ─────────────────────────────────────

        const nextSteps = [
          ...steps,
          "Generate a post token: openssl rand -hex 32",
          "wrangler secret put SOCIAL_POST_TOKEN --config wrangler-social.toml",
          "wrangler deploy --config wrangler-social.toml",
          "Verify: curl https://social.nexus.wearetarr.com/.well-known/webfinger?resource=acct:nexus@social.nexus.wearetarr.com",
        ];

        if (opts.json) {
          console.log(JSON.stringify({ errors, nextSteps }));
          return;
        }

        console.log();
        console.log(chalk.bold("Next steps:"));
        nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
        if (errors.length > 0) {
          console.log();
          console.log(chalk.yellow("Warnings:"));
          errors.forEach((e) => console.log(`  - ${e}`));
        }
      },
    );
}
