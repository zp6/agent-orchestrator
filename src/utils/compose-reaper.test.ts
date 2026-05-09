import { describe, it, expect, vi } from "vitest";
import {
  parseEtimeSeconds,
  findStaleComposeProcesses,
  reapStaleComposeProcesses,
  DEFAULT_MAX_AGE_SECONDS,
} from "./compose-reaper.js";

describe("parseEtimeSeconds", () => {
  it("parses MM:SS form", () => {
    expect(parseEtimeSeconds("00:30")).toBe(30);
    expect(parseEtimeSeconds("14:59")).toBe(14 * 60 + 59);
  });

  it("parses HH:MM:SS form", () => {
    expect(parseEtimeSeconds("01:00:00")).toBe(3600);
    expect(parseEtimeSeconds("23:46:00")).toBe(23 * 3600 + 46 * 60);
  });

  it("parses D-HH:MM:SS form", () => {
    expect(parseEtimeSeconds("1-00:00:00")).toBe(86400);
    expect(parseEtimeSeconds("2-12:30:15")).toBe(
      2 * 86400 + 12 * 3600 + 30 * 60 + 15,
    );
  });

  it("parses bare seconds form", () => {
    expect(parseEtimeSeconds("45")).toBe(45);
  });

  it("returns 0 for unparseable input (treated as not stale)", () => {
    expect(parseEtimeSeconds("")).toBe(0);
    expect(parseEtimeSeconds("not-a-time")).toBe(0);
    expect(parseEtimeSeconds("--:--")).toBe(0);
  });
});

describe("findStaleComposeProcesses", () => {
  const sample = [
    // PID  ETIME      COMMAND
    "  123  00:30      docker compose -f docker-compose.generated.yml up --build -d agent-a",
    " 456  14:59      docker compose up --build agent-b",
    " 789  23:46:00   docker compose -f docker-compose.generated.yml up --build -d meeting-facilitator-agent",
    " 999  22:53:00   /Users/paultarr/.docker/cli-plugins/docker-compose compose -f docker-compose.generated.yml up --build -d claude-orchestrator-telegram",
    " 100  10:00:00   /usr/bin/node dist/service/daemon.js",
    " 200  04:00      sshd: paultarr",
    " 300  1-12:00:00 docker compose down",
  ].join("\n");

  it("identifies compose processes older than the ceiling", () => {
    const { stale, scanned } = findStaleComposeProcesses(sample, 15 * 60);
    // 4 stale compose processes: PIDs 789, 999, 300 — and 456 at exactly 14:59 is NOT stale (under 15:00).
    const pids = stale.map((s) => s.pid).sort();
    expect(pids).toEqual([300, 789, 999]);
    // Total compose processes scanned (regardless of age): 5 (123, 456, 789, 999, 300).
    expect(scanned).toBe(5);
  });

  it("ignores non-compose processes (daemon, sshd, etc.)", () => {
    const { stale } = findStaleComposeProcesses(sample, 60);
    expect(stale.every((s) => /docker[\s-]?compose/.test(s.command))).toBe(true);
  });

  it("treats the ceiling as a strict less-than (15:00 == not stale)", () => {
    const fifteenMin =
      "  111  15:00      docker compose -f x up --build -d a";
    const { stale } = findStaleComposeProcesses(fifteenMin, 15 * 60);
    expect(stale).toEqual([]);

    const fifteenMinOneSec =
      "  111  15:01      docker compose -f x up --build -d a";
    const { stale: stale2 } = findStaleComposeProcesses(
      fifteenMinOneSec,
      15 * 60,
    );
    expect(stale2.map((s) => s.pid)).toEqual([111]);
  });

  it("matches both `docker compose` and `cli-plugins/docker-compose compose` forms", () => {
    const both = [
      "  701  20:00:00 docker compose up --build agent-x",
      "  702  20:00:00 /Users/u/.docker/cli-plugins/docker-compose compose up --build -d agent-y",
    ].join("\n");
    const { stale } = findStaleComposeProcesses(both, 15 * 60);
    expect(stale.map((s) => s.pid).sort()).toEqual([701, 702]);
  });

  it("returns ageSeconds for each stale entry (telemetry)", () => {
    const { stale } = findStaleComposeProcesses(sample, 15 * 60);
    const old = stale.find((s) => s.pid === 789);
    expect(old?.ageSeconds).toBe(23 * 3600 + 46 * 60);
  });
});

