/**
 * Unit tests for revenue-watcher.ts
 *
 * Strategy: inject a mock viem PublicClient via `opts.publicClient` and a
 * minimal StateStore stub so we can test all code paths without touching the
 * network or a real SQLite database.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  dispatchRevenueWatcher,
  parseUsdcAmount,
  formatDepositAlert,
  USDC_DECIMALS,
  NOTIFICATION_THRESHOLD_USD,
  MAX_BLOCKS_PER_SCAN,
  FLEET_WALLET,
  type RevenueWatcherResult,
} from "./revenue-watcher.js";
import type { StateStore } from "../state/store.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../service/telegram.js", () => ({
  sendTelegramAlert: vi.fn(),
}));

import { sendTelegramAlert } from "../service/telegram.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Minimal StateStore stub containing only the revenue-watcher methods.
 */
function makeStore(
  opts: {
    lastBlock?: bigint | null;
    presentHashes?: Set<string>;
  } = {},
): Pick<
  StateStore,
  | "getRevenueWatcherLastBlock"
  | "setRevenueWatcherLastBlock"
  | "insertRevenueLog"
  | "isRevenueLogEntryPresent"
> & { _setLastBlock: bigint | undefined; _insertedEntries: unknown[] } {
  let lastBlock: bigint | null = opts.lastBlock ?? null;
  const presentHashes = opts.presentHashes ?? new Set<string>();
  const insertedEntries: unknown[] = [];
  let storedBlock: bigint | undefined;

  return {
    _setLastBlock: undefined as bigint | undefined,
    _insertedEntries: insertedEntries,
    getRevenueWatcherLastBlock: () => lastBlock,
    setRevenueWatcherLastBlock: (block: bigint) => {
      storedBlock = block;
      (store as typeof store)._setLastBlock = block;
      lastBlock = block;
    },
    insertRevenueLog: (entry: unknown) => {
      insertedEntries.push(entry);
    },
    isRevenueLogEntryPresent: (txHash: string) => presentHashes.has(txHash),
  } as unknown as ReturnType<typeof makeStore>;

  // workaround: assign to a local var so closures share state
  const store = {} as ReturnType<typeof makeStore>;
  return store;
}

/** Simplified make-store with proper closure */
function makeStoreSimple(opts: {
  lastBlock?: bigint | null;
  presentHashes?: Set<string>;
}): {
  store: Pick<
    StateStore,
    | "getRevenueWatcherLastBlock"
    | "setRevenueWatcherLastBlock"
    | "insertRevenueLog"
    | "isRevenueLogEntryPresent"
  >;
  setLastBlockCallArgs: bigint[];
  insertedEntries: unknown[];
} {
  let lastBlock: bigint | null = opts.lastBlock ?? null;
  const presentHashes = opts.presentHashes ?? new Set<string>();
  const insertedEntries: unknown[] = [];
  const setLastBlockCallArgs: bigint[] = [];

  const store = {
    getRevenueWatcherLastBlock: () => lastBlock,
    setRevenueWatcherLastBlock: (block: bigint) => {
      lastBlock = block;
      setLastBlockCallArgs.push(block);
    },
    insertRevenueLog: (entry: unknown) => {
      insertedEntries.push(entry);
    },
    isRevenueLogEntryPresent: (txHash: string) => presentHashes.has(txHash),
  } as unknown as Pick<
    StateStore,
    | "getRevenueWatcherLastBlock"
    | "setRevenueWatcherLastBlock"
    | "insertRevenueLog"
    | "isRevenueLogEntryPresent"
  >;

  return { store, setLastBlockCallArgs, insertedEntries };
}

/**
 * Build a minimal mock viem PublicClient.
 */
function makeMockClient(opts: {
  currentBlock: bigint;
  logs?: unknown[];
  blockTimestamp?: bigint;
}) {
  const logs = opts.logs ?? [];
  const ts = opts.blockTimestamp ?? 1_700_000_000n;

  return {
    getBlockNumber: vi.fn().mockResolvedValue(opts.currentBlock),
    getLogs: vi.fn().mockResolvedValue(logs),
    getBlock: vi.fn().mockResolvedValue({ timestamp: ts }),
  } as unknown as import("viem").PublicClient;
}

