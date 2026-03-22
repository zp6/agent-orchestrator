import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const PID_PATH = join(homedir(), ".claude-orchestrator", "daemon.pid");

export function writePid(): void {
  mkdirSync(dirname(PID_PATH), { recursive: true });
  writeFileSync(PID_PATH, String(process.pid));
}

export function readPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const content = readFileSync(PID_PATH, "utf-8").trim();
  const pid = parseInt(content, 10);
  return isNaN(pid) ? null : pid;
}

export function isRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist — stale PID file
    removePid();
    return false;
  }
}

export function removePid(): void {
  try {
    unlinkSync(PID_PATH);
  } catch {
    // Already gone
  }
}

export function getPidPath(): string {
  return PID_PATH;
}
