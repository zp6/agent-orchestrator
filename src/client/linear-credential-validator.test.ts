import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateLinearCredential, assertLinearCredential } from "./linear-credential-validator.js";
import { readFileSync, existsSync } from "fs";

// Mock fs and os for testing
vi.mock("fs");
vi.mock("os", () => ({
  homedir: () => "/home/testuser",
  hostname: () => "claude-agent-orchestrator",
}));

const ENV_PATH = "/home/testuser/.claude-orchestrator/.env";
const MOUNT_PATH = "/run/secrets/claude-agent-orchestrator_linear_api_key";
const VALID_KEY = "lin_api_1234567890abcdefghijklmnopqrstuv";

/**
 * Helper: build a `readFileSync` mock that dispatches per-path. Anything not
 * explicitly handled raises ENOENT, matching real fs behavior.
 */
function setupFsMocks(opts: {
  envContent?: string | null; // null = ENOENT, undefined = not configured
  mountContent?: string | null; // null = absent, undefined = not configured
  envReadError?: Error;
  mountReadError?: Error;
}): void {
  vi.mocked(existsSync).mockImplementation((p) => {
    const path = String(p);
    if (path === MOUNT_PATH) return opts.mountContent !== undefined && opts.mountContent !== null;
    return false;
  });

  vi.mocked(readFileSync).mockImplementation((p) => {
    const path = String(p);
    if (path === ENV_PATH) {
      if (opts.envReadError) throw opts.envReadError;
      if (opts.envContent === null || opts.envContent === undefined) {
        throw new Error("ENOENT: no such file or directory");
      }
      return opts.envContent;
    }
    if (path === MOUNT_PATH) {
      if (opts.mountReadError) throw opts.mountReadError;
      if (opts.mountContent === null || opts.mountContent === undefined) {
        throw new Error("ENOENT: no such file or directory");
      }
      return opts.mountContent;
    }
    throw new Error(`Unexpected readFileSync path: ${path}`);
  });
}