// ── Helper types ──────────────────────────────────────────────────────────────

function makeTransferLog(opts: {
  txHash: string;
  value: bigint;
  blockNumber: bigint;
}) {
  return {
    transactionHash: opts.txHash,
    blockNumber: opts.blockNumber,
    args: { value: opts.value },
  };
}

// ── Feature flag tests ────────────────────────────────────────────────────────

describe("dispatchRevenueWatcher — feature flag", () => {
  afterEach(() => {
    delete process.env.REVENUE_WATCHER_ENABLED;
    vi.clearAllMocks();
  });

  it("returns skipped=1 when REVENUE_WATCHER_ENABLED is not set", async () => {
    const { store } = makeStoreSimple({});
    const result = await dispatchRevenueWatcher(store as unknown as StateStore);
    expect(result).toEqual({ dispatched: 0, skipped: 1, errors: [] });
  });

  it("returns skipped=1 when REVENUE_WATCHER_ENABLED=false", async () => {
    process.env.REVENUE_WATCHER_ENABLED = "false";
    const { store } = makeStoreSimple({});
    const result = await dispatchRevenueWatcher(store as unknown as StateStore);
    expect(result.skipped).toBe(1);
    expect(result.dispatched).toBe(0);
  });
});

// ── First-run bookmark tests ──────────────────────────────────────────────────

describe("dispatchRevenueWatcher — first run (no prior bookmark)", () => {
  beforeEach(() => {
    process.env.REVENUE_WATCHER_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.REVENUE_WATCHER_ENABLED;
    vi.clearAllMocks();
  });

  it("records the current block as bookmark and returns skipped=1 without scanning", async () => {
    const client = makeMockClient({ currentBlock: 5_000_000n });
    const { store, setLastBlockCallArgs } = makeStoreSimple({ lastBlock: null });

    const result = await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    expect(result).toEqual({ dispatched: 0, skipped: 1, errors: [] });
    expect(setLastBlockCallArgs).toEqual([5_000_000n]);
    // getLogs must NOT have been called on first run
    expect((client as ReturnType<typeof makeMockClient>).getLogs).not.toHaveBeenCalled();
  });
});

// ── Already at tip ────────────────────────────────────────────────────────────

describe("dispatchRevenueWatcher — already at chain tip", () => {
  beforeEach(() => {
    process.env.REVENUE_WATCHER_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.REVENUE_WATCHER_ENABLED;
    vi.clearAllMocks();
  });

  it("returns skipped=1 when lastBlock >= currentBlock", async () => {
    const client = makeMockClient({ currentBlock: 5_000_000n });
    const { store } = makeStoreSimple({ lastBlock: 5_000_000n });

    const result = await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    expect(result.skipped).toBe(1);
    expect(result.dispatched).toBe(0);
    expect((client as ReturnType<typeof makeMockClient>).getLogs).not.toHaveBeenCalled();
  });
});

// ── Normal scan with deposits ─────────────────────────────────────────────────

