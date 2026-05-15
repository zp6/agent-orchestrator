/**
 * HTTP client for the Nexus ActivityPub Worker (issue #1515).
 *
 * Used by `orch social` CLI commands to interact with the running worker at
 * social.nexus.wearetarr.com. Auth token is resolved from:
 *   1. explicit option passed to constructor
 *   2. SOCIAL_POST_TOKEN env var
 *   3. ~/.claude-orchestrator/.env (SOCIAL_POST_TOKEN=...)
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

export interface SocialPost {
  id: string;
  content: string;
  published: string;
  activityId: string;
}

export interface SocialStatus {
  ok: boolean;
  handle: string;
  actorUrl: string;
  followerCount: number;
  hasRecentPost: boolean;
  latestPost: string | null;
}

export class SocialClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SocialClientError";
  }
}

function resolveToken(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env["SOCIAL_POST_TOKEN"]) return process.env["SOCIAL_POST_TOKEN"];

  // Fall back to ~/.claude-orchestrator/.env
  try {
    const envPath = resolve(join(homedir(), ".claude-orchestrator", ".env"));
    const content = readFileSync(envPath, "utf-8");
    const match = /^SOCIAL_POST_TOKEN=(.+)$/m.exec(content);
    if (match?.[1]) return match[1].trim();
  } catch {
    // File not found or unreadable — skip
  }

  throw new SocialClientError(
    "SOCIAL_POST_TOKEN not found. Set it via --token, SOCIAL_POST_TOKEN env, " +
      "or ~/.claude-orchestrator/.env",
  );
}

export class SocialClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl?: string; token?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://social.nexus.wearetarr.com").replace(/\/$/, "");
    this.token = resolveToken(opts.token);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Create a new post. Returns the created post record. */
  async post(content: string): Promise<SocialPost> {
    const res = await this.fetchImpl(`${this.baseUrl}/admin/post`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ content }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SocialClientError(`Post failed: ${text || res.statusText}`, res.status);
    }

    const data = await res.json() as { post: SocialPost };
    return data.post;
  }

  /** Fetch worker status (no auth required). */
  async status(): Promise<SocialStatus> {
    const res = await this.fetchImpl(`${this.baseUrl}/admin/status`);
    if (!res.ok) {
      throw new SocialClientError(`Status check failed: ${res.statusText}`, res.status);
    }
    return res.json() as Promise<SocialStatus>;
  }

  /** Fetch the outbox (recent posts). */
  async posts(limit = 10): Promise<SocialPost[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/users/nexus/outbox`, {
      headers: { Accept: "application/activity+json" },
    });
    if (!res.ok) {
      throw new SocialClientError(`Outbox fetch failed: ${res.statusText}`, res.status);
    }
    const collection = await res.json() as {
      orderedItems?: Array<{ object?: SocialPost }>;
    };
    return (collection.orderedItems ?? [])
      .map((item) => item.object)
      .filter((o): o is SocialPost => !!o)
      .slice(0, limit);
  }
}
