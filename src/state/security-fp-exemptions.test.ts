import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "./store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// StateStore — security_fp_exemptions (issue #1612)
// ─────────────────────────────────────────────────────────────────────────────

describe("StateStore — security FP exemptions", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-sec-fp-test-${randomUUID()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {}
    }
  });

  // ── addSecurityFpExemption ──────────────────────────────────────────────────

  describe("addSecurityFpExemption", () => {
    it("inserts a new exemption and returns it", () => {
      const exemption = store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "docker-compose.generated.yml",
        pattern_name: "Docker Compose env_file referencing plaintext .env",
        reason: "env_file references a non-secret template, confirmed false positive",
      });
      expect(exemption.id).toBeGreaterThan(0);
      expect(exemption.repo).toBe("owner/repo");
      expect(exemption.file_path).toBe("docker-compose.generated.yml");
      expect(exemption.pattern_name).toBe("Docker Compose env_file referencing plaintext .env");
      expect(exemption.reason).toContain("false positive");
      expect(exemption.created_at).toBeTruthy();
      expect(exemption.updated_at).toBeTruthy();
    });

    it("is idempotent — returns the original row on duplicate call", () => {
      const input = {
        repo: "owner/repo",
        file_path: ".env.test",
        pattern_name: "plaintext .env file committed to git",
        reason: "Test fixture committed intentionally",
      };
      const first = store.addSecurityFpExemption(input);
      const second = store.addSecurityFpExemption(input);
      expect(second.id).toBe(first.id);
      expect(second.created_at).toBe(first.created_at);
    });

    it("allows wildcard repo='*'", () => {
      const exemption = store.addSecurityFpExemption({
        repo: "*",
        file_path: ".env.ci",
        pattern_name: "plaintext .env file committed to git",
        reason: "CI env files are never secret",
      });
      expect(exemption.repo).toBe("*");
    });

    it("allows wildcard file_path='*'", () => {
      const exemption = store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "*",
        pattern_name: "Docker Compose env_file referencing plaintext .env",
        reason: "All docker-compose env_file refs in this repo are known safe",
      });
      expect(exemption.file_path).toBe("*");
    });

    it("allows wildcard pattern_name='*'", () => {
      const exemption = store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "docker-compose.generated.yml",
        pattern_name: "*",
        reason: "Auto-generated file never contains real secrets",
      });
      expect(exemption.pattern_name).toBe("*");
    });

    it("stores distinct triples independently", () => {
      store.addSecurityFpExemption({ repo: "a/b", file_path: "f1", pattern_name: "p1", reason: "r1" });
      store.addSecurityFpExemption({ repo: "a/b", file_path: "f2", pattern_name: "p1", reason: "r2" });
      store.addSecurityFpExemption({ repo: "c/d", file_path: "f1", pattern_name: "p1", reason: "r3" });
      const all = store.listSecurityFpExemptions();
      expect(all.length).toBe(3);
    });
  });

  // ── isSecurityFpExempt ──────────────────────────────────────────────────────

  describe("isSecurityFpExempt", () => {
    it("returns false when no exemptions exist", () => {
      expect(
        store.isSecurityFpExempt("owner/repo", "docker-compose.yml", "plaintext .env"),
      ).toBe(false);
    });

    it("returns true for an exact match", () => {
      store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "docker-compose.generated.yml",
        pattern_name: "Docker Compose env_file referencing plaintext .env",
        reason: "confirmed FP",
      });
      expect(
        store.isSecurityFpExempt(
          "owner/repo",
          "docker-compose.generated.yml",
          "Docker Compose env_file referencing plaintext .env",
        ),
      ).toBe(true);
    });

    it("returns false when repo does not match and no wildcard", () => {
      store.addSecurityFpExemption({
        repo: "other/repo",
        file_path: "docker-compose.generated.yml",
        pattern_name: "Docker Compose env_file referencing plaintext .env",
        reason: "FP in other repo",
      });
      expect(
        store.isSecurityFpExempt(
          "owner/repo",
          "docker-compose.generated.yml",
          "Docker Compose env_file referencing plaintext .env",
        ),
      ).toBe(false);
    });

    it("returns false when file_path does not match and no wildcard", () => {
      store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "other-file.yml",
        pattern_name: "Docker Compose env_file referencing plaintext .env",
        reason: "FP on other file",
      });
      expect(
        store.isSecurityFpExempt(
          "owner/repo",
          "docker-compose.generated.yml",
          "Docker Compose env_file referencing plaintext .env",
        ),
      ).toBe(false);
    });

    it("returns false when pattern_name does not match and no wildcard", () => {
      store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "docker-compose.generated.yml",
        pattern_name: "other pattern",
        reason: "FP on other pattern",
      });
      expect(
        store.isSecurityFpExempt(
          "owner/repo",
          "docker-compose.generated.yml",
          "Docker Compose env_file referencing plaintext .env",
        ),
      ).toBe(false);
    });

    it("wildcard repo='*' matches any repo", () => {
      store.addSecurityFpExemption({
        repo: "*",
        file_path: "docker-compose.generated.yml",
        pattern_name: "Docker Compose env_file referencing plaintext .env",
        reason: "global exemption",
      });
      expect(
        store.isSecurityFpExempt(
          "any-owner/any-repo",
          "docker-compose.generated.yml",
          "Docker Compose env_file referencing plaintext .env",
        ),
      ).toBe(true);
    });

    it("wildcard file_path='*' matches any file", () => {
      store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "*",
        pattern_name: "Docker Compose env_file referencing plaintext .env",
        reason: "all docker-compose files are safe in this repo",
      });
      expect(
        store.isSecurityFpExempt(
          "owner/repo",
          "any-docker-compose.yml",
          "Docker Compose env_file referencing plaintext .env",
        ),
      ).toBe(true);
    });

    it("wildcard pattern_name='*' matches any pattern", () => {
      store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "docker-compose.generated.yml",
        pattern_name: "*",
        reason: "auto-generated, never real secrets",
      });
      expect(
        store.isSecurityFpExempt("owner/repo", "docker-compose.generated.yml", "any-pattern"),
      ).toBe(true);
    });

    it("all-wildcard row exempts any triple", () => {
      store.addSecurityFpExemption({
        repo: "*",
        file_path: "*",
        pattern_name: "*",
        reason: "suppress all (testing only)",
      });
      expect(store.isSecurityFpExempt("any/repo", "any/file.yml", "any pattern")).toBe(true);
    });

    it("returns false after the only matching exemption is removed", () => {
      store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "docker-compose.generated.yml",
        pattern_name: "Docker Compose env_file referencing plaintext .env",
        reason: "test",
      });
      store.removeSecurityFpExemption(
        "owner/repo",
        "docker-compose.generated.yml",
        "Docker Compose env_file referencing plaintext .env",
      );
      expect(
        store.isSecurityFpExempt(
          "owner/repo",
          "docker-compose.generated.yml",
          "Docker Compose env_file referencing plaintext .env",
        ),
      ).toBe(false);
    });
  });

  // ── listSecurityFpExemptions ────────────────────────────────────────────────

  describe("listSecurityFpExemptions", () => {
    it("returns empty array when no exemptions exist", () => {
      expect(store.listSecurityFpExemptions()).toHaveLength(0);
    });

    it("returns all exemptions when no repo filter is given", () => {
      store.addSecurityFpExemption({ repo: "a/b", file_path: "f1", pattern_name: "p1", reason: "r" });
      store.addSecurityFpExemption({ repo: "c/d", file_path: "f2", pattern_name: "p2", reason: "r" });
      const all = store.listSecurityFpExemptions();
      expect(all).toHaveLength(2);
    });

    it("filters by repo when provided", () => {
      store.addSecurityFpExemption({ repo: "a/b", file_path: "f1", pattern_name: "p1", reason: "r" });
      store.addSecurityFpExemption({ repo: "c/d", file_path: "f2", pattern_name: "p2", reason: "r" });
      const filtered = store.listSecurityFpExemptions("a/b");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].repo).toBe("a/b");
    });

    it("includes wildcard repo='*' rows in filtered results", () => {
      store.addSecurityFpExemption({ repo: "*", file_path: "f1", pattern_name: "p1", reason: "global" });
      store.addSecurityFpExemption({ repo: "a/b", file_path: "f2", pattern_name: "p2", reason: "specific" });
      store.addSecurityFpExemption({ repo: "c/d", file_path: "f3", pattern_name: "p3", reason: "other" });
      const filtered = store.listSecurityFpExemptions("a/b");
      // Should include the "a/b" row and the "*" row, not the "c/d" row
      expect(filtered).toHaveLength(2);
      const repos = filtered.map((e) => e.repo);
      expect(repos).toContain("*");
      expect(repos).toContain("a/b");
      expect(repos).not.toContain("c/d");
    });
  });

  // ── removeSecurityFpExemption ───────────────────────────────────────────────

  describe("removeSecurityFpExemption", () => {
    it("returns false when no matching exemption exists", () => {
      expect(
        store.removeSecurityFpExemption("owner/repo", "file.yml", "some pattern"),
      ).toBe(false);
    });

    it("returns true and removes the matching row", () => {
      store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "docker-compose.generated.yml",
        pattern_name: "Docker Compose env_file referencing plaintext .env",
        reason: "test",
      });
      const removed = store.removeSecurityFpExemption(
        "owner/repo",
        "docker-compose.generated.yml",
        "Docker Compose env_file referencing plaintext .env",
      );
      expect(removed).toBe(true);
      expect(store.listSecurityFpExemptions()).toHaveLength(0);
    });

    it("only removes the exact triple, not partial matches", () => {
      store.addSecurityFpExemption({ repo: "a/b", file_path: "f1", pattern_name: "p1", reason: "keep" });
      store.addSecurityFpExemption({ repo: "a/b", file_path: "f1", pattern_name: "p2", reason: "remove" });
      store.removeSecurityFpExemption("a/b", "f1", "p2");
      const remaining = store.listSecurityFpExemptions();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].pattern_name).toBe("p1");
    });
  });
});
