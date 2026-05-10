/**
 * Cloudflare DNS API client (issue #1513).
 *
 * Thin wrapper around the Cloudflare REST API for the small slice of DNS
 * operations the fleet needs autonomously: list zones, list / create / delete
 * DNS records. Backed by `CLOUDFLARE_API_TOKEN` and either a pre-known
 * `CLOUDFLARE_ZONE_ID` or a zone-name lookup.
 *
 * The client is deliberately minimal: every public method maps 1:1 onto a
 * single Cloudflare endpoint so it is straightforward to mock in tests. CLI
 * orchestration lives in `src/cli/commands/dns.ts`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  zone_id?: string;
  zone_name?: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status?: string;
}

export interface CloudflareDnsClientOptions {
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CloudflareError extends Error {
  constructor(message: string, readonly status?: number, readonly errors?: Array<{ code: number; message: string }>) {
    super(message);
    this.name = "CloudflareError";
  }
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
}

/**
 * Resolve a Cloudflare API token from any of the supported sources, mirroring
 * the GH_TOKEN multi-source pattern in `src/config/schema.ts`:
 *   1. explicit constructor option
 *   2. CLOUDFLARE_API_TOKEN env var
 *   3. ~/.claude-orchestrator/.env (CLOUDFLARE_API_TOKEN=...)
 */
export function resolveCloudflareToken(explicit?: string): string | undefined {
  if (explicit && explicit.length > 0) return explicit;
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  try {
    const envPath = resolve(process.env.HOME ?? "", ".claude-orchestrator", ".env");
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  } catch {
    // .env file does not exist — fine
  }
  return undefined;
}

/**
 * Resolve a zone id from any of the supported sources:
 *   1. explicit option
 *   2. CLOUDFLARE_ZONE_ID env var
 *   3. ~/.claude-orchestrator/.env (CLOUDFLARE_ZONE_ID=...)
 */
export function resolveCloudflareZoneId(explicit?: string): string | undefined {
  if (explicit && explicit.length > 0) return explicit;
  if (process.env.CLOUDFLARE_ZONE_ID) return process.env.CLOUDFLARE_ZONE_ID;
  try {
    const envPath = resolve(process.env.HOME ?? "", ".claude-orchestrator", ".env");
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/^CLOUDFLARE_ZONE_ID=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  } catch {
    // .env file does not exist — fine
  }
  return undefined;
}

/**
 * Given a fully-qualified record name like "nexus.wearetarr.com" derive the
 * registrable parent zone "wearetarr.com" using the simple last-two-labels
 * heuristic. Cloudflare's `GET /zones?name=` lookup will reject anything that
 * isn't a zone, so this is safe enough for the fleet's use case.
 */
export function deriveZoneNameFromRecord(recordName: string): string {
  const parts = recordName.split(".").filter(Boolean);
  if (parts.length <= 2) return recordName;
  return parts.slice(-2).join(".");
}

export class CloudflareDnsClient {
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: CloudflareDnsClientOptions = {}) {
    const token = resolveCloudflareToken(opts.apiToken);
    if (!token) {
      throw new CloudflareError(
        "CLOUDFLARE_API_TOKEN not set. Provide --token, set CLOUDFLARE_API_TOKEN env var, or add it to ~/.claude-orchestrator/.env",
      );
    }
    this.apiToken = token;
    this.baseUrl = (opts.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** List zones, optionally filtered by zone name. */
  async listZones(name?: string): Promise<CloudflareZone[]> {
    const qs = name ? `?name=${encodeURIComponent(name)}` : "";
    const res = await this.request<CloudflareZone[]>("GET", `/zones${qs}`);
    return res ?? [];
  }

  /** Resolve a zone id from a zone name (e.g. "wearetarr.com"). */
  async findZoneIdByName(zoneName: string): Promise<string> {
    const zones = await this.listZones(zoneName);
    const exact = zones.find((z) => z.name === zoneName);
    if (!exact) {
      throw new CloudflareError(
        `No Cloudflare zone matches "${zoneName}". Confirm the API token has Zone:Read access and the zone is in this account.`,
      );
    }
    return exact.id;
  }

  /** List DNS records in a zone, optionally filtered by name and/or type. */
  async listDnsRecords(
    zoneId: string,
    filter: { name?: string; type?: string } = {},
  ): Promise<CloudflareDnsRecord[]> {
    const params = new URLSearchParams();
    if (filter.name) params.set("name", filter.name);
    if (filter.type) params.set("type", filter.type);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await this.request<CloudflareDnsRecord[]>(
      "GET",
      `/zones/${encodeURIComponent(zoneId)}/dns_records${qs}`,
    );
    return res ?? [];
  }

  /** Create a DNS record. */
  async createDnsRecord(
    zoneId: string,
    record: {
      type: string;
      name: string;
      content: string;
      ttl?: number;
      proxied?: boolean;
      comment?: string;
    },
  ): Promise<CloudflareDnsRecord> {
    const body: Record<string, unknown> = {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl ?? 1, // 1 = "automatic" in Cloudflare's API
    };
    if (record.proxied !== undefined) body.proxied = record.proxied;
    if (record.comment) body.comment = record.comment;
    const res = await this.request<CloudflareDnsRecord>(
      "POST",
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      body,
    );
    if (!res) {
      throw new CloudflareError("Cloudflare returned an empty result for create");
    }
    return res;
  }

  /** Delete a DNS record by its record id. */
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request<{ id: string }>(
      "DELETE",
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    );
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      };
      const response = await this.fetchImpl(url, init);
      const text = await response.text();
      let parsed: CloudflareEnvelope<T> | null = null;
      try {
        parsed = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : null;
      } catch {
        // fall through; surface the raw text in the error
      }
      if (!response.ok || (parsed && parsed.success === false)) {
        const errors = parsed?.errors ?? [];
        const message = errors.length > 0
          ? errors.map((e) => `${e.code}: ${e.message}`).join("; ")
          : (text || `HTTP ${response.status}`);
        throw new CloudflareError(`Cloudflare API error: ${message}`, response.status, errors);
      }
      return (parsed?.result ?? null) as T | null;
    } catch (err) {
      if (err instanceof CloudflareError) throw err;
      if ((err as { name?: string }).name === "AbortError") {
        throw new CloudflareError(`Cloudflare request timed out after ${this.timeoutMs}ms (${method} ${path})`);
      }
      throw new CloudflareError(
        `Cloudflare request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
