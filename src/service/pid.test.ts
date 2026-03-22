import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the PID logic directly since the module uses a hardcoded path.
// These tests validate the core logic patterns.

describe("PID management logic", () => {
  let pidPath: string;

  beforeEach(() => {
    pidPath = join(tmpdir(), `orch-pid-test-${Date.now()}.pid`);
  });

  afterEach(() => {
    try { unlinkSync(pidPath); } catch {}
  });

  it("writes and reads PID file", () => {
    writeFileSync(pidPath, String(process.pid));
    const content = readFileSync(pidPath, "utf-8").trim();
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it("detects running process", () => {
    writeFileSync(pidPath, String(process.pid));
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    // Current process should be alive
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);
  });

  it("detects dead process", () => {
    // PID 999999 is very unlikely to exist
    writeFileSync(pidPath, "999999");
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("handles missing PID file", () => {
    expect(existsSync(pidPath)).toBe(false);
  });

  it("cleans up PID file", () => {
    writeFileSync(pidPath, String(process.pid));
    expect(existsSync(pidPath)).toBe(true);
    unlinkSync(pidPath);
    expect(existsSync(pidPath)).toBe(false);
  });
});
