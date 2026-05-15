/**
 * WebFinger handler (issue #1515).
 *
 * Responds to `/.well-known/webfinger?resource=acct:nexus@social.nexus.wearetarr.com`
 * with a JRD that points to the ActivityPub actor endpoint.
 *
 * https://www.rfc-editor.org/rfc/rfc7033
 */

import type { SocialConfig } from "./types.js";

export function buildWebFingerResponse(resource: string, cfg: SocialConfig): object | null {
  const expectedAcct = `acct:${cfg.username}@${cfg.domain}`;
  if (resource !== expectedAcct) return null;

  return {
    subject: expectedAcct,
    aliases: [cfg.actorUrl],
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: cfg.actorUrl,
      },
      {
        rel: "http://webfinger.net/rel/profile-page",
        type: "text/html",
        href: cfg.actorUrl,
      },
    ],
  };
}

export function handleWebFinger(request: Request, cfg: SocialConfig): Response {
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource") ?? "";
  const jrd = buildWebFingerResponse(resource, cfg);

  if (!jrd) {
    return new Response(
      JSON.stringify({ error: "Unknown resource", resource }),
      { status: 404, headers: { "Content-Type": "application/jrd+json" } },
    );
  }

  return new Response(JSON.stringify(jrd), {
    status: 200,
    headers: {
      "Content-Type": "application/jrd+json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
