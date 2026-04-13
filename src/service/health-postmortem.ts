/**
 * Health Check Post-Mortem — root-cause reporting for agent failures (issue #771).
 *
 * Problem: health check failures are currently resolved with generic "recovered"
 * messages. Operators have no visibility into WHY an agent failed — OOM, port
 * conflict, crash, or missing secret — so recurring failures are opaque.
 *
 * This module captures the last N docker log lines at the moment of failure,
 * infers a root-cause category, and formats a structured post-mortem block that
 * is attached to the escalation task description. After this, operators can
 * answer "why does claude-proxy keep failing?" instead of just seeing it recover.
 */

import { execFileSync } from "node:child_process";

// ── Root Cause Categories ────────────────────────────────────────────────────

/**
 * Enumerated root-cause categories inferred from log patterns and failure context.
 * Extend this list as new patterns are observed in production.
 */
export type RootCauseCategory =
  | "oom"              // Out-of-memory kill
  | "port-conflict"    // Port already bound by another process
  | "crash"            // Uncaught exception / FATAL / segfault
  | "dependency"       // Cannot reach a required upstream service
  | "startup-timeout"  // Process never became ready after start
  | "secret-missing"   // Required secret file absent or empty
  | "unknown";         // No specific pattern matched

/**
 * Pattern rules mapping log/detail text to a root-cause category.
 * Evaluated in order; first match wins.
 */
const ROOT_CAUSE_RULES: Array<{ pattern: RegExp; category: RootCauseCategory; label: string }> = [
  {
    pattern: /\b(oom.?kill|out.of.memory|killed process|memory limit exceeded|cannot allocate memory)\b/i,
    category: "oom",
    label: "Out-of-memory kill",
  },
  {
    pattern: /\b(address already in use|EADDRINUSE|port.*already.*bound|bind.*failed)\b/i,
    category: "port-conflict",
    label: "Port already in use",
  },
  {
    pattern: /\b(ENOENT|secret.*not.*found|secret.*missing|no such file.*secret|failed to read.*secret)\b/i,
    category: "secret-missing",
    label: "Missing or unreadable secret",
  },
  {
    pattern: /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection refused|failed to connect|upstream connect error)\b/i,
    category: "dependency",
    label: "Upstream dependency unreachable",
  },
  {
    pattern: /\b(uncaught exception|unhandled rejection|FATAL|segmentation fault|sigsegv|core dumped|panic:)\b/i,
    category: "crash",
    label: "Process crash (uncaught exception or signal)",
  },
  {
    pattern: /\b(health check.*timeout|timed out waiting|startup.*timeout|failed to become healthy)\b/i,
    category: "startup-timeout",
    label: "Startup timeout — process started but never became ready",
  },
];

// ── Log Capture ───────────────────────────────────────────────────────────────

/**
 * Attempt to capture the last `lines` log lines from the named Docker container.
 * Returns the raw text output, or an error message if the docker CLI call fails.
 *
 * This is intentionally fail-safe: a failure to capture logs must never block
 * the post-mortem from being written — we surface the error inline.
 */
export function captureDockerLogs(containerName: string, lines = 20): string {
  try {
    const output = execFileSync(
      "docker",
      ["logs", containerName, "--tail", String(lines), "--timestamps"],
      { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return output.trim() || "(container produced no log output)";
  } catch (err) {
    // execFileSync throws on non-zero exit; stderr is embedded in the error message.
    const msg = err instanceof Error ? err.message : String(err);
    // docker logs exits 1 when the container doesn't exist — give a cleaner message.
    if (msg.includes("No such container")) {
      return `(container "${containerName}" not found — may have been removed or renamed)`;
    }
    return `(failed to capture docker logs: ${msg.slice(0, 200)})`;
  }
}

// ── Root Cause Inference ──────────────────────────────────────────────────────

/**
 * Infer the most likely root-cause category by scanning log text and the
 * failure detail string. Returns the first matching rule, or "unknown".
 */
export function inferRootCause(
  logOutput: string,
  failureDetail: string,
): { category: RootCauseCategory; label: string } {
  const combined = `${failureDetail}\n${logOutput}`;
  for (const rule of ROOT_CAUSE_RULES) {
    if (rule.pattern.test(combined)) {
      return { category: rule.category, label: rule.label };
    }
  }
  return { category: "unknown", label: "No specific pattern matched — manual inspection required" };
}

// ── Post-Mortem Data ──────────────────────────────────────────────────────────

export interface HealthPostmortem {
  /** Container / agent name */
  agentName: string;
  /** ISO timestamp when the failure was first detected */
  failureTimestamp: string;
  /** Human-readable failure duration (e.g. "3m", "12s") */
  durationLabel: string;
  /** Raw last-N log lines from docker */
  logLines: string;
  /** Inferred root-cause category */
  rootCause: RootCauseCategory;
  /** Human-readable root-cause label */
  rootCauseLabel: string;
}

/**
 * Build a complete post-mortem by capturing docker logs and inferring
 * root cause at the moment of escalation.
 *
 * @param agentName        Agent / container name (same value used in docker commands)
 * @param failureDetail    Failure detail string from the health check (e.g. "connection refused")
 * @param failureStartedAt Unix epoch ms when the failure was first detected
 * @param durationMs       How long the agent has been unhealthy in milliseconds
 * @param logLinesToCapture Number of tail log lines to capture (default: 20)
 */
export function buildHealthPostmortem(
  agentName: string,
  failureDetail: string,
  failureStartedAt: number,
  durationMs: number,
  logLinesToCapture = 20,
): HealthPostmortem {
  const failureTimestamp = new Date(failureStartedAt).toISOString();
  const durationLabel = formatDurationMs(durationMs);
  const logLines = captureDockerLogs(agentName, logLinesToCapture);
  const { category, label } = inferRootCause(logLines, failureDetail);

  return {
    agentName,
    failureTimestamp,
    durationLabel,
    logLines,
    rootCause: category,
    rootCauseLabel: label,
  };
}

/**
 * Format a duration in milliseconds into a human-readable string.
 * Mirrors the logic in daemon.ts `formatHealthDuration` — kept local
 * so this module has no import dependency on daemon.ts.
 */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

// ── Markdown Rendering ────────────────────────────────────────────────────────

/**
 * Render a HealthPostmortem as a markdown section to prepend to the
 * escalation task description. Designed to be a self-contained block
 * that operators can read at a glance before diving into the playbook.
 */
export function renderPostmortemBlock(pm: HealthPostmortem): string {
  const rootCauseEmoji: Record<RootCauseCategory, string> = {
    "oom": "💥",
    "port-conflict": "🔌",
    "crash": "💣",
    "dependency": "🔗",
    "startup-timeout": "⏱️",
    "secret-missing": "🔑",
    "unknown": "❓",
  };

  const emoji = rootCauseEmoji[pm.rootCause];

  return (
    `## Post-Mortem Summary\n\n` +
    `| Field | Value |\n` +
    `|-------|-------|\n` +
    `| **Agent** | \`${pm.agentName}\` |\n` +
    `| **Failure detected** | ${pm.failureTimestamp} |\n` +
    `| **Unhealthy for** | ${pm.durationLabel} |\n` +
    `| **Root cause** | ${emoji} **${pm.rootCauseLabel}** (\`${pm.rootCause}\`) |\n` +
    `\n` +
    `### Last ${pm.logLines.split("\n").length} log lines before failure\n\n` +
    "```\n" +
    pm.logLines +
    "\n```\n\n" +
    `---\n\n`
  );
}