describe("dispatchRevenueWatcher — normal scan", () => {
  beforeEach(() => {
    process.env.REVENUE_WATCHER_ENABLED = "true";
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.REVENUE_WATCHER_ENABLED;
    vi.clearAllMocks();
  });

  it("records a new deposit and advances the block bookmark", async () => {
    const txHash = "0xabc123";
    const value = 10_000_000n; // 10 USDC
    const logs = [makeTransferLog({ txHash, value, blockNumber: 5_000_001n })];
    const client = makeMockClient({
      currentBlock: 5_000_001n,
      logs,
      blockTimestamp: 1_700_001_000n,
    });
    const { store, setLastBlockCallArgs, insertedEntries } = makeStoreSimple({
      lastBlock: 5_000_000n,
    });

    const result = await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    expect(result.dispatched).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(insertedEntries).toHaveLength(1);
    const entry = insertedEntries[0] as Record<string, unknown>;
    expect(entry.tx_hash).toBe(txHash);
    expect(entry.amount_usd).toBeCloseTo(10, 5);
    expect(entry.currency).toBe("USDC");
    expect(entry.chain).toBe("base");
    expect(entry.source).toBe("on-chain");
    expect(entry.path).toBe("direct-transfer");
    // Bookmark should advance to toBlock (5_000_001n)
    expect(setLastBlockCallArgs).toContain(5_000_001n);
  });

  it("skips already-recorded transactions (deduplication)", async () => {
    const txHash = "0xduplicate";
    const logs = [makeTransferLog({ txHash, value: 5_000_000n, blockNumber: 5_000_001n })];
    const client = makeMockClient({ currentBlock: 5_000_001n, logs });
    const { store, insertedEntries } = makeStoreSimple({
      lastBlock: 5_000_000n,
      presentHashes: new Set([txHash]),
    });

    const result = await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    expect(result.dispatched).toBe(0);
    expect(insertedEntries).toHaveLength(0);
  });

  it("sends Telegram notification when amount exceeds threshold", async () => {
    const txHash = "0xbigtx";
    const value = BigInt(100 * 10 ** USDC_DECIMALS); // $100
    const logs = [makeTransferLog({ txHash, value, blockNumber: 5_000_001n })];
    const client = makeMockClient({ currentBlock: 5_000_001n, logs });
    const { store } = makeStoreSimple({ lastBlock: 5_000_000n });

    await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
      notificationThresholdUsd: NOTIFICATION_THRESHOLD_USD,
    });

    expect(sendTelegramAlert).toHaveBeenCalledOnce();
    const alertArg = vi.mocked(sendTelegramAlert).mock.calls[0]![0];
    expect(alertArg).toContain("$100.00 USDC");
    expect(alertArg).toContain(txHash);
  });

  it("does NOT send Telegram notification for small deposits", async () => {
    const txHash = "0xsmalltx";
    const value = 1_000_000n; // $1 — below $5 threshold
    const logs = [makeTransferLog({ txHash, value, blockNumber: 5_000_001n })];
    const client = makeMockClient({ currentBlock: 5_000_001n, logs });
    const { store } = makeStoreSimple({ lastBlock: 5_000_000n });

    await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("skips transfer logs with null txHash (pending)", async () => {
    const logs = [{ transactionHash: null, blockNumber: 5_000_001n, args: { value: 5_000_000n } }];
    const client = makeMockClient({ currentBlock: 5_000_001n, logs });
    const { store, insertedEntries } = makeStoreSimple({ lastBlock: 5_000_000n });

    const result = await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    expect(result.dispatched).toBe(0);
    expect(insertedEntries).toHaveLength(0);
  });

  it("processes multiple deposits in one scan", async () => {
    const logs = [
      makeTransferLog({ txHash: "0xtx1", value: 5_000_000n, blockNumber: 5_000_001n }),
      makeTransferLog({ txHash: "0xtx2", value: 20_000_000n, blockNumber: 5_000_002n }),
    ];
    const client = makeMockClient({ currentBlock: 5_000_010n, logs });
    const { store, insertedEntries } = makeStoreSimple({ lastBlock: 5_000_000n });

    const result = await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    expect(result.dispatched).toBe(2);
    expect(insertedEntries).toHaveLength(2);
  });
});

// ── Block range capping ───────────────────────────────────────────────────────

