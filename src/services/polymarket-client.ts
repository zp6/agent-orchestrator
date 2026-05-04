import { createHmac } from "node:crypto";
import type { Hex } from "viem";
import type { SignerClient } from "./signer-client.js";

const CLOB_API = "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

export interface PolymarketMarket {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
}

export interface PlaceOrderParams {
  tokenId: string;
  side: "BUY" | "SELL";
  /** USDC amount (whole units, e.g. 25 for $25). */
  amountUsdc: number;
  /** Price per token, 0–1 (e.g. 0.53 for 53¢ per NO token). */
  price: number;
  nonce?: bigint;
}

export class PolymarketClient {
  private readonly signer: SignerClient;
  private apiKey?: string;
  private apiSecret?: string;
  private apiPassphrase?: string;
  private walletAddress?: string;

  constructor(signer: SignerClient) {
    this.signer = signer;
  }

  /** Fetch market details by slug. Returns YES and NO token IDs + current prices. */
  async getMarket(slug: string): Promise<PolymarketMarket> {
    const resp = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
    if (!resp.ok) throw new Error(`Gamma API error ${resp.status}`);
    const markets = await resp.json() as Array<{
      conditionId: string;
      question: string;
      clobTokenIds: string; // JSON-encoded string array: ["yesId", "noId"]
      outcomes: string;     // JSON-encoded string array: ["Yes", "No"]
      outcomePrices: string; // JSON-encoded string array: ["0.64", "0.36"]
    }>;
    if (!markets.length) throw new Error(`No market found for slug: ${slug}`);
    const m = markets[0];
    const tokenIds: string[] = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    const outcomes: string[] = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
    const prices: string[] = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    const yesIdx = outcomes.findIndex(o => o.toLowerCase() === "yes");
    const noIdx = outcomes.findIndex(o => o.toLowerCase() === "no");
    if (yesIdx === -1 || noIdx === -1) throw new Error("Could not find YES/NO outcomes in market");
    return {
      conditionId: m.conditionId,
      question: m.question,
      yesTokenId: tokenIds[yesIdx],
      noTokenId: tokenIds[noIdx],
      yesPrice: parseFloat(prices[yesIdx]),
      noPrice: parseFloat(prices[noIdx]),
    };
  }

  /**
   * Generate CLOB API credentials via EIP-712 ClobAuth signing.
   * The derived credentials (apiKey, secret, passphrase) are used for HMAC-signed API calls.
   */
  async authenticate(walletAddress: string): Promise<void> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 0;

    const { signature, address } = await this.signer.signPolymarketAuth(timestamp, nonce);

    // CLOB API uses POLY_* headers for auth (not request body)
    const resp = await fetch(`${CLOB_API}/auth/api-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://polymarket.com",
        "Referer": "https://polymarket.com/",
        "POLY_ADDRESS": address,
        "POLY_SIGNATURE": signature,
        "POLY_TIMESTAMP": timestamp,
        "POLY_NONCE": String(nonce),
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`CLOB auth failed ${resp.status}: ${text}`);
    }
    const creds = await resp.json() as { apiKey: string; secret: string; passphrase: string };
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.secret;
    this.apiPassphrase = creds.passphrase;
    this.walletAddress = walletAddress;
  }

  /** Get current nonce for order signing. */
  async getNonce(): Promise<bigint> {
    const resp = await fetch(`${CLOB_API}/nonce`, {
      headers: await this.hmacHeaders("GET", "/nonce", ""),
    });
    if (!resp.ok) throw new Error(`CLOB nonce fetch failed ${resp.status}`);
    const data = await resp.json() as { nonce: number };
    return BigInt(data.nonce);
  }

  /**
   * Sign and submit an order to the Polymarket CLOB.
   * Returns the order ID.
   */
  async placeOrder(params: PlaceOrderParams): Promise<string> {
    if (!this.apiKey || !this.walletAddress) throw new Error("Not authenticated — call authenticate() first");

    const makerAmountUnits = BigInt(Math.round(params.amountUsdc * 1_000_000));
    const takerAmountUnits = BigInt(Math.round((params.amountUsdc / params.price) * 1_000_000));
    const nonce = params.nonce ?? (await this.getNonce());

    const { signature, order } = await this.signer.signOrder({
      makerAmount: makerAmountUnits,
      takerAmount: takerAmountUnits,
      tokenId: params.tokenId,
      side: params.side === "BUY" ? 0 : 1,
      nonce,
    });

    const body = JSON.stringify({
      order: { ...order, signature },
      owner: this.walletAddress,
      orderType: "GTC",
    });

    const resp = await fetch(`${CLOB_API}/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await this.hmacHeaders("POST", "/order", body)),
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`CLOB order placement failed ${resp.status}: ${text}`);
    }
    const data = await resp.json() as { orderID: string };
    return data.orderID;
  }

  /** Build HMAC-SHA256 authentication headers for CLOB API calls. */
  private async hmacHeaders(method: string, path: string, body: string): Promise<Record<string, string>> {
    if (!this.apiKey || !this.apiSecret || !this.apiPassphrase || !this.walletAddress) {
      throw new Error("Not authenticated");
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const message = timestamp + method.toUpperCase() + path + body;
    const signature = createHmac("sha256", Buffer.from(this.apiSecret, "base64"))
      .update(message)
      .digest("base64");
    return {
      "POLY_ADDRESS": this.walletAddress,
      "POLY_API_KEY": this.apiKey,
      "POLY_PASSPHRASE": this.apiPassphrase,
      "POLY_SIGNATURE": signature,
      "POLY_TIMESTAMP": timestamp,
    };
  }
}
