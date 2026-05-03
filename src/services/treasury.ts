import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import { SignerClient } from "./signer-client.js";

export const BASE_CHAIN_ID = 8453;
export const AAVE_V3_POOL_BASE = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as const;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const TREASURY_ADDRESS = "0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef" as const;
export const USDC_DECIMALS = 6;

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

const AAVE_POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
]);

export interface TreasuryClientOptions {
  signer?: SignerClient;
  publicClient?: PublicClient;
  rpcUrl?: string;
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

  constructor(opts: TreasuryClientOptions = {}) {
    this.signer = opts.signer ?? new SignerClient();
    this.publicClient =
      opts.publicClient ??
      (createPublicClient({
        chain: base,
        transport: http(opts.rpcUrl ?? process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
      }) as unknown as PublicClient);
  }

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

  /** Aave V3 supply() calldata for USDC, onBehalfOf=treasury. */
  buildSupplyCalldata(amount: bigint): Hex {
    return encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: "supply",
      args: [USDC_BASE, amount, TREASURY_ADDRESS, 0],
    });
  }

  /**
   * Sign + broadcast a single operation, wait for 1 confirmation.
   * Returns the receipt. Throws on rejection or revert.
   */
  async signAndBroadcast(req: {
    operation: "aave_supply_usdc" | "erc20_approve";
    to: `0x${string}`;
    data: Hex;
    usdValue: number;
  }): Promise<TransactionReceipt> {
    const signed = await this.signer.sign({
      operation: req.operation,
      chainId: BASE_CHAIN_ID,
      to: req.to,
      data: req.data,
      value: 0n,
      usdValue: req.usdValue,
    });

    const txHash = await this.publicClient.sendRawTransaction({ serializedTransaction: signed.signedTx });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`tx ${txHash} reverted (status=${receipt.status})`);
    }
    return receipt;
  }
}
