import * as http from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, PrivateKeyAccount } from "viem";
import {
  evaluateWhitelist,
  type SignRequest,
  POLYGON_CONTRACTS,
  PER_TX_CAPS_USD,
  DAILY_CAP_USD,
} from "./whitelists/index.js";
import { AuditLog } from "./audit.js";

/** Configuration for the signer service. */
export interface SignerServerConfig {
  /** Hex private key (0x-prefixed) loaded into memory after passphrase decrypt. */
  privateKey: `0x${string}`;
  /** TCP port for the localhost HTTP listener. Defaults to 7521. */
  port?: number;
  /**
   * Bind host. Defaults to 127.0.0.1. Override to 0.0.0.0 only when running
   * inside a container whose port is mapped to host loopback (127.0.0.1:7521:7521).
   * Never bind 0.0.0.0 directly on a host with a public interface.
   */
  bindHost?: string;
  /** Audit log instance. Created with default path if omitted. */
  auditLog?: AuditLog;
}

interface SignRequestBody {
  operation: SignRequest["operation"];
  chainId: number;
  to: string; // empty string for contract deployments
  data: string;
  value: string; // hex or decimal string
  usdValue: number;
  siweDomain?: string;
  // Gas params — caller is responsible for estimating these before signing.
  nonce?: number;
  gas?: string;          // hex string e.g. "0x15f90"
  maxFeePerGas?: string; // hex string
  maxPriorityFeePerGas?: string; // hex string
}

interface SignResponseBody {
  approved: boolean;
  reason: string;
  signedTx?: Hex;
  txParams?: Record<string, string>;
}

/** Polymarket /sign-order request body. action=order signs a trade; action=auth signs API key credentials. */
interface PolymarketSignBody {
  action: "order" | "auth";
  // --- order fields (action=order) ---
  makerAmount?: string;
  takerAmount?: string;
  tokenId?: string;
  side?: 0 | 1;
  expiration?: string;
  nonce?: string;
  feeRateBps?: string;
  // --- auth fields (action=auth) ---
  timestamp?: string;
  authNonce?: number;
}

interface SignOrderResponseBody {
  approved: boolean;
  reason: string;
  signature?: Hex;
  order?: Record<string, string>;
  address?: string;
}

/** EIP-712 domain for Polymarket CTF Exchange orders. */
const POLYMARKET_ORDER_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 137,
  verifyingContract: POLYGON_CONTRACTS.POLYMARKET_CTF_EXCHANGE,
} as const;

/** EIP-712 domain for Polymarket CLOB API key generation. */
const POLYMARKET_AUTH_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: 137,
} as const;

const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
} as const;

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "int256" },
    { name: "message", type: "string" },
  ],
} as const;

async function handleSignOrder(
  body: PolymarketSignBody,
  account: PrivateKeyAccount,
  audit: AuditLog,
): Promise<SignOrderResponseBody> {

  if (body.action === "auth") {
    // EIP-712 auth signing for CLOB API key generation — no USD cap (no funds moved)
    const timestamp = body.timestamp ?? String(Math.floor(Date.now() / 1000));
    const authNonce = body.authNonce ?? 0;
    const signature = await account.signTypedData({
      domain: POLYMARKET_AUTH_DOMAIN,
      types: CLOB_AUTH_TYPES,
      primaryType: "ClobAuth",
      message: {
        address: account.address,
        timestamp,
        nonce: BigInt(authNonce),
        message: "This message attests that I control the given wallet",
      },
    });
    await audit.append({ operation: "polymarket_auth", decision: "approve", reason: "CLOB API key auth signed" });
    return { approved: true, reason: "CLOB auth signed", signature, address: account.address };
  }

  // action=order
  const makerAmount = BigInt(body.makerAmount ?? "0");
  const usdValue = Number(makerAmount) / 1_000_000;

  if (usdValue > PER_TX_CAPS_USD.POLYMARKET_ORDER) {
    await audit.append({ operation: "polymarket_sign_order", decision: "reject", reason: `usdValue ${usdValue} exceeds per-tx cap` });
    return { approved: false, reason: `makerAmount ${usdValue} USDC exceeds per-tx cap ${PER_TX_CAPS_USD.POLYMARKET_ORDER}` };
  }
  const daySpend = await audit.daySpendUsd();
  if (daySpend + usdValue > DAILY_CAP_USD) {
    await audit.append({ operation: "polymarket_sign_order", decision: "reject", reason: `daily cap exceeded` });
    return { approved: false, reason: `daily cap exceeded: ${daySpend} + ${usdValue} > ${DAILY_CAP_USD}` };
  }

  const saltBytes = crypto.getRandomValues(new Uint8Array(32));
  const salt = BigInt("0x" + Array.from(saltBytes).map(b => b.toString(16).padStart(2, "0")).join(""));
  const order = {
    salt,
    maker: account.address,
    signer: account.address,
    taker: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    tokenId: BigInt(body.tokenId ?? "0"),
    makerAmount,
    takerAmount: BigInt(body.takerAmount ?? "0"),
    expiration: BigInt(body.expiration ?? "0"),
    nonce: BigInt(body.nonce ?? "0"),
    feeRateBps: BigInt(body.feeRateBps ?? "0"),
    side: body.side ?? 0,
    signatureType: 0,
  };

  const signature = await account.signTypedData({
    domain: POLYMARKET_ORDER_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: order,
  });

  await audit.append({
    operation: "polymarket_sign_order",
    decision: "approve",
    reason: "Polymarket order signed",
    payload: { tokenId: body.tokenId, side: body.side, usdValue },
    daySpendUsd: usdValue,
  });

  return {
    approved: true,
    reason: "Polymarket order signed",
    signature,
    order: {
      salt: salt.toString(),
      maker: account.address,
      signer: account.address,
      taker: "0x0000000000000000000000000000000000000000",
      tokenId: body.tokenId ?? "",
      makerAmount: body.makerAmount ?? "0",
      takerAmount: body.takerAmount ?? "0",
      expiration: body.expiration ?? "0",
      nonce: body.nonce ?? "0",
      feeRateBps: body.feeRateBps ?? "0",
      side: String(body.side ?? 0),
      signatureType: "0",
    },
  };
}

