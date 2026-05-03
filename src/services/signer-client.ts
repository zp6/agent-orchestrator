import type { Hex } from "viem";

export interface SignerSignRequest {
  operation: "aave_supply_usdc" | "erc20_approve_usdc" | "polymarket_place_order" | "siwe_sign";
  chainId: number;
  to: `0x${string}`;
  data: Hex;
  value: bigint;
  usdValue: number;
  siweDomain?: string;
  nonce?: number;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface SignerSignApproved {
  approved: true;
  reason: string;
  signedTx: Hex;
  txParams?: Record<string, string>;
}

export interface SignerSignRejected {
  approved: false;
  reason: string;
}

export type SignerSignResponse = SignerSignApproved | SignerSignRejected;

export class SignerError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SignerError";
  }
}

export class SignerRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`signer rejected request: ${reason}`);
    this.name = "SignerRejectedError";
  }
}

export interface SignerClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class SignerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: SignerClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.FLEET_SIGNER_URL ?? "http://127.0.0.1:7521").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async health(): Promise<{ status: string; address: `0x${string}` }> {
    const res = await this.request("GET", "/health");
    return res as { status: string; address: `0x${string}` };
  }

  async sign(req: SignerSignRequest): Promise<SignerSignApproved> {
    const body: Record<string, unknown> = {
      operation: req.operation,
      chainId: req.chainId,
      to: req.to,
      data: req.data,
      value: `0x${req.value.toString(16)}`,
      usdValue: req.usdValue,
      siweDomain: req.siweDomain,
    };
    if (req.nonce !== undefined) body.nonce = req.nonce;
    if (req.gas !== undefined) body.gas = `0x${req.gas.toString(16)}`;
    if (req.maxFeePerGas !== undefined) body.maxFeePerGas = `0x${req.maxFeePerGas.toString(16)}`;
    if (req.maxPriorityFeePerGas !== undefined) body.maxPriorityFeePerGas = `0x${req.maxPriorityFeePerGas.toString(16)}`;

    const res = (await this.request("POST", "/sign", body)) as SignerSignResponse;
    if (!res.approved) {
      throw new SignerRejectedError(res.reason);
    }
    return res;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        signal: controller.signal,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      };
      const response = await this.fetchImpl(url, init);
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!response.ok && response.status !== 403) {
        throw new SignerError(`signer returned ${response.status}: ${text || "(empty)"}`);
      }
      return parsed;
    } catch (err) {
      if (err instanceof SignerError || err instanceof SignerRejectedError) throw err;
      throw new SignerError(`signer request failed: ${err instanceof Error ? err.message : String(err)}`, err);
    } finally {
      clearTimeout(timer);
    }
  }
}
