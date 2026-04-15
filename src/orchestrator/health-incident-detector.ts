/**
 * Health Incident Pattern Detector
 *
 * Scans completed health incident tasks and extracts root cause patterns.
 * For recurring or critical issues, generates DetectedImprovement objects
 * that trigger automatic GitHub issue creation.
 *
 * Root causes detected:
 * - OOM (out-of-memory kills)
 * - Port conflicts (port already in use)
 * - Secret missing (authentication/configuration issues)
 * - Dependency (upstream service unavailable)
 * - Crash (process failure, segfault)
 * - Startup timeout (process never became ready)
 * - Unknown (no pattern matched, requires investigation)
 */

import type { Task } from "../state/store.js";
import type { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("health-incident-detector");

/**
 * Root cause categories extracted from health incident results.
 * Mirrors the categories defined in health-postmortem.ts.
 */
export type RootCauseCategory =
  | "oom"
  | "port-conflict"
  | "secret-missing"
  | "dependency"
  | "crash"
  | "startup-timeout"
  | "unknown";

/**
 * The label shown to operators for a root cause.
 */
function getRootCauseLabel(category: RootCauseCategory): string {
  const labels: Record<RootCauseCategory, string> = {
    oom: "Out-of-memory kills",
    "port-conflict": "Port conflicts",
    "secret-missing": "Missing secrets/credentials",
    dependency: "Dependency failures",
    crash: "Process crashes",
    "startup-timeout": "Startup timeouts",
    unknown: "Unknown cause",
  };
  return labels[category];
}

/**
 * Regex patterns for detecting root cause categories.
 * Evaluated in order; first match wins.
 */
const ROOT_CAUSE_PATTERNS: Array<[RootCauseCategory, RegExp]> = [
  ["oom", /oom.?kill|out.of.memory|killed process|memory limit exceeded/i],
  ["port-conflict", /address already in use|EADDRINUSE|port.*already.*bound/i],
  ["secret-missing", /ENOENT|secret.*not.*found|secret.*missing/i],
  ["dependency", /ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection refused/i],
  ["crash", /uncaught exception|unhandled rejection|FATAL|segfault|sigsegv|core dumped|panic/i],
  ["startup-timeout", /health check.*timeout|timed out waiting|startup.*timeout/i],
];

/**
 * Extract root cause category from health incident task result.
 * Returns 'unknown' if no pattern matches.
 */
function extractRootCause(result: string | null): RootCauseCategory {
  if (!result) return "unknown";

  for (const [category, pattern] of ROOT_CAUSE_PATTERNS) {
    if (pattern.test(result)) {
      return category;
    }
  }

  return "unknown";
}

/**
 * Extract agent name from health incident task source_ref.
 * Format: 'health-check-fail:${agentName}'
 */
function extractAgentName(sourceRef: string | null): string | null {
  if (!sourceRef?.startsWith("health-check-fail:")) return null;
  return sourceRef.substring("health-check-fail:".length) || null;
}

/**
 * Detected improvement from a health incident pattern.
 * Matches the DetectedImprovement interface used by issue-creator.
 */
export interface DetectedImprovement {
  title: string;
  description: string;
  affected_agents: string[];
  severity: "low" | "medium" | "high";
  evidence: Array<{ taskId: string; detail: string }>;
}

/**
 * Scan recent health incident tasks and detect recurring patterns.
 * Files improvement issues for critical or recurring root causes.
 *
 * Strategy:
 * - Aggregate incidents by (root_cause, agent) in the last 24 hours
 * - File issue if: incidents >= 2 OR (incidents >= 1 AND critical)
 * - Critical patterns: OOM, port-conflict, secret-missing
 */
export function detectHealthIncidentIssues(
  store: StateStore,
  _config: OrchestratorConfig,
): DetectedImprovement[] {
  const incidents = store.getRecentHealthIncidents(24, 50);

  if (incidents.length === 0) {
    return [];
  }

  // Aggregate incidents by (root_cause, agent)
  const patterns = new Map<
    string,
    {
      cause: RootCauseCategory;
      agent: string | null;
      tasks: Task[];
    }
  >();

  for (const task of incidents) {
    const cause = extractRootCause(task.result);
    const agent = extractAgentName(task.source_ref);
    const key = `${cause}:${agent}`;

    if (!patterns.has(key)) {
      patterns.set(key, { cause, agent, tasks: [] });
    }
    patterns.get(key)!.tasks.push(task);
  }

  // Convert patterns to improvements
  const improvements: DetectedImprovement[] = [];
  const criticalCauses: RootCauseCategory[] = ["oom", "port-conflict", "secret-missing"];

  for (const { cause, agent, tasks } of patterns.values()) {
    const isCritical = criticalCauses.includes(cause);
    const count = tasks.length;

    // File issue if: recurring (count >= 2) OR critical (count >= 1)
    if (count < 2 && !isCritical) {
      continue;
    }

    if (!agent) {
      continue; // Skip incidents without valid agent name
    }

    // Determine severity
    const severity =
      cause === "oom" ? "high" :
      cause === "port-conflict" ? "high" :
      cause === "secret-missing" ? "high" :
      cause === "crash" ? "medium" :
      cause === "dependency" ? "medium" :
      cause === "startup-timeout" ? "medium" :
      "low";

    // Build issue title
    const title = `[Orchestrator] Health: ${getRootCauseLabel(cause)} in ${agent}`;

    // Build detailed description
    const description = buildHealthIncidentDescription(cause, agent, count, tasks);

    // Collect evidence (last 3 incidents)
    const evidence = tasks.slice(0, 3).map((t) => ({
      taskId: t.id,
      detail: t.result?.slice(0, 100) || "Health check failed",
    }));

    improvements.push({
      title,
      description,
      affected_agents: [agent],
      severity,
      evidence,
    });
  }

  log.info("Health incident detection complete", {
    total_incidents: incidents.length,
    patterns_detected: patterns.size,
    improvements_generated: improvements.length,
  });

  return improvements;
}

/**
 * Build a detailed description for a health incident improvement issue.
 * Tailored to the specific root cause to help operators fix the problem.
 */
function buildHealthIncidentDescription(
  cause: RootCauseCategory,
  agent: string,
  count: number,
  _tasks: Task[],
): string {
  const occurrences = count === 1 ? "incident" : `${count} incidents`;

  const baseDesc = `Recurring health check failures detected in the orchestrator's agent fleet.

Agent: \`${agent}\`
Root Cause: ${getRootCauseLabel(cause)}
Occurrences (24h): ${occurrences}

This pattern indicates a systematic issue that affects agent availability and reliability.`;

  // Add cause-specific guidance
  const guidance =
    cause === "oom"
      ? `\n\n**Guidance:** The agent process is being killed by the kernel due to insufficient memory.\n- Increase memory limits in docker-compose or Kubernetes configuration\n- Check for memory leaks in the agent or its dependencies\n- Profile heap usage under load to identify the issue`
      : cause === "port-conflict"
        ? `\n\n**Guidance:** The agent's port is already in use, likely by a previous instance that didn't shut down cleanly.\n- Check for stray processes: \`ps aux | grep agent\`\n- Clear the port: \`lsof -i :PORT | kill -9 PID\`\n- Review container startup/shutdown lifecycle and ensure clean shutdown`
        : cause === "secret-missing"
          ? `\n\n**Guidance:** Required secrets or environment variables are missing from the agent's environment.\n- Verify all required secrets are mounted/injected at startup\n- Check secret file permissions and ownership\n- Review the agent's configuration schema for missing required fields`
          : cause === "dependency"
            ? `\n\n**Guidance:** The agent cannot reach an upstream service (database, cache, API, etc.).\n- Check network connectivity: \`ping\`, \`nc -zv\` to the service\n- Verify DNS resolution and service discovery\n- Review firewall rules and security group configuration\n- Ensure dependent services are healthy and accepting connections`
            : cause === "crash"
              ? `\n\n**Guidance:** The agent process is crashing with an unhandled exception or fatal error.\n- Collect full logs from the crash moment: \`docker logs container-name\`\n- Look for stack traces and error messages indicating the root cause\n- Check for version incompatibilities or missing dependencies\n- Review recent code changes or configuration updates`
              : cause === "startup-timeout"
                ? `\n\n**Guidance:** The agent is taking too long to start or never becomes ready.\n- Check startup logs: \`docker logs container-name\` during startup\n- Increase health check timeout if the agent legitimately needs more time\n- Profile startup performance to identify bottlenecks\n- Verify all startup dependencies (services, configs, secrets) are available`
                : `\n\n**Guidance:** The root cause of the health check failure is not yet determined.\n- Examine the full logs of recent health check failures\n- Look for patterns or error messages in the incident tasks\n- File a structured investigation task if manual analysis is needed`;

  return baseDesc + guidance;
}
