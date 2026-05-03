import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FleetSignerClient } from "./fleet-signer-client.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock notifyOperator
vi.mock("../service/notify.js", () => ({
  notifyOperator: vi.fn(),
}));

describe("FleetSignerClient", () => {
  let client: FleetSignerClient;

  beforeEach(() => {
    client = new FleetSignerClient({ signerUrl: "http://127.0.0.1:7521" });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("health()", () => {
    it("returns health info when signer is up", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", address: "0xabc" }),
      });

      const result = await client.health();
      expect(result).toEqual({ status: "ok", address: "0xabc" });
    });

    it("returns null when signer is down", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await client.health();
      expect(result).toBeNull();
    });
  });

  describe("isReachable()", () => {
    it("returns true when healthy", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", address: "0xabc" }),
      });

      expect(await client.isReachable()).toBe(true);
    });

    it("returns false when down", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      expect(await client.isReachable()).toBe(false);
    });
  });

  describe("signAaveSupply()", () => {
    it("sends correct payload for Aave supply on Base", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ approved: true, reason: "all checks passed", signedTx: "0xsigned" }),
      });

      const result = await client.signAaveSupply(20);
      expect(result.approved).toBe(true);
      expect(result.signedTx).toBe("0xsigned");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:7521/sign");
      const body = JSON.parse(opts.body);
      expect(body.operation).toBe("aave_supply_usdc");
      expect(body.chainId).toBe(8453);
      expect(body.usdValue).toBe(20);
    });
  });

  describe("signPolymarketOrder()", () => {
    it("sends correct payload for Polymarket order", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ approved: true, reason: "all checks passed", signedTx: "0xsigned" }),
      });

      const result = await client.signPolymarketOrder("0xdeadbeef", 25);
      expect(result.approved).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.operation).toBe("polymarket_order");
      expect(body.chainId).toBe(137);
      expect(body.usdValue).toBe(25);
    });
  });

  describe("signSiwe()", () => {
    it("sends correct payload for SIWE sign", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ approved: true, reason: "SIWE domain whitelisted" }),
      });

      const result = await client.signSiwe("mirror.xyz", "Sign in to mirror.xyz");
      expect(result.approved).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.operation).toBe("siwe_sign");
      expect(body.siweDomain).toBe("mirror.xyz");
      expect(body.usdValue).toBe(0);
    });
  });

  describe("signAaveSupplyPolygon()", () => {
    it("sends correct payload for Aave on Polygon", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ approved: true, reason: "all checks passed", signedTx: "0xsigned" }),
      });

      const result = await client.signAaveSupplyPolygon(30);
      expect(result.approved).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.operation).toBe("aave_supply_usdc_polygon");
      expect(body.chainId).toBe(137);
      expect(body.usdValue).toBe(30);
    });
  });

  describe("signAerodromeLp()", () => {
    it("sends correct payload for Aerodrome LP", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ approved: true, reason: "all checks passed", signedTx: "0xsigned" }),
      });

      const result = await client.signAerodromeLp("0xe8e337000000", 40);
      expect(result.approved).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.operation).toBe("aerodrome_add_liquidity");
      expect(body.chainId).toBe(8453);
      expect(body.usdValue).toBe(40);
    });
  });

  describe("error handling", () => {
    it("returns rejection with reason when signer is unreachable", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await client.signAaveSupply(20);
      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/signer unreachable/);
    });

    it("returns rejection from signer when request is denied", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({ approved: false, reason: "daily cap exceeded" }),
      });

      const result = await client.signAaveSupply(20);
      expect(result.approved).toBe(false);
      expect(result.reason).toBe("daily cap exceeded");
    });
  });
});
