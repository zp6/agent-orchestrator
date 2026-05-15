import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkUrlsInDiff,
  formatPreflightFailureReport,
  formatPreflightHelp,
  scanPreflightUrlCandidates,
} from "../reviewer/preflight.js";
import { runPreflightCli } from "../cli/preflight.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-preflight-"));
  tempDirs.push(dir);
  return dir;
}

function makeDiff(filePath: string, lines: string[]): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1,0 +1,1 @@",
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

describe("preflight help", () => {
  it("mentions URL checks, skip flags, and the stub marker", () => {
    const help = formatPreflightHelp();
    expect(help).toContain("orch preflight");
    expect(help).toContain("--check-urls");
    expect(help).toContain("--skip-url-check");
    expect(help).toContain("@preflight-skip-url-check");
  });
});

describe("scanPreflightUrlCandidates", () => {
  it("extracts URL literals from added diff lines", () => {
    const diff = makeDiff("src/adapters/immunefi.ts", [
      `const API_BASE = "https://api.immunefi.com/v1/submissions";`,
      `const DOCS = "https://example.com/docs";`,
    ]);
    const candidates = scanPreflightUrlCandidates(diff);
    expect(candidates.map((c) => c.url)).toEqual([
      "https://api.immunefi.com/v1/submissions",
      "https://example.com/docs",
    ]);
    expect(candidates[0]?.filePath).toBe("src/adapters/immunefi.ts");
  });

  it("skips files marked with @preflight-skip-url-check", () => {
    const diff = makeDiff("src/stubs/offline.ts", [
      `// @preflight-skip-url-check`,
      `const URL = "https://api.example.invalid/v1";`,
    ]);
    expect(scanPreflightUrlCandidates(diff)).toEqual([]);
  });
});

describe("checkUrlsInDiff", () => {
  it("flags a root host failure for the Immunefi API case", async () => {
    const diff = makeDiff("src/adapters/immunefi.ts", [
      `const API_BASE = "https://api.immunefi.com/v1/submissions";`,
    ]);
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const report = await checkUrlsInDiff(diff, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cachePath: join(makeTempDir(), "cache.json"),
      now: () => 0,
    });

    expect(report.checked).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.reason).toContain("api.immunefi.com unreachable: ECONNREFUSED");
    expect(report.failures[0]?.filePath).toBe("src/adapters/immunefi.ts");
  });

  it("deduplicates host probes and performs a path probe per unique URL", async () => {
    const diff = makeDiff("src/adapters/example.ts", [
      `const FIRST = "https://api.preflight-demo.invalid/v1/submissions";`,
      `const SECOND = "https://api.preflight-demo.invalid/v1/status";`,
    ]);
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "HEAD" && url === "https://api.preflight-demo.invalid/") {
        return new Response("", { status: 200 });
      }
      if (init?.method === "HEAD" && url === "https://api.preflight-demo.invalid/v1/submissions") {
        return new Response("", { status: 404 });
      }
      if (init?.method === "HEAD" && url === "https://api.preflight-demo.invalid/v1/status") {
        return new Response("", { status: 200 });
      }
      throw new Error(`unexpected request: ${url} ${init?.method ?? "GET"}`);
    });

    const report = await checkUrlsInDiff(diff, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cachePath: join(makeTempDir(), "cache.json"),
      now: () => 0,
    });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.reason).toContain("404");
    expect(seen.filter((line) => line === "HEAD https://api.preflight-demo.invalid/")).toHaveLength(1);
    expect(seen.filter((line) => line === "HEAD https://api.preflight-demo.invalid/v1/submissions")).toHaveLength(1);
    expect(seen.filter((line) => line === "HEAD https://api.preflight-demo.invalid/v1/status")).toHaveLength(1);
  });

  it("skips internal hostnames without probing", async () => {
    const diff = makeDiff("src/local.ts", [
      `const LOCAL = "http://localhost:3000/health";`,
      `const TEST = "https://api.example.com/v1";`,
    ]);
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const report = await checkUrlsInDiff(diff, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cachePath: join(makeTempDir(), "cache.json"),
      now: () => 0,
    });

    expect(report.failures).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("reuses cached probe results within the TTL", async () => {
    const diff = makeDiff("src/adapters/cache.ts", [
      `const API = "https://api.cache-test.invalid/v1";`,
    ]);
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const tempDir = makeTempDir();
    const cachePath = join(tempDir, "cache.json");

    const first = await checkUrlsInDiff(diff, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cachePath,
      now: () => 1_000,
    });
    const second = await checkUrlsInDiff(diff, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cachePath,
      now: () => 1_500,
    });

    expect(first.failures).toHaveLength(0);
    expect(second.failures).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(readFileSync(cachePath, "utf-8")).toContain("cache-test.invalid");
  });

  it("counts skipped files when the inline skip marker is present", async () => {
    const diff = makeDiff("src/stubs/offline.ts", [
      `// @preflight-skip-url-check`,
      `const URL = "https://api.example.invalid/v1";`,
    ]);
    const report = await checkUrlsInDiff(diff, {
      cachePath: join(makeTempDir(), "cache.json"),
      now: () => 0,
    });

    expect(report.checked).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.failures).toHaveLength(0);
  });
});

describe("formatPreflightFailureReport", () => {
  it("renders a structured failure report", () => {
    const report = formatPreflightFailureReport({
      checked: 1,
      skipped: 0,
      failures: [
        {
          url: "https://api.immunefi.com/v1/submissions",
          hostname: "api.immunefi.com",
          filePath: "src/adapters/immunefi.ts",
          lineNumber: 12,
          reason: "api.immunefi.com unreachable: ECONNREFUSED",
          rootStatus: "ECONNREFUSED",
        },
      ],
    });

    expect(report).toContain("Preflight failed.");
    expect(report).toContain("src/adapters/immunefi.ts:12");
    expect(report).toContain("api.immunefi.com unreachable: ECONNREFUSED");
    expect(report).toContain("@preflight-skip-url-check");
  });
});

describe("runPreflightCli", () => {
  it("returns help text for --help", async () => {
    const result = await runPreflightCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("orch preflight");
    expect(result.stdout).toContain("--check-urls");
  });

  it("fails on the Immunefi URL with the concrete host-level message", async () => {
    const tempDir = makeTempDir();
    const diffFile = join(tempDir, "diff.txt");
    writeFileSync(
      diffFile,
      makeDiff("src/adapters/immunefi.ts", [
        `const API_BASE = "https://api.immunefi.com/v1/submissions";`,
      ]),
      "utf-8",
    );

    const result = await runPreflightCli(["--diff-file", diffFile], {
      fetchImpl: vi.fn(async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      }) as unknown as typeof fetch,
      cachePath: join(tempDir, "cache.json"),
      now: () => 0,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("api.immunefi.com unreachable: ECONNREFUSED");
    expect(result.stderr).toContain("src/adapters/immunefi.ts:1");
  });

  it("respects --skip-url-check", async () => {
    const result = await runPreflightCli(["--skip-url-check"], {
      diffText: makeDiff("src/anything.ts", [`const URL = "https://example.com";`]),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("URL check skipped");
  });
});
