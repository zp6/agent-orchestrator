import type { AgentHealth } from "./state/types.js";

export interface HealthRecoveryObservation {
  agent_name: string;
  consecutive_failures: number;
  last_error_at: string | null;
  last_success_at?: string | null;
  updated_at: string;
}

export interface HealthRecoveryEvent {
  agentName: string;
  degradedForMs: number;
  confirmationCycles: number;
  confirmedAtMs: number;
}

interface RecoveryState {
  degradedSinceMs: number;
  healthyStreak: number;
}

function toEpochMs(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;

  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d`;
}

/**
 * Tracks agent health recovery so the orchestrator can send a single Telegram
 * notice after the agent has been healthy for a confirmation window.
 */
export class HealthRecoveryTracker {
  private readonly states = new Map<string, RecoveryState>();

  constructor(private readonly confirmationCycles: number = 3) {
    if (!Number.isInteger(confirmationCycles) || confirmationCycles < 1) {
      throw new Error("confirmationCycles must be a positive integer");
    }
  }

  observe(
    health: HealthRecoveryObservation | AgentHealth,
    observedAt: string | number | Date = Date.now(),
  ): HealthRecoveryEvent | null {
    const nowMs = toEpochMs(observedAt);
    if (nowMs === null) {
      throw new Error("observedAt must be a valid timestamp");
    }

    const agentName = health.agent_name;
    const isHealthy = health.consecutive_failures === 0;
    const current = this.states.get(agentName);

    if (!isHealthy) {
      if (!current) {
        this.states.set(agentName, {
          degradedSinceMs: toEpochMs(health.last_error_at) ?? nowMs,
          healthyStreak: 0,
        });
      } else {
        current.healthyStreak = 0;
      }
      return null;
    }

    if (!current) {
      return null;
    }

    current.healthyStreak += 1;
    if (current.healthyStreak < this.confirmationCycles) {
      return null;
    }

    this.states.delete(agentName);
    return {
      agentName,
      degradedForMs: Math.max(0, nowMs - current.degradedSinceMs),
      confirmationCycles: this.confirmationCycles,
      confirmedAtMs: nowMs,
    };
  }

  reset(agentName: string): void {
    this.states.delete(agentName);
  }

  clear(): void {
    this.states.clear();
  }
}