describe("linear-credential-validator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_NAME;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("validateLinearCredential — env-file path (existing behavior)", () => {
    it("returns valid=true for a real API key in .env", () => {
      setupFsMocks({ envContent: `LINEAR_API_KEY=${VALID_KEY}\nLINEAR_TEAM_KEY=NEX` });

      const result = validateLinearCredential();

      expect(result.valid).toBe(true);
      expect(result.apiKey).toBe(VALID_KEY);
      expect(result.errorMessage).toBeNull();
      expect(result.suggestions).toHaveLength(0);
      expect(result.source).toBe("env-file");
    });

    it("returns valid=false for a placeholder key in .env when no mount fallback", () => {
      setupFsMocks({ envContent: "LINEAR_API_KEY=lin_api_..." });

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.apiKey).toBeNull();
      expect(result.errorMessage).toContain("placeholder");
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.source).toBeNull();
    });

    it("returns valid=false for missing LINEAR_API_KEY when no mount fallback", () => {
      setupFsMocks({ envContent: "LINEAR_TEAM_KEY=NEX\n# no api key" });

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.apiKey).toBeNull();
      expect(result.errorMessage).toContain("not found");
    });

    it("returns valid=false for invalid format when no mount fallback", () => {
      setupFsMocks({ envContent: "LINEAR_API_KEY=invalid_prefix_key" });

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.apiKey).toBeNull();
      expect(result.errorMessage).toContain("invalid format");
    });

    it("returns valid=false when both .env and mount are absent", () => {
      setupFsMocks({});

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.apiKey).toBeNull();
      expect(result.errorMessage).toContain("not available");
      // Forensic message names both paths
      expect(result.errorMessage).toContain(".env");
      expect(result.errorMessage).toContain("/run/secrets/");
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it("handles empty LINEAR_API_KEY value in .env", () => {
      setupFsMocks({ envContent: "LINEAR_API_KEY=" });

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.apiKey).toBeNull();
    });
  });

  describe("validateLinearCredential — secrets-mount fallback (issue #1490)", () => {
    it("falls back to /run/secrets when .env is missing the key", () => {
      setupFsMocks({
        envContent: "LINEAR_TEAM_KEY=NEX\n# no api key here",
        mountContent: VALID_KEY,
      });

      const result = validateLinearCredential();

      expect(result.valid).toBe(true);
      expect(result.apiKey).toBe(VALID_KEY);
      expect(result.source).toBe("secrets-mount");
    });

    it("falls back to /run/secrets when .env file does not exist", () => {
      setupFsMocks({ envContent: null, mountContent: VALID_KEY });

      const result = validateLinearCredential();

      expect(result.valid).toBe(true);
      expect(result.apiKey).toBe(VALID_KEY);
      expect(result.source).toBe("secrets-mount");
    });

    it("falls back to /run/secrets when .env contains a placeholder", () => {
      setupFsMocks({ envContent: "LINEAR_API_KEY=lin_api_...", mountContent: VALID_KEY });

      const result = validateLinearCredential();

      expect(result.valid).toBe(true);
      expect(result.apiKey).toBe(VALID_KEY);
      expect(result.source).toBe("secrets-mount");
    });

    it("strips trailing newline from secrets-mount value (matches /run/secrets convention)", () => {
      setupFsMocks({ envContent: null, mountContent: `${VALID_KEY}\n` });

      const result = validateLinearCredential();

      expect(result.valid).toBe(true);
      expect(result.apiKey).toBe(VALID_KEY);
    });

    it("rejects placeholder value in secrets-mount", () => {
      setupFsMocks({ envContent: null, mountContent: "lin_api_..." });

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain("placeholder");
    });

    it("rejects invalid-format value in secrets-mount", () => {
      setupFsMocks({ envContent: null, mountContent: "not_a_linear_key" });

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain("invalid format");
    });

    it("prefers .env over secrets-mount when both have valid keys (env wins)", () => {
      const envKey = "lin_api_envvalueABCDEFGHIJKLMNOPQRSTUVWX";
      const mountKey = "lin_api_mountvalueABCDEFGHIJKLMNOPQRSTU";
      setupFsMocks({ envContent: `LINEAR_API_KEY=${envKey}`, mountContent: mountKey });

      const result = validateLinearCredential();

      expect(result.valid).toBe(true);
      expect(result.apiKey).toBe(envKey);
      expect(result.source).toBe("env-file");
    });

    it("respects AGENT_NAME override for the secrets-mount path", () => {
      // When AGENT_NAME is set, the mount path uses it instead of hostname.
      process.env.AGENT_NAME = "custom-agent-name";

      vi.mocked(existsSync).mockImplementation((p) =>
        String(p) === "/run/secrets/custom-agent-name_linear_api_key",
      );
      vi.mocked(readFileSync).mockImplementation((p) => {
        const path = String(p);
        if (path === "/run/secrets/custom-agent-name_linear_api_key") return VALID_KEY;
        throw new Error("ENOENT");
      });

      const result = validateLinearCredential();

      expect(result.valid).toBe(true);
      expect(result.source).toBe("secrets-mount");
    });
  });

  describe("validateLinearCredential — error reporting", () => {
    it("includes both attempted paths in the error message when nothing works", () => {
      setupFsMocks({});

      const result = validateLinearCredential();

      expect(result.errorMessage).toContain(".claude-orchestrator/.env");
      expect(result.errorMessage).toContain("/run/secrets/claude-agent-orchestrator_linear_api_key");
    });

    it("returns valid=false when env read raises a non-ENOENT error and no mount", () => {
      setupFsMocks({
        envReadError: new Error("EACCES: permission denied"),
      });

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain("EACCES");
    });
  });

  describe("assertLinearCredential", () => {
    it("returns the API key when valid (env path)", () => {
      setupFsMocks({ envContent: `LINEAR_API_KEY=${VALID_KEY}` });

      const key = assertLinearCredential();

      expect(key).toBe(VALID_KEY);
    });

    it("returns the API key when valid (mount path)", () => {
      setupFsMocks({ envContent: null, mountContent: VALID_KEY });

      const key = assertLinearCredential();

      expect(key).toBe(VALID_KEY);
    });

    it("throws with helpful message when credential is invalid", () => {
      setupFsMocks({ envContent: "LINEAR_API_KEY=lin_api_..." });

      expect(() => assertLinearCredential()).toThrow(
        /Linear credential validation failed.*placeholder/,
      );
    });

    it("throws when both env file and mount are missing", () => {
      setupFsMocks({});

      expect(() => assertLinearCredential()).toThrow(
        /Linear credential validation failed.*not available/,
      );
    });
  });
});
