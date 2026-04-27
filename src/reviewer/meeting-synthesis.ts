/**
 * Meeting synthesis reliability helpers.
 *
 * This module provides the persistence and reconciliation layer for
 * facilitator-scheduled meetings:
 *   1. Write a durable `meeting_synthesis_pending` row locally when a meeting
 *      is dispatched.
 *   2. Retry the facilitator intake request best-effort.
 *   3. Reconcile pending rows against the facilitator outcome API on later
 *      daemon cycles.
 *   4. Alert operators and re-attempt intake when a meeting remains unresolved
 *      for more than 24 hours.
 */

import { createLogger } from "../service/logger.js";
import type { Notifier } from "../notify.js";
import type {
  IMeetingSynthesisStore,
  MeetingSynthesisSignalRecord,
} from "../state/types.js";
import {
  DEFAULT_MEETING_SYNTHESIS_STALE_HOURS,
  isMeetingSynthesisStale,
} from "../state/meeting-synthesis.js";
import type { MeetingOutcome } from "./meeting-outcome-client.js";

const log = createLogger("meeting-synthesis");

// ---------------------------------------------------------------------------
// Intake client
// ---------------------------------------------------------------------------

/** Payload accepted by the facilitator intake endpoint. */
export interface MeetingIntakeRequest {
  meeting_id: string;
  topic: string;
  dispatched_at?: string;
  [key: string]: unknown;
}

/** Generic response payload returned by the facilitator intake endpoint. */
export type MeetingIntakeResponse = Record<string, unknown>;

export interface MeetingIntakeClientOptions {
  /** Base URL of the facilitator HTTP server. Defaults to `http://localhost:3485`. */
  baseUrl?: string;
  /**
   * Intake endpoint path.  The facilitator owns the HTTP contract, so this is
   * configurable instead of hard-coded.
   */
  intakePath?: string;
  /** Request timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Local persistence store used to record the pending signal. */
  store?: IMeetingSynthesisStore;
  /** Dependency injection hook for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_INTAKE_BASE_URL = "http://localhost:3485";
const DEFAULT_INTAKE_PATH = "/api/meetings/intake";
const DEFAULT_INTAKE_TIMEOUT_MS = 10_000;

/**
 * Fire-and-forget intake client for facilitator-scheduled meetings.
 *
 * The client persists a pending synthesis row locally before it makes the
 * HTTP call, so an intake outage does not erase the audit trail.
 */
export class MeetingIntakeClient {
  private readonly baseUrl: string;
  private readonly intakePath: string;
  private readonly timeoutMs: number;
  private readonly store?: IMeetingSynthesisStore;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MeetingIntakeClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_INTAKE_BASE_URL).replace(/\/$/, "");
    this.intakePath = opts.intakePath ?? DEFAULT_INTAKE_PATH;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_INTAKE_TIMEOUT_MS;
    this.store = opts.store;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Submit an intake request to the facilitator.
   *
   * Returns the parsed response on success, or `null` on failure.  The local
   * pending row is written before the HTTP request so the meeting is never
   * silently dropped if the facilitator is offline.
   */
  async submitIntake(req: MeetingIntakeRequest): Promise<MeetingIntakeResponse | null> {
    this.persistPendingSignal(req);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await this.fetchImpl(`${this.baseUrl}${this.intakePath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        log.warn("Meeting intake endpoint returned non-2xx", {
          meetingId: req.meeting_id,
          status: resp.status,
          body: body.slice(0, 200),
        });
        return null;
      }

      const text = await resp.text();
      if (!text.trim()) {
        return {};
      }

      return JSON.parse(text) as MeetingIntakeResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("abort")) {
        log.warn("Meeting intake request timed out", {
          meetingId: req.meeting_id,
          timeoutMs: this.timeoutMs,
        });
      } else {
        log.warn("Meeting intake request failed", {
          meetingId: req.meeting_id,
          error: message,
        });
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private persistPendingSignal(req: MeetingIntakeRequest): void {
    if (!this.store) {
      return;
    }

    try {
      this.store.recordMeetingSynthesisPending(req.meeting_id, req.topic, req.dispatched_at);
    } catch (err) {
      log.error("Failed to persist meeting synthesis pending signal", {
        meetingId: req.meeting_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Narrow interface for the facilitator outcome API client. */
export interface MeetingOutcomeLookup {
  fetchOutcome(meetingId: string): Promise<MeetingOutcome | null>;
}

export interface MeetingSynthesisReconcilerOptions {
  /** Look-back threshold for stale alerts. Defaults to 24h. */
  staleAfterHours?: number;
  /** Maximum pending rows to inspect per cycle. Defaults to 50. */
  scanLimit?: number;
  /**
   * Optional callback that re-attempts intake for stale rows after the alert
   * fires.  The daemon can wire this back to the intake client.
   */
  retryIntake?: (signal: MeetingSynthesisSignalRecord) => Promise<void>;
}

export interface MeetingSynthesisReconcileResult {
  checked: number;
  resolved: number;
  stale: number;
  alerted: number;
  retried: number;
}

/**
 * Build the Telegram alert body for a stale meeting synthesis signal.
 */
export function buildMeetingSynthesisAlertMessage(
  signal: MeetingSynthesisSignalRecord,
  staleAfterHours: number = DEFAULT_MEETING_SYNTHESIS_STALE_HOURS,
): string {
  const ageHours = Math.max(
    0,
    Math.floor((Date.now() - new Date(signal.dispatched_at).getTime()) / 3600_000),
  );

  return [
    `Meeting synthesis is still pending after ${ageHours}h.`,
    ``,
    `*Meeting:* \`${signal.meeting_id}\``,
    `*Topic:* ${signal.topic}`,
    `*Dispatched:* ${signal.dispatched_at}`,
    `*Threshold:* ${staleAfterHours}h`,
    `*Retries:* ${signal.retry_count}`,
    ``,
    `The orchestrator will re-attempt intake so the meeting history stays durable.`,
  ].join("\n");
}

/**
 * Reconcile pending meeting synthesis rows against the facilitator outcome API.
 */
export class MeetingSynthesisReconciler {
  private readonly staleAfterHours: number;
  private readonly scanLimit: number;

