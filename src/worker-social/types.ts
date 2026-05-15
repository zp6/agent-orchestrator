/**
 * Shared types for the Nexus ActivityPub Cloudflare Worker (issue #1515).
 */

/** KV namespace interface (subset of Cloudflare Workers KVNamespace). */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  put(key: string, value: string, opts: { expirationTtl?: number }): Promise<void>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<void>;
}

/** Worker environment bindings. */
export interface SocialEnv {
  SOCIAL_KV: KVNamespace;
  /** Bearer token required by the admin /admin/post endpoint. */
  SOCIAL_POST_TOKEN?: string;
  SOCIAL_DOMAIN?: string;
  SOCIAL_USERNAME?: string;
  SOCIAL_DISPLAY_NAME?: string;
  SOCIAL_SUMMARY?: string;
}

/** Resolved config with defaults applied. */
export interface SocialConfig {
  domain: string;
  username: string;
  displayName: string;
  summary: string;
  actorUrl: string;
  publicKeyId: string;
}

export function resolveConfig(env: SocialEnv): SocialConfig {
  const domain = env.SOCIAL_DOMAIN ?? "social.nexus.wearetarr.com";
  const username = env.SOCIAL_USERNAME ?? "nexus";
  const actorUrl = `https://${domain}/users/${username}`;
  return {
    domain,
    username,
    displayName: env.SOCIAL_DISPLAY_NAME ?? "Nexus Fleet",
    summary: env.SOCIAL_SUMMARY ?? "Autonomous AI fleet.",
    actorUrl,
    publicKeyId: `${actorUrl}#main-key`,
  };
}

/** Stored post record. */
export interface Post {
  id: string;
  content: string;
  published: string;
  activityId: string;
}

/** ActivityPub Note. */
export interface Note {
  "@context": string;
  type: "Note";
  id: string;
  attributedTo: string;
  content: string;
  published: string;
  to: string[];
  cc: string[];
}

/** ActivityPub Create activity wrapping a Note. */
export interface CreateActivity {
  "@context": string;
  type: "Create";
  id: string;
  actor: string;
  published: string;
  to: string[];
  cc: string[];
  object: Note;
}

/** ActivityPub Actor (Person). */
export interface Actor {
  "@context": string[];
  type: "Person";
  id: string;
  url: string;
  name: string;
  preferredUsername: string;
  summary: string;
  inbox: string;
  outbox: string;
  followers: string;
  following: string;
  publicKey: {
    id: string;
    owner: string;
    publicKeyPem: string;
  };
}
