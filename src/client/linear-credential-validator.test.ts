import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateLinearCredential, assertLinearCredential } from "./linear-credential-validator.js";
import { readFileSync } from "fs";

// Mock fs and os for testing
vi.mock("fs");
vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

describe("linear-credential-validator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("validateLinearCredential", () => {
    it("returns valid=true for a real API key", () => {
      vi.mocked(readFileSync).mockReturnValue(
        "LINEAR_API_KEY=lin_api_1234567890abcdefghijklmnopqrstuv\nLINEAR_TEAM_KEY=NEX"
      );

      const result = validateLinearCredential();

      expect(result.valid).toBe(true);
      expect(result.apiKey).toBe("lin_api_1234567890abcdefghijklmnopqrstuv");
      expect(result.errorMessage).toBeNull();
      expect(result.suggestions).toHaveLength(0);
    });

    it("returns valid=false for a placeholder key", () => {
      vi.mocked(readFileSync).mockReturnValue("LINEAR_API_KEY=lin_api_...");

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.apiKey).toBeNull();
      expect(result.errorMessage).toContain("placeholder");
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it("returns valid=false for missing LINEAR_API_KEY", () => {
      vi.mocked(readFileSync).mockReturnValue("LINEAR_TEAM_KEY=NEX\n# no api key");

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.apiKey).toBeNull();
      expect(result.errorMessage).toContain("not found");
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it("returns valid=false for invalid format", () => {
      vi.mocked(readFileSync).mockReturnValue("LINEAR_API_KEY=invalid_prefix_key");

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.apiKey).toBeNull();
      expect(result.errorMessage).toContain("invalid format");
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it("returns valid=false when file cannot be read", () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.apiKey).toBeNull();
      expect(result.errorMessage).toContain("Failed to read credentials");
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it("handles empty LINEAR_API_KEY value", () => {
      vi.mocked(readFileSync).mockReturnValue("LINEAR_API_KEY=");

      const result = validateLinearCredential();

      expect(result.valid).toBe(false);
      expect(result.apiKey).toBeNull();
      expect(result.errorMessage).toContain("not found");
    });
  });

  describe("assertLinearCredential", () => {
    it("returns the API key when valid", () => {
      vi.mocked(readFileSync).mockReturnValue("LINEAR_API_KEY=lin_api_1234567890abcdefghijklmnopqrstuv");

      const key = assertLinearCredential();

      expect(key).toBe("lin_api_1234567890abcdefghijklmnopqrstuv");
    });

    it("throws with helpful message when credential is invalid", () => {
      vi.mocked(readFileSync).mockReturnValue("LINEAR_API_KEY=lin_api_...");

      expect(() => assertLinearCredential()).toThrow(
        /Linear credential validation failed.*placeholder/
      );
    });

    it("throws with suggestions when file is missing", () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error("ENOENT: no such file");
      });

      expect(() => assertLinearCredential()).toThrow(
        /Linear credential validation failed.*Failed to read credentials/
      );
    });
  });
});