describe("dispatchRevenueWatcher — block range capping", () => {
  beforeEach(() => {
    process.env.REVENUE_WATCHER_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.REVENUE_WATCHER_ENABLED;
    vi.clearAllMocks();
  });

  it("caps toBlock at MAX_BLOCKS_PER_SCAN from fromBlock", async () => {
    const fromBlock = 1n;
    // currentBlock is much further ahead
    const currentBlock = fromBlock + MAX_BLOCKS_PER_SCAN + 50_000n;
    const client = makeMockClient({ currentBlock, logs: [] });
    const { store, setLastBlockCallArgs } = makeStoreSimple({ lastBlock: fromBlock - 1n });

    await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    // toBlock should be capped at fromBlock + MAX_BLOCKS_PER_SCAN - 1n
    const expectedToBlock = fromBlock + MAX_BLOCKS_PER_SCAN - 1n;
    expect(setLastBlockCallArgs).toContain(expectedToBlock);
  });

  it("uses currentBlock as toBlock when it is within the cap", async () => {
    const lastBlock = 100n;
    const currentBlock = lastBlock + 100n; // well within MAX_BLOCKS_PER_SCAN
    const client = makeMockClient({ currentBlock, logs: [] });
    const { store, setLastBlockCallArgs } = makeStoreSimple({ lastBlock });

    await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    expect(setLastBlockCallArgs).toContain(currentBlock);
  });
});

// ── Fail-open on RPC errors ───────────────────────────────────────────────────

describe("dispatchRevenueWatcher — fail-open on RPC errors", () => {
  beforeEach(() => {
    process.env.REVENUE_WATCHER_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.REVENUE_WATCHER_ENABLED;
    vi.clearAllMocks();
  });

  it("returns errors[] entry and does not throw when getBlockNumber fails", async () => {
    const client = {
      getBlockNumber: vi.fn().mockRejectedValue(new Error("RPC timeout")),
      getLogs: vi.fn(),
      getBlock: vi.fn(),
    } as unknown as import("viem").PublicClient;
    const { store } = makeStoreSimple({ lastBlock: 100n });

    const result = await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("RPC timeout");
    expect(result.dispatched).toBe(0);
  });

  it("returns errors[] entry and does not throw when getLogs fails", async () => {
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(200n),
      getLogs: vi.fn().mockRejectedValue(new Error("rate limited")),
      getBlock: vi.fn(),
    } as unknown as import("viem").PublicClient;
    const { store } = makeStoreSimple({ lastBlock: 100n });

    const result = await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("rate limited");
    expect(result.dispatched).toBe(0);
  });

  it("continues processing other deposits when a single getBlock timestamp fails", async () => {
    const txHash = "0xresiliencetx";
    const logs = [makeTransferLog({ txHash, value: 8_000_000n, blockNumber: 200n })];
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(200n),
      getLogs: vi.fn().mockResolvedValue(logs),
      // getBlock throws — timestamp resolution is non-fatal
      getBlock: vi.fn().mockRejectedValue(new Error("block not found")),
    } as unknown as import("viem").PublicClient;
    const { store, insertedEntries } = makeStoreSimple({ lastBlock: 100n });

    const result = await dispatchRevenueWatcher(store as unknown as StateStore, {
      publicClient: client,
    });

    // Should still record the deposit despite timestamp fetch failure
    expect(result.dispatched).toBe(1);
    expect(insertedEntries).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Pure helper function tests ────────────────────────────────────────────────

describe("parseUsdcAmount", () => {
  it("converts 6-decimal raw value to dollars", () => {
    expect(parseUsdcAmount(1_000_000n)).toBe(1.0);
    expect(parseUsdcAmount(5_000_000n)).toBe(5.0);
    expect(parseUsdcAmount(100_000_000n)).toBe(100.0);
    expect(parseUsdcAmount(1_500_000n)).toBeCloseTo(1.5, 6);
    expect(parseUsdcAmount(0n)).toBe(0);
  });

  it("handles sub-cent values", () => {
    expect(parseUsdcAmount(1n)).toBeCloseTo(0.000001, 9);
  });
});

describe("formatDepositAlert", () => {
  it("contains amount and txHash", () => {
    const msg = formatDepositAlert("0xdeadbeef", 42.5);
    expect(msg).toContain("$42.50 USDC");
    expect(msg).toContain("0xdeadbeef");
    expect(msg).toContain("Base");
    expect(msg).toContain("direct-transfer");
  });

  it("uses Markdown bold/code formatting", () => {
    const msg = formatDepositAlert("0xabc", 10.0);
    expect(msg).toContain("*");   // bold markers
    expect(msg).toContain("`");   // code markers
  });
});
