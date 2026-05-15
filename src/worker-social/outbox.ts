/**
 * ActivityPub Outbox handler (issue #1515).
 *
 * Returns an OrderedCollection of the actor's posts.
 * https://www.w3.org/TR/activitypub/#outbox
 */

import type { SocialConfig } from "./types.js";
import type { KVNamespace } from "./types.js";
import { listPosts, postToActivity } from "./store.js";

export async function handleOutbox(
  _request: Request,
  kv: KVNamespace,
  cfg: SocialConfig,
): Promise<Response> {
  const posts = await listPosts(kv, 20);
  const activities = posts.map((p) => postToActivity(p, cfg));

  const collection = {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "OrderedCollection",
    id: `${cfg.actorUrl}/outbox`,
    totalItems: activities.length,
    orderedItems: activities,
  };

  return new Response(JSON.stringify(collection), {
    status: 200,
    headers: {
      "Content-Type": "application/activity+json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=30",
    },
  });
}

export async function handleFollowers(
  _request: Request,
  kv: KVNamespace,
  cfg: SocialConfig,
): Promise<Response> {
  const { listFollowers } = await import("./store.js");
  const followers = await listFollowers(kv);
  const collection = {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "OrderedCollection",
    id: `${cfg.actorUrl}/followers`,
    totalItems: followers.length,
    orderedItems: followers.map((f) => f.actorUrl),
  };
  return new Response(JSON.stringify(collection), {
    status: 200,
    headers: { "Content-Type": "application/activity+json" },
  });
}

export function handleFollowing(cfg: SocialConfig): Response {
  const collection = {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "OrderedCollection",
    id: `${cfg.actorUrl}/following`,
    totalItems: 0,
    orderedItems: [],
  };
  return new Response(JSON.stringify(collection), {
    status: 200,
    headers: { "Content-Type": "application/activity+json" },
  });
}
