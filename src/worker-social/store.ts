/**
 * KV storage helpers for posts, followers, and coordination state (issue #1515).
 */

import type { KVNamespace, Post, CreateActivity } from "./types.js";
import type { SocialConfig } from "./types.js";

const POST_LIST_KEY = "posts:list";
const MAX_POSTS = 500;

// ── Posts ─────────────────────────────────────────────────────────────────────

/** List posts newest-first. */
export async function listPosts(kv: KVNamespace, limit = 20): Promise<Post[]> {
  const raw = await kv.get(POST_LIST_KEY);
  if (!raw) return [];
  const all = JSON.parse(raw) as Post[];
  return all.slice(0, limit);
}

/** Create a new post and prepend it to the post list. */
export async function createPost(
  kv: KVNamespace,
  content: string,
  cfg: SocialConfig,
): Promise<Post> {
  const id = crypto.randomUUID();
  const published = new Date().toISOString();
  const activityId = `${cfg.actorUrl}/activities/${id}`;

  const post: Post = { id, content, published, activityId };

  const raw = await kv.get(POST_LIST_KEY);
  const all: Post[] = raw ? (JSON.parse(raw) as Post[]) : [];
  all.unshift(post);
  // Cap to avoid unbounded KV growth
  const trimmed = all.slice(0, MAX_POSTS);
  await kv.put(POST_LIST_KEY, JSON.stringify(trimmed));

  return post;
}

/** Build an ActivityPub CreateActivity from a Post. */
export function postToActivity(post: Post, cfg: SocialConfig): CreateActivity {
  const noteId = `${cfg.actorUrl}/notes/${post.id}`;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Create",
    id: post.activityId,
    actor: cfg.actorUrl,
    published: post.published,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${cfg.actorUrl}/followers`],
    object: {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Note",
      id: noteId,
      attributedTo: cfg.actorUrl,
      content: post.content,
      published: post.published,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${cfg.actorUrl}/followers`],
    },
  };
}

// ── Followers ─────────────────────────────────────────────────────────────────

const FOLLOWERS_KEY = "followers:list";

export interface Follower {
  actorUrl: string;
  inboxUrl: string;
  addedAt: string;
}

export async function listFollowers(kv: KVNamespace): Promise<Follower[]> {
  const raw = await kv.get(FOLLOWERS_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as Follower[];
}

export async function addFollower(kv: KVNamespace, follower: Follower): Promise<void> {
  const followers = await listFollowers(kv);
  const exists = followers.some((f) => f.actorUrl === follower.actorUrl);
  if (!exists) {
    followers.push(follower);
    await kv.put(FOLLOWERS_KEY, JSON.stringify(followers));
  }
}

export async function removeFollower(kv: KVNamespace, actorUrl: string): Promise<void> {
  const followers = await listFollowers(kv);
  const filtered = followers.filter((f) => f.actorUrl !== actorUrl);
  await kv.put(FOLLOWERS_KEY, JSON.stringify(filtered));
}
