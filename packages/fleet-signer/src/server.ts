import * as http from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, PrivateKeyAccount } from "viem";
import { evaluateWhitelist, type SignRequest } from "./whitelists/index.js";
import { AuditLog } from "./audit.js";

/** Configuration for the signer service. */
export interface SignerServerConfig {
  /** Hex private key (0x-prefixed) loaded into memory after passphrase decrypt. */
  privateKey: `0x${string}`;
  /** TCP port for the localhost HTTP listener. Defaults to 7521. */
  port?: number;
  /** Audit log instance. Created with default path if omitted. */
  auditLog?: AuditLog;
}

interface SignRequestBody {
  operation: SignRequest["operation"];
  chainId: number;
  to: string;
  data: string;
  value: string; // hex or decimal string
  usdValue: number;
  siweDomain?: string;
}

interface SignResponseBody {
  approved: boolean;
  reason: string;
  signedTx?: Hex;
  txParams?: Record<string, string>;
}

/**
 * Construct, validate, and (if approved) sign the requested transaction.
 *
 * Returns the signed raw transaction. The fleet daemon then broadcasts it
 * via its preferred RPC. The signer never broadcasts — separating sign
 * from broadcast is a security best-practice (the signer's only privilege
 * is producing signatures).
 */
async function handleSign(
  body: SignRequestBody,
  account: PrivateKeyAccount,
  audit: AuditLog,
): Promise<SignResponseBody> {
  const req: SignRequest = {
    operation: body.operation,
    chainId: body.chainId,
    to: body.to as `0x${string}`,
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
    // SIWE: sign a message (EIP-191 personal_sign), not a transaction.
    // The data field contains the hex-encoded SIWE message.
    const messageBytes = Buffer.from(req.data.slice(2), "hex");
    signedTx = await account.signMessage({ message: { raw: messageBytes } });
  } else {
    // Transaction signing: EIP-1559. Nonce + gas are caller responsibility.
    signedTx = await account.signTransaction({
      chainId: req.chainId,
      to: req.to,
      data: req.data,
      value: req.value,
      type: "eip1559",
      nonce: 0,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      gas: 0n,
    });
  }

  await audit.append({
    operation: req.operation,
    decision: "approve",
    reason: decision.reason,
    payload: { to: req.to, chainId: req.chainId, usdValue: req.usdValue },
    daySpendUsd: req.usdValue,
  });

  return {
    approved: true,
    reason: decision.reason,
    signedTx,
    txParams: {
      from: account.address,
      to: req.to,
      data: req.data,
      value: `0x${req.value.toString(16)}`,
      chainId: `0x${req.chainId.toString(16)}`,
    },
  };
}

/** Start the localhost HTTP signer. Returns the server handle so callers can stop it. */
export function startSignerServer(config: SignerServerConfig): http.Server {
  const port = config.port ?? 7521;
  const account = privateKeyToAccount(config.privateKey);
  const audit = config.auditLog ?? new AuditLog();

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/sign") {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", address: account.address }));
        return;
      }
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

  server.listen(port, "127.0.0.1");
  return server;
}
