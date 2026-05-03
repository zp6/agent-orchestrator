import { describe, it, expect } from "vitest";
import { SignerClient, SignerError, SignerRejectedError } from "./signer-client.js";

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: string }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(url), init);
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("SignerClient", () => {
  it("returns parsed body on /health", async () => {
    const client = new SignerClient({
      baseUrl: "http://signer.local:7521",
      fetchImpl: mockFetch((url) => {
        expect(url).toBe("http://signer.local:7521/health");
        return { status: 200, body: JSON.stringify({ status: "ok", address: "0xabc" }) };
      }),
    });
    const out = await client.health();
    expect(out.status).toBe("ok");
    expect(out.address).toBe("0xabc");
  });

  it("returns approved on 200 /sign", async () => {
    const client = new SignerClient({
      baseUrl: "http://signer.local:7521",
      fetchImpl: mockFetch((url, init) => {
        expect(url).toBe("http://signer.local:7521/sign");
        const sent = JSON.parse(String(init?.body));
        expect(sent.value).toBe("0x0");
        expect(sent.usdValue).toBe(2);
        return { status: 200, body: JSON.stringify({ approved: true, reason: "ok", signedTx: "0xdeadbeef" }) };
      }),
    });
    const res = await client.sign({
      operation: "aave_supply_usdc",
      chainId: 8453,
      to: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
      data: "0x",
      value: 0n,
      usdValue: 2,
    });
    expect(res.approved).toBe(true);
    expect(res.signedTx).toBe("0xdeadbeef");
  });

  it("throws SignerRejectedError on 403 with reason", async () => {
    const client = new SignerClient({
      baseUrl: "http://signer.local:7521",
      fetchImpl: mockFetch(() => ({
        status: 403,
        body: JSON.stringify({ approved: false, reason: "to 0x... not Aave V3 Pool" }),
      })),
    });
    await expect(
      client.sign({
        operation: "aave_supply_usdc",
        chainId: 8453,
        to: "0x0000000000000000000000000000000000000000",
        data: "0x",
        value: 0n,
        usdValue: 2,
      }),
    ).rejects.toBeInstanceOf(SignerRejectedError);
  });

  it("throws SignerError on 500", async () => {
    const client = new SignerClient({
      baseUrl: "http://signer.local:7521",
      fetchImpl: mockFetch(() => ({ status: 500, body: JSON.stringify({ approved: false, reason: "boom" }) })),
    });
    await expect(client.health()).rejects.toBeInstanceOf(SignerError);
  });

  it("throws SignerError on network failure", async () => {
    const failing: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new SignerClient({ baseUrl: "http://x.local:7521", fetchImpl: failing });
    await expect(client.health()).rejects.toBeInstanceOf(SignerError);
  });

  it("encodes value as hex string for signer payload", async () => {
    let captured = "";
    const client = new SignerClient({
      baseUrl: "http://x.local:7521",
      fetchImpl: mockFetch((_, init) => {
        captured = String(init?.body);
        return { status: 200, body: JSON.stringify({ approved: true, reason: "ok", signedTx: "0x00" }) };
      }),
    });
    await client.sign({
      operation: "erc20_approve",
      chainId: 8453,
      to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      data: "0x",
      value: 1234n,
      usdValue: 1,
    });
    expect(JSON.parse(captured).value).toBe("0x4d2");
  });
});
