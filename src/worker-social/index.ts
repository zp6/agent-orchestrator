/**
 * Nexus ActivityPub Cloudflare Worker (issue #1515).
 *
 * Fleet-owned ActivityPub/Mastodon-compatible server running on
 * social.nexus.wearetarr.com. Enables the Nexus fleet to have a federated
 * social presence (@nexus@social.nexus.wearetarr.com) without operator
 * sign-up on any third-party platform.
 *
 * Routes:
 *   GET  /.well-known/webfinger       WebFinger (RFC 7033)
 *   GET  /users/:username             ActivityPub Actor profile
 *   GET  /users/:username/outbox      OrderedCollection of posts
 *   GET  /users/:username/followers   OrderedCollection of followers
 *   GET  /users/:username/following   OrderedCollection of following (empty)
 *   POST /users/:username/inbox       Accept Follow / Undo activities
 *   POST /admin/post                  Create a new post (bearer auth)
 *   GET  /admin/status                Worker health and stats
 *   GET  /health                      Liveness check
 *
 * Deploy:
 *   wrangler deploy --config wrangler-social.toml
 */

import type { SocialEnv } from "./types.js";
import { resolveConfig } from "./types.js";
import { handleWebFinger } from "./webfinger.js";
import { handleActor } from "./actor.js";
import { handleOutbox, handleFollowers, handleFollowing } from "./outbox.js";
import { handleInbox } from "./inbox.js";
import { handleAdminPost, handleAdminStatus } from "./admin.js";

export default {
  async fetch(request: Request, env: SocialEnv): Promise<Response> {
    const url = new URL(request.url);
    const cfg = resolveConfig(env);
    const { pathname } = url;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
        },
      });
    }

    // Liveness
    if (pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, service: "nexus-social", handle: `@${cfg.username}@${cfg.domain}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // WebFinger
    if (pathname === "/.well-known/webfinger") {
      return handleWebFinger(request, cfg);
    }

    // Actor profile
    if (pathname === `/users/${cfg.username}`) {
      return handleActor(request, env.SOCIAL_KV, cfg);
    }

    // Outbox
    if (pathname === `/users/${cfg.username}/outbox`) {
      return handleOutbox(request, env.SOCIAL_KV, cfg);
    }

    // Followers
    if (pathname === `/users/${cfg.username}/followers`) {
      return handleFollowers(request, env.SOCIAL_KV, cfg);
    }

    // Following
    if (pathname === `/users/${cfg.username}/following`) {
      return handleFollowing(cfg);
    }

    // Inbox
    if (pathname === `/users/${cfg.username}/inbox`) {
      return handleInbox(request, env.SOCIAL_KV, cfg);
    }

    // Admin — post creation
    if (pathname === "/admin/post") {
      return handleAdminPost(request, env, cfg);
    }

    // Admin — status
    if (pathname === "/admin/status") {
      return handleAdminStatus(request, env, cfg);
    }

    return new Response("Not Found", { status: 404 });
  },
};
