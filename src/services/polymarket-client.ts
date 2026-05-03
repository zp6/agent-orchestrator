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
      tokens: Array<{ token_id: string; outcome: string; price: string }>;
    }>;
    if (!markets.length) throw new Error(`No market found for slug: ${slug}`);
    const m = markets[0];
    const yes = m.tokens.find(t => t.outcome.toLowerCase() === "yes");
    const no = m.tokens.find(t => t.outcome.toLowerCase() === "no");
    if (!yes || !no) throw new Error("Could not find YES/NO tokens in market");
    return {
      conditionId: m.conditionId,
      question: m.question,
      yesTokenId: yes.token_id,
      noTokenId: no.token_id,
      yesPrice: parseFloat(yes.price),
      noPrice: parseFloat(no.price),
    };
  }

  /**
   * Generate CLOB API credentials via EIP-712 ClobAuth signing.
   * The derived credentials (apiKey, secret, passphrase) are used for HMAC-signed API calls.
   */
  async authenticate(walletAddress: string): Promise<void> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 0;

    const { signature } = await this.signer.signPolymarketAuth(timestamp, nonce);

    const resp = await fetch(`${CLOB_API}/auth/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature, timestamp, nonce, address: walletAddress }),
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
