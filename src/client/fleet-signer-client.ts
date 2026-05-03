/**
 * Fleet Signer Client — daemon-side interface to the fleet-signer service.
 *
 * The fleet-signer runs at localhost:7521 (configurable via SIGNER_URL env).
 * This client constructs the correct calldata for each operation, posts to
 * /sign, and returns the signed transaction (or escalates on failure).
 *
 * Phase 1.5 operations:
 * - signAaveSupply(chain, amount) — Aave V3 supply USDC
 * - signErc20Approve(spender, amount) — ERC20 approve USDC
 * - signPolymarketOrder(orderData, usdValue) — Polymarket CLOB order
 * - signSiwe(domain, message) — SIWE message signature
 * - signAaveSupplyPolygon(amount) — Aave V3 supply USDC on Polygon
 * - signAerodromeLp(amount) — Aerodrome USDC/USDbC LP on Base
 */

import { createLogger } from "../service/logger.js";
import { notifyOperator } from "../service/notify.js";

const log = createLogger("fleet-signer-client");

export interface FleetSignerConfig {
  /** Base URL of the signer HTTP service. Default: http://127.0.0.1:7521 */
  signerUrl?: string;
  /** Request timeout in ms. Default: 5000 */
  timeoutMs?: number;
}

export interface SignerResponse {
  approved: boolean;
  reason: string;
  signedTx?: string;
  txParams?: Record<string, string>;
}

export interface SignerHealthResponse {
  status: string;
  address: string;
}

/** Known contract addresses (mirrored from fleet-signer whitelist for convenience). */
const CONTRACTS = {
  BASE_AAVE_V3_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  BASE_USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  BASE_AERODROME_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  POLYGON_POLYMARKET_CTF_EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  POLYGON_AAVE_V3_POOL: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  POLYGON_USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
} as const;

/** Function selectors for calldata encoding. */
const SELECTORS = {
  AAVE_V3_SUPPLY: "0x617ba037",
  ERC20_APPROVE: "0x095ea7b3",
  AERODROME_ADD_LIQUIDITY: "0xe8e33700",
} as const;

