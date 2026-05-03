import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  padHex,
  parseAbi,
  parseAbiParameters,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { base, polygon } from "viem/chains";
import { SignerClient } from "./signer-client.js";

export const BASE_CHAIN_ID = 8453;
export const POLYGON_CHAIN_ID = 137;
export const AAVE_V3_POOL_BASE = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as const;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;
export const TREASURY_ADDRESS = "0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef" as const;
export const MORPHO_STEAKHOUSE_USDC = "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183" as const;
export const USDC_DECIMALS = 6;

// CCTP v1 on Base
export const CCTP_TOKEN_MESSENGER_BASE = "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962" as const;
export const CCTP_MESSAGE_TRANSMITTER_POLYGON = "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81" as const;
export const CCTP_POLYGON_DOMAIN = 7 as const;
export const POLYMARKET_CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;
export const LIFI_DIAMOND_BASE = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as const;
// Native MATIC token address on Polygon (used as Li.fi toToken for gas refuel)
export const POLYGON_NATIVE_MATIC = "0x0000000000000000000000000000000000001010" as const;

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

const AAVE_POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
]);

const ERC4626_ABI = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  "function balanceOf(address account) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

const CCTP_TOKEN_MESSENGER_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64 nonce)",
]);

const CCTP_MESSAGE_TRANSMITTER_ABI = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool success)",
]);

const ERC20_ABI_POLYGON = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

export interface TreasuryClientOptions {
  signer?: SignerClient;
  publicClient?: PublicClient;
  polygonClient?: PublicClient;
  rpcUrl?: string;
  polygonRpcUrl?: string;
}

/**
 * Coordinates signer + RPC to execute treasury operations on Base.
 *
 * The signer is the only privilege-holder for the private key. This client
 * builds calldata, requests signatures, broadcasts, and waits for receipts.
 */
export class TreasuryClient {
  private readonly signer: SignerClient;
  private readonly publicClient: PublicClient;
  private readonly polygonClient: PublicClient;

