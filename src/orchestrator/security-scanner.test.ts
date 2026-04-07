import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isLiveEnvFile,
  looksLikeRealSecret,
  scanContentForSecrets,
  scanDockerComposeForEnvFiles,
  todayDateString,
  maybeRunDailySecurityScan,
  type SecurityScanState,
} from "./security-scanner.js";
import type { OrchestratorConfig } from "../config/schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(
  agents: Record<string, { github?: string }> = {},
): OrchestratorConfig {
  return {
    proxy: { url: "http://localhost:3000", api_key: "test" },
    base_dir: "/tmp",
    orchestrator_dir: "/tmp/orch",
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, a]) => [
        name,
        {
          dir: "/tmp",
          github: a.github,
          capabilities: [],
          description: "test",
          owns_topics: [],
        },
      ]),
    ),
  } as unknown as OrchestratorConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// isLiveEnvFile
// ─────────────────────────────────────────────────────────────────────────────

describe("isLiveEnvFile", () => {
  it("returns true for a bare .env file", () => {
    expect(isLiveEnvFile(".env")).toBe(true);
  });

  it("returns true for a nested .env file", () => {
    expect(isLiveEnvFile("services/api/.env")).toBe(true);
  });

  it("returns true for .env.production", () => {
    expect(isLiveEnvFile(".env.production")).toBe(true);
  });

  it("returns false for .env.example", () => {
    expect(isLiveEnvFile(".env.example")).toBe(false);
  });

  it("returns false for .env.sample", () => {
    expect(isLiveEnvFile(".env.sample")).toBe(false);
  });

  it("returns false for .env.template", () => {
    expect(isLiveEnvFile(".env.template")).toBe(false);
  });

  it("returns false for .env.test", () => {
    expect(isLiveEnvFile(".env.test")).toBe(false);
  });

  it("returns false for .env.ci", () => {
    expect(isLiveEnvFile(".env.ci")).toBe(false);
  });

  it("returns false for a non-env file", () => {
    expect(isLiveEnvFile("src/index.ts")).toBe(false);
  });

  it("returns false for README.md", () => {
    expect(isLiveEnvFile("README.md")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// looksLikeRealSecret
// ─────────────────────────────────────────────────────────────────────────────

describe("looksLikeRealSecret", () => {
  it("returns true for a realistic API key", () => {
    expect(looksLikeRealSecret("sk-abc123XYZ456def789")).toBe(true);
  });

  it("returns true for a long hex token", () => {
    expect(looksLikeRealSecret("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4")).toBe(true);
  });

  it("returns false for placeholder starting with 'your_'", () => {
    expect(looksLikeRealSecret("your_api_key_here")).toBe(false);
  });

  it("returns false for placeholder containing 'example'", () => {
    expect(looksLikeRealSecret("example_token")).toBe(false);
  });

  it("returns false for angle-bracket placeholders", () => {
    expect(looksLikeRealSecret("<your-token>")).toBe(false);
  });

  it("returns false for 'changeme'", () => {
    expect(looksLikeRealSecret("changeme")).toBe(false);
  });

  it("returns false for environment variable references", () => {
    expect(looksLikeRealSecret("$MY_TOKEN")).toBe(false);
    expect(looksLikeRealSecret("${MY_TOKEN}")).toBe(false);
  });

  it("returns false for very short values", () => {
    expect(looksLikeRealSecret("abc")).toBe(false);
    expect(looksLikeRealSecret("")).toBe(false);
  });

  it("returns false for the string 'true'", () => {
    expect(looksLikeRealSecret("true")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scanContentForSecrets
// ─────────────────────────────────────────────────────────────────────────────

describe("scanContentForSecrets", () => {
  it("finds a plaintext API key assignment", () => {
    const content = "API_KEY=sk-realkey12345678\nOTHER=value\n";
    const findings = scanContentForSecrets(content, "owner/repo", ".env");
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const finding = findings[0];
    expect(finding.patternName).toContain("plaintext secret");
    expect(finding.filePath).toBe(".env");
    expect(finding.lineNumber).toBe(1);
    expect(finding.description).toContain("API_KEY");
  });

  it("ignores commented-out lines", () => {
    const content = "# API_KEY=sk-realkey12345678\n";
    const findings = scanContentForSecrets(content, "owner/repo", ".env");
    expect(findings).toHaveLength(0);
  });

  it("ignores placeholder values", () => {
    const content = "API_KEY=your_api_key_here\nSECRET_KEY=<replace_me>\n";
    const findings = scanContentForSecrets(content, "owner/repo", ".env");
    expect(findings).toHaveLength(0);
  });

  it("ignores environment variable references", () => {
    const content = "TOKEN=${MY_TOKEN}\nSECRET=$OTHER_SECRET\n";
    const findings = scanContentForSecrets(content, "owner/repo", ".env");
    expect(findings).toHaveLength(0);
  });

  it("finds multiple secrets on different lines", () => {
    const content = [
      "API_KEY=realkey123456789",
      "SECRET_TOKEN=anothersecretvalue123",
      "NORMAL_VAR=not-a-secret",
    ].join("\n");
    const findings = scanContentForSecrets(content, "owner/repo", ".env");
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for benign content", () => {
    const content = "PORT=3000\nNODE_ENV=production\nDEBUG=false\n";
    const findings = scanContentForSecrets(content, "owner/repo", ".env");
    expect(findings).toHaveLength(0);
  });

  it("masks the secret value in the description", () => {
    const content = "API_KEY=supersecretkey9876\n";
    const findings = scanContentForSecrets(content, "owner/repo", ".env");
    expect(findings[0].description).toContain("***");
    expect(findings[0].description).not.toContain("supersecretkey9876");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scanDockerComposeForEnvFiles
// ─────────────────────────────────────────────────────────────────────────────

describe("scanDockerComposeForEnvFiles", () => {
  it("detects env_file referencing a live .env", () => {
    const content = `
services:
  api:
    image: node:20
    env_file:
      - .env
`;
    const findings = scanDockerComposeForEnvFiles(content, "owner/repo", "docker-compose.yml");
    expect(findings).toHaveLength(1);
    expect(findings[0].patternName).toContain("Docker Compose env_file");
    expect(findings[0].description).toContain(".env");
  });

  it("ignores env_file pointing to .env.example", () => {
    const content = `
services:
  api:
    env_file:
      - .env.example
`;
    const findings = scanDockerComposeForEnvFiles(content, "owner/repo", "docker-compose.yml");
    expect(findings).toHaveLength(0);
  });

  it("ignores env_file pointing to .env.sample", () => {
    const content = `
services:
  api:
    env_file: .env.sample
`;
    const findings = scanDockerComposeForEnvFiles(content, "owner/repo", "docker-compose.yml");
    expect(findings).toHaveLength(0);
  });

  it("detects multiple env_file references", () => {
    const content = `
services:
  api:
    env_file:
      - .env
      - secrets.env
`;
    const findings = scanDockerComposeForEnvFiles(content, "owner/repo", "docker-compose.yml");
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for compose files without env_file", () => {
    const content = `
services:
  api:
    image: node:20
    environment:
      - NODE_ENV=production
`;
    const findings = scanDockerComposeForEnvFiles(content, "owner/repo", "docker-compose.yml");
    expect(findings).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// todayDateString
// ─────────────────────────────────────────────────────────────────────────────

describe("todayDateString", () => {
  it("returns YYYY-MM-DD format", () => {
    const result = todayDateString(new Date("2026-04-06T10:30:00"));
    expect(result).toBe("2026-04-06");
  });

  it("pads month and day with leading zero", () => {
    const result = todayDateString(new Date("2026-01-05T00:00:00"));
    expect(result).toBe("2026-01-05");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maybeRunDailySecurityScan scheduling
// ─────────────────────────────────────────────────────────────────────────────

describe("maybeRunDailySecurityScan", () => {
  // We don't want the scan to actually run (it calls gh api / execSync)
  // so we just test the scheduling logic by using a config with no agents.
  const emptyConfig = makeConfig({});

  it("does not run before 02:00 local time", async () => {
    const state: SecurityScanState = { lastScanDate: null };
    // 01:59
    const before2am = new Date("2026-04-06T01:59:00");
    await maybeRunDailySecurityScan(state, emptyConfig, before2am);
    // If it had tried to run, lastScanDate would be set
    expect(state.lastScanDate).toBeNull();
  });

  it("runs once after 02:00 when lastScanDate is null", async () => {
    const state: SecurityScanState = { lastScanDate: null };
    const after2am = new Date("2026-04-06T03:00:00");
    await maybeRunDailySecurityScan(state, emptyConfig, after2am);
    // With no agents, runSecurityScan is a no-op but lastScanDate still updates
    expect(state.lastScanDate).toBe("2026-04-06");
  });

  it("does not run again the same day", async () => {
    const state: SecurityScanState = { lastScanDate: "2026-04-06" };
    const after2am = new Date("2026-04-06T10:00:00");
    const before = state.lastScanDate;
    await maybeRunDailySecurityScan(state, emptyConfig, after2am);
    // State should be unchanged (already ran today)
    expect(state.lastScanDate).toBe(before);
  });

  it("runs again the next day", async () => {
    const state: SecurityScanState = { lastScanDate: "2026-04-06" };
    const nextDay = new Date("2026-04-07T03:00:00");
    await maybeRunDailySecurityScan(state, emptyConfig, nextDay);
    expect(state.lastScanDate).toBe("2026-04-07");
  });
});
