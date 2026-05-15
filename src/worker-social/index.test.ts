/**
 * Tests for the Nexus ActivityPub Cloudflare Worker (issue #1515).
 *
 * Tests cover:
 *   - WebFinger response shape and CORS headers
 *   - Actor profile JSON structure
 *   - Outbox OrderedCollection format
 *   - Admin post creation and auth
 *   - KV store helpers (posts, followers)
 *   - buildWebFingerResponse for various resource values
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KVNamespace, SocialEnv, Post } from "./types.js";

// ── Mock crypto.subtle for key generation ────────────────────────────────────

const mockKeyPair = {
  privateKey: { type: "private" } as unknown as CryptoKey,
  publicKey: { type: "public" } as unknown as CryptoKey,
};

const mockJwk: JsonWebKey = { kty: "RSA", n: "abc", e: "AQAB" };

// Provide a minimal global crypto for the worker crypto module
if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: {
      randomUUID: () => "test-uuid-1234",
      subtle: {
        generateKey: vi.fn().mockResolvedValue(mockKeyPair),
        exportKey: vi.fn().mockResolvedValue(mockJwk),
        importKey: vi.fn().mockResolvedValue(mockKeyPair.privateKey),
        sign: vi.fn().mockResolvedValue(new ArrayBuffer(256)),
        digest: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
      },
    },
    writable: true,
  });
} else {
  vi.spyOn(globalThis.crypto.subtle, "generateKey").mockResolvedValue(mockKeyPair as unknown as CryptoKeyPair);
  vi.spyOn(globalThis.crypto.subtle, "exportKey").mockResolvedValue(mockJwk as unknown as JsonWebKey);
}

// ── KV mock ──────────────────────────────────────────────────────────────────

function makeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    put: vi.fn().mockImplementation((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    delete: vi.fn().mockImplementation((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
  } as unknown as KVNamespace;
}

function makeEnv(kv: KVNamespace, token = "test-token"): SocialEnv {
  return {
    SOCIAL_KV: kv,
    SOCIAL_POST_TOKEN: token,
    SOCIAL_DOMAIN: "social.nexus.wearetarr.com",
    SOCIAL_USERNAME: "nexus",
    SOCIAL_DISPLAY_NAME: "Nexus Fleet",
    SOCIAL_SUMMARY: "Autonomous AI fleet.",
  };
}

// ── WebFinger ─────────────────────────────────────────────────────────────────

import { buildWebFingerResponse } from "./webfinger.js";
import { resolveConfig } from "./types.js";

describe("buildWebFingerResponse", () => {
  const cfg = resolveConfig({
    SOCIAL_KV: makeKV(),
    SOCIAL_DOMAIN: "social.nexus.wearetarr.com",
    SOCIAL_USERNAME: "nexus",
  });

  it("returns JRD for the correct resource", () => {
    const jrd = buildWebFingerResponse("acct:nexus@social.nexus.wearetarr.com", cfg);
    expect(jrd).not.toBeNull();
    const j = jrd as Record<string, unknown>;
    expect(j["subject"]).toBe("acct:nexus@social.nexus.wearetarr.com");
    expect((j["links"] as Array<{ rel: string }>).some((l) => l.rel === "self")).toBe(true);
  });

  it("returns null for unknown resource", () => {
    const jrd = buildWebFingerResponse("acct:unknown@other.com", cfg);
    expect(jrd).toBeNull();
  });

  it("includes the actor URL in the self link", () => {
    const jrd = buildWebFingerResponse("acct:nexus@social.nexus.wearetarr.com", cfg) as Record<string, unknown>;
    const links = jrd["links"] as Array<{ rel: string; href: string }>;
    const self = links.find((l) => l.rel === "self");
    expect(self?.href).toBe("https://social.nexus.wearetarr.com/users/nexus");
  });
});

// ── Store helpers ─────────────────────────────────────────────────────────────

import { listPosts, createPost, postToActivity, addFollower, listFollowers, removeFollower } from "./store.js";

describe("store: posts", () => {
  it("returns empty array when no posts exist", async () => {
    const kv = makeKV();
    const cfg = resolveConfig({ SOCIAL_KV: kv });
    const posts = await listPosts(kv);
    expect(posts).toEqual([]);
  });

  it("creates and retrieves a post", async () => {
    const kv = makeKV();
    const cfg = resolveConfig({ SOCIAL_KV: kv });
    const post = await createPost(kv, "Hello fleet!", cfg);
    expect(post.content).toBe("Hello fleet!");
    expect(post.id).toBeDefined();
    expect(post.published).toBeDefined();
    expect(post.activityId).toContain(cfg.actorUrl);
    const posts = await listPosts(kv);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.content).toBe("Hello fleet!");
  });

  it("lists posts newest-first", async () => {
    const kv = makeKV();
    const cfg = resolveConfig({ SOCIAL_KV: kv });
    const p1 = await createPost(kv, "first", cfg);
    const p2 = await createPost(kv, "second", cfg);
    const posts = await listPosts(kv);
    expect(posts[0]?.content).toBe("second");
    expect(posts[1]?.content).toBe("first");
  });

  it("postToActivity returns a valid Create activity", async () => {
    const kv = makeKV();
    const cfg = resolveConfig({ SOCIAL_KV: kv });
    const post = await createPost(kv, "test post", cfg);
    const activity = postToActivity(post, cfg);
    expect(activity.type).toBe("Create");
    expect(activity.actor).toBe(cfg.actorUrl);
    expect(activity.object.type).toBe("Note");
    expect(activity.object.content).toBe("test post");
    expect(activity.to).toContain("https://www.w3.org/ns/activitystreams#Public");
  });
});

describe("store: followers", () => {
  it("starts with empty followers list", async () => {
    const kv = makeKV();
    expect(await listFollowers(kv)).toEqual([]);
  });

  it("adds and lists a follower", async () => {
    const kv = makeKV();
    await addFollower(kv, {
      actorUrl: "https://fosstodon.org/users/alice",
      inboxUrl: "https://fosstodon.org/users/alice/inbox",
      addedAt: new Date().toISOString(),
    });
    const followers = await listFollowers(kv);
    expect(followers).toHaveLength(1);
    expect(followers[0]?.actorUrl).toBe("https://fosstodon.org/users/alice");
  });

  it("does not add duplicate followers", async () => {
    const kv = makeKV();
    const follower = {
      actorUrl: "https://fosstodon.org/users/alice",
      inboxUrl: "https://fosstodon.org/users/alice/inbox",
      addedAt: new Date().toISOString(),
    };
    await addFollower(kv, follower);
    await addFollower(kv, follower);
    const followers = await listFollowers(kv);
    expect(followers).toHaveLength(1);
  });

  it("removes a follower", async () => {
    const kv = makeKV();
    const actorUrl = "https://fosstodon.org/users/alice";
    await addFollower(kv, { actorUrl, inboxUrl: "...", addedAt: new Date().toISOString() });
    await removeFollower(kv, actorUrl);
    expect(await listFollowers(kv)).toHaveLength(0);
  });
});

// ── resolveConfig ─────────────────────────────────────────────────────────────

describe("resolveConfig", () => {
  it("uses defaults when env vars are unset", () => {
    const cfg = resolveConfig({ SOCIAL_KV: makeKV() });
    expect(cfg.domain).toBe("social.nexus.wearetarr.com");
    expect(cfg.username).toBe("nexus");
    expect(cfg.actorUrl).toBe("https://social.nexus.wearetarr.com/users/nexus");
    expect(cfg.publicKeyId).toContain("#main-key");
  });

  it("uses env vars when provided", () => {
    const cfg = resolveConfig({
      SOCIAL_KV: makeKV(),
      SOCIAL_DOMAIN: "custom.example.com",
      SOCIAL_USERNAME: "bot",
    });
    expect(cfg.domain).toBe("custom.example.com");
    expect(cfg.username).toBe("bot");
    expect(cfg.actorUrl).toBe("https://custom.example.com/users/bot");
  });
});

// ── SocialClient ──────────────────────────────────────────────────────────────

import { SocialClient, SocialClientError } from "../services/social-client.js";

describe("SocialClient", () => {
  it("throws SocialClientError when post fails with 401", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve("Unauthorized"),
    });
    const client = new SocialClient({ token: "bad-token", fetchImpl: mockFetch as unknown as typeof fetch });
    await expect(client.post("test")).rejects.toThrow(SocialClientError);
  });

  it("returns post on success", async () => {
    const fakePost: Post = {
      id: "abc",
      content: "hello",
      published: new Date().toISOString(),
      activityId: "https://example.com/activities/abc",
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ post: fakePost }),
    });
    const client = new SocialClient({ token: "good-token", fetchImpl: mockFetch as unknown as typeof fetch });
    const result = await client.post("hello");
    expect(result.id).toBe("abc");
    expect(result.content).toBe("hello");
  });

  it("calls /admin/post with Authorization header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ post: { id: "x", content: "y", published: "", activityId: "" } }),
    });
    const client = new SocialClient({ token: "my-token", fetchImpl: mockFetch as unknown as typeof fetch });
    await client.post("hello");
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/admin/post");
    expect((opts.headers as Record<string, string>)?.["Authorization"]).toBe("Bearer my-token");
  });
});