  constructor(opts: TreasuryClientOptions = {}) {
    this.signer = opts.signer ?? new SignerClient();
    this.publicClient =
      opts.publicClient ??
      (createPublicClient({
        chain: base,
        transport: http(opts.rpcUrl ?? process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
      }) as unknown as PublicClient);
    this.polygonClient =
      opts.polygonClient ??
      (createPublicClient({
        chain: polygon,
        transport: http(opts.polygonRpcUrl ?? process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com"),
      }) as unknown as PublicClient);
  }

  /** Exposes the underlying signer client for consumers that need direct signing (e.g. Polymarket client). */
  get signerClient(): SignerClient { return this.signer; }

  /** USDC balance of the treasury (as smallest unit — 6 decimals). */
  async treasuryUsdcBalance(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: USDC_BASE,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [TREASURY_ADDRESS],
    })) as bigint;
  }

  /** Treasury → Aave V3 Pool USDC allowance. */
  async treasuryAaveAllowance(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: USDC_BASE,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [TREASURY_ADDRESS, AAVE_V3_POOL_BASE],
    })) as bigint;
  }

  /** ERC20 approve calldata for USDC → Aave V3 Pool. */
  buildApproveCalldata(amount: bigint): Hex {
    return encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [AAVE_V3_POOL_BASE, amount],
    });
  }

  /** ERC20 approve calldata for USDC → any spender on Base. */
  buildApproveCalldataForSpender(spender: `0x${string}`, amount: bigint): Hex {
    return encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount],
    });
  }

  /** ERC20 approve calldata for USDC → CCTP TokenMessenger on Base. */
  buildCctpApproveCalldata(amount: bigint): Hex {
    return encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CCTP_TOKEN_MESSENGER_BASE, amount],
    });
  }

  /** Aave V3 supply() calldata for USDC, onBehalfOf=treasury. */
  buildSupplyCalldata(amount: bigint): Hex {
    return encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: "supply",
      args: [USDC_BASE, amount, TREASURY_ADDRESS, 0],
    });
  }

  /** Aave V3 withdraw() calldata for USDC, to=treasury. */
  buildWithdrawCalldata(amount: bigint): Hex {
    return encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: "withdraw",
      args: [USDC_BASE, amount, TREASURY_ADDRESS],
    });
  }

  /** ERC4626 redeem() calldata — withdraw all Morpho shares back to USDC, receiver+owner=treasury. */
  buildMorphoRedeemCalldata(shares: bigint): Hex {
    return encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: "redeem",
      args: [shares, TREASURY_ADDRESS, TREASURY_ADDRESS],
    });
  }

  /** ERC4626 deposit() calldata for Morpho vault, receiver=treasury. */
  buildMorphoDepositCalldata(amount: bigint): Hex {
    return encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: "deposit",
      args: [amount, TREASURY_ADDRESS],
    });
  }

  /** ERC20 approve calldata for USDC → Morpho vault. */
  buildApproveMorphoCalldata(amount: bigint): Hex {
    return encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [MORPHO_STEAKHOUSE_USDC, amount],
    });
  }

  /** FlashArbBot deployment calldata: bytecode + ABI-encoded constructor arg. */
  buildFlashArbBotDeployData(bytecode: Hex): Hex {
    const encodedArg = encodeAbiParameters(parseAbiParameters("address"), [AAVE_V3_POOL_BASE]);
    return (bytecode + encodedArg.slice(2)) as Hex;
  }

  /** aUSDC balance in Aave (shares, 1:1 with USDC at current index). */
  async treasuryAaveUsdcBalance(): Promise<bigint> {
    // aBasUSDC token on Base
    return (await this.publicClient.readContract({
      address: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [TREASURY_ADDRESS],
    })) as bigint;
  }

  /** Morpho vault share balance converted to USDC assets. */
  async treasuryMorphoUsdcBalance(): Promise<bigint> {
    const shares = (await this.publicClient.readContract({
      address: MORPHO_STEAKHOUSE_USDC,
      abi: ERC4626_ABI,
      functionName: "balanceOf",
      args: [TREASURY_ADDRESS],
    })) as bigint;
    if (shares === 0n) return 0n;
    return (await this.publicClient.readContract({
      address: MORPHO_STEAKHOUSE_USDC,
      abi: ERC4626_ABI,
      functionName: "convertToAssets",
      args: [shares],
    })) as bigint;
  }

  /** USDC balance of the treasury on Polygon. */
  async treasuryPolygonUsdcBalance(): Promise<bigint> {
    return (await this.polygonClient.readContract({
      address: USDC_POLYGON,
      abi: ERC20_ABI_POLYGON,
      functionName: "balanceOf",
      args: [TREASURY_ADDRESS],
    })) as bigint;
  }

  /** depositForBurn calldata for CCTP bridge Base → Polygon. */
  buildCctpDepositForBurnCalldata(amount: bigint): Hex {
    // mintRecipient must be bytes32-padded address
    const mintRecipient = padHex(TREASURY_ADDRESS, { size: 32 });
    return encodeFunctionData({
      abi: CCTP_TOKEN_MESSENGER_ABI,
      functionName: "depositForBurn",
      args: [amount, CCTP_POLYGON_DOMAIN, mintRecipient, USDC_BASE],
    });
  }

  /** receiveMessage calldata for completing a CCTP bridge on Polygon. */
  buildCctpReceiveMessageCalldata(message: Hex, attestation: Hex): Hex {
    return encodeFunctionData({
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
      functionName: "receiveMessage",
      args: [message, attestation],
    });
  }

  /** ERC20 approve USDC → spender on Polygon. */
  buildPolygonUsdcApproveCalldata(spender: `0x${string}`, amount: bigint): Hex {
    return encodeFunctionData({
      abi: ERC20_ABI_POLYGON,
      functionName: "approve",
      args: [spender, amount],
    });
  }

  /**
   * Poll Circle's CCTP attestation API until the attestation is ready.
   * Returns { message, attestation } for use in receiveMessage on Polygon.
   */
  async pollCctpAttestation(txHash: Hex, opts: { pollIntervalMs?: number; maxAttempts?: number } = {}): Promise<{ message: Hex; attestation: Hex }> {
    const pollMs = opts.pollIntervalMs ?? 15_000;
    const maxAttempts = opts.maxAttempts ?? 40; // ~10 minutes

    // Get the MessageSent event log from the transaction
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    // MessageSent(bytes) event topic
    const messageSentTopic = "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036";
    const messageSentLog = receipt.logs.find(l => l.topics[0]?.toLowerCase() === messageSentTopic.toLowerCase());
    if (!messageSentLog) throw new Error("MessageSent event not found in tx receipt");

    // Decode the message bytes from log data
    const messageBytes = messageSentLog.data as Hex;
    // Strip the ABI encoding overhead (offset + length prefix = 64 bytes = 128 hex chars + "0x")
    const message = ("0x" + messageBytes.slice(130)) as Hex;
    const messageHash = await this.hashCctpMessage(message);

    for (let i = 0; i < maxAttempts; i++) {
      const resp = await fetch(`https://iris-api.circle.com/v1/attestations/${messageHash}`);
      if (resp.status >= 400 && resp.status < 500) {
        throw new Error(`CCTP attestation lookup failed (${resp.status}) — check messageHash: ${messageHash}`);
      }
      if (resp.ok) {
        const json = await resp.json() as { status: string; attestation?: string };
        if (json.status === "complete" && json.attestation) {
          return { message, attestation: json.attestation as Hex };
        }
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error(`CCTP attestation not ready after ${maxAttempts} attempts`);
  }

  /**
   * Fetch a Li.fi cross-chain bridge quote.
   * Returns the transaction calldata to execute on Base.
   * toToken: USDC address on Polygon OR POLYGON_NATIVE_MATIC for gas refuel.
   */
  async fetchLifiBridgeQuote(opts: {
    fromAmountUsdc: number;
    toToken: string;
  }): Promise<{ to: `0x${string}`; data: Hex; estimatedOutput: bigint; toolName: string }> {
    const fromAmount = BigInt(Math.round(opts.fromAmountUsdc * 1_000_000)).toString();
    const url = `https://li.quest/v1/quote?fromChain=8453&toChain=137` +
      `&fromToken=${USDC_BASE}&toToken=${opts.toToken}` +
      `&fromAmount=${fromAmount}` +
      `&fromAddress=${TREASURY_ADDRESS}&toAddress=${TREASURY_ADDRESS}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Li.fi quote failed ${resp.status}: ${text}`);
    }
    const data = await resp.json() as {
      tool?: string;
      transactionRequest?: { to: string; data: string; value: string };
      estimate?: { toAmount: string };
      message?: string;
    };
    if (data.message) throw new Error(`Li.fi quote error: ${data.message}`);
    const tx = data.transactionRequest;
    if (!tx?.to || !tx?.data) throw new Error("Li.fi quote returned no transaction");
    if (tx.to.toLowerCase() !== LIFI_DIAMOND_BASE.toLowerCase()) {
      throw new Error(`Li.fi quote to unexpected address: ${tx.to}`);
    }
    return {
      to: tx.to as `0x${string}`,
      data: tx.data as Hex,
      estimatedOutput: BigInt(data.estimate?.toAmount ?? "0"),
      toolName: data.tool ?? "unknown",
    };
  }

  /** Morpho share balance of the treasury. */
  async treasuryMorphoShares(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: MORPHO_STEAKHOUSE_USDC,
      abi: ERC4626_ABI,
      functionName: "balanceOf",
      args: [TREASURY_ADDRESS],
    })) as bigint;
  }

  private async hashCctpMessage(message: Hex): Promise<string> {
    const { keccak256 } = await import("viem");
    return keccak256(message);
  }

  /**
   * Sign + broadcast a single operation on Polygon, wait for 1 confirmation.
   */
  async signAndBroadcastPolygon(req: {
    operation: "erc20_approve_usdc_polygon" | "cctp_receive_message";
    to: `0x${string}`;
    data: Hex;
    usdValue: number;
  }): Promise<TransactionReceipt> {
    const [gasEstimate, feeData, nonce] = await Promise.all([
      this.polygonClient.estimateGas({ account: TREASURY_ADDRESS, to: req.to, data: req.data, value: 0n }),
      this.polygonClient.estimateFeesPerGas(),
      this.polygonClient.getTransactionCount({ address: TREASURY_ADDRESS }),
    ]);
    const gas = (gasEstimate * 120n) / 100n;

    const signed = await this.signer.sign({
      operation: req.operation,
      chainId: POLYGON_CHAIN_ID,
      to: req.to,
      data: req.data,
      value: 0n,
      usdValue: req.usdValue,
      nonce,
      gas,
      maxFeePerGas: feeData.maxFeePerGas ?? 50_000_000_000n,  // 50 gwei — safe upper bound for Polygon spikes
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 30_000_000_000n,  // 30 gwei priority
    });

    const txHash = await this.polygonClient.sendRawTransaction({ serializedTransaction: signed.signedTx });
    const receipt = await this.polygonClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`tx ${txHash} reverted (status=${receipt.status})`);
    }
    return receipt;
  }

  /**
   * Sign + broadcast a single operation, wait for 1 confirmation.
   * Returns the receipt. Throws on rejection or revert.
   */
  async signAndBroadcast(req: {
    operation: "aave_supply_usdc" | "erc20_approve_usdc" | "aave_withdraw" | "morpho_deposit" | "deploy_flash_arb_bot" | "flash_arb_execute" | "bridge_usdc_to_polygon" | "morpho_withdraw" | "lifi_bridge";
    to: `0x${string}` | null;
    data: Hex;
    usdValue: number;
  }): Promise<TransactionReceipt> {
    const [gasEstimate, feeData, nonce] = await Promise.all([
      this.publicClient.estimateGas({ account: TREASURY_ADDRESS, to: req.to ?? undefined, data: req.data, value: 0n }),
      this.publicClient.estimateFeesPerGas(),
      this.publicClient.getTransactionCount({ address: TREASURY_ADDRESS }),
    ]);
    // Add 20% gas buffer to avoid out-of-gas on Aave's multi-step supply
    const gas = (gasEstimate * 120n) / 100n;

    const signed = await this.signer.sign({
      operation: req.operation,
      chainId: BASE_CHAIN_ID,
      to: req.to,
      data: req.data,
      value: 0n,
      usdValue: req.usdValue,
      nonce,
      gas,
      maxFeePerGas: feeData.maxFeePerGas ?? 1_000_000n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 100_000n,
    });

    const txHash = await this.publicClient.sendRawTransaction({ serializedTransaction: signed.signedTx });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`tx ${txHash} reverted (status=${receipt.status})`);
    }
    return receipt;
  }
}
