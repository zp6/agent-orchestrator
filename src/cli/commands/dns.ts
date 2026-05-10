/**
 * CLI command: orch dns (issue #1513)
 *
 * Autonomous Cloudflare DNS management for fleet-owned zones (e.g.
 * wearetarr.com). Eliminates the operator-UI dependency for DNS sub-tasks
 * such as #1464 (CNAME nexus.wearetarr.com) and #1466 (email routing).
 *
 * Usage:
 *   orch dns add <name> --type CNAME --content <target> [--ttl 1] [--proxied]
 *   orch dns list [zone]
 *   orch dns remove <name> [--type CNAME]
 *
 * Auth resolution mirrors GH_TOKEN: --token flag → CLOUDFLARE_API_TOKEN env →
 * ~/.claude-orchestrator/.env. Same precedence for --zone-id /
 * CLOUDFLARE_ZONE_ID. When neither is set, the zone is derived from the
 * record name (last two labels) and looked up via the API.
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  CloudflareDnsClient,
  CloudflareError,
  deriveZoneNameFromRecord,
  resolveCloudflareZoneId,
} from "../../services/cloudflare-dns-client.js";

interface CommonOpts {
  token?: string;
  zoneId?: string;
  zone?: string;
  json?: boolean;
}

function makeClient(opts: CommonOpts): CloudflareDnsClient {
  try {
    return new CloudflareDnsClient({ apiToken: opts.token });
  } catch (err) {
    if (err instanceof CloudflareError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}

async function resolveZoneId(
  client: CloudflareDnsClient,
  opts: CommonOpts,
  recordName?: string,
): Promise<string> {
  const explicit = resolveCloudflareZoneId(opts.zoneId);
  if (explicit) return explicit;
  const zoneName = opts.zone ?? (recordName ? deriveZoneNameFromRecord(recordName) : undefined);
  if (!zoneName) {
    console.error(
      chalk.red(
        "Could not determine zone. Pass --zone-id, --zone, or set CLOUDFLARE_ZONE_ID.",
      ),
    );
    process.exit(1);
  }
  try {
    return await client.findZoneIdByName(zoneName);
  } catch (err) {
    if (err instanceof CloudflareError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}

function printError(err: unknown): never {
  if (err instanceof CloudflareError) {
    console.error(chalk.red(err.message));
  } else {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  }
  process.exit(1);
}

export function registerDnsCommand(program: Command): void {
  const dns = program
    .command("dns")
    .description("Cloudflare DNS management for fleet-owned zones (issue #1513)");

  dns
    .command("add <name>")
    .description("Create a DNS record (defaults: type=CNAME, ttl=automatic, proxied=false)")
    .requiredOption("--content <target>", "Record content (target host, IP, or text)")
    .option("--type <type>", "Record type (CNAME, A, AAAA, TXT, MX, ...)", "CNAME")
    .option("--ttl <seconds>", "TTL seconds (1 = automatic)", "1")
    .option("--proxied", "Route through Cloudflare's proxy (orange cloud)")
    .option("--comment <text>", "Optional record comment")
    .option("--token <token>", "Cloudflare API token (overrides CLOUDFLARE_API_TOKEN)")
    .option("--zone-id <id>", "Cloudflare zone id (overrides CLOUDFLARE_ZONE_ID)")
    .option("--zone <name>", "Zone name to look up (e.g. wearetarr.com)")
    .option("--json", "Emit the created record as JSON")
    .action(async (
      name: string,
      opts: CommonOpts & {
        content: string;
        type: string;
        ttl: string;
        proxied?: boolean;
        comment?: string;
      },
    ) => {
      const ttl = Number(opts.ttl);
      if (!Number.isFinite(ttl) || ttl < 1) {
        console.error(chalk.red("--ttl must be a positive integer (use 1 for automatic)"));
        process.exit(1);
      }
      const client = makeClient(opts);
      const zoneId = await resolveZoneId(client, opts, name);
      try {
        const record = await client.createDnsRecord(zoneId, {
          type: opts.type.toUpperCase(),
          name,
          content: opts.content,
          ttl,
          proxied: opts.proxied,
          comment: opts.comment,
        });
        if (opts.json) {
          console.log(JSON.stringify(record, null, 2));
          return;
        }
        console.log(chalk.green(`✓ created ${record.type} ${record.name} → ${record.content}`));
        console.log(chalk.dim(`  zone: ${zoneId}  record id: ${record.id}  ttl: ${record.ttl}${record.proxied ? "  proxied" : ""}`));
      } catch (err) {
        printError(err);
      }
    });

  dns
    .command("list [zone]")
    .description("List DNS records in a zone (zone defaults to derived from --zone-id or env)")
    .option("--type <type>", "Filter by record type")
    .option("--name <name>", "Filter by record name")
    .option("--token <token>", "Cloudflare API token (overrides CLOUDFLARE_API_TOKEN)")
    .option("--zone-id <id>", "Cloudflare zone id (overrides CLOUDFLARE_ZONE_ID)")
    .option("--json", "Emit records as JSON")
    .action(async (
      zoneArg: string | undefined,
      opts: CommonOpts & { type?: string; name?: string },
    ) => {
      const client = makeClient(opts);
      const zoneId = await resolveZoneId(client, { ...opts, zone: zoneArg ?? opts.zone });
      try {
        const records = await client.listDnsRecords(zoneId, {
          name: opts.name,
          type: opts.type?.toUpperCase(),
        });
        if (opts.json) {
          console.log(JSON.stringify(records, null, 2));
          return;
        }
        if (records.length === 0) {
          console.log(chalk.dim("  (no records)"));
          return;
        }
        console.log(chalk.bold(`\n● DNS records (zone ${zoneId})\n`));
        for (const r of records) {
          const type = r.type.padEnd(6);
          const ttl = String(r.ttl === 1 ? "auto" : r.ttl).padStart(5);
          const proxied = r.proxied ? chalk.cyan(" proxied") : "";
          console.log(`  ${chalk.dim(r.id.slice(0, 8))}  ${chalk.bold(type)}  ${r.name.padEnd(40)}  ${chalk.dim(ttl)}  ${r.content}${proxied}`);
        }
        console.log();
      } catch (err) {
        printError(err);
      }
    });

  dns
    .command("remove <name>")
    .description("Delete a DNS record by name (use --type to disambiguate when multiple exist)")
    .option("--type <type>", "Record type (only required when name has multiple records)")
    .option("--token <token>", "Cloudflare API token (overrides CLOUDFLARE_API_TOKEN)")
    .option("--zone-id <id>", "Cloudflare zone id (overrides CLOUDFLARE_ZONE_ID)")
    .option("--zone <name>", "Zone name to look up (e.g. wearetarr.com)")
    .option("--json", "Emit the deleted record id as JSON")
    .action(async (
      name: string,
      opts: CommonOpts & { type?: string },
    ) => {
      const client = makeClient(opts);
      const zoneId = await resolveZoneId(client, opts, name);
      try {
        const matches = await client.listDnsRecords(zoneId, {
          name,
          type: opts.type?.toUpperCase(),
        });
        if (matches.length === 0) {
          console.error(chalk.red(`No DNS record matches name="${name}"${opts.type ? ` type=${opts.type.toUpperCase()}` : ""}`));
          process.exit(1);
        }
        if (matches.length > 1) {
          console.error(
            chalk.red(`Multiple records match "${name}". Pass --type to disambiguate. Found:`),
          );
          for (const m of matches) {
            console.error(`  ${m.type} ${m.name} → ${m.content} (id ${m.id})`);
          }
          process.exit(1);
        }
        const target = matches[0]!;
        await client.deleteDnsRecord(zoneId, target.id);
        if (opts.json) {
          console.log(JSON.stringify({ deleted: target.id, name: target.name, type: target.type }, null, 2));
          return;
        }
        console.log(chalk.green(`✓ deleted ${target.type} ${target.name} (id ${target.id})`));
      } catch (err) {
        printError(err);
      }
    });
}
