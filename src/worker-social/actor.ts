/**
 * ActivityPub Actor profile handler (issue #1515).
 *
 * Serves the actor JSON at /users/:username.
 * https://www.w3.org/TR/activitypub/#actor-objects
 */

import type { Actor, SocialConfig } from "./types.js";
import type { KVNamespace } from "./types.js";
import { getPublicKeyPem } from "./crypto.js";

export async function buildActor(kv: KVNamespace, cfg: SocialConfig): Promise<Actor> {
  const publicKeyPem = await getPublicKeyPem(kv);
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    type: "Person",
    id: cfg.actorUrl,
    url: cfg.actorUrl,
    name: cfg.displayName,
    preferredUsername: cfg.username,
    summary: cfg.summary,
    inbox: `${cfg.actorUrl}/inbox`,
    outbox: `${cfg.actorUrl}/outbox`,
    followers: `${cfg.actorUrl}/followers`,
    following: `${cfg.actorUrl}/following`,
    publicKey: {
      id: cfg.publicKeyId,
      owner: cfg.actorUrl,
      publicKeyPem,
    },
  };
}

export async function handleActor(
  request: Request,
  kv: KVNamespace,
  cfg: SocialConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const expectedPath = `/users/${cfg.username}`;
  if (url.pathname !== expectedPath) {
    return new Response("Not Found", { status: 404 });
  }

  const accept = request.headers.get("Accept") ?? "";
  const wantsActivityJson =
    accept.includes("application/activity+json") ||
    accept.includes("application/ld+json") ||
    accept.includes("application/json");

  // HTML browsers get a simple profile page
  if (!wantsActivityJson) {
    const html = `<!doctype html><html><body>
<h1>${cfg.displayName} (@${cfg.username}@${cfg.domain})</h1>
<p>${cfg.summary}</p>
<p>ActivityPub handle: <code>@${cfg.username}@${cfg.domain}</code></p>
</body></html>`;
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const actor = await buildActor(kv, cfg);
  return new Response(JSON.stringify(actor), {
    status: 200,
    headers: {
      "Content-Type": "application/activity+json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    },
  });
}
