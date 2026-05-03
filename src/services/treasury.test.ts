import { describe, it, expect } from "vitest";
import { TreasuryClient, AAVE_V3_POOL_BASE, USDC_BASE, TREASURY_ADDRESS } from "./treasury.js";

describe("TreasuryClient calldata builders", () => {
  const client = new TreasuryClient({
    publicClient: {} as never,
    signer: {} as never,
  });

  it("builds approve(spender, amount) calldata for Aave Pool", () => {
    const data = client.buildApproveCalldata(1_000_000n);
    expect(data.startsWith("0x095ea7b3")).toBe(true);
    expect(data.toLowerCase()).toContain(AAVE_V3_POOL_BASE.slice(2).toLowerCase());
  });

  it("builds supply(asset, amount, onBehalfOf, referralCode) for Aave Pool", () => {
    const data = client.buildSupplyCalldata(2_000_000n);
    expect(data.startsWith("0x617ba037")).toBe(true);
    expect(data.toLowerCase()).toContain(USDC_BASE.slice(2).toLowerCase());
    expect(data.toLowerCase()).toContain(TREASURY_ADDRESS.slice(2).toLowerCase());
  });
});
