/**
 * Health Incident Router — issue #104
 *
 * Routes health check incident reports to Telegram instead of creating PRs.
 * Health check failures are infrastructure diagnostics (pure-diagnostic tasks),
 * not code reviews. They pollute the PR queue and should instead go to the
 * escalation Telegram channel with structured incident data.
 *
 * Acceptance criteria:
 *   1. Health check incident output goes to Telegram with structured fields
 *      (agent, timestamp, root cause, resolution)
 *   2. No PR is opened for pure-diagnostic health check tasks
 *   3. PRs that fix code as part of incident response are still allowed
 *
 * Integration: Called by the orchestrator's improvement processing pipeline
 * BEFORE issue/PR creation. See usage example at bottom of file.
 */

import { createLogger } from "../service/logger.js";
import type { Notifier } from "../notify.js";

const log = createLogger("health-incident-router");

// ── Types ────────────────────────────────────────────────────────────────

export interface HealthIncident {
  /** Task ID of the health check task (populated by caller). */
  taskId: string;
  /** Agent that failed the health check. */
  agentName: string;
  /** When the incident was detected. */
  timestamp: string;
  /** Inferred root cause from task title or result. */
  rootCause?: string;
  /** Diagnostic playbook or resolution steps from the task result. */
  diagnosticPlaybook?: string;
  /** True if this is a pure diagnostic (no code fix). */
  isPureDiagnostic: boolean;
}

export interface HealthIncidentProvider {
  detectHealthIncident(taskTitle: string, sourceRef: string | null): HealthIncident | null;
  shouldSkipPRCreation(sourceRef: string | null): boolean;
  formatIncidentForTelegram(incident: HealthIncident): string;
  routeToTelegram(incident: HealthIncident): Promise<boolean>;
}

// ── Detection patterns ───────────────────────────────────────────────────

/**
 * Patterns that identify health check incident tasks.
 *
 * Real examples from the orchestrator:
 *   - source_ref: "health-check-fail:codex-orchestrator-reviewer"
 *   - title: "[revision] Health check failed: codex-agent-orchestrator"
 *   - title: "[auto-reroute] [revision] Health check failed: codex-orchestrator-reviewer"
 */
const HEALTH_CHECK_SOURCE_PREFIX = "health-check-fail:";
const HEALTH_CHECK_TITLE_PATTERNS = [
  /Health check (?:failed|incident)[:\s]+(.+)/i,
  /\[revision\]\s*Health check (?:failed|incident)[:\s]+(.+)/i,
  /\[auto-reroute\].*Health check (?:failed|incident)[:\s]+(.+)/i,
];

// ── Router ───────────────────────────────────────────────────────────────

export class HealthIncidentRouter implements HealthIncidentProvider {
  constructor(private notifier?: Notifier) {}

  /**
   * Detect whether a task is a health check incident (pure diagnostic).
   *
   * Detection checks (in priority order):
   * 1. source_ref starts with "health-check-fail:" → definitive match
   * 2. Title matches health check failure patterns → fallback match
   *
   * @returns Parsed incident data, or null if not a health check incident
   */
  detectHealthIncident(
    taskTitle: string,
    sourceRef: string | null,
  ): HealthIncident | null {
    // Primary detection: source_ref pattern (most reliable)
    if (sourceRef?.startsWith(HEALTH_CHECK_SOURCE_PREFIX)) {
      const agentName = sourceRef.slice(HEALTH_CHECK_SOURCE_PREFIX.length);
      return {
        taskId: "", // Populated by caller
        agentName,
        timestamp: new Date().toISOString(),
        rootCause: this.inferRootCause(taskTitle),
        isPureDiagnostic: true,
      };
    }

    // Fallback detection: title pattern matching
    for (const pattern of HEALTH_CHECK_TITLE_PATTERNS) {
      const match = taskTitle.match(pattern);
      if (match) {
        // Extract agent name — strip any trailing parenthetical/bracket noise
        const agentName = match[1].replace(/\s*\(.*\)$/, "").trim();
        return {
          taskId: "",
          agentName,
          timestamp: new Date().toISOString(),
          rootCause: this.inferRootCause(taskTitle),
          isPureDiagnostic: true,
        };
      }
    }

    return null;
  }

  /**
   * Determine whether a task should skip PR creation.
   *
   * Returns true for pure-diagnostic health check incidents.
   * Returns false for everything else (including incident responses that
   * contain actual code fixes — those should still create PRs).
   */
  shouldSkipPRCreation(sourceRef: string | null): boolean {
    return sourceRef !== null && sourceRef.startsWith(HEALTH_CHECK_SOURCE_PREFIX);
  }

  /**
   * Format a health incident as a structured Telegram message.
   *
   * Uses Markdown formatting compatible with Telegram's parse_mode=Markdown.
   */
  formatIncidentForTelegram(incident: HealthIncident): string {
    const lines: string[] = [
      `🚨 *Health Incident*: \`${incident.agentName}\``,
      `⏰ *Time*: \`${incident.timestamp}\``,
    ];

    if (incident.rootCause) {
      lines.push(`🔍 *Root Cause*: ${incident.rootCause}`);
    }

    if (incident.diagnosticPlaybook) {
      const playbook =
        incident.diagnosticPlaybook.length > 500
          ? incident.diagnosticPlaybook.slice(0, 500) + "…"
          : incident.diagnosticPlaybook;
      lines.push(`📋 *Diagnostics*:\n${playbook}`);
    }

    lines.push(
      "",
      `_Routed to Telegram — no PR created for pure-diagnostic incident._`,
    );

    return lines.join("\n");
  }

  /**
   * Route a health incident to Telegram via the notifier.
   *
   * Uses `notifier.send()` for the structured message and logs failures
   * without throwing (fire-and-forget pattern for non-critical path).
   *
   * @returns true if the message was sent, false if notifier unavailable or send failed
   */
  async routeToTelegram(incident: HealthIncident): Promise<boolean> {
    if (!this.notifier || !this.notifier.isConfigured()) {
      log.warn("Telegram notifier not configured — health incident not routed", {
        agentName: incident.agentName,
        taskId: incident.taskId,
      });
      return false;
    }

    try {
      const message = this.formatIncidentForTelegram(incident);
      // NOISE SUPPRESSION (#564): Health incident routing is informational monitoring.
      // Operator should query /health or /incidents if interested; no push notifications.
      log.info("Health incident recorded (not sending to Telegram per #564)", {
        agentName: incident.agentName,
        taskId: incident.taskId,
        rootCause: incident.rootCause ?? "unknown",
      });
      return true;
    } catch (err) {
      log.error("Failed to route health incident to Telegram", {
        agentName: incident.agentName,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Infer root cause from task title.
   *
   * Common patterns:
   *   "Health check failed: agent (OOM kill)" → "OOM kill"
   *   "Health check failed: agent (Port conflict)" → "Port conflict"
   *   "Health check failed: agent" → undefined
   */
  private inferRootCause(title: string): string | undefined {
    const match = title.match(/\(([^)]+)\)\s*$/);
    return match ? match[1] : undefined;
  }
}
