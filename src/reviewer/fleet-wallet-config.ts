/**
 * Fleet wallet config — payload builder for the reviewer metrics endpoint.
 * (issue #594 / agent-dashboard#674 / agent-orchestrator#1331)
 *
 * Surfaces the fleet's canonical wallet address and network so that:
 *   1. The orchestrator's metrics server can expose it at `GET /api/fleet-config`
 *      alongside quality scores, health sparklines, and dashboard data.
 *   2. Any agent that imports from this package can call `getFleetWalletConfig()`
 *      without repeating env-var reading logic.
 *   3. Tests can inject a config object instead of relying on process.env.
 *
 * Priority order for the wallet address:
 *   1. `config.fleet.wallet_address`   — passed programmatically by the orchestrator
 *   2. `FLEET_WALLET_ADDRESS` env var  — set in agents.yaml providers.global
 *   3. Empty string                    — surfaced as "not configured" in the payload
 *
 * Usage (payload builder for HTTP server):
 *
 *   import { getFleetWalletConfigPayload } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/api/fleet-config', (_req, res) => {
 *     res.json(getFleetWalletConfigPayload(reviewerConfig));
 *   });
 *
 * Usage (direct accessor):
 *
 *   import { resolveWalletAddress } from 'claude-orchestrator-reviewer';
 *
 *   const addr = resolveWalletAddress(reviewerConfig);
 */

import type { ReviewerConfig } from "../config.js";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Structured fleet wallet configuration.
 * Returned by `getFleetWalletConfigPayload()` and used by the metrics endpoint.
 */
export interface FleetWalletConfig {
  /** Crypto wallet address (EVM-compatible, e.g. "0x..."). Empty string = not configured. */
  wallet_address: string;
  /** Network name, e.g. "Base", "Ethereum". Empty string = not configured. */
  wallet_network: string;
  /**
   * True when `wallet_address` is a non-empty string.
   * Convenience flag so dashboard consumers don't need to string-check.
   */
  configured: boolean;
}

/**
 * Full payload returned by `GET /api/fleet-config`.
 * Extends FleetWalletConfig with revenue-URL fields.
 */
export interface FleetConfigPayload extends FleetWalletConfig {
  /** GitHub Sponsors profile URL. Empty string = not configured. */
  github_sponsors_url: string;
  /** Polar.sh page URL. Empty string = not configured. */
  polar_url: string;
  /** Algora bounty profile URL. Empty string = not configured. */
  algora_url: string;
  /** Gitcoin grants page URL. Empty string = not configured. */
  gitcoin_url: string;
  /** ISO-8601 timestamp when this payload was computed. */
  computed_at: string;
}

// ── Accessors ─────────────────────────────────────────────────────────────────

/**
 * Resolve the fleet wallet address from config (programmatic) or env var.
 *
 * Priority:
 *   1. `config?.fleet?.wallet_address`
 *   2. `process.env.FLEET_WALLET_ADDRESS`
 *   3. `""` (empty string — not configured)
 */
export function resolveWalletAddress(config?: ReviewerConfig | null): string {
  return (
    config?.fleet?.wallet_address?.trim() ||
    process.env.FLEET_WALLET_ADDRESS?.trim() ||
    ""
  );
}

/**
 * Resolve the fleet wallet network from config or env var.
 *
 * Priority:
 *   1. `config?.fleet?.wallet_network`
 *   2. `process.env.FLEET_WALLET_NETWORK`
 *   3. `""` (empty string — not configured)
 */
export function resolveWalletNetwork(config?: ReviewerConfig | null): string {
  return (
    config?.fleet?.wallet_network?.trim() ||
    process.env.FLEET_WALLET_NETWORK?.trim() ||
    ""
  );
}

/**
 * Build the structured FleetWalletConfig from config + env vars.
 */
export function getFleetWalletConfig(config?: ReviewerConfig | null): FleetWalletConfig {
  const wallet_address = resolveWalletAddress(config);
  const wallet_network = resolveWalletNetwork(config);
  return {
    wallet_address,
    wallet_network,
    configured: wallet_address.length > 0,
  };
}

/**
 * Build the full `GET /api/fleet-config` payload.
 *
 * Reads wallet address, network, and all revenue-path URLs from either the
 * programmatic config (passed by the orchestrator daemon) or from env vars
 * (set in agents.yaml `providers.global` section, per orchestrator#1331).
 */
export function getFleetConfigPayload(config?: ReviewerConfig | null): FleetConfigPayload {
  const wallet = getFleetWalletConfig(config);

  return {
    ...wallet,
    github_sponsors_url:
      config?.fleet?.github_sponsors_url?.trim() ||
      process.env.FLEET_GITHUB_SPONSORS_URL?.trim() ||
      "",
    polar_url:
      config?.fleet?.polar_url?.trim() ||
      process.env.FLEET_POLAR_URL?.trim() ||
      "",
    algora_url:
      config?.fleet?.algora_url?.trim() ||
      process.env.FLEET_ALGORA_URL?.trim() ||
      "",
    gitcoin_url:
      config?.fleet?.gitcoin_url?.trim() ||
      process.env.FLEET_GITCOIN_URL?.trim() ||
      "",
    computed_at: new Date().toISOString(),
  };
}

/**
 * Alias kept for callers that only need the wallet sub-section.
 * Prefer `getFleetConfigPayload` for the full metrics endpoint response.
 */
export const getFleetWalletConfigPayload = getFleetConfigPayload;