  constructor(
    private readonly store: IMeetingSynthesisStore,
    private readonly outcomeLookup: MeetingOutcomeLookup,
    private readonly notifier?: Notifier,
    opts: MeetingSynthesisReconcilerOptions = {},
  ) {
    this.staleAfterHours = opts.staleAfterHours ?? DEFAULT_MEETING_SYNTHESIS_STALE_HOURS;
    this.scanLimit = opts.scanLimit ?? 50;
    this.retryIntake = opts.retryIntake;
  }

  private readonly retryIntake?: (signal: MeetingSynthesisSignalRecord) => Promise<void>;

  async reconcile(): Promise<MeetingSynthesisReconcileResult> {
    const pending = this.store.getPendingMeetingSynthesisSignals(this.scanLimit);
    const result: MeetingSynthesisReconcileResult = {
      checked: pending.length,
      resolved: 0,
      stale: 0,
      alerted: 0,
      retried: 0,
    };

    for (const signal of pending) {
      const outcome = await this.lookupOutcome(signal.meeting_id);

      if (outcome?.status === "complete") {
        if (this.store.resolveMeetingSynthesis(signal.meeting_id, outcome.decided_at, outcome.status)) {
          result.resolved += 1;
        }
        continue;
      }

      if (!isMeetingSynthesisStale(signal, this.staleAfterHours)) {
        continue;
      }

      result.stale += 1;
      if (signal.alerted_at) {
        continue;
      }

      await this.alertStaleSignal(signal);
      if (this.store.markMeetingSynthesisAlerted(signal.meeting_id)) {
        result.alerted += 1;
      }

      if (this.retryIntake) {
        try {
          await this.retryIntake(signal);
          if (this.store.incrementMeetingSynthesisRetryCount(signal.meeting_id)) {
            result.retried += 1;
          }
        } catch (err) {
          log.warn("Meeting synthesis retry intake failed", {
            meetingId: signal.meeting_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return result;
  }

  private async lookupOutcome(meetingId: string): Promise<MeetingOutcome | null> {
    try {
      return await this.outcomeLookup.fetchOutcome(meetingId);
    } catch (err) {
      log.warn("Failed to fetch meeting outcome during reconciliation", {
        meetingId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async alertStaleSignal(signal: MeetingSynthesisSignalRecord): Promise<void> {
    if (!this.notifier?.isConfigured()) {
      return;
    }

    try {
      await this.notifier.notifyOperator(
        "Meeting synthesis still pending",
        buildMeetingSynthesisAlertMessage(signal, this.staleAfterHours),
        "high",
      );
    } catch (err) {
      log.warn("Failed to send meeting synthesis alert", {
        meetingId: signal.meeting_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
