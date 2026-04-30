import { execSync } from "node:child_process";

export interface DaemonStaleness {
  commitsBehind: number;
  currentHash: string;
  isStale: boolean;
  error: string | null;
}

/**
 * Check how many commits the local HEAD is behind origin/main and return the
 * current short commit hash.  Flags as stale when commitsBehind > threshold
 * (default 5, matching the unhealthy threshold documented in #1368).
 */
export function daemonStaleness(threshold = 5): DaemonStaleness {
  try {
    // Fetch without modifying local refs so we get a fresh remote count.
    execSync("git fetch origin main --quiet", {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Fetch failure is non-fatal — proceed with whatever the local cache has.
  }

  try {
    const behindRaw = execSync("git rev-list HEAD..origin/main --count", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const hashRaw = execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const commitsBehind = parseInt(behindRaw, 10) || 0;
    return {
      commitsBehind,
      currentHash: hashRaw,
      isStale: commitsBehind > threshold,
      error: null,
    };
  } catch (err) {
    return {
      commitsBehind: 0,
      currentHash: "unknown",
      isStale: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