describe("reapStaleComposeProcesses — acceptance from #1558", () => {
  it("kills compose processes older than 15 min, reports the count", () => {
    const psOutput = [
      "  100  20:00:00 docker compose up --build agent-a",
      "  200  00:30    docker compose up --build agent-b",
      "  300  16:00    docker compose up --build agent-c",
    ].join("\n");

    const killed: number[] = [];
    const result = reapStaleComposeProcesses({
      readPs: () => psOutput,
      killProcess: (pid) => {
        killed.push(pid);
      },
    });

    expect(result.killed).toBe(2);
    expect(result.killedPids.sort()).toEqual([100, 300]);
    expect(killed.sort()).toEqual([100, 300]);
    expect(result.scanned).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("acceptance: a 30-min compose invocation IS killed at the 15-min ceiling, not after 30 min", () => {
    // Simulates the bug recipe in #1558: a hung `compose up --build` whose
    // process has been running for 30 minutes. The reaper must recognize it
    // as stale at the ceiling (default 15 min) and kill it.
    const thirtyMinHang =
      "  4242  30:00    docker compose -f docker-compose.generated.yml up --build -d hung-agent";
    const killed: number[] = [];
    const result = reapStaleComposeProcesses({
      readPs: () => thirtyMinHang,
      killProcess: (pid) => {
        killed.push(pid);
      },
    });
    expect(killed).toEqual([4242]);
    expect(result.killed).toBe(1);
  });

  it("does NOT kill fresh compose processes (under the ceiling)", () => {
    const psOutput = [
      "  100  00:30    docker compose up --build agent-a",
      "  200  05:00    docker compose up --build agent-b",
      "  300  10:00    docker compose up --build agent-c",
    ].join("\n");

    const killed: number[] = [];
    const result = reapStaleComposeProcesses({
      readPs: () => psOutput,
      killProcess: (pid) => {
        killed.push(pid);
      },
    });

    expect(result.killed).toBe(0);
    expect(killed).toEqual([]);
    expect(result.scanned).toBe(3);
  });

  it("does NOT touch non-compose processes (daemon, ssh, node, etc.)", () => {
    const psOutput = [
      "  100  20:00:00 /usr/bin/node dist/service/daemon.js",
      "  200  20:00:00 sshd: paultarr",
      "  300  20:00:00 /usr/bin/python3 /opt/script.py",
    ].join("\n");

    const killed: number[] = [];
    const result = reapStaleComposeProcesses({
      readPs: () => psOutput,
      killProcess: (pid) => {
        killed.push(pid);
      },
    });

    expect(killed).toEqual([]);
    expect(result.scanned).toBe(0);
    expect(result.killed).toBe(0);
  });

  it("treats ESRCH (PID exited between scan and kill) as a successful reap", () => {
    const psOutput =
      "  4242  30:00 docker compose up --build agent-x";
    const result = reapStaleComposeProcesses({
      readPs: () => psOutput,
      killProcess: () => {
        const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      },
    });
    expect(result.killed).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("captures EPERM (or other) kill errors per-PID without aborting the loop", () => {
    const psOutput = [
      "  100  30:00 docker compose up --build agent-a",
      "  200  30:00 docker compose up --build agent-b",
    ].join("\n");
    const killed: number[] = [];
    const result = reapStaleComposeProcesses({
      readPs: () => psOutput,
      killProcess: (pid) => {
        if (pid === 100) {
          const err = new Error("kill EPERM") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        killed.push(pid);
      },
    });
    // PID 200 still got killed despite PID 100 failing
    expect(killed).toEqual([200]);
    expect(result.killed).toBe(1);
    expect(result.killedPids).toEqual([200]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].pid).toBe(100);
    expect(result.errors[0].error).toMatch(/EPERM/);
  });

  it("handles ps read failure without throwing (cycle keeps running)", () => {
    const result = reapStaleComposeProcesses({
      readPs: () => {
        throw new Error("ps not found");
      },
      killProcess: () => {
        throw new Error("should not be called");
      },
    });
    expect(result.killed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/ps not found/);
  });

  it("respects custom maxAgeSeconds (acceptance: tunable ceiling)", () => {
    const psOutput =
      "  100  10:00 docker compose up --build agent-a";
    // Default 15-min ceiling — not stale yet
    const noKill = reapStaleComposeProcesses({
      readPs: () => psOutput,
      killProcess: () => {},
    });
    expect(noKill.killed).toBe(0);

    // Custom 5-min ceiling — now stale
    const killed: number[] = [];
    const withKill = reapStaleComposeProcesses({
      readPs: () => psOutput,
      maxAgeSeconds: 5 * 60,
      killProcess: (pid) => {
        killed.push(pid);
      },
    });
    expect(withKill.killed).toBe(1);
    expect(killed).toEqual([100]);
  });

  it("default ceiling matches #1558 acceptance criterion (15 min)", () => {
    expect(DEFAULT_MAX_AGE_SECONDS).toBe(15 * 60);
  });
});
