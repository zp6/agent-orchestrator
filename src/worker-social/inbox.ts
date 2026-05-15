/**
 * ActivityPub Inbox handler (issue #1515).
 *
 * Accepts Follow activities from remote actors and responds with Accept
 * activities, enabling federation with servers like fosstodon.org.
 *
 * https://www.w3.org/TR/activitypub/#inbox
 */

import type { SocialConfig } from "./types.js";
import type { KVNamespace } from "./types.js";
import { addFollower, removeFollower, type Follower } from "./store.js";
import { getOrCreateKeyPair, deliverActivity } from "./crypto.js";

interface ActivityPubActivity {
  type: string;
  id?: string;
  actor?: string;
  object?: unknown;
}

/** Resolve the `inbox` URL for a remote actor by fetching their profile. */
async function resolveActorInbox(actorUrl: string): Promise<string | null> {
  try {
    const res = await fetch(actorUrl, {
      headers: { Accept: "application/activity+json" },
    });
    if (!res.ok) return null;
    const actor = await res.json() as { inbox?: string };
    return actor.inbox ?? null;
  } catch {
    return null;
  }
}

export async function handleInbox(
  request: Request,
  kv: KVNamespace,
  cfg: SocialConfig,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let activity: ActivityPubActivity;
  try {
    activity = await request.json() as ActivityPubActivity;
  } catch {
    return new Response("Bad Request: invalid JSON", { status: 400 });
  }

  const actorUrl = typeof activity.actor === "string" ? activity.actor : null;

  switch (activity.type) {
    case "Follow": {
      if (!actorUrl) {
        return new Response("Bad Request: missing actor", { status: 400 });
      }

      // Resolve the follower's inbox for delivering the Accept
      const inboxUrl = await resolveActorInbox(actorUrl);
      if (inboxUrl) {
        const follower: Follower = {
          actorUrl,
          inboxUrl,
          addedAt: new Date().toISOString(),
        };
        await addFollower(kv, follower);

        // Deliver Accept back to the follower's inbox
        const { privateKeyJwk } = await getOrCreateKeyPair(kv);
        const accept = {
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "Accept",
          id: `${cfg.actorUrl}/activities/${crypto.randomUUID()}`,
          actor: cfg.actorUrl,
          object: activity,
        };
        // Fire-and-forget; do not block the response
        deliverActivity({
          inboxUrl,
          activity: accept,
          keyId: cfg.publicKeyId,
          privateKeyJwk,
        }).catch(() => {
          // Non-fatal: follower stored even if Accept delivery fails
        });
      }

      return new Response(null, { status: 202 });
    }

    case "Undo": {
      // Undo a Follow — unfollow
      const objectActivity = activity.object as ActivityPubActivity | undefined;
      if (objectActivity?.type === "Follow" && actorUrl) {
        await removeFollower(kv, actorUrl);
      }
      return new Response(null, { status: 202 });
    }

    case "Create":
    case "Announce":
    case "Like":
      // Accepted but not processed in this minimal implementation
      return new Response(null, { status: 202 });

    default:
      return new Response(null, { status: 202 });
  }
}
