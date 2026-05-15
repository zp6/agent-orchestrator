/**
 * Admin endpoints for the ActivityPub worker (issue #1515).
 *
 * POST /admin/post — create a new Note and deliver to followers
 *   Body: { content: string }
 *   Auth: Authorization: Bearer <SOCIAL_POST_TOKEN>
 *
 * GET /admin/status — health and basic stats (no auth required)
 */

import type { SocialConfig, SocialEnv } from "./types.js";
import { createPost, postToActivity, listFollowers } from "./store.js";
import { getOrCreateKeyPair, deliverActivity } from "./crypto.js";

/** Verify the bearer token from the Authorization header. */
function checkAuth(request: Request, env: SocialEnv): boolean {
  const token = env.SOCIAL_POST_TOKEN;
  if (!token) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match?.[1] === token;
}

interface PostBody {
  content?: unknown;
}

export async function handleAdminPost(
  request: Request,
  env: SocialEnv,
  cfg: SocialConfig,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!checkAuth(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: PostBody;
  try {
    body = await request.json() as PostBody;
  } catch {
    return new Response("Bad Request: invalid JSON", { status: 400 });
  }

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return new Response("Bad Request: content is required", { status: 400 });
  }
  if (content.length > 5000) {
    return new Response("Bad Request: content too long (max 5000 chars)", { status: 400 });
  }

  const post = await createPost(env.SOCIAL_KV, content, cfg);
  const activity = postToActivity(post, cfg);

  // Deliver to followers — fire-and-forget, do not block the API response
  const followers = await listFollowers(env.SOCIAL_KV);
  if (followers.length > 0) {
    const { privateKeyJwk } = await getOrCreateKeyPair(env.SOCIAL_KV);
    for (const follower of followers) {
      deliverActivity({
        inboxUrl: follower.inboxUrl,
        activity,
        keyId: cfg.publicKeyId,
        privateKeyJwk,
      }).catch(() => {
        // Non-fatal: posts are stored in KV; followers can refetch outbox
      });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, post }),
    {
      status: 201,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function handleAdminStatus(
  _request: Request,
  env: SocialEnv,
  cfg: SocialConfig,
): Promise<Response> {
  const followers = await listFollowers(env.SOCIAL_KV);
  const { listPosts } = await import("./store.js");
  const posts = await listPosts(env.SOCIAL_KV, 1);

  return new Response(
    JSON.stringify({
      ok: true,
      handle: `@${cfg.username}@${cfg.domain}`,
      actorUrl: cfg.actorUrl,
      followerCount: followers.length,
      hasRecentPost: posts.length > 0,
      latestPost: posts[0]?.published ?? null,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
