/**
 * Compose-process reaper — kills `docker compose` subprocesses that have been
 * running longer than the safe ceiling.
 *
 * Background (issues #1517 / #1558): the proxy spawns `docker compose -f
 * docker-compose.generated.yml up --build -d <agent>` to (re)deploy agents.
 * Even with the `-d` (detached) flag, that subprocess can hang for many hours
 * if the build cache fetch stalls, the registry pull is slow, or the docker
 * daemon socket has a race. Today's incident saw orphans 22-24 hours old
 * driving load average to 71 on a 12-core M4. They were missed by #1519's
 * in-flight-deploy guard because the orchestrator never owns the compose PID
 * — it only triggers the proxy via the management API.
 *
 * The reaper is the host-level safety net: it scans the process table for
 * compose processes older than `maxAgeSeconds` (default 15 min, matching the
 * ceiling in #1558) and sends SIGKILL. The actual containers are unaffected
 * — `docker compose up -d` returns control as soon as the container starts;
 * the lingering subprocess is the CLI itself, which by 15 min is doing
 * nothing useful.
 *
 * The reaper is read-only on the process table when no orphans are present,
 * so it is cheap to call every cycle. When orphans are killed, the count is
 * logged so the operator can see reaping happening.
 */

import { execSync } from "node:child_process";

/** Default ceiling: kill compose processes running longer than 15 minutes. */
export const DEFAULT_MAX_AGE_SECONDS = 15 * 60;

/** Regex matching the compose CLI invocation in the `ps` output. Matches
 * both `docker compose` (Docker plugin subcommand form) and the absolute path
 * form `.../cli-plugins/docker-compose compose ...` that some Docker Desktop
 * builds use, which is what shows up in `ps` on macOS hosts.
 *
 * The pattern is intentionally permissive: `docker[ -]compose` followed by a
 * word boundary catches both the space and hyphen variants. The `/` prefix
 * in the cli-plugins absolute path form does NOT block the match because we
 * don't anchor at start-of-line — `docker-compose` anywhere inside the
 * command line counts as a hit, which is what we want.
 */
const COMPOSE_COMMAND_PATTERN = /\bdocker[ -]compose\b/;

export interface StaleComposeProcess {
  pid: number;
  ageSeconds: number;
  command: string;
}

export interface ReapResult {
  /** Number of compose processes that were SIGKILLed. */
  killed: number;
  /** PIDs killed (informational, for log entries). */
  killedPids: number[];
  /** Any per-PID kill errors (the reaper tries every candidate, swallowing
   * individual errors so one stuck PID doesn't block the rest). */
  errors: Array<{ pid: number; error: string }>;
  /** Total compose processes seen, for observability. */
  scanned: number;
}

/**
 * Parse `ps -o etime` output into total seconds.
 *
 * Format reference (POSIX `ps`):
 *   - `SS` (rare, depending on locale)
 *   - `MM:SS`
 *   - `HH:MM:SS`
 *   - `D-HH:MM:SS`
 *
 * Returns 0 on parse failure (caller treats as "not stale" rather than
 * crashing on unexpected output).
 */
export function parseEtimeSeconds(etime: string): number {
  const trimmed = etime.trim();
  if (!trimmed) return 0;

  // Days form: D-HH:MM:SS
  const dayMatch = trimmed.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayMatch) {
    const [, d, h, m, s] = dayMatch;
    return Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
  }

  // Hours form: HH:MM:SS
  const hourMatch = trimmed.match(/^(\d+):(\d+):(\d+)$/);
  if (hourMatch) {
    const [, h, m, s] = hourMatch;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }

  // Minutes form: MM:SS
  const minMatch = trimmed.match(/^(\d+):(\d+)$/);
  if (minMatch) {
    const [, m, s] = minMatch;
    return Number(m) * 60 + Number(s);
  }

  // Seconds form (rare): SS
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  return 0;
}

/**
 * Run `ps -ax -o pid,etime,command` and return the stdout. Extracted so the
 * reaper can be unit-tested with a mocked process listing.
 */
export function readProcessTable(): string {
  return execSync("ps -ax -o pid=,etime=,command=", {
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Parse a `ps -ax -o pid=,etime=,command=` listing and return all compose
 * processes older than `maxAgeSeconds`. Pure function — no side effects on
 * the host.
 */
export function findStaleComposeProcesses(
  psOutput: string,
  maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
): { stale: StaleComposeProcess[]; scanned: number } {
  const stale: StaleComposeProcess[] = [];
  let scanned = 0;

  for (const rawLine of psOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // Three-column format: PID ETIME COMMAND...
    // ETIME may contain colons but no spaces, so the first two whitespace-
    // delimited tokens are PID and ETIME, and everything after is COMMAND.
    const match = line.match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pidStr, etime, command] = match;

    if (!COMPOSE_COMMAND_PATTERN.test(command)) continue;
    scanned += 1;

    const ageSeconds = parseEtimeSeconds(etime);
    // Strict greater-than: a process at exactly the ceiling is NOT yet stale.
    // The #1558 acceptance criterion is "may run for >15 minutes", so 15:00
    // is fine; only 15:01+ is reaped.
    if (ageSeconds <= maxAgeSeconds) continue;

    stale.push({ pid: Number(pidStr), ageSeconds, command });
  }

  return { stale, scanned };
}

export interface ReapOptions {
  /** Override the ceiling (seconds). Default 15 minutes. */
  maxAgeSeconds?: number;
  /** Inject a process-table reader (tests). */
  readPs?: () => string;
  /** Inject a kill function (tests). Defaults to `process.kill(pid, 'SIGKILL')`. */
  killProcess?: (pid: number) => void;
}

/**
 * Find and SIGKILL any `docker compose` processes older than the ceiling.
 * Safe to call every poll cycle — fast no-op when nothing is stale, and the
 * actual containers are unaffected because `docker compose up -d` decouples
 * the CLI process from the running container as soon as the container is up.
 */
export function reapStaleComposeProcesses(options: ReapOptions = {}): ReapResult {
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const readPs = options.readPs ?? readProcessTable;
  const killProcess =
    options.killProcess ??
    ((pid: number) => {
      // SIGKILL because the issue (#1558) shows compose hung on pre-detach
      // phases (build/pull/socket race). SIGTERM would just be ignored by a
      // process stuck in a syscall; SIGKILL bypasses all signal handlers.
      process.kill(pid, "SIGKILL");
    });

  const result: ReapResult = {
    killed: 0,
    killedPids: [],
    errors: [],
    scanned: 0,
  };

  let psOutput: string;
  try {
    psOutput = readPs();
  } catch (err) {
    // Reading `ps` failed (extremely rare on macOS/Linux). The reaper logs the
    // error via the caller's catch but does not throw — a poll cycle should
    // continue even if the process scan is unavailable.
    result.errors.push({
      pid: 0,
      error: `ps read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return result;
  }

  const { stale, scanned } = findStaleComposeProcesses(psOutput, maxAgeSeconds);
  result.scanned = scanned;

  for (const proc of stale) {
    try {
      killProcess(proc.pid);
      result.killed += 1;
      result.killedPids.push(proc.pid);
    } catch (err) {
      // ESRCH (no such process) is benign — the orphan exited between the
      // scan and the kill. Treat as a successful reap (count it as killed).
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        result.killed += 1;
        result.killedPids.push(proc.pid);
        continue;
      }
      result.errors.push({
        pid: proc.pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
