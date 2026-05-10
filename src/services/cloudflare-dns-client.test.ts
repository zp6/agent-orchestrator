import { describe, it, expect } from "vitest";
import {
  CloudflareDnsClient,
  CloudflareError,
  deriveZoneNameFromRecord,
  resolveCloudflareToken,
  resolveCloudflareZoneId,
} from "./cloudflare-dns-client.js";

function mockFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: string },
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(url), init);
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

function envelope<T>(result: T): string {
  return JSON.stringify({ success: true, errors: [], messages: [], result });
}

describe("deriveZoneNameFromRecord", () => {
  it("returns the last two labels for a sub-sub-domain", () => {
    expect(deriveZoneNameFromRecord("nexus.wearetarr.com")).toBe("wearetarr.com");
    expect(deriveZoneNameFromRecord("a.b.c.example.com")).toBe("example.com");
  });

  it("returns the input unchanged when it already is a registrable domain", () => {
    expect(deriveZoneNameFromRecord("wearetarr.com")).toBe("wearetarr.com");
    expect(deriveZoneNameFromRecord("example")).toBe("example");
  });
});

describe("resolveCloudflareToken / resolveCloudflareZoneId", () => {
  it("prefers explicit value over env", () => {
    const previous = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "from-env";
    try {
      expect(resolveCloudflareToken("from-explicit")).toBe("from-explicit");
    } finally {
      if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = previous;
    }
  });

  it("falls back to env when no explicit value", () => {
    const previous = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "env-value";
    try {
      expect(resolveCloudflareToken()).toBe("env-value");
    } finally {
      if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = previous;
    }
  });

  it("returns undefined when no source set and no .env file present", () => {
    const previousToken = process.env.CLOUDFLARE_API_TOKEN;
    const previousZone = process.env.CLOUDFLARE_ZONE_ID;
    const previousHome = process.env.HOME;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ZONE_ID;
    process.env.HOME = "/nonexistent/path/for/test";
    try {
      expect(resolveCloudflareToken()).toBeUndefined();
      expect(resolveCloudflareZoneId()).toBeUndefined();
    } finally {
      if (previousToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = previousToken;
      if (previousZone !== undefined) process.env.CLOUDFLARE_ZONE_ID = previousZone;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

describe("CloudflareDnsClient", () => {
  it("throws when no API token is provided", () => {
    const previous = process.env.CLOUDFLARE_API_TOKEN;
    const previousHome = process.env.HOME;
    delete process.env.CLOUDFLARE_API_TOKEN;
    process.env.HOME = "/nonexistent/path/for/test";
    try {
      expect(() => new CloudflareDnsClient()).toThrow(CloudflareError);
    } finally {
      if (previous !== undefined) process.env.CLOUDFLARE_API_TOKEN = previous;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("listZones sends the bearer header and parses the result", async () => {
    let receivedAuth: string | undefined;
    const client = new CloudflareDnsClient({
      apiToken: "tok",
      fetchImpl: mockFetch((url, init) => {
        expect(url).toBe("https://api.cloudflare.com/client/v4/zones?name=wearetarr.com");
        receivedAuth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
        return {
          status: 200,
          body: envelope([{ id: "zid", name: "wearetarr.com", status: "active" }]),
        };
      }),
    });
    const zones = await client.listZones("wearetarr.com");
    expect(receivedAuth).toBe("Bearer tok");
    expect(zones).toHaveLength(1);
    expect(zones[0]?.id).toBe("zid");
  });

  it("findZoneIdByName returns the matching zone id", async () => {
    const client = new CloudflareDnsClient({
      apiToken: "tok",
      fetchImpl: mockFetch(() => ({
        status: 200,
        body: envelope([
          { id: "zid", name: "wearetarr.com", status: "active" },
        ]),
      })),
    });
    expect(await client.findZoneIdByName("wearetarr.com")).toBe("zid");
  });

  it("findZoneIdByName throws CloudflareError when no zone matches", async () => {
    const client = new CloudflareDnsClient({
      apiToken: "tok",
      fetchImpl: mockFetch(() => ({ status: 200, body: envelope([]) })),
    });
    await expect(client.findZoneIdByName("missing.com")).rejects.toThrow(/No Cloudflare zone/);
  });

  it("createDnsRecord posts the record body and returns the created record", async () => {
    let receivedBody: string | undefined;
    const client = new CloudflareDnsClient({
      apiToken: "tok",
      fetchImpl: mockFetch((url, init) => {
        expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zid/dns_records");
        expect(init?.method).toBe("POST");
        receivedBody = String(init?.body);
        return {
          status: 200,
          body: envelope({
            id: "rid",
            type: "CNAME",
            name: "nexus.wearetarr.com",
            content: "agent-orchestrator.workers.dev",
            ttl: 1,
            proxied: false,
          }),
        };
      }),
    });
    const created = await client.createDnsRecord("zid", {
      type: "CNAME",
      name: "nexus.wearetarr.com",
      content: "agent-orchestrator.workers.dev",
      proxied: false,
    });
    const sent = JSON.parse(receivedBody ?? "{}");
    expect(sent.type).toBe("CNAME");
    expect(sent.name).toBe("nexus.wearetarr.com");
    expect(sent.content).toBe("agent-orchestrator.workers.dev");
    expect(sent.ttl).toBe(1);
    expect(sent.proxied).toBe(false);
    expect(created.id).toBe("rid");
    expect(created.name).toBe("nexus.wearetarr.com");
  });

  it("listDnsRecords filters by name and type", async () => {
    const client = new CloudflareDnsClient({
      apiToken: "tok",
      fetchImpl: mockFetch((url) => {
        expect(url).toContain("/zones/zid/dns_records");
        expect(url).toContain("name=nexus.wearetarr.com");
        expect(url).toContain("type=CNAME");
        return { status: 200, body: envelope([]) };
      }),
    });
    const records = await client.listDnsRecords("zid", {
      name: "nexus.wearetarr.com",
      type: "CNAME",
    });
    expect(records).toEqual([]);
  });

  it("deleteDnsRecord issues a DELETE and treats success as void", async () => {
    let usedMethod: string | undefined;
    const client = new CloudflareDnsClient({
      apiToken: "tok",
      fetchImpl: mockFetch((url, init) => {
        expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zid/dns_records/rid");
        usedMethod = init?.method;
        return { status: 200, body: envelope({ id: "rid" }) };
      }),
    });
    await client.deleteDnsRecord("zid", "rid");
    expect(usedMethod).toBe("DELETE");
  });

  it("surfaces Cloudflare error envelopes as CloudflareError", async () => {
    const client = new CloudflareDnsClient({
      apiToken: "tok",
      fetchImpl: mockFetch(() => ({
        status: 400,
        body: JSON.stringify({
          success: false,
          errors: [{ code: 81057, message: "Record already exists." }],
          messages: [],
          result: null,
        }),
      })),
    });
    await expect(
      client.createDnsRecord("zid", {
        type: "CNAME",
        name: "nexus.wearetarr.com",
        content: "agent-orchestrator.workers.dev",
      }),
    ).rejects.toMatchObject({
      name: "CloudflareError",
      status: 400,
    });
  });
});
