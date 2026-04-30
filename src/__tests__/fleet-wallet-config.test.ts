import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveWalletAddress,
  resolveWalletNetwork,
  getFleetWalletConfig,
  getFleetConfigPayload,
} from "../reviewer/fleet-wallet-config.js";
import type { ReviewerConfig } from "../config.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_CONFIG: ReviewerConfig = {
  base_dir: "/tmp",
  orchestrator_dir: "/tmp/orchestrator",
  agents: {},
};

function withFleet(overrides: NonNullable<ReviewerConfig["fleet"]>): ReviewerConfig {
  return { ...BASE_CONFIG, fleet: overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveWalletAddress", () => {
  beforeEach(() => {
    delete process.env.FLEET_WALLET_ADDRESS;
  });
  afterEach(() => {
    delete process.env.FLEET_WALLET_ADDRESS;
  });

  it("returns empty string when config and env are both absent", () => {
    expect(resolveWalletAddress()).toBe("");
    expect(resolveWalletAddress(BASE_CONFIG)).toBe("");
  });

  it("reads from FLEET_WALLET_ADDRESS env var", () => {
    process.env.FLEET_WALLET_ADDRESS = "0xABCDEF";
    expect(resolveWalletAddress()).toBe("0xABCDEF");
  });

  it("config.fleet.wallet_address takes priority over env var", () => {
    process.env.FLEET_WALLET_ADDRESS = "0xENV";
    expect(resolveWalletAddress(withFleet({ wallet_address: "0xCONFIG" }))).toBe("0xCONFIG");
  });

  it("trims whitespace from config value", () => {
    expect(resolveWalletAddress(withFleet({ wallet_address: "  0xTRIM  " }))).toBe("0xTRIM");
  });

  it("falls back to env when config fleet is present but wallet_address is empty", () => {
    process.env.FLEET_WALLET_ADDRESS = "0xFALLBACK";
    expect(resolveWalletAddress(withFleet({ wallet_network: "Base" }))).toBe("0xFALLBACK");
  });

  it("handles null config gracefully", () => {
    process.env.FLEET_WALLET_ADDRESS = "0xNULL";
    expect(resolveWalletAddress(null)).toBe("0xNULL");
  });
});

describe("resolveWalletNetwork", () => {
  beforeEach(() => {
    delete process.env.FLEET_WALLET_NETWORK;
  });
  afterEach(() => {
    delete process.env.FLEET_WALLET_NETWORK;
  });

  it("returns empty string when not configured", () => {
    expect(resolveWalletNetwork()).toBe("");
  });

  it("reads from FLEET_WALLET_NETWORK env var", () => {
    process.env.FLEET_WALLET_NETWORK = "Base";
    expect(resolveWalletNetwork()).toBe("Base");
  });

  it("config takes priority over env", () => {
    process.env.FLEET_WALLET_NETWORK = "Ethereum";
    expect(resolveWalletNetwork(withFleet({ wallet_network: "Base" }))).toBe("Base");
  });
});

describe("getFleetWalletConfig", () => {
  beforeEach(() => {
    delete process.env.FLEET_WALLET_ADDRESS;
    delete process.env.FLEET_WALLET_NETWORK;
  });
  afterEach(() => {
    delete process.env.FLEET_WALLET_ADDRESS;
    delete process.env.FLEET_WALLET_NETWORK;
  });

  it("returns configured=false when wallet_address is empty", () => {
    const cfg = getFleetWalletConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.wallet_address).toBe("");
  });

  it("returns configured=true when wallet_address is set", () => {
    process.env.FLEET_WALLET_ADDRESS = "0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef";
    const cfg = getFleetWalletConfig();
    expect(cfg.configured).toBe(true);
    expect(cfg.wallet_address).toBe("0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef");
  });

  it("populates wallet_network", () => {
    const cfg = getFleetWalletConfig(withFleet({ wallet_address: "0x1", wallet_network: "Base" }));
    expect(cfg.wallet_network).toBe("Base");
  });
});

describe("getFleetConfigPayload", () => {
  beforeEach(() => {
    delete process.env.FLEET_WALLET_ADDRESS;
    delete process.env.FLEET_WALLET_NETWORK;
    delete process.env.FLEET_GITHUB_SPONSORS_URL;
    delete process.env.FLEET_POLAR_URL;
    delete process.env.FLEET_ALGORA_URL;
    delete process.env.FLEET_GITCOIN_URL;
  });
  afterEach(() => {
    delete process.env.FLEET_WALLET_ADDRESS;
    delete process.env.FLEET_WALLET_NETWORK;
    delete process.env.FLEET_GITHUB_SPONSORS_URL;
    delete process.env.FLEET_POLAR_URL;
    delete process.env.FLEET_ALGORA_URL;
    delete process.env.FLEET_GITCOIN_URL;
  });

  it("returns all fields with empty strings when nothing configured", () => {
    const payload = getFleetConfigPayload();
    expect(payload.wallet_address).toBe("");
    expect(payload.wallet_network).toBe("");
    expect(payload.configured).toBe(false);
    expect(payload.github_sponsors_url).toBe("");
    expect(payload.polar_url).toBe("");
    expect(payload.algora_url).toBe("");
    expect(payload.gitcoin_url).toBe("");
    expect(payload.computed_at).toBeTruthy();
  });

  it("reads revenue URLs from env vars", () => {
    process.env.FLEET_WALLET_ADDRESS = "0x1";
    process.env.FLEET_WALLET_NETWORK = "Base";
    process.env.FLEET_GITHUB_SPONSORS_URL = "https://github.com/sponsors/rapartlu";
    process.env.FLEET_POLAR_URL = "https://polar.sh/rapartlu";
    process.env.FLEET_ALGORA_URL = "https://algora.io/rapartlu";
    process.env.FLEET_GITCOIN_URL = "https://gitcoin.co/grants/rapartlu";

    const payload = getFleetConfigPayload();
    expect(payload.configured).toBe(true);
    expect(payload.wallet_address).toBe("0x1");
    expect(payload.wallet_network).toBe("Base");
    expect(payload.github_sponsors_url).toBe("https://github.com/sponsors/rapartlu");
    expect(payload.polar_url).toBe("https://polar.sh/rapartlu");
    expect(payload.algora_url).toBe("https://algora.io/rapartlu");
    expect(payload.gitcoin_url).toBe("https://gitcoin.co/grants/rapartlu");
  });

  it("config takes priority over env for revenue URLs", () => {
    process.env.FLEET_POLAR_URL = "https://polar.sh/env";
    const payload = getFleetConfigPayload(
      withFleet({ polar_url: "https://polar.sh/config" })
    );
    expect(payload.polar_url).toBe("https://polar.sh/config");
  });

  it("computed_at is a valid ISO-8601 timestamp", () => {
    const payload = getFleetConfigPayload();
    expect(() => new Date(payload.computed_at)).not.toThrow();
    expect(new Date(payload.computed_at).getTime()).toBeGreaterThan(0);
  });

  it("uses canonical wallet address from orchestrator#1331", () => {
    // This mirrors the value baked into agents.yaml providers.global
    const canonical = "0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef";
    const payload = getFleetConfigPayload(
      withFleet({ wallet_address: canonical, wallet_network: "Base" })
    );
    expect(payload.wallet_address).toBe(canonical);
    expect(payload.wallet_network).toBe("Base");
    expect(payload.configured).toBe(true);
  });
});