/**
 * Construct, validate, and (if approved) sign the requested transaction.
 */
async function handleSign(
  body: SignRequestBody,
  account: PrivateKeyAccount,
  audit: AuditLog,
): Promise<SignResponseBody> {
  const req: SignRequest = {
    operation: body.operation,
    chainId: body.chainId,
    to: body.to ? (body.to as `0x${string}`) : null,
    data: body.data as Hex,
    value: BigInt(body.value),
    usdValue: body.usdValue,
    siweDomain: body.siweDomain,
  };

  const daySpend = await audit.daySpendUsd();
  const decision = evaluateWhitelist(req, daySpend);

  if (!decision.approved) {
    await audit.append({
      operation: req.operation,
      decision: "reject",
      reason: decision.reason,
      payload: { to: req.to, chainId: req.chainId, usdValue: req.usdValue },
    });
    return { approved: false, reason: decision.reason };
  }

  let signedTx: Hex;

  if (req.operation === "siwe_sign") {
    const messageBytes = Buffer.from(req.data.slice(2), "hex");
    signedTx = await account.signMessage({ message: { raw: messageBytes } });
  } else {
    const txBase = {
      chainId: req.chainId,
      data: req.data,
      value: req.value,
      type: "eip1559" as const,
      nonce: body.nonce ?? 0,
      maxFeePerGas: body.maxFeePerGas ? BigInt(body.maxFeePerGas) : 0n,
      maxPriorityFeePerGas: body.maxPriorityFeePerGas ? BigInt(body.maxPriorityFeePerGas) : 0n,
      gas: body.gas ? BigInt(body.gas) : 0n,
    };
    signedTx = await account.signTransaction(
      req.to ? { ...txBase, to: req.to } : txBase,
    );
  }

  const nonSpendingOps = new Set(["aave_withdraw", "deploy_flash_arb_bot", "flash_arb_execute", "bridge_usdc_to_polygon", "cctp_receive_message", "morpho_withdraw", "lifi_bridge"]);
  await audit.append({
    operation: req.operation,
    decision: "approve",
    reason: decision.reason,
    payload: { to: req.to, chainId: req.chainId, usdValue: req.usdValue },
    daySpendUsd: nonSpendingOps.has(req.operation) ? 0 : req.usdValue,
  });

  return {
    approved: true,
    reason: decision.reason,
    signedTx,
    txParams: {
      from: account.address,
      ...(req.to ? { to: req.to } : {}),
      data: req.data,
      value: `0x${req.value.toString(16)}`,
      chainId: `0x${req.chainId.toString(16)}`,
    },
  };
}

/** Start the localhost HTTP signer. Returns the server handle so callers can stop it. */
export function startSignerServer(config: SignerServerConfig): http.Server {
  const port = config.port ?? 7521;
  const bindHost = config.bindHost ?? "127.0.0.1";
  const account = privateKeyToAccount(config.privateKey);
  const audit = config.auditLog ?? new AuditLog();

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", address: account.address }));
      return;
    }

    if (req.method === "POST" && req.url === "/sign-order") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw) as PolymarketSignBody;
          const result = await handleSignOrder(body, account, audit);
          res.writeHead(result.approved ? 200 : 403, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown error";
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ approved: false, reason: `error: ${message}` }));
        }
      });
      return;
    }

    if (req.method !== "POST" || req.url !== "/sign") {
      res.writeHead(404);
      res.end();
      return;
    }

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw) as SignRequestBody;
        const result = await handleSign(body, account, audit);
        res.writeHead(result.approved ? 200 : 403, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        await audit.append({
          operation: "unknown",
          decision: "error",
          reason: message,
        });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ approved: false, reason: `error: ${message}` }));
      }
    });
  });

  server.listen(port, bindHost);
  return server;
}
