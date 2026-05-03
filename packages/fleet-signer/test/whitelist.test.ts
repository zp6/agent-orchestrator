import { describe, it, expect } from "vitest";
import {
  evaluateWhitelist,
  BASE_CONTRACTS,
  AAVE_V3_SUPPLY_SELECTOR,
  ERC20_APPROVE_SELECTOR,
  PER_TX_CAPS_USD,
  DAILY_CAP_USD,
} from "../src/whitelists/index.js";

const validSupply: Parameters<typeof evaluateWhitelist>[0] = {
  operation: "aave_supply_usdc",
  chainId: 8453,
  to: BASE_CONTRACTS.AAVE_V3_POOL,
  data: `${AAVE_V3_SUPPLY_SELECTOR}0000000000000000000000000000000000000000000000000000000000000000` as `0x${string}`,
  value: 0n,
  usdValue: 20,
};

describe("evaluateWhitelist — Aave V3 supply USDC", () => {
  it("approves a valid supply within caps", () => {
    const d = evaluateWhitelist(validSupply, 0);
    expect(d.approved).toBe(true);
  });

  it("rejects when value > 0", () => {
    const d = evaluateWhitelist({ ...validSupply, value: 1n }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/value.*not 0/);
  });

  it("rejects wrong chainId", () => {
    const d = evaluateWhitelist({ ...validSupply, chainId: 1 }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/chainId/);
  });

  it("rejects wrong destination contract", () => {
    const d = evaluateWhitelist({ ...validSupply, to: "0x0000000000000000000000000000000000000000" }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/Aave V3 Pool/);
  });

  it("rejects wrong selector", () => {
    const d = evaluateWhitelist({ ...validSupply, data: "0xdeadbeef00000000" }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/supply/);
  });

  it("rejects when usdValue exceeds per-tx cap", () => {
    const d = evaluateWhitelist({ ...validSupply, usdValue: PER_TX_CAPS_USD.AAVE_SUPPLY_USDC + 1 }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/per-tx cap/);
  });

  it("rejects when current day spend + this tx exceeds daily cap", () => {
    const closeToCap = DAILY_CAP_USD - 5;
    const d = evaluateWhitelist({ ...validSupply, usdValue: 10 }, closeToCap);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/daily cap/);
  });

  it("approves when day spend + this tx is exactly at daily cap", () => {
    const d = evaluateWhitelist({ ...validSupply, usdValue: 10 }, DAILY_CAP_USD - 10);
    expect(d.approved).toBe(true);
  });
});

describe("evaluateWhitelist — ERC20 approve USDC", () => {
  it("approves a valid approve within caps", () => {
    const d = evaluateWhitelist(
      {
        operation: "erc20_approve_usdc",
        chainId: 8453,
        to: BASE_CONTRACTS.USDC,
        data: `${ERC20_APPROVE_SELECTOR}0000` as `0x${string}`,
        value: 0n,
        usdValue: 20,
      },
      0,
    );
    expect(d.approved).toBe(true);
  });

  it("rejects when destination is not USDC", () => {
    const d = evaluateWhitelist(
      {
        operation: "erc20_approve_usdc",
        chainId: 8453,
        to: "0x0000000000000000000000000000000000000000",
        data: `${ERC20_APPROVE_SELECTOR}` as `0x${string}`,
        value: 0n,
        usdValue: 20,
      },
      0,
    );
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/USDC/);
  });
});

describe("evaluateWhitelist — unknown operations", () => {
  it("rejects unknown operations", () => {
    const d = evaluateWhitelist(
      {
        operation: "unknown_op" as never,
        chainId: 8453,
        to: BASE_CONTRACTS.USDC,
        data: "0x",
        value: 0n,
        usdValue: 0,
      },
      0,
    );
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/unknown operation/);
  });
});
