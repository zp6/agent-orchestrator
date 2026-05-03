import { describe, it, expect } from "vitest";
import {
  evaluateWhitelist,
  BASE_CONTRACTS,
  POLYGON_CONTRACTS,
  AAVE_V3_SUPPLY_SELECTOR,
  ERC20_APPROVE_SELECTOR,
  AERODROME_ADD_LIQUIDITY_SELECTOR,
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

describe("evaluateWhitelist — Aave V3 supply USDC (Base)", () => {
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

describe("evaluateWhitelist — Polymarket placeOrder (Polygon)", () => {
  const validOrder: Parameters<typeof evaluateWhitelist>[0] = {
    operation: "polymarket_order",
    chainId: 137,
    to: POLYGON_CONTRACTS.POLYMARKET_CTF_EXCHANGE,
    data: "0xdeadbeef" as `0x${string}`,
    value: 0n,
    usdValue: 25,
  };

  it("approves a valid Polymarket order within caps", () => {
    const d = evaluateWhitelist(validOrder, 0);
    expect(d.approved).toBe(true);
  });

  it("rejects wrong chainId (must be Polygon)", () => {
    const d = evaluateWhitelist({ ...validOrder, chainId: 8453 }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/chainId 137/);
  });

  it("rejects wrong contract address", () => {
    const d = evaluateWhitelist({ ...validOrder, to: "0x0000000000000000000000000000000000000000" }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/Polymarket CTF Exchange/);
  });

  it("rejects when usdValue exceeds per-tx cap", () => {
    const d = evaluateWhitelist({ ...validOrder, usdValue: PER_TX_CAPS_USD.POLYMARKET_ORDER + 1 }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/per-tx cap/);
  });

  it("rejects when daily cap exceeded", () => {
    const d = evaluateWhitelist({ ...validOrder, usdValue: 30 }, 80);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/daily cap/);
  });
});

describe("evaluateWhitelist — SIWE message signatures", () => {
  const validSiwe: Parameters<typeof evaluateWhitelist>[0] = {
    operation: "siwe_sign",
    chainId: 1,
    to: "0x0000000000000000000000000000000000000000",
    data: "0x" as `0x${string}`,
    value: 0n,
    usdValue: 0,
    siweDomain: "mirror.xyz",
  };

  it("approves SIWE for whitelisted domain", () => {
    const d = evaluateWhitelist(validSiwe, 0);
    expect(d.approved).toBe(true);
    expect(d.reason).toMatch(/SIWE domain whitelisted/);
  });

  it("approves SIWE for subdomain of whitelisted domain", () => {
    const d = evaluateWhitelist({ ...validSiwe, siweDomain: "app.mirror.xyz" }, 0);
    expect(d.approved).toBe(true);
  });

  it("rejects SIWE for non-whitelisted domain", () => {
    const d = evaluateWhitelist({ ...validSiwe, siweDomain: "evil.com" }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/not in SIWE allowlist/);
  });

  it("rejects SIWE when siweDomain is missing", () => {
    const d = evaluateWhitelist({ ...validSiwe, siweDomain: undefined }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/requires siweDomain/);
  });

  it("does not count against daily cap", () => {
    // Even at max daily spend, SIWE should pass (it's not a financial op)
    const d = evaluateWhitelist(validSiwe, DAILY_CAP_USD);
    expect(d.approved).toBe(true);
  });
});

describe("evaluateWhitelist — Aave V3 supply USDC (Polygon)", () => {
  const validPolygonSupply: Parameters<typeof evaluateWhitelist>[0] = {
    operation: "aave_supply_usdc_polygon",
    chainId: 137,
    to: POLYGON_CONTRACTS.AAVE_V3_POOL,
    data: `${AAVE_V3_SUPPLY_SELECTOR}0000` as `0x${string}`,
    value: 0n,
    usdValue: 20,
  };

  it("approves valid Polygon Aave supply", () => {
    const d = evaluateWhitelist(validPolygonSupply, 0);
    expect(d.approved).toBe(true);
  });

  it("rejects wrong chainId", () => {
    const d = evaluateWhitelist({ ...validPolygonSupply, chainId: 8453 }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/chainId 137/);
  });

  it("rejects wrong contract", () => {
    const d = evaluateWhitelist({ ...validPolygonSupply, to: "0x0000000000000000000000000000000000000000" }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/Aave V3 Pool \(Polygon\)/);
  });
});

describe("evaluateWhitelist — Aerodrome USDC/USDbC LP (Base)", () => {
  const validLp: Parameters<typeof evaluateWhitelist>[0] = {
    operation: "aerodrome_add_liquidity",
    chainId: 8453,
    to: BASE_CONTRACTS.AERODROME_ROUTER,
    data: `${AERODROME_ADD_LIQUIDITY_SELECTOR}0000` as `0x${string}`,
    value: 0n,
    usdValue: 30,
  };

  it("approves valid Aerodrome LP entry", () => {
    const d = evaluateWhitelist(validLp, 0);
    expect(d.approved).toBe(true);
  });

  it("rejects wrong chainId", () => {
    const d = evaluateWhitelist({ ...validLp, chainId: 137 }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/chainId 8453/);
  });

  it("rejects wrong contract", () => {
    const d = evaluateWhitelist({ ...validLp, to: "0x0000000000000000000000000000000000000000" }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/Aerodrome Router/);
  });

  it("rejects wrong selector", () => {
    const d = evaluateWhitelist({ ...validLp, data: "0xdeadbeef" as `0x${string}` }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/addLiquidity/);
  });

  it("rejects over per-tx cap", () => {
    const d = evaluateWhitelist({ ...validLp, usdValue: PER_TX_CAPS_USD.AERODROME_ADD_LIQUIDITY + 1 }, 0);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/per-tx cap/);
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
