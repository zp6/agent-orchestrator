import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbi,
  parseAbiParameters,
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
export const MORPHO_STEAKHOUSE_USDC = "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183" as const;
export const USDC_DECIMALS = 6;

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
  "function balanceOf(address account) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
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

  /** Aave V3 withdraw() calldata for USDC, to=treasury. */
  buildWithdrawCalldata(amount: bigint): Hex {
    return encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: "withdraw",
      args: [USDC_BASE, amount, TREASURY_ADDRESS],
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

  /**
   * Sign + broadcast a single operation, wait for 1 confirmation.
   * Returns the receipt. Throws on rejection or revert.
   */
  async signAndBroadcast(req: {
    operation: "aave_supply_usdc" | "erc20_approve_usdc" | "aave_withdraw" | "morpho_deposit" | "deploy_flash_arb_bot";
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
