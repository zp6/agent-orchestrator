/**
 * Async exec helper — non-blocking replacement for execSync/spawnSync.
 *
 * Uses Node's async `exec` (backed by libuv thread pool) so git / gh CLI calls
 * do NOT freeze the event loop.  A mandatory per-call timeout (default 30 s)
 * ensures one hung git process cannot stall the daemon indefinitely.
 *
 * See: agent-orchestrator#1518
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execP = promisify(exec);

export interface ExecAsyncOptions {
  cwd?: string;
  /** Always UTF-8 — included in the type for API compatibility with execSync opts. */
  encoding?: "utf-8";
  /** Per-call timeout in ms.  Defaults to 30 000 (30 s). */
  timeout?: number;
  env?: Record<string, string>;
}

/**
 * Run a shell command asynchronously and return stdout as a string.
 *
 * - Throws if the command exits with a non-zero code (same behaviour as execSync).
 * - Throws if the command exceeds `timeout` ms.
 * - Never blocks the event loop.
 */
export async function execAsync(
  cmd: string,
  opts: ExecAsyncOptions = {},
): Promise<string> {
  const { timeout = 30_000, env, ...rest } = opts;
  const { stdout } = await execP(cmd, {
    ...rest,
    encoding: "utf-8",
    timeout,
    env: env ?? (process.env as Record<string, string>),
  });
  return stdout;
}
