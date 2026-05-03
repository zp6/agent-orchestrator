/**
 * Unit tests for the CowSwap recipe helpers.
 *
 * These tests verify the pure utility functions (URL building, amount formatting)
 * without requiring a browser or Playwright.
 */

import { describe, it, expect } from "vitest";
import {
  buildCowSwapUrl,
  formatTokenAmount,
  parseTokenAmount,
  COWSWAP_CHAINS,
  BASE_TOKENS,
} from "../src/recipes/cowswap.js";

describe("buildCowSwapUrl", () => {
  it("builds a Base USDC→ETH URL", () => {
    const url = buildCowSwapUrl({
      sellToken: BASE_TOKENS.USDC,
      buyToken: BASE_TOKENS.ETH,
      sellAmount: "10000000", // 10 USDC
      chain: COWSWAP_CHAINS.BASE,
    });
    expect(url).toContain("swap.cow.fi");
    expect(url).toContain("/base/swap/");
    expect(url).toContain(encodeURIComponent(BASE_TOKENS.USDC));
    expect(url).toContain(encodeURIComponent(BASE_TOKENS.ETH));
  });

  it("defaults to Base chain", () => {
    const url = buildCowSwapUrl({
      sellToken: BASE_TOKENS.USDC,
      buyToken: BASE_TOKENS.WETH,
      sellAmount: "10000000",
    });
    expect(url).toContain("/base/swap/");
  });

  it("supports mainnet chain", () => {
    const url = buildCowSwapUrl({
      sellToken: BASE_TOKENS.USDC,
      buyToken: BASE_TOKENS.WETH,
      sellAmount: "10000000",
      chain: COWSWAP_CHAINS.MAINNET,
    });
    expect(url).toContain("/mainnet/swap/");
  });

  it("URL-encodes token addresses", () => {
    const url = buildCowSwapUrl({
      sellToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      buyToken: "ETH",
      sellAmount: "1000000",
    });
    // Addresses with lowercase hex and uppercase should be encoded
    expect(url).not.toContain(" ");
    expect(url.startsWith("https://")).toBe(true);
  });
});

describe("formatTokenAmount", () => {
  it("formats USDC (6 decimals) correctly", () => {
    expect(formatTokenAmount("10000000")).toBe("10"); // 10 USDC
    expect(formatTokenAmount("1000000")).toBe("1"); // 1 USDC
    expect(formatTokenAmount("500000")).toBe("0.5"); // 0.5 USDC
    expect(formatTokenAmount("1500000")).toBe("1.5"); // 1.5 USDC
  });

  it("trims trailing zeros in fractional part", () => {
    expect(formatTokenAmount("1100000")).toBe("1.1"); // 1.100000 → "1.1"
    expect(formatTokenAmount("1050000")).toBe("1.05"); // 1.050000 → "1.05"
  });

  it("formats whole numbers without decimal point", () => {
    expect(formatTokenAmount("5000000")).toBe("5");
    expect(formatTokenAmount("100000000")).toBe("100");
  });

  it("formats ETH (18 decimals) correctly", () => {
    const oneEth = BigInt("1000000000000000000");
    expect(formatTokenAmount(oneEth, 18)).toBe("1");
    const halfEth = BigInt("500000000000000000");
    expect(formatTokenAmount(halfEth, 18)).toBe("0.5");
  });

  it("accepts bigint input", () => {
    expect(formatTokenAmount(10_000_000n)).toBe("10");
  });
});

describe("parseTokenAmount", () => {
  it("parses USDC amounts (6 decimals)", () => {
    expect(parseTokenAmount("10")).toBe(10_000_000n);
    expect(parseTokenAmount("1")).toBe(1_000_000n);
    expect(parseTokenAmount("0.5")).toBe(500_000n);
    expect(parseTokenAmount("1.5")).toBe(1_500_000n);
  });

  it("parses ETH amounts (18 decimals)", () => {
    expect(parseTokenAmount("1", 18)).toBe(BigInt("1000000000000000000"));
    expect(parseTokenAmount("0.5", 18)).toBe(BigInt("500000000000000000"));
  });

  it("handles amounts without fractional part", () => {
    expect(parseTokenAmount("100")).toBe(100_000_000n);
  });

  it("is the inverse of formatTokenAmount", () => {
    const original = 7_250_000n; // 7.25 USDC
    const formatted = formatTokenAmount(original, 6);
    const reparsed = parseTokenAmount(formatted, 6);
    expect(reparsed).toBe(original);
  });

  it("truncates fractional digits beyond precision", () => {
    // 6 decimal precision: "1.1234567" → treat as "1.123456"
    const result = parseTokenAmount("1.1234567", 6);
    expect(result).toBe(1_123_456n);
  });
});

describe("COWSWAP_CHAINS constants", () => {
  it("has expected chain slugs", () => {
    expect(COWSWAP_CHAINS.BASE).toBe("base");
    expect(COWSWAP_CHAINS.MAINNET).toBe("mainnet");
    expect(COWSWAP_CHAINS.GNOSIS).toBe("gnosis");
    expect(COWSWAP_CHAINS.ARBITRUM).toBe("arbitrum");
    expect(COWSWAP_CHAINS.POLYGON).toBe("polygon");
  });
});

describe("BASE_TOKENS constants", () => {
  it("has well-known Base token addresses", () => {
    expect(BASE_TOKENS.USDC).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(BASE_TOKENS.WETH).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(BASE_TOKENS.DAI).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(BASE_TOKENS.USDT).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(BASE_TOKENS.ETH).toBe("ETH");
  });
});
