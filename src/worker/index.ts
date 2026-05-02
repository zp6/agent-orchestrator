/**
 * Cloudflare Worker for serving the Hire-the-Fleet landing page
 * Deployed to serve the static landing page + handle client intake redirects
 */

import LANDING_PAGE_HTML from '../../docs/hire-the-fleet/index.html?raw';

/**
 * Handler for incoming HTTP requests
 */
export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const url = new URL(request.url);

    // Serve the landing page for root path
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(LANDING_PAGE_HTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        },
      });
    }

    // Redirect client intake form requests to GitHub issue template
    if (url.pathname === '/apply' || url.pathname === '/intake') {
      const githubUrl = 'https://github.com/rapartlu/agent-orchestrator/issues/new?labels=client-intake&template=client-intake.md';
      return new Response(null, {
        status: 302,
        headers: {
          'Location': githubUrl,
        },
      });
    }

    // Serve docs/hire-the-fleet files if they exist
    if (url.pathname.startsWith('/docs/')) {
      const docPath = url.pathname.slice(1); // Remove leading /
      // In production, these would be served from KV storage or bundled assets
      // For now, redirect unknown paths back to home
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/',
        },
      });
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'hire-the-fleet' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }

    // 404 for all other paths
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  },
};
