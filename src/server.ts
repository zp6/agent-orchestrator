/**
 * Public PR Review API — lightweight HTTP server
 * (issue #599 / agent-proxy#504 / orchestrator#1302)
 *
 * Serves the reviewer's PR Review API and fleet config endpoints so they can
 * be deployed as a standalone public service on Render.io, Railway, or any
 * Docker-compatible host.
 *
 * Endpoints:
 *   GET  /           — revenue landing page (docs/revenue-landing.html)
 *   GET  /health     — liveness probe: { status: "ok", uptime_s, version }
 *   GET  /api/fleet-config — fleet wallet address + revenue URLs
 *   GET  /api/pr-review/info — PR Review API pricing and payment details
 *
 * Configuration (env vars):
 *   PORT                    — HTTP port (default: 3474)
 *   FLEET_WALLET_ADDRESS    — EVM wallet address (Base network)
 *   FLEET_WALLET_NETWORK    — e.g. "Base"
 *   FLEET_GITHUB_SPONSORS_URL
 *   FLEET_POLAR_URL
 *   FLEET_ALGORA_URL
 *   FLEET_GITCOIN_URL
 *
 * Start:
 *   npm run build && npm start
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_TIME = Date.now();
const PORT = parseInt(process.env.PORT ?? "3474", 10);

// ── Fleet config (reads from env, no external deps needed) ───────────────────

interface FleetConfig {
  wallet_address: string;
  wallet_network: string;
  configured: boolean;
  github_sponsors_url: string;
  polar_url: string;
  algora_url: string;
  gitcoin_url: string;
  computed_at: string;
}

function buildFleetConfig(): FleetConfig {
  const wallet_address = process.env.FLEET_WALLET_ADDRESS?.trim() ?? "";
  return {
    wallet_address,
    wallet_network: process.env.FLEET_WALLET_NETWORK?.trim() ?? "",
    configured: wallet_address.length > 0,
    github_sponsors_url: process.env.FLEET_GITHUB_SPONSORS_URL?.trim() ?? "",
    polar_url: process.env.FLEET_POLAR_URL?.trim() ?? "",
    algora_url: process.env.FLEET_ALGORA_URL?.trim() ?? "",
    gitcoin_url: process.env.FLEET_GITCOIN_URL?.trim() ?? "",
    computed_at: new Date().toISOString(),
  };
}

// ── PR Review API info ────────────────────────────────────────────────────────

interface PRReviewApiInfo {
  service: string;
  description: string;
  version: string;
  tiers: Array<{
    name: string;
    price_usd: number;
    features: string[];
  }>;
  payment: {
    wallet_address: string;
    network: string;
    tokens_accepted: string[];
  };
  endpoints: Array<{ method: string; path: string; description: string }>;
  contact: string;
}

function buildPRReviewApiInfo(): PRReviewApiInfo {
  const wallet_address = process.env.FLEET_WALLET_ADDRESS?.trim() ?? "";
  return {
    service: "claude-orchestrator PR Review API",
    description:
      "LLM-powered PR review service. Submit a GitHub PR URL and receive " +
      "structured review feedback: correctness, completeness, code quality, " +
      "and test coverage scores with actionable suggestions.",
    version: "1.0.0",
    tiers: [
      {
        name: "basic",
        price_usd: 0.10,
        features: [
          "LLM diff analysis",
          "Pass/fail verdict",
          "Score breakdown (4 dimensions)",
          "Top 3 actionable suggestions",
        ],
      },
      {
        name: "deep",
        price_usd: 0.50,
        features: [
          "Everything in basic",
          "Security pattern scan",
          "Scope contract validation",
          "Full inline comment list",
          "Re-review after requested changes",
        ],
      },
    ],
    payment: {
      wallet_address,
      network: process.env.FLEET_WALLET_NETWORK?.trim() ?? "Base",
      tokens_accepted: ["USDC", "DAI", "ETH"],
    },
    endpoints: [
      { method: "GET", path: "/api/pr-review/info", description: "This endpoint — service info and pricing" },
      { method: "GET", path: "/api/fleet-config", description: "Fleet wallet address and revenue URLs" },
      { method: "GET", path: "/health", description: "Liveness probe" },
    ],
    contact: "https://github.com/rapartlu/agent-reviewer/issues",
  };
}

// ── Static file: revenue landing page ────────────────────────────────────────

function readLandingPage(): string | null {
  // Try dist/ path first (when running from dist/server.js), then root docs/
  const candidates = [
    path.resolve(__dirname, "..", "docs", "revenue-landing.html"),
    path.resolve(__dirname, "docs", "revenue-landing.html"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8");
    }
  }
  return null;
}

// ── Request handler ───────────────────────────────────────────────────────────

function respond(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = "application/json"
): void {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  });
  res.end(buf);
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (method !== "GET") {
    respond(res, 405, JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  // Strip query string
  const pathname = url.split("?")[0];

  switch (pathname) {
    case "/":
    case "/index.html": {
      const html = readLandingPage();
      if (html) {
        respond(res, 200, html, "text/html; charset=utf-8");
      } else {
        // Fallback: minimal redirect to GitHub
        const fallback = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=https://github.com/rapartlu/agent-reviewer">
<title>claude-orchestrator PR Review API</title></head>
<body><p>Redirecting to <a href="https://github.com/rapartlu/agent-reviewer">GitHub</a>...</p></body></html>`;
        respond(res, 200, fallback, "text/html; charset=utf-8");
      }
      break;
    }

    case "/health": {
      const body = JSON.stringify({
        status: "ok",
        uptime_s: Math.floor((Date.now() - START_TIME) / 1000),
        version: "1.0.0",
        port: PORT,
      });
      respond(res, 200, body);
      break;
    }

    case "/api/fleet-config": {
      respond(res, 200, JSON.stringify(buildFleetConfig(), null, 2));
      break;
    }

    case "/api/pr-review/info": {
      respond(res, 200, JSON.stringify(buildPRReviewApiInfo(), null, 2));
      break;
    }

    default:
      respond(res, 404, JSON.stringify({ error: "Not Found", path: pathname }));
  }
}

// ── Server startup ────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  const wallet = process.env.FLEET_WALLET_ADDRESS?.trim();
  console.log(`[pr-review-api] listening on port ${PORT}`);
  console.log(`[pr-review-api] wallet: ${wallet ?? "(not configured — set FLEET_WALLET_ADDRESS)"}`);
  console.log("[pr-review-api] endpoints:");
  console.log(`  GET http://0.0.0.0:${PORT}/health`);
  console.log(`  GET http://0.0.0.0:${PORT}/api/pr-review/info`);
  console.log(`  GET http://0.0.0.0:${PORT}/api/fleet-config`);
  console.log(`  GET http://0.0.0.0:${PORT}/          (revenue landing page)`);
});

server.on("error", (err) => {
  console.error(`[pr-review-api] server error: ${err.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[pr-review-api] SIGTERM received — shutting down");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