export class FleetSignerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: FleetSignerConfig = {}) {
    this.baseUrl = config.signerUrl ?? process.env.SIGNER_URL ?? "http://127.0.0.1:7521";
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  /** Check if the signer service is reachable. */
  async health(): Promise<SignerHealthResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      return (await res.json()) as SignerHealthResponse;
    } catch {
      return null;
    }
  }

  /** Check if signer is reachable — returns boolean for simple checks. */
  async isReachable(): Promise<boolean> {
    const h = await this.health();
    return h !== null && h.status === "ok";
  }

  /**
   * Sign an Aave V3 supply USDC transaction on Base.
   * @param amountUsdc Amount in USDC (6 decimals, e.g. 20 for $20)
   * @param onBehalfOf Address receiving the aToken. Defaults to signer address.
   */
  async signAaveSupply(amountUsdc: number, onBehalfOf?: string): Promise<SignerResponse> {
    const amountRaw = BigInt(Math.round(amountUsdc * 1e6));
    const recipient = onBehalfOf ?? "0x0000000000000000000000000000000000000000";
    // supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
    const data =
      SELECTORS.AAVE_V3_SUPPLY +
      padAddress(CONTRACTS.BASE_USDC) +
      padUint256(amountRaw) +
      padAddress(recipient) +
      padUint256(0n);

    return this.sign({
      operation: "aave_supply_usdc",
      chainId: 8453,
      to: CONTRACTS.BASE_AAVE_V3_POOL,
      data,
      value: "0",
      usdValue: amountUsdc,
    });
  }

  /**
   * Sign an ERC20 approve for USDC on Base.
   * @param spender The address being approved (e.g. Aave pool).
   * @param amountUsdc Amount in USDC units.
   */
  async signErc20Approve(spender: string, amountUsdc: number): Promise<SignerResponse> {
    const amountRaw = BigInt(Math.round(amountUsdc * 1e6));
    // approve(address spender, uint256 amount)
    const data = SELECTORS.ERC20_APPROVE + padAddress(spender) + padUint256(amountRaw);

    return this.sign({
      operation: "erc20_approve_usdc",
      chainId: 8453,
      to: CONTRACTS.BASE_USDC,
      data,
      value: "0",
      usdValue: amountUsdc,
    });
  }

  /**
   * Sign a Polymarket order placement on Polygon.
   * @param orderCalldata Pre-encoded order calldata from CLOB SDK.
   * @param usdValue USD value of the order for cap accounting.
   */
  async signPolymarketOrder(orderCalldata: string, usdValue: number): Promise<SignerResponse> {
    return this.sign({
      operation: "polymarket_order",
      chainId: 137,
      to: CONTRACTS.POLYGON_POLYMARKET_CTF_EXCHANGE,
      data: orderCalldata,
      value: "0",
      usdValue,
    });
  }

  /**
   * Sign a SIWE (Sign-In With Ethereum) message.
   * @param domain The requesting domain (must be in SIWE allowlist).
   * @param message The full SIWE message to sign (hex-encoded).
   */
  async signSiwe(domain: string, message: string): Promise<SignerResponse> {
    // SIWE is a message signature — no contract, no value, no chain-specific tx
    const hexMessage = message.startsWith("0x") ? message : toHex(message);
    return this.sign({
      operation: "siwe_sign",
      chainId: 1, // SIWE is chain-agnostic but we need a value
      to: "0x0000000000000000000000000000000000000000",
      data: hexMessage,
      value: "0",
      usdValue: 0,
      siweDomain: domain,
    });
  }

  /**
   * Sign an Aave V3 supply USDC transaction on Polygon.
   * @param amountUsdc Amount in USDC (6 decimals).
   * @param onBehalfOf Address receiving the aToken.
   */
  async signAaveSupplyPolygon(amountUsdc: number, onBehalfOf?: string): Promise<SignerResponse> {
    const amountRaw = BigInt(Math.round(amountUsdc * 1e6));
    const recipient = onBehalfOf ?? "0x0000000000000000000000000000000000000000";
    const data =
      SELECTORS.AAVE_V3_SUPPLY +
      padAddress(CONTRACTS.POLYGON_USDC) +
      padUint256(amountRaw) +
      padAddress(recipient) +
      padUint256(0n);

    return this.sign({
      operation: "aave_supply_usdc_polygon",
      chainId: 137,
      to: CONTRACTS.POLYGON_AAVE_V3_POOL,
      data,
      value: "0",
      usdValue: amountUsdc,
    });
  }

  /**
   * Sign an Aerodrome USDC/USDbC LP entry on Base.
   * @param amountUsdc Amount of USDC side in USD.
   * @param lpCalldata Pre-encoded addLiquidity calldata.
   */
  async signAerodromeLp(lpCalldata: string, amountUsdc: number): Promise<SignerResponse> {
    // Ensure the calldata starts with the right selector
    const data = lpCalldata.startsWith(SELECTORS.AERODROME_ADD_LIQUIDITY)
      ? lpCalldata
      : SELECTORS.AERODROME_ADD_LIQUIDITY + lpCalldata.replace(/^0x/, "");

    return this.sign({
      operation: "aerodrome_add_liquidity",
      chainId: 8453,
      to: CONTRACTS.BASE_AERODROME_ROUTER,
      data,
      value: "0",
      usdValue: amountUsdc,
    });
  }

  /**
   * Core sign method — posts to signer's /sign endpoint.
   * Handles signer-down gracefully with operator notification.
   */
  private async sign(payload: {
    operation: string;
    chainId: number;
    to: string;
    data: string;
    value: string;
    usdValue: number;
    siweDomain?: string;
  }): Promise<SignerResponse> {
    try {
      const res = await fetch(`${this.baseUrl}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const body = (await res.json()) as SignerResponse;

      // Alert operator on rejections
      if (!body.approved) {
        log.warn("Signer rejected request", {
          operation: payload.operation,
          reason: body.reason,
          usdValue: payload.usdValue,
        });
        await notifyOperator(
          "Signer Rejection",
          `Operation: ${payload.operation}\nReason: ${body.reason}\nValue: $${payload.usdValue}`,
          "warning",
          `signer-reject-${payload.operation}`,
        );
      }

      return body;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Signer unreachable", { error: message, operation: payload.operation });

      // Critical alert — signer down means treasury operations are blocked
      await notifyOperator(
        "Fleet Signer Unreachable",
        `Cannot reach signer at ${this.baseUrl}\nOperation attempted: ${payload.operation}\nError: ${message}`,
        "critical",
        "signer-unreachable",
      );

      return {
        approved: false,
        reason: `signer unreachable: ${message}`,
      };
    }
  }
}

// --- Encoding helpers ---

function padAddress(addr: string): string {
  return addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

function padUint256(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function toHex(str: string): string {
  return "0x" + Buffer.from(str, "utf-8").toString("hex");
}
